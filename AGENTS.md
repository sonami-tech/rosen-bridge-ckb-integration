# Working in This Repository

This file is the working agreement for this tracker and for implementation work in the Rosen repositories named by each work item. Three documents divide the rest: the integration [README](./README.md) is the implementation contract, decision status and evidence live in the [decision register](./decisions-and-open-questions.md), and the [work breakdown](./implementation/README.md) carries delivery units and dependencies.

## Working Agreement

- Each work item names and links its implementation repositories. Do not assume a sibling checkout layout; select and verify each target checkout and revision explicitly. Paths in this tracker are relative to the tracker root, and paths in work-item links are relative to `implementation/`.
- Keep `CLAUDE.md` as a relative symlink to `AGENTS.md`; do not duplicate the working agreement in a regular file.
- Run tracker checks from the tracker root unless a tracker package documents another working directory. Run implementation commands from the selected target repository's root unless that repository documents another working directory.
- This repository is the single owner of the high-level design, decision history, work breakdown, and deployment handoff. Correct those artifacts together whenever tracked implementation evidence invalidates a claim.
- A material design decision is complete only when its owning public artifact records the selected choice, rejected alternatives, decisive reason, and accepted tradeoff. Propagate the selected rule to the README and affected work items; when a benchmark chooses production behavior, keep deployment measurements as handoff gates rather than open architecture. Do not leave rationale only in private notes or chat.
- Read [decisions-and-open-questions.md](./decisions-and-open-questions.md) before implementing a surface. The integration README remains the implementation contract; do not revise a selected rule inside one work item.
- This implementation pass ends at owned code committed and pushed with repository-local and clean-package verification. It does not execute a testbed, mainnet rollout, contract deployment, or production operations.
- When the evidence a work item needs to close lies outside this pass (testbed, rollout, deployment, live multi-node or live-indexer observation), report that item blocked and name the missing evidence and its owner. Do not hold it open ambiguously and do not treat the requirement as waived.
- Ordinary upstream PR review is Rosen's acceptance path for Sonami proposals. Do not add separate Rosen confirmation, approval, or review gates for individual design choices; track only concrete protocol or deployment inputs that PR review cannot supply.
- Treat pre-existing dirty worktrees as baseline. Record them, preserve unrelated changes, and never use them as proof for owned work.
- Search tracked source with `git grep`. Do not use ignored or generated files as implementation proof.
- Implementation evidence consists of a completion report to the requester with commands, results, baseline dirt, and unresolved blockers, plus durable code-relevant evidence in the owning pull request or deployment handoff. Do not create another project document for it.

## Source Precedence

- The process and module authority is the [pinned Rosen Contribution Standards repository](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf), especially [RCS-003](https://github.com/rosen-bridge/rcs/tree/7b9784dae9d8d5b66b80de7a6043d1ba36a3a4bf/rcs-003). Read the applicable module sections before changing a repository.
- The latest public CKB-specific direction is the [Rosen team response on `rosen-bridge/rcs#2`](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-4926455588). It is authoritative only for what it states: rejecting the single Anyone Can Pay (ACP) cell in favour of normal Rosen-lock UTXOs, the blanket Scanner input-resolution concern, the public-endpoint question, and chain-index ownership. It supersedes the issue body's earlier single-ACP-cell and tentative chain-index proposals.
- Every other detailed choice belongs to RCS-003, a pinned source, or Sonami. [Sonami's published reply](https://github.com/rosen-bridge/rcs/issues/2#issuecomment-5322173229) is an unanswered proposal, and private discussion is not public evidence; neither makes a choice a Rosen decision. Classify each such choice by that owner rather than citing `rcs#2` for it.
- Latest Rosen-specific guidance and current RCS contracts supersede earlier exploration. Tracked implementation can correct status, API, or feasibility claims, but it does not silently override a Rosen protocol or contribution requirement; report that conflict as a blocker requiring Rosen clarification.
- Before designing a CKB-specific mechanism, inspect the shared Guard path and the closest existing Rosen chain integrations at pinned revisions. Reuse their contract when CKB has no material protocol difference. When CKB must diverge, name the protocol constraint or safety failure that requires it; when the same problem affects other chains, surface that scope instead of silently making CKB its owner.

## Runtime

- Preserve each target repository's declared Node version. The work items expect Node `22.18.0` except for Watcher version 1 at Node `20.11.0`; verify those values in the selected revisions before implementation.
- Do not change a repository runtime to make cross-repository consumption work. Resolve package, API, build-output, and syntax compatibility within the declared runtimes.
- Ad hoc `node_modules` overlays are not downstream proof. A consumer must install or pack the producer through a clean repository-supported flow.

## Contribution

- Follow the RCS contribution contract: every PR has a changeset; do not edit changelogs directly, skip hooks, or include unrelated files. Almost all changesets are minor level, and each changeset covers one package unless several packages share exactly the same changelog text. Under the reviewed RCS-003 contract, the Guard service integration PR is the exception that uses a major changeset.
- Every RCS-required new package created with `npx kodegen monorepo add-package` starts at version `0.0.0` and carries its own minor changeset with the exact text `initialize the package`. RCS-003 does not require that initialization and the first functional change use separate PRs; follow repository maintainer slicing without weakening the version or changeset rule.

## Review Heuristics

- Separate source facts, product decisions, and deployment values.
- Treat each Guard's CKB pool as local asynchronous state even when every node uses the same release and configuration.
- Distinguish a transaction proposer, agreement initiator, signing coordinator, and broadcaster.
- Distinguish conflict independence from common-ancestor failure independence.
- Keep CKB capacity and extensible user-defined token (xUDT) quantity in separate ledgers.
- Do not infer previous-cell contents during deposit extraction. Guard payout construction is a different path and may resolve its own custody inputs.
- Compare complete signed transaction bytes when witnesses matter. A CKB raw transaction hash excludes witnesses.

## Completion Procedure

For the next engineer revising an accepted decision:

1. Pin the source revisions used and append new evidence only when it changes the decision.
2. Compare the proposed rule against every affected transaction path: payment, cold storage, arbitrary, and manual.
3. Trace construction through agreement, threshold signature scheme (TSS) signing, submission, retry, conflict handling, restart, and confirmation.
4. Check concurrent confirmed-input transactions on at least two identically configured CKB nodes with deliberately different pool arrival order.
5. Record the answer or revision in the [decision register](./decisions-and-open-questions.md) and update its status when applicable.
6. Update the integration [README](./README.md) and all affected work items together. Remove superseded requirements rather than adding compatibility branches.
7. Run focused tests, repository-native checks, clean packed-package consumer tests, contradiction searches, and `git diff --check`.
8. Run an independent critic pass. If it changes the contract, repeat verification before recording the revision.

Do not revise a design decision from a passing unit test alone. For a deployment-input row, record its value, owner, and evidence and run checks scoped to that input; apply the decision-revision procedure only when the evidence changes a selected contract.
