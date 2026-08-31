# 08. Contract Deployment Handoff

## Outcome

Maintain one evidence-backed handoff artifact that gives Rosen the exact mainnet contract, token, script, dependency, and configuration inputs needed after implementation.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md). Start this living handoff alongside implementation and finalize it only after work items 01-07 have code-backed outcomes.
- Target repository: `..` only.
- The [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003) assigns Rosen the contract integration listed in its Contracts section, including new-chain tokens on Ergo and bridge-token minting on other supporting chains. This proposal assigns token-map publication and final route approval to Rosen and supplies the CKB mint mechanism and compatibility evidence.

## Requirements

### Artifact and Script Identities

- Create and maintain `../deployment-handoff.md`. Its authoritative table has exactly these columns: `Item`, `Owner`, `Status`, `Value`, `Evidence`, and `Blocker / next action`. Every row uses one status: `requested`, `provided`, `code-backed`, `unresolved`, or `executed`. Do not scatter authoritative handoff state across multiple files.
- Record RCS-003's Rosen-owned Ergo Rosen Watcher Token (RWT) and Authorized Watcher Collateral NFT (AWC) setup and bridge-token minting separately from token-map publication, route approval, and related configuration inputs.
- Record bridged extensible user-defined token (xUDT) issuance as a maximum mint through the existing single-use lock followed by destruction of authority. Rosen or its delegated executor performs the deployment.
- Record the canonical default lock exactly as `codeHash = 0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8`, `hashType = type`, dep group `0x71a7ba8fc96349fea0ed3a5c47992e3b4084b031a42264a018e0072e8172e46c:0`, plus deployment-pinned `codeHash`, `hashType`, and dep identities for canonical mainnet xUDT and single-use lock. Node-facing construction consumes dep OutPoints; Utils receives registered script identities and performs no production discovery through CCC, the CKB ecosystem JavaScript SDK.

### Runtime and Deployment Inputs

- Record `tssChainCode`, the proposed non-hardened `[44, 309, 0, 0]` array, resulting threshold signature scheme (TSS) public key, hot and cold scripts and addresses, token map, chain identifiers, final confirmation settings, fee guardrails, representative payment templates, positive native and per-xUDT cold service quantities for the eager-cleanup order-quantum policy (H1), and service configuration. Require distinct complete hot and cold lock scripts.
- Derive the actual `M_hot`, `M_cold`, and `F_max` values. Validate and record the README's four native cold bounds plus a positive, size-tested `maxTokenTransfer` for every registered xUDT route.
- Record the Guard release containing CKB's wire/in-memory complete-wrapper `agreementId` binding, unchanged raw-`txId` transaction schema, permanent-outcome invalid-row suppression, and shared status-guarded signing completion. Also record Rosen's supplied membership, approval threshold, `parallelSign`, signing timeout, and expected competing ECDSA load.
- Record the local CKB node release and configuration for each Guard, Watcher, and Minimum Fee Job deployment, including one shared `tx_pool_info.tx_size_limit`. Pin Guard to the built-in standard indexer rather than rich-indexer, and retain evidence for the exact lock/type/data filters on that release.
- Record the UI's default public mainnet RPC/indexer endpoint pool as a mutable deployment value, with its configuration owner, exact source revision, and implementation-time reachability evidence. Do not make a community hostname part of the integration contract or a production-service dependency.
- Record the complete identity-read latency and resource budget, queue behavior, indexer-lag behavior, startup seed, and manual-provisioning owners. The [custody-flow benchmark](../benchmarks/custody-flow/) proposes one global untyped CKB-capacity seed and one typed quantity seed per registered xUDT; it does not duplicate untyped cells per asset.
- Use the signed-off fee rate, cycle-weight bytes, transaction-size limit, structural shape, and custody-lock shape in the lifecycle transaction profile. Increase the seed and rerun the complete workload until it records no inventory no-fit.
- From that zero-no-fit run, record unavailable selected cells `P_r(t)`, net cell-count erosion `E_r(t)`, explicit headroom `H_r`, and a proposed seed satisfying `N_r >= max_t(P_r(t) + E_r(t)) + H_r` over the named workload and replenishment horizon. A run with any inventory no-fit cannot supply the maximum term. Record cell count, CKB capacity, and each xUDT quantity separately.
- Run successful complete paginated identity reads within the configured `maxIdentityCells` budget. Exercise budget exhaustion, locally persisted shallow-change provenance for payment and arbitrary construction, the chain-proven cold-reachable set, and common exclusion rules.
- For the eager-cleanup order-quantum policy (H1), record the targets, request-derived event/arbitrary quanta, configured cold quanta, exact packed-Molecule byte vectors, mandatory native and per-route one-type event templates, event-template `B` caps, cycle and reservation cost, degraded native and xUDT recovery, and divergent proposer inventory and pending views under agreement-visible H1 checks. The [benchmark results](../benchmarks/custody-flow/results/README.md#selection-rationale) own the current comparison evidence. Include a multi-xUDT case where one small positive remainder limits the shared typed count. Record every cleanup-prefix outcome and prove the retained latest valid plan remains within the transaction-size limit; an invalid intermediate prefix is expected to continue when a later prefix can restore a valid remainder. For native and every token route, exercise fragmentation at `maxIdentityCells` and prove its capped cold transfer fits the shared transaction-size limit or lower the cap before signoff.
- Cover proposer and agreement timing, the deployed global ECDSA round limit and timeout, competing non-CKB ECDSA work, transaction processing, commitment and indexer delay, retries, multi-input payout merges, exact covers, deposits, and cold-storage effects.
- Apply this pre-deployment proposal in the handoff; do not defer initial sizing to production. Startup seeds and cold service quanta are deployment values, while H1's path-shape-derived targets and shared recursive construction are contract rules.
- Record a source-backed or measured full-node and Guard-indexer resource profile. When that evidence requires out-of-scope testbed work, leave the [node and indexer resource input](../decisions-and-open-questions.md#release-fees-wallets-and-resources) unresolved and name its owner.

### Fee, Node, and TSS Evidence

- Record the fee and cycle evidence for the selected deployment. Every size and node-limit check uses the README's `serializedSizeInBlock`, and the shared transaction-size limit equals every Guard node's `tx_pool_info.tx_size_limit`.
- Record that the Guard application cycle ceiling fits the node's consensus and policy limits, the representative payment template fits below that ceiling, Guard enforces the README's [terminal handling](../README.md#custody-concurrency-and-transaction-chaining), and Minimum Fee Job prices routes from measured representative values instead of the Guard ceiling.
- Validate configured values against node policy and consensus bounds at startup. Do not add a startup fixture transaction that depends on live cells.
- Record the application cycle ceiling as a revisable operational value with its owner and each recorded change. A changed ceiling applies to newly constructed transactions and does not reactivate a retained invalid raw-`txId` row. Record valid-signature cycle-variation measurements for the selected lock and node release, keep the ceiling away from the observed boundary, and require a quiesced coordinated rollout before every Guard resumes CKB construction and signing; record no per-transaction suppression state in the handoff.
- Verify the cellbase maturity rule and every `-302` `Display` needle in the README's terminal classifier against the exact node release chosen for deployment. Those needles were checked only against the [pinned research revision](https://github.com/nervosnetwork/ckb/tree/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987), so the deployment release remains unverified until those checks are repeated; changed text requires an explicit contract revision before rollout.
- Record the approved `tss-api` version, source commit, artifact SHA-256, and provenance. Keep CKB unresolved until a known 32-byte CKB SighashAll digest sent through that artifact produces a recoverable signature over those bytes for the configured compressed public key. Any approved artifact change reruns this evidence.
- Record that CKB uses Rosen's existing private TSS key lifecycle described in the [signer analysis](../guard-signing/tss.md). Retain only the deployment values and operational owner needed by the integration; do not require publication or reimplementation of Rosen's ceremony or rotation procedure.

### Wallet, Capacity, and Token Evidence

- Record enabled wallet rows separately from event validity, keyed by provider identity/version, CCC version, full input-lock script, deployment deps, unlock mode, and any type script at `outputs[inputs.length]`. Retain the README-required transaction comparison, deployed-lock, witness-compatibility, and mutation evidence for each row. Unqualified rows remain disabled.
- For each enabled destination or token route, record the evaluated capacity bound, the lock/type/data lengths used, supported and excluded destination forms, and evidence against the README's capacity and payout-accounting contract. Record the distinct configured hot and cold scripts plus implementation evidence for their inequality, the payout exclusion, and cold-storage exemption; do not restate those rules in the handoff.
- Record whether manual signing is enabled. When enabled, retain its authentication, caller-threshold configuration, and implementation evidence against the README's exact-input contract.
- For each proposed ecosystem xUDT, record its full type script and hash, deployment references, decimals, exact 16-byte amount shape, zero-extension evidence, issuer and bearer-economics review, transfer fixtures, Rosen registration status, token-map route, and Guard's exact per-type conservation evidence, including an owner-mode-activated fixture.
- Label absent deployment values and unchecked references as unresolved. Never promote requested or provided data to code-backed or executed without evidence.

## Done When

- `../deployment-handoff.md` uses the required six-column schema, distinguishes all five evidence/execution states, and contains no unsupported values.
- Evaluated route values and enabled wallet rows point to their owning contract and retain exact implementation or deployment evidence without copying protocol rules into the handoff.
- Rosen-owned contract/registry work, explicitly delegated CKB execution, exact identities, dep OutPoints, token map, token-registration evidence, wallet compatibility, and unresolved inputs are actionable and explicit.
- The handoff records the `tss-api` identity, provenance, and direct-digest vector.
- The handoff records the global untyped and per-xUDT typed committed-cell seeds, CKB capacity, token quantities, lifecycle traces, headroom, and workload evidence showing that committed-only construction sustains the measured signing demand.
- Finalization reflects work items 01-07 while preserving historical requested/provided distinctions.

## Verification

- Re-read tracked implementation with `git -C <repo> grep -n` and pin each code-backed claim to repository, commit, and file.
- Use tracker `git grep` to find conflicting capacity, Anyone Can Pay (ACP), token-control, script-identity, metadata, and execution claims.
- Verify every relative repository/file reference resolves and every retained number has code, authoritative reference, or unresolved status.
