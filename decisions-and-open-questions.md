# CKB Integration Decisions and Deployment Inputs

This register records why the CKB integration has its current shape and which answers are settled. It is a handoff for implementers, reviewers, and decision owners. It does not replace the implementation contract in [README.md](./README.md), and it does not store deployment values owned by `deployment-handoff.md`.

## Authority and Status

Apply sources in this order:

1. The pinned [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003) and later explicit Rosen protocol guidance.
2. The [Rosen response on `rosen-bridge/rcs#2`](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-4926455588). Its scope is the single Anyone Can Pay (ACP) cell rejection, the normal Rosen-lock UTXO direction, blanket input resolution, the public-endpoint question, and chain-index ownership. It asks about public endpoint availability without prescribing or accepting a topology, and does not answer the rest of this register.
3. The integration [README](./README.md), which owns the implementation contract.
4. This register, which owns decision status and evidence summaries.
5. The implementation work items, which must follow the settled contract rather than choose architecture independently.

[Sonami's published reply](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5322173229) is an unanswered proposal, not authority over the contract. It remains rationale or evidence only in the decision entries that cite it.

When this register marks another document as stale, follow the register, update every affected contract document together, then remove the marker. Exact deployment identities, thresholds, benchmarks, and measured templates belong only in `deployment-handoff.md` once [work item 08](./implementation/08-contract-deployment-handoff.md) creates it.

In this register, `v1` means the first mainnet release scope of the CKB integration. Section placement is status: accepted decisions are settled for v1, open questions await a named owner's answer, deployment inputs need measured values or owners, and superseded positions remain only where they explain stale implementation or documentation.

## Source Facts

These facts constrain the design but are not CKB policy choices.

Primary local revisions used for these facts are listed under [Evidence Pins](#evidence-pins).

### Rosen Transaction Proposal Rotates

`GuardTurn` nominates one Guard by a three-minute wall-clock slot, with two active minutes and a final no-work minute. The selected Guard normally constructs and initiates agreement for every chain during its slot. This is not a durable per-event lease.

### Signing Leadership Is Separate

The threshold signature scheme (TSS) uses an independent one-minute request/start turn. Ergo multisig uses its own coordinator turn. The transaction proposer need not lead signing.

### Fresh ECDSA Signing Is Narrower Than Proposal Production

At the [pinned Guard revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0), the active proposer drains an uncapped agreement queue every five seconds, while confirmed-event and arbitrary-order construction iterate unbounded database results sequentially until the two-minute active window ends. The same release sets Guard `parallelSign: 5` and passes it to `@rosen-bridge/tss` 5.2.0 as `signPerRoundLimit`; the library admits only the first configured number of queue entries in each independent one-minute TSS-owner round. Posted unfinished entries occupy slots until timeout, and the ECDSA signer is shared with other Rosen ECDSA chains. CKB v1 uses one Rosen input-lock group and one ECDSA digest per transaction, so five fresh ECDSA admissions per healthy minute is the current bridge-wide configured ceiling rather than a CKB allocation; completion can be lower. The deployment records this configuration and competing load, and the benchmark uses those values. Agreement can start more candidates, but that does not increase fresh signing capacity.

### Broadcasting Is Not Unique

Every Guard that stores signed bytes may submit the exact transaction through its own node. A `sent` transaction that is absent locally but still valid is resubmitted unchanged. There is no fee bump or replacement transaction in this loop.

### Guard Catch-Up Is Incomplete

A Guard that receives the threshold approval can verify and persist the transaction even if it missed the request. A Guard that misses the complete request/approval window has no general active-transaction synchronization. Completed payment synchronization exists only in a narrow reward-request path.

### Current Agreement Identity Omits Witnesses and Request Context

At the [pinned Guard revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0), approval responses and signatures bind `{txId}`, while event/order identity stays outside the signature and a late approval can persist the supplied `txJson`. CKB's transaction hash also excludes witnesses, so CKB needs the README's request-bound canonical-wrapper identity before this path is safe. Existing chains retain their current behavior.

### Existing Outgoing Identity Is Not Uniformly Request-Bound

EVM commits `eventId` in calldata, while the inspected UTXO-family, Cardano, and Ergo target IDs derive from transaction bytes independently of wrapper `eventId`. Their source permits equal payout bodies for distinct requests to share a target identity, although no pinned regression test demonstrates the collision. CKB proposes wrapper-aware approval binding; [payment attribution across Guards](#payment-attribution-across-guards) remains unresolved. Rosen's shared Guard review owns any revision for existing chains.

### A TSS Request Alone Does Not Authorize a New Local Share

At the pinned Guard revision, [`transactionProcessor.ts`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/transaction/transactionProcessor.ts#L64-L89) initially calls `chain.signTransaction` from a locally persisted `approved` transaction; its persisted `sign-failed` retry path can call the same processor again. That revision's lock resolves `@rosen-bridge/tss` 5.2.0 from [the npm tarball](https://registry.npmjs.org/@rosen-bridge/tss/-/tss-5.2.0.tgz), integrity `sha512-ONUG30kEv2gS+9NqZ9ZaVgn8l+AuWjnkCTZNgW8I0KaF2Ommg6Wh6AuEucSOsRtMtcMdnM5r47DTbP6iiG9VXQ==`. In those exact package bytes, `TssSigner.handleRequestMessage` stores a remote request when the digest is absent from the local sign queue, and only a local `sign()` call adds the digest and processes the stored request. A remote request can return an already cached result, but it cannot initiate a new local share without that digest entering local persisted transaction processing. These bytes do not establish any broader agreement guarantee.

### Current TSS Child Is Shared

At the pinned Guard revision, one [`runBinary()` child](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/handlers/tssHandler.ts#L45-L104) serves both the [ECDSA and EdDSA signers](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/handlers/tssHandler.ts#L106-L170). Artifact approval and the shared executable lifecycle remain Rosen-wide deployment and Guard responsibilities; CKB adds only direct-digest compatibility and recovered-key checks.

### Confirmed Events Have No Rejection Transition

At the [pinned Guard revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0), the event-processing path that acts on a confirmed event row has no catch branch that moves it to `EventStatus.rejected`, and the public rejected status is read from the rejected-event repository rather than from a confirmed row. A CKB target that can never be paid must therefore be rejected before `insertConfirmedEvent`, not after it.

### Guard's `/sign` Route Runs No Verifier Hooks

At the same Guard commit, the manual prebuilt `/sign` route calls `rawTxToPaymentTransaction` and then `DatabaseHandler.insertTx`. It does not invoke `verifyPaymentTransaction`, `verifyTransactionFee`, `verifyNoTokenBurned`, or `verifyTransactionExtraConditions`. Implementing those chain hooks therefore does not by itself validate a manual transaction.

### The Transaction Row Is Keyed by `txId` and Outlives Invalidation

At the [pinned Guard revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0), `TransactionEntity` uses `txId` as its primary key and carries no `agreementId` column. An invalidated transaction's row is retained rather than deleted, and `setTxAsApproved` skips a transaction whose existing row is already invalid. Distinct wrappers can share one witness-excluding CKB `txId`, so only one can own the active row. Wrapper-specific rejection occurs before persistence; permanent execution failure invalidates the raw transaction for every wrapper, so the retained row is also the durable suppression record and needs no schema change.

### Guard Validity Can Collapse Ambiguity Into Invalidation

At the [pinned Guard revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0), the only runtime invalid writer is reached from unsigned `signFailed` retry and missing signed-transaction processing through a boolean `ValidityStatus`. New rows start with `lastCheck = 0`, so a normal `false` can invalidate on the first retry of a mature chain. CKB must therefore define `false` as proven permanent raw-transaction invalidity only; `unknown`, remote procedure call (RPC) ambiguity, TSS failure, and other temporary states retain the row and exclusions.

### Signing Completion Is Not Status-Guarded Upstream

At the pinned Guard revision, [`processApprovedTx`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/transaction/transactionProcessor.ts#L75-L88) writes `inSign` before starting the unawaited signer, and [`setTxAsSignFailed`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/db/databaseAction.ts#L232-L254) can move that row to `signFailed` while the callback remains live. `updateWithSignedTx` then updates by raw `txId` alone. A delayed callback can therefore change an `invalid` or `completed` row back to `signed`. The smallest correction is one shared atomic update conditioned on status `inSign` or `signFailed`; those are the two source-backed callback-live states, and immutable raw-`txId` row bytes make an attempt identifier unnecessary.

### Each Guard Admits One Active Transaction per Event

At the pinned Guard revision, [`DatabaseHandler.insertTx`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/db/databaseHandler.ts#L34-L138) serializes local admission with `txSignSemaphore`. Event insertion replaces an approved incumbent only for a lower transaction ID and rejects a replacement after the incumbent advances. Input overlap is not part of this event-level decision. These local rules do not prove cross-Guard convergence under different arrival order.

### `estimate_cycles` Has Two Documented Error Classes

At the [pinned CKB revision](https://github.com/nervosnetwork/ckb/tree/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987), `rpc/src/module/chain.rs` documents and implements only `TransactionFailedToResolve (-301)` and `TransactionFailedToVerify (-302)` for `estimate_cycles`, and its `ScriptVerifier` runs against consensus max cycles. The error detail string, not the code alone, distinguishes a consensus cycle overflow from a deterministic script failure.

### CKB Separates Full Bytes From Raw Transaction Identity

At the [pinned CKB revision](https://github.com/nervosnetwork/ckb/tree/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987), raw `tx_hash` excludes witnesses, `witness_hash` hashes the complete serialized transaction, and `TransactionKey { block_hash, index }` keys complete block-body rows. A valid block rejects duplicate raw transaction hashes. Guard's `(sourceBlockId, sourceTxId)` verification therefore identifies one exact occurrence and can derive its index without persisting another identity. None of these values establishes finality; confirmation depth does.

### CKB Pools Are Node-Local

CKB has no globally shared pool or pool consensus. Identically configured nodes can differ because propagation, peers, restarts, conflicts, verification queues, eviction, and reorg timing differ. Pool RPCs describe one node at one instant.

### CKB Relay Is Native and Best Effort

Accepted transactions are announced by hash and fetched by peers. A remotely relayed child with an unknown input can enter the orphan pool and request its parent from the sending peer. A child submitted through local `send_transaction` with an unknown parent is rejected instead.

### CKB Has No Arbitrary Hash-Fetch RPC

`get_transaction` reads the local chain, accepted pool, and recent rejection state. It does not ask peers for an unknown hash. Duplicate `send_transaction` reannounces an accepted transaction, although RPC returns duplicate error `-1107`.

### CKB Re-Adds Detached Transactions After a Reorg

At the [pinned CKB revision](https://github.com/nervosnetwork/ckb/tree/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987), `update_tx_pool_for_reorg` collects transactions unique to detached blocks and `readd_detached_tx` resolves and inserts them in detached-block order. A detached child can therefore remain locally resolvable against its re-added detached parent even though neither creating transaction is currently canonical committed.

### CKB Commitment Follows a Proposal Window

At the same CKB revision, consensus fixes `TX_PROPOSAL_WINDOW` to `ProposalWindow(2, 10)`: a transaction must be proposed before commitment and may commit from 2 through 10 blocks after its proposal. If a well-relayed transaction is proposed in the next block, the README's recent 9.3-second cadence gives a rough 28-102 second broadcast-to-eligible-window range. Proposal inclusion can take longer, so about one minute is a planning estimate rather than a bound. The public harness uses synthetic timing profiles. Before deployment, retain complete local pool-to-commit observations and testbed evidence from the intended topology, derive the deployment profile from those raw records, and rerun the model. Later production evidence can trigger a revised profile and proposal.

### CKB Header Deps Are Fork-Relative

At the same CKB revision, `HeaderChecker::check_valid` accepts a header dep only while `is_main_chain(block_hash)` is true, RFC-0036 has removed the former header-dep immaturity rule, and the pool evicts transactions whose header deps leave the main chain. A shallow creating-block header is therefore legal and causes fork-local eviction, but it does not make signed bytes permanently invalid: a re-reorg restoring that block restores the dependency.

### Current UTXO Chaining Is Permissive

Bitcoin-family, Cardano, Ergo, and the Handshake package build children from locally stored signed parent transactions without requiring local provider visibility first. At the [pinned Rosen Chains revision](https://github.com/rosen-bridge/rosen-chains/tree/b51e5b87fd98bd599741bffabf680f93f8ebf50e), Ergo goes further: it eagerly substitutes successor boxes through its track map over locally stored signed transactions and the local mempool, carries the serialized input boxes in its transaction wrapper, and verifies those boxes by box ID rather than by canonical liveness or depth. That is eager successor substitution with proposer-supplied input bytes, not an independent-first rule with a fallback. Runes disables chaining because its asset verification requires confirmed external indexer state. None of these implements independent-first selection, a dependency-depth bound, or coordinated descendant invalidation end to end. This is precedent to read, not Rosen authority for a CKB rule.

### EVM Bounds Width, Not Depth

`maxParallelTx` limits conflicting candidates at one nonce. Higher nonce layers remain an unbounded dependency tail. It is useful precedent for a chain-owned concurrency policy, not a complete model to copy.

### CCC Cache Is Speculative

CCC, the CKB ecosystem JavaScript SDK, has a process-local wallet construction cache. It is not a reservation authority, distributed pool view, or rejection-safe transaction lifecycle. Guard must not use cache marks as proof of liveness or ownership.

## Accepted Decisions

### Deposit Cell Model

- **Decision:** Use normal transfer outputs to the Rosen lock. ACP and a shared fee cell are discarded, not deferred; a material change in deposit economics reopens design work, not ACP.
- **Rationale and consequence:** Normal cells provide independent OutPoints and match Rosen's UTXO model. The earlier single-ACP-per-token proposal created a shared conflict point and extra scanner/input-resolution requirements.
- **Contract owner:** [README, occupied capacity](./README.md#occupied-capacity) and [work breakdown](./implementation/README.md).

### Deposit Metadata

- **Decision:** Use one exact extra-witness envelope: transaction-wide deposit-output index, transaction-wide source-input index, then the existing unversioned Rosen payload.
- **Rationale and consequence:** The selected output owns lock, asset, and amount. The selected consumed OutPoint owns `fromAddress`. The pure extractor performs no previous-cell resolution. Existing Rosen payloads do not carry a version byte, and the exact witness position and selectors provide CKB framing. A type script at output index `inputs.length` must be qualified to ignore the envelope at that same witness index.
- **Contract owner:** [README, data writing](./README.md#2-data-writing), [work item 01](./implementation/01-shared-utils-codec-and-extractor.md), [work item 02](./implementation/02-watcher-ingest-path.md), [work item 06](./implementation/06-sdk-integration.md), and [work item 07](./implementation/07-ui-and-rosen-service-integration.md).

### Unqualified Sender Locks

- **Decision:** Enable a sender wallet/lock path only after proving that it commits the complete extra-witness suffix and preserves Rosen's first extra-witness slot.
- **Rationale and consequence:** CKB's raw transaction hash excludes witnesses. An unqualified path can therefore confirm the same txid with an attacker-rewritten but valid payout destination; Watcher and Guard cannot recover the original intent. Missing, malformed, redirected, or incompatible requests have no automatic refund or recovery promise.
- **Contract owner:** [README](./README.md), [work item 06](./implementation/06-sdk-integration.md), [work item 07](./implementation/07-ui-and-rosen-service-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Event and Payment Cardinality

- **Decision:** One source transaction produces at most one bridge event, and one event payment produces exactly one target transaction with one `paymentTxId`.
- **Rationale and consequence:** `generateMultipleTransactions` is a chain construction hook, not permission to settle one event in installments.
- **Contract owner:** [README](./README.md), [work item 01](./implementation/01-shared-utils-codec-and-extractor.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), and [work item 04](./implementation/04-minimum-fee-support.md).

### Custody Signing

- **Decision:** Reuse Rosen ECDSA TSS with the canonical mainnet default secp256k1 lock.
- **Rationale and consequence:** CKB adds transaction preparation, SighashAll digesting, signature validation, and witness insertion. Rosen retains TSS participant and key-lifecycle ownership.
- **Contract owner:** [Signing comparison](./guard-signing/), [TSS details](./guard-signing/tss.md), and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Witness-Aware Agreement

- **Decision:** Compute one immutable `agreementId` over the canonical placeholder `PaymentTransaction`, recompute it from every carried wrapper, and keep it on the wire and in memory only. Persist and suppress by raw `txId`; add no second expiry, policy hash, or persistence identity.
- **Rationale and consequence:** Raw `txId` omits witnesses and Rosen request context, so equal payouts for different events can otherwise share an approval identity. The existing wrapper binds the missing context without another serialization or schema.
- **Status:** Its end-to-end attribution claim is under evaluation in [Payment Attribution Across Guards](#payment-attribution-across-guards). The decision stands until that question is resolved.
- **Contract owner:** [Identity and finality analysis](./transaction-identity-and-finality.md), [README](./README.md), and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Extensible User-Defined Token (xUDT) Support

- **Decision:** Require an explicit token-map route, canonical mainnet xUDT, full type-script identity, exactly 16 bytes of little-endian `u128` amount data, and zero extension bits. Guard independently enforces exact per-type input/output equality on every transaction.
- **Rationale and consequence:** Owner mode can bypass the script's own conservation rule, but not Guard's re-resolved equality check. Issuer authority and bearer economics remain Rosen registration concerns; deposit extraction does not claim issuance provenance.
- **Contract owner:** [README](./README.md), [work item 01](./implementation/01-shared-utils-codec-and-extractor.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Payment Accounting

- **Decision:** Keep xUDT quantity and CKB capacity as separate ledgers, preserve every registered xUDT amount exactly, and treat native input-minus-output capacity as the paid fee. The xUDT recipient-capacity decision below owns order reporting.
- **Rationale and consequence:** Inherited native-balance equality would reject every fee-paying CKB transaction. Typed-cell capacity is separate from xUDT quantity.
- **Contract owner:** [README](./README.md) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Minimum Fee Job Economics

- **Decision:** Publish a representative complete-payment estimate, not a hard Guard construction ceiling. Rosen custody absorbs a positive actual-fee difference.
- **Rationale and consequence:** This follows Bitcoin-family precedent and the selected "typical estimate" policy. Guard still funds and verifies the actual transaction.
- **Contract owner:** [README](./README.md) and [work item 04](./implementation/04-minimum-fee-support.md).

### xUDT Recipient Capacity Surplus

- **Decision:** Fund payment and arbitrary-order xUDT recipients at the route bound, and leave any surplus above occupied capacity with the recipient. Require exact equality with that bound. Order extraction reports the xUDT amount in `tokens` and zero `nativeToken`; transaction-local validation owns the exact capacity check.
- **Rationale and consequence:** Event users pay the bound through `networkFee`; retaining its surplus in custody would profit from worst-case pricing. Exact equality also prevents a proposer from diverting the difference to custody while preserving order equality. Arbitrary orders use the same rule for deterministic construction. Sonami selected this policy in the [rcs#2 reply](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5322173229).
- **Contract owner:** [README](./README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 04](./implementation/04-minimum-fee-support.md), [work item 07](./implementation/07-ui-and-rosen-service-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Minimum Fee Job Activation

- **Decision:** Keep the existing Rosen activation workflow: the job calculates a proposal and generates the unsigned update; authorized signing and submission activate it; Guards learn the active value by polling the on-chain config.
- **Rationale and consequence:** CKB needs no second fee-activation channel or chain-specific config synchronization mechanism.
- **Contract owner:** [README](./README.md) and [work item 04](./implementation/04-minimum-fee-support.md).

### Recipient Lock Policy

- **Decision:** Within Rosen's 60-byte encoded `toAddress` limit, accept any valid mainnet RFC 0021 full-format lock except exact matches for the configured hot or cold custody script. Do not add a `codeHash` allowlist. Apply the custody exclusion to payment and arbitrary-order paths; cold storage is exempt.
- **Rationale and consequence:** [Every existing chain codec enforces the same limit](https://github.com/rosen-bridge/utils/blob/8074e8ac6685bc1f8c16079905ba5926b39aed1e/packages/address-codec-chains/cardano/lib/cardano.ts#L15); for CKB it leaves at most 26 lock-argument bytes. The native multisig 28-byte `since` form and larger OmniLock configurations are therefore valid CKB locks but unsupported Rosen destinations. A custody-lock destination would be indistinguishable from change or silently return the payment to Rosen.
- **Contract owner:** [README](./README.md), [work item 01](./implementation/01-shared-utils-codec-and-extractor.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 06](./implementation/06-sdk-integration.md), [work item 07](./implementation/07-ui-and-rosen-service-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Native Recipient Funding

- **Decision:** Keep `getMinimumNativeToken() = 0n`. After fees, UI and SDK require the derived 67 CKB worst-case native recipient floor; Guard construction checks the actual recipient lock's occupied capacity. Add only the narrow pre-insert CKB target validation described below, not a general target-chain-aware Watcher or Guard event hook.
- **Rationale and consequence:** The generic minimum is additive and also applies to xUDT orders, so setting it to 67 would overpay native recipients and add a native rider to every xUDT order. The conservative client floor intentionally rejects some 41-66 CKB post-fee payments that a shorter lock could hold. A hand-built event below its actual floor is caught by the narrow CKB target validation before `insertConfirmedEvent` and stored through the rejected-event repository, because a confirmed row has no rejection transition.
- **Contract owner:** [README](./README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 06](./implementation/06-sdk-integration.md), and [work item 07](./implementation/07-ui-and-rosen-service-integration.md).

### CKB Library Boundary

- **Decision:** Add a bounded Rosen-owned `@rosen-bridge/ckb-primitives` TypeScript package for plain CKB types, Molecule codecs, RFC 0021 full addresses, CKB hashing, occupied capacity, xUDT `u128`, `WitnessArgs`, SighashAll over explicitly resolved inputs, and secp256k1 recovery through explicit `@noble` dependencies. Scanner, Watcher, Guard, and Minimum Fee Job use it for the named mechanics and carry no CCC runtime dependency. Health Check consumes library-neutral Guard and Scanner results instead of duplicating those mechanics. CCC remains in SDK/UI and as a Utils development-only differential reference.
- **Rationale and consequence:** CCC's sufficient main entry has a frozen 44-entry/58 MB production closure and executes JoyID, ethers, legacy CKB SDK, elliptic, node-fetch, WebSocket, and multiple crypto stacks; `./advanced` lacks the required primitives. The owned package is accepted only while it stays within the named API and passes official, differential, packed-consumer, and deployed-script gates.
- **Contract owner:** [Library review](./ccc-dependency-review.md), [README](./README.md), and the [work breakdown](./implementation/README.md) for work items 01-07.

### Watcher Runtime Gate

- **Decision:** Test the exact packed CKB Utils/Scanner consumer through Watcher's Node 20.11 production startup path.
- **Rationale and consequence:** The owned primitives target both declared runtimes and avoid CCC's Node `>=20.19.0` transitive floor, but the gate must still prove the actual packed consumer, module format, and production startup rather than only producer tests.
- **Contract owner:** [Work item 02](./implementation/02-watcher-ingest-path.md).

### Node Ownership

- **Decision:** Each Guard, Watcher, and Minimum Fee Job operator runs an independently operated local CKB full node with the agreed release and configuration. Watcher uses Chain RPC only and runs no indexer. Guard uses the node's built-in standard indexer, not rich-indexer. Minimum Fee Job reads height, fee-rate statistics, and `tx_pool_info.min_fee_rate` from its own node and runs no indexer.
- **Rationale and consequence:** Watcher scans confirmed blocks and does not need cell queries. Guard needs live-cell selection and payout pool integration. Built-in index keys preserve canonical position ordering after reorg; rich-indexer insertion IDs do not. Same configuration removes policy divergence but does not make separate calls one snapshot. This is Sonami's answer to Rosen's public-endpoint question, not a topology Rosen has publicly accepted; ordinary PR review remains the acceptance path.
- **Status:** Reopened by [Endpoint Topology](#endpoint-topology); Rosen's [tracker comment](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5969120694) calls a required operator-run node not acceptable. The decision stands until that question is resolved.
- **Contract owner:** [README](./README.md), [work item 02](./implementation/02-watcher-ingest-path.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 04](./implementation/04-minimum-fee-support.md), [work item 05](./implementation/05-health-check-support.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Client Topology

- **Decision:** Do not add CKB Light Client, remote-RPC quorum, or dual-provider Watcher modes in v1.
- **Rationale and consequence:** Operator-owned local full nodes give both services one explicit trust and failure model. Additional provider modes multiply reconciliation and operations paths without a demonstrated requirement. This is a Sonami scope choice rather than a Rosen decision.
- **Status:** Reopened by [Endpoint Topology](#endpoint-topology) and [Light-Client Transport](#light-client-transport). The decision stands until those questions are resolved.
- **Contract owner:** [README](./README.md), [work item 02](./implementation/02-watcher-ingest-path.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 05](./implementation/05-health-check-support.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Public Network Connectivity

- **Decision:** Guard nodes remain connected to the public CKB network. Do not set `whitelist_only = true`. Persistent direct Guard peers are optional.
- **Rationale and consequence:** Nodes must continue receiving ordinary blocks and non-Rosen transactions. Direct peers may improve relay latency and reconnection but do not guarantee delivery or replay pool inventory.
- **Status:** Reopened by [Endpoint Topology](#endpoint-topology). The decision stands until that question is resolved.
- **Contract owner:** [Work item 08 deployment topology](./implementation/08-contract-deployment-handoff.md).

### Native Mechanism Preference

- **Decision:** Do not introduce a shared mempool, transaction-package agreement format, or third-party CKB Client in custody services for v1.
- **Rationale and consequence:** Guard owns construction, active-input exclusions, exact signed-transaction persistence, submission, and retry against its local node. The shared primitives are pure; Rosen network packages own raw local-node RPC and complete paginated identity reads.
- **Status:** Reopened by [Endpoint Topology](#endpoint-topology) for every reference to a local node. The decision stands until that question is resolved.
- **Contract owner:** [README](./README.md) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Payout Dependency Policy

- **Decision:** Never select an uncommitted output. Payment and arbitrary construction use depth-qualified cells first and retry with locally persisted shallow committed Guard-produced change only when that set has no valid plan; cold storage uses the shared cold-reachable set. Every Guard re-resolves declared inputs and the shallow-parent predicate from canonical Chain RPC. Add no parent bytes, custody-input depth setting, or extra identity read.
- **Rationale and consequence:** Deep-first lowers reorg exposure, while the Guard-produced restriction excludes shallow user deposits. The committed floor keeps parent readiness, package ordering, and descendant invalidation out of CKB agreement; deployment provisioning must sustain the resulting bounded signing demand.
- **Contract owner:** [README](./README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Construction No-Fit Lifecycle

- **Decision:** Send committed-cell shortage, active-input conflict, exhausted-selector no-fit, and reconstruction of a retained invalid raw `txId` through each automatic path's existing waiting, retry, or scheduled lifecycle, with a distinct reason for each. Reject only request-level invalidity that does not depend on finding a cover, such as a native payment below its recipient's occupied capacity or a custody-lock destination.
- **Rationale and consequence:** Payment already has `paymentWaiting`, arbitrary orders have `waiting`, and cold storage runs again on its scheduled round. One unusable cover does not prove permanent infeasibility because active exclusions and chain state change. An invalid row proves only that the same raw transaction family is permanently suppressed, so checking it before agreement prevents repeat work while another construction may later proceed. Permanent event invalidity is rejected before confirmed-event insertion through the rejected-event repository, and arbitrary intake rejects before waiting insertion; neither uses a waiting state.
- **Contract owner:** [README](./README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), and [work item 04](./implementation/04-minimum-fee-support.md).

### Identity-Read Budget

- **Decision:** Give each exact lock/type/data identity a positive `maxIdentityCells` budget. Limit each request to the smaller of the configured page limit and the remaining budget plus one sentinel, and fail temporarily before construction when the response would exceed the budget; never construct from a truncated set. Asset health uses the repository-native unavailable-measurement status rather than publishing a partial balance.
- **Rationale and consequence:** Silent truncation can hide custody or make constructor output depend on an arbitrary page boundary, while an unbounded page or traversal gives one fragmented identity unbounded memory and RPC work. The budget preserves safety and service availability at the cost of pausing construction and automatic cold sweeps for an over-fragmented identity until an operator changes the budget or custody state.
- **Contract owner:** [README](./README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 05](./implementation/05-health-check-support.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Cycle-Estimation Outcome

- **Decision:** Persist and validate the exact signed transaction, call `estimate_cycles`, and apply the README's temporary/permanent classifier. Keep the exact cause as diagnostics rather than another behavioral or persistence subtype.
- **Rationale and consequence:** Exact cycles are unavailable before signing, while unresolved and unknown errors do not prove permanent failure. Raw-wide suppression prevents repeated agreement and scarce TSS work but accepts liveness loss from ceiling changes or valid-signature cycle variation. Because invalidation is permanent locally, staggered cycle ceilings are unsupported: deployment measures signature variation, keeps the ceiling away from the observed boundary, and changes the shared value only during a quiesced coordinated rollout.
- **Status:** Reopened by [Signed Payments Above the Application Cycle Ceiling](#signed-payments-above-the-application-cycle-ceiling) and the [Chain Data Trust Model](#chain-data-trust-model). The decision stands until those questions are resolved.
- **Contract owner:** [README terminal handling](./README.md#custody-concurrency-and-transaction-chaining), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Custody Construction

- **Decision:** Every automatic CKB path completes the README-owned bounded identity traversal, re-resolves selected OutPoints through Chain RPC, and runs one recursive eager-cleanup order-quantum policy (H1) with shared comparators and final input order. The path adapter supplies demand, eligibility, canonical base selection, and ordinary-payment service quanta. Event quanta come from the payment, arbitrary quanta from the largest single item per identity, and cold quanta from one deployment-signed payment profile. Every added repair or cleanup input rebuilds composition, fee, shaping, and cold projection. While relevant change is unresolved, H1 may repair its ceiling but keeps canonical minimal change and does not clean up or shape. Manual signing supplies exact inputs.
- **Rationale and consequence:** The payment benchmark selects eager cleanup over no cleanup and triggered cleanup. It does not cover arbitrary or cold transactions, so uniform production use is a Sonami simplification rather than a benchmark result: every automatic transaction can repair payment-useful inventory, and Guard implements one construction tree instead of path-specific change behavior. Cold needs configured service quanta because its sweep amount is a balance-control action rather than a useful future payment denomination. Non-event cleanup keeps the event-sized byte allowance, and one small positive xUDT remainder can reduce every typed group's shared lane count. The accepted costs are that bounded coupling, one more quiesced agreement-critical profile, wider transaction-local validity on cold and arbitrary paths, and unbenchmarked path-specific workloads before deployment validation.
- **Contract owner:** [README](./README.md), [custody-flow evidence](./benchmarks/custody-flow/results/README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 04](./implementation/04-minimum-fee-support.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Proposal Verification Scope

- **Decision:** Re-resolve every declared input and verify its eligibility, local conflicts, comparator and final order, outputs, conservation, fee, and path policy. Every automatic path enforces H1's agreement-visible output-count, useful-lane, near-equality, complete-byte, and demand bounds without reproducing cover, repair, cleanup, unresolved, or omitted-cell state. Cold H1 checks use declared outputs and shared service quanta; cold hot-balance projection remains a separate local safety predicate.
- **Rationale and consequence:** Candidate, active, pool, depth, and indexer views are local, so exact selection, cleanup descent, inventory ceilings, and a verifier's maximum locally visible cold transfer cannot be shared validity rules. Different Guards may propose different eligible covers or reject a cold proposal under different local reservations; `agreementId` plus threshold approval selects exact bytes. The accepted tradeoff is that cold and arbitrary inputs are no longer required to be irreducible and cold verification accepts a safe transfer smaller than the verifier itself might construct.
- **Status:** Its completed-payment hook use is reopened by [Completed-Payment Verification Boundary](#completed-payment-verification-boundary). The decision stands until that question is resolved.
- **Contract owner:** [README](./README.md) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Durable CKB Suppression

- **Decision:** Add no CKB transaction column, index, fingerprint entity, migration, or invalid-row reactivation path. Keep wrapper `agreementId` on the wire and in memory. Permanent execution outcomes invalidate the existing retained `TransactionEntity` row keyed by raw `txId`; construction, proposal validation, approval, and manual intake consult that row so the same transaction stays suppressed across restart, including after an application-ceiling increase.
- **Rationale and consequence:** Authorization is wrapper-scoped, but every persisted terminal outcome is transaction-execution-scoped. Wrapper mismatch, request mismatch, policy rejection, and candidate conflict fail before persistence. Reactivation, exact-ID fingerprints, measured-cycle applicability, and row reassignment form one liveness subsystem; rejecting it accepts that a quiet bridge may need custody drift or operator action before the waiting request constructs different bytes.
- **Contract owner:** [Identity and finality analysis](./transaction-identity-and-finality.md), [README](./README.md), and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Invalidation and Signing Completion

- **Decision:** Use the existing boolean validity hook, but for CKB let `false` mean only canonical input death after the configured grace or another proven permanent raw-transaction fact. Temporary ambiguity retains state and still faces complete pre-TSS verification. Change shared signing completion to one atomic update where status is `inSign` or `signFailed`; discard a late result for every other status.
- **Rationale and consequence:** A tri-state shared API changes every chain, while a second CKB classifier duplicates the existing hook. Narrow boolean semantics enforce the required boundary with no new state. The guarded update fixes a chain-generic status-regression race with one predicate; an attempt ID is needed only if rows can be rebound, which this design forbids.
- **Status:** Reopened by [Canonical Input-Consumption Evidence and Grace](#canonical-input-consumption-evidence-and-grace) and the [Chain Data Trust Model](#chain-data-trust-model). The decision stands until those questions are resolved.
- **Contract owner:** [Identity and finality analysis](./transaction-identity-and-finality.md), [README](./README.md), and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Manual Signing Escape Hatch

- **Decision:** Keep authenticated prebuilt signing disabled by default and preserve Guard's existing caller-supplied threshold contract when enabled. Place CKB validation in an explicit pre-insert branch of the shared `/sign` route, because that route reaches no chain verifier hook on its own. Parse, verify transaction shape and policy, and re-resolve exact inputs before entering the CKB critical section. Under the section, reject a retained invalid raw `txId`, refresh candidates, active transactions, and local-pool spends, reject overlap, then insert active state before release. Manual intake never claims an exact-candidate match. Existing chain manual behavior is unchanged.
- **Rationale and consequence:** Manual signing is an exact-input operational escape, not a constructor or claimant recovery path. Expensive chain I/O does not need the local-state lock and cannot freeze chain state; the lock owns only the final local conflict and retained-row check plus insertion. Complete verification before every TSS submission catches later chain changes. This preserves independent progress while leaving no local gap between conflict check and registration.
- **Contract owner:** [README](./README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Candidate and Active Input Exclusions

- **Decision:** Under one chain-scoped critical section, refresh local candidates, active transactions, and local-pool spends before conflict checking and registration. Key candidates by recomputed `agreementId`; matching retransmission is idempotent, different overlapping work conflicts, and approval atomically moves the candidate into persisted active state. Candidate exclusions expire in memory; active exclusions persist to authoritative terminal state.
- **Rationale and consequence:** Complete acceptance-time verification makes a second candidate byte key or durable proposal record unnecessary. Restart rebuilds durable exclusions from active state and the local pool.
- **Contract owner:** [README](./README.md) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Cross-Guard Event and Input Conflicts

- **Decision:** Keep the local invariant local. CKB's single-spend rule resolves only input-conflicting transactions across Guards. Assign same-event conflicts with disjoint inputs to shared Guard event admission. Before rollout, require at least two Guard instances with opposite arrival order to prove one surviving lifecycle through approval, restart, late delivery, signing, and confirmation. If that fails, fix the shared owner. Reject a CKB-specific coordinator, reservation service, or protocol message.
- **Rationale and consequence:** The existing per-Guard admission rule is the smallest event-level owner but does not itself prove cluster-wide convergence. Duplicating it inside CKB would add another source of truth. CKB still owns terminalizing the loser of an input conflict once canonical input death is authoritative. The accepted tradeoff is that missing multi-Guard evidence blocks rollout and may require a shared Guard correction.
- **Contract owner:** [README](./README.md) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Expanded Fragmentation Health

- **Decision:** Do not add a dry-run constructibility or cell-distribution health subsystem in v1. Keep plain CKB and full-type xUDT balance checks plus Scanner, node, and indexer health, using Guard's cold-trigger balance result.
- **Rationale and consequence:** This preserves the original work-item-05 scope and existing Rosen balance-health pattern while keeping health and cold construction on the README's single cold-reachable ledger. Normal payments, cold storage, and deposits determine cell shape; Health Check does not duplicate selection to second-guess it.
- **Contract owner:** [Work item 05](./implementation/05-health-check-support.md).

### Invalid-Deposit Recovery

- **Decision:** Malformed or unsupported deposits create no automatic refund, discretionary recovery promise, protocol entitlement, refund event, or refund database. Existing arbitrary orders and manual signing remain general operator tools, not a claimant recovery service.
- **Rationale and consequence:** A recovery promise requires claimant authentication, replay prevention, reconciliation, approval, accounting, and an operational owner; no such lifecycle belongs to this integration contract.
- **Contract owner:** [README](./README.md), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Confirmation Ownership

- **Decision:** Keep Watcher's deployment-supplied global commitment gate separate from Guard's five CKB confirmation settings. Use tip depth zero. Guard `verifyEvent` owns canonical source block and transaction binding; transaction-ID-only `getTxConfirmation` owns committed status and depth.
- **Rationale and consequence:** Confirmation depth is the bridge's reorganization protection; event identity, sender signatures, full-byte hashes, and block locators do not replace it. Existing integrations do not enforce cross-service numeric equality, and the network confirmation method cannot receive a source block ID. Final launch values remain a deployment signoff.
- **Contract owner:** [Identity and finality analysis](./transaction-identity-and-finality.md), [README](./README.md), [work item 02](./implementation/02-watcher-ingest-path.md), and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Cold-Storage Accounting

- **Decision:** Use the README's one complete cold-reachable set and CKB-specific projection for balance, triggering, construction, and verification. Schedule token-only and native-only sweeps, cap native and each token route so oversized balances drain across scheduled rounds, and require distinct complete hot and cold scripts.
- **Rationale and consequence:** The generic balance model can mix xUDT backing capacity with spendable native CKB, while local persistence cannot identify every shallow Guard output. One chain-provable projection prevents balance from triggering work construction cannot fund and lets each ledger retain its own unit. Per-ledger caps keep one fragmented oversized sweep from becoming a permanent transaction-size no-fit. The tradeoff is a complete bounded chain read that can pause balance and sweeps when the identity budget is exhausted.
- **Status:** Reopened by [Cold-Balance Reads During Custody Changes](#cold-balance-reads-during-custody-changes). The decision stands until that question is resolved.
- **Contract owner:** [README cold-storage contract](./README.md#transaction-fee-handling), [work item 03](./implementation/03-guard-chain-and-rpc-integration.md), [work item 05](./implementation/05-health-check-support.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Minting Utility Scope

- **Decision:** Specify and validate the registered xUDT deployment topology and evidence, but do not implement a CKB maximum-supply mint CLI as part of this integration.
- **Rationale and consequence:** Existing Rosen integrations do not own wrapped-token mint transaction utilities. Rosen or a delegated deployer performs the mint; [work item 08](./implementation/08-contract-deployment-handoff.md) records the resulting scripts, OutPoints, and evidence.
- **Contract owner:** [README](./README.md) and [work item 08](./implementation/08-contract-deployment-handoff.md).

### Signed Shallow-Reorg Reconciliation

- **Decision:** Apply the committed-input and shallow-parent rules before every new construction, acceptance, manual intake, and local TSS submission. Retain exact signed bytes and exclusions through ambiguous detached-parent state; invalidate only after canonical input death or another proven permanent raw-transaction fact. Never use detached outputs for another successor before their creator recommits.
- **Rationale and consequence:** Age and local absence do not prove permanent failure, so timeout release could race a replayable signed transaction. The accepted tradeoff is an indefinite wait without parent transport, ancestry state, cascade handling, or row reactivation.
- **Status:** Reopened by [Canonical Input-Consumption Evidence and Grace](#canonical-input-consumption-evidence-and-grace). The decision stands until that question is resolved.
- **Contract owner:** [README](./README.md) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md).

### Decimal Wrapping

- **Decision:** Keep the shared Utils ceiling wrap for every CKB deposit and add no CKB-specific rounding. Neutralize it by registration: the decimals selection rule under Deployment Inputs makes the wrap divisor one on every CKB route where each chain's amount range permits; elsewhere the dust tradeoff below applies.
- **Rationale and consequence:** At the pinned Utils revision, `TokenMap.wrapAmount` divides by ten to the power of the source decimals minus the token set's smallest decimals and rounds any remainder up, and the abstract extractor applies it for every chain. The mainnet token map already deploys mixed decimals for DOGE, ETH, BNB, and two other tokens, so this is deployed precedent rather than a CKB choice. Where decimals differ, sub-unit dust from a non-UI sender is credited up by at most one coarse unit per deposit; the official UI limits input to the coarse unit. The CKB extractor must not divide again, because a second wrap under-credits by the divisor.
- **Contract owner:** [README](./README.md), [work item 01](./implementation/01-shared-utils-codec-and-extractor.md), and [work item 08](./implementation/08-contract-deployment-handoff.md).

## Open Questions

These items are undecided or wait on a named owner. Each entry names what resolves it. Remove an entry when it becomes an accepted decision, a deployment input, or an applied contract correction.

Current state: implementation does not start until [Endpoint Topology](#endpoint-topology) and the [Chain Data Trust Model](#chain-data-trust-model) are agreed, because they decide where each service reads CKB and what it may act on; three of the four lifecycle questions named below are evaluated with the trust model. The other entries order themselves after those two: [Upstream Fix Preconditions](#upstream-fix-preconditions) and the Deployment Inputs gate rollout; [Bridge-Wide Feed Independence](#bridge-wide-feed-independence), [Loss Bounds](#loss-bounds), and [Cold-Spend Data Sources](#cold-spend-data-sources) wait on Rosen and change the recorded exposure; [Payment Attribution Across Guards](#payment-attribution-across-guards) and the three older questions are independent of the topology. Ten accepted decisions carry a reopened status line and stand until their question is resolved: Node Ownership, Client Topology, Public Network Connectivity, Native Mechanism Preference, Cycle-Estimation Outcome, Invalidation and Signing Completion, Signed Shallow-Reorg Reconciliation, Cold-Storage Accounting, Witness-Aware Agreement, and Proposal Verification Scope.

The four lifecycle questions below ([Signed Payments Above the Application Cycle Ceiling](#signed-payments-above-the-application-cycle-ceiling), [Canonical Input-Consumption Evidence and Grace](#canonical-input-consumption-evidence-and-grace), [Completed-Payment Verification Boundary](#completed-payment-verification-boundary), and [Cold-Balance Reads During Custody Changes](#cold-balance-reads-during-custody-changes)) follow the 2026-09-05 review and comparison with pinned Rosen integrations. They reopen the affected parts of Cycle-Estimation Outcome, Invalidation and Signing Completion, Signed Shallow-Reorg Reconciliation, Cold-Storage Accounting, and Proposal Verification Scope. Those accepted entries describe the existing proposal, not resolution of these findings. The README and work item 03 remain unchanged pending a coordinated contract revision; these are contract questions rather than deployment measurements alone.

The entries under [Data Sources and Trust](#data-sources-and-trust) follow Rosen's feedback on the node topology and Sonami's review of the Rosen services CKB depends on. They reopen Node Ownership, Client Topology, Public Network Connectivity, and Native Mechanism Preference, and, through the trust model, Cycle-Estimation Outcome and Invalidation and Signing Completion. Rosen's requirement is on record in its [tracker comment](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5969120694).

### Data Sources and Trust

#### Endpoint Topology

- **Question:** Does the integration keep requiring an operator-run full node for Watchers, Guards, Rosen Service (which follows Watcher's policy under work item 07), and Minimum Fee Job, which Rosen has said it cannot rely on, or does it read CKB through public JSON-RPC endpoints, a light-client sidecar, or either with an operator-run node as the optional stronger choice, and does a light client satisfy Rosen's three-endpoint requirement?
- **Why it matters:** The accepted Node Ownership decision requires an operator-run full node for every service. [RCS-003 section 3](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003) states that relying on a single public node is not sufficient and that multiple independent endpoints should be available, and Rosen's [`rcs#2` response](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-4926455588) asked how many public JSON-RPC APIs exist. Rosen's [tracker comment](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5969120694), after what it calls a quick review, says the plan seems sufficient except for this point, calls a required operator-run node "not acceptable for us, given the resource requirements and Rosen's architecture", and requires "at least three reliable public endpoints for every network, usable by both Watchers and Guards", either public nodes or infrastructure services, while recommending own nodes where feasible; the three-node requirement also appears in the [public Rosen group](https://t.me/rosenbridge_erg/64412). The transports differ in who bears the node cost and in what the Guard can verify.
- **Evidence and precedent:** At the Guard `dev` revision named under Evidence Pins, each chain uses one configured provider set, with no cross-check between sources; the shipped configuration names a public hostname for the selected provider of Bitcoin, Doge, Cardano, and Ergo. The Guard already manages one sidecar binary it starts and restarts itself, [`tss-api` through `tssHandler.runBinary`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/handlers/tssHandler.ts#L45-L104), so a light-client sidecar is an existing operational shape. The [official public CKB JSON-RPC list](https://github.com/nervosnetwork/ckb/wiki/Public-JSON-RPC-nodes) names two mainnet endpoints from unnamed community operators and says not to use them for production; [Ankr](https://www.ankr.com/rpc/nervos/) and [GetBlock](https://getblock.io/nodes/ckb/) serve CKB behind API keys. The transport under evaluation is a light client as the shipped default reader for Guard and Watcher, with hosted endpoints used only for fee and pool-policy data, which decide neither deposit validity nor payment completion.
- **Resolution:** Sonami [asked Rosen on the tracker](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5982187336) whether a light client shipped as the default reader for Guard and Watcher satisfies the requirement; the answer is pending. Sonami then selects one transport per service that satisfies Rosen's requirement, or records that CKB cannot satisfy it, names the operator, funding, and duration of every shared endpoint and of CKB incident response, and records the data-trust consequences under [Chain Data Trust Model](#chain-data-trust-model). Update Node Ownership, Client Topology, Public Network Connectivity, Native Mechanism Preference, README section 3, and work items 02, 03, 04, 05, 07, and 08 together.
- **Owner:** Rosen answers whether a light client satisfies its requirement; Sonami proposes the transport through ordinary PR review.

#### Chain Data Trust Model

- **Question:** Which facts read from a CKB data source are self-verifying, which are provable against headers, which cannot be proven from any single response, and which Guard decisions may depend on each class?
- **Why it matters:** With a third-party endpoint, every plan rule that treats node output as truth becomes a trust assumption. The classes differ. Cell contents are self-verifying once the reader fetches the creating transaction and hashes it, because the OutPoint names that hash and the raw hash commits outputs and output data. Transaction and witness bytes are provable by recomputing `transactions_root` from the complete block against its header; [`get_transaction_proof`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/rpc/src/module/chain.rs#L1917-L1936) proves only transaction hashes and supplies an aggregate witness root, so the deposit envelope needs the complete block or a transaction-and-witness proof. Inclusion on a PoW-valid linked branch is provable, but canonicity is not: a detached branch keeps valid PoW, so the reader must also select the branch by cumulative difficulty against a trusted anchor and apply the confirmation depth. Transaction inclusion alone does not prove current cell liveness, which only a committed spend can disprove. Pool contents, `tx_pool_info`, duplicate-submission replies, and `estimate_cycles` results are unverifiable by the Guard without re-executing them. A lying source can be limited to stalling the CKB path only if no permanent decision depends on an unverifiable fact; where one does, the result is a second payment or an unpaid user.
- **Evidence and precedent:** The register's [Signed Payments Above the Application Cycle Ceiling](#signed-payments-above-the-application-cycle-ceiling) and [Canonical Input-Consumption Evidence and Grace](#canonical-input-consumption-evidence-and-grace) are instances of the same rule and resolve with it.
- **Resolution:** Specify the classes in the README, the canonical-branch selection and anchoring rule, how competing branches and chain freshness are established when one source can withhold a higher-work branch, and the accepted connectivity assumptions. One rule to evaluate is that an unverifiable fact or uncertain freshness never invalidates a signed transaction, never marks a payment confirmed, and never releases an input exclusion, and that only a spend or an inclusion proven on the selected canonical branch at the configured depth may; it would also remove the application-ceiling invalidation. Evaluate it against terminal handling, retry handling, confirmation, and cold accounting, with a source that lies in each class and one that withholds a higher-work branch, before selecting any rule.
- **Owner:** Sonami proposes the model through ordinary Rosen Guard review.

#### Light-Client Transport

- **Question:** Can the [CKB light client](https://github.com/nervosnetwork/ckb-light-client/tree/9ce5fc6507ce1379dd8bd4b947426078bb2062e8) serve Watcher and Guard reads under the trust model, and at what integration cost?
- **Why it matters:** It verifies headers through FlyClient sampling and transactions by inclusion, serves `get_cells` and `get_transactions` for a configured lock, and maintains script-filtered transaction and cell state rather than full-chain state, so it may reduce resource needs while making header, inclusion, and depth facts verifiable; it does not prove cell liveness. It has no full pool view, keeps `pending` in a 64-entry in-memory list that only overflow evicts, and serves filtered transactions rather than whole blocks, so Rosen's block scanner cannot sit behind it unchanged.
- **Resolution:** Measure sync time, storage, and peer availability on mainnet; design the Watcher scanner shape and the submission path, which may use any full node because reconciliation is by transaction hash. The decision selects it, rejects it, or keeps it as the recommended optional transport.
- **Owner:** Sonami measures and proposes; Rosen PR review accepts or rejects the sidecar.

#### Bridge-Wide Feed Independence

- **Question:** What does Rosen commit to about the independence of the data sources its Guards use on every chain, and how is that commitment observable?
- **Why it matters:** Guards are one process holding signing material for every chain, with a shared custody root across the ECDSA chains, and each Guard reads each chain through one configured provider set. A fake deposit on any chain whose source is shared by enough Watchers and Guards can be paid from the hot custody of any target chain, CKB included, and wrapped assets minted on CKB become unbacked when their home chain's custody is drained. On the chains that sign a pre-SegWit-style hash, which does not cover input amounts, a source that lies to enough Guards can get hot funds spent as mining fee, as [stated publicly](https://t.me/rosenbridge_erg/64432). Nothing in the Guard code checks or reports which providers operators use. Rosen attributes the rejection of the 84 invalid events in the July 2026 Cardano incident to Guards operating on independent data sources; the code neither enforces nor reports that independence. The proposed CKB trust model, once its canonicity rule is selected and demonstrated, would close the CKB-source deposit and CKB fee paths only; a fake deposit on another chain could still be paid from CKB custody.
- **Evidence and precedent:** Guard [`config/default.yaml`](https://github.com/rosen-bridge/guard-service/blob/5b8dcd408c1f70aa42d4257c09fefc4e16cd5fdd/services/guard-service/config/default.yaml); Rosen's public [security update on the July incident](https://t.me/rosenbridge_erg/63209).
- **Resolution:** Rosen states its provider-independence policy for Guards, for example a distinct-source rule the set can check or a cross-check against a second source before signing, how it is verified, and the status of the privately reported issues known to Rosen; Sonami [asked on the tracker](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5982187336) and the answer is pending. The register records the policy and the resulting exposure of CKB custody and CKB-minted wrapped assets.
- **Owner:** Rosen for the policy; Sonami for recording the exposure.

#### Loss Bounds

- **Question:** What bounds the loss from one poisoned source or one chain reorganization before a human intervenes, and will Rosen add a mechanism?
- **Why it matters:** Cold sweeps reduce hot exposure but enforce no hard cap: a sweep can defer, skip, or fail, a capped round leaves the balance above `high`, and deposits or replenishment refill hot custody between rounds. The inspected Guard source and configuration contain no payout rate limit, anomaly check, or automatic pause; known pauses were manual, such as [pausing Cardano bridging during a manual transaction](https://t.me/rosenbridge_erg/49919) and [disabling watcher commits by configuration](https://t.me/rosenbridge_erg/62450). A CKB mining pool above half the hash rate can reorganize past any confirmation depth, which makes CKB deposit finality depend on that pool's honesty and lets the same pool serve a private branch to a verified reader; the README's Confirmation Policy records this as a caveat rather than a live condition.
- **Resolution:** Rosen states whether it will add a payout limit or automatic halt; Sonami [asked on the tracker](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5982187336) and the answer is pending. The README states the residual exposure in both directions; the values, sweep assumptions, and hash-rate evidence are deployment inputs.
- **Owner:** Rosen for mechanisms; Sonami for the CKB values and the hash-rate evidence.

#### Cold-Spend Data Sources

- **Question:** Does Rosen's cold-storage spending path, which has no public implementation, read the same third-party sources as the automated Guard, and with what verification?
- **Why it matters:** Cold funds are protected because the automated path never signs for them. If cold spending relies on the same unverified data, it may retain related exposure; its verification boundary is unknown.
- **Resolution:** Rosen states the answer or declines; the register records either.
- **Owner:** Rosen.

#### Upstream Fix Preconditions

- **Question:** Which of the CKB-relevant Rosen service defects reported in September 2026 must be fixed before CKB rollout, and which are accepted as known?
- **Why it matters:** CKB runs on the shared Guard, signing, scanner, fee, and UI code. Several reported defects change CKB's rollout conditions even though CKB cannot fix them locally.
- **Evidence and precedent:** Guard: a [sync quorum that counts answers for different transactions together](https://github.com/rosen-bridge/guard-service/issues/23), a [crash between two completion writes that strands an event](https://github.com/rosen-bridge/guard-service/issues/26), [processor jobs without error handling](https://github.com/rosen-bridge/guard-service/issues/24), [locks not released on every path](https://github.com/rosen-bridge/guard-service/issues/28), and a [log health window of about a week](https://github.com/rosen-bridge/guard-service/issues/27). Signing: [Guards on different `@rosen-bridge/tss` patch versions cannot count each other's approvals](https://github.com/rosen-bridge/sign-protocols/issues/5), a [threshold check that accepts duplicates](https://github.com/rosen-bridge/sign-protocols/issues/4), a [retry that can crash tss-api](https://github.com/rosen-bridge/sign-protocols/issues/6), [one busy core per active sign](https://github.com/rosen-bridge/sign-protocols/issues/7), and a [leaked connection per sign](https://github.com/rosen-bridge/sign-protocols/issues/8). Fees and UI: [fee ratios that break every run](https://github.com/rosen-bridge/minimum-fee-job/issues/2) and a [stale fee that can strand a lock](https://github.com/rosen-bridge/ui/issues/32). Each issue pins its own source revision. Further issues were reported privately and are known to Rosen; their status is tracked privately with Rosen.
- **Resolution:** Rosen marks each as fixed, scheduled, or accepted. Sonami records rollout preconditions in work item 08 and the matching pitfalls in work items 01, 03, 04, and 07.
- **Owner:** Rosen for fixes; Sonami for the preconditions list.

### Signed Payments Above the Application Cycle Ceiling

- **Question:** How does Guard handle a signed payment that exceeds the application cycle ceiling but remains executable under CKB consensus, without authorizing a second payment?
- **Why it matters:** The README currently invalidates that raw transaction and requeues its request. A participant retaining the signed bytes can still broadcast them. When changed inventory produces a replacement with disjoint inputs, both payments can confirm; local raw-`txId` suppression does not revoke the first signature. This exceeds the previously accepted liveness-only tradeoff.
- **Evidence and precedent:** CKB's [cycle estimator verifies against the consensus limit](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/rpc/src/module/chain.rs#L2423-L2445). Rosen [EVM invalidation checks failed on-chain execution or a consumed nonce](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/chains/evm/lib/evmChain.ts#L564-L629), while [Cardano checks encoded transaction expiry and input validity](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/chains/cardano/lib/cardanoChain.ts#L536-L590). Neither is equivalent to an off-chain ceiling revoking signed CKB bytes.
- **Resolution:** Specify which evidence permits release and replacement. The proposed correction retains signed bytes and exclusions on application-only failure rather than treating it as permanent execution failure. Test delayed broadcast of the original after changed inventory permits a disjoint replacement. Apply the selected rule to [README terminal handling](./README.md#terminal-handling), [identity and finality](./transaction-identity-and-finality.md#terminal-suppression), and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md) together. Evaluate it with the [Chain Data Trust Model](#chain-data-trust-model): `estimate_cycles` is unverifiable by the Guard, so a rule that bars unverifiable facts from invalidation would cover this case.
- **Owner:** Sonami proposes the CKB correction through ordinary Rosen Guard pull-request review.

### Canonical Input-Consumption Evidence and Grace

- **Question:** What evidence distinguishes a canonically consumed input from an unresolved parent, and when is that consumption sufficiently confirmed to release a conflict loser?
- **Why it matters:** The README retains every exclusion indefinitely on input `unknown` but relies on canonical input death to retry a loser. CKB's [canonical snapshot returns `Unknown` for an absent cell](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/snapshot/src/lib.rs#L231-L242); its [RPC type explicitly deprecates the `dead` distinction](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/jsonrpc-types/src/cell.rs#L47-L64). A genuinely spent input can therefore strand the losing request and its other inputs.
- **Evidence and precedent:** [Bitcoin Runes RPC maps `gettxout` null to false](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/networks/bitcoin-runes-rpc/lib/bitcoinRunesRpcNetwork.ts#L579-L615); [Ergo Node checks `spentTransactionId` but also maps 404 to false](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/networks/ergo-node/lib/ergoNodeNetwork.ts#L448-L475). The [shared invalidation grace measures `height - tx.lastCheck`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/transaction/transactionProcessor.ts#L368-L377), not the conflicting spend's depth. These precedents do not establish the stronger CKB permanence claim.
- **Resolution:** Define consumption evidence and its finality boundary in the CKB adapter while preserving the boolean hook. Test RPC-shaped `unknown` responses for both spent cells and detached parents, plus a newly committed conflict against an old `lastCheck`. Update [README retry handling](./README.md#reorganization-and-retry-handling) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md). Raise the inherited ambiguity and grace semantics with shared Guard rather than adding a CKB-only recovery protocol. Evaluate it with the [Chain Data Trust Model](#chain-data-trust-model): a spending transaction proven committed is the only consumption evidence that model could accept, and the shared `height - lastCheck` grace reads its height from the same source.
- **Owner:** Sonami owns the CKB evidence contract; Rosen Guard review owns changes to shared invalidation semantics.

### Completed-Payment Verification Boundary

- **Question:** Which CKB checks apply to historical completed-payment synchronization, as distinct from admission of a transaction that has not spent its inputs yet?
- **Why it matters:** Work item 03 puts current input liveness and nonconflict into `verifyPaymentTransaction`, then requires completed synchronization to run it and the ordinary fee verifier. A completed payment has already consumed its inputs; a historical fee can also differ from current construction policy.
- **Evidence and precedent:** [Bitcoin](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/chains/bitcoin/lib/bitcoinChain.ts#L744-L786) and [Cardano](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/chains/cardano/lib/cardanoChain.ts#L851-L899) use this hook for transaction and input-reference consistency, separately from current spendability. The [shared synchronization path](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/synchronization/eventSynchronization.ts#L440-L486) checks consistency, order, confirmation, and signed extra conditions without rerunning admission-time fee checks.
- **Resolution:** Preserve that separation using the existing hooks, retaining historical input-content, conservation, payment-association, and canonical-settlement verification. Do not globally add volatile fee-policy checks to synchronization. Require a positive test for a completed payment with spent inputs and changed fee configuration before correcting [work item 03](./implementation/03-guard-chain-and-rpc-integration.md) and the [README verification contract](./README.md#proposal-verification). A check to evaluate for CKB is that the raw hash of the response's `txBytes` equals both its `txId` and the `actualTxId` checked on chain, because the shared path [checks only `actualTxId` on chain and counts answers for different transactions together](https://github.com/rosen-bridge/guard-service/issues/23). The CKB hook never receives `actualTxId`, so that equality check and the quorum fix both belong to shared synchronization through ordinary Guard review.
- **Owner:** Sonami proposes the CKB hook correction; ordinary Rosen Guard review owns any shared synchronization change.

### Cold-Balance Reads During Custody Changes

- **Question:** How does the cold projection avoid crediting spent, unselected cells when a paginated inventory spans custody changes?
- **Why it matters:** Selected-input re-resolution does not validate the unselected balance used to retain `low`. An early page can include a cell consumed before a later page includes its replacement. A read reporting 4,060 CKB when only 3,060 CKB remains live can authorize a capped 500 CKB sweep with `low = 2,600` and `high = 3,600`, leaving only 2,560 CKB minus fees. A separate live input can fund the sweep. This is an accounting counterexample, not a live-indexer reproduction.
- **Evidence and precedent:** CKB [creates a new indexer snapshot for each `get_cells` call](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/indexer/src/service.rs#L193-L242). Rosen [Bitcoin](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/networks/bitcoin-esplora/lib/bitcoinEsploraNetwork.ts#L107-L135) and [Cardano Blockfrost](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/networks/cardano-blockfrost/lib/cardanoBlockFrostNetwork.ts#L127-L171) instead consume provider balance summaries. The [shared cold verifier](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/verification/transactionVerifier.ts#L147-L320) adds local transfer and threshold checks, not a globally atomic treasury view.
- **Resolution:** Specify a conservative reconciliation rule for every cell credited toward the retained cold balance and state its concurrency limits. Test spend-and-replacement between pages where the stale cell is never selected, including a transaction absent from local persistence and the current pool. Correct [README cold accounting](./README.md#cold-storage-accounting) and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md) without treating a new global reservation or snapshot service as established Rosen precedent. Under the [Chain Data Trust Model](#chain-data-trust-model) the credited live set is an unverifiable fact from a possibly untrusted source, so the rule must also bound what an overstated live set can authorize.
- **Owner:** Sonami owns the CKB balance calculation; shared cross-Guard balance guarantees belong to Rosen Guard review.

### Payment Attribution Across Guards

- **Question:** Can Guards agree on which source event a confirmed CKB payment settles when different events produce identical raw transaction bytes and approval delivery is incomplete?
- **Scenario to evaluate:** Events A and B request the same payout. Some Guards retain A's approved wrapper; others miss it and later accept B's wrapper around the same raw transaction. The wrappers have different `agreementId` values, but the proposed signing path signs the same CKB digest. Evaluate whether those Guards can participate in one signing operation and then associate its confirmation with different events, leaving inconsistent completion or reward attribution and a potentially stranded event.
- **Evidence status:** The independent 2026-09-23 review inferred this scenario from the [documented collision and agreement model](./transaction-identity-and-finality.md#collision-scenario) and [signing contract](./README.md#wrapper-serialization-and-signing); it has not been reproduced. It reopens the end-to-end attribution claim under Witness-Aware Agreement without selecting a replacement identity or signing design.
- **Resolution:** Trace shared event admission, approval thresholds and delivery, TSS participation, persistence, restart, and completed-payment synchronization. Exercise the same-raw-`txId`, different-event case across multiple Guards with missed and delayed approvals. Establish that one payment settles the same single event everywhere and that the other event remains payable, or document the failing transition and its owner. Update the README, identity analysis, and [work item 03](./implementation/03-guard-chain-and-rpc-integration.md) together after selecting a resolution.
- **Owner:** Sonami owns evaluating the CKB scenario; any shared event-admission or TSS correction belongs to Rosen's shared Guard/signing path through ordinary pull-request review.

### Minted Supply Destination and Initial Cold Split

- **Question:** Which full lock receives the one-time `2^128 - 1` bridge-token mint, and what hot and cold split applies immediately afterward?
- **Why it matters:** The cold-storage contract continues capped token sweeps on every scheduled round while projected hot quantity stays above `high`. A full supply left in hot custody never converges and spends one ECDSA admission per route per round from the bridge-wide signing ceiling.
- **Resolution:** Sonami selects hot or cold as the mint destination. If hot, an initial sweep plan that leaves hot quantity at or below each route's `high`; if cold, the hot-provisioning action and its owner. Existing Rosen practice for wrapped supply on other chains, where known, sets the default.
- **Owner:** Sonami, recorded in [work item 08](./implementation/08-contract-deployment-handoff.md).

### Manual Signing Scope for Unsupported Cells

- **Question:** Does manual prebuilt signing reject unsupported input cells (DAO, foreign-token, unsupported xUDT, and non-empty-data untyped cells) the way automatic paths do, or may an operator move them with exact inputs?
- **Why it matters:** [Work item 03](./implementation/03-guard-chain-and-rpc-integration.md) reads both ways: its input rejection list applies inside `verifyPaymentTransaction`, while its manual rule says to apply only exact-input and supported-shape checks. Under the first reading, capacity and tokens stranded in unsupported cells at the Rosen lock can never be moved without a contract revision. This is distinct from the settled rule that claimants have no recovery entitlement.
- **Resolution:** Sonami states the manual scope explicitly in work item 03 and records the consequence here.
- **Owner:** Sonami.

### Target-Validation Mechanism in Shared Guard Code

- **Question:** Does the narrow pre-insert CKB target check land as an explicit CKB branch in the shared event processor or as a default-true `AbstractChain` hook?
- **Why it matters:** Both shapes touch the same shared pre-insert point. The pinned event order already branches on Ergo as the target chain, so a CKB branch follows existing style; a chain-package hook taking the raw event could not reuse the shared `EventOrder` path the check must follow.
- **Resolution:** Rosen pull-request review. The no-general-target-chain-hook wording under Native Recipient Funding records the selected default, not a prohibition on the reviewer's preferred shape.
- **Owner:** Rosen pull-request review; Sonami proposes the branch.

### Pending Contract Corrections

Selected corrections identified in review on 2026-09-03 and not yet applied to the README and work items. Owner: Sonami, applied with the next README and work-item revision. Remove each when applied.

- **Wrapped-unit boundary:** State once in the README that payment orders, `getTransactionAssets`, `getLockAddressAssets`, `getMinimumNativeToken`, and configured thresholds use Rosen wrapped units, while construction, occupied capacity, fee, and byte rules use native shannons, with the CKB chain package converting at exactly those surfaces. Correct work item 03's instruction to keep `getTransactionAssets` raw, which contradicts every existing chain package at the pinned Guard revision.
- **Hash text form:** Pin lowercase `0x`-prefixed 32-byte hashes at the Rosen-owned RPC adapter for `sourceTxId`, `sourceBlockId`, raw `txId`, the hash inside `box:<hash>.<decimal-index>`, and the `getBlockTransactionIds` return value. The derived Rosen event ID keeps its existing bare digest form. Guard hashes the `sourceTxId` string and checks exact string membership in the source block, so a prefix mismatch fails every CKB event.

## Deployment Inputs

These items need measured values or named owners, not further architecture discussion:

### Identities and Topology

- Final non-hardened TSS derivation array, `tssChainCode`, shared public key, lock args, and distinct complete hot and cold scripts and addresses.
- Work item 08's approved `tss-api` identity, provenance, and direct-digest compatibility evidence.
- Final `SUPPORTED_CHAINS` byte after the Utils merge order is fixed.
- Exact node release and homogeneous Guard/Watcher/Minimum Fee Job node configuration, plus Guard's integrated-indexer configuration.
- Final Watcher commitment depth and Guard observation, payment, cold, manual, and arbitrary confirmation values. The provisional Guard value is 150 for all five paths; launch signoff must record tip-zero semantics, current block/reorg evidence, and acceptance of no automatic rollback after Guard acceptance or completed payment.
- RPC URLs, initial heights, polling intervals, confirmation settings, cold thresholds, native and per-xUDT maximum cold transfers, balance thresholds, cold H1 native amount and per-xUDT service quantities, and alert destinations.
- Scanner block-cleanup threshold duration and per-round trim count for Watcher and Rosen Service, with retention covering the worst-case pre-commit lifetime: the Watcher commitment depth times a conservative block time, plus polling and processing delay, plus margin. Record both values and the conversion.
- Registered tokens and routes, full type scripts, decimals, dep OutPoints, mint transaction, spent single-use owner OutPoint evidence, token-map publication, and final route approver. Registered decimals follow one rule: CKB native is registered without decimal reduction wherever each chain's amount range permits, and each xUDT representation of an existing token uses that token set's current significant decimals; a higher value rounds every return deposit up under the shared ceiling wrap, and a lower value changes rounding on chains already live.

### Inventory and Lifecycle

- Final `maxIdentityCells` identity-read budget, queue behavior, startup seed, and manual-provisioning owners. Record one global untyped CKB-capacity pool and one typed quantity pool per registered xUDT, never one untyped pool per asset.
- Increase the seed and rerun the complete workload until it records no inventory no-fit. Only then retain each resource's lifecycle trace of unavailable selected cells `P_r(t)` and net cell-count erosion `E_r(t)`, choose explicit headroom `H_r`, and propose a seed satisfying `N_r >= max_t(P_r(t) + E_r(t)) + H_r` over the named workload and replenishment horizon.
- Treat that count as necessary but not sufficient. Run the exact complete paginated reads, locally persisted shallow-change provenance, and exclusion rules.
- Validate H1's byte-derived targets and service quanta against the signed-off event, arbitrary, and cold transaction shapes. Measure its cycle and reservation cost, exercise degraded native and xUDT inventories, and confirm the retained latest valid plan stays within the transaction-size limit even when an intermediate cleanup prefix is invalid.
- Cover agreement, configured TSS limit and timeout, competing ECDSA work, commit and indexer delays, retries, multi-input merges, exact covers, deposits, and cold-storage effects. Treat cell count, shared CKB capacity, and each xUDT quantity as separate adequacy checks.
- Record the pre-deployment proposal, assumptions, evidence, horizon, and replenishment owner in the handoff. Production or TSS-configuration deviation triggers a new benchmark and explicit revision rather than automatic policy change.

### Release, Fees, Wallets, and Resources

- The Guard release containing CKB's wire/in-memory full-wrapper `agreementId` binding, raw-`txId` permanent-outcome suppression, and shared status-guarded signing completion, plus Rosen's supplied Guard membership, approval-threshold, `parallelSign`, signing-timeout, and expected competing ECDSA-load configuration.
- The approved `@rosen-bridge/tss` and `tss-api` release, with every Guard on the exact same `@rosen-bridge/tss` version during CKB rollout because [patch versions cannot count each other's approvals](https://github.com/rosen-bridge/sign-protocols/issues/5), and the fix status of each item under [Upstream Fix Preconditions](#upstream-fix-preconditions). The register's TSS source facts were read on `@rosen-bridge/tss` 5.2.0; the later pinned `dev` revision locks 6.0.1, so re-pin them at the implementation revision before work item 03 depends on them.
- Each CKB route's `feeRatioFloat`, checked against [`BigInt(feeRatioFloat * 10000)`](https://github.com/rosen-bridge/minimum-fee-job/issues/2) until that is fixed upstream.
- Current CKB hash-rate distribution by pool, rechecked at launch signoff, with the accepted exposure when one pool exceeds half.
- Representative native and per-token xUDT `serializedSizeInBlock` values and measured cycles; deployment-wide Guard application cycle ceiling, target fee rate, optional absolute fee cap, and shared transaction-size limit equal to every Guard node's `tx_pool_info.tx_size_limit`, with an explicit signoff accepting the resulting cycle-headroom treasury subsidy; local node-policy compatibility evidence; exact-release revalidation of every terminal `-302` `Display` needle; Minimum Fee Job update threshold; and template-review owner.
- Wallet/provider and output-side witness-index qualification evidence for every enabled sender path.
- Work item 08's UI default public endpoint pool and evidence.
- Node and Guard-indexer CPU, memory, disk, retention, and bridge-query benchmark, including tss-api CPU under the deployed `parallelSign` because [each active sign keeps one core busy](https://github.com/rosen-bridge/sign-protocols/issues/7).
- The CKB cold thresholds' sweep-latency and replenishment assumptions, any per-period CKB payout limit Rosen adds, and the operator, funding, and duration of every shared CKB endpoint and of CKB incident response, from [Loss Bounds](#loss-bounds) and [Endpoint Topology](#endpoint-topology).

Work item 08 must create `deployment-handoff.md` with `Item`, `Owner`, `Status`, `Value`, `Evidence`, and `Blocker / next action` columns. Do not duplicate those mutable values here.

## Superseded Positions

### Five-Byte Envelope Selecting Only an Output

Replaced by the eight-byte output-index and source-input-index prefix before the existing Rosen payload. The consumed OutPoint is required for deterministic Rosen-compatible provenance.

### `inputs[0]` as `fromAddress`

Replaced by the explicitly selected source input because the selected consumed OutPoint owns deterministic Rosen-compatible provenance.

### Single ACP Cell per Token

Replaced by normal Rosen-lock transfer cells after Rosen's concurrency and scanner feedback. ACP sharding is technically possible but is not the selected v1 model.

### Uncommitted-Successor Construction, Parent-Readiness Checks, and Parent-Package Handling

Rejected for v1, and the depth revision below does not reopen it. The canonical committed input floor avoids unconfirmed-parent readiness, wrapper-carried parent bytes, topological package handling, and a separate package client; reorg fallout uses canonical-state reconciliation. Guard can start dozens of agreement candidates in one proposer window, but the pinned Guard configures a bridge-wide limit of five ECDSA queue entries per TSS-owner round, and CKB v1 uses one digest per transaction. Provisioned disjoint committed cells therefore address the current configured throughput ceiling with less protocol state. Reopen unconfirmed chaining only from measured production shortage after the deployment inventory model and shallow committed fallback are applied. The public [rcs#2 reply](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5322173229) records the confirmed-only proposal.

### Confirmation-Depth Eligibility for Every Custody Input

Replaced by a canonical committed floor plus a constructor-only deep-first pass with a shallow-committed fallback. Requiring each input's creating transaction to reach the payment-confirmation depth was verifiable but made newly committed custody change unselectable for a whole confirmation window. Making the fallback conditional on another Guard proving that no deeper cover existed would not be verifiable because that Guard cannot see the proposer's candidate universe. The shallow-reorg exposure is instead reduced by the constructor preference and otherwise handled by existing canonical-state reconciliation.

### Timeout Release and Fork-Binding

This position proposed timeout release for an `unknown` shallow parent and fork-binding through the parent's block header. It is rejected. Missing for a confirmation window does not prevent later parent rebroadcast, so releasing another child input can create a double-payment race. Adding the shallow parent's block hash to `header_deps` causes eviction while that block is off the main chain, but a re-reorg revives both the header and signed child; it therefore does not replace indefinite retention and adds canonical header selection, verification, and fee surface.

### Persisted Wrapper `agreementId` and Reactivation State

This position proposed a persisted wrapper `agreementId`, terminal fingerprint table, measured-cycle applicability, and invalid-row reactivation. It is replaced by the retained raw-`txId` transaction row as the single active and terminal owner. Wrapper rejection occurs before persistence, while permanent execution failure applies to the raw transaction family. Accepting permanent suppression after a ceiling change or signature-cycle variation removes schema, migration, applicability, and row-rebinding state at a known liveness cost.

### Minimum Fee Job Template as a Hard Guard Ceiling

Replaced by the selected representative estimate. Guard may construct a heavier valid transaction and custody pays the difference.

### Keep CCC Core or Advanced in Watcher or Guard Because Selected APIs Are Sufficient

Rejected after measuring the published package and runtime main entry. `./advanced` lacks the load-bearing transaction APIs; the sufficient main entry imports unrelated wallet/EVM/network stacks. CCC remains in SDK/UI and as an exact development reference.

### Smallest-First Plus at Most Two Balanced Change Cells

Rejected as a universal self-correcting rule. Legal deposit/payment sequences can grow or oscillate, and the integrated indexer cannot supply global amount order without a complete scan.

### Configured Lane Targets and Universal Representative Useful Amounts

Partially superseded. Configured lane counts remain rejected because `T` is derived from exact transaction bytes. Event and arbitrary service quanta remain request-derived. Cold storage now accepts a deployment-signed native amount and per-xUDT payment quantity because a balance-control sweep has no payment request and its full transfer amount would collapse payment-useful hot inventory. Startup ownership remains necessary because no construction-time rule can create capacity from an exhausted pool. Skew ratios and generic automatic compaction thresholds remain rejected.

## Evidence Pins

- **Rosen RCS:** [Pinned source revision](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf). Used for contribution order, endpoint ownership, and contract-integration ownership.
- **Rosen Guard Service:** [Pinned source revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0). Used for GuardTurn, agreement, transaction retry, chain adapter behavior, and cold/manual/arbitrary paths. A [later `dev` revision](https://github.com/rosen-bridge/guard-service/tree/5b8dcd408c1f70aa42d4257c09fefc4e16cd5fdd), which contains the first, was used for the provider-configuration and upstream-defect facts; it locks `@rosen-bridge/tss` 6.0.1. The upstream-defect issues pin their own source revisions.
- **`@rosen-bridge/tss`:** Version `5.2.0`, Guard-lock integrity `sha512-ONUG30kEv2gS+9NqZ9ZaVgn8l+AuWjnkCTZNgW8I0KaF2Ommg6Wh6AuEucSOsRtMtcMdnM5r47DTbP6iiG9VXQ==`, downloaded tarball SHA-256 `cc41b79a04cb6515c723935f08101cc86efb0164d9048f671898ad460febd61e`. Used for one-minute TSS turns, configurable first-queue-entry admission, posted-sign slot retention, and the 600-second Guard-configured local signing lifetime.
- **Rosen sign-protocols:** [Pinned source revision](https://github.com/rosen-bridge/sign-protocols/tree/f278d8132549dee1a64746e2d64d9d30c0b3bac7). Used for public TSS and Ergo multisig behavior; re-pin and verify the detailed coordinator path before implementation depends on it.
- **Rosen Scanner:** [Pinned source revision](https://github.com/rosen-bridge/scanner/tree/85d0ae8569dcdc95b08a64904d0cb4bf99863184). Used for Scanner and observation rollback behavior, plus the block-cleanup and used-block extractor contract.
- **Rosen Watcher:** [Pinned source revision](https://github.com/rosen-bridge/watcher/tree/f4800ffff49fb84b14dd2d95931f92a034422c45). Used for confirmation gating before commitment creation.
- **Rosen Utils:** [Pinned source revision](https://github.com/rosen-bridge/utils/tree/8074e8ac6685bc1f8c16079905ba5926b39aed1e). Used for the existing unversioned Rosen binary payload and chain-native extractor framing.
- **Rosen SDK:** [Pinned source revision](https://github.com/rosen-bridge/rosen-sdk/tree/d8e546079da772b54e69291b185d09ad7f6f2379). Used for the existing unversioned Rosen payload writer and chain-native metadata containers.
- **Rosen contract:** [Pinned source revision](https://github.com/rosen-bridge/contract/tree/ec2a1f15418a08561b28a9b8a31ba4865b4dc7f4). Used for the Ergo guard-update architecture and Ergo bridge scripts.
- **CCC:** [Package source](https://github.com/ckb-devrel/ccc/tree/5f2f1d433416bd7d60721808d1506fec415ed018) for `@ckb-ccc/core@1.16.1`; earlier behavior reviews used a [mainnet-focused revision](https://github.com/ckb-devrel/ccc/tree/a15c3a783ee2763813b1bcd0f3c27d2e863317b9) and an [earlier review revision](https://github.com/ckb-devrel/ccc/tree/8a19abcd1fe0bde575dc765eac567a4072b84aa0). Used for SDK/UI behavior, differential codec/signing evidence, package-boundary and dependency review; not custody runtime authority.
- **CKB:** [Primary source revision](https://github.com/nervosnetwork/ckb/tree/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987), including the pinned [`blockchain.mol` schema](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/gen-types/schemas/blockchain.mol); relay/orphan behavior used a [relay-focused revision](https://github.com/nervosnetwork/ckb/tree/4358d51d55adb77c52110ac1e2ee8fdc138b12e8), peer configuration used a [peer-configuration revision](https://github.com/nervosnetwork/ckb/tree/c9dc6506541dea79a1e25ef024acc1379e5adb0d), and indexer filters plus the witness commitment in `transactions_root` used an [indexer-focused revision](https://github.com/nervosnetwork/ckb/tree/17d7db5bb423a1b2177e14a132a41d5a91a515f3). Used for the Molecule schema; pool, fee, weight, and size policy; native relay; orphan-parent retrieval; peer configuration; shape-filtered indexer queries; block-level witness commitment; and the `estimate_cycles` error contract in `rpc/src/module/chain.rs`.
- **CKB production scripts:** [Pinned source revision](https://github.com/nervosnetwork/ckb-production-scripts/tree/26b0b4f15bb6eeb268b70d7ae006e244b7c06649). Used for canonical xUDT validation and flags.
- **CKB RFCs:** [Pinned source revision](https://github.com/nervosnetwork/rfcs/tree/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe). Used for transaction, address, xUDT, ACP, and capacity contracts.
- **Rosen selection:** [Pinned source revision](https://github.com/rosen-bridge/rosen-chains/tree/152826b42d3fcf2e1a50e76e54d9d7aa997e614e). Used for iterator-order first-cover behavior and actual Ergo change construction.
- **Rosen chains:** [Pinned source revision](https://github.com/rosen-bridge/rosen-chains/tree/b51e5b87fd98bd599741bffabf680f93f8ebf50e). Used for existing chain-package UTXO chaining behavior, including Ergo's track-map successor substitution and wrapper-carried input boxes.

The relay and peer-configuration revisions above are research evidence, not a substitute for deployment-version verification. Recheck their behavior against the exact node release selected in [work item 08](./implementation/08-contract-deployment-handoff.md). Mark a claim unverified rather than transferring line evidence between commits.
