# CKB Custody-Flow Benchmark

This benchmark compares joint custody-cell input-selection and change-shaping policies for Rosen Bridge payments on CKB. It also models whether committed custody inventory can sustain the Guard, threshold signature scheme (TSS), commitment, and indexer lifecycle without unconfirmed chaining.

The benchmark is public decision evidence. The integration [README](../../README.md#decision-evidence-and-ownership) selects the eager-cleanup order-quantum policy (H1) for event payments; [work item 08](../../implementation/08-contract-deployment-handoff.md) owns deployment reruns against the signed-off transaction shape and topology.

## Start Here

- [Benchmark contract](./docs/contract.md): scope, invariants, workloads, comparison gates, and completion criteria.
- [Order-quantum H1 brief](./docs/heuristic-brief.md): the selected policy, evidence, and accepted tradeoff.
- [Policy guide](./docs/policies.md): policy implementations and their roles in the comparison.
- [Results](./results/README.md): generated artifacts, reproduction commands, and interpretation.

## Setup

Use Node `22.18.0` or newer and the pinned pnpm release. Run commands from this directory:

```sh
pnpm install --frozen-lockfile
```

The benchmark has no runtime dependency. TypeScript and Node declarations are development-only checks.

## Commands

- `pnpm check`: type-check the package and run all 126 tests.
- `pnpm typecheck`: type-check `src/`, `scripts/`, and `test/` without emitting JavaScript.
- `pnpm test:fast`: run the 122 focused tests and skip the exhaustive recoverability proofs.
- `pnpm test:recoverability`: run the four exhaustive proofs, which take roughly five minutes on the recorded runtime.
- `pnpm test:comparison`, `pnpm test:lifecycle`, `pnpm test:equal-remainder`, and `pnpm test:order-quantum`: run the named focused suites.
- `pnpm test:recoverability:equal`: run only the equal-remainder recoverability proof.
- `pnpm test`: run all 126 tests.
- `pnpm generate`: regenerate every checked-in JSON artifact under `results/`.
- `pnpm generate:comparison`: regenerate only the traffic comparison.
- `pnpm generate:lifecycle`: regenerate only the lifecycle report.
- `pnpm generate:recoverability`: regenerate all four recoverability reports.
- `pnpm observe --endpoint <url>`: run the live pool observer with optional `--samples`, `--poll-ms`, `--duration-ms`, and `--output` arguments.

For one recoverability report, pass its short name:

```sh
pnpm generate:recoverability equal
```

The accepted names are `equal`, `order-quantum`, `no-cleanup`, and `triggered`. The [results document](./results/README.md) explains the generated evidence.

## Structure

- `src/`: simulation, policy, lifecycle, validation, and recoverability code.
- `test/`: focused and exhaustive Node test suites.
- `scripts/`: artifact generators and the live pool observer.
- `docs/`: benchmark contract, selected-policy brief, and policy guide.
- `fixtures/`: checked deterministic seeds and serialized transaction fixtures.
- `results/`: generated evidence and its interpretation.
