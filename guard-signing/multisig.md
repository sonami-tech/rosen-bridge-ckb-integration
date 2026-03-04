# Rosen Bridge: Guard Multi-Sig and Key Rotation

How the guard set is represented on-chain, how Ergo multi-sig signing works, how the guard set is rotated, and how assets are migrated to new bridge addresses. This is the non-TSS (Ergo multi-sig) companion to [tss.md](./tss.md), which covers TSS signing for all other chains.

## Guard Config Box

The canonical guard set lives on Ergo in a single UTXO called the **Guard Config Box**, identified by a unique Guard NFT token (`tokens.GuardNFT` in contract config). All components (guard-service, watcher, scanner) read from this box.

### Register Layout

| Register | Type | Content |
|----------|------|---------|
| R4 | `Coll[Coll[Byte]]` | Compressed ECDSA public keys (33 bytes each) |
| R5 | `Coll[Int]` | `[paymentSignRequired, updateSignRequired]` |

R5[0] (payment threshold) gates Lock box spending, cold-storage transfers, and reward distribution. R5[1] (update threshold) gates updating the guard set itself.

### Contract Interactions

The [GuardSign](https://github.com/rosen-bridge/contract/blob/dev/src/main/scala/rosen/bridge/scripts/GuardSign.es) contract controls the Guard Config Box. Spending requires `atLeast(R5[1])` signatures and preserves the Guard NFT in the output.

Other contracts ([Lock](https://github.com/rosen-bridge/contract/blob/dev/src/main/scala/rosen/bridge/scripts/Lock.es), [RepoConfig](https://github.com/rosen-bridge/contract/blob/dev/src/main/scala/rosen/bridge/scripts/RepoConfig.es), [Emission](https://github.com/rosen-bridge/contract/blob/dev/src/main/scala/rosen/bridge/scripts/Emission.es)) take the Guard Config Box as a read-only **data input** and verify the Guard NFT presence and signature threshold. Because guard data lives in box registers (not contract constants), the Lock address stays the same across guard rotations.

### Runtime Detection

[GuardPkHandler](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/guardPkHandler.ts) polls the Guard Config Box every 180 seconds (configurable), caches the public keys and threshold, identifies this guard's index by ECDSA public key comparison, and propagates changes via `updateDependentModules()`. Currently the only dependent module is [ErgoMultiSig](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/ergo-multi-sig/lib/multiSigHandler.ts), which receives the updated PK array via `handlePublicKeysChange()`.

The guard-service [initialization sequence](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/index.ts): database and token handler, P2P communication, guard detection, multi-sig handler for Ergo, chain handler (wires sign mediators), guard config from blockchain, transaction agreement, arbitrary processor, scanners and event processors. The guard config fetch is where on-chain guard set changes are first detected; the periodic update job (every 180s) keeps it in sync.

## Ergo Multi-Sig Signing Protocol

Ergo uses interactive Schnorr multi-sig via [ergo-lib-wasm](https://github.com/ergoplatform/sigma-rust): a 5-message commitment exchange protocol entirely in TypeScript/WASM, implemented in [multiSigHandler.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/ergo-multi-sig/lib/multiSigHandler.ts). Non-Ergo chains use TSS via an external Go binary instead (see [tss.md](./tss.md)).

### Coordinator Selection

The coordinator rotates every 3 minutes based on wall-clock time: `Math.floor(Date.now() / turnTime) % guardPks.length`. Only the coordinator can initiate signing. Full period: `guardsLen * 180s`, with a 2-minute active window and 1-minute gap per guard ([GuardTurn](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/utils/guardTurn.ts)).

### Protocol Flow

| Message | Direction | Purpose |
|---------|-----------|---------|
| GenerateCommitment | coordinator -> all | Broadcast transaction and coordinator's commitment |
| Commitment | each peer -> coordinator | Return peer's commitment |
| InitiateSign | coordinator -> committed signers | Distribute all commitments + simulated proofs |
| Sign | each signer -> coordinator | Return partial proof |
| SignedTx | coordinator -> all | Broadcast fully-signed transaction |

**Phase 1 (GenerateCommitment):** The coordinator generates commitment secrets (random nonces for each input's Sigma protocol) via `generate_commitments_for_reduced_transaction()` and broadcasts to all peers.

**Phase 2 (Commitment):** Each peer with the transaction queued generates its own commitments and returns them. When M commitments arrive, the coordinator determines signers vs non-signers, generates simulated proofs for non-signers using an empty prover, and produces its own partial proof. The simulated proofs fill the non-signing branches of the `atLeast(M, ...)` Sigma proposition with placeholder values that the real signers can complete.

**Phase 3 (InitiateSign):** The coordinator sends all commitments (real + simulated) and simulated proofs to each committed signer.

**Phase 4 (Sign):** Each signer reconstructs the full hint bag (real commitments, simulated commitments, simulated proofs, own secrets), signs, extracts its partial proof via `extract_hints()`, and returns it to the coordinator.

**Phase 5 (SignedTx):** The coordinator aggregates all M partial proofs, simulated proofs, and commitments into a single hint bag. An empty prover (no secrets) produces a valid signature because all hints are provided. The result is serialized and broadcast.

Every guard validates the final transaction by checking each input proof via `verify_tx_input_proof()`. Valid transactions resolve the signing promise; invalid ones are rejected. Transactions older than `txSignTimeout` are cleaned up periodically.

### Key Rotation Impact

When `handlePublicKeysChange()` replaces the PK array, the coordinator modulo changes if the guard count changed. In-flight transactions with a mismatched coordinator have their state reset before the protocol restarts. Transactions whose coordinator was removed are cleaned up by the timeout mechanism.

## Guard Communication

Guards communicate via [libp2p](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/communication/rosenDialer.ts) with relay nodes. Each guard has a persistent peer ID. Channels relevant to multi-sig: `ecdsa-detection` (liveness heartbeats), `ergo-multi-sig` (signing coordination), `tx-agreement` (transaction proposals).

[GuardDetection](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/detection/lib/guardDetection.ts) uses a three-message handshake (`register` -> `approval` -> `approval`) followed by periodic heartbeats. A guard is active if its last update was within 120 seconds. The active list is sorted by public key for deterministic set composition. When keys change, `changePks()` reinitializes the guard info array and triggers re-detection.

## Transaction Agreement

Before cryptographic signing begins, guards must agree on what to sign. [TxAgreement](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/agreement/txAgreement.ts) extends [Communicator](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/communication/lib/communicator.ts) on the `tx-agreement` channel. A guard proposes a transaction (request), others verify and sign (response), and once enough responses arrive the approved transaction proceeds to the signing protocol (approval). This layer is shared by both multi-sig and TSS chains.

## Lock Address and Guard Rotation

### Does the Lock Address Change?

- **Ergo: No.** The Lock contract references the Guard Config Box as a read-only data input. The contract address is determined by the script code, not the guard keys. After rotation, the new guard set can spend existing Lock boxes.

- **Non-Ergo chains: Depends.** If the lock address is derived from the guard set (multisig script hash or aggregate public key), changing the guard set changes the address and assets must be migrated.

### Ergo Rotation (No Migration)

1. At least `updateSignRequired` guards agree to change the guard set
2. They spend the current Guard Config Box, producing a new one with the same Guard NFT, updated R4 (new public keys), and optionally updated R5 (new thresholds)
3. The GuardSign contract verifies the threshold is met
4. After confirmation, guard-service instances detect the change within 180 seconds via GuardPkHandler
5. No asset migration: existing Lock boxes are spendable by the new guard set

### Non-Ergo Rotation (Migration Required)

From the [contract README](https://github.com/rosen-bridge/contract) (Section D.2): "all bridge wallet assets should be transferred into their new address in such chains before updating the guard set." That single sentence is the only specification for non-TSS non-Ergo migration. There are no migration scripts, migration-specific code paths, or operational playbooks.

Currently all non-Ergo chains use TSS, so migration procedures will be built around TSS signing. With TSS, CKB piggybacks on whatever procedures get built for Bitcoin, Ethereum, and the other 5+ TSS chains. With Omnilock multisig, CKB would become the only non-Ergo chain migrating through a non-TSS path (Ergo does not need migration since its Lock address is stable). CKB would be the sole consumer of its own signing package (`ckb-multi-sig`) and its own migration coordination. See [comparison.md](./comparison.md#operational-isolation-of-multisig-migration) for the full analysis.

## Asset Migration

For chains where the lock address changes, the [ArbitraryProcessor](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/arbitrary/arbitraryProcessor.ts) provides a generic payment mechanism. Orders are submitted via [`POST /order`](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/api/arbitrary.ts) with a destination address (the new lock address), chain identifier, and asset amounts. The processor picks up pending orders, generates `TransactionType.arbitrary` transactions, and routes them through the normal agreement and signing flow. The old guard set signs since they still control the old address.

Cold storage assets (configured separately in [contracts.json](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/configs/rosenConfig.ts)) may also need migration. The [cold storage mechanism](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/coldStorage/coldStorage.ts) uses the same signing infrastructure.

### Undocumented Operational Concerns

- Whether bridge operations must be paused during migration
- Ordering: drain all chains first then update the guard set, or update first then drain
- Handling in-flight transactions that reference the old address
- Per-chain confirmation requirements (Bitcoin 2, Cardano 40, Ergo 14, Ethereum 50, Binance 900, Doge 20)

See [rosen-bridge/rcs#2](https://github.com/rosen-bridge/rcs/issues/2) for the questions raised with the Rosen team.

## Guard Secrets and Configuration

Each guard holds a persistent `guardMnemonic` that derives both the Ergo Schnorr signing key and the ECDSA key identifying this guard in the on-chain guard set. A separate `tss.secret` key handles P2P message encryption. During rotation, both stay the same (they are the guard's identity).

Chain addresses are loaded at startup from [contracts.json](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/configs/rosenConfig.ts), which provides lock, cold, and contract addresses per chain. Per-chain [config builders](https://github.com/rosen-bridge/guard-service/tree/dev/services/guard-service/src/configs) extract the relevant addresses and signing parameters.

## Summary

### Ergo

| Component | Changes on Rotation? | Action Required |
|---|---|---|
| Guard Config Box (R4/R5) | Yes | Spend and recreate with new PKs |
| Lock contract address | No | None |
| Lock boxes (assets) | No | None (new guards can spend them) |
| Cold address | Optionally | Update contracts.json if changed |
| guardSignAddress | No | Same contract, same address |

### Non-Ergo Chains (Address Changes)

| Component | Changes on Rotation? | Action Required |
|---|---|---|
| Lock address | Yes | Derive from new guard set |
| Assets | Must migrate | Arbitrary transactions: old -> new address |
| contracts.json | Yes | Update all affected addresses |

## References

- [GuardSign.es](https://github.com/rosen-bridge/contract/blob/dev/src/main/scala/rosen/bridge/scripts/GuardSign.es): Guard set update contract
- [Lock.es](https://github.com/rosen-bridge/contract/blob/dev/src/main/scala/rosen/bridge/scripts/Lock.es): Lock contract, data-input pattern
- [Contract README](https://github.com/rosen-bridge/contract): Section D.2 "Guards Update"
- [multiSigHandler.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/ergo-multi-sig/lib/multiSigHandler.ts): Ergo 5-phase Schnorr multi-sig
- [guardPkHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/guardPkHandler.ts): Runtime guard key cache
- [guardDetection.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/detection/lib/guardDetection.ts): Liveness detection
- [communicator.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/communication/lib/communicator.ts): P2P messaging base class
- [txAgreement.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/agreement/txAgreement.ts): Transaction agreement protocol
- [arbitraryProcessor.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/arbitrary/arbitraryProcessor.ts): Arbitrary transaction mechanism
- [chainHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/chainHandler.ts): Per-chain sign mediator wiring
- [guardTurn.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/utils/guardTurn.ts): Turn scheduling
