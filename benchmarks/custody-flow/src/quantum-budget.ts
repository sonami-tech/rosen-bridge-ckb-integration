import {
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  outputSerializedBytes,
  transactionFee,
  type ChangeOutput,
  type Payment,
  type PolicyLimits,
} from "./model.ts";
import { shapingByteBudget } from "./shaping-budget.ts";

const fakeInput = (output: ChangeOutput, index: number) => ({
  id: `quantum-input-${index}`,
  blockNumber: 0,
  transactionIndex: 0,
  outputIndex: index,
  ...output,
  confirmedAt: 0,
  matureAt: 0,
  eligible: true,
});

const untypedSample = (payment: Payment, profile: PolicyLimits): ChangeOutput =>
  materializeChange([{ capacity: 0n }], payment, profile)[0];

const typedSample = (payment: Payment, profile: PolicyLimits): ChangeOutput =>
  materializeChange([{ capacity: 0n, tokenAmount: 1n }], payment, profile)[0];

export const nativeQuantum = (
  payment: Payment,
  profile: PolicyLimits,
): bigint => {
  const change = untypedSample(payment, profile);
  change.capacity = occupiedCapacity(change);
  const fee = transactionFee(
    {
      inputs: [fakeInput(change, 0)],
      recipient: makeRecipient(payment),
      change: [change],
    },
    profile.structural,
  ).fee;
  return payment.amount + change.capacity + fee;
};

export const xudtMateQuantum = (
  payment: Payment,
  profile: PolicyLimits,
): bigint => {
  if (payment.asset.kind !== "xudt")
    throw new Error("xUDT mate quantum requires an xUDT payment");
  const typed = typedSample(payment, profile);
  typed.capacity = occupiedCapacity(typed);
  typed.token!.amount = payment.amount + 1n;
  const untyped = untypedSample(payment, profile);
  untyped.capacity = occupiedCapacity(untyped);
  const fee = transactionFee(
    {
      inputs: [fakeInput(typed, 0), fakeInput(untyped, 1)],
      recipient: makeRecipient(payment),
      change: [
        { ...typed, token: { ...typed.token!, amount: 1n } },
        untyped,
      ],
    },
    profile.structural,
  ).fee;
  return payment.recipientCapacity + untyped.capacity + fee;
};

export const maximumQuantumLanes = (
  payment: Payment,
  profile: PolicyLimits,
): number => {
  const untypedBytes = outputSerializedBytes(untypedSample(payment, profile));
  const typedBytes = outputSerializedBytes(typedSample(payment, profile));
  const laneBytes = payment.asset.kind === "native"
    ? untypedBytes
    : untypedBytes + typedBytes;
  const baselineBytes = payment.asset.kind === "native" ? untypedBytes : typedBytes;
  return Math.max(
    1,
    Math.floor(
      (baselineBytes + shapingByteBudget(payment, profile)) / laneBytes,
    ),
  );
};

export const provisionalInventoryTarget = (
  payment: Payment,
  profile: PolicyLimits,
): number => maximumQuantumLanes(payment, profile);
