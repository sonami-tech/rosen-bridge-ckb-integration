# Rosen Bridge Threshold Signature Scheme and Guard Rotation

This document records the executable threshold signature scheme (TSS) behavior inspected for the CKB integration. It distinguishes current source behavior from intended resharing and migration architecture.

## Architecture

TSS signing uses two layers:

1. The TypeScript [`TssSigner`](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/tss/lib/tss/tssSigner.ts) coordinates guards, approval, scheduling, liveness, and result caching.
2. The Go [`tss-api`](https://github.com/rosen-bridge/sign-protocols/tree/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/tss-api) runs BNB tss-lib keygen and signing.

Guard-service spawns one Go binary for both ECDSA and EdDSA, supplies a random trust key, and restarts it five seconds after failure. Guard deployments currently download that binary without a pinned version.

Successful and failed signing callbacks carry the trust key and are rejected when it does not match the active child process. Keygen is run by the separate keygen service, and its callbacks do not use this signing trust-key contract.

Work item 08 owns the approved artifact identity, provenance, and CKB direct-digest compatibility evidence. Shared executable lifecycle and containment remain Rosen-wide Guard scope.

The Go API exposes:

- `GET /threshold`
- `POST /getPK`
- `POST /sign`
- `POST /keygen`
- `POST /message`

It exposes no regroup or reshare route.

## Algorithms and Derivation

- **ECDSA secp256k1:** Used by Bitcoin-family and EVM-family chains and proposed for CKB. Child derivation requires a non-empty `uint32[]` path and configured chain-code string.
- **EdDSA Ed25519:** Used by Cardano. Rosen does not expose a derivation path.

Rosen's pinned BNB tss-lib implements public/non-hardened ECDSA child derivation only. Every index must be less than `0x80000000`; hardened BIP-32/BIP-44 indices are rejected. Existing Guard material shows arrays such as `[44, 60, 0, 0]`; that array is an illustrative example, not a checked deployment value.

CKB therefore proposes the same four-level non-hardened shape, `[44, 309, 0, 0]`. It is BIP-44-shaped namespacing, not a standards-compliant hardened BIP-44 wallet path. The final array and `tssChainCode` string remain Rosen deployment inputs supplied before deriving the CKB public key, lock args, or address.

The configured chain-code string is passed to the Go derivation code as bytes. Current Rosen validation does not enforce BIP-32's nominal 32-byte chain-code length, so the exact value is an operational identifier that must be copied consistently rather than inferred by Sonami.

## Key Generation

The separate [`keygen-service`](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/keygen-service/src/service/tss.ts) supports ECDSA and EdDSA. It waits for every configured peer, then invokes `/keygen` with participant IDs, threshold, algorithm, and a 600-second operation timeout.

Distributed key generation (DKG) produces:

- One shared public key per algorithm
- One private share and share ID per participant
- Metadata containing participant count and threshold

Each algorithm writes one `{TSS_HOME}/{ecdsa,eddsa}/keygen_data.json`. The current service refuses a new keygen when that file already exists.

## Signing Behavior

The TypeScript coordinator uses four message types (`request`, `approve`, `start`, and `cached`); signing proceeds as follows:

1. A queued message waits for the current 60-second guard turn.
2. The initiator requests approval from active guards.
3. After threshold approval, selected guards start their local Go operation.
4. The Go parties run multi-party computation (MPC) and return a compact signature and, for ECDSA, a recovery value.

Important effective behavior at the reviewed commits:

- The in-memory cache is keyed by raw message only. Chain code and derivation path are not part of the key.
- The Go concurrent-operation identity is algorithm plus the hash of the message. Concurrent requests for the same digest under different derived keys would conflict.
- In the exact `@rosen-bridge/tss` 5.2.0 package bytes pinned in the [decision register](../decisions-and-open-questions.md#source-facts), a network-delivered cached result verifies the compact signature against the derived public key, but that path carries a TODO and does not verify the recovery id. Results delivered through the trusted `handleSignData` callback and results served by the local in-memory cache fast path repeat no cryptographic verification at all, and the cache key omits chain code and derivation path.
- Guard's trust-key check on those callbacks authenticates the callback transport against the active child process. It is not signature or recovery validation and must not be described as such.
- CKB therefore treats every TSS result as untrusted at its adapter boundary: it requires the recovery id, validates the signature and recovery ranges, recovers the compressed key, and rejects any result whose CKB `blake160` differs from the configured lock args.

CKB must not rely on the configured cache TTL in [Reviewed Defaults](#reviewed-defaults) or use cache behavior as a transaction-state guarantee.

## CKB Signing Boundary

The integration [README](../README.md#wrapper-serialization-and-signing) owns the exact adapter contract, and [work item 03](../implementation/03-guard-chain-and-rpc-integration.md) owns its implementation and verification. The source-backed boundary is that CKB sends one already-computed 32-byte SighashAll digest per distinct full Rosen input-lock group, TSS signs that digest without a CKB prefix or second hash, and the CKB adapter treats the result as untrusted until it validates the signature and recovered key. TSS owns participant approval and MPC execution; the [signing decision](./README.md) records why this boundary was selected.

## Key Lifecycle Ownership

### Executable Current State

- A fresh DKG produces a new shared public key.
- Every address derived from that algorithm's key changes.
- The current Rosen service has no regroup implementation.
- BNB tss-lib contains resharing primitives that can preserve a public key, but the reviewed public service does not expose them.

The Rosen contract README describes TSS resharing as the intended guard-update architecture. The reviewed public service does not expose that route, but public source is not evidence about Rosen's private ceremony or rotation procedure.

CKB inherits the same key lifecycle as Rosen's existing ECDSA TSS chains. This integration supplies CKB transaction preparation and signature insertion only. Rosen operations own key generation, participant changes, rotation, and any bridge-wide migration. The [deployment handoff work item](../implementation/08-contract-deployment-handoff.md) confirms the current shared public key, `tssChainCode`, derivation array, and resulting CKB lock; it does not require publication or reimplementation of Rosen's operational procedure.

## Reviewed Defaults

- **Turn duration:** 60 seconds.
- **No-work window:** Final 10 seconds; suppresses approve-to-start only.
- **Sign timeout:** 600 seconds from queue insertion.
- **Messages started per turn:** Up to 5 in Guard configuration.
- **Threshold refresh:** 60 seconds.
- **Signer update job:** 10 seconds.
- **Effective cache TTL:** 7,200 seconds from the TypeScript `TssSigner` base class; configured 86,400 seconds is not forwarded.
- **Keygen timeout:** 600 seconds.
- **Binary restart gap:** 5 seconds.

## Sources

- [TSS coordinator](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/tss/lib/tss/tssSigner.ts)
- [ECDSA signer constructor](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/tss/lib/tss/ecdsaSigner.ts)
- [Go TSS routes](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/tss-api/api/router.go)
- [Go keygen/sign state](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/tss-api/app/rosenTss.go)
- [Rosen ECDSA derivation adapter](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/tss-api/app/sign/ecdsa/ecdsa.go)
- [BNB non-hardened derivation](https://github.com/bnb-chain/tss-lib/blob/28d0622477bfe05ed2c950d2728d8c4ace70a0a0/crypto/ckd/child_key_derivation.go)
- [Guard TSS handler](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/handlers/tssHandler.ts)
- [Guard TSS defaults](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/config/default.yaml)
- [Rosen guard-update documentation](https://github.com/rosen-bridge/contract/blob/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4/README.md#2-guards-update)
