# CKB Bridge Wallet: Omnilock Multisig vs TSS + ACP

A comparison of two signing approaches for the CKB integration into [Rosen Bridge](../README.md): on-chain multisig via [Omnilock](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0042-omnilock/0042-omnilock.md) (auth flag `0x06`) with composable ACP, and off-chain threshold signing via ECDSA TSS with standalone [RFC 0026 ACP](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md). CKB also has a [system multisig script](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_multisig_all.c) (non-Omnilock), but it lacks ACP composability and depends on CCC PR [#349](https://github.com/ckb-devrel/ccc/pull/349) (open, not merged) for signer support. [#360](https://github.com/ckb-devrel/ccc/pull/360) (draft, not merged) is a superset of #349 that adds Omnilock multisig signers. See [README](../README.md#1-multi-signer-addresses) for the full comparison.

## Omnilock Multisig + ACP

On-chain M-of-N via [Omnilock](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0042-omnilock/0042-omnilock.md) (auth flag `0x06`) with composable ACP mode. A single lock script handles both:

- **Spending (multisig)**: M-of-N secp256k1 signatures verified on-chain via [`verify_multisig`](https://github.com/cryptape/omnilock/blob/main/c/ckb_identity.h)
- **Deposits (ACP)**: [RFC 0026](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) rules allow adding CKB/xUDT without signature

Lock args format:

```
0x06 | blake160(S|R|M|N|pubkey_hashes) | omnilock_flags | [min_ckb | min_udt]
 1B          20B                            1B              1B        1B
```

Witness format (spending):

```
S|R|M|N | pubkey_hashes      | signatures
 4B       N * 20B              M * 65B
```

For M=19, N=30: `4 + (30 * 20) + (19 * 65)` = **1839 bytes**.

Signing: each guard computes [`sighash_all`](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_sighash_all.c) (blake2b digest over transaction hash and witnesses) and signs with secp256k1. Coordinator collects M signatures via P2P ([Communicator](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/communication/lib/communicator.ts)), assembles multisig bytes using CCC's [MultisigCkbWitness](https://github.com/ckb-devrel/ccc/pull/349) (PR #349), wraps in [OmniLockWitnessLock](https://github.com/cryptape/omnilock/blob/main/c/omni_lock.c#L337) molecule format (PR #360). No interactive commitment protocol needed (unlike [Ergo's 5-round Schnorr](./multisig.md#ergo-multi-sig-signing-protocol)).

## TSS + Standalone ACP

Replace on-chain multisig with ECDSA TSS. Guards run the MPC protocol off-chain (via [BNB tss-lib](https://github.com/bnb-chain/tss-lib)) to produce a single secp256k1 signature. Use the standalone [RFC 0026 ACP lock](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) for deposit cells and the [default secp256k1-blake160 lock](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_sighash_all.c) for custody cells.

### Why It Works

The RFC 0026 ACP lock extends `secp256k1-blake160-sighash-all` with relaxed deposit rules. Spending path:

1. Recovers the public key from the 65-byte recoverable ECDSA signature
2. Checks `blake160(recovered_pubkey) == lock_args[0..20]`

TSS ECDSA produces a standard 65-byte recoverable secp256k1 signature, indistinguishable from a single-key signature. The lock address is `blake160(tss_shared_pubkey)`.

### Two Lock Scripts Instead of One

This is the main structural difference from Omnilock. With TSS + ACP, the bridge uses **two different lock scripts**:

**Deposit cells (RFC 0026 ACP):**

```
lock:
  code_hash: <anyone_can_pay_code_hash>
  hash_type: data
  args: blake160(tss_pubkey) [| min_ckb] [| min_udt]
         20B                    1B           1B
```

**Custody/change cells (default lock):**

```
lock:
  code_hash: <secp256k1_blake160_sighash_all_code_hash>
  hash_type: data
  args: blake160(tss_pubkey)
         20B
```

Both use the same 20-byte `blake160(tss_pubkey)` in args, but different `code_hash` values. Omnilock uses one `code_hash` for both (just different flags in args).

**Witness (spending either type):**

```
WitnessArgs.lock = 65-byte recoverable ECDSA signature
```

### Signing Flow

CKB would be wired as another ECDSA TSS chain, identical to how Bitcoin, Ethereum, Doge, and Binance are wired in [chainHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/chainHandler.ts). The existing [TssSigner](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/tssSigner.ts) and [tss-api](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api) infrastructure handles everything: 4-message approval protocol, MPC signing via tss-lib, signature caching. No new signing package needed.

## Cell Capacity, Signing, and Script Structure

Cell capacity, transaction fees, and deposit flow are functionally equivalent between the two approaches. Omnilock lock args are 2 bytes longer than TSS lock args (auth flag + omnilock_flags), resulting in a fixed 2 CKB difference per cell ([1 CKB per byte](https://docs.nervos.org/docs/tech-explanation/economics#state-rent), [RFC 0022](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md)). The witness size difference is larger (Omnilock 1839B vs TSS 65B for M=19, N=30) but CKB transaction fees are low enough (under 0.0001 CKB per spending tx at standard fee rates) that this does not materially affect bridge economics. A typical consolidation transaction (1 ACP input, 1 custody output) comes to ~2300 bytes with Omnilock (dominated by the 1839-byte multisig witness) vs ~500 bytes with TSS. Deposits use the ACP path in both cases (Omnilock's [omni_lock_acp.h](https://github.com/cryptape/omnilock/blob/main/c/omni_lock_acp.h) reimplements [RFC 0026](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) rules), so the user-facing deposit flow is identical.

Signing latency is comparable. Omnilock multisig uses 3-minute [GuardTurn](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/utils/guardTurn.ts) cycles (180s period, 120s active) with a single P2P round to collect M independent signatures. TSS uses shorter 60-second turns but adds MPC execution time (6-8 rounds of [Gennaro-Goldfeder ECDSA](https://github.com/bnb-chain/tss-lib) via the Go binary). TSS additionally supports signature caching (24-hour TTL) and up to 5 parallel signatures per turn.

TSS + ACP uses two lock scripts (default lock for custody, RFC 0026 ACP for deposits) instead of Omnilock's single script with different args flags. This has no practical impact: both approaches produce separate [script groups](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md) for ACP vs custody cells, require the same number of cell_deps for typical transactions, and need comparable lock detection logic in `CkbChain`.

## Script Deployment and Upgrade Surface

### Omnilock

Omnilock is deployed by `type` ([upgradable](https://github.com/cryptape/omnilock)). As discussed in [cryptape/omnilock#10](https://github.com/cryptape/omnilock/issues/10), referencing by `type` means Cryptape could upgrade the script and silently change its behavior. The [agreed mitigation](https://github.com/cryptape/omnilock/issues/10#issuecomment-2697129705) is to reference by `data` (immutable hash) instead, optionally deploying a bridge-owned copy (~124k CKB).

**Upgrade surface**: with `data` reference, zero upgradable scripts. Both custody and deposit cells depend on this single script.

### TSS + Standalone ACP

The default `secp256k1-blake160-sighash-all` lock is a genesis-deployed [system script](https://github.com/nervosnetwork/ckb-system-scripts) (no runtime privilege; see [README](../README.md#1-multi-signer-addresses)), never upgraded since genesis. The RFC 0026 ACP lock is deployed by `type` but has never been upgraded since 2020. Both are safe to reference by `data`.

**Upgrade surface**: zero upgradable scripts (both `data`-referenced, never upgraded since deployment).

## Security Analysis

### On-Chain Verification Model

**Omnilock multisig**: the on-chain script verifies M distinct secp256k1 signatures against N registered pubkey hashes. An observer can verify that M distinct guards authorized the transaction.

**TSS + ACP**: the on-chain script verifies one secp256k1 signature against one pubkey hash. The chain has no knowledge of the threshold structure.

### Attack Scenarios

**Compromise of fewer than M guard keys**: blocked in both cases. Omnilock requires M distinct signatures; TSS cannot produce a valid signature without M parties participating in the MPC protocol ([proven in tss-lib](https://github.com/bnb-chain/tss-lib)). Both provide M-of-N security, enforced on-chain (Omnilock) vs off-chain MPC (TSS).

**MPC implementation bug**: not applicable to Omnilock (no MPC). For TSS, a bug in tss-lib could theoretically leak key material, mitigated by tss-lib being [audited and battle-tested](https://github.com/bnb-chain/tss-lib#security). The same risk already exists for Bitcoin, Ethereum, Doge, Binance, and Bitcoin Runes in Rosen Bridge.

**Lock script upgrade attack**: Omnilock mitigated by `data` reference (see [cryptape/omnilock#10](https://github.com/cryptape/omnilock/issues/10)). TSS: both locks are `data`-referenced, no upgrade risk.

**Go binary failure**: Omnilock signing is pure TypeScript. TSS depends on the [tss-api Go binary](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api), which auto-restarts on crash (5s gap). This risk already exists for all other TSS chains.

**TSS compromise at bridge level**: Rosen Bridge already uses ECDSA TSS for 5+ chains sharing the same tss-lib, Go binary, and keygen shares. If an attacker finds a tss-lib vulnerability, they can exploit it against Bitcoin or Ethereum without needing CKB. Adding CKB to TSS does not meaningfully expand the attack surface. Both approaches enforce the same M-of-N threshold with the same cryptographic assumptions, so switching CKB to on-chain multisig does not harden a bridge where all chains share a single trust boundary. This is the same reasoning applied to the [Quantum Resistant Lock](../README.md#1-multi-signer-addresses).

| Dimension | Omnilock multisig | TSS + ACP |
|---|---|---|
| Threshold enforcement | On-chain (verifiable by observers) | Off-chain MPC (invisible on-chain) |
| MPC attack surface | None specific to CKB | Same as 5+ other TSS chains |
| Lock script upgrade risk | Zero (with `data` reference) | Zero (`data`-referenced, never upgraded) |
| Go binary dependency | Not needed for CKB | Already running for 5+ chains |

## Guard Rotation and Migration

Guard rotation is where the two approaches diverge most. The dimensions above are near-parity; migration scope is not.

Both approaches require full asset migration on guard rotation. TSS reshare/regroup (which would preserve the public key and avoid migration) is mentioned in the [tss-api README](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api) but [no implementation exists](./tss.md#lock-address-and-guard-rotation). This analysis assumes it will not ship.

### Address Change Mechanics

**Omnilock multisig**: lock args contain `blake160(S|R|M|N|pubkey_hashes)`. Any change to M, N, or the pubkey set changes the address. Only CKB is affected.

**TSS + ACP**: lock args contain `blake160(tss_shared_pubkey)`. A new keygen ceremony produces a new shared public key (via DKG, no single guard holds the full private key), changing the derived public key for **every ECDSA chain simultaneously** (Bitcoin, Ethereum, Doge, Binance, Bitcoin Runes, and CKB). Cardano (EdDSA) also changes from its own separate keygen.

### Blast Radius

| Factor | Omnilock multisig | TSS + ACP |
|---|---|---|
| CKB address changes | Yes | Yes |
| Other chain addresses change | No (independent) | Yes (all ECDSA + EdDSA chains) |
| CKB migration required | Yes | Yes |
| Other chain migrations required | Independent of CKB | Already required (new keygen affects all TSS chains) |
| Who signs CKB migration txs | Old guards (collect-and-assemble, TypeScript) | Old guards (TSS MPC via Go binary) |

With Omnilock, CKB's migration is **CKB-scoped**. With TSS, it is part of a **bridge-wide migration event**, but these bridge-wide migrations are already required regardless of CKB's signing approach.

### Migration Steps

**Omnilock multisig:**
1. Compute new lock args from new guard set: `blake160(S|R|M|N|new_pubkey_hashes)`
2. Submit arbitrary orders via [`POST /order`](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/api/arbitrary.ts) for each CKB asset
3. Old guards sign via collect-and-assemble (pure TypeScript)
4. Wait for 50 CKB confirmations (~8 minutes)

**TSS:**
1. New guard set runs keygen ceremony (~10 min). Produces new ECDSA and EdDSA shared public keys (and per-guard private shares via DKG).
2. Derive new CKB lock address: BIP-44 path `m/44'/309'/0'/0` produces the public key, `blake160(pubkey)` gives the lock args
3. Submit arbitrary orders for each CKB asset
4. Old guards sign via TSS MPC (Go binary)
5. Wait for 50 CKB confirmations (~8 minutes)

### The Overlapping Guards Problem (TSS-Specific)

The Go binary stores keygen shares in a single file per algorithm. A guard cannot hold old and new shares simultaneously (HTTP 400 on new keygen attempt). Guards overlapping between old and new sets must complete all migration signing before joining the new keygen. Omnilock has no such constraint: each guard's signing key is their individual secp256k1 key, persistent and independent of set composition.

### Migration Timeline

| Phase | Omnilock multisig | TSS + ACP |
|---|---|---|
| Compute new addresses | Instant (hash of new pubkey set) | Keygen ceremony (~10 min) |
| Drain CKB hot cells | Collect-and-assemble | TSS MPC |
| Drain CKB cold cells | Same | Same |
| CKB confirmations | 50 blocks (~8 min) | 50 blocks (~8 min) |
| Other TSS chains | N/A (independent) | Already happening in parallel |
| Wait for slowest chain | N/A | Binance: 900 confirmations (~45 min) |
| Update configs | CKB addresses only | All chain addresses, keygen files, tss.pubs |

CKB migration takes ~20 minutes with Omnilock (no keygen + 50 confirmations). With TSS, CKB is gated by the bridge-wide bottleneck (~45 minutes). The bridge-wide migration happens regardless of CKB's signing approach.

### Migration Documentation Gap

No migration procedure is documented in Rosen repos. The [contract README](https://github.com/rosen-bridge/contract) (Section D.2) mentions the requirement; the [ArbitraryProcessor](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/arbitrary/arbitraryProcessor.ts) provides the mechanism; all coordination would be manual. See [rosen-bridge/rcs#2](https://github.com/rosen-bridge/rcs/issues/2) for the questions raised with the Rosen team.

### Operational Isolation of Multisig Migration

This documentation gap affects both approaches, but not equally. With TSS, CKB migration uses the same signing backend as 5+ other chains (Bitcoin, Ethereum, Doge, Binance, Bitcoin Runes). Whatever migration procedures, tooling, and operational playbooks get built for those chains work for CKB too: CKB is one more chain in an existing event.

With Omnilock multisig, CKB becomes the only non-Ergo chain that needs asset migration through a non-TSS signing path. Ergo does not need migration (Lock address is stable across rotations, see [multisig.md](./multisig.md#ergo-rotation-no-migration)). So CKB would be the sole consumer of:

- A signing package that does not exist yet (`ckb-multi-sig`)
- Migration procedures that cannot reuse whatever gets built for TSS chains (different signing backend)
- CKB-specific operational coordination that no other chain needs

The signing protocol itself is straightforward (collect-and-assemble, simpler than [Ergo's 5-round Schnorr](./multisig.md#ergo-multi-sig-signing-protocol)). The concern is that CKB's migration gap must be closed separately, using infrastructure that also does not exist yet, for exactly one chain.

## Implementation Scope

### On-Chain Multisig (Either Variant)

Both multisig variants require:
- **`ckb-multi-sig` package**: new `@rosen-bridge/ckb-multi-sig` in [sign-protocols](https://github.com/rosen-bridge/sign-protocols) with P2P coordination, sighash computation, and multisig witness assembly (~500-1000 LOC)
- **Unmerged CCC PRs**: [#349](https://github.com/ckb-devrel/ccc/pull/349) (open) adds system multisig signers (`SignerMultisigCkbPrivateKey`), witness codec (`MultisigCkbWitness`), and transaction aggregation. [#360](https://github.com/ckb-devrel/ccc/pull/360) (draft) is a superset of #349 that adds Omnilock witness encoding (`OmniLockWitnessLock`) and Omnilock multisig signers (`SignerMultisigOmniLockPrivateKey`). System multisig needs only #349; Omnilock needs #360.

Omnilock-specific:
- **Omnilock molecule encoding**: [OmniLockWitnessLock](https://github.com/cryptape/omnilock/blob/main/c/omni_lock.c) construction, dummy witness sizing, placeholder creation, final encoding
- **Lock script handling**: parse Omnilock auth flag + auth content + omnilock flags for cell detection

Does not require changes to TSS infrastructure or Go binary configuration.

### TSS + ACP

Requires:
- **Guard config**: add `ckb.tssChainCode` and `ckb.derivationPath` (3 lines in `default.yaml`, 2 lines in `GuardsCkbConfigs`)
- **TSS chain wiring**: add CKB to `chainHandler.ts` with `wrapCurveSignMediator()` (~10 lines)
- **Key derivation**: BIP-44 path `m/44'/309'/0'/0` ([CKB technical parameters](../README.md#ckb-technical-parameters)), passed to existing ECDSA TSS. No separate keygen needed.
- **Lock script handling**: detect two `code_hash` values (default lock and ACP)

Does not require a new signing package, CCC multisig PR, or Omnilock molecule encoding.

### Shared Work (Identical Regardless of Signing Approach)

| Phase | Description | Impact |
|---|---|---|
| 1 | Scanner | None |
| 2 | Address codec | None |
| 3 | Rosen Extractor | None (extracts from cell data, lock-script-agnostic) |
| 4 | Observation Extractor | None |
| 5a | Abstract Chain bases | Lock script detection (two scripts vs one, comparable) |
| 5b | Universal extractor | None |
| 5c | Abstract Chain impl | Signing and witness construction differ |
| 5d | Network | None (`getAcpCells` queries by lock script) |
| 6 | Health Check | None |
| 7 | Service Integration | Wiring differs (TSS mediator vs multi-sig handler) |
| 8 | UI | Different lock script for deposit tx, same user flow |
| 9 | Contracts | Deploy ACP cells with different lock, same structure |

## Summary of Tradeoffs

| Dimension | Omnilock multisig | TSS + ACP |
|---|---|---|
| **Threshold enforcement** | On-chain (M-of-N verifiable by observer) | Off-chain MPC (appears as single-key) |
| **Lock script count** | 1 (Omnilock for custody and deposits) | 2 (default lock + RFC 0026 ACP) |
| **Custody cell capacity** | 144 CKB | 142 CKB |
| **Deposit cell capacity** | 146 CKB | 144 CKB |
| **Spending witness size** | 1839 bytes (M=19, N=30) | 65 bytes |
| **Consolidation tx size** | ~2300 bytes | ~500 bytes |
| **Lock script upgrade risk** | Zero (with `data` reference) | Zero (`data`-referenced, never upgraded) |
| **New code required** | ~500-1000 LOC + 2 unmerged CCC PRs | ~10 LOC + 5 config lines |
| **CKB signing dependency** | Pure TypeScript | Go binary (already running for 5+ chains) |
| **Guard rotation scope** | CKB-scoped (~20 min) | Bridge-wide (~45 min) |
| **Overlapping guards** | No conflict (individual keys persist) | Dual-share conflict |
| **Deposit flow** | Identical | Identical |
| **Signing latency** | 0-180s (3-min turns, collect-and-assemble) | 0-60s turn + MPC (comparable) |
| **Signature caching** | Not applicable | 24-hour cache |
| **Parallel signing** | 1 batch per turn | Up to 5 per turn |

## References

### CKB

- [secp256k1-blake160-sighash-all](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_sighash_all.c): Default lock script
- [secp256k1-blake160-multisig-all](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_multisig_all.c): System multisig script
- [RFC 0026 Anyone-Can-Pay](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md): ACP lock
- [RFC 0042 Omnilock](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0042-omnilock/0042-omnilock.md): Composable lock with multisig + ACP modes
- [Omnilock source](https://github.com/cryptape/omnilock): Implementation
- [RFC 0022 Transaction Structure](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md): Cell model, script groups, capacity formula

### Rosen Bridge

- [tssSigner.ts](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/tssSigner.ts): TSS coordination
- [tss-api](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api): Go MPC binary
- [tssHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/tssHandler.ts): Guard-service TSS integration
- [chainHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/chainHandler.ts): Per-chain sign mediator wiring
- [Communicator](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/communication/lib/communicator.ts): P2P coordination base class
- [GuardTurn](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/utils/guardTurn.ts): Turn scheduling
- [ArbitraryProcessor](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/arbitrary/arbitraryProcessor.ts): Arbitrary transaction mechanism
- [BNB tss-lib](https://github.com/bnb-chain/tss-lib): Threshold ECDSA and EdDSA

### Project-Specific

- [Technical plan](../README.md): CKB integration for Rosen Bridge
- [cryptape/omnilock#10](https://github.com/cryptape/omnilock/issues/10): Type vs data reference, upgrade risk
- [Guard rotation: multi-sig](./multisig.md): Ergo multi-sig, key rotation, migration
- [Guard rotation: TSS](./tss.md): TSS keygen, signing, regroup status
- [rosen-bridge/rcs#2](https://github.com/rosen-bridge/rcs/issues/2): Guard rotation questions
