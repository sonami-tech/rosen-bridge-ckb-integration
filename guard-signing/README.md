# CKB Bridge Wallet Signing Decision

## Decision

The first mainnet CKB integration release uses Rosen's existing ECDSA threshold signature scheme (TSS) service with the canonical mainnet `Secp256k1Blake160` lock. Native CKB multisig remains a future alternative.

This is an implementation and operations decision, not a claim that TSS and native multisig have identical cryptographic risk. Native multisig is the simpler cryptographic construction. TSS is selected because it reuses Rosen's existing distributed-signing service and avoids creating a CKB-only coordination and migration path for the first release.

The companion [TSS analysis](./tss.md) records executable signer behavior and operational ownership. The [Ergo signing analysis](./multisig.md) explains why Ergo's existing guard-set and multisig path does not supply a native CKB signing path.

## Fixed First-Release Constraints

- Deposits and custody use normal outputs under one configured Rosen lock.
- The Rosen lock is the canonical mainnet default lock:

  ```text
  codeHash = 0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8
  hashType = type
  args     = CKB blake160(33-byte compressed SEC1 derived TSS public key)
  dep      = canonical mainnet dep group recorded by work item 08
  ```

- CKB follows Rosen's non-hardened derivation-array convention. The integration [README](../README.md#derivation-parameters) owns the proposed shape, and [work item 08](../implementation/08-contract-deployment-handoff.md) owns its deployment inputs.
- CKB-specific code owns transaction finalization, SighashAll preparation, TSS result validation, and witness insertion. Existing Rosen code owns approval and multi-party computation (MPC) execution.
- CKB inherits Rosen's existing TSS key lifecycle; private ceremony and rotation procedures remain Rosen operations rather than a CKB integration deliverable.

## ECDSA TSS Path

The integration [README](../README.md#wrapper-serialization-and-signing) owns the exact CKB signing contract. [Work item 03](../implementation/03-guard-chain-and-rpc-integration.md) owns its implementation and verification. In summary, CKB finalizes the placeholder transaction, computes SighashAll from explicitly re-resolved inputs, sends the digest directly to Rosen TSS, validates the result and recovered key, replaces only the lock placeholder, and then runs CKB cycle, transaction, and fee checks.

The on-chain lock sees one recoverable secp256k1 signature and does not expose the off-chain threshold.

### Reused Infrastructure

- Rosen's TypeScript `TssSigner` approval and scheduling layer
- Rosen's Go `tss-api` and BNB tss-lib MPC implementation
- Existing ECDSA chain mediator boundary in Guard
- Existing transaction-agreement, arbitrary-order, manual-signing, and monitoring conventions

### New CKB Work Still Required

- Full-lock-group discovery and independent event re-extraction through `verifyEvent`
- Canonical witness placeholder and signature assembly
- CKB fee, cycle, occupied-capacity, and cell-selection logic
- In-window candidate, active-state, and mempool reconciliation
- Payment, cold-storage, arbitrary, and manual transaction validation
- Failure handling across payment, cold-storage, arbitrary, and manual paths

TSS reuse therefore reduces new distributed-signing work; it does not reduce the entire CKB signing integration to configuration or a few lines of code.

## Native Multisig Alternative

The narrow alternative is the mainnet `Secp256k1MultisigV2` known script exposed by CCC, the CKB ecosystem JavaScript SDK:

```text
codeHash = 0x36c971b8d41fbd94aabca77dc75e826729ac98447b46f91e00796155dddb0d29
hashType = data1
args     = blake160(S | R | M | N | pubkey_hashes)
```

Its spending witness is:

```text
WitnessArgs.lock = S | R | M | N | pubkey_hashes | M recoverable signatures
```

For the illustrative profile `M = 19` and `N = 30`, the lock field is `4 + 30 * 20 + 19 * 65 = 1839` bytes. The script verifies the threshold on-chain without an MPC protocol.

Rosen would still need a new CKB-specific service or package that owns coordinator selection, P2P request authentication, independent signature collection, duplicate/session handling, witness aggregation, retries, monitoring, and migration signing. CCC's witness helpers do not provide those Rosen operational processes.

## Risk Comparison

### Threshold Visibility

- **ECDSA TSS:** Off-chain MPC with one signature on-chain.
- **Native multisig:** M-of-N is visible and enforced on-chain.

### Cryptographic and Protocol Surface

- **ECDSA TSS:** Interactive MPC, share storage, and session and transport assumptions.
- **Native multisig:** Independent ordinary signatures and a native verifier.

### New Rosen Implementation

- **ECDSA TSS:** A CKB transaction/digest adapter on the existing signer.
- **Native multisig:** A new CKB distributed collection and aggregation path.

### Marginal Operational Surface

- **ECDSA TSS:** Reuses the existing TSS deployment and monitoring.
- **Native multisig:** Adds CKB-only signing, recovery, and monitoring procedures.

### Spending Witness

- **ECDSA TSS:** 65-byte lock field.
- **Native multisig:** 1839-byte lock field in the illustrative M=19, N=30 profile.

### Guard-Set Change

- **ECDSA TSS:** Fresh distributed key generation (DKG) changes all derived TSS addresses; regroup is not currently exposed.
- **Native multisig:** CKB lock args change with the guard set.

### Migration Scope

- **ECDSA TSS:** CKB participates in a bridge-wide TSS key-change event.
- **Native multisig:** Would be a CKB-specific migration event.

### Operational Lifecycle

- **ECDSA TSS:** Reuses Rosen's existing TSS operations; the private procedure is outside the public CKB integration contract.
- **Native multisig:** Would require a new CKB-specific procedure.

### Security Interpretation

Native multisig removes TSS implementation and share-management risk from direct CKB custody and provides defense in depth. TSS retains those risks, and the two approaches do not share identical cryptographic assumptions.

Conversely, a new multisig path creates implementation and operations risk in code and procedures that Rosen does not currently operate. For the first release, that marginal risk is more immediate than the benefit of a second signing architecture. The decision should be revisited if Rosen develops a reusable native-signature collector or an audit identifies unacceptable TSS risk.

## Reconsideration Gates

Re-open native multisig only with:

- An owner and design for authenticated signature collection and aggregation
- Failure, retry, monitoring, and recovery behavior
- Payment, cold, arbitrary, and manual path coverage
- A CKB-specific multisig operational lifecycle, including guard-set changes
- Tests and audit scope comparable to the existing TSS path

## Sources

- [CKB default SighashAll lock](https://github.com/nervosnetwork/ckb-system-scripts/blob/f25c5ae8824c4907ad94326a0113a03defab9bfc/c/secp256k1_blake160_sighash_all.c)
- [CKB native multisig lock, genesis-deployed source](https://github.com/nervosnetwork/ckb-system-scripts/blob/5e3756ef4d8c90e87149f4790114ad1c003a2f04/c/secp256k1_blake160_multisig_all.c)
- [CKB native multisig lock v2, the selected alternative baseline](https://github.com/nervosnetwork/ckb-system-scripts/blob/d2629554c4db540c6ebb23b2abe83c29c4887fc8/c/secp256k1_blake160_multisig_all.c)
- [CCC mainnet known scripts](https://github.com/ckb-devrel/ccc/blob/a15c3a783ee2763813b1bcd0f3c27d2e863317b9/packages/core/src/client/clientPublicMainnet.advanced.ts)
- [CCC transaction signing helpers](https://github.com/ckb-devrel/ccc/blob/a15c3a783ee2763813b1bcd0f3c27d2e863317b9/packages/core/src/ckb/transaction.ts) (differential reference, not Guard runtime)
- [Rosen TSS signer](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/tss/lib/tss/tssSigner.ts)
- [Rosen TSS API](https://github.com/rosen-bridge/sign-protocols/tree/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/tss-api)
- [Rosen Guard TSS integration](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/handlers/tssHandler.ts)
- [Rosen contract guard-update notes](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/README.md#2-guards-update)
- [TSS details](./tss.md)
- [Ergo guard and signing details](./multisig.md)
