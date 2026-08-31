# 05. Health Check Support

## Outcome

Add CKB funding, asset, scanner-sync, and local infrastructure health signals using the settled Guard and Scanner contracts.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md). Guard asset and local-infrastructure checks begin after [work item 03](./03-guard-chain-and-rpc-integration.md) stabilizes its CKB asset and RPC/indexer surfaces. Scanner-sync wiring begins only after [work item 02](./02-watcher-ingest-path.md) exposes Watcher's CKB signal. This work item may otherwise proceed in parallel with [work item 04](./04-minimum-fee-support.md).
- Owned repositories: [Health Check](https://github.com/rosen-bridge/health-check), [Guard Service](https://github.com/rosen-bridge/guard-service), and this integration tracker. Treat [Scanner](https://github.com/rosen-bridge/scanner) and [Watcher](https://github.com/rosen-bridge/watcher) as read-only dependency contracts for this work item.
- This work item owns operational health only and performs no route fee calculation.

## Requirements

- Monitor plain CKB funding balance separately from token balances, using Guard cold triggering's complete cold-reachable set and projected balance.
- Monitor each extensible user-defined token (xUDT) balance by full type script identity: `code_hash`, `hash_type`, and `args`, using that same result rather than rebuilding the set in Health Check.
- Consume library-neutral full-script and balance results from the packed Guard and Scanner contracts. Do not add CCC (the CKB ecosystem JavaScript SDK), a direct CKB codec, or local serialization/capacity mechanics to Health Check.
- Add Guard asset health using the settled CKB/native registration and configured thresholds.
- Register the CKB asset, Scanner sync, local-node, and Guard-indexer checks in Guard's existing health-check wiring.
- Surface Watcher's existing CKB Scanner synchronization signal through the existing `ScannerSyncHealthCheckParam` contract and configured thresholds. Do not calculate lag a second time here.
- Report the local CKB node and Guard's integrated-indexer reachability and freshness. Watcher has no indexer dependency. Do not substitute public endpoints.
- Surface Guard's existing construction-health signal when local node minimum-fee-rate or transaction-size policy is incompatible with shared settings. Do not reimplement that comparison in Health Check.
- When Guard cannot complete an identity read within `maxIdentityCells`, surface the repository-native unavailable-measurement status with the Guard diagnostic. Never publish a partial balance or rebuild the read in Health Check.
- Preserve repository-native health result, threshold, and alert conventions.
- Keep asset health balance-based. Do not duplicate Guard selection with cell-distribution, active-input age, protected-payout, or constructibility simulation.
- Do not calculate transaction fees, recipient capacity, prices, route minimums, or `networkFee`.
- Correct tracker health and operational dependency claims as code-backed behavior becomes available.

## Done When

- Plain CKB and xUDT balances are distinct and xUDTs cannot collide through code-hash-only matching.
- Guard asset, surfaced Scanner sync, local node, indexer, and surfaced construction health have focused healthy, stale, unreachable, threshold-failure, incompatible-policy, and identity-read-budget tests. An over-budget identity reports the repository-native unavailable-measurement status and no partial balance, with no second read, lag, or policy calculation in Health Check.
- No Minimum Fee Job ownership or fee calculation enters this work item.

## Verification

- Use tracked-source `git grep` across Health Check, Guard, and Scanner to prove asset registration, full type-script matching, tip comparison, and local service configuration.
- Run repository-native lint, type-check, focused health tests, and builds under each repository's declared Node version.
- Prove changed Guard/Scanner packages are consumed through a clean package flow.
