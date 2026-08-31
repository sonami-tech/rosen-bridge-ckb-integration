import {
  makeRecipient,
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
} from "./model.ts";
import { constructSingleChangePlan } from "./single-change.ts";
import { shapingByteBudget } from "./shaping-budget.ts";

export type RequestedChangeLanes = {
  untyped: number;
  paymentType: number;
};

export type CapacityAllocation = "balanced" | "preserve-untyped";

const sumCapacity = (cells: Cell[]): bigint =>
  cells.reduce((sum, cell) => sum + cell.capacity, 0n);

const tokenRemainder = (cells: Cell[], payment: Payment): bigint =>
  payment.asset.kind === "xudt"
    ? cells.reduce(
        (sum, cell) => sum + paymentTokenAmount(cell, payment),
        0n,
      ) - payment.amount
    : 0n;

export const constructLanePreservingPlan = (
  selected: Cell[],
  payment: Payment,
  profile: PolicyLimits,
  requested: RequestedChangeLanes,
  replayPayment: Payment = payment,
  capacityAllocation: CapacityAllocation = "balanced",
): PolicyPlan | undefined => {
  if (selected.length === 0) return undefined;
  if (
    payment.asset.kind === "native" &&
    selected.some((cell) => cell.token !== undefined)
  )
    return undefined;

  const recipient = makeRecipient(payment);
  const inputCapacity = sumCapacity(selected);
  const tokens = tokenRemainder(selected, payment);
  if (tokens < 0n) return undefined;

  const exact = transactionFee(
    { inputs: selected, recipient, change: [] },
    profile.structural,
  );
  if (tokens === 0n && inputCapacity === recipient.capacity + exact.fee)
    return { inputIds: selected.map((cell) => cell.id), change: [] };

  const consumedUntyped = selected.some((cell) => cell.token === undefined);
  const desiredTyped =
    tokens > 0n ? Math.min(tokens > 1n ? 2 : 1, requested.paymentType) : 0;
  const desiredUntyped = Math.max(
    tokens === 0n ? 1 : 0,
    consumedUntyped ? requested.untyped : 0,
  );
  const minimumTyped = tokens > 0n ? 1 : 0;
  const minimumUntyped = tokens === 0n ? 1 : 0;

  for (let typedCount = desiredTyped; typedCount >= minimumTyped; typedCount -= 1) {
    for (
      let untypedCount = desiredUntyped;
      untypedCount >= minimumUntyped;
      untypedCount -= 1
    ) {
      const typedAmounts = Array.from({ length: typedCount }, (_, index) =>
        tokens / BigInt(typedCount) +
        (BigInt(index) < tokens % BigInt(typedCount) ? 1n : 0n),
      );
      const emptyIntents: ChangeIntent[] = [
        ...typedAmounts.map((tokenAmount) => ({ capacity: 0n, tokenAmount })),
        ...Array.from({ length: untypedCount }, () => ({ capacity: 0n })),
      ];
      if (emptyIntents.length === 0) continue;
      const samples = materializeChange(emptyIntents, payment, profile);
      const fee = transactionFee(
        { inputs: selected, recipient, change: samples },
        profile.structural,
      );
      if (fee.size + 4 > profile.maxTransactionBytes) continue;
      const floors = samples.map(occupiedCapacity);
      const changeCapacity = inputCapacity - recipient.capacity - fee.fee;
      const floorCapacity = floors.reduce((sum, floor) => sum + floor, 0n);
      if (changeCapacity < floorCapacity) continue;
      const baseChangeBytes = outputSerializedBytes(
        materializeChange(
          [tokens > 0n ? { capacity: 0n, tokenAmount: tokens } : { capacity: 0n }],
          payment,
          profile,
        )[0],
      );
      const actualChangeBytes = samples.reduce(
        (sum, output) => sum + outputSerializedBytes(output),
        0,
      );
      if (actualChangeBytes > baseChangeBytes + shapingByteBudget(payment, profile))
        continue;

      const excess = changeCapacity - floorCapacity;
      const preserveUntypedCapacity =
        capacityAllocation === "preserve-untyped" &&
        payment.asset.kind === "xudt" &&
        untypedCount === 1;
      const count = BigInt(emptyIntents.length);
      const intents = emptyIntents.map((intent, index) => ({
        ...intent,
        capacity:
          floors[index] +
          (preserveUntypedCapacity
            ? index === emptyIntents.length - 1
              ? excess
              : 0n
            : excess / count +
              (BigInt(index) < excess % count ? 1n : 0n)),
      }));
      if (typedCount === 2 || (payment.asset.kind === "native" && untypedCount === 2)) {
        const outputs = materializeChange(intents, payment, profile);
        const laneOutputs =
          typedCount === 2
            ? outputs.slice(0, typedCount)
            : outputs.slice(typedCount);
        const untypedOutput = preserveUntypedCapacity
          ? outputs[outputs.length - 1]
          : undefined;
        const replayable = laneOutputs.every((output, index) =>
          constructSingleChangePlan(
            [
              {
                id: `lane-${index}`,
                blockNumber: 0,
                transactionIndex: 0,
                outputIndex: index,
                ...output,
                confirmedAt: 0,
                matureAt: 0,
                eligible: true,
              },
              ...(untypedOutput
                ? [
                    {
                      id: `lane-capacity-${index}`,
                      blockNumber: 0,
                      transactionIndex: 0,
                      outputIndex: outputs.length - 1,
                      ...untypedOutput,
                      confirmedAt: 0,
                      matureAt: 0,
                      eligible: true,
                    },
                  ]
                : []),
            ],
            replayPayment,
            profile,
          ) !== undefined,
        );
        if (!replayable) continue;
      }
      return { inputIds: selected.map((cell) => cell.id), change: intents };
    }
  }
  return undefined;
};
