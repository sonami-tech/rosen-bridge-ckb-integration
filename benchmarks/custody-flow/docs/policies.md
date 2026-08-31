# Custody-Flow Policies

Each policy jointly selects custody inputs and proposes custody change. The [benchmark contract](./contract.md) defines the common safety and agreement rules; the [results](../results/README.md) compare traffic and recoverability under those rules. The integration [README](../../../README.md#custody-concurrency-and-transaction-chaining) owns the selected production behavior.

[`src/comparison-policies.ts`](../src/comparison-policies.ts) is the authoritative list of eligible policies and diagnostic ablations.

## Implementations

- [`biggest-first-single-change.ts`](../src/policies/biggest-first-single-change.ts): the historical largest-first canonical-minimal-change baseline and its legacy single-change comparator.
- [`oldest-first-single-change.ts`](../src/policies/oldest-first-single-change.ts): oldest-first cover with canonical single change.
- [`oldest-first-lane-preserving.ts`](../src/policies/oldest-first-lane-preserving.ts): oldest-first and bounded-value lane-preserving variants.
- [`bounded-value-quantum.ts`](../src/policies/bounded-value-quantum.ts): bounded-value selection with quantum-shaped change.
- [`equal-remainder.ts`](../src/policies/equal-remainder.ts): equal-remainder shaping variants retained as comparators.
- [`simple-useful-split.ts`](../src/policies/simple-useful-split.ts): minimal useful-split policies, including the exact-subset control.
- [`order-quantum.ts`](../src/policies/order-quantum.ts): the selected eager-cleanup order-quantum policy (H1) and its cleanup ablations, with rationale in the [H1 brief](./heuristic-brief.md).

Policies do not bypass validation. A policy that violates conservation, occupied-capacity floors, recipient value, input eligibility, transaction limits, or agreement ceilings is unusable regardless of its throughput.
