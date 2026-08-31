# CKB Transaction Identity and Finality

This document records the identity and finality analysis behind the CKB integration. No single CKB or Rosen identifier owns transaction-byte commitment, block location, event identity, Guard agreement, terminal suppression, and reorganization protection at once.

## Authority

Rosen's [public response on `rcs#2`](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-4926455588) settles the move from one Anyone Can Pay (ACP) cell to normal Rosen-lock UTXOs, raises the blanket Scanner input-resolution concern, asks about public endpoint availability, and assigns chain-index ownership. It does not prescribe the witness envelope, confirmation value, node topology, `agreementId`, terminal suppression, or committed-only custody policy.

Those remaining choices are Sonami's source-backed proposal under the [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003). Ordinary upstream pull-request review is their acceptance path. The local-node topology answers Rosen's public-endpoint question but has not received separate public Rosen acceptance.

## Native CKB Identities

CKB defines several identities with different scopes.

- **Raw transaction hash, Rosen `txId`:** Identifies the `RawTransaction` and CKB OutPoints, excludes witnesses, and is available before block inclusion.
- **`witness_hash`:** Commits the complete Molecule-serialized `Transaction`, includes witnesses, and is available before block inclusion once all witnesses are final.
- **`TransactionKey { block_hash, index }`:** Locates one complete transaction at one ordered position in one stored block, includes witnesses transitively through `block_hash`, and is unavailable before block inclusion.
- **`ProposalShortId`:** Contains the first ten bytes of the raw transaction hash, excludes witnesses, and is available before block inclusion.
- **Rosen source event ID:** Equals `blake2b(sourceTxId)` under the current shared Guard contract, excludes witnesses, and is available after source transaction discovery.
- **CKB `agreementId`:** Commits the canonical placeholder payment wrapper and Rosen request context, includes witnesses in placeholder form, and is available before block inclusion.

The raw transaction hash deliberately excludes witnesses. [`TransactionReader::calc_tx_hash`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/gen-types/src/extension/calc_hash.rs#L125-L152) delegates to the raw transaction hash, while `calc_witness_hash` hashes the complete serialized `Transaction`. Despite its name, `witness_hash` is CKB's native full-transaction-byte commitment.

CKB stores full block transactions under the Molecule [`TransactionKey`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/gen-types/schemas/extensions.mol#L60-L63), whose fields are `block_hash` and big-endian transaction `index`. [`insert_block`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/store/src/transaction.rs#L201-L208) writes each complete block-body transaction under that key. Canonical transaction metadata is a separate index keyed by raw transaction hash.

The block header's `transactions_root` combines a Merkle root of raw transaction hashes with a Merkle root of full `witness_hash` values. [`MerkleRootVerifier`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/verification/src/block_verifier.rs#L189-L210) rejects a block whose header does not match the computed root. The block hash therefore commits each complete transaction at its ordered position.

CKB's [`DuplicateVerifier`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/verification/src/block_verifier.rs#L158-L187) rejects duplicate raw transaction hashes within one valid block. Two transactions with the same raw fields and different witnesses cannot occupy two positions in that block. Different competing blocks may contain different witness variants, in which case their witness roots and block hashes differ.

## Identity Is Not Finality

`TransactionKey { block_hash, index }` identifies exact bytes in one observed block. It does not make that block canonical forever. A reorganization can replace the block, its transaction position, and the complete Rosen request together.

The same boundary applies to every other identifier:

- A sender signature proves authorization relative to the signed transaction, not permanence of the containing block.
- `witness_hash` proves exact transaction bytes, not canonical inclusion.
- Raw `txId` identifies one raw transaction, not its witnesses or finality.
- A Rosen metadata digest would identify metadata, not prevent a replacement chain from removing the whole transaction.
- A Rosen event ID controls application identity, not consensus finality.

The bridge must therefore wait for its configured confirmation depth before acceptance. If that assumption fails, the design has no metadata-based fallback and makes no automatic rollback promise after Guard acceptance or completed payment.

## Source Deposits

The source path has three independent checks:

1. A qualified sender lock signs the complete extra-witness suffix, including the Rosen envelope at `witnesses[inputs.length]`. This prevents a relay peer or miner from changing that envelope before confirmation while retaining the same raw transaction hash.
2. The confirmed block commits the complete transaction through the witness root and `transactions_root`.
3. Guard's `getTxConfirmation` check owns committed status and sufficient depth. `verifyEvent` separately requires the claimed `sourceBlockId` to be canonical, selects the unique `sourceTxId` transaction from that block body, re-extracts the request, and compares every event field.

The source block and transaction hash already provide the semantics of CKB's native block-body key. Within one valid block, the raw transaction hash selects at most one transaction, so Guard can derive its transaction index when needed. Carrying the index as another business identifier would not strengthen the finality model.

The source event ID remains `blake2b(sourceTxId)` because the first mainnet CKB integration release permits one request per transaction and this preserves Rosen's shared event contract. This choice is not reorganization protection. Confirmation depth owns that property.

No additional source mechanism is required:

- A cell-stored envelope digest has no standard script validating its Rosen meaning or its relationship to the witness.
- Off-chain digest recomputation duplicates bytes already committed by the block.
- A schema epoch adds speculative acceptance surface; the exact-position, exact-consumption parser already rejects incompatible formats.
- `witness_hash` or `TransactionKey` could identify exact confirmed bytes, but Guard already obtains and verifies those bytes from the claimed block.
- A new event ID does not improve finality and is unnecessary while one source transaction yields at most one event.

## Existing Rosen Precedent

Existing Rosen event identity is transaction-derived. Guard's [`EventSerializer`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/event/eventSerializer.ts#L12-L17), shared Utils, and Scanner hash the source transaction ID without block hash, transaction index, output index, or log index. No inspected integration uses a block-qualified transaction position as its durable business event ID.

The shared [`AbstractChain.verifyEvent`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/abstract-chain/lib/abstractChain.ts#L164-L262) treats `sourceBlockId` as verification context: it checks transaction membership, fetches the transaction, re-extracts the request, and compares event fields. CKB must implement that contract strictly by reading the claimed block because some existing providers ignore the optional block argument on their raw transaction fetch.

Pinned Scanner source rolls observations back when their blocks fork before acceptance. At the pinned Watcher revision, Watcher applies a confirmation gate before commitment creation. At the pinned Guard revision, no source-reorg path rolls back an accepted event or completed payment. Waiting paths continue destination payment processing from stored event state, and completed transactions are excluded from active processing. CKB therefore follows shared behavior: finality is accepted at the configured depth, with no chain-specific post-acceptance rollback.

Existing outgoing identity is less uniform. EVM commits `eventId` in calldata, while the inspected UTXO-family, Cardano, and Ergo target transaction IDs generally derive from transaction bytes independently of wrapper `eventId`. Their source therefore permits identical payout bodies for different requests to share a target identity, although no pinned regression test demonstrates that collision.

The request-context hazard is a broader Guard concern. CKB fixes its own path because CKB already requires a wrapper-aware agreement change, while other chains retain their current behavior until a shared revision is proposed.

## Outgoing Agreement

### Collision Scenario

Outgoing payment agreement occurs before a block location exists, so `TransactionKey` cannot identify a candidate. Raw `txId` is also insufficient because the raw CKB transaction does not contain the Rosen `eventId` or `txType`.

The smallest distinguishing sequence is:

1. Two source events request the same CKB destination, asset, and amount.
2. Deterministic construction against the same custody state produces identical raw payment transaction `T` for either event.
3. The two wrappers share `txId(T)` but carry different `eventId` values.
4. If approvals bind only `txId(T)`, different Guards can persist different event associations for the same eventual on-chain payment.
5. Once `T` confirms, Guards can disagree about which event completed and can later attempt payment for the other event.

### Agreement Identity

Agreement must therefore bind exact placeholder transaction bytes and request context. The information-bearing fields are `txBytes`, `eventId`, and `txType`. The selected five-field `PaymentTransaction` wrapper also carries `network` and recomputed `txId`; those fields are redundant within one CKB chain instance but using the existing wrapper avoids a second serialization contract.

`agreementId` is computed over the canonical placeholder wrapper and is used for:

- request and approval signatures;
- in-memory candidate lookup keyed by `agreementId` alone;
- exact retransmission matching after recomputing the ID from the carried wrapper;
- conflict checks between different candidates;
- acceptance-time recomputation and complete verification.

`agreementId` does not replace raw `txId` for node lookup, OutPoints, submission, or confirmation.

## Signed Transactions

Under the [README signing contract](./README.md#wrapper-serialization-and-signing), the threshold signature scheme (TSS) replaces only the approved lock placeholders. Raw `txId` remains unchanged because CKB excludes witnesses, while `witness_hash` changes from the placeholder transaction to the complete signed transaction. Guard already needs the complete signed bytes for comparison and persistence, so storing the derivable `witness_hash` would add no identity.

## Terminal Suppression

Authorization identity and execution-failure identity have different scopes.

`agreementId` is wrapper-scoped because it answers which Rosen request Guards authorized. The [README](./README.md#custody-concurrency-and-transaction-chaining) owns the operative temporary/permanent classifier and retry behavior; the [decision register](./decisions-and-open-questions.md#accepted-decisions) records its status and rationale. The identity distinction requires wrapper-level failures to end before transaction persistence, while permanent execution facts may invalidate the retained raw transaction.

For the qualified CKB shape, a permanent execution result applies to every wrapper carrying the same raw transaction. The transaction has the same scripts, inputs, outputs, deps, fee, and fixed witness shape; Guard has already validated the permitted TSS signature replacement. Retrying another `eventId` with the same raw bytes cannot repair a deterministic script failure. Cycle use may vary across valid signatures, but raw-wide overflow suppression deliberately accepts that liveness loss instead of repeating agreement and consuming scarce TSS capacity.

The existing retained `TransactionEntity` keyed by raw `txId` already stores the wrapper, scalar transaction type, and event or order relation, and survives invalidation. It can therefore own active execution and terminal suppression while `agreementId` remains an authorization identity on the wire and in memory.

The simplifying invariant is strict: **only permanent transaction-execution facts may invalidate a CKB transaction row.** If a future implementation persists wrapper-specific rejection as transaction invalidity, raw-`txId` suppression would poison otherwise valid wrappers and this decision must be reopened.

Raw-wide suppression accepts a liveness cost after a ceiling increase or valid-signature cycle variation in exchange for removing a configuration-sensitive suppression schema, signature-variant retry loop, and row-rebinding lifecycle.

## Evidence Pins

- [Primary CKB source revision](https://github.com/nervosnetwork/ckb/tree/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987): raw and witness hashing, block verification, storage, RPC, transaction-pool behavior, and `TransactionKey`.
- [Corroborating CKB source revision](https://github.com/nervosnetwork/ckb/tree/17d7db5bb423a1b2177e14a132a41d5a91a515f3): witness-root and current pool behavior used by the integration tracker.
- [Pinned Guard Service revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0): transaction-derived event identity, `txId`-bound agreement, retained transaction rows, late approval persistence, and signed transaction processing.
- [Pinned Utils revision](https://github.com/rosen-bridge/utils/tree/8074e8ac6685bc1f8c16079905ba5926b39aed1e): existing Rosen request extraction contracts.
- [Pinned Scanner revision](https://github.com/rosen-bridge/scanner/tree/85d0ae8569dcdc95b08a64904d0cb4bf99863184): transaction-derived observation IDs and pre-acceptance fork rollback.
- [Pinned Watcher revision](https://github.com/rosen-bridge/watcher/tree/f4800ffff49fb84b14dd2d95931f92a034422c45): confirmation gating before commitment creation.
- [Pinned RCS-003 revision](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003): contribution and chain-integration contract.

The integration [README](./README.md) remains the implementation contract. The [decision register](./decisions-and-open-questions.md) records accepted status and superseded alternatives; this document preserves the complete reasoning and source distinction behind those shorter requirements.
