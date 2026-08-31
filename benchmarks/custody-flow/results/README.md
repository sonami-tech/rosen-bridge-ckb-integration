# CKB custody-flow benchmark results

## Current benchmark

### Lifecycle scope

#### Modeled lifecycle

`lifecycle.json` is the current deterministic planning artifact. It exercises the
committed-only lifecycle selected for the CKB integration instead of comparing
transaction-shaping policies. The model includes:

- payment arrivals and indefinite queues;
- the Guard's 180-second proposer slot and 120-second active window;
- five-second agreement draining and candidate expiry at the active-window
  boundary;
- 60-second transaction processing and one fresh threshold signature scheme (TSS) digest per CKB
  transaction;
- the global five-fresh-digest TSS round, its 600-second timeout, and
  head-of-line blocking;
- CKB proposal-to-commit delay and separate indexer lag;
- deep inputs plus shallow, canonically committed Guard change, without
  unconfirmed-parent chaining;
- complete in-memory identity inventories, with shallow Guard-change eligibility
  supplied by scenario fixtures rather than proven from persisted transactions;
- one shared untyped CKB-capacity pool and one typed quantity pool per extensible user-defined token (xUDT);
- exact covers, multi-input erosion, deposits, cold-storage removal, and queue
  censoring;
- canonical construction under the lifecycle profile's fee, cycle weight,
  transaction-size limit, structural shape, and custody-lock shape.

#### Inventory event validity

Inventory events are exact exogenous fixture effects rather than modeled cold
selection or retry. The runner fails if any removal is missing, spent, or
reserved, if a removal or addition id is duplicated, or if an event falls beyond
the scenario horizon; each report records scheduled and applied counts.

### Reproduction

Run it from the [custody-flow package](../README.md#commands):

```sh
pnpm test:lifecycle
pnpm generate:lifecycle
```

Each checked JSON records its Node runtime and exact reproduction command. Two independent generations of all six checked artifacts compare byte-for-byte equal. The focused lifecycle suite passes 17 tests.

### Planning results

#### Checked traces

The three hand-authored 50-payment mixed-asset runs complete without a no-fit
observation. Here, p95 means the 95th-percentile end-to-end latency. Their trace
peaks are:

| Timing profile | Shared untyped cells | Largest typed pool | End-to-end p95 | No-fit observations |
| --- | ---: | ---: | ---: | ---: |
| Illustrative two-minute commitment | 23 | 9 | 257 s | 0 |
| Proposal-window edges | 18 | 9 | 240 s | 0 |
| Delayed proposal and indexer | 36 | 15 | 541 s | 0 |

The corresponding generated 60-payment traces peak at 24/10, 20/10, and 39/14
shared-untyped/largest-typed cells. These are trace outputs, not production
defaults: deployment must replace the synthetic arrivals, amounts, initial
inventory, cold-storage schedule, timing, fee, cycle weight, transaction-size
limit, structural shape, and custody-lock shape with representative
pre-deployment evidence and rerun the model. Inventory proposals also need a
separately justified operating headroom above the trace peaks.

#### Planning gate

The two inventory columns report `maxRequired`, which combines unavailable
canonical cells with net cell-count erosion. That value is censored by an
inadequate seed, so the lifecycle runner rejects every planning report with any
no-fit observation. The checked hand-authored seeds contain 40 untyped and 20
cells per typed identity; generated seeds contain 48 and 26. Deployment must
increase its proposed seed until its complete workload reaches the same
zero-no-fit gate before using `maxRequired` and adding headroom. The
two-minute profile is an illustrative assumption, not an observed bound.

#### Mechanics coverage

Focused scenarios establish the important mechanics:

- eleven simultaneous fresh jobs enter TSS as 5, 5, and 1 across successive
  owner rounds;
- shallow Guard-produced change becomes selectable only after commitment and
  indexing, while a shallow user deposit waits for the normal depth;
- required inventory counts committed replacement change as unavailable until
  indexing, including overlap with newly reserved seed cells;
- speculative candidate and agreement-stage outputs do not constrain a concurrent
  payment under the selected eager-cleanup order-quantum policy (H1), while approved-or-later unresolved change disables shaping and
  cleanup until the earlier transaction commits;
- complete in-memory inventories reach later usable deep cells despite a
  larger shallow-deposit prefix;
- combining exact-token xUDT inputs erodes typed cell count while returning
  surplus CKB capacity to the shared untyped pool;
- shared untyped demand can exceed either individual typed asset's peak;
- a shallow-deposit prefix larger than 100 cells cannot hide deep usable cells in the in-memory model;
- candidate expiry and stalled TSS-head scenarios remain censored when the
  configured horizon ends rather than being reported as successful throughput.

#### Observation method

No checked-in public observation supplies a lifecycle profile. The observation
method is reproducible with:

```sh
pnpm observe --endpoint https://mainnet.ckb.dev/ --samples 5 \
  --poll-ms 1000 --duration-ms 900000
```

The observer records the interval from its first local pool-status observation
to its first local committed-status observation and retains the block producer
timestamp separately. The polling cadence bounds its precision; it does not
measure original broadcast, global propagation, or Guard indexer visibility. A
deployment run therefore needs observations from the intended node/indexer
topology and must retain the complete raw output used to derive its profile.

## Equal-remainder experiment

### Equal-remainder evidence

`largest-first-equal-remainder` is retained as a historical experiment. It is not the policy selected for the first mainnet CKB integration release (v1). Its agreement boundary owns inventory ceilings and unresolved-change minimality; generic validation owns exact-floor typed change. Bounded exact-subset optimization and allocator shape remain proposer policy.

The focused suite passes 16 tests. The separate bounded checker enumerates 15,876 xUDT states and accepts all 15,082 agreement-admissible payments with zero false no-fits, invalid plans, or non-floor typed outputs. Constructive enumeration finds a target-recovering equal-remainder plan in 7,094 states; the policy recovers 2,906 and misses 4,188, or 59% of the constructibly recoverable states.

### Allocator comparison

#### Traffic ranking

Fourteen remainder allocators share one cover, padding, fallback, and agreement implementation. Their canonical/slow-confirmation backlog areas rank as follows:

| Allocator | Canonical | Slow | Slow served |
| --- | ---: | ---: | ---: |
| arithmetic / golden ratio | 174 | 586 | 289 |
| inventory fit / equal | 175 | 587 | 289 |
| Fibonacci / prime | 175 | 589 | 289 |
| two tier | 175 | 594 | 289 |
| binary | 180 | 605 | 288 |
| center heavy | 181 | 605 | 287 |
| decimal coin | 185 | 616 | 285 |
| logarithmic | 193 | 629 | 282 |
| square | 192 | 636 | 285 |
| ternary | 189 | 647 | 286 |
| cubic | 208 | 695 | 279 |

Arithmetic and golden-ratio allocation lead by one canonical and slow backlog unit under the committed seeds. That narrow fixed-seed result does not select a winner. Stronger fixed skew degrades service in the checked workloads.

#### Reproduction

```sh
pnpm test:equal-remainder
pnpm test:recoverability:equal
pnpm generate:recoverability equal
```

Of 15,876 enumerated states, 15,082 are agreement-oracle-admissible. The policy accepts every admissible state. Constructive enumeration finds 7,094 states with a target-recovering equal-remainder plan; 2,906 policy plans recover the target and 4,188 miss it.

### Order-quantum comparison

```sh
pnpm test:order-quantum
pnpm generate:recoverability order-quantum
```

Order quantum recovers 6,062 of the same 7,094 equal-remainder-constructible states. The no-cleanup ablation recovers 2,049; triggered cleanup matches eager cleanup exactly.

## Historical shaping comparison

The comparison tables retain every earlier policy, the historical canonical baseline, and simple and order-quantum ablations. No result is removed when a simpler policy fails.

Input selection and change shaping are one policy. Selected inputs determine the token remainder, available CKB capacity, exact-cover behavior, output count, and next confirmed inventory. The benchmark therefore compares joint policies inside a bounded oldest-cell query rather than holding input selection fixed and ranking change shapes in isolation.

```sh
pnpm generate:comparison
```

The comparison suite passes 75 tests and H1 adds 14 focused tests. Run both from the [package command interface](../README.md#commands):

```sh
pnpm test:comparison
```

Across 87 policy/profile rows, 60 are eligible with zero exact-oracle misses or invalid proposals. The three profile rows for `largest-first-simple-useful-split` remain deliberately ineligible with `28/28/72` exact misses. Twenty-four legacy rows are now ineligible because generic validation correctly rejects above-floor typed change. The canonical baseline has no inventory target, so it reports net cell growth but is not subject to the target-relative growth gate; every safety and exact-oracle gate still applies.

## Legacy diagnostics

Eight historical policies remain in `comparison.json`, but they are disqualified. Their single-change fallback or balanced capacity allocation can place surplus CKB in typed change above its occupied floor. Generic validation now owns that invariant, so these rows report invalid proposals instead of service evidence.

`C/N/S` means canonical, narrow-candidate, and slow-confirmation profiles.

| Policy | Invalid proposals C/N/S |
| --- | ---: |
| `biggest-first-single-change` | 122/122/122 |
| `oldest-first-single-change` | 117/117/117 |
| `oldest-first-floor-2` | 117/117/117 |
| `oldest-first-replay-current-floor-8` | 117/117/117 |
| `oldest-first-representative-floor-8` | 117/117/117 |
| `oldest-first-ledger-floor-8` | 97/97/97 |
| `bounded-value-representative-floor-8` | 122/122/122 |
| `bounded-value-ledger-floor-8` | 102/102/102 |

## Complete comparison

| Policy | Served C/N/S | Backlog area C/N/S | Multi-change txs C/N/S | Canonical change outputs | Canonical bytes | Canonical terminal cells |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `largest-first-canonical` | 288/287/247 | 274/277/1,052 | 118/118/100 | 400 | 182,104 | 772 |
| `bounded-value-damped-quantum` | 292/291/276 | 141/144/738 | 126/126/118 | 534 | 207,206 | 764 |
| `largest-first-simple-useful-split-exact` | 281/280/211 | 610/613/1,696 | 235/235/151 | 1,224 | 330,110 | 720 |
| `largest-first-order-quantum-no-cleanup` | 292/291/290 | 86/89/311 | 122/122/120 | 438 | 188,712 | 803 |
| `largest-first-order-quantum-triggered-cleanup` | 292/291/290 | 98/101/347 | 141/141/132 | 499 | 204,013 | 752 |
| `largest-first-order-quantum` | 292/291/290 | 98/101/347 | 141/141/132 | 499 | 204,013 | 752 |
| `largest-first-equal-remainder` | 292/291/289 | 175/178/587 | 143/142/138 | 555 | 233,367 | 357 |
| `largest-first-simple-useful-split` | 281/280/207 | 621/624/1,714 | 240/240/154 | 1,255 | 336,004 | 724 |

### Selection rationale

The selected event-payment policy is [order quantum H1](../docs/heuristic-brief.md). It replaces fixed representative values with the current payment quantum and a template-derived output allowance, uses exact-token selection only as a fallback, and keeps typed change at occupied capacity. While relevant change is unresolved, it permits ceiling-bounded canonical change and smallest-input ceiling repair but no cleanup or shaping. The integration [README](../../../README.md#custody-concurrency-and-transaction-chaining) owns the production contract; this document owns the comparison evidence.

`largest-first-canonical` is the historical first-release baseline: the same largest-first cover order without a lane target, repair pass, cleanup, or split change. H1 serves `292/291/290` payments versus the baseline's `288/287/247` and reduces backlog from `274/277/1,052` to `98/101/347`, at a canonical cost of 543 rather than 424 inputs and 204,013 rather than 182,104 bytes. Together with H1's recovery result, this supports replacing the baseline for event payments.

`bounded-value-damped-quantum` remains an eligible historical comparator. H1
matches or exceeds its served count while reducing backlog and harness accessor
work in every profile, so the current evidence gives no reason to select it.

Order quantum records `0/3/0` unproven no-fits, no exact misses, and backlog `98/101/347`. In the bounded xUDT lattice it recovers `6,062/7,094` states with a target-recovering equal-remainder plan, versus equal remainder's `2,906`; misses fall from `4,188` to `1,032`.

Simple useful split deliberately removes exact-subset selection, explicit ceiling repair, and sub-quantum cleanup. It is safe but ineligible: `28/28/72` exact-oracle misses and backlog `621/624/1,714`. Keeping this failed baseline in the report shows that useful equal pieces alone are insufficient; the H1 repair machinery earns its complexity.

Adding exact-token subset selection removes all exact misses but leaves backlog at `610/613/1,696`; exact selection is required as a fallback but does not solve inventory quality. Removing cleanup from H1 improves traffic backlog to `86/89/311` and reduces canonical inputs from 543 to 431, but recovery within the equal-remainder-constructible denominator falls from `6,062/7,094` to `2,049/7,094`. The first release accepts cleanup's service and input cost because payment-time processing is the only automatic inventory-repair path.

Triggered and eager cleanup have identical traffic summaries and recovery against that denominator (`6,062/7,094`). The selected H1 rule is eager cleanup because the trigger predicates change no checked behavior.

## Harness query work

These totals count in-process accessor work: candidate records, every construction lane-view scan, and the target-bound constructor snapshot. They do not represent production remote procedure call (RPC) counts or view drift. Candidate counts are post-filter records exposed to the policy; a production two-stream native/xUDT merge has a separate transport bound of fewer than `candidateLimit + 2 * pageSize` records. Totals include later attempts caused by each policy's earlier choices.

| Policy | Canonical cells/pages | Narrow cells/pages | Slow cells/pages |
| --- | ---: | ---: | ---: |
| `largest-first-canonical` | 3,028 / 936 | 3,227 / 563 | 3,533 / 1,783 |
| `bounded-value-damped-quantum` | 9,902 / 2,226 | 9,812 / 1,899 | 12,320 / 3,606 |
| `largest-first-simple-useful-split-exact` | 4,807 / 1,898 | 5,018 / 1,458 | 5,387 / 3,100 |
| `largest-first-order-quantum-no-cleanup` | 4,383 / 1,162 | 4,594 / 830 | 4,357 / 1,503 |
| `largest-first-order-quantum-triggered-cleanup` | 4,114 / 1,166 | 4,325 / 838 | 4,075 / 1,507 |
| `largest-first-order-quantum` | 4,114 / 1,166 | 4,325 / 838 | 4,075 / 1,507 |
| `largest-first-equal-remainder` | 3,342 / 1,261 | 3,553 / 926 | 3,320 / 1,850 |
| `largest-first-simple-useful-split` | 5,187 / 1,935 | 5,398 / 1,484 | 6,086 / 3,142 |

## Decision Evidence

Canonical payments cannot rely on automatic maintenance or routine manual re-denomination. The evidence therefore supports eager-cleanup H1 for event payments: cleanup recovers 6,062 of the 7,094 states in the equal-remainder-constructible denominator versus 2,049 without cleanup, at the measured cost of 63/120 rather than 67/120 immediate burst admissions, higher backlog in every profile, and more inputs and transaction bytes. Triggered cleanup changes no checked result. The integration [README](../../../README.md#decision-evidence-and-ownership) owns the selected rule, and [work item 08](../../../implementation/08-contract-deployment-handoff.md) owns activation evidence.

[`comparison.json`](./comparison.json) contains the exact seeds, workloads, profiles, policies, per-scenario burst splits, and summary values. It intentionally omits per-attempt traces.
