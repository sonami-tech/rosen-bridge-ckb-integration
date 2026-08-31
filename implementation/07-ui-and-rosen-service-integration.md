# 07. UI and Rosen Service Integration

## Outcome

Expose a CCC-based CKB deposit flow in the user interface (UI). CCC is the CKB ecosystem JavaScript software development kit (SDK). Add CKB Scanner/observation integration to `rosen-service2`, using normal outputs, extra-witness metadata, the shared destination codec, and the published route minimum.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md). Direct dependencies are [work item 02](./02-watcher-ingest-path.md), [work item 04](./04-minimum-fee-support.md), and [work item 06](./06-sdk-integration.md); the Guard transaction model from [work item 03](./03-guard-chain-and-rpc-integration.md) must also remain settled before end-to-end proof.
- Target repositories: [UI](https://github.com/rosen-bridge/ui) and this integration tracker.
- UI may use configurable public mainnet CCC defaults. Rosen Service operational scanning still uses the local-node policy from [work item 02](./02-watcher-ingest-path.md).

## Requirements

### Transaction Construction and Witnesses

- Implement the UI's `@rosen-network/ckb` CCC transaction surface for native CKB and eligible extensible user-defined token (xUDT) deposits as normal outputs to the configured Rosen lock.
- Build exactly one selected Rosen-lock output per request and retain its output index. Place the complete known envelope with fixed-size selector placeholders and required input-aligned witness padding before fee completion.
- After every input or output mutation, refresh both transaction-wide selectors and repeat fee completion until inputs, outputs, witnesses, and fee are stable. Select a final wallet-controlled source input, preferably from the asset-contributing lock group.
- Finalize the envelope at `witnesses[inputs.length]`, then hand the immutable transaction to the wallet without moving or truncating the suffix.
- Reject any sender script that reserves `witnesses[inputs.length]` for another schema. An enabled provider/lock path must leave Rosen's first extra-witness slot and complete suffix stable through signing.
- When `outputs[inputs.length]` exists, require its exact type script to ignore that group-output witness. The first-release plain xUDT profile with zero extension bits qualifies; any other type path needs a VM-backed qualification. Reorder outputs when that creates a compatible slot, otherwise reject the transaction shape.

### Wallet Qualification

- Maintain an explicit qualification matrix keyed by provider identity/version, CCC version, full input-lock script, deployment deps, and unlock mode. Default secp256k1 and native multisig commit the suffix. UTXO Global and Rei source paths preserve it for default-secp accounts, but installed extensions still require real-provider tests. OmniLock paths require provider and full-script tests. PW Lock requires the signed path and a live-binary VM test; its unsigned Anyone Can Pay (ACP) path is forbidden. The quantum-resistant lock script (QRL) is not enabled because pinned CCC has no signer.
- Keep JoyID CKB disabled until the current hosted provider returns the suffix unchanged, one-byte suffix mutation fails the exact deployed lock, and CCC resolves and records the complete live mainnet dependencies. Its official SDK and historical lock tests are positive evidence, not proof of the current closed deployment. CCC resolves Type-ID dependency descriptors to current live cells, so do not treat a stale configured fallback OutPoint alone as incompatibility.
- For each enabled matrix row, insert the complete envelope before the final input and fee pass, complete inputs and fees to a stable transaction, sign without broadcasting, and compare the returned transaction byte-for-byte. Permit only documented input-witness lock changes. Verify the original against the exact deployed lock, then require failure after changing or removing one envelope byte and after appending or reordering an extra witness. Requalify after any provider, CCC, lock, or dependency change. Do not turn this producer gate into Watcher or Guard input resolution.
- Split the qualification into a one-time check and a per-transaction check. Prove once that the exact deployed full lock and its dependencies make the signing digest commit the complete extra-witness suffix. Then, on every transaction, prove that the wallet returned the finalized inputs, outputs, output data, and envelope unchanged. Node script validation owns signature validity; do not add a lock-generic signature verifier to UI. One qualified default-secp provider satisfies the initial wallet surface; enabling more providers is a product-reach decision.
- Add a CCC wallet abstraction consistent with existing UI wallet boundaries; do not bind transaction construction to one wallet implementation. Convert between CCC entities and library-neutral Rosen script/address/amount values at this boundary; CCC remains absent from Watcher and Guard production graphs.
- Keep CCC wallet and transaction imports outside `apps/rosen-service2`. That service consumes only packed Scanner, extractor, and primitive surfaces; its clean production closure must exclude `@ckb-ccc/*` and the CCC-backed wallet transaction package even when the UI monorepo lockfile contains them.
- Consume [work item 08's](./08-contract-deployment-handoff.md) current public mainnet RPC/indexer endpoint pool only where UI requires defaults, and make every endpoint overridable by configuration. An operator-supplied endpoint disables CCC's built-in fallbacks (`fallbacks: []`); qualification records the effective endpoint pool so an override cannot silently retain or replay through community defaults.

### Address, Fee, and Service Integration

- Encode destinations with the shared codec, enforce the 60-byte limit, and reject `ckt`. The resulting 26-byte args maximum excludes the native multisig 28-byte `since` form and larger OmniLock configurations. Reject exact configured hot/cold custody scripts as user payout destinations. Do not reject other locks sharing a `codeHash`, and do not add an unrelated textual `fromAddress` length restriction.
- Consume [work item 04's](./04-minimum-fee-support.md) existing `networkFee` route value in calculator, minimum, validation, and warning UX. Do not introduce a second capacity or rent field.
- For CKB-source deposits, construct the exact Rosen output capacity. In target-CKB calculator flows, require at least 67 CKB after fees for native requests without adding that capacity to `networkFee` again. This protocol-derived worst-case floor intentionally rejects some smaller payments that Guard could construct for shorter locks. For xUDT, present [work item 04's](./04-minimum-fee-support.md) conservative capacity subsidy; Guard funds the payout output at that same charged bound, so the surplus stays with the recipient.
- Preserve full Rosen lock and xUDT script identities, standard `u128` xUDT data, native capacity semantics, and no ACP behavior.
- Wire the CKB Scanner and observation extractor into UI's `apps/rosen-service2`, including schema, defaults, generated types, startup registration, and local-node configuration.
- After changing `apps/rosen-service2/config/schema.json` in UI, run that app's `npm run gen-config-defaults` and `npm run gen-config-types` scripts and commit the generated outputs.
- Add the established UI registrations, wallet controls, asset calculator behavior, URLs, and visual assets needed for a usable CKB flow.
- Preserve UI's declared Node `22.18.0` runtime and correct implementation-backed tracker claims.

## Done When

- Native CKB and eligible xUDT transactions are constructed with CCC as one selected normal Rosen-lock output, one explicit wallet-controlled source input, and one unversioned envelope at `witnesses[inputs.length]`, with no fixed input-order or source-cell-shape restriction.
- Tests cover iterative fee stability, final input count, refreshed transaction-wide selectors, selected-input ownership by the connected wallet, extra-witness placement/preservation, output-side witness-index compatibility, selected output binding, the provider/lock qualification matrix and mutation failures, both asset shapes, the 67 CKB post-fee native floor, hot/cold destination rejection, xUDT capacity subsidy UX, full scripts/deployments, 60-byte boundaries and excluded lock fixtures, configurable endpoints, wallet abstraction, and route minimum UX.
- `rosen-service2` starts with generated CKB config and tracked Scanner/observer registration.
- A clean `rosen-service2` production install contains no CCC or wallet transaction package.
- The flow imposes no fixed input order, source-cell-shape, textual `fromAddress`, ACP lookup, output-data metadata, or duplicate fee-field requirement.

## Verification

- Use UI tracked-source `git grep` to prove CCC construction, both transaction-wide indices, source-input selection, final extra-witness insertion before signing, provider/lock gates, endpoint overrides, fee consumption, and `rosen-service2` registration.
- Run both config generation scripts after schema edits and inspect the resulting tracked diff.
- Run repository-native lint, type-check, focused transaction/signing/service tests, and builds under Node `22.18.0`.
- Prove clean consumption of Scanner and Utils packages by `rosen-service2`, including its CCC-free production graph, and clean SDK consumption only at the UI wallet boundary.
