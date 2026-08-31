# 04. Minimum Fee Support

## Outcome

Calculate and publish the CKB route minimum from one representative complete Guard payment transaction and, for extensible user-defined token (xUDT) targets, one conservative recipient-cell capacity subsidy.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md). Begin after [work item 01](./01-shared-utils-codec-and-extractor.md) provides the packed primitives and [work item 03](./03-guard-chain-and-rpc-integration.md) exposes representative selected-policy transaction bytes plus a stable Guard fee and recipient-capacity contract.
- Owned repositories: [Minimum Fee Job](https://github.com/rosen-bridge/minimum-fee-job) and this integration tracker. Treat [Guard Service](https://github.com/rosen-bridge/guard-service) as the read-only dependency contract for this work item.
- This work item owns route minimum-fee calculation only. Health monitoring belongs to [work item 05](./05-health-check-support.md).

## Requirements

### Fee Model

- Preserve the existing `networkFee` field and fee lookup identity `(Ergo-side token ID, fromChain, fromChainHeight, toChain)`. Do not add a `stateRent` field or a parallel CKB fee state.
- Do not claim the job knows a future transaction's exact live-cell selection, serialized size, or recipient lock. Use configured representative native and xUDT input/dependency/witness/output templates from the selected construction policy; do not freeze one observed change count into route pricing. The template estimates the route minimum and is not a Guard construction ceiling. Resolve the route's registered CKB full type script and output-data shape, then apply the [README recipient-capacity bound](../README.md#occupied-capacity). Review the payment template when representative Guard construction changes.
- Consume packed `@rosen-bridge/ckb-primitives` APIs for the template's Molecule serialization and `serializedSizeInBlock`, full script identity, and occupied-capacity calculation. Do not add CCC (the CKB ecosystem JavaScript SDK) or local copies of those mechanics.
- Apply the [README fee formula](../README.md#transaction-fee-handling) to the configured template rather than restating it. This job's inputs are the template's Molecule size and a representative cycle budget `templateCycles`. Its output is the representative fee that feeds the existing price and update safety policy.
- Keep `templateCycles` no higher than Guard's shared application cycle ceiling, but do not claim it is the ceiling unless operators configure the same value. When the job's local node minimum exceeds the shared target, fail closed instead of publishing a node-local fee formula that Guards would disagree on. Work item 05 surfaces Guard-node policy health only.
- For an xUDT target, compute required CKB as the representative payment fee plus that README bound for the route's registered token. Guard funds the recipient cell at the same charged bound, so capacity above the actual occupied requirement stays with the recipient.
- For a native CKB target, publish the representative payment fee without adding occupied capacity again: the transferred CKB is the output capacity. This job adds no client floor and no configurable value.
- Convert required CKB into the bridged source token through the job's existing price and safety-margin model.
- Keep native CKB and xUDT route calculations distinct because only xUDT requires a CKB capacity subsidy in addition to the transferred asset.
- Price one representative complete payment transaction. Do not multiply fees or capacity for event installments because Guard does not support them.
- Guard may construct a transaction heavier than the representative template while still enforcing the shared transaction-size limit and its application cycle ceiling. Rosen custody absorbs any positive difference between Guard's ceiling-derived fee bound and the published estimate.
- Deployment signoff must explicitly accept the resulting cycle-headroom subsidy. When cycles dominate size, a loose ceiling systematically pays more than representative measured cycles, while a tight ceiling causes more rounds to fail after signing. Record that acceptance with the guardrail values in the [deployment handoff](./08-contract-deployment-handoff.md).

### Publication and Node Inputs

- Publish through the existing workflow: calculate the proposal, generate the unsigned route update, and leave activation to authorized signing and submission. Guards poll the active on-chain config. The Guard/event path, not Minimum Fee Job, applies `max(minimumFee, userFee)` to a bridge request.
- Read CKB height, recent fee-rate statistics, and `tx_pool_info.min_fee_rate` from the job operator's own local CKB node under the register's [Node ownership decision](../decisions-and-open-questions.md#accepted-decisions); do not substitute a public endpoint. Use them to validate the shared deployment policy and update inputs, not to create a per-node Guard fee rule. Do not duplicate cell selection or transaction construction in this job.
- Correct tracker fee claims when code-backed values or formulas differ from the current design record.

## Done When

- The existing fee record shape and key remain unchanged.
- Tests use native and xUDT output lock/type/data fixtures, the 61/142/146 canonical-lock examples, the 67/148/152 maximum-recipient examples, the template size and representative cycle inputs to the README fee formula, the Guard application ceiling relationship, admission/recommended rates, transaction fee, price conversion, update policy, user minimum, and local height.
- Tests prove the published estimate is derived from configured template values, so a changed construction shape or destination-lock bound cannot silently retain a stale estimate.
- Tests consume the packed primitive package for template bytes, size, script identity, and capacity, including a clean production dependency graph with no CCC.
- Tests prove native pricing excludes a duplicate capacity charge, xUDT pricing covers the configured capacity bound, and the published value feeds the existing Guard/event `max(minimumFee, userFee)` contract without reimplementing that comparison in this job. A heavier actual Guard transaction does not change the event payment amount after construction; custody pays the positive fee difference.
- No health-check behavior or generic fee-field redesign is included.

## Verification

- Use tracked-source `git grep` in Minimum Fee Job and Guard to locate the existing key, `networkFee`, pricing/safety model, height provider, and Guard fee contract.
- Run repository-native lint, type-check, focused fee tests, and builds under the repository's declared Node version.
- Run clean package/API integration checks against the packed Utils primitives and Guard contract.
