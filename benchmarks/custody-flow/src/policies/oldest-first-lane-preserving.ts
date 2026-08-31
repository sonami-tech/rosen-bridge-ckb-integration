import {
  compareCellId,
  SHANNONS_PER_CKB,
  type Cell,
  type ChangeOutput,
  type Payment,
} from "../model.ts";
import type { Policy } from "../policy.ts";
import {
  constructLanePreservingPlan,
  type CapacityAllocation,
} from "../lane-preserving-change.ts";
import { constructSingleChangePlan } from "../single-change.ts";

const makePolicy = (
  id: string,
  target: number,
  preserveConsumed: boolean,
  replayPayment?: (payment: Payment) => Payment,
  capacityAllocation: CapacityAllocation = "balanced",
  preserveConsumedUntyped = false,
  inputSelection: "oldest" | "bounded-value" = "oldest",
): Policy => ({
  id,
  inventoryTarget: () => target,
  propose(context) {
    const visible: Cell[] = [];
    for (;;) {
      const page = context.candidates.readNextPage();
      if (page.length === 0) break;
      visible.push(...page);
    }
    const hasCustodyLock = (value: Cell | ChangeOutput): boolean =>
      value.lockId === context.limits.custodyLockId &&
      value.lockBytes === context.limits.custodyLockBytes;
    const isUntyped = (value: Cell | ChangeOutput): boolean =>
      hasCustodyLock(value) &&
      value.token === undefined &&
      value.typeBytes === 0 &&
      value.dataBytes === 0;
    const isPaymentType = (value: Cell | ChangeOutput): boolean =>
      hasCustodyLock(value) &&
      context.payment.asset.kind === "xudt" &&
      value.token?.typeId === context.payment.asset.typeId &&
      value.typeBytes === context.payment.asset.typeBytes &&
      value.dataBytes === 16;
    const compareBigintDesc = (left: bigint, right: bigint): number =>
      left === right ? 0 : left > right ? -1 : 1;
    const untyped = visible.filter(isUntyped);
    const paymentType = visible.filter(isPaymentType);
    const relevant =
      inputSelection === "oldest"
        ? visible.filter((cell) => isUntyped(cell) || isPaymentType(cell))
        : context.payment.asset.kind === "native"
          ? untyped.sort(
              (left, right) =>
                compareBigintDesc(left.capacity, right.capacity) ||
                compareCellId(left, right),
            )
          : (() => {
              paymentType.sort(
                (left, right) =>
                  compareBigintDesc(
                    left.token?.amount ?? 0n,
                    right.token?.amount ?? 0n,
                  ) ||
                  compareBigintDesc(left.capacity, right.capacity) ||
                  compareCellId(left, right),
              );
              untyped.sort(
                (left, right) =>
                  compareBigintDesc(left.capacity, right.capacity) ||
                  compareCellId(left, right),
              );
              let tokenTotal = 0n;
              const covering = paymentType.filter((cell) => {
                if (tokenTotal >= context.payment.amount) return false;
                tokenTotal += cell.token?.amount ?? 0n;
                return true;
              });
              const coveringIds = new Set(covering.map((cell) => cell.id));
              return [
                ...covering,
                ...untyped,
                ...paymentType.filter((cell) => !coveringIds.has(cell.id)),
              ];
            })();
    const selected: Cell[] = [];
    for (const cell of relevant) {
      selected.push(cell);
      if (
        !constructSingleChangePlan(
          selected,
          context.payment,
          context.limits,
        )
      )
        continue;
      const selectedIds = new Set(selected.map((input) => input.id));
      const selectedUntyped = selected.filter(isUntyped).length;
      const selectedPaymentType = selected.filter(isPaymentType).length;
      const remainingUntyped =
        context.payment.asset.kind === "native" || selectedUntyped > 0
          ? context.pendingOutputs.filter(isUntyped).length +
            context.lanes.untyped.countUnselected(selectedIds, target)
          : 0;
      const remainingPaymentType =
        context.payment.asset.kind === "xudt"
          ? context.pendingOutputs.filter(isPaymentType).length +
            context.lanes.paymentType!.countUnselected(selectedIds, target)
          : 0;
      const requested = (selectedCount: number, remainingCount: number): number =>
        Math.min(
          2,
          Math.max(
            1,
            target - remainingCount,
            preserveConsumed ? selectedCount : 1,
          ),
        );
      const requestedUntyped =
        context.payment.asset.kind === "native"
          ? requested(selectedUntyped, remainingUntyped)
          : selectedUntyped > 0 &&
              (preserveConsumedUntyped || remainingUntyped === 0)
            ? 1
            : 0;
      const requestedPaymentType =
        context.payment.asset.kind === "xudt"
          ? requested(selectedPaymentType, remainingPaymentType)
          : 0;
      const plan = constructLanePreservingPlan(
        selected,
        context.payment,
        context.limits,
        {
          untyped: requestedUntyped,
          paymentType: requestedPaymentType,
        },
        replayPayment?.(context.payment),
        capacityAllocation,
      );
      if (plan) return plan;
    }
    return undefined;
  },
});

export const oldestFirstLanePreserving = makePolicy(
  "oldest-first-floor-2",
  2,
  false,
);

export const oldestFirstLaneFloorEight = makePolicy(
  "oldest-first-replay-current-floor-8",
  8,
  true,
);

// Diagnostic units match the burst fixtures; they are not deployment values.
const representativePayment = (payment: Payment): Payment =>
  payment.asset.kind === "native"
    ? {
        ...payment,
        amount: 67n * SHANNONS_PER_CKB,
        recipientCapacity: 67n * SHANNONS_PER_CKB,
      }
    : { ...payment, amount: 50n };

export const oldestFirstRepresentativeFloorEight = makePolicy(
  "oldest-first-representative-floor-8",
  8,
  true,
  representativePayment,
);

export const oldestFirstLedgerFloorEight = makePolicy(
  "oldest-first-ledger-floor-8",
  8,
  true,
  representativePayment,
  "preserve-untyped",
  true,
);

export const boundedValueLedgerFloorEight = makePolicy(
  "bounded-value-ledger-floor-8",
  8,
  true,
  representativePayment,
  "preserve-untyped",
  true,
  "bounded-value",
);

export const boundedValueRepresentativeFloorEight = makePolicy(
  "bounded-value-representative-floor-8",
  8,
  true,
  representativePayment,
  "balanced",
  false,
  "bounded-value",
);
