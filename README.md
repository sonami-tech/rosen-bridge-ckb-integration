# CKB Integration for Rosen Bridge

Technical assessment and implementation plan for integrating [Nervos CKB](https://www.nervos.org/) into [Rosen Bridge](https://rosen.tech/) using the [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003).

**Status: Work in progress.** This specification records the current design, evidence, deployment inputs, and implementation plan; it does not claim a completed integration.

In this document, `v1` means the first mainnet release scope of the CKB integration. It does not refer to the separately versioned Watcher v1 service or to an upstream script version.

This README owns the implementation contract.

The [decision register](./decisions-and-open-questions.md) records accepted choices, deployment inputs, and superseded positions. The [transaction identity and finality analysis](./transaction-identity-and-finality.md) separates CKB's native identities from Rosen event, agreement, persistence, and confirmation semantics. The [work breakdown](./implementation/README.md) organizes implementation by dependency and repository. The [signing comparison](./guard-signing/) explains the selected custody approach. The [public benchmarks](./benchmarks/) contain reproducible decision evidence.

Cited Rosen positions are limited to what their sources explicitly say; the remaining design is Sonami's proposal.

RCS-003 defines three base requirements. CKB supports multi-signer custody and transaction data writing directly. For the endpoint requirement, this proposal uses independently operated local Watcher and Guard nodes rather than one shared operational endpoint.

## Why Rosen Bridge

Rosen Bridge is a bidirectional cross-chain asset bridge with a [proof-of-event](https://github.com/rosen-bridge/docs/blob/d7173e50dcc180012f5a14d81030a0c3833a8849/readme/rosen/catalyst-fund10/f10-rewardmodelandtokenomicsofrosenbridge.md#L9) security model. Two layers of incentivized off-chain verifiers (Watchers and Guards) validate every transfer, minimizing smart contract exposure. Rosen Bridge is [live on mainnet](https://app.rosen.tech/) and currently connects Cardano, Ergo, Ethereum, Binance, Dogecoin, Bitcoin, Bitcoin Runes, and Firo.

Adding CKB means every connected chain becomes reachable in both directions. CKB and registered CKB ecosystem assets can flow outward as wrapped tokens, while assets from those chains flow inward. Candidate assets such as iCKB and SEAL remain separate Rosen token-registration decisions. It would complement RGB++ and Fiber by focusing on bridge transfers between Rosen-connected chains.

Community members can participate as Watchers, staking RSN and earning bridge fees for validating CKB transactions.

Development is led by [Sonami](https://sonami.cc/) and funded by the Nervos [Community Fund DAO](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756).

## 1. Multi-Signer Addresses

CKB can use its native M-of-N multisig lock or the default [secp256k1-blake160-sighash-all](https://github.com/nervosnetwork/ckb-system-scripts/blob/f25c5ae8824c4907ad94326a0113a03defab9bfc/c/secp256k1_blake160_sighash_all.c) lock with Rosen's ECDSA threshold signature scheme (TSS). The [signing comparison](./guard-signing/) owns the rejected native-multisig alternative.

**Chosen approach: ECDSA TSS.** The default lock verifies a standard ECDSA signature, indistinguishable from the one produced by TSS. Its 20-byte args are CKB `blake160` of the 33-byte compressed SEC1 encoding of the derived TSS shared public key; no other public-key representation is valid for address derivation. CKB uses the same signing backend as Bitcoin, Bitcoin Runes, Ethereum, Binance, Doge, and Firo: the existing [tss-api](https://github.com/rosen-bridge/sign-protocols/tree/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/tss-api) Go binary and [TssSigner](https://github.com/rosen-bridge/sign-protocols/blob/f278d8132549dee1a64746e2d64d9d30c0b3bac7/packages/tss/lib/tss/tssSigner.ts) TypeScript coordination. No new distributed-signing package is needed.

This choice reuses Rosen's signer and key ceremony instead of adding a CKB-only coordination service. Native multisig is cryptographically simpler and exposes the threshold on-chain; TSS adds multi-party computation (MPC) and share-management assumptions. The v1 integration chooses the smaller new implementation and operations surface, not equivalent cryptographic risk.

Deposits use normal transfer outputs to the configured Rosen lock. The [occupied-capacity section](#occupied-capacity) owns why Anyone Can Pay (ACP) was discarded rather than deferred.

**Threat model:** the shared ECDSA custody root is an intentional Rosen-wide trust choice: one compromise domain across all ECDSA chains, and CKB adds no separate domain. The hot/cold boundary is part of that same choice: the hot-to-cold sweep is public guard-service code, while spending from cold has no public implementation and its details are deliberately not public.

## 2. Data Writing

### Metadata Location and Envelope

CKB transactions have three potential locations for embedding Rosen Bridge request data:

- **Cell data / output data**: Output cells carry asset data in their `data` field. For the extensible user-defined token (xUDT) standard, the first 16 bytes encode the little-endian `u128` token amount. The v1 design reserves output data for asset data instead of appending Rosen metadata there.
- **Witness fields**: Arbitrary data can be included in a transaction's witness array (analogous to Bitcoin's SegWit witness data). The v1 design reads Rosen metadata from one exact extra witness and validates it off-chain against the selected transfer output.
- **Lock args**: Lock script args encode spending conditions (pubkey hash, multisig script hash, or ACP minimums) and are enforced by each lock script. No standard CKB lock accepts arbitrary extra bridge metadata bytes. A custom lock script could parse extra args bytes, but the bridge's principle is to depend only on battle-tested standard scripts to minimize smart contract exposure.

Output data and witnesses can both physically carry the required bridge request fields (`toChain`, `toAddress`, `bridgeFee`, `networkFee`), but only witnesses are used by the current v1 model.

**Chosen approach: one selected output and source input in an extra witness.** After all inputs and outputs are final, the transaction carries one raw extra witness at `witnesses[inputs.length]`. Its envelope is `[4-byte deposit output index, little-endian][4-byte source input index, little-endian][existing parseRosenData payload]`.

The envelope has no version byte. Existing Rosen binary metadata is unversioned and each chain's native container frames it; the exact extra-witness position, two selectors, and exact payload consumption provide the CKB framing. An incompatible future format requires a new reviewed producer/extractor contract rather than speculative version acceptance in v1.

### Output and Source-Input Binding

The output index binds the request to exactly one Rosen output for lock, token, and amount. The transaction-wide input index selects one consumed OutPoint, and the extractor derives `fromAddress` as `box:<previous_output.tx_hash>.<previous_output.index_decimal>`. That OutPoint is provenance only, not an event key, refund target, or spending credential. No previous cell is resolved during normal extraction.

Inputs have no fixed ordering or source-cell-shape requirement. The explicit source input index is assigned only after final input ordering; official producers select an input controlled by the initiating wallet, preferably from the asset-contributing lock group.

### Witness Commitment and Wallet Compatibility

The extra witness stays outside every input-aligned witness, so it does not overwrite input-side `WitnessArgs` fields. Output type scripts address group-output witnesses by output index, however. When `outputs[inputs.length]` exists, its exact type script must be qualified to ignore that witness; otherwise the builder reorders outputs or rejects the transaction shape. The v1 integration's plain xUDT path has no active extensions and does not consume a group-output witness, but that does not establish general `outputType` availability.

[Default secp256k1 SighashAll](https://github.com/nervosnetwork/ckb-system-scripts/blob/f25c5ae8824c4907ad94326a0113a03defab9bfc/c/secp256k1_blake160_sighash_all.c#L122-L139), all three native multisig variants, and the [quantum-resistant lock script](https://github.com/nervosnetwork/quantum-resistant-lock-script/tree/082c0a19ce4e0b2c0b00f7b46f423f59a30afc71) (QRL) through its proposed [`CKB_TX_MESSAGE_ALL`](https://github.com/nervosnetwork/quantum-resistant-lock-script/blob/082c0a19ce4e0b2c0b00f7b46f423f59a30afc71/contracts/c-sphincs-all-in-one-lock/utils/ckb_tx_message_all.h#L136-L150) commit every witness at an index greater than or equal to `inputs.length`. Other lock schemes remain a wallet qualification boundary, not a Watcher or Guard event-validity policy.

The canonical block additionally commits every witness: [the header's `transactions_root` folds the witness-hash root](https://github.com/nervosnetwork/ckb/blob/17d7db5bb423a1b2177e14a132a41d5a91a515f3/util/types/src/core/views.rs#L762-L777), so a committed transaction's envelope is chain-committed even though the transaction hash excludes witnesses; this is why the witness-carried request stays canonical. Even when an unsupported sender path fails to protect the witness before confirmation, whatever witness confirms is the request.

The v1 integration persists neither the block transaction index nor `witness_hash` as another Rosen identity.

### Extraction and Rejection Rules

The pure network and universal extractors read only the exact extra-witness index, selected output index, and selected transaction input's `previous_output`. They perform no input-cell or dependency resolution.

A selected native CKB output must have no type script and empty output data, and uses capacity as amount. A selected canonical xUDT output must have exactly 16 output-data bytes encoding its amount and is identified by its full type-script hash. The selected deposit amount must be positive.

This is the authoritative untyped deposit predicate, and it matches Guard's rejection of untyped non-empty-data custody cells. An untyped Rosen-lock output carrying data or a zero-value selected deposit produces no event and has no compatibility path.

Missing or malformed envelopes, trailing bytes, out-of-range input or output indices, malformed selected OutPoints, non-Rosen selected locks, and unsupported selected assets produce no event. Other Rosen-looking outputs are ignored.

A sender lock that does not commit the complete extra-witness suffix is unsafe even when its request is well formed: a miner or relay peer can replace the envelope under the same raw transaction hash and redirect the eventual payout. Watcher and Guard validate the envelope that confirms and cannot distinguish that rewrite from sender intent. Such a wallet/lock path is unsupported and has no automatic refund or recovery promise. A sender script that requires the first extra-witness slot for its own schema is likewise incompatible because Rosen metadata owns `witnesses[inputs.length]`.

The v1 integration permits one request per transaction because Scanner and Guard [derive event identity from the transaction ID alone](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/event/eventSerializer.ts#L12-L17). Supporting multiple selected outputs requires a revised event-ID contract that includes output identity.

Guard's [`getActualTxId`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/event/eventProcessor.ts#L303-L304) call is unrelated to this source key. It normalizes the destination-chain payment transaction ID during reward distribution, and CKB returns the raw hash like the closest Bitcoin UTXO precedent.

Missing, malformed, or unsupported requests produce no event and no automatic refund or discretionary recovery promise. Guard arbitrary orders and manual prebuilt signing remain general operator tools, not a claimant recovery service or protocol entitlement.

## 3. Sufficient Endpoints

The pinned CKB node revision in the [decision register](./decisions-and-open-questions.md#evidence-pins) exposes a JSON-RPC API covering chain data and transaction lookup. The topology avoids a shared operational endpoint by requiring independently operated local nodes for Watchers and Guards.

Scanner and both extractors consume transaction hash, input OutPoints, outputs, `outputs_data`, and witnesses directly. They perform no previous-cell or live-cell resolution during event extraction.

Guard fetches the claimed block through its own node and reruns the shared extractor rather than accepting a normalized Watcher object as proof. The operators and chain views are independent; the extractor semantics are shared, so this is not parser diversity.

CKB clients in Rosen's software development kit (SDK) and user interface (UI) may use CCC, the CKB ecosystem JavaScript SDK, with configurable community mainnet endpoints. The exact default pool is a mutable deployment-handoff value with source and reachability evidence, not an implementation-contract hostname. Community endpoints are not production dependencies for Watcher, Guard, or Minimum Fee Job.

Each Watcher and Guard operator runs an independently operated local full node. Watcher uses Chain RPC only and needs no indexer; Guard also uses the node's standard integrated indexer for custody-cell selection. Minimum Fee Job reads height and fee policy from its own operator-owned local node and needs no indexer, and Health Check monitors the services each deployment actually depends on.

The [CKB light client](https://github.com/nervosnetwork/ckb-light-client) ([RFC 0044](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0044-ckb-light-client/0044-ckb-light-client.md)) offers a lower-resource alternative using FlyClient-based sampling and script-level filtering. It is out of scope for v1. The v1 integration also adds no remote-RPC quorum or dual-provider Watcher mode. Watcher uses its local full node; Guard live-cell selection and mempool management use its local full-node/indexer pair.

The remaining sections answer RCS-003's additional requirements and record the CKB-specific contract.

## Token Support

### Token Standard

CKB supports fungible tokens through on-chain scripts:

- **[sUDT (Simple UDT)](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0025-simple-udt/0025-simple-udt.md)**: The original token standard. Stores a 16-byte little-endian `u128` amount in cell data. Token identity is the type script hash. Validates that total output amount does not exceed total input amount (unless in owner mode). No extension mechanism.
- **[xUDT (Extensible UDT)](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0052-extensible-udt/0052-extensible-udt.md)**: Successor to sUDT. It preserves the 16-byte amount layout and can append a 4-byte flags field in type-script args after the 32-byte owner hash to control owner modes and extension data. A 32-byte-args token, or a flags value selecting plain mode, uses the simple UDT validation path.

Under sUDT and xUDT, each token balance lives in a cell, and native CKB is carried as cell capacity, not as a token amount (see [Occupied Capacity](#occupied-capacity)).

**Chosen standard: xUDT.** While only sUDT-compatible features are needed (no active extensions), the ecosystem has moved to xUDT: dominant adoption on [CKB Explorer](https://explorer.nervos.org/xudts), broader wallet support through [CCC](https://github.com/ckb-devrel/ccc), and active tooling development.

### Bridge Token Issuance and Registration

**Proposed bridge-token minting:** Each bridged token representation on CKB (e.g. rsADA, rsERG) is minted once at maximum supply (2^128 - 1) using a [single-use lock](https://github.com/ckb-devrel/ckb-proxy-locks/tree/38b7e1df19828f2203c01b30340be26691b70d7a/contracts/single-use-lock), which CCC's [mainnet known-script config](https://github.com/ckb-devrel/ccc/blob/a15c3a783ee2763813b1bcd0f3c27d2e863317b9/packages/core/src/client/clientPublicMainnet.advanced.ts#L449-L465) references immutably by `data1`. Its authority is tied to consuming one designated live OutPoint, so owner-mode minting cannot be repeated after that OutPoint is spent. Tokens with uncapped supply on their home chain could not have their full supply bridged under this proposal, but 2^128 is large enough that this is not a practical constraint for the proposed routes.

Beyond the standard choice, every bridgeable asset is an explicit Rosen token-map entry; structural xUDT compatibility does not make an asset bridgeable automatically. Both bridge directions require bearer assets: a route subject to third-party freeze or seizure is not supported, and final route selection remains Rosen's registration decision.

**Bridging existing ecosystem tokens:** The v1 extractor recognizes canonical mainnet xUDT, identifies a token by the hash of its full type script, and requires a unique token-map entry containing both the CKB asset and requested target representation. Unknown or source-only tokens produce no event. The v1 integration deliberately supports only the plain xUDT profile with exactly 16 bytes of output data containing the little-endian `u128` amount; other valid xUDT compositions and extension data shapes remain unsupported rather than being classified as malformed xUDT.

The v1 compatibility profile requires extension bits = 0 in the xUDT flags field and an explicitly registered route. Owner-mode bits do not automatically disqualify a token: issuer authority and bearer economics belong to Rosen's normal registration review.

### Full-Script Identity and Conservation

For every Guard transaction, Guard re-resolves every cell, accepts only registered full type-script identities and supported data shapes, and independently requires exact input/output quantity equality for each xUDT type. That check preserves custody even when an owner source or enhanced-owner witness makes the on-chain script skip its own conservation rule.

Deposit extraction validates the registered asset and amount, not issuance provenance. For example, [iCKB](https://github.com/ickb/whitepaper/tree/9984d53b9530c1418df587d3c28058bdb9363e98) fits the structural profile but remains a separate Rosen registration decision. See [xudt_rce.c](https://github.com/nervosnetwork/ckb-production-scripts/blob/26b0b4f15bb6eeb268b70d7ae006e244b7c06649/c/xudt_rce.c) for the owner paths and the conservation rule they can bypass.

**Retroactive extension safety:** An issuer cannot add extensions to an existing xUDT after the fact. Token identity is derived from the full type script (`codeHash`, `hashType`, and `args`), so changing the flags would change the type script hash, creating a different token. Configured script matching must compare the full script, not only `codeHash`.

Changing flags or any other type-script field changes the full script hash and therefore creates a different, unregistered token identity. Rosen may consider issuer and economic controls during its normal manual registration process, but CKB v1 adds no generalized token-audit engine or chain-specific approval framework.

## Occupied Capacity

### Capacity Floors

CKB requires every cell (UTXO) to carry enough CKB to cover its occupied on-chain bytes (1 CKB per byte). This is locked capacity, not a recurring rent payment.

With the canonical 20-byte default-lock args, a basic cell occupies 61 CKB. A plain xUDT cell with 32-byte owner args and 16-byte amount data occupies 142 CKB; iCKB's additional 4-byte flags make the corresponding cell 146 CKB.

Every implementation path calculates the actual value from lock, optional type, and data rather than applying either example as a universal constant.

### Inbound and Outbound Funding

Occupied capacity affects bridge design:

- **Inbound (bridge pays user):** For xUDT, the bridge supplies CKB capacity in addition to the token amount and recovers a conservative capacity bound through `networkFee`. For native CKB, the transferred amount is itself the cell capacity. The exact funding and client-floor rules are derived below.

- **Outbound (user pays bridge):** Users create normal transfer outputs to the configured Rosen lock and carry request metadata in witnesses. An xUDT sender also funds the output's occupied capacity and bears it as a transfer cost; the v1 integration provides no automatic refund or backing entitlement for that capacity. For native CKB, the transferred amount is the output capacity.

### Why ACP Was Rejected

The v1 model uses normal Rosen-lock outputs instead of ACP cells for both xUDT and native CKB deposits. ACP was initially attractive because it lets users add tokens to an existing bridge-owned cell instead of funding a fresh xUDT cell. That optimization is not worth the v1 complexity.

ACP deposits target shared live cells, so concurrent users can race on the same input cell and force retry or chaining logic. A common fee cell would also serialize otherwise independent payments. Avoiding those failures requires proxy contracts or a managed ACP pool, mempool-aware selection, recovery when hot cells are already spent, and extra inbound/outbound liquidity policy.

Normal Rosen-lock outputs give every deposit its own OutPoint, match Rosen's existing UTXO-chain model, and let guards spend as many cells as needed when paying users. The v1 design follows the direction Rosen proposes in the [CKB issue response](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-4926455588), which supersedes the issue body's earlier ACP proposal. ACP is discarded, not deferred: its concurrency, chaining, occupied-capacity, and proxy-contract failure modes are why it lost. If deposit economics ever change materially, the answer is a new design worked out with Rosen, not an ACP revival.

### Recipient Bounds and Validation

Occupied capacity is still accounted for. Minimum Fee Job knows the route's registered CKB token type but not the future recipient lock.

Rosen bounds encoded `toAddress` to 60 bytes on every chain: [each existing chain codec at the pinned Utils revision enforces that limit](https://github.com/rosen-bridge/utils/tree/8074e8ac6685bc1f8c16079905ba5926b39aed1e/packages/address-codec-chains). The CKB codec keeps that shared bound; the CKB-specific consequence is the lock-size limit derived below. The v1 integration accepts any valid mainnet full-format destination within that bound, except exact full-script matches for the configured Rosen hot or cold custody lock on user payout and arbitrary-order paths. The dedicated cold-storage path remains exempt.

Removing the one-byte address-format discriminator leaves a maximum 59-byte on-chain lock script, so an xUDT route's conservative recipient bound is `8 + 59 + (33 + typeArgsLength) + outputDataLength` CKB. With standard 16-byte amount data this is 148 CKB for 32-byte xUDT args and 152 CKB for iCKB's 36-byte args. Guard derives the actual occupied capacity from lock, type, and data as the validity floor, but funds the xUDT recipient cell at the full charged bound, so the surplus stays with the recipient.

The same bound leaves at most 26 lock-argument bytes. Valid CKB locks with longer args are not Rosen payout destinations in v1, including the native multisig [28-byte `since` form](https://github.com/nervosnetwork/ckb-system-scripts/blob/d2629554c4db540c6ebb23b2abe83c29c4887fc8/c/secp256k1_blake160_multisig_all.c#L112-L118) and OmniLock configurations whose recovery or administrator data takes the args beyond 26 bytes.

A native destination is at most 67 CKB under the same address bound, but [guard-service deducts `networkFee` from the transferred native amount](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/event/eventOrder.ts#L165-L182); adding occupied capacity to that fee would charge it twice. `getMinimumNativeToken()` therefore remains `0n`, UI and SDK compare the post-fee amount with 67 CKB, and Guard compares it with the actual output minimum.

The v1 integration adds no ACP field, no `stateRent` field, and no general target-chain event-validation hook, with one deliberate exception. A hand-built native payment below its actual recipient floor, and a payment or arbitrary destination equal to the configured hot or cold custody lock, are permanent request invalidity rather than transient shortage. The [shared confirmed-event path has no rejection transition](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/services/guard-service/src/event/eventProcessor.ts) to fall back on.

Guard therefore validates the CKB target after normal source-event verification and before `insertConfirmedEvent`. It derives the expected payment through the same EventOrder and fee path that construction uses rather than a second fee formula. For native CKB it decodes the target lock and rejects when the net recipient capacity is below that lock's exact occupied floor.

Such a raw event is inserted through the existing rejected-event repository with an explicit reason such as `target-unpayable` or `custody-destination`, so existing rejected publication works unchanged. It never enters `paymentWaiting` and has no recovery promise. xUDT recipient capacity remains a route-bound construction rule and never becomes an event amount floor.

## Lock Scripts

The current v1 path uses the configured Rosen lock for deposit and custody outputs, expected to be the canonical mainnet [default secp256k1-blake160-sighash-all](https://github.com/nervosnetwork/ckb-system-scripts/blob/f25c5ae8824c4907ad94326a0113a03defab9bfc/c/secp256k1_blake160_sighash_all.c) lock with CKB `blake160(compressed_SEC1_tss_shared_pubkey)` in lock args. CCC's [`Secp256k1Blake160` mainnet config](https://github.com/ckb-devrel/ccc/blob/a15c3a783ee2763813b1bcd0f3c27d2e863317b9/packages/core/src/client/clientPublicMainnet.advanced.ts#L23-L39) uses `codeHash = 0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8`, `hashType = type`, and the fixed genesis dep group. The genesis code cell is protected by the zero lock, so it has no ordinary on-chain replacement path.

**Rosen-lock cells:** Guards spend Rosen-lock cells by placing the TSS-produced 65-byte recoverable ECDSA signature in `WitnessArgs.lock`. The lock recovers the public key from the signature, computes `blake160(recovered_pubkey)`, and compares against lock args. Rosen-lock xUDT cells require occupied capacity calculated from their actual lock, type, and data.

**Deposit outputs:** The extractor matches the configured Rosen lock by its full script (`codeHash`, `hashType`, and `args`). The [extraction rules](#extraction-and-rejection-rules) own the selected output shapes and amount semantics.

**Consolidation and spending:** The bridge spends Rosen-lock cells using the standard TSS spending path. Each distinct full Rosen input-lock group receives one 65-byte zero placeholder in the first group witness before digest calculation and one final TSS signature afterward. Type-script groups execute their own validation but do not receive TSS signatures. The normal v1 custody model is expected to use one configured Rosen lock group per transaction.

## Transaction Fee Handling

This section is the single owner of exact CKB fee weight and calculation, payment accounting, and cold-storage accounting. Work items 03 and 04 point here and add only their own consumer-specific inputs and outputs.

### Transaction-Pool Admission

CKB has two relevant fee measures. `serializedSizeInBlock` is the transaction's Molecule byte length plus the four-byte containing-vector offset ([`Transaction::serialized_size_in_block`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/gen-types/src/extension/serialized_size.rs#L32-L46)). Transaction-pool admission compares the configured minimum fee rate against that size alone and requires `fee >= floor(minFeeRate * serializedSizeInBlock / 1000)` shannons ([`check_tx_fee`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/tx-pool/src/util.rs#L28-L54) over [`FeeRate::fee`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/types/src/core/fee_rate.rs#L33-L37)).

### Miner Weight and Guard Fee Bound

Miner selection instead uses the transaction weight `max(serializedSizeInBlock, floor(cycles * 0.0001705714))` ([`get_transaction_weight`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/types/src/core/tx_pool.rs#L277-L302)). CKB implements `DEFAULT_BYTES_PER_CYCLES` as that rounded `f64`; it approximates `MAX_BLOCK_BYTES / MAX_BLOCK_CYCLES`, whose source parameters are 597 bytes and 3,500,000 cycles per reference transaction ([`consensus.rs`](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/spec/src/consensus.rs#L70-L84)). Use the implemented constant rather than exact rational arithmetic.

Exact cycles are available from `estimate_cycles` only for a transaction whose scripts verify. Changing the fee after TSS signing would invalidate the signatures.

Guard therefore finalizes the transaction with 65-byte zero signature placeholders before funding the fee. It funds exactly `ceil(targetFeeRate * max(serializedSizeInBlock, floor(cycleCeiling * 0.0001705714)) / 1000)` shannons, where `serializedSizeInBlock` is measured on that finalized placeholder transaction and `cycleCeiling` is the shared application cycle ceiling. Rounding up is deliberate: the node's own minimum rounds down and covers size only, so this weight-based bound never underpays node policy.

The observed fee is total input capacity minus total output capacity. `verifyTransactionFee` rejects output capacity above input capacity, requires exact equality with the recomputed bound, and enforces the optional absolute transaction-fee cap. The application cycle ceiling, target fee rate, optional cap, transaction-size limit, signed-off native and per-route one-type event templates, CKB cold thresholds, `maxNativeTransfer`, each route's positive `maxTokenTransfer`, and cold H1 service quanta are agreement-critical deployment inputs shared by every Guard.

Let `F_max` be the same fee formula evaluated with `serializedSizeInBlock` equal to that shared transaction-size limit; every supported transaction's exact fee is at most `F_max`. The ceiling-derived fee can intentionally exceed a representative measured-cycle estimate. Deployment signoff must therefore pick the ceiling knowing that a tight one risks rejected TSS rounds while a loose one systematically overpays cycle headroom.

Each Guard requires `serializedSizeInBlock` to fit the shared transaction-size limit. It refuses CKB readiness when local `tx_pool_info.tx_size_limit` differs from that deployment value, local `tx_pool_info.min_fee_rate` exceeds the shared target, or other local size policy conflicts with the deployment contract.

Construction and verification use the shared limit. Local node observations never change an agreed transaction's fee formula or change composition.

Guard cannot observe peer configuration. Deployment must therefore quiesce CKB construction and signing before changing an agreement-critical value and resume only after every Guard has the same value.

`estimate_cycles` executes the transaction scripts, so zero lock placeholders cannot supply a usable pre-sign cycle result. Selection may use measured cycle data only to forecast whether a candidate is likely to fit; the final pre-sign fee bound still uses the shared application ceiling. The terminal-handling contract below owns every result after signing.

### Payment Accounting

For payment and arbitrary verification, CKB transaction-order extraction excludes exact hot-custody-lock change, then groups recipient outputs by encoded lock in first-output order.

An untyped output contributes its full capacity as native CKB. An xUDT output contributes its amount by full type-script identity and no native CKB; transaction-local validation separately requires its capacity to equal the route bound. Each extracted `SinglePayment` reports its `tokens` in ascending lexicographic packed full type-`Script` byte order, matching the canonical output order below.

Construction rejects duplicate requested destinations, and verification rejects duplicate output `(destination, asset identity)` pairs or unsupported shapes. Duplicate rejection applies only to positive extracted contributions, so a typed output never collides with a separate native contribution at the same destination. Grouping can therefore combine distinct xUDT identities for one destination without hiding a split payment.

### Route Minimums

For CKB-side payments, Minimum Fee Job cannot know the future live-cell selection, exact transaction size, or destination lock. It uses measured representative transaction bytes and cycles for the selected construction policy. This estimate is not Guard's construction ceiling and does not freeze one change count into route pricing.

For an xUDT target the job resolves the route's registered full type script and output-data shape, then applies the 59-byte maximum on-chain recipient lock to calculate the token-specific capacity bound. For native CKB it adds no capacity surcharge because the transferred amount is the output capacity.

The estimate is converted to the source token and published through Rosen's unchanged `networkFee` field, and Guard/event processing applies `max(minimumFee, userFee)`. When the actual Guard fee bound exceeds the published estimate, Rosen custody pays the shortfall. When the published estimate exceeds the actual bound, the unused fee remains in custody. A cycle-ceiling term above representative measured cycles therefore creates a systematic treasury subsidy. The surplus-to-recipient rule covers recipient-cell capacity only, not the fee component.

Minimum Fee Job prices one representative complete payment transaction and one recipient cell. Rosen event and arbitrary-order processing use the shared [`generateTransaction`](https://github.com/rosen-bridge/guard-service/blob/ac5702608e8f441a932b01582881a01be32155b0/packages/abstract-chain/lib/abstractChain.ts#L62-L84) contract, which requires exactly one transaction for the complete expected order. Guard does not impose an input-count limit derived from the fee template.

Request metadata changes the user's outbound CKB deposit transaction size and fee, but it does not increase output occupied capacity. The inbound route to CKB models the separate Guard payment transaction, which has TSS witnesses but no Rosen request metadata. There is no fixed `stateRent` constant or separate `stateRent` field in the event contract.

### Cold-Storage Accounting

Cold-storage outputs extract differently. Every typed cold output has exactly the occupied capacity of its cold lock, type, and 16-byte data; it contributes its token quantity but zero extracted native. CKB schedules token-only and native-only cold transactions. The configured full hot and cold lock scripts must differ.

Cold balance and construction use the complete **cold-reachable set**: every eligible depth-qualified hot-lock cell plus every shallower canonical committed hot-lock output whose creating transaction is independently proven through Chain RPC to spend only exact configured Rosen hot-custody-lock inputs. Cold provenance does not depend on local transaction persistence. Before balance, trigger, or construction, remove every input held by another in-window candidate, nonterminal active CKB transaction, or local-pool spend and credit none of their outputs.

Cold verification starts from that same pre-transaction projection. It does not subtract the extracted cold order from `preBalance`; it omits only the exact current raw-`txId` row from active-consumer subtraction, applies the proposed transaction once, and rejects duplicate input consumption. Keep the shared cold-address, forbidden-token, and active same-token checks only where their semantics match this CKB projection.

Let `M_hot` and `M_cold` be the occupied capacities of one untyped empty-data hot and cold output. Native cold configuration requires `high >= low`, `low >= M_hot`, `maxNativeTransfer >= M_cold`, and `high - low >= M_cold + F_max`; reject configuration that fails any bound. For exact stable fee `F`, the constructor transfers `min(preBalance - low - F, maxNativeTransfer)` in one untyped cold output. The bounds ensure every triggered round emits a valid cold output and leaves any positive hot remainder at or above `M_hot`. Later scheduled rounds continue when the cap leaves hot balance above `high`.

For the triggered token route, the token-sweep constructor transfers `min(preBalance - low, maxTokenTransfer)` units in one typed cold output, transfers no native amount beyond that output's exact occupied capacity, and transfers no other token. A capped round continues on later schedules while projected hot quantity remains above `high`. Each native sweep transfers no token.

The CKB cold-storage hot projection separately accounts for capacity released by consumed typed inputs. Input resolution belongs to Guard transaction verification; deposit extraction reads the selected input's OutPoint for provenance but resolves no previous cell.

## dApp Connector

CKB has wallet connectivity through CCC, which exposes signer interfaces for JoyID, UniSat, OKX, UTXO Global, Rei, and EVM wallets through wallet-discovery standard EIP-6963. Connector availability does not establish compatibility with Rosen's extra witness. The official UI enables an exact provider-version and input-lock path only after proving that it preserves the finalized transaction and commits the complete witness suffix.

### Qualification Matrix

#### Default secp256k1

This path includes the pinned [UTXO Global](https://github.com/UTXO-Global/utxo-wallet-extension/blob/817ed1d71caf095657e82895a0d6a3cf10d243d0/src/shared/networks/ckb/helpers.ts#L228-L301) and [Rei](https://github.com/TeamTaoist/reiwallet/tree/55d281d288d526ae7958b5dc10874143297054ad) source paths. The deployed lock commits the suffix; the inspected providers preserve witnesses and sign through Lumos.

**v1 gate:** Qualify each installed extension version with a real-provider differential test.

#### Native Multisig

The reviewed variants are [genesis](https://github.com/nervosnetwork/ckb-system-scripts/blob/5e3756ef4d8c90e87149f4790114ad1c003a2f04/c/secp256k1_blake160_multisig_all.c#L175-L220), [V2 beta](https://github.com/nervosnetwork/ckb-system-scripts/blob/934166406fafb33e299f5688a904cadb99b7d518/c/secp256k1_blake160_multisig_all.c#L219-L283), and [V2](https://github.com/nervosnetwork/ckb-system-scripts/blob/d2629554c4db540c6ebb23b2abe83c29c4887fc8/c/secp256k1_blake160_multisig_all.c#L217-L281). All deployed variants retain the suffix-hashing loop; the beta fix did not change the message.

**v1 gate:** Qualify any variant exposed by the UI with partial-signing and aggregation tests.

#### OmniLock Signed Paths

[OmniLock](https://github.com/cryptape/omnilock/blob/cd764d7133ec4e6b192fac4b93fc0596ef5b71f6/c/ckb_identity.h#L377-L466) signed paths support BTC, EVM, Doge, or Nostr providers. CCC derives the suffix-covering digest locally and sends only the message for signing.

**v1 gate:** Qualify each provider and require the expected full lock identity.

#### PW Lock Signed Path

CCC and the [published lock source](https://github.com/lay2dev/pw-lock/blob/b447c2bb3f855e933e36212b45af4dec92adf705/c/secp256k1_keccak256_lock.h#L435-L549) commit the suffix.

**v1 gate:** Wait until the exact live binary passes the differential VM test; reject the unsigned ACP/payment path.

#### JoyID CKB

The [official SDK](https://github.com/nervina-labs/joyid-sdk-js/blob/5f25794006dca5276f6b1f287aa81b460bd9af78/packages/ckb/src/index.ts#L249-L345) and [historical lock tests](https://github.com/nervina-labs/joyid-lib-demo/blob/85dd579ca392e94f1c1fc60a10a0551f48c6f4c3/tests/src/native_tests.rs#L245-L307) commit an extra witness, but the current hosted provider and closed-source deployed lock are not reproducibly pinned.

**v1 gate:** Wait until the live provider preserves the suffix, a one-byte mutation fails the deployed lock, and CCC resolves and records the complete live mainnet deps.

#### QRL

The deployed message algorithm commits the suffix, but pinned CCC exposes no QRL signer.

**v1 gate:** Not enabled in v1.

### Qualification Procedure

Qualification places the complete known envelope with fixed-size selector placeholders before fee completion, refreshes both selectors after any input or output mutation, and repeats fee completion until the full unsigned transaction is stable. It signs without broadcasting, compares the complete returned transaction, and permits only documented input-witness lock changes.

It then verifies the original against the exact deployed lock and requires the same signature to fail after changing, removing, appending, or reordering an extra witness. Installed extension identity and version, full input-lock script, CCC version, resolved deployment deps, and test evidence are retained; any change closes the gate until requalification.

[CCC resolves dependency entries carrying Type-ID descriptors](https://github.com/ckb-devrel/ccc/blob/a15c3a783ee2763813b1bcd0f3c27d2e863317b9/packages/core/src/client/client.ts#L622-L641) to their current live cells before using configured fallback OutPoints, so a stale fallback alone is not proof of incompatibility. This producer gate protects supported sender intent without adding input resolution or a source-lock allowlist to Watcher and Guard.

## Custody Concurrency and Transaction Chaining

This section answers RCS-003's Transaction Chaining requirement. CKB uses normal UTXOs for bridge custody and payments. Identity reads, construction, and selected-input re-resolution run outside the chain-scoped critical section. Before registering a candidate or active transaction, Guard enters the section, refreshes persisted active transactions, local mempool spends, and its locally in-window candidates, rejects any selected-input conflict, and registers the new exclusion before release.

Rosen has no automatic custody-maintenance transaction, trigger, agreement path, retry path, or anti-churn rule. Routine manual re-denomination is not an operating fallback. The v1 integration therefore applies one eager-cleanup order-quantum policy (H1) to every transaction Guard constructs: event payments, arbitrary multi-item orders, and cold-storage sweeps. Each path retains its own recipient or cold-transfer demand, input eligibility, and canonical base selection; all three use the same bounded construction tree once that base is available.

H1 preserves useful committed inventory during ordinary Guard construction while keeping each request in one transaction. It selects no uncommitted output, separates CKB capacity from xUDT quantity, keeps typed xUDT change at exact occupied capacity, folds no sub-floor residue into fee, and emits only canonical minimal change while relevant change is unresolved. It adds no maintenance transaction or CKB-only lifecycle fork.

### Critical Section and Candidates

#### Candidate Registration and Approval

A candidate is keyed by its `agreementId`. Every request recomputes that ID from its exact placeholder wrapper before lookup. A matching ID is therefore an **exact candidate match** rather than a second byte key: retransmission is idempotent, retains the existing registration, and creates no second candidate.

Every **different** in-window candidate that shares any input with the work under consideration is a conflict. It blocks both proposal validation and in-window approval.

Approval of an exact candidate atomically removes that candidate and persists the transaction into existing active state. It registers the input exclusions before the section is released, so no window exists in which neither the candidate nor the active record holds those inputs.

A candidate exclusion lapses with the existing agreement window and is deliberately lost on restart; nothing about a candidate is persisted. An approved transaction stays excluded until it reaches authoritative terminal chain state.

Manual intake still registers its exact inputs in active transaction state before TSS and has no exact-candidate exemption. It rejects overlap with every in-window candidate, active transaction, and local-pool spend before that insertion.

Independent events can then proceed on disjoint committed cells. The local mempool scan also catches signed transactions from an agreement window that a Guard missed.

Losing candidates on restart is safe because a candidate is only a local construction hint. A restarted Guard rebuilds exclusions from persisted active state and its local pool. When a threshold approval later arrives, it carries its own bytes and follows the acceptance-time verification below; a TSS request alone cannot produce a new local share unless the same transaction has entered that Guard's persisted active processing.

#### Approval Verification

An approval delivered by the shared communicator is not rejected merely because its `agreementId` is unknown locally, such as after restart. Guard first rejects any wrapper whose raw `txId` names a retained invalid transaction row.

A wrapper matching an already active row is idempotent only when normalizing the permitted signed-lock replacement back to the canonical placeholder reconstructs the same wrapper and `agreementId`. Otherwise Guard reruns the complete common verification at acceptance time.

That verification covers exact wrapper bytes with a recomputed matching `agreementId`, current event or order status, input liveness and committed status, active-transaction and input conflicts, overlap with any different in-window candidate, local mempool conflicts, transaction-type policy, fee, conservation, and supported shape.

Guard accepts and persists only when that verification still passes; otherwise it leaves the request in its existing lifecycle. The shared communicator owns whatever message-age policy its installed release enforces. CKB adds no second approval expiry.

#### Local and Cross-Guard Conflicts

The local invariant is that one Guard never holds overlapping nonterminal active transactions or overlapping in-window candidates. This is not a cross-Guard promise: two Guards can still construct input-conflicting transactions over the same custody cells.

CKB's single-spend rule is the explicit resolver for that case only. At most one input-conflicting transaction confirms. When canonical input death is authoritative, Guard terminalizes the loser, releases its active exclusion, and returns its event or order to the existing waiting or retry lifecycle.

This rule does not prevent two Guards from constructing disjoint transactions for the same event. Shared Guard transaction admission is the existing event-level owner. At the pinned release, each Guard serializes insertion, replaces an approved incumbent only with a lower transaction ID, and rejects replacement after the incumbent advances.

That per-Guard rule does not by itself prove cluster-wide convergence under opposite arrival order. CKB rollout requires adversarial multi-Guard tests through approval, restart, late delivery, signing, and confirmation. A failure must be fixed in the shared Guard owner before rollout, not with a CKB-specific coordinator or protocol message.

#### Retry and Submission Idempotence

Deterministic unchanged-state retries are idempotent by construction: the same relevant construction state and agreement-critical configuration reproduce the same wrapper bytes and the same `agreementId`.

Duplicate-submission error `-1107` is only an acknowledgement that the node already holds the transaction and has reannounced it. Guard treats it as a successful submission and reconciles the outcome through authoritative `get_transaction`. It never creates an `accepted` lifecycle state, never marks the transaction confirmed, and never releases active inputs from `-1107` alone.

### Canonical Transaction Shape

Automatic CKB construction fixes every raw field before agreement. Transaction version is `0`; every input `since` is `0`; inputs follow the canonical final input order defined below; `cell_deps` are exactly the independently resolved deployed deps needed by the executed lock and type scripts, without duplicates and in lexicographic packed-`CellDep` byte order; and `header_deps` is empty.

The v1 integration's one Rosen input-lock group has one input-aligned witness per input. The first is `WitnessArgs` carrying only its 65-byte zero `lock`, constructed from the empty supported placeholder rather than from any preexisting `inputType` or `outputType`. Every later witness is empty bytes, and there are no extra witnesses.

Manual signing preserves caller-supplied input and output order but enforces the same version, `since`, dep, header, and supported witness-shape constraints.

### Canonical Output Order

Automatic construction walks the Rosen request array in order. For each `SinglePayment` it emits that payment's positive native recipient output first, then its positive xUDT recipient outputs in ascending lexicographic packed full type-`Script` byte order, before moving to the next `SinglePayment`. Every recipient output is emitted before any custody output.

Only once all recipients are emitted does construction append positive xUDT custody outputs. It groups them by ascending lexicographic packed full type-`Script` bytes and orders each group by token quantity descending, then capacity descending. Positive untyped custody outputs follow in capacity-descending order. Custody outputs are never interleaved among recipients, and `outputs_data` stays index-aligned with `outputs`.

Event-payment, arbitrary-order, and cold-storage construction and their independent verification all apply this exact rule. Manual signing preserves caller order instead.

### Agreement Identity

CKB agreement does not use the on-chain transaction hash as its proposal identity because that hash excludes witnesses and the transaction alone does not identify its Rosen request. After installing every 65-byte zero lock placeholder, Guard decodes `txBytes`, recomputes the CKB raw transaction hash, and requires it to equal `txId`.

Guard computes `agreementId = ckbBlake2b256(UTF8(paymentTransaction.toJson()))` once over that placeholder wrapper, using the 16-byte `ckb-default-hash` personalization. The JSON's fixed serialization order is `network`, `eventId`, lowercase-hex `txBytes`, `txId`, and `txType`, with no added whitespace. Those five wrapper keys are fixed camelCase.

Deployment policy is not carried on the wire and is not hashed into the identity. Each Guard already runs complete local transaction and policy verification on every request, vote, non-idempotent approval, persistence, and TSS submission, so a transaction that is invalid under a Guard's current policy is rejected there. Adding a policy hash to the wrapper would restate that check less precisely than the checks themselves.

### Terminal Handling

Every signed outcome is temporary or permanent. A temporary result retains the exact signed bytes and active-input exclusions, then reconciles or retries. A permanent result invalidates the existing transaction row under raw `txId`. It returns payment to `paymentWaiting`, arbitrary to `waiting`, cold storage to its next scheduled round, or manual signing to its terminal outcome. The specific cause remains a diagnostic reason rather than another behavioral enum.

Permanent outcomes are a successful cycle count above the application ceiling, a `-302` detail containing `ExceededMaximumCycles`, a recognized deterministic `-302` detail (`ValidationFailure`, `ScriptNotFound`, `InvalidScriptHashType`, `Invalid VM Version`, or `MultipleMatches`), and canonical input death after the existing finality grace.

Temporary outcomes are transport failure, timeout, internal error, every unresolved-input `-301`, unrecognized `-302` detail, and ambiguous chain state.

The shared processor asks each chain for a boolean validity result on unsigned `signFailed` retry and on missing signed transactions. For CKB, `false` means only proven permanent raw-transaction invalidity: canonical input death after the configured grace or another explicit consensus fact that makes those bytes unusable. Input `unknown`, RPC ambiguity, local absence, TSS failure or timeout, wrapper or policy rejection, and unrecognized node errors must not return `false`. A non-false retry result does not authorize signing; complete current verification still runs before every local TSS submission.

Terminal suppression reuses Guard's existing retained `TransactionEntity` row and raw-`txId` primary key. Only permanent transaction-execution facts may invalidate that row; wrapper mismatch, request mismatch, policy rejection, and candidate conflict fail before persistence and never poison a raw transaction. Construction, proposal validation, approval, and manual intake consult the retained invalid row, suppressing the same failed raw transaction before another agreement or TSS attempt. Another request waits until changed custody or agreement-critical construction state produces a different `txId`.

Active-input conflict, committed-cell shortage, exhausted-selector no-fit, and automatic reconstruction of a raw `txId` already retained as invalid use each request path's existing waiting or retry lifecycle under distinct diagnostic reasons. Guard checks the invalid row after construction and before agreement, so unchanged state cannot repeatedly propose the same permanently failed transaction. Add no CKB-specific waiting, escalation, timeout, or consolidation path. An intrinsically invalid or unsupported payment is rejected rather than split.

### Wrapper Serialization and Signing

`txBytes` is the lowercase hex of the packed Molecule `Transaction`, never a JSON object of raw transaction fields. No CKB JSON-RPC field spelling can therefore enter `agreementId`.

Rosen-owned CKB JSON-RPC adapters normalize node JSON into the owned structural types at that boundary, converting snake_case RPC field names to camelCase structural names.

The fields `version`, `since`, `inputs`, `outputs`, `capacity`, `lock`, `type`, `args`, `index`, `witnesses`, and their hex values retain their names and codec-defined encodings. Elsewhere in this tracker, a field named by its CKB RPC or Molecule spelling denotes the corresponding structural field after this mapping.

Requests, responses, approvals, and in-memory candidates carry `agreementId`. Every message carrying wrapper bytes is decoded, recomputed from those exact placeholder bytes, and required to match its signed ID before approval or persistence.

Persisted state keeps the existing raw `txId`, `txJson` wrapper, scalar transaction `type`, and event or order relation. Signing replaces `txJson` with a wrapper that preserves `eventId` and `txType`; it adds no agreement identity field. Raw `txId` never substitutes for approval bytes, including the late-approval path. Existing chains keep their current transaction-ID agreement behavior, and cold storage retains its existing empty `eventId`.

Before each local TSS submission, Guard re-resolves every input and computes CKB SighashAll from the exact finalized placeholder transaction and complete Rosen input-lock group. It submits that 32-byte digest directly, without a CKB prefix or second hash.

TSS returns a 64-byte compact signature and recovery value `0..3`. Guard assembles `r || s || recovery_byte`, recovers the compressed public key, requires its CKB `blake160` to equal the configured lock args, and replaces only the specified 65-byte lock placeholder. Every other byte must remain equal. Guard stores the complete signed bytes on the existing raw-`txId` row and compares complete bytes whenever witnesses matter.

Signing completion uses one atomic update conditioned on the row still being `inSign` or `signFailed`. A late callback affecting no row is discarded and can never restore `invalid` or `completed` to `signed`. No attempt ID is needed because a raw-`txId` row is never rebound to different bytes.

CKB's native `witness_hash` is derivable from the signed bytes but is not persisted as another Rosen identity. It changes from the placeholder and can change across signing runs.

Rosen's shared Guard service owns membership, approval threshold, turns, and Guard-set changes. CKB adds no attempt or view identity, durable positive-vote store, quorum-certified abort or expiry, general active-transaction synchronization, Guard-set epoch, Byzantine threshold, cross-epoch protocol, or transaction-replacement protocol.

### Committed Inputs and Inventory Planning

#### Committed-Only Throughput Model

[Existing Rosen UTXO integrations may construct children from locally stored signed parents](https://github.com/rosen-bridge/rosen-chains/tree/b51e5b87fd98bd599741bffabf680f93f8ebf50e), but CKB v1 never selects or newly admits an uncommitted output. Construction, proposal and approval verification, persistence, manual intake, and every TSS submission require each input cell to be live with a canonically committed creating transaction at that check. That committed floor is what keeps unconfirmed-parent readiness, parent bytes on the wire, package agreement and submission ordering, transitive conflict state, and coordinated descendant machinery out of the v1 admission contract.

The committed floor is also the selected throughput policy, not only a simplification. At the pinned Guard release, one proposer can start many agreement candidates during its two-minute active window. Guard configures `@rosen-bridge/tss` 5.2.0 with `parallelSign: 5`, and the library admits only the first configured number of queue entries in each one-minute TSS-owner round. Posted but unfinished entries retain their slots until timeout, and the same ECDSA signer serves other Rosen ECDSA chains.

CKB v1 has one Rosen input-lock group and one ECDSA digest per transaction. Five is therefore the current bridge-wide fresh ECDSA admission ceiling per healthy minute, not a guaranteed CKB allocation; completion can be lower. Starting more agreements does not raise that ceiling, and unconfirmed chaining would only change how cells feed it.

A set of disjoint committed custody cells lets available signing jobs proceed in parallel without introducing an unconfirmed dependency chain. The v1 integration therefore keeps the stronger committed-state recovery model around the bottleneck that remains.

#### Inventory Benchmark

Before deployment, a lifecycle benchmark must propose a committed inventory that covers the supported workload. Model one global untyped CKB-capacity pool and one typed quantity pool for each registered xUDT identity. Never multiply the untyped seed by the asset count or assume one hot xUDT bounds native and mixed-asset capacity demand.

For each resource `r` and simulated time `t`, let `P_r(t)` be cells unavailable while selected work crosses agreement, TSS, commitment, and indexer visibility. Let `E_r(t)` be the net cell-count erosion caused by completed multi-input merges, exact covers, deposits, and cold-storage effects, and let `H_r` be explicit operating headroom.

Because `P_r + E_r` is censored by an inadequate starting seed, increase the seed and rerun the complete workload until it records no inventory no-fit. Only that zero-no-fit run may supply `max_t(P_r(t) + E_r(t))`. The proposed seed then satisfies `N_r >= max_t(P_r(t) + E_r(t)) + H_r` over the named workload and replenishment horizon.

Cell count, total CKB capacity, and each xUDT quantity remain separate adequacy checks. The typed quantities must cover the modeled payout distribution.

The benchmark includes the Guard's proposer window, five-second agreement drain, 60-second transaction processor, configured global ECDSA TSS rounds and timeout, competing non-CKB ECDSA work, indefinite payment queues, candidate expiry, retries, and shallow committed Guard-change reuse.

Its current lifecycle harness uses complete in-memory identity inventories and fixture provenance. It does not prove RPC pagination, cursor failure handling, or persisted shallow-change provenance. The count formula above is therefore necessary but not sufficient: deployment must exercise the exact complete read, persisted-change provenance, and exclusions against the intended topology.

Each lifecycle profile also carries the transaction fee rate, cycle-weight bytes derived from the application ceiling, transaction-size limit, structural shape, and custody-lock shape used for construction. The deployment rerun replaces those values with the signed-off configuration.

CKB consensus allows commitment 2-10 blocks after proposal. At the recent 9.3-second cadence, a transaction proposed in the next block has a rough 28-102 second broadcast-to-eligible-window range, but later proposal and indexer visibility can extend it. Reproducible public-node observations are input-method checks, not a deployment distribution. The deployment profile must use the intended node and indexer topology or a stated conservative bound.

The handoff records the deployed `parallelSign`, TSS timeout, competing ECDSA load, every other source and assumption, each trace, headroom choice, and provisioning owner. The lifecycle model sets the startup seed, not H1's path-shape-derived target or cold service quanta. If production or TSS configuration contradicts it, the resulting data drives a new benchmark and explicit revision. Agreement-start counts alone cannot reopen unconfirmed chaining.

The reproducible model, policy comparisons, tests, and generated evidence are published in the [CKB custody-flow benchmark](./benchmarks/custody-flow/).

#### Shallow Committed Change

Above that floor, depth is a constructor preference rather than an eligibility rule for payment and arbitrary inputs. Those constructors first run H1 with their path-specific demand and canonical base selector over every depth-qualified cell from the complete identity read.

Only when that set admits no valid plan do they apply the same path-specific rule to the deep set plus shallow committed **Guard-produced change** identified from the Guard's locally persisted CKB transaction rows. The supplement contains only outputs of those exact persisted transactions whose creating transaction is now canonical committed but has not reached the configured depth. It performs no extra indexer read and cannot admit an ordinary deposit.

Every supplemented output and its creator are re-resolved through canonical Chain RPC. A shallow creator is Guard-produced only when every one of its inputs' previous cells is independently fetched and carries the exact configured Rosen hot custody lock. The same predicate applies to a shallow manual input. Parent data never rides in the proposal; every Guard derives it from canonical Chain RPC while approving.

The v1 integration adds no custody-input depth setting; canonical committed status is the fallback floor. A Guard that never persisted another Guard's transaction may omit its shallow change until it reaches normal depth. That is a local liveness difference rather than a verification rule.

Cold storage uses the same shallow-parent predicate without the local-persistence restriction. Its balance, trigger, construction, and verification include all canonically provable shallow Guard outputs but exclude shallow user deposits.

For payment and arbitrary construction, deep-first is deliberately constructor-only because no other Guard can observe the proposer's candidate universe. Verification accepts every deep hot-lock input and shallow Guard-produced hot-lock input after re-resolving liveness and contents exactly. Cold input eligibility is shared and verified against the cold-reachable depth-or-parent rule. Manual signing supplies exact inputs, so it applies the committed and Guard-parent floor and runs no selection pass.

Reorg fallout stays with existing canonical-state reconciliation, per affected transaction. A shallow input that is not live on a verifying Guard's current canonical view fails that Guard's current verification.

After signing, a reorg can detach both a parent and child, and CKB can re-add those exact transactions to one node's local pool. That passive package residency is not new uncommitted-input selection or package construction. No further transaction may use their outputs unless the creating transaction is canonical committed again.

Restricting the fallback to Guard-produced change makes ordinary recovery likely because the exact parent is already persisted by the Guards that produced it. Every Guard therefore does not need to receive parent bytes in the child proposal.

#### Reorganization and Retry Handling

Every signed retry first reconciles the transaction's own authoritative `get_transaction(txId)` status and local-pool presence. A copy confirmed or re-added elsewhere is therefore never misclassified from its now-spent inputs.

If the transaction remains absent and any declared input is `unknown`, including a detached parent output, exact signed bytes and every input exclusion remain active without timeout or retry-count release. `-301` stays temporary and does not invalidate the row.

Only a declared input canonically `dead` through another transaction, evaluated after the existing finality grace, or another consensus fact that makes the raw transaction permanently unusable permits invalidation and the existing waiting, scheduled, or manual-invalid outcome.

An `unknown` dependency can therefore wait indefinitely. That is the explicit safety cost that avoids a replayable signed child racing a replacement. The v1 integration adds no header binding, ancestry graph, or cross-transaction cascade protocol.

### Selection and Identity Reads

Input selection and change composition are one policy because selected inputs determine xUDT remainder, available CKB, exact cover, and possible outputs. The v1 integration uses complete paginated identity reads, one total comparator order, and the same H1 construction tree for every automatic path. Each Guard has a positive per-identity `maxIdentityCells` work budget.

#### Paginated Read Budget

For one exact full identity, configure a positive maximum request limit `L`. Before each built-in-indexer request, use `min(L, maxIdentityCells - accumulatedCount + 1)` as the effective limit. This lets the traversal observe one over-budget sentinel without fetching an unbounded page.

Check whether the response would exceed `maxIdentityCells` before treating a short page as complete. If it would, return the temporary `identity-read-budget-exceeded` outcome without adding the page or constructing from a partial set.

Otherwise accumulate the page and stop only when `objects.length` is less than that request's effective limit. An empty page is terminal, while an exact multiple requires a final empty request.

After every full page, require the returned `last_cursor` to differ from the cursor just sent before requesting the next page. A missing or non-advancing cursor is a temporary read failure.

#### Eligibility and Re-resolution

Exact identities are untyped empty-data Rosen cells or one registered xUDT type with 16 data bytes. Exact lock/type/data eligibility is post-validated on every page. The shallow persisted-change supplement above contains only locally known transaction outputs within the confirmation window.

Cursor traversal is not treated as a snapshot. Guard re-resolves every selected input through Chain RPC for liveness, contents, and committed status, then performs the critical-section conflict check and exclusion registration described above.

A stale, conflicting, malformed, or over-budget read returns the request to its retry lifecycle.

### Canonical Position and Comparators

Every paginated indexer read uses `order: "asc"`. A row's canonical position is the numeric tuple `(block_number, tx_index, output_index)`, compared ascending field by field, with ascending lexicographic packed-`OutPoint` bytes as the final tie-break.

After the complete read and optional persisted-change supplement are united, the native comparator orders untyped cells by capacity descending, then canonical position ascending, then packed `OutPoint` ascending. The xUDT comparator orders same-type cells by token quantity descending, then capacity descending, then canonical position ascending, then packed `OutPoint` ascending. Both are total orders over distinct OutPoints, so construction and independent verification derive the same sequence from the same declared set.

Payment and arbitrary construction each run H1 with their path adapter over the complete depth-preferred set first. Only when that yields no valid plan do they retry over that set plus the shallow locally persisted change supplement. Cold construction runs H1 once over the complete cold-reachable set after common reservations are removed.

### Canonical Base Selection

For an event payment, build the first canonical cover from the complete depth-preferred set above in comparator order. Native uses untyped cells by capacity descending. xUDT considers the typed quantity-cover prefix first, then untyped cells that meet the current capacity-mate quantum, remaining same-type cells, and finally smaller untyped cells. Every selected typed cell's capacity funds the shared CKB ledger, and every token remainder returns to same-type custody outputs.

When that order yields no cover that can be repaired to respect the identity ceiling, the only alternate cover is a minimum-cardinality exact-token subset. It is drawn from the first 30 comparator-ordered payment-type cells whose quantity does not exceed the request. An exact subset requiring a cell outside that bounded window is no-fit.

### Canonical Minimal Composition

For a fixed selected set, let `C` be total input capacity, `R` total capacity sent outside hot custody, and each `U_i` be the selected quantity of one xUDT identity minus its outgoing quantity. Emit exactly one same-type custody output at its occupied floor for every positive `U_i`. Compute `F(outputs)` from each exact candidate output shape.

If `C - R - sum(typedFloors) - F([typed...])` is zero, emit only those typed outputs. Otherwise use the split form when it fits the shared transaction-size limit and `C - R - sum(typedFloors) - F([typed..., untyped])` is at least the untyped occupied floor. In that form, keep every typed output at its floor and put the complete remainder in one untyped output.

A positive remainder that cannot fund the untyped output is no-fit rather than absorbed into typed change or folded into fee. Every positive output must meet its exact occupied floor; if neither form exists, the selected set is no-fit.

Native CKB and exact-token xUDT cover are the zero-typed-remainder cases. They emit either no change on exact cover or one valid untyped change. Every path uses this composition for its canonical base and H1 fallback.

### Unified H1 Construction

#### Construction Tree and Path Inputs

H1 is a bounded greedy construction tree, not a change post-pass. A node is an ordered selected-input set plus the first valid plan from the finite output-count search below. Deriving a node recomputes the path's outgoing demand, canonical composition, occupied-capacity floors, exact fee, inventory projection, output shaping, and complete serialized size. Exhausted work budget or absence of a valid plan is no-fit.

The path adapter supplies only:

- the fixed payment recipients, fixed arbitrary-order recipients, or cold-transfer demand from the cold-storage formula;
- the depth-preferred or cold-reachable eligibility set; and
- the canonical base selector: the event-payment cover above, or the aggregate cold/arbitrary selector below; and
- the ordinary-payment service quanta defined below.

Every tree edge adds exactly one input. The primary root is the path's first canonical cover. Event xUDT payments alone have the bounded exact-token alternate root above; arbitrary orders do not multiply exact-subset choices across type groups. From either root, ceiling repair adds the smallest matching confirmed cell for the first violated identity, with typed identities processed by ascending packed full-`Script` bytes and untyped capacity last. Every addition creates a new fully recomputed node.

While active state contains unresolved relevant change, stop at the first ceiling-respecting canonical or event exact-token root. Do not descend into cleanup or shape change until the creating transaction is canonically committed. Its committed-unindexed outputs continue to count as pending.

#### Service Quanta, Target, and Canonical Base

Each path supplies ordinary-payment service quanta to the same shaping engine:

- an event payment uses its current payment quantity and recipient capacity;
- an arbitrary order uses the largest positive contribution to each full asset identity among its `SinglePayment` items, while its capacity contribution is the largest total recipient capacity of one item; and
- cold storage uses a deployment-signed native payment amount at least as large as the largest supported native recipient occupied capacity and a positive payment quantity for each registered xUDT route. Its xUDT capacity contribution is that route's existing recipient-capacity bound.

The cold values describe useful future payment inventory, not the cold transfer amount. They add one agreement-critical profile because a cold sweep has no payment request from which to derive a useful denomination. Configured lane counts remain forbidden.

One useful lane has one typed output for every touched xUDT identity, each carrying at least that identity's service quantum, plus one untyped output that funds the path's capacity contribution, one future hot untyped output floor, and the exact fee of the one-lane template.

Let `S` be the packed Molecule `Transaction` byte length with every input-aligned witness placeholder, excluding `serializedSizeInBlock`'s outer four-byte containing-vector offset. For a native-only path, let `B` be `S` for the signed-off representative native event-payment template with two untyped inputs and one useful untyped lane. For a path touching xUDT, let `B` be the largest corresponding signed-off one-type xUDT event-payment template among the touched routes, each with one typed input, one untyped input, and one typed-plus-untyped lane. Arbitrary recipient count and cold-transfer size therefore do not enlarge the cleanup allowance.

For the current path's output shell, let `b` be the increase in `S` from appending one complete useful lane and let `b0` be the increase from appending one untyped output for a native-only path or one exact-floor typed output for every touched xUDT identity otherwise. The target is `T = max(1, floor((b0 + B) / b))`. The checked single-payment profile yields five native outputs or three typed-plus-untyped xUDT pairs. Multi-item paths include every touched typed identity in `b` and `b0`, so additional asset identities can only hold or reduce `T` rather than enlarging the event-sized `B` allowance.

A transaction's canonical base is formed by ordering only its declared inputs under the path's canonical base selector and taking the shortest prefix that satisfies the path demand and admits canonical minimal composition. The byte baseline is the complete packed placeholder `Transaction` for that prefix in final input order, including recipient or cold outputs, canonical minimal custody change, deps, and input-aligned witnesses, all measured in the `S` domain above. The shaped transaction may exceed that base by at most `B` bytes. Extra declared inputs and extra outputs both count toward the delta.

#### Inventory Ceiling Repair

Before shaping, the constructor counts confirmed cells and known approved-or-later pending outputs separately for the untyped identity and every xUDT identity touched by the path. Candidate and agreement-stage outputs remain speculative and do not count. Its local snapshot excludes confirmed cells consumed by approved-or-later transactions or under an unexpired local reservation, saturates each confirmed count at `T + 1`, then includes the qualifying pending custody outputs.

When a canonical plan's projected count for an identity, equal to its current count minus the plan's consumed confirmed cells of that identity plus its custody change outputs of that identity, would exceed `max(T, current count)`, consume matching confirmed cells by capacity ascending, then packed OutPoint, until the plan fits. This reproduces the benchmark repair order and is deterministic constructor policy, not an agreement rule. When an event comparator-order cover cannot be repaired, retry the same repair on its exact-token cover. Return no-fit when the path has no repairable root.

#### Cleanup and Output Shaping

After a root is repaired, restrict cleanup to the untyped identity and xUDT identities touched by the path. Filter each identity to unselected confirmed cells smaller than its fixed service quantum, then rank that dense filtered list by value ascending with packed OutPoint ties. Interleave equal ranks by ascending packed full-`Script` bytes for typed identities and untyped capacity last. This reproduces the benchmark order when one xUDT identity is touched.

Descend through every cumulative prefix of that fixed sequence. Add the next cell permanently and rebuild the complete node, including a new fee and, for cold storage, a new transfer amount and hot-balance projection. Retain the latest valid shaped node within the identity ceilings, `B` allowance, and shared transaction-size limit. An invalid prefix keeps the preceding valid plan but does not stop descent because a later added cell can restore a valid remainder; there is no branch that removes an earlier cleanup cell or backtracks into another subset. Agreement does not reproduce this constructor order.

At the repaired root and every cleanup prefix, derive maximum typed and untyped counts from `T`, the identity ceilings, and the available remainders. All positive typed remainder groups use one shared typed count. Search typed count descending, then untyped count descending, exactly as the checked one-type H1 does. For each pair, construct all exact outputs, compute the complete fee, compute any cold transfer from that fee, and accept the first plan satisfying conservation, floors, useful quanta, cold projection, the `B` allowance, and the shared transaction-size limit. Capacity is a fixed-width `Uint64` and each xUDT amount occupies the fixed 16-byte data field, so a count pair fixes the serialized output shape before those values are assigned. This finite search supplies the node plan without a fee/output fixed-point iteration. An xUDT path with zero typed remainder uses canonical minimal composition and does not shape untyped capacity alone.

Each typed xUDT output carries at least its identity's service quantum at exact occupied capacity. Each shaped untyped output funds the path's service capacity contribution, one future untyped hot-change floor, and the one-lane template fee. Within each typed or untyped output group, nearly equal means the largest and smallest values differ by at most one base unit: one token unit for typed outputs or one shannon for untyped outputs. Every positive typed remainder group has the selected shared typed count, that count and the untyped count are independently bounded by `T`, and all excess CKB remains untyped.

If shaping never improves a valid repaired root within these bounds, use that root.

### Cold-Storage and Arbitrary Selection

Aggregate requested or cold-transfer quantities by full asset identity, then process full xUDT type groups in ascending lexicographic packed full-`Script` byte order. For each type group, take the shortest xUDT-comparator prefix that covers that group's outgoing quantity. Union those inputs, then add the shortest native-comparator prefix for which the complete recipient or cold-output set and canonical minimal composition fit the CKB-capacity ledger. This is the path's H1 root; ceiling repair, unresolved fallback, cleanup descent, and shaping then follow the shared tree above.

### Final Input Order

After the selected set is fixed, the transaction's input order is fully determined: first every typed input, grouped by full type identity in ascending lexicographic packed-`Script` byte order and ordered inside each group by the xUDT comparator; then every untyped input ordered by the native comparator. Independent verification reproduces this order from the re-resolved input set and rejects any other arrangement, so proposer ordering carries no information.

### Proposal Verification

Selection and the payment/arbitrary depth-preferred pass are constructor-only, while the cold-reachable predicate, comparators, final input order, and output policy are shared and verified. Indexer timing and the in-window-candidate, active, and local-pool exclusions are intentionally local, so another Guard never reproduces the proposer's exact candidate set. After common exact input re-resolution, proposal and approval verification asks whether the declared set is a legitimate H1 result:

- every declared input carries the exact configured Rosen hot custody lock, is currently live, and is locally nonconflicting; deep payment and arbitrary inputs need no parent-provenance check, their shallow inputs require the Guard-produced-parent predicate, and cold inputs satisfy either configured depth or that same predicate;
- each typed group and the untyped group follow their comparator and the final typed-groups-then-untyped input order;
- every automatic path contains one shared typed output count no greater than `T` across its positive typed remainder groups and no more than `T` untyped custody outputs, every multi-output group is nearly equal and useful for the path's agreement-visible service quantum, and the complete packed Molecule transaction exceeds the canonical base derived from its declared inputs by at most `B` bytes;
- cold transactions also satisfy the cold-reachable input predicate, declared-transfer bounds, and the verifier's projected hot-balance safety check.

H1 output and byte verification is closed-set. It derives payment and arbitrary quanta from the order, cold quanta from shared configuration, and the cold H1 demand from the declared cold outputs. It does not reproduce the proposer's cover, event exact-token fallback, ceiling repair, cleanup order, unresolved-change view, or omitted-cell view. The identity ceiling and unresolved fallback are constructor policy because each Guard's pending and indexer state is local. Cold and arbitrary verification therefore does not require input irreducibility.

Cold hot-balance verification remains a separate local safety predicate. It applies the positive declared transfer once to the verifier's own pre-transaction cold projection. A native sweep must not exceed `maxNativeTransfer` and must leave the native projection at or above native `low`. A token sweep must not exceed that route's `maxTokenTransfer`, must leave the triggered token at or above its `low`, must leave native hot capacity at or above native `low`, and must not transfer another token. Local candidates, active transactions, and pool spends can therefore make one Guard reject a cold proposal that another Guard accepts; threshold approval decides that difference just as it decides locally known input conflicts. A verifier does not require the proposer to have chosen the maximum transfer visible in the verifier's different local view.

A verifier may reject a declared input it locally knows to be spent or conflicting, but it must never reject a proposal merely for omitting a cell it alone can see.

Payment and arbitrary verification does not reject committed Guard-produced input merely for being shallower than the verifier's preference. Cold verification enforces the shared cold-reachable predicate and projection.

Different Guards can legitimately propose different eligible covers for the same request. `agreementId` selects one exact set of bytes, and threshold approval decides among them. Manual signing validates its exact caller-supplied inputs and supported transaction shape under the committed-input floor, without any selection rule.

### Decision Evidence and Ownership

The [custody-flow benchmark](./benchmarks/custody-flow/results/README.md) provides the decision evidence for eager rather than triggered or absent cleanup on single-payment workloads. It preserves the no-cleanup variant's served totals while recovering 6,062 of the 7,094 states in the equal-remainder-constructible denominator instead of 2,049. The benchmark does not cover arbitrary orders or cold storage. Applying the same recursive rule to those paths is the production simplification: it avoids path-specific change behavior and lets every automatic transaction repair inventory, at the accepted cost of configured cold service quanta and replacing their narrower irreducibility check with the agreement-visible H1 and local cold-safety bounds above. On a multi-xUDT order, the smallest positive typed remainder can reduce the shared typed lane count for every touched identity; this bounded coupling is accepted instead of adding a per-identity output-count search.

Deployment still provisions the initial shared-untyped and per-xUDT typed inventories; H1 cannot create capacity or token quantity from an exhausted pool.

The [transaction fee handling section](#transaction-fee-handling) owns the cold-storage accounting contract. This section owns the shared constructor and verifier mechanics. The [decision register](./decisions-and-open-questions.md#accepted-decisions) records decision status and rationale without defining another operative rule.

## CKB Technical Parameters

- **Block time:** About 9.3 seconds recently (variable, difficulty-adjusted).
- **Transaction proposal window:** Commitment is allowed 2-10 blocks after proposal; proposal inclusion time is additional.
- **Confirmation policy:** Initial Guard CKB settings are 150 blocks; Watcher keeps its existing global commitment gate.
- **Address format:** [CKB Address Format (RFC 0021)](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0021-ckb-address-format/0021-ckb-address-format.md), Bech32m with the `ckb` mainnet prefix.
- **Key derivation:** Proposed Rosen four-level non-hardened indices `[44, 309, 0, 0]`; the final array and chain code are deployment inputs.
- **Native token:** CKB (1 CKB = 10^8 shannons).
- **Cell capacity:** 1 CKB per byte of on-chain storage.
- **Basic cell:** 61 CKB.
- **Plain xUDT cell:** 142 CKB with 32-byte owner args and 16-byte amount data.
- **iCKB cell:** 146 CKB with 32-byte owner hash, 4-byte flags, and 16-byte amount data.
- **Rosen metadata:** Unversioned envelope at `witnesses[inputs.length]`, selecting one deposit output and one source input.
- **Full node resources:** Deployment benchmark unresolved; full-node and Guard-indexer sizing depends on retention settings and bridge query load.

### Derivation Parameters

Rosen's pinned TSS library derives from the shared public key and rejects hardened child indices. CKB therefore follows Rosen's existing four-level, non-hardened configuration shape with `[44, 309, 0, 0]`; this is BIP-44-shaped namespacing, not a standards-compliant hardened BIP-44 wallet path. `309` is CKB's registered [SLIP-44](https://github.com/satoshilabs/slips/blob/308f4c50275d1c553de7ec3b75e028c1a83e5e0c/slip-0044.md) coin type. The concrete `tssChainCode` string and final derivation array remain deployment handoff values supplied before the lock args and address are fixed.

### Confirmation Policy

Use 150 blocks as the initial mainnet value for Guard's CKB observation, payment, cold-storage, manual, and arbitrary confirmation settings, approximately 23 minutes at recent block times of about 9.3 seconds.

Scanner follows the live tip, and the observation extractor stores valid requests immediately. Watcher applies its existing global `observation.confirmation` setting before commitment creation; CKB does not add a second Watcher-specific threshold.

Guard independently requires the source transaction to be canonically committed and at depth 150 before accepting the event. Event acceptance is the shared source-validation boundary. Later destination processing uses the stored event and does not re-decode the source before signing.

No cross-service equality rule or shared configuration package is added.

Confirmation depth is the bridge's reorganization protection. The sender signature, block witness commitment, source event ID, `witness_hash`, and block transaction position identify or authenticate bytes within the observed history; none prevents a replacement canonical chain from rewriting the complete block and request. If the selected depth is insufficient, the integration has no metadata-based fallback and makes no automatic rollback promise after Guard acceptance or completed payment.

The [RGB++ security analysis](https://github.com/utxostack/RGBPlusPlus-design/blob/c0b065c8bb8cc0a1813d27e9352ff694e1975ca3/docs/security-analysis-en.md) relates 24 CKB confirmations to 6 Bitcoin confirmations only under its stated adversarial-hash-rate and orphan-rate assumptions. Miner-address concentration is not proof of common control, while a true majority-hash operator or cartel is not mitigated by additional confirmations. Before launch, use current block-production evidence to retain 150 or record a replacement policy; implementation keeps the value configurable.

## Implementation Plan

### Repository Boundaries

The module map points to the work item that owns each implementation surface. Execution order and dependencies live in the work breakdown's [Work Sequence](./implementation/README.md#work-sequence).

Existing Rosen UTXO integrations are the default implementation precedent: reuse their package boundaries, Kodegen structure, abstractions, configuration, selection, service wiring, health, fee, SDK, UI, and test patterns wherever they fit.

Package versions and changesets follow the contribution rule in [AGENTS.md](./AGENTS.md#contribution), which owns that contract for every work item.

CKB uses two library boundaries. Custody, ingestion, and Minimum Fee Job template calculation use the bounded Rosen-owned `@rosen-bridge/ckb-primitives` TypeScript package. Node-facing services use Rosen-owned local-node JSON-RPC adapters, while Health Check consumes library-neutral Guard and Scanner results.

SDK and UI use CCC conventionally for wallet and sender transaction work. Shared APIs carry plain structures, bytes, strings, and `bigint`, never CCC classes. The [library review](./ccc-dependency-review.md) records the measured main-entry dependency and runtime surface that keeps CCC out of custody.

Keep code-facing class names as `Ckb...`, but use lowercase `ckb` for the cross-repo chain id, config key, and native-token id.

Each work item starts by selecting and pinning its target repository revision, then records only implementation evidence produced or verified against that revision.

Runtime and clean-package consumption policy is owned by [AGENTS.md](./AGENTS.md#runtime).

### Module Map

- **Shared primitives, address codec, and deposit extraction:** [01. Shared Utils codec and extractor](./implementation/01-shared-utils-codec-and-extractor.md)
- **Scanner, observation extractor, and Watcher wiring:** [02. Watcher ingest path](./implementation/02-watcher-ingest-path.md)
- **Guard chain, RPC, construction, signing, and validation:** [03. Guard chain and RPC integration](./implementation/03-guard-chain-and-rpc-integration.md)
- **Representative fee publication:** [04. Minimum Fee support](./implementation/04-minimum-fee-support.md)
- **Node, indexer, scanner, and asset health:** [05. Health Check support](./implementation/05-health-check-support.md)
- **CKB SDK package and wallet transaction construction:** [06. SDK integration](./implementation/06-sdk-integration.md)
- **UI and Rosen Service wiring:** [07. UI and Rosen Service integration](./implementation/07-ui-and-rosen-service-integration.md)
- **Script identities, routes, operating values, and deployment evidence:** [08. Contract deployment handoff](./implementation/08-contract-deployment-handoff.md)
- **Repository closeout and tracker synchronization:** [09. Closeout and tracker sync](./implementation/09-closeout-and-tracker-sync.md)

## License

This repository is available under the [MIT License](./LICENSE), with Sonami as the 2026 copyright holder.

## References

- [Grant Proposal (DIS)](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756)
- [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003)
- [Rosen issue guidance for the CKB integration](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-4926455588)
- [Rosen Contribution Standards](https://github.com/rosen-bridge/rcs)
- [Rosen Sign Protocols](https://github.com/rosen-bridge/sign-protocols)
- [tss-api (Go MPC binary)](https://github.com/rosen-bridge/sign-protocols/tree/f278d8132549dee1a64746e2d64d9d30c0b3bac7/services/tss-api)
- [BNB tss-lib](https://github.com/bnb-chain/tss-lib)
- [CCC SDK](https://github.com/ckb-devrel/ccc)
- [Official CKB public JSON-RPC node list](https://github.com/nervosnetwork/ckb/wiki/Public-JSON-RPC-nodes)
- [CKB Address Format (RFC 0021)](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0021-ckb-address-format/0021-ckb-address-format.md)
- [xUDT Standard (RFC 0052)](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0052-extensible-udt/0052-extensible-udt.md)
- [xUDT Implementation (xudt_rce.c)](https://github.com/nervosnetwork/ckb-production-scripts/blob/26b0b4f15bb6eeb268b70d7ae006e244b7c06649/c/xudt_rce.c)
- [sUDT Standard (RFC 0025)](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0025-simple-udt/0025-simple-udt.md)
- [secp256k1-blake160-sighash-all (default lock)](https://github.com/nervosnetwork/ckb-system-scripts/blob/f25c5ae8824c4907ad94326a0113a03defab9bfc/c/secp256k1_blake160_sighash_all.c)
- [Anyone-Can-Pay Lock (RFC 0026)](https://github.com/nervosnetwork/rfcs/blob/4b502ffcb02fc7019e0dd4b5f866b5f09819cfbe/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md)
- [Single-Use Lock](https://github.com/ckb-devrel/ckb-proxy-locks/tree/38b7e1df19828f2203c01b30340be26691b70d7a/contracts/single-use-lock)
- [RGB++ Security Analysis](https://github.com/utxostack/RGBPlusPlus-design/blob/c0b065c8bb8cc0a1813d27e9352ff694e1975ca3/docs/security-analysis-en.md)
- [Ergo guard set and signing evidence](./guard-signing/multisig.md)
- [Guard rotation: TSS](./guard-signing/tss.md)
- [Signing approach comparison](./guard-signing/)
