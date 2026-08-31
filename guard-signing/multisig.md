# Rosen Bridge Ergo Guard Set and Signing

This document records how Rosen represents guards on Ergo and how Ergo signing differs from non-Ergo chains that use a threshold signature scheme (TSS). It is evidence for the [CKB signing decision](./README.md), not a CKB migration runbook; the arbitrary-order, manual prebuilt, and cold-storage contracts live in the integration [README](../README.md) and its [work items](../implementation/README.md).

## Guard Config Box

The canonical Ergo guard set lives in the Guard Config Box, identified by the Guard non-fungible token (NFT).

| Register | Type | Content |
| --- | --- | --- |
| R4 | `Coll[Coll[Byte]]` | Compressed ECDSA public keys |
| R5 | `Coll[Int]` | `[paymentSignRequired, updateSignRequired]` |

The [`GuardSign`](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/src/main/scala/rosen/bridge/scripts/GuardSign.es) contract requires the update threshold and preserves the Guard NFT when the box changes. Ergo [`Lock`](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/src/main/scala/rosen/bridge/scripts/Lock.es), [`RepoConfig`](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/src/main/scala/rosen/bridge/scripts/RepoConfig.es), and [`Emission`](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/src/main/scala/rosen/bridge/scripts/Emission.es) read guard data from the box rather than embedding the guard set in their addresses.

As a result, an Ergo guard rotation updates the Guard Config Box but does not change the Ergo Lock address or require migration of existing Lock boxes.

## Runtime Guard Detection

Guard-service's [`GuardPkHandler`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/handlers/guardPkHandler.ts) reads the Guard Config Box, caches keys and thresholds, determines the local guard index, and propagates changes to dependent modules. The default Guard configuration refreshes this state every 180 seconds.

[`GuardDetection`](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/detection/lib/guardDetection.ts) maps configured guard public keys to live peer IDs through registration, approval, and heartbeat messages. Active guard records are sorted by public key for deterministic TSS participant ordering.

## Ergo Interactive Multisig

Ergo uses an interactive Schnorr protocol implemented by [`multiSigHandler.ts`](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/ergo-multi-sig/lib/multiSigHandler.ts), not CKB's native multisig script.

The message flow is:

| Message | Purpose |
| --- | --- |
| `GenerateCommitment` | Coordinator broadcasts the transaction and its commitments |
| `Commitment` | Peers return commitments |
| `InitiateSign` | Coordinator distributes real and simulated hints |
| `Sign` | Selected signers return partial proofs |
| `SignedTx` | Coordinator broadcasts the aggregated transaction |

The coordinator uses Guard's three-minute turn schedule. Each turn has a two-minute active interval and a final one-minute gap. In-flight state may reset when the guard-key array changes; stale transactions are eventually removed by timeout handling.

Every recipient validates the final Ergo transaction proof before accepting it as signed.

## Transaction Agreement

Cryptographic signing starts only after [`TxAgreement`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/agreement/txAgreement.ts) reaches the configured guard threshold on the transaction proposal. This agreement layer is shared by Ergo multisig and non-Ergo TSS chains.

Agreement does not replace chain-specific validation. A CKB transaction still needs CKB full-script, capacity, cell-selection, fee, conflict, and signing checks before a guard approves it.

## Rotation by Chain Family

### Ergo

1. The current update threshold authorizes a new Guard Config Box.
2. The output preserves the Guard NFT and updates R4/R5.
3. Guard services refresh their runtime guard state.
4. Existing Ergo Lock boxes remain under the same contract address.

### TSS Chains

The public service exposes no regroup route, while the first mainnet CKB integration release inherits Rosen's existing private TSS key lifecycle used by its other ECDSA chains. See the [TSS analysis](./tss.md).

### Native CKB Multisig Alternative

If CKB used native multisig, any guard-set or threshold change would change the CKB lock args and address. CKB would then need a signing and migration path separate from both Ergo and Rosen's current TSS service. This is why native multisig remains a future alternative rather than the first-release plan.

## Sources

- [Rosen contract overview and guard updates](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/README.md)
- [GuardSign contract](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/src/main/scala/rosen/bridge/scripts/GuardSign.es)
- [Ergo multisig handler](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/ergo-multi-sig/lib/multiSigHandler.ts)
- [Guard key handler](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/handlers/guardPkHandler.ts)
- [Guard detection](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/detection/lib/guardDetection.ts)
- [Transaction agreement](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/agreement/txAgreement.ts)
