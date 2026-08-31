# 09. Closeout and Tracker Sync

## Outcome

Prove the owned CKB implementation state repository by repository, reconcile the contract and tracker claims, and distinguish implementation completion from upstream acceptance.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md). Run after the applicable implementation graph and final handoff state are ready for closeout.
- Target repositories: [Utils](https://github.com/rosen-bridge/utils), [Scanner](https://github.com/rosen-bridge/scanner), [Watcher](https://github.com/rosen-bridge/watcher), [Guard Service](https://github.com/rosen-bridge/guard-service), [Minimum Fee Job](https://github.com/rosen-bridge/minimum-fee-job), [Health Check](https://github.com/rosen-bridge/health-check), [Rosen SDK](https://github.com/rosen-bridge/rosen-sdk), [UI](https://github.com/rosen-bridge/ui), and this integration tracker.
- Closeout records dependency-aware implementation status. It does not execute rollout or a zero-value mainnet testbed.

## Landed definition

A repository's owned changes are landed for this implementation pass only when they are committed and pushed, the worktree is clean except for documented pre-existing baseline changes, base and head commits are explicit, and pull-request/upstream review and merge state is stated explicitly. Upstream merge is not required.

## Requirements

- Close graph nodes only after their declared dependencies and completion evidence are satisfied. Record incomplete or blocked nodes without holding independent branches to a false shared status.
- For every repository, record declared Node version, active branch, base commit, head commit, pushed ref, owned commits, upstream state, and baseline dirt.
- Run repository-native lint, type-check, focused tests, and builds for each changed surface under that repository's declared Node version.
- Prove cross-repository consumption with clean install/pack/build flows. Do not accept an existing `node_modules`, generated output, or an ad hoc overlay as package compatibility evidence.
- Inspect `git status`, owned commit diffs, base-to-head diffs, and tracked-source `git grep` results. Distinguish owned changes from baseline rather than cleaning unrelated work.
- Reconcile the technical contract and every repository-owned completion criterion against tracked evidence. Do not preserve superseded requirements.
- Update the integration [README](../README.md) when implementation evidence invalidates its timeline, fee/capacity assumptions, dependencies, handoff links, or contract. Record repository status and upstream state in the completion report and owning pull requests. Update the [decision register](../decisions-and-open-questions.md) only when decision status or evidence changed.
- Verify [work item 08's](./08-contract-deployment-handoff.md) sole handoff artifact at `../deployment-handoff.md`; do not duplicate its item-level deployment state in the main tracker.
- Do not perform contract deployment, token registration, service rollout, mainnet testbed transactions, or production operation.

## Done When

- Every graph node has an evidence-backed status and unmet dependencies remain explicit.
- Every owned implementation change satisfies the landed definition or is reported as not landed with the exact missing condition.
- Every changed repository has clean package proof and repo-native verification, or a precise blocker and strongest unblocked result.
- The completion report and owning pull requests record final implementation status; `../README.md` contains no stale timeline or shared-requirement conflict.
- The deployment handoff uses its required six-column schema, and the main tracker links to it without duplicating its authoritative rows.
- No rollout or testbed execution is represented as part of implementation completion.

## Verification

- Run `git -C <repo> status --short --branch`, `git -C <repo> diff --check`, and explicit base-to-head `git diff --stat`/`git log` checks for every repository.
- Search only tracked source with `git -C <repo> grep -n -E` for the shared requirement terms and inspect the matching implementation, tests, and config.
- Run and record each repository's declared Node version and native validation commands.
- Verify all implementation-folder relative paths resolve and Work Sequence lists every numbered work item file in this folder exactly once.
- Search the work breakdown and tracker for stale work-item names, stale dependencies, unsupported completion claims, superseded CKB models, five-byte CKB envelope headers, and `inputs[0]` or selected-output `fromAddress` derivation.
- Record graph status, per-repository landed status, verification commands/results, tracker edits, blockers, and remaining Rosen-owned work with the implementation evidence.
