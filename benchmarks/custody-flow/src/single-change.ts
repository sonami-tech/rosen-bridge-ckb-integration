import {
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  paymentTokenAmount,
  transactionFee,
  type Cell,
  type ChangeIntent,
  type Payment,
  type PolicyLimits,
  type PolicyPlan,
} from "./model.ts";

const sumCapacity = (cells: Cell[]): bigint =>
  cells.reduce((sum, cell) => sum + cell.capacity, 0n);

export const constructSingleChangePlan = (
  selected: Cell[],
  payment: Payment,
  profile: PolicyLimits,
): PolicyPlan | undefined => {
  if (selected.length === 0) return undefined;
  const recipient = makeRecipient(payment);
  const inputCapacity = sumCapacity(selected);
  if (
    payment.asset.kind === "native" &&
    selected.some((cell) => cell.token !== undefined)
  )
    return undefined;

  const tokenRemainder =
    payment.asset.kind === "xudt"
      ? selected.reduce(
          (sum, cell) => sum + paymentTokenAmount(cell, payment),
          0n,
        ) - payment.amount
      : 0n;
  if (tokenRemainder < 0n) return undefined;

  const exact = transactionFee(
    { inputs: selected, recipient, change: [] },
    profile.structural,
  );
  if (
    tokenRemainder === 0n &&
    inputCapacity === recipient.capacity + exact.fee
  )
    return exact.size + 4 <= profile.maxTransactionBytes
      ? { inputIds: selected.map((cell) => cell.id), change: [] }
      : undefined;

  const intent: ChangeIntent =
    tokenRemainder > 0n
      ? { capacity: 0n, tokenAmount: tokenRemainder }
      : { capacity: 0n };
  const sample = materializeChange([intent], payment, profile)[0];
  const { fee, size } = transactionFee(
    { inputs: selected, recipient, change: [sample] },
    profile.structural,
  );
  if (size + 4 > profile.maxTransactionBytes) return undefined;
  const capacity = inputCapacity - recipient.capacity - fee;
  if (capacity < occupiedCapacity(sample)) return undefined;
  return {
    inputIds: selected.map((cell) => cell.id),
    change: [{ ...intent, capacity }],
  };
};
