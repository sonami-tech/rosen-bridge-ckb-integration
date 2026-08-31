import {
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  transactionSize,
  type Cell,
  type ChangeOutput,
  type Payment,
  type PolicyLimits,
} from "./model.ts";

const custodyOutput = (
  payment: Payment,
  profile: PolicyLimits,
  typed: boolean,
): ChangeOutput => {
  const output = materializeChange(
    [typed ? { capacity: 0n, tokenAmount: 1n } : { capacity: 0n }],
    payment,
    profile,
  )[0];
  output.capacity = occupiedCapacity(output);
  return output;
};

const templateInput = (
  output: ChangeOutput,
  index: number,
): Cell => ({
  id: `template-input-${index}`,
  blockNumber: 0,
  transactionIndex: 0,
  outputIndex: index,
  ...output,
  confirmedAt: 0,
  matureAt: 0,
  eligible: true,
});

export const shapingByteBudget = (
  payment: Payment,
  profile: PolicyLimits,
): number => {
  if (profile.shapingBudget === "unbounded") return Number.MAX_SAFE_INTEGER;
  const untyped = custodyOutput(payment, profile, false);
  const typed =
    payment.asset.kind === "xudt"
      ? custodyOutput(payment, profile, true)
      : undefined;
  const change = typed ? [typed, untyped] : [untyped];
  // Two native inputs model the smallest complete payment that also funds change.
  const inputs = typed
    ? [templateInput(typed, 0), templateInput(untyped, 1)]
    : [templateInput(untyped, 0), templateInput(untyped, 1)];
  return transactionSize(
    { inputs, recipient: makeRecipient(payment), change },
    profile.structural,
  );
};
