import {
  makeRecipient,
  isPaymentToken,
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

export const constructCanonicalPlan = (
  selected: Cell[],
  payment: Payment,
  profile: PolicyLimits,
): PolicyPlan | undefined => {
  if (selected.length === 0) return undefined;
  if (
    payment.asset.kind === "native" &&
    selected.some((cell) => cell.token !== undefined)
  )
    return undefined;
  if (
    payment.asset.kind === "xudt" &&
    selected.some(
      (cell) =>
        cell.token !== undefined && !isPaymentToken(cell, payment),
    )
  )
    return undefined;

  const recipient = makeRecipient(payment);
  const inputCapacity = sumCapacity(selected);
  const tokenRemainder =
    payment.asset.kind === "xudt"
      ? selected.reduce(
          (sum, cell) => sum + paymentTokenAmount(cell, payment),
          0n,
        ) - payment.amount
      : 0n;
  if (tokenRemainder < 0n) return undefined;

  const typedIntent: ChangeIntent | undefined =
    tokenRemainder > 0n
      ? { capacity: 0n, tokenAmount: tokenRemainder }
      : undefined;
  const typedSample = typedIntent
    ? materializeChange([typedIntent], payment, profile)[0]
    : undefined;
  const typedFloor = typedSample ? occupiedCapacity(typedSample) : 0n;
  const typedFloorIntent = typedIntent
    ? { ...typedIntent, capacity: typedFloor }
    : undefined;

  const typedOnlyIntents = typedFloorIntent ? [typedFloorIntent] : [];
  const typedOnlyChange = materializeChange(
    typedOnlyIntents,
    payment,
    profile,
  );
  const typedOnly = transactionFee(
    { inputs: selected, recipient, change: typedOnlyChange },
    profile.structural,
  );
  if (typedOnly.size + 4 > profile.maxTransactionBytes) return undefined;
  const typedOnlySurplus =
    inputCapacity - recipient.capacity - typedFloor - typedOnly.fee;
  if (typedOnlySurplus < 0n) return undefined;
  if (typedOnlySurplus === 0n)
    return {
      inputIds: selected.map((cell) => cell.id),
      change: typedOnlyIntents,
    };

  const untypedSample = materializeChange(
    [{ capacity: 0n }],
    payment,
    profile,
  )[0];
  const untypedFloor = occupiedCapacity(untypedSample);
  const splitSamples = materializeChange(
    [...typedOnlyIntents, { capacity: untypedFloor }],
    payment,
    profile,
  );
  const split = transactionFee(
    { inputs: selected, recipient, change: splitSamples },
    profile.structural,
  );
  const splitSurplus =
    inputCapacity - recipient.capacity - typedFloor - split.fee;
  if (
    split.size + 4 <= profile.maxTransactionBytes &&
    splitSurplus >= untypedFloor
  )
    return {
      inputIds: selected.map((cell) => cell.id),
      change: [
        ...typedOnlyIntents,
        { capacity: splitSurplus },
      ],
    };

  return undefined;
};
