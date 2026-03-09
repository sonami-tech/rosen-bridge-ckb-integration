# Rosen Bridge: Guard TSS and Key Rotation

How TSS (Threshold Signature Scheme) signing works for non-Ergo chains, how the guard set is rotated, and how assets are migrated to new bridge addresses. This is the TSS companion to [multisig.md](./multisig.md), which covers Ergo multi-sig.

## Shared Infrastructure

The Guard Config Box, runtime detection (GuardPkHandler), transaction agreement protocol, arbitrary transaction mechanism, guard communication, and guard secrets are shared between TSS and multi-sig paths. See [multisig.md](./multisig.md) for details. Key differences for TSS:

- **GuardPkHandler** does not propagate changes to TSS signers. TSS signers manage their own state via an independent `update()` loop every 10 seconds.
- **Guard detection** is shared (same `ecdsa-detection` channel). TSS adds dedicated channels: `tss-ecdsa-signing`, `tss-eddsa-signing`, and `tss` (Go binary gossip).

## TSS Architecture

TSS signing is split across two processes:

1. **TypeScript TSS signer** ([sign-protocols/packages/tss/](https://github.com/rosen-bridge/sign-protocols/tree/dev/packages/tss)): orchestrates guard-to-guard coordination, turn scheduling, message approval, and caching
2. **Go TSS binary** ([sign-protocols/services/tss-api/](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api)): executes the actual MPC protocol using [BNB Chain tss-lib v2](https://github.com/bnb-chain/tss-lib)

The guard-service spawns the Go binary as a child process and communicates via HTTP. Go binaries communicate with each other via P2P messages routed through the guard-service's libp2p dialer.

### Go Binary Lifecycle

The guard-service [spawns](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/tssHandler.ts) the Go binary as a child process with a random trust key (UUID). The trust key is included in all callbacks; the guard-service rejects callbacks with a wrong key, preventing stale responses from crashed/restarted binaries. On crash, auto-restart after 5 seconds.

The Go binary ([main.go](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/main.go)) listens on `localhost:4000` (configurable) and exposes: `GET /threshold`, `POST /getPK`, `POST /sign`, `POST /keygen`, `POST /message` (P2P relay). At startup, it loads existing keygen data (if any), subscribes to the `tss` P2P channel, and starts serving.

### Algorithm Families

| Algorithm | Curve | Chains | Key Derivation |
|-----------|-------|--------|----------------|
| ECDSA | secp256k1 | Bitcoin, Bitcoin Runes, Ethereum, Binance, Doge | BIP-32 via chainCode + derivationPath |
| EdDSA | Ed25519 | Cardano | chainCode only |

Both share the same [TssSigner](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/tssSigner.ts) base class and the same Go binary. The algorithm is selected per-operation via the `crypto` field.

## Key Generation

Before signing, guards run a distributed key generation (DKG) ceremony that produces a shared public key and per-guard private shares. No single guard holds the full private key. The ceremony runs once per algorithm.

The [keygen-service](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/keygen-service/src/service/tss.ts) orchestrates the ceremony: it spawns the Go binary, waits for all peers to connect via libp2p, and POSTs to the Go binary's `/keygen` endpoint with the p2pIDs, threshold, peer count, algorithm, and a 10-minute timeout.

The Go binary ([ecdsa](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/app/keygen/ecdsa/ecdsa.go), [eddsa](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/app/keygen/eddsa/eddsa.go)) creates party IDs from p2pIDs (sorted by share ID), starts the tss-lib local party, and exchanges messages via P2P gossip until all rounds complete. The output (`LocalPartySaveData`) contains the shared public key, this guard's share ID, and private share material.

Keygen data is persisted to `{TSS_HOME}/{ecdsa,eddsa}/keygen_data.json`. On startup, the Go binary loads these files; if they exist, keygen has already been performed and the shares are ready for signing.

## Signing Protocol

### TypeScript Coordination

The [TssSigner](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/tssSigner.ts) base class (extended by [EcdsaSigner](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/ecdsaSigner.ts) and [EddsaSigner](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/eddsaSigner.ts)) manages guard coordination before the MPC protocol runs.

TSS uses 1-minute turns with a 10-second no-work buffer (50s active, 10s gap), compared to Ergo multi-sig's 3-minute turns. The 4-message coordination protocol:

| Message | Direction | Purpose |
|---------|-----------|---------|
| request | initiator -> all | "I want to sign this message with these guards" |
| approve | each peer -> initiator | "I approve; here is my signature on the request" |
| start | initiator -> approved guards | "Threshold reached; start TSS" |
| cached | any guard -> requester | "Already signed this; here is the cached result" |

When the initiator's turn arrives, it sends `request` to all active guards. Peers validate and respond with `approve`. Once the threshold is reached, the initiator sends `start` and POSTs to its local Go binary. Each approved guard does the same, and the Go binaries run the MPC protocol amongst themselves. On completion, each Go binary calls back to its guard-service with the signature.

Successful signatures are cached for 24 hours (configurable). Up to 5 signatures can be produced per turn.

### Go MPC Layer

When the TypeScript layer POSTs to `/sign`, the Go binary ([ecdsa](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/app/sign/ecdsa/ecdsa.go), [eddsa](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/app/sign/eddsa/eddsa.go)) loads keygen data, creates party IDs from the peers list (sorted by share ID), hex-decodes the message, and starts the tss-lib signing party (blake2b is used only internally to compute a routing ID for parallel signing sessions, not to hash the data that gets signed). For ECDSA, it uses `NewLocalPartyWithKDD()` (key derivation delegation) to derive chain-specific keys via BIP-32. Messages flow between parties via P2P gossip until the signature is produced and returned via callback.

### Algorithm Specifics

**ECDSA** ([ecdsaSigner.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/ecdsaSigner.ts)): requires `derivationPath`, produces both `signature` and `signatureRecovery` (needed for Ethereum-style ecrecover). Verification via `secp256k1.ecdsaVerify()`. Supports BIP-32 hierarchical key derivation through the Go binary's `DerivingPubkeyFromPath()`.

**EdDSA** ([eddsaSigner.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/eddsaSigner.ts)): no derivation path (Ed25519 does not support HD derivation). Produces signature only. Verification via `@noble/ed25519`.

### Public Key Derivation

The Go binary derives chain-specific public keys on demand via `POST /getPK` with `crypto`, `chainCode`, and `derivationPath`. For ECDSA, the same keygen shares produce different public keys for different chains by varying the derivation path. For EdDSA, the public key is fixed.

## Chain-Specific Configuration

Each TSS chain gets a signing mediator wired in [chainHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/chainHandler.ts) via [TssHandler](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/tssHandler.ts). ECDSA chains use `wrapCurveSignMediator(chainCode, derivationPath)`, EdDSA chains use `wrapEdwardSignMediator(chainCode)`.

| Chain | Algorithm | Config Class | derivationPath |
|-------|-----------|-------------|----------------|
| Bitcoin | ECDSA | GuardsBitcoinConfigs | Yes |
| Bitcoin Runes | ECDSA | GuardsBitcoinRunesConfigs | Yes |
| Ethereum | ECDSA | GuardsEthereumConfigs | Yes |
| Binance | ECDSA | GuardsBinanceConfigs | Yes |
| Doge | ECDSA | GuardsDogeConfigs | Yes |
| Cardano | EdDSA | GuardsCardanoConfigs | No |
| Ergo | Multi-sig | GuardsErgoConfigs | N/A |

Each chain's config provides `tssChainCode` and (for ECDSA) `derivationPath` from the guard-service application config. The threshold is queried from the Go binary every 60 seconds via `GET /threshold`.

## Lock Address and Guard Rotation

For TSS chains, the lock address is derived from the TSS public key. Since the public key is produced by the keygen ceremony:

- **New keygen** (new guard set): new public key, new lock address, migration required.
- **Reshare/regroup** (same public key, different shares): same lock address, no migration. **Not yet implemented.**

The tss-api README mentions regroup, and the [controller](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/api/controller.go) has conflict-checking code for it, but no regroup implementation exists: no API endpoints, no operation structs, no protocol handlers, no message types. Any guard set change currently requires a full new keygen ceremony.

| Chain Family | Lock Address Changes? | Migration Needed? |
|---|---|---|
| Ergo (multi-sig) | No (data input pattern) | No |
| TSS chains (new keygen) | Yes (new public key) | Yes |
| TSS chains (regroup) | No (same public key) | No (not yet implemented) |

### Rotation Procedure (Current)

1. Run new keygen ceremony with the new guard set (~10-minute timeout). Produces new ECDSA and EdDSA shared public keys (and per-guard private shares).
2. Derive new lock addresses for each TSS chain from the new public keys.
3. Migrate all assets from old to new addresses via [arbitrary transactions](./multisig.md#asset-migration).
4. Update `contracts.json` with new addresses.
5. Update the Ergo Guard Config Box with new guard PKs (see [multisig.md](./multisig.md#ergo-rotation-no-migration)).

The ordering of steps 4 and 5 relative to the migration is an open question (see [rosen-bridge/rcs#2](https://github.com/rosen-bridge/rcs/issues/2)).

### The Overlapping Guards Problem

The Go binary stores keygen shares in a single file per algorithm ([storage.go](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/storage/storage.go)), backed by a single in-memory struct. A guard cannot hold old and new shares simultaneously: the Go binary refuses to start a new keygen while the old keygen file exists ([`rosenTss.go`](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/app/rosenTss.go), HTTP 400). Guards overlapping between old and new sets must complete all migration signing before deleting the old keygen file and joining the new keygen.

### Regroup (Future)

If reshare/regroup were implemented, the old and new guard sets would jointly produce fresh shares for the new set, preserving the same public key: no address changes, no migration. tss-lib already provides the resharing protocol. The missing work is Rosen Bridge's wrapper: an HTTP endpoint in the Go binary, P2P message routing, share storage handling, and TypeScript coordination (same pattern as keygen and sign).

## Guard Secrets and Key Material

Each guard holds:

- **guardMnemonic**: derives the ECDSA identity key (shared across all protocols). Stays the same during rotation.
- **tss.secret**: ECDSA key for P2P message encryption within TSS coordination. Stays the same during rotation.
- **tss.pubs**: per-guard TSS public info (`curvePub`, `curveShareId`, `edwardShareId`). Changes if a new keygen is run.
- **Keygen data on disk**: `{TSS_HOME}/{ecdsa,eddsa}/keygen_data.json`. Changes if a new keygen is run.

## Timing Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Turn duration | 60s | Each guard's signing window |
| Turn no-work | 10s | Gap at end of each turn |
| Signature timeout | 600s (10 min) | Max time for a signing operation |
| Sign cache TTL | 86400s (24h) | How long to cache signatures |
| Signs per round | 5 | Max parallel signatures per turn |
| Threshold TTL | 60s | Re-query interval for threshold |
| TSS update interval | 10s | How often TssSigner.update() runs |
| Keygen timeout | 600s (10 min) | Max time for keygen ceremony |
| Binary restart gap | 5s | Wait before restarting crashed binary |

## Summary

### TSS Chains (New Keygen)

| Component | Changes on Rotation? | Action Required |
|---|---|---|
| TSS public key (ECDSA + EdDSA) | Yes | New keygen ceremony |
| Lock addresses (all TSS chains) | Yes | Derive from new public keys |
| Assets | Must migrate | Arbitrary transactions: old -> new address |
| keygen_data.json | Yes | New files from ceremony |
| tss.pubs in config | Yes | Update with new share IDs |
| contracts.json | Yes | Update all affected addresses |

### TSS Chains (Regroup, Not Yet Implemented)

| Component | Changes on Rotation? | Action Required |
|---|---|---|
| TSS public key | No | Same key, different shares |
| Lock addresses | No | None |
| Assets | No migration | None |
| keygen_data.json | Yes | New shares from regroup |
| tss.pubs in config | Yes | Update with new share IDs |

## References

- [tssSigner.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/tssSigner.ts): TSS coordination base class
- [ecdsaSigner.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/ecdsaSigner.ts): ECDSA specialization
- [eddsaSigner.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/eddsaSigner.ts): EdDSA specialization
- [tss-api](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api): Go binary (BNB tss-lib MPC)
- [tssHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/tssHandler.ts): Guard-service TSS integration
- [chainHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/chainHandler.ts): Per-chain sign mediator wiring
- [keygen-service](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/keygen-service/src/service/tss.ts): Keygen ceremony orchestrator
- [storage.go](https://github.com/rosen-bridge/sign-protocols/blob/dev/services/tss-api/storage/storage.go): Keygen data persistence
- [BNB tss-lib](https://github.com/bnb-chain/tss-lib): Threshold ECDSA and EdDSA implementation
