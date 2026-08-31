import { constructCanonicalPlan } from "../canonical-change.ts";
import { orderBoundedValueCells } from "../custody-policy.ts";
import { materializeChange, type Cell, type PolicyPlan } from "../model.ts";
import type { Policy } from "../policy.ts";
import {
  maximumQuantumLanes,
  nativeQuantum,
  xudtMateQuantum,
} from "../quantum-budget.ts";
import { validateEqualRemainderBoundary } from "../validator.ts";
import {
  constructEqualRemainderPlan,
  exactTokenSubset,
  remainderAllocators,
} from "./equal-remainder.ts";

const makeSimpleUsefulSplit = (id: string, preferExact: boolean): Policy => ({
  id,
  inventoryTarget: maximumQuantumLanes,
  validationBoundary: "equal-remainder",
  propose(context) {
    const visible: Cell[] = [];
    for (;;) {
      const page = context.candidates.readNextPage();
      if (page.length === 0) break;
      visible.push(...page);
    }
    const inventory = context.confirmedInventory;
    if (!inventory) return undefined;
    const unresolved =
      inventory.unresolved?.untyped === true ||
      (context.payment.asset.kind === "xudt" &&
        inventory.unresolved?.paymentType === true);
    const lanes = maximumQuantumLanes(context.payment, context.limits);
    const valid = (inputs: Cell[], plan: PolicyPlan) =>
      validateEqualRemainderBoundary(
        context.payment,
        inputs,
        materializeChange(plan.change, context.payment, context.limits),
        context.limits,
        {
          confirmedInventory: {
            ...inventory,
            pendingOutputs: context.pendingOutputs,
          },
        },
      ).length === 0;
    const ordered = orderBoundedValueCells(
      visible.filter(
        (candidate) =>
          candidate.reservedUntil === undefined ||
          candidate.reservedUntil <= context.window,
      ),
      context.payment,
      context.limits,
    );
    if (preferExact && context.payment.asset.kind === "xudt") {
      const exact = exactTokenSubset(ordered, context.payment);
      if (exact) {
        const inputs = [...exact];
        const selected = new Set(inputs.map((cell) => cell.id));
        for (const cell of [undefined, ...ordered.filter((cell) => !cell.token)]) {
          if (cell && !selected.has(cell.id)) inputs.push(cell);
          const plan = constructCanonicalPlan(
            inputs,
            context.payment,
            context.limits,
          );
          if (plan && valid(inputs, plan)) return plan;
        }
      }
    }
    const selected: Cell[] = [];
    let fallback: PolicyPlan | undefined;
    for (const cell of ordered) {
      selected.push(cell);
      const canonical = constructCanonicalPlan(
        selected,
        context.payment,
        context.limits,
      );
      if (canonical && valid(selected, canonical)) {
        if (unresolved) return canonical;
        fallback ??= canonical;
      }
      const plan = constructEqualRemainderPlan(
        selected,
        context.payment,
        context.limits,
        context.payment.asset.kind === "xudt" ? lanes : 0,
        lanes,
        remainderAllocators[0],
        undefined,
        context.payment.asset.kind === "native"
          ? { untyped: nativeQuantum(context.payment, context.limits) }
          : {
              typed: context.payment.amount,
              untyped: xudtMateQuantum(context.payment, context.limits),
            },
      );
      if (!plan) continue;
      if (valid(selected, plan)) return plan;
    }
    return fallback;
  },
});

export const simpleUsefulSplit = makeSimpleUsefulSplit(
  "largest-first-simple-useful-split",
  false,
);

export const simpleUsefulSplitExact = makeSimpleUsefulSplit(
  "largest-first-simple-useful-split-exact",
  true,
);
