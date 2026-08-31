# 02. Watcher Ingest Path

## Outcome

Feed live-tip CKB transactions from Scanner through a tracked observation extractor into Watcher version 1 using the shared extra-witness and selected-output contract, while preserving Watcher's existing global commitment-confirmation gate.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md), then complete [work item 01](./01-shared-utils-codec-and-extractor.md) first.
- Target repositories: [Scanner](https://github.com/rosen-bridge/scanner), [Utils](https://github.com/rosen-bridge/utils), [Watcher](https://github.com/rosen-bridge/watcher), and this integration tracker.

## Requirements

### Runtime and Package Wiring

- First resolve package, application programming interface (API), syntax, and build-output compatibility among Scanner and Utils at Node `22.18.0` and Watcher version 1 at Node `20.11.0`. This work item solely owns the exact final packed Utils/Scanner dependency lock and Watcher production-startup gate. Consume only the packed shared CKB primitives and extractors; the production dependency graph must contain no package from CCC, the CKB ecosystem JavaScript SDK. Test the exact final consumer lock through production startup without changing a repository runtime.
- Preserve Scanner's block JSON-RPC boundary using only `get_block_by_number`, `get_block`, and `get_tip_block_number`. CKB JSON-RPC integers are hex strings: request full transaction objects with verbosity `"0x2"` (or omit the optional argument when the selected node release defaults to full objects), never numeric `2`.
- Keep Scanner transaction inputs as OutPoints and preserve version, `cell_deps`, `header_deps`, outputs, `outputs_data`, and witnesses. Do not add input resolution to Scanner, the observation path, or either extractor.
- Create the `@rosen-bridge/ckb-scanner` and tracked `CkbRpcObservationExtractor` package slices under the contribution rule in [AGENTS.md](../AGENTS.md#contribution).
- Add the tracked `CkbRpcObservationExtractor` package through the Bridge Expansion Kit (RCS-003) Kodegen package flow, then test it against the shared `CkbRpcRosenExtractor`.
- Add Watcher version 1 package consumption, chain registration, configuration schema/defaults, scanner construction, observation-extractor wiring, the CKB scanner update job in `src/jobs/initScanner.ts`, and startup integration.
- Register CKB Scanner synchronization health through Watcher's existing health-check wiring and the existing `ScannerSyncHealthCheckParam` contract. Do not implement a second lag calculation.

### Extraction and Node Topology

- Scan the live tip and store valid observations immediately. Reuse Watcher's existing global `observation.confirmation` setting when selecting observations for commitment; do not hardcode 150 in Scanner or the observation extractor and do not add a CKB-specific Watcher threshold.
- Emit at most one observation event per transaction from the encoded selected output and source input. Preserve exact extra-witness placement, full-script matching, native-capacity amounts, extensible user-defined token (xUDT) output-data amounts, and selected consumed-OutPoint `box:<previous_tx_hash>.<previous_output_index_decimal>` formatting.
- Configure Watcher to use a local CKB full node through Chain RPC only. Add no indexer, Light Client, remote quorum, or dual-provider mode. A complete inventory of public endpoints is not a code blocker.

### Rollback and Scanner Contract

- Land the reviewed rollback ownership split. Watcher owns migrations that cascade the observation-status sidecar and set the independently meaningful transaction reference to null; its queue invalidates orphaned commitment/trigger rows.
- Scanner invokes extractor rollback before atomically rewinding pointers and deleting forked blocks, so extractor failure remains retryable. Preserve transaction records, and do not cascade them or claim rollback after Guard acceptance or completed payment. Audit already-persisted databases separately because the migration cannot repair observations stranded by an earlier failed rollback.
- Satisfy the current `@rosen-bridge/abstract-scanner` contract. `ScannerConfig` and the `GeneralScanner` constructor now require `blockCleanupConfig`, so `CkbRpcScanner` must thread the block-cleanup threshold duration and per-round trim count through rather than inheriting `AbstractScanner`'s 24-hour/100-block fallback by accident.
- Under that same contract, `CkbRpcObservationExtractor` implements `createUsedBlocksQuery()` returning an array of query builders. `AbstractScanner.extractors` is now protected, so no CKB code may reach into it. The scanner deletes old unused blocks every round, bounding pre-commit rollback depth by that retention window.
- Make all implementation-backed tracker corrections in this work item; do not defer known stale RPC, confirmation, or extraction claims.

## Done When

- The Scanner package slices comply with [AGENTS.md](../AGENTS.md#contribution).
- Clean package consumption works across the Node `22.18.0` producer repositories and Node `20.11.0` Watcher.
- A tracked observation extractor stores the encoded token-map-supported event at the live tip, and Watcher commitment eligibility respects the existing global confirmation setting.
- New-package structure, version, and changeset evidence satisfy RCS-003; no changelog is edited directly.
- Tests prove the allowed block RPC methods and hex verbosity, zero input-resolution calls, OutPoint-only Scanner inputs, preserved transaction fields, exact `inputs.length` witness placement, both index decodings, selected-input `fromAddress`, full selected-output scripts, both amount rules, and one-event selection.
- A Watcher-integrated rollback test covers observations with status/transaction references and proves deterministic invalidation without stale commitment eligibility or foreign-key failure.
- Envelope tests cover missing and trailing data, each index out of range, malformed selected input OutPoints, multiple bridge-looking outputs with one selected output, and no event from an unsupported selected output even when another output is supported.

## Verification

- In each selected target checkout, record the exact base revision and use `git grep -n "initialize the package" -- .changeset` to verify required package-initialization changesets.
- Use `git -C <repo> grep -n` in Scanner, Utils, and Watcher to prove RPC methods, live-tip observation storage, the existing global commitment gate, extractor registration, and config wiring from tracked source.
- Run repository-native lint, type-check, tests, and builds in every changed repository under its declared Node version.
- Perform a clean package install/pack flow into Watcher and run the focused integration test without an ad hoc dependency overlay.
