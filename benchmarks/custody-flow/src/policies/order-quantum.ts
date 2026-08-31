import { constructCanonicalPlan } from "../canonical-change.ts";
import {
  isPaymentTypeCustody,
  isUntypedCustody,
  orderBoundedValueCells,
} from "../custody-policy.ts";
import {
  makeRecipient,
  materializeChange,
  transactionSize,
  type Cell,
  type ChangeOutput,
  type ConfirmedInventorySnapshot,
  type PolicyPlan,
  type PolicyLimits,
  type Payment,
} from "../model.ts";
import type { Policy } from "../policy.ts";
import {
  maximumQuantumLanes,
  nativeQuantum,
  xudtMateQuantum,
} from "../quantum-budget.ts";
import { shapingByteBudget } from "../shaping-budget.ts";
import {
  constructEqualRemainderPlan,
  exactTokenSubset,
  remainderAllocators,
} from "./equal-remainder.ts";

const canonicalCover = (
  ordered: Cell[],
  payment: Parameters<typeof constructCanonicalPlan>[1],
  limits: Parameters<typeof constructCanonicalPlan>[2],
): { inputs: Cell[]; plan: PolicyPlan } | undefined => {
  const inputs: Cell[] = [];
  for (const cell of ordered) {
    inputs.push(cell);
    const plan = constructCanonicalPlan(inputs, payment, limits);
    if (plan) return { inputs: [...inputs], plan };
  }
  return undefined;
};

const exactCover = (
  ordered: Cell[],
  payment: Payment,
  limits: PolicyLimits,
): { inputs: Cell[]; plan: PolicyPlan } | undefined => {
  if (payment.asset.kind !== "xudt") return undefined;
  const exact = exactTokenSubset(ordered, payment);
  if (!exact) return undefined;
  const selected = [...exact];
  const selectedIds = new Set(selected.map((cell) => cell.id));
  let plan = constructCanonicalPlan(selected, payment, limits);
  for (const cell of ordered) {
    if (
      plan ||
      selectedIds.has(cell.id) ||
      !isUntypedCustody(cell, limits)
    )
      continue;
    selected.push(cell);
    plan = constructCanonicalPlan(selected, payment, limits);
  }
  return plan ? { inputs: selected, plan } : undefined;
};

export const respectsOrderQuantumCeiling = (
  inputs: Cell[],
  plan: PolicyPlan,
  payment: Payment,
  limits: PolicyLimits,
  inventory: ConfirmedInventorySnapshot,
  pendingOutputs: ChangeOutput[],
): boolean => {
  const isUntyped = (value: Cell | ChangeOutput): boolean =>
    isUntypedCustody(value, limits);
  const isTyped = (value: Cell | ChangeOutput): boolean =>
    isPaymentTypeCustody(value, payment, limits);
  const projectedCount = (
    accepts: (value: Cell | ChangeOutput) => boolean,
  ): number => {
    const before =
      inventory.cells.filter(accepts).length +
      pendingOutputs.filter(accepts).length;
    return (
      Math.max(0, before - inputs.filter(accepts).length) +
      materializeChange(plan.change, payment, limits).filter(accepts).length
    );
  };
  const untypedBefore =
    inventory.cells.filter(isUntyped).length +
    pendingOutputs.filter(isUntyped).length;
  const typedBefore =
    inventory.cells.filter(isTyped).length +
    pendingOutputs.filter(isTyped).length;
  return (
    projectedCount(isUntyped) <= Math.max(inventory.target, untypedBefore) &&
    (payment.asset.kind === "native" ||
      projectedCount(isTyped) <= Math.max(inventory.target, typedBefore))
  );
};

type Cleanup = "none" | "needed" | "eager";

const makeOrderQuantum = (id: string, cleanup: Cleanup): Policy => ({
  id,
  inventoryTarget: maximumQuantumLanes,
  validationBoundary: "order-quantum",
  propose(context) {
    const visible: Cell[] = [];
    for (;;) {
      const page = context.candidates.readNextPage();
      if (page.length === 0) break;
      visible.push(...page);
    }
    const selectable = visible.filter(
      (cell) =>
        cell.reservedUntil === undefined || cell.reservedUntil <= context.window,
    );
    const ordered = orderBoundedValueCells(
      selectable,
      context.payment,
      context.limits,
    );
    const inventory = context.confirmedInventory;
    if (!inventory) return undefined;
    const target = inventory.target;
    const isUntyped = (value: Cell | ChangeOutput): boolean =>
      isUntypedCustody(value, context.limits);
    const isTyped = (value: Cell | ChangeOutput): boolean =>
      isPaymentTypeCustody(value, context.payment, context.limits);
    const countedUntyped =
      inventory.cells.filter(isUntyped).length +
      context.pendingOutputs.filter(isUntyped).length;
    const countedTyped =
      inventory.cells.filter(isTyped).length +
      context.pendingOutputs.filter(isTyped).length;
    const beforeUntyped = countedUntyped;
    const beforeTyped = countedTyped;
    const unresolved =
      inventory.unresolved?.untyped === true ||
      (context.payment.asset.kind === "xudt" &&
        inventory.unresolved?.paymentType === true);
    const projectedCount = (
      inputs: Cell[],
      change: PolicyPlan["change"],
      accepts: (value: Cell | ChangeOutput) => boolean,
      before: number,
    ): number =>
      Math.max(0, before - inputs.filter(accepts).length) +
      materializeChange(change, context.payment, context.limits).filter(accepts)
        .length;
    const respectsCeiling = (inputs: Cell[], plan: PolicyPlan): boolean =>
      respectsOrderQuantumCeiling(
        inputs,
        plan,
        context.payment,
        context.limits,
        inventory,
        context.pendingOutputs,
      );
    const repairCeiling = (
      candidate: { inputs: Cell[]; plan: PolicyPlan },
    ): { inputs: Cell[]; plan: PolicyPlan } | undefined => {
      const inputs = [...candidate.inputs];
      const selected = new Set(inputs.map((cell) => cell.id));
      const smallest = [...ordered].toSorted((left, right) =>
        left.capacity === right.capacity
          ? left.id.localeCompare(right.id)
          : left.capacity < right.capacity
            ? -1
            : 1,
      );
      let plan = candidate.plan;
      while (!respectsCeiling(inputs, plan)) {
        const untypedExceeded =
          projectedCount(inputs, plan.change, isUntyped, beforeUntyped) >
          Math.max(target, beforeUntyped);
        const repair = smallest.find(
          (cell) =>
            !selected.has(cell.id) &&
            (untypedExceeded ? isUntyped(cell) : isTyped(cell)),
        );
        if (!repair) return undefined;
        selected.add(repair.id);
        inputs.push(repair);
        const next = constructCanonicalPlan(
          inputs,
          context.payment,
          context.limits,
        );
        if (!next) return undefined;
        plan = next;
      }
      return { inputs, plan };
    };

    let base = canonicalCover(ordered, context.payment, context.limits);
    let budgetBase = base;
    base = base ? repairCeiling(base) : undefined;
    if (!base) {
      const exact = exactCover(ordered, context.payment, context.limits);
      budgetBase = exact;
      base = exact ? repairCeiling(exact) : undefined;
    }
    if (!base) return undefined;
    if (unresolved || target === 0) return base.plan;
    if (!budgetBase) return undefined;

    const generationLimit = maximumQuantumLanes(
      context.payment,
      context.limits,
    );
    const remainingCount = (
      inputs: Cell[],
      accepts: (value: Cell | ChangeOutput) => boolean,
      before: number,
    ): number => Math.max(0, before - inputs.filter(accepts).length);
    const shape = (inputs: Cell[]): PolicyPlan | undefined => {
      const untypedAllowance =
        Math.max(target, beforeUntyped) -
        remainingCount(inputs, isUntyped, beforeUntyped);
      const typedAllowance =
        Math.max(target, beforeTyped) -
        remainingCount(inputs, isTyped, beforeTyped);
      const plan = constructEqualRemainderPlan(
        inputs,
        context.payment,
        context.limits,
        context.payment.asset.kind === "xudt"
          ? Math.min(generationLimit, typedAllowance)
          : 0,
        Math.min(generationLimit, untypedAllowance),
        remainderAllocators[0],
        undefined,
        context.payment.asset.kind === "native"
          ? { untyped: nativeQuantum(context.payment, context.limits) }
          : {
              typed: context.payment.amount,
              untyped: xudtMateQuantum(context.payment, context.limits),
            },
      );
      return plan && respectsCeiling(inputs, plan) ? plan : undefined;
    };
    const baselineSize = transactionSize(
      {
        inputs: budgetBase.inputs,
        recipient: makeRecipient(context.payment),
        change: materializeChange(
          budgetBase.plan.change,
          context.payment,
          context.limits,
        ),
      },
      context.limits.structural,
    );
    const withinAllowance = (inputs: Cell[], plan: PolicyPlan): boolean =>
      transactionSize(
        {
          inputs,
          recipient: makeRecipient(context.payment),
          change: materializeChange(
            plan.change,
            context.payment,
            context.limits,
          ),
        },
        context.limits.structural,
      ) - baselineSize <= shapingByteBudget(context.payment, context.limits);

    let selected = base.inputs;
    let best = shape(selected);
    if (!best || !withinAllowance(selected, best)) best = base.plan;
    if (cleanup === "none") return best;
    const selectedIds = new Set(selected.map((cell) => cell.id));
    const nativeQuantumValue =
      context.payment.asset.kind === "native"
        ? nativeQuantum(context.payment, context.limits)
        : undefined;
    const mate =
      context.payment.asset.kind === "xudt"
        ? xudtMateQuantum(context.payment, context.limits)
        : 0n;
    const usefulUntyped =
      inventory.cells.filter(
        (cell) =>
          isUntyped(cell) &&
          cell.capacity >=
            (context.payment.asset.kind === "native"
              ? nativeQuantumValue!
              : mate),
      ).length +
      context.pendingOutputs.filter(
        (output) =>
          isUntyped(output) &&
          output.capacity >=
            (context.payment.asset.kind === "native"
              ? nativeQuantumValue!
              : mate),
      ).length;
    const usefulTyped =
      context.payment.asset.kind === "xudt"
        ? inventory.cells.filter(
            (cell) =>
              isTyped(cell) &&
              (cell.token?.amount ?? 0n) >= context.payment.amount,
          ).length +
          context.pendingOutputs.filter(
            (output) =>
              isTyped(output) &&
              (output.token?.amount ?? 0n) >= context.payment.amount,
          ).length
        : 0;
    const untypedPadding = ordered
      .filter(
        (cell) =>
          !selectedIds.has(cell.id) &&
          isUntyped(cell) &&
          (cleanup === "eager" ||
            beforeUntyped > target ||
            usefulUntyped < target) &&
          cell.capacity <
            (context.payment.asset.kind === "native"
              ? nativeQuantumValue!
              : mate),
      )
      .toSorted((left, right) =>
        left.capacity === right.capacity
          ? left.id.localeCompare(right.id)
          : left.capacity < right.capacity
            ? -1
            : 1,
      );
    const typedPadding = ordered
      .filter(
        (cell) =>
          !selectedIds.has(cell.id) &&
          isTyped(cell) &&
          (cleanup === "eager" ||
            beforeTyped > target ||
            usefulTyped < target) &&
          (cell.token?.amount ?? 0n) < context.payment.amount,
      )
      .toSorted((left, right) => {
        const leftAmount = left.token?.amount ?? 0n;
        const rightAmount = right.token?.amount ?? 0n;
        return leftAmount === rightAmount
          ? left.id.localeCompare(right.id)
          : leftAmount < rightAmount
            ? -1
            : 1;
      });
    const padding = Array.from(
      { length: Math.max(typedPadding.length, untypedPadding.length) },
      (_, index) => [typedPadding[index], untypedPadding[index]],
    ).flatMap((pair) => pair.filter((cell): cell is Cell => cell !== undefined));
    let candidateInputs = selected;
    for (const cell of padding) {
      candidateInputs = [...candidateInputs, cell];
      const candidate = shape(candidateInputs);
      if (!candidate || !withinAllowance(candidateInputs, candidate)) continue;
      selected = candidateInputs;
      best = candidate;
    }
    return best;
  },
});

export const orderQuantumNoCleanup = makeOrderQuantum(
  "largest-first-order-quantum-no-cleanup",
  "none",
);

export const orderQuantumTriggeredCleanup = makeOrderQuantum(
  "largest-first-order-quantum-triggered-cleanup",
  "needed",
);

export const orderQuantum = makeOrderQuantum(
  "largest-first-order-quantum",
  "eager",
);
