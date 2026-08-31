import {
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  outputSerializedBytes,
  paymentTokenAmount,
  transactionFee,
  type Cell,
  type Payment,
  type PolicyLimits,
  type PolicyPlan,
} from "./model.ts";
import {
  maximumQuantumLanes,
  nativeQuantum,
  xudtMateQuantum,
} from "./quantum-budget.ts";
import { constructCanonicalPlan } from "./canonical-change.ts";
import { shapingByteBudget } from "./shaping-budget.ts";
import { minimumChangeBytes } from "./validator.ts";

const sumCapacity = (cells: Cell[]): bigint =>
  cells.reduce((sum, cell) => sum + cell.capacity, 0n);

const tokenRemainder = (cells: Cell[], payment: Payment): bigint =>
  payment.asset.kind === "xudt"
    ? cells.reduce(
        (sum, cell) => sum + paymentTokenAmount(cell, payment),
        0n,
      ) - payment.amount
    : 0n;

export const constructQuantumMinimalPlan = (
  selected: Cell[],
  payment: Payment,
  profile: PolicyLimits,
): PolicyPlan | undefined => constructCanonicalPlan(selected, payment, profile);

export const constructQuantumPlan = (
  selected: Cell[],
  payment: Payment,
  profile: PolicyLimits,
  desiredLanes: number,
): PolicyPlan | undefined => {
  if (selected.length === 0 || desiredLanes < 1) return undefined;
  if (
    payment.asset.kind === "native" &&
    selected.some((cell) => cell.token !== undefined)
  )
    return undefined;

  const recipient = makeRecipient(payment);
  const inputCapacity = sumCapacity(selected);
  const tokens = tokenRemainder(selected, payment);
  if (tokens < 0n) return undefined;
  if (
    payment.asset.kind === "xudt" &&
    tokens > 0n &&
    tokens < payment.amount
  )
    return undefined;
  const exact = transactionFee(
    { inputs: selected, recipient, change: [] },
    profile.structural,
  );
  if (
    tokens === 0n &&
    inputCapacity === recipient.capacity + exact.fee &&
    exact.size + 4 <= profile.maxTransactionBytes
  )
    return { inputIds: selected.map((cell) => cell.id), change: [] };

  for (let lanes = desiredLanes; lanes >= 1; lanes -= 1) {
    const typedCount = payment.asset.kind === "xudt" && tokens > 0n ? lanes : 0;
    if (
      typedCount > 1 &&
      tokens < payment.amount * BigInt(typedCount)
    )
      continue;
    const tokenAmounts = Array.from({ length: typedCount }, (_, index) =>
      index === typedCount - 1
        ? tokens - payment.amount * BigInt(typedCount - 1)
        : payment.amount,
    );
    const untypedCount = typedCount > 0 ? typedCount : lanes;
    const emptyIntents = [
      ...tokenAmounts.map((tokenAmount) => ({ capacity: 0n, tokenAmount })),
      ...Array.from({ length: untypedCount }, () => ({ capacity: 0n })),
    ];
    const samples = materializeChange(emptyIntents, payment, profile);
    const fee = transactionFee(
      { inputs: selected, recipient, change: samples },
      profile.structural,
    );
    if (fee.size + 4 > profile.maxTransactionBytes) continue;
    const floors = samples.map(occupiedCapacity);
    const changeCapacity = inputCapacity - recipient.capacity - fee.fee;
    const typedCapacity = floors
      .slice(0, typedCount)
      .reduce((sum, floor) => sum + floor, 0n);
    const untypedCapacity = changeCapacity - typedCapacity;
    const untypedFloors = floors.slice(typedCount);
    if (untypedCapacity < untypedFloors.reduce((sum, floor) => sum + floor, 0n))
      continue;

    const quantum =
      payment.asset.kind === "native"
        ? nativeQuantum(payment, profile)
        : xudtMateQuantum(payment, profile);
    if (untypedCapacity < quantum * BigInt(untypedCount))
      continue;
    const intents = emptyIntents.map((intent, index) => {
      if (index < typedCount)
        return { ...intent, capacity: floors[index] };
      const untypedIndex = index - typedCount;
      return {
        ...intent,
        capacity:
          untypedIndex === untypedCount - 1
            ? untypedCapacity - quantum * BigInt(untypedCount - 1)
            : quantum,
      };
    });
    const baseBytes = minimumChangeBytes(selected, payment, profile);
    const actualBytes = materializeChange(intents, payment, profile).reduce(
      (sum, output) => sum + outputSerializedBytes(output),
      0,
    );
    if (actualBytes > baseBytes + shapingByteBudget(payment, profile)) continue;
    return { inputIds: selected.map((cell) => cell.id), change: intents };
  }
  return undefined;
};
