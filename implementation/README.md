# CKB Work Breakdown

This directory breaks the integration contract into dependency-aware delivery units. Each file names its outcome, repositories, dependencies, owned requirements, completion evidence, and verification commands. The integration [README](../README.md) owns the technical contract, the [decision register](../decisions-and-open-questions.md) owns status, and [AGENTS.md](../AGENTS.md) owns contribution rules.

## Cross-Cutting Rules

- Reuse the [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003) and existing Rosen UTXO integration patterns where they fit. Custody, ingestion, and Minimum Fee Job template calculation use bounded Rosen-owned TypeScript primitives; node-facing services use local-node JSON-RPC. Health Check consumes library-neutral Guard and Scanner results. CCC, the CKB ecosystem JavaScript SDK, remains an SDK/UI dependency and exact development-only differential reference. Keep shared package APIs library-neutral and CKB capacity separate from extensible user-defined token (xUDT) quantity.
- The extractor's `SUPPORTED_CHAINS` owns the destination wire byte. Guard runtime ordering must not depend on that position.
- The first mainnet CKB integration release (v1) is mainnet-only. CKB addresses use mainnet encoding and reject `ckt`; zero-value integration testing uses a mainnet testbed.
- The integration [README](../README.md#custody-concurrency-and-transaction-chaining) owns bounded input selection, the comparators and canonical input/output orders, the recursive eager-cleanup order-quantum policy (H1) for every automatic path, proposal verification, wire/in-memory full-wrapper agreement identity, and raw-`txId` permanent-outcome suppression. Work items consume that contract instead of restating it.

## Work Sequence

Work items 02, 03, and 06 may proceed in parallel after 01. Work item 05's Guard health surfaces may proceed when Guard balance and node/indexer interfaces are stable. Closeout is dependency-aware: an incomplete branch does not prevent independent graph branches from being verified and recorded.

| Work item | Repositories | Depends on |
| --- | --- | --- |
| [01. Shared Utils codec and extractor](./01-shared-utils-codec-and-extractor.md) | Utils, integration | None |
| [02. Watcher ingest path](./02-watcher-ingest-path.md) | Scanner, Utils, Watcher, integration | 01 |
| [03. Guard chain and RPC integration](./03-guard-chain-and-rpc-integration.md) | Utils, Guard, integration | 01; deployment values at activation |
| [04. Minimum Fee support](./04-minimum-fee-support.md) | Minimum Fee Job, integration | 01; 03 template contract |
| [05. Health Check support](./05-health-check-support.md) | Health Check, Guard, integration | 03; 02 for Scanner sync |
| [06. SDK integration](./06-sdk-integration.md) | Rosen SDK, integration | 01 |
| [07. UI and Rosen Service integration](./07-ui-and-rosen-service-integration.md) | UI, integration | 02, 04, 06 |
| [08. Contract deployment handoff](./08-contract-deployment-handoff.md) | Integration | Starts now; finalizes after 01-07 |
| [09. Closeout and tracker sync](./09-closeout-and-tracker-sync.md) | All owned repositories | 01-08 as applicable |

Work item 04 specifically depends on work item 03's representative selected-policy template contract. Work item 08 starts alongside implementation and finalizes after work items 01-07.
