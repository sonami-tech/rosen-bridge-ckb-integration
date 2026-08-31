import {
  makeRecipient,
  isPaymentToken,
  materializeChange,
  occupiedCapacity,
  outputSerializedBytes,
  paymentTokenAmount,
  transactionFee,
  type Cell,
  type ChangeIntent,
  type Payment,
  type PolicyLimits,
  type PolicyPlan,
} from "../model.ts";
import {
  isPaymentTypeCustody,
  isUntypedCustody,
  orderBoundedValueCells,
} from "../custody-policy.ts";
import { constructCanonicalPlan } from "../canonical-change.ts";
import type { Policy } from "../policy.ts";
import { maximumQuantumLanes } from "../quantum-budget.ts";
import { shapingByteBudget } from "../shaping-budget.ts";
import { minimumChangeBytes } from "../validator.ts";

const sumCapacity = (cells: Cell[]): bigint =>
  cells.reduce((sum, cell) => sum + cell.capacity, 0n);

export type RemainderAllocator = {
  id: string;
  weights: (count: number, existing: bigint[]) => bigint[];
};

const sequences: RemainderAllocator[] = [
  { id: "equal", weights: (count) => Array(count).fill(1n) },
  { id: "arithmetic", weights: (count) => Array.from({ length: count }, (_, i) => BigInt(i + 1)) },
  { id: "square", weights: (count) => Array.from({ length: count }, (_, i) => BigInt((i + 1) ** 2)) },
  { id: "binary", weights: (count) => Array.from({ length: count }, (_, i) => 2n ** BigInt(i)) },
  { id: "ternary", weights: (count) => Array.from({ length: count }, (_, i) => 3n ** BigInt(i)) },
  { id: "golden", weights: (count) => Array.from({ length: count }, (_, i) => [1000n, 1618n, 2618n, 4236n, 6854n, 11090n][i] ?? 11090n) },
  { id: "fibonacci", weights: (count) => Array.from({ length: count }, (_, i) => [1n, 2n, 3n, 5n, 8n, 13n][i] ?? 13n) },
  { id: "decimal-coin", weights: (count) => Array.from({ length: count }, (_, i) => [1n, 2n, 5n][i % 3]) },
  { id: "prime", weights: (count) => Array.from({ length: count }, (_, i) => [1n, 2n, 3n, 5n, 7n, 11n][i] ?? 11n) },
  { id: "logarithmic", weights: (count) => Array.from({ length: count }, (_, i) => BigInt(Math.floor(Math.log2(i + 1)) + 1)) },
  { id: "cubic", weights: (count) => Array.from({ length: count }, (_, i) => BigInt((i + 1) ** 3)) },
  { id: "two-tier", weights: (count) => Array.from({ length: count }, (_, i) => i < Math.ceil(count / 2) ? 1n : 4n) },
  { id: "center-heavy", weights: (count) => Array.from({ length: count }, (_, i) => BigInt(Math.min(i + 1, count - i))) },
  {
    id: "inventory-fit",
    weights: (count, existing) => {
      const values = existing.filter((value) => value > 0n).toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0);
      if (values.length === 0) return Array(count).fill(1n);
      return Array.from({ length: count }, (_, index) =>
        values[Math.floor(index * values.length / count)] ?? values[values.length - 1],
      );
    },
  },
];

export const remainderAllocators = sequences;

const split = (
  value: bigint,
  count: number,
  minimum: bigint,
  allocator: RemainderAllocator,
  existing: bigint[],
): bigint[] => {
  const remainder = value - minimum * BigInt(count);
  if (remainder < 0n) return [];
  const weights = allocator.weights(count, existing);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  const shares = weights.map((weight) => remainder * weight / totalWeight);
  const residue = remainder - shares.reduce((sum, share) => sum + share, 0n);
  const incremented = new Set(
    weights
      .map((weight, index) => ({
        index,
        fraction: remainder * weight % totalWeight,
        weight,
      }))
      .toSorted((left, right) =>
        left.fraction === right.fraction
          ? left.weight === right.weight
            ? left.index - right.index
            : left.weight > right.weight ? -1 : 1
          : left.fraction > right.fraction ? -1 : 1,
      )
      .slice(0, Number(residue))
      .map(({ index }) => index),
  );
  return shares.map((share, index) =>
    minimum + share + (incremented.has(index) ? 1n : 0n),
  );
};

const tokenRemainder = (cells: Cell[], payment: Payment): bigint =>
  payment.asset.kind === "xudt"
    ? cells.reduce(
        (sum, cell) => sum + paymentTokenAmount(cell, payment),
        0n,
      ) - payment.amount
    : 0n;

export const exactTokenSubset = (cells: Cell[], payment: Payment): Cell[] | undefined => {
  if (payment.asset.kind !== "xudt") return undefined;
  const typed = cells
    .filter(
      (cell) =>
        isPaymentToken(cell, payment) && cell.token.amount <= payment.amount,
    )
    .slice(0, 30);
  const splitAt = Math.floor(typed.length / 2);
  const subsets = (values: Cell[]): Map<bigint, Cell[]> => {
    const result = new Map<bigint, Cell[]>([[0n, []]]);
    for (const cell of values) {
      for (const [sum, selected] of [...result]) {
        const next = sum + (cell.token?.amount ?? 0n);
        if (next > payment.amount) continue;
        const existing = result.get(next);
        if (!existing || selected.length + 1 < existing.length)
          result.set(next, [...selected, cell]);
      }
    }
    return result;
  };
  const left = subsets(typed.slice(0, splitAt));
  const right = subsets(typed.slice(splitAt));
  let best: Cell[] | undefined;
  for (const [sum, selected] of left) {
    const mate = right.get(payment.amount - sum);
    if (!mate) continue;
    const candidate = [...selected, ...mate];
    if (candidate.length > 0 && (!best || candidate.length < best.length))
      best = candidate;
  }
  return best;
};

export const constructEqualRemainderPlan = (
  selected: Cell[],
  payment: Payment,
  limits: PolicyLimits,
  desiredTyped: number,
  desiredUntyped = desiredTyped,
  allocator: RemainderAllocator = remainderAllocators[0],
  existing: { typed: bigint[]; untyped: bigint[] } = { typed: [], untyped: [] },
  minimums: { typed?: bigint; untyped?: bigint } = {},
): PolicyPlan | undefined => {
  if (
    selected.length === 0 ||
    desiredTyped < 0 ||
    desiredUntyped < 0 ||
    (payment.asset.kind === "native" && desiredUntyped < 1) ||
    (payment.asset.kind === "xudt" && desiredTyped < 1)
  )
    return undefined;
  if (payment.asset.kind === "native" && selected.some((cell) => cell.token))
    return undefined;
  const recipient = makeRecipient(payment);
  const capacity = sumCapacity(selected);
  const tokens = tokenRemainder(selected, payment);
  if (tokens < 0n) return undefined;
  if (payment.asset.kind === "xudt" && tokens === 0n)
    return constructCanonicalPlan(selected, payment, limits);
  if (payment.asset.kind === "xudt") {
    const minimal = constructCanonicalPlan(selected, payment, limits);
    if (
      minimal?.change.length === 1 &&
      minimal.change[0].tokenAmount !== undefined
    )
      return minimal;
  }
  if (payment.asset.kind === "native") {
    const exact = transactionFee(
      { inputs: selected, recipient, change: [] },
      limits.structural,
    );
    if (
      capacity === recipient.capacity + exact.fee &&
      exact.size + 4 <= limits.maxTransactionBytes
    )
      return { inputIds: selected.map((cell) => cell.id), change: [] };
  }

  const maximumTyped = payment.asset.kind === "xudt" ? desiredTyped : 0;
  const minimumTyped = maximumTyped === 0 ? 0 : 1;
  const minimumUntyped = payment.asset.kind === "xudt" ? 0 : 1;
  for (
    let typedCount = maximumTyped;
    typedCount >= minimumTyped;
    typedCount -= 1
  ) {
    const tokenAmounts =
      typedCount === 0
        ? []
        : tokens >= (minimums.typed ?? 1n) * BigInt(typedCount)
          ? split(
              tokens,
              typedCount,
              minimums.typed ?? 1n,
              allocator,
              existing.typed,
            )
          : undefined;
    if (!tokenAmounts) continue;
    for (
      let untypedCount = desiredUntyped;
      untypedCount >= minimumUntyped;
      untypedCount -= 1
    ) {
      const empty: ChangeIntent[] = [
        ...tokenAmounts.map((tokenAmount) => ({ capacity: 0n, tokenAmount })),
        ...Array.from({ length: untypedCount }, () => ({ capacity: 0n })),
      ];
      const samples = materializeChange(empty, payment, limits);
      const { fee, size } = transactionFee(
        { inputs: selected, recipient, change: samples },
        limits.structural,
      );
      if (size + 4 > limits.maxTransactionBytes) continue;
      const typedFloors = samples.slice(0, typedCount).map(occupiedCapacity);
      const typedCapacity = typedFloors.reduce(
        (sum, floor) => sum + floor,
        0n,
      );
      const untypedCapacity =
        capacity - recipient.capacity - fee - typedCapacity;
      if (untypedCount === 0 && untypedCapacity !== 0n) continue;
      const untypedFloor =
        untypedCount === 0 ? 0n : occupiedCapacity(samples[typedCount]);
      const minimumUntypedCapacity = minimums.untyped ?? untypedFloor;
      if (untypedCapacity < minimumUntypedCapacity * BigInt(untypedCount))
        continue;
      const untypedAmounts =
        untypedCount === 0
          ? []
          : split(
              untypedCapacity,
              untypedCount,
              minimumUntypedCapacity,
              allocator,
              existing.untyped,
            );
      const change: ChangeIntent[] = [
        ...tokenAmounts.map((tokenAmount, index) => ({
          capacity: typedFloors[index],
          tokenAmount,
        })),
        ...untypedAmounts.map((outputCapacity) => ({
          capacity: outputCapacity,
        })),
      ];
      const actualBytes = materializeChange(change, payment, limits).reduce(
        (sum, output) => sum + outputSerializedBytes(output),
        0,
      );
      if (
        actualBytes >
        minimumChangeBytes(selected, payment, limits) +
          shapingByteBudget(payment, limits)
      )
        continue;
      return { inputIds: selected.map((cell) => cell.id), change };
    }
  }
  return undefined;
};

export const makeRemainderPolicy = (allocator: RemainderAllocator): Policy => ({
  id: `largest-first-${allocator.id}-remainder`,
  inventoryTarget: maximumQuantumLanes,
  validationBoundary: "equal-remainder",
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
    const isUntyped = (cell: Cell): boolean =>
      isUntypedCustody(cell, context.limits);
    const isTyped = (cell: Cell): boolean =>
      isPaymentTypeCustody(cell, context.payment, context.limits);
    const unresolved =
      inventory.unresolved?.untyped === true ||
      (context.payment.asset.kind === "xudt" &&
        inventory.unresolved?.paymentType === true);
    let preferredExact: { inputs: Cell[]; plan: PolicyPlan } | undefined;
    if (context.payment.asset.kind === "xudt") {
      const exact = exactTokenSubset(ordered, context.payment);
      if (exact) {
        const selected = [...exact];
        let plan = constructCanonicalPlan(selected, context.payment, context.limits);
        if (plan) preferredExact = { inputs: selected, plan };
        else {
          for (const cell of ordered) {
            if (cell.token !== undefined) continue;
            selected.push(cell);
            plan = constructCanonicalPlan(selected, context.payment, context.limits);
            if (plan) {
              preferredExact = { inputs: selected, plan };
              break;
            }
          }
        }
      }
    }
    const countedUntyped =
      inventory.cells.filter(isUntyped).length +
      context.pendingOutputs.filter((output) =>
        isUntypedCustody(output, context.limits),
      ).length;
    const beforeUntyped = inventory.unresolved?.untyped
      ? Math.max(target, countedUntyped)
      : countedUntyped;
    const countedTyped =
      inventory.cells.filter(isTyped).length +
      context.pendingOutputs.filter((output) =>
        isPaymentTypeCustody(output, context.payment, context.limits),
      ).length;
    const beforeTyped = inventory.unresolved?.paymentType
      ? Math.max(target, countedTyped)
      : countedTyped;
    const respectsCeiling = (inputs: Cell[], plan: PolicyPlan): boolean => {
      const afterUntyped =
        Math.max(0, beforeUntyped - inputs.filter(isUntyped).length) +
        plan.change.filter((output) => output.tokenAmount === undefined).length;
      if (afterUntyped > Math.max(target, beforeUntyped)) return false;
      if (context.payment.asset.kind === "native") return true;
      const afterTyped =
        Math.max(0, beforeTyped - inputs.filter(isTyped).length) +
        plan.change.filter((output) => output.tokenAmount !== undefined).length;
      return afterTyped <= Math.max(target, beforeTyped);
    };
    if (unresolved) {
      const cover: Cell[] = [];
      for (const cell of ordered) {
        cover.push(cell);
        const plan = constructCanonicalPlan(cover, context.payment, context.limits);
        if (plan) return respectsCeiling(cover, plan) ? plan : undefined;
      }
      return undefined;
    }
    if (
      preferredExact &&
      respectsCeiling(preferredExact.inputs, preferredExact.plan)
    )
      return preferredExact.plan;
    const desired = (inputs: Cell[]): { typed: number; untyped: number } => {
      const consumed = new Set(inputs.map((input) => input.id));
      const remainingUntyped =
        inventory.cells.filter(
          (cell) => !consumed.has(cell.id) && isUntyped(cell),
        ).length +
        context.pendingOutputs.filter((output) =>
          isUntypedCustody(output, context.limits),
        ).length;
      if (context.payment.asset.kind === "native")
        return { typed: 0, untyped: Math.max(1, target - remainingUntyped) };
      const remainingTyped =
        inventory.cells.filter(
          (cell) => !consumed.has(cell.id) && isTyped(cell),
        ).length +
        context.pendingOutputs.filter((output) =>
          isPaymentTypeCustody(output, context.payment, context.limits),
        ).length;
      return {
        typed: Math.max(1, target - remainingTyped),
        untyped: Math.max(1, target - remainingUntyped),
      };
    };
    const existing = (inputs: Cell[]) => {
      const consumed = new Set(inputs.map((input) => input.id));
      return {
        typed: inventory.cells
          .filter((cell) => !consumed.has(cell.id) && isTyped(cell))
          .map((cell) => cell.token?.amount ?? 0n),
        untyped: inventory.cells
          .filter((cell) => !consumed.has(cell.id) && isUntyped(cell))
          .map((cell) => cell.capacity),
      };
    };

    const cover: Cell[] = [];
    let plan: PolicyPlan | undefined;
    let next = 0;
    for (; next < ordered.length; next += 1) {
      cover.push(ordered[next]);
      const outputCounts = desired(cover);
      const candidate = constructEqualRemainderPlan(
        cover,
        context.payment,
        context.limits,
        outputCounts.typed,
        outputCounts.untyped,
        allocator,
        existing(cover),
      );
      if (candidate && respectsCeiling(cover, candidate)) {
        plan = candidate;
        next += 1;
        break;
      }
    }
    if (!plan) return undefined;
    if (
      context.payment.asset.kind === "xudt" &&
      tokenRemainder(cover, context.payment) === 0n
    )
      return plan;

    const padding = ordered
      .slice(next)
      .filter(
        (cell) =>
          (isUntyped(cell) && beforeUntyped > target) ||
          (isTyped(cell) && beforeTyped > target),
      )
      .sort((left, right) =>
        left.capacity === right.capacity
          ? left.id.localeCompare(right.id)
          : left.capacity < right.capacity
            ? -1
            : 1,
      );
    let selected = cover;
    let best = plan;
    for (const cell of padding) {
      const candidateInputs = [...selected, cell];
      const outputCounts = desired(candidateInputs);
      const candidate = constructEqualRemainderPlan(
        candidateInputs,
        context.payment,
        context.limits,
        outputCounts.typed,
        outputCounts.untyped,
        allocator,
        existing(candidateInputs),
      );
      if (candidate && respectsCeiling(candidateInputs, candidate)) {
        selected = candidateInputs;
        best = candidate;
        continue;
      }
      const minimal = constructEqualRemainderPlan(
        candidateInputs,
        context.payment,
        context.limits,
        1,
        1,
        allocator,
        existing(candidateInputs),
      );
      if (!minimal || !respectsCeiling(candidateInputs, minimal)) continue;
      selected = candidateInputs;
      best = minimal;
    }
    return best;
  },
});

export const remainderPolicies = remainderAllocators.map(makeRemainderPolicy);
export const equalRemainder = remainderPolicies[0];
