# CKB custody-flow heuristic: eager-cleanup order-quantum (H1)

The first mainnet CKB integration release (v1) selects the eager-cleanup order-quantum policy (H1) for event-payment custody shaping. Rosen has no automatic custody-maintenance lifecycle, so payment processing must preserve and repair useful committed inventory. The integration [README](../../../README.md#custody-concurrency-and-transaction-chaining) owns the production contract; this brief records the selected algorithm and evidence.

## Selected Policy

The integration README owns H1's operative rules. The benchmark reference implementation is [`src/policies/order-quantum.ts`](../src/policies/order-quantum.ts), using its eager variant.

It combines the benchmark's bounded-value order, a bounded exact-token fallback, identity-ceiling repair, eager cleanup of sub-quantum cells, nearly equal payment-useful change, and canonical-only output while relevant change is unresolved. Ceiling repair remains available in that state; cleanup and shaping do not.

Inventory ceilings and unresolved change are constructor policy. Agreement validates transaction-local output and complete-byte bounds without reproducing the proposer's cover or cleanup order.

The checked target is five native outputs or three typed-plus-untyped extensible user-defined token (xUDT) pairs. Production derives its value from the signed-off structural profile using the README formula rather than copying those fixture counts.

## Evidence

- The complete 126-test suite passes on the declared minimum Node `22.18.0` and on the Node `24.18.0` runtime recorded by the generated artifacts. It comprises 75 comparison tests, 16 equal-remainder tests, 14 H1 tests, 17 lifecycle tests, and four bounded recoverability proofs.
- The comparison includes the incumbent largest-first canonical-minimal-change policy as an eligible zero-shaping baseline.
- The [results document](../results/README.md) owns all generated comparison and recoverability figures.
- Eager cleanup is selected. It preserves the no-cleanup variant's served totals and recovers 6,062 of the 7,094 states in the equal-remainder-constructible denominator instead of 2,049. The v1 integration accepts higher measured backlog, input count, and bytes because no separate maintenance lifecycle repairs degraded inventory. Triggered cleanup is rejected because it matches eager cleanup in every checked result while adding a predicate.

## Deployment Follow-Up

[Work item 08](../../../implementation/08-contract-deployment-handoff.md) owns the pre-activation measurements and testbed evidence for H1. Those checks may revise the policy before rollout; they do not leave the v1 architecture undecided.
