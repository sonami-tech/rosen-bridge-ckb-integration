import { constructCanonicalPlan } from "../canonical-change.ts";
import { compareCellId, type Cell } from "../model.ts";
import type { Policy } from "../policy.ts";
import { constructSingleChangePlan } from "../single-change.ts";

const loadCandidates = (context: Parameters<Policy["propose"]>[0]): Cell[] => {
  const cells: Cell[] = [];
  for (;;) {
    const next = context.candidates.readNextPage();
    if (next.length === 0) break;
    cells.push(...next);
  }
  return cells;
};

const compareBigintDesc = (left: bigint, right: bigint): number =>
  left === right ? 0 : left > right ? -1 : 1;

const proposeLargestFirst = (
  context: Parameters<Policy["propose"]>[0],
  construct: typeof constructCanonicalPlan,
) => {
  const cells = loadCandidates(context);
  const typed = cells
    .filter(
      (cell) =>
        context.payment.asset.kind === "xudt" &&
        cell.token?.typeId === context.payment.asset.typeId,
    )
    .sort(
      (left, right) =>
        compareBigintDesc(
          left.token?.amount ?? 0n,
          right.token?.amount ?? 0n,
        ) ||
        compareBigintDesc(left.capacity, right.capacity) ||
        compareCellId(left, right),
    );
  const untyped = cells
    .filter((cell) => cell.token === undefined)
    .sort(
      (left, right) =>
        compareBigintDesc(left.capacity, right.capacity) ||
        compareCellId(left, right),
    );
  const order =
    context.payment.asset.kind === "native" ? untyped : [...typed, ...untyped];
  const selected: Cell[] = [];
  for (const cell of order) {
    selected.push(cell);
    const plan = construct(selected, context.payment, context.limits);
    if (plan) return plan;
  }
  return undefined;
};

export const largestFirstCanonical: Policy = {
  id: "largest-first-canonical",
  propose(context) {
    return proposeLargestFirst(context, constructCanonicalPlan);
  },
};

export const biggestFirstSingleChange: Policy = {
  id: "biggest-first-single-change",
  propose(context) {
    return proposeLargestFirst(context, constructSingleChangePlan);
  },
};
