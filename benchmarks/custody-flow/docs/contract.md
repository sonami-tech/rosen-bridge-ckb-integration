# CKB custody-flow heuristic benchmark contract

## Purpose

This benchmark compares a small fixed set of trusted CKB custody-cell selection policies for the first mainnet CKB integration release (v1). It is a decision aid, not a general policy competition platform.

The benchmark answers one question: which joint input-selection, change-shaping, and replenishment policy serves ordinary and burst native CKB and one-type extensible user-defined token (xUDT) payments reliably without chaining, value loss, recipient overpayment, starvation, or avoidable custody-cell fragmentation?

## Scope

The comparison covers:

- confirmed, mature, eligible custody inputs;
- native CKB or one registered full xUDT type per payment;
- separate CKB capacity and xUDT quantity conservation;
- one complete payment per transaction;
- engine-owned recipient and custody change scripts;
- no chaining;
- local reservations, pending change visibility, retries, and confirmation delay.

Cold storage, arbitrary multi-item orders, manual maintenance, unrelated-type pass-through, and production rollout are outside this benchmark.

## Safety Invariants

The engine validates every proposed transaction. A policy is unusable when any proposal:

- selects an unreadable, unconfirmed, immature, ineligible, reserved, duplicate, or foreign input;
- loses capacity or xUDT quantity other than the exact charged fee;
- overpays the recipient;
- folds a sub-floor residue into miner fee;
- emits an unsupported type or changes engine-owned script/data identity;
- creates an output below its exact occupied-capacity floor;
- exceeds the transaction-size or applicable verifier-owned byte budget.

Native recipient capacity equals the requested amount. An xUDT recipient receives the requested token quantity and route capacity. Typed change has the same full xUDT type, positive token quantity, 16 data bytes, and exactly its occupied-capacity floor. Untyped change has empty data and enough capacity for its exact floor.

The engine computes transaction size from the nested Molecule `Transaction` shape, including input-aligned witnesses. Fee is `ceil(rate * max(serialized_size_in_block, cycle_weight_bytes) / 1000)`, where `serialized_size_in_block` is the complete transaction size plus its four-byte containing-vector offset.

## Candidate View

Cells are ordered by `(blockNumber, transactionIndex, outputIndex, id)`. The engine takes the profile's candidate prefix before removing reserved cells. A policy reads that remaining prefix only through sequential pages of 100 cells and cannot seek or reverse it.

Lane inventory is separate full-identity data, not an inference from the mixed-asset input prefix. Construction policies may scan their lane views enough times to make policy decisions.

The selected order-quantum selection-and-change heuristic (H1) receives at most `target + 1` confirmed cells per identity, excludes inputs consumed by approved-or-later transactions or under an unexpired local reservation, and counts all known approved-or-later pending outputs. Counts above target need only prove non-growth. Candidate and agreement-stage outputs remain speculative. Unresolved relevant change permits the same smallest-input ceiling repair as resolved state, but bypasses cleanup and shaping until canonical commitment. Committed-unindexed outputs still count as pending.

H1's minimum-cardinality exact-token search examines at most the first 30 comparator-ordered payment-type cells whose quantity does not exceed the request.

H1 agreement does not consume this local inventory view. It validates transaction-local output counts, payment usefulness, near-equality, conservation, and the complete transaction-size delta from the shortest H1-ordered declared-input prefix that admits canonical minimal composition. Extra declared inputs and extra outputs count toward that delta.

Read metrics charge every candidate record, construction lane-view scan, and inventory snapshot record exposed through the harness. They are in-process accessor work, not production remote procedure call (RPC) counts.

Policies are trusted repository code and run in process. Each construction receives fresh candidate and lane views plus cloned input data. The runner executes every scenario twice and rejects a policy when the canonical results differ.

## Input And Change Shaping

### Compared Policies

Input selection and change shaping are coupled. The selected inputs determine xUDT remainder, available CKB capacity, exact cover, possible output count, and the next confirmed inventory. The comparison includes:

- single change emits the minimum one custody output when change is required;
- the former floor-two rule forks only when the selected inputs consume every confirmed cell of that full asset identity and no known pending output will replace one;
- replay-current floor eight creates up to two children until its identity target is reached, but requires each child to replay the current payment;
- the representative floor-eight comparison instead requires each child to serve 67 CKB or 50 raw xUDT units;
- bounded value-aware policies that reorder only the readable candidate prefix. The integrated-indexer query applies exact lock, type, and data-shape eligibility before the limit, so unsupported and foreign cells never consume it. Native cells order by descending capacity. xUDT starts with a descending-token cover, then full untyped mates, remaining typed cells, and sub-mate untyped cells. A bounded ascending-token alternative handles exact decompositions that largest-first cannot represent;
- ledger-owned xUDT change that leaves typed outputs at their occupied floor and returns consumed excess CKB to one untyped output, compared with allocation that can self-fund typed outputs.
- the equal-remainder experiment, which uses largest-first payment cover, splits positive remainders as evenly as integer units permit, and adds smallest same-identity cells only while that identity is over target. Exact-token cover stays canonical and minimal. Typed xUDT outputs stay at occupied capacity and all excess CKB returns to untyped outputs. Its checked target equals the byte-derived generation cap: five native outputs or three typed and three untyped xUDT outputs under the checked profile.
- order quantum H1, selected for event payments after this comparison. The integration [README](../../../README.md#custody-concurrency-and-transaction-chaining) owns the production contract; the [heuristic brief](./heuristic-brief.md) records its evidence and accepted tradeoff.

Targeted shaping is not the rejected global two-change rule. Diagnostic policies retain their declared targets, and remainder allocators have no configured useful amount.

### Shared Validation Boundaries

The transaction byte budget bounds cleanup and output generation, while the constructor's target-bound inventory snapshot bounds per-identity growth. Generic validation rejects above-floor typed change. H1 agreement enforces its derived output target, useful near-equal change, and complete transaction byte allowance.

Bounded exact-subset optimization, ceiling repair, cleanup order, unresolved state, and allocator shape remain proposer policy. Any historical policy that violates a global invariant is reported as ineligible rather than exempted.

Diagnostic children are emitted only when each can serve the policy's current-payment or representative-payment unit under the same occupied-capacity, fee, and transaction-size rules. Equal remainder reduces typed and untyped output counts until the complete transaction fits. Exact capacity cover emits no change. A positive xUDT remainder emits at least one floor-capacity typed output; a positive capacity remainder emits untyped change rather than extra fee. The representative units remain diagnostic fixtures, not deployment values.

Construction uses lane views and known approved-or-later pending outputs. Absence of the target-bound constructor snapshot fails closed.

While active state contains unresolved relevant change, the harness permits a canonical or exact-token plan plus only the smallest confirmed custody inputs needed to repair a ceiling violation. It forbids cleanup and shaping.

H1 agreement uses only the declared transaction, so proposer and verifier inventory-view drift cannot change its validity. The retained equal-remainder and damped-quantum comparators still consume confirmed-inventory snapshots under their historical agreement boundaries.

## No-Fit Evidence

For at most 20 transaction-relevant cells, an exact subset oracle checks no-fit independently of policy ordering.

H1's oracle uses its constructor-owned pending-output and identity-ceiling semantics while independently enumerating every bounded subset. It does not reproduce the constructor's cover order, exact-token window, or repair heuristic. Historical targeted policies use their own confirmed-inventory agreement boundary. A historical single-change plan that strands excess CKB in typed change is therefore not misreported as admissible.

Every oracle-proven policy miss is a hard failure.

The engine owns outcome labels in this order:

1. invalid order;
2. invalid proposal;
3. aggregate shortage;
4. reservation shortage;
5. size or structural infeasibility;
6. intrinsic no-fit;
7. policy no-fit;
8. accepted.

Larger pools remain comparative. Their no-fit outcomes are reported as unproven and never converted into proof.

## Workloads

### Boundary and Lifecycle Cases

Fixed public seeds generate mixed native and two-route xUDT inventories with useful values beyond an initial dust region. Query-level shape filtering keeps their transaction-relevant sets below the narrow 100-cell limit, so the hand-authored `candidate-window-pressure` workload, not the generated seeds, owns the narrow-window comparison.

Checked mechanics cover:

- recipient floor minus, exact, and plus one;
- exact cover and residues at one shannon, change floor minus one, floor, and floor plus one;
- typed-change floor boundaries;
- maturity, reservation release, RPC rejection, signing failure/delay, conflict, cycle rejection, and ambiguous restart confirmation/release;
- fragmented, serial, mixed native/xUDT, foreign-prefix, and candidate-window pressure;
- native and xUDT one-lane pressure, recovery to two independently useful lanes, steady-state non-growth, floor fallback, and per-asset typed/untyped change;
- native and xUDT hidden-lane counterexamples where 99 foreign cells separate two same-identity lanes. Inferring lanes from the 100-cell mixed-asset prefix grows two lanes to twelve in ten payments; the identity-specific floor-two policy must hold at two and targeted policies may grow only to their declared target;
- an aggregate-zero identity shift that consumes one typed and one untyped lane to create two typed lanes. Per-identity growth must fail even though total cell count is unchanged.

### Burst and Cross-Asset Cases

- cold bursts of eight payments per asset from one confirmed lane;
- warm bursts after seven spaced opportunities to grow the inventory;
- bursts after two larger multi-input payments, both at and above the diagnostic representative lane unit.
- native and xUDT exact-cover sequences followed by bursts, proving that strict oldest-first input consumption can erase a target without emitting change;
- xUDT funding followed by a native burst, comparing capacity moved into typed cells with capacity preserved in the untyped ledger;
- simultaneous native and xUDT demand in both queue orders, exposing starvation when floor-capacity typed cells share the untyped capacity pool.

### Long-Run and Adversarial Cases

- 500-payment native homogeneous, native bimodal, and xUDT homogeneous traces for bounded inventory;
- a 40-payment no-chaining burst from three confirmed cells and bounded progress through 10,000 hostile small cells;
- attacker-crafted exact-cover exhaustion followed by deposit recovery, proving the candidate loses no value but cannot create capacity before new inflow.
- many independent xUDT cells carrying one payment plus one remainder, proving all payments remain serviceable while largest-first splitting consolidates the pool to the bounded typed-plus-untyped target;
- an input-heavy transaction under a reduced size limit, proving an oversized minimal fallback returns no plan rather than an invalid proposal.
- hidden native floor donations and small xUDT donations, proving bounded identity repair restores useful lanes without net growth;
- more than one initial generation plus repeated floor donations, proving repair absorbs ongoing inflow without policy-attributable growth;
- more unsupported custody shapes than the candidate limit followed by a solvent deposit, proving query-level shape filtering prevents a permanent prefix halt;
- exact-token xUDT cover with and without untyped congestion, same-window RPC reservations, confirmed-view shaping rejection with minimal-payment acceptance, proposer input reordering, fragmented sub-quantum change, and ordinary no-suffix over-generation, proving construction and agreement enforce one boundary;
- same-full-type capacity funding, proving every extra token unit remains in same-type custody change.

### Comparison Profiles

The comparison uses three profiles:

- canonical moderate candidate view and confirmation;
- narrow 100-cell candidate view;
- slow confirmation with a lower signing ceiling.

Adding a profile requires a concrete reason it could change the policy choice.

## Metrics And Decision

### Reported Metrics

For each policy and profile, report:

- safety eligibility, invalid proposals, and exact-oracle misses;
- served payments and no-fit rate;
- maximum wait, maximum backlog, and backlog area;
- immediate burst admissions by workload and asset in cold, warm, collapse, exact-cover, capacity-migration, and mixed-demand workloads;
- total inputs, change outputs, multi-change transactions, serialized bytes, and fees;
- total policy cells and pages read, including identity-lane probes;
- peak and terminal inventory plus policy-attributable net cell growth. A
  target-relative growth gate applies only to policies that declare an
  inventory target; target-less baselines still report growth but have no
  target against which that gate can be defined.

Candidate read metrics count post-filter merged records exposed to the policy. The standard indexer implementation uses separate native-untyped and payment-type streams; lazy merge transport reads are bounded by fewer than `candidateLimit + 2 * pageSize` records and remain a deployment-budget gate.

### Planning Validity

Lifecycle `maxRequired` is censored when the starting inventory cannot serve the workload. Every published planning report must therefore have zero inventory no-fit observations. Increase a deployment seed until the complete workload passes that gate before using its peak and adding explicit headroom.

Lifecycle inventory events are exact exogenous fixture effects, not modeled cold selection or retry. Every event must apply completely at its declared time and within the scenario horizon. A missing, spent, reserved, or duplicate removal, duplicate addition, or unapplied event invalidates the run.

Each lifecycle timing profile carries the complete transaction profile used for canonical construction and change materialization. A deployment rerun must replace its fee rate, cycle-weight bytes, transaction-size limit, structural shape, and custody-lock shape together with the timing and workload assumptions.

### Decision Rule

The runner does not calculate an automatic winner. Safety failures and exact-oracle misses disqualify a policy. Among eligible policies, compare current service, cross-asset starvation, sustained useful inventory, bounded false negatives, and queue behavior before byte, fee, and inventory cost. Input and change choices are judged together. Any unresolved reversal returns to the owner rather than being hidden by weights or a Pareto rule.

## Reproducibility

The harness is dependency-free erasable TypeScript and records the executing Node version in every generated report. Fixed seeds, profiles, scenarios, policies, and canonical summary encoding are repository-owned. The checked serialized fixtures prove the byte calculator. The package [command interface](../README.md#commands) owns test and generation invocation.

One command must run the complete comparison in a few minutes. The durable result is a concise summary with the command, Node version, fixed seeds, policy ids, profile rows, and remaining scope limits. Full per-attempt output is generated only for debugging.

## Stopping Rule

The benchmark is finished when:

1. every safety invariant holds in every accepted transaction;
2. focused mechanics and exact-oracle tests pass;
3. one command completes in a few minutes;
4. each policy has one row for each of the three profiles;
5. the rows are sufficient for the owner to choose one policy and record its accepted tradeoff.

Do not add machinery unless it could change which policy is chosen. A defect in optional harness machinery is a reason to remove that machinery, not expand it.
