import {
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  outputSerializedBytes,
  paymentTokenAmount,
  transactionFee,
  type BenchmarkProfile,
  type Cell,
  type ChangeOutput,
  type ConfirmedInventorySnapshot,
  type Payment,
  type PolicyLimits,
  type PolicyPlan,
  type SizedPlan,
  type ValidationResult,
} from "./model.ts";
import {
  decomposeBoundedValueInputs,
  evaluateIdentityCeilings,
  isPaymentTypeCustody,
  isUntypedCustody,
  orderBoundedValueCells,
} from "./custody-policy.ts";
import { constructCanonicalPlan } from "./canonical-change.ts";
import {
  maximumQuantumLanes,
  nativeQuantum,
  xudtMateQuantum,
} from "./quantum-budget.ts";
import { constructQuantumMinimalPlan } from "./quantum-change.ts";
import { shapingByteBudget } from "./shaping-budget.ts";

const sumCapacity = (values: { capacity: bigint }[]): bigint =>
  values.reduce((sum, value) => sum + value.capacity, 0n);

const tokenAmount = (
  values: { token?: { typeId: string; amount: bigint } }[],
  typeId: string,
): bigint =>
  values.reduce(
    (sum, value) =>
      sum + (value.token?.typeId === typeId ? value.token.amount : 0n),
    0n,
  );

export const minimumChangeTemplateBytes = (
  payment: Payment,
  profile: PolicyLimits,
  typed: boolean,
): number =>
  outputSerializedBytes(
    materializeChange(
      [typed ? { capacity: 0n, tokenAmount: 1n } : { capacity: 0n }],
      payment,
      profile,
    )[0],
  );

export const minimumChangeBytes = (
  inputs: Cell[],
  payment: Payment,
  profile: PolicyLimits,
): number => {
  const recipient = makeRecipient(payment);
  const noChange: SizedPlan = { inputs, recipient, change: [] };
  const exactFee = transactionFee(noChange, profile.structural).fee;
  const inputCapacity = sumCapacity(inputs);
  const tokenRemainder =
    payment.asset.kind === "xudt"
      ? tokenAmount(inputs, payment.asset.typeId) - payment.amount
      : 0n;
  if (
    tokenRemainder === 0n &&
    inputCapacity === recipient.capacity + exactFee
  )
    return 0;
  return minimumChangeTemplateBytes(payment, profile, tokenRemainder > 0n);
};

export const validatePayment = (
  payment: Payment,
  custodyLockId?: string,
): string[] => {
  const violations: string[] = [];
  const recipient = makeRecipient(payment);
  if (payment.amount <= 0n) violations.push("nonpositive-payment");
  if (recipient.capacity < occupiedCapacity(recipient))
    violations.push("recipient-below-floor");
  if (payment.asset.kind === "native" && payment.recipientDataBytes !== 0)
    violations.push("native-recipient-data");
  if (payment.asset.kind === "xudt" && payment.recipientDataBytes !== 16)
    violations.push("xudt-recipient-data");
  if (custodyLockId !== undefined && payment.recipientLockId === custodyLockId)
    violations.push("forbidden-custody-destination");
  return violations;
};

export type PlanValidationOptions = {
  boundary?: "damped-quantum" | "equal-remainder" | "order-quantum";
  confirmedInventory?: ConfirmedInventorySnapshot;
};

export const validateDampedQuantumBoundary = (
  payment: Payment,
  inputs: Cell[],
  change: ChangeOutput[],
  profile: PolicyLimits,
  options: PlanValidationOptions,
): string[] => {
  if (!options.confirmedInventory) return ["missing-confirmed-inventory"];
  if (
    !Number.isSafeInteger(options.confirmedInventory.target) ||
    options.confirmedInventory.target < 0
  )
    return ["invalid-inventory-target"];
  const violations: string[] = [];
  const generationLimit = maximumQuantumLanes(payment, profile);
  const target = options.confirmedInventory.target;
  let reducedOverTargetInventory = false;
  const isUntyped = (value: Cell | ChangeOutput): boolean =>
    isUntypedCustody(value, profile);
  const isPaymentType = (value: Cell | ChangeOutput): boolean =>
    isPaymentTypeCustody(value, payment, profile);
  const usefulLanes = (values: (Cell | ChangeOutput)[]): number => {
    if (payment.asset.kind === "native") {
      const quantum = nativeQuantum(payment, profile);
      return values.filter((value) => isUntyped(value) && value.capacity >= quantum)
        .length;
    }
    const typed = values.filter(
      (value) =>
        isPaymentType(value) && (value.token?.amount ?? 0n) >= payment.amount,
    ).length;
    const mate = xudtMateQuantum(payment, profile);
    const untyped = values.filter(
      (value) => isUntyped(value) && value.capacity >= mate,
    ).length;
    return Math.min(typed, untyped);
  };

  const ceiling = evaluateIdentityCeilings(
    options.confirmedInventory.cells,
    inputs,
    change,
    payment,
    profile,
    target,
  );
  reducedOverTargetInventory = ceiling.reduced;
  if (ceiling.exceeded) violations.push("inventory-growth-ceiling");
  const fragmentedSubquantumChange =
    payment.asset.kind === "native"
      ? change.filter(
          (output) =>
            isUntyped(output) &&
            output.capacity < nativeQuantum(payment, profile),
        ).length > 1
      : change.filter(
            (output) =>
              isPaymentType(output) &&
              (output.token?.amount ?? 0n) < payment.amount,
          ).length > 1 ||
        change.filter(
          (output) =>
            isUntyped(output) &&
            output.capacity < xudtMateQuantum(payment, profile),
        ).length > 1;
  if (fragmentedSubquantumChange)
    violations.push("fragmented-subquantum-change");
  const exactTokenInput =
    payment.asset.kind === "xudt" &&
    inputs.reduce(
      (sum, cell) => sum + paymentTokenAmount(cell, payment),
      0n,
    ) === payment.amount;
  if (
    exactTokenInput &&
    (change.length > 1 || (change.length === 1 && !isUntyped(change[0])))
  )
    violations.push("invalid-exact-token-change");
  if (
    payment.asset.kind === "xudt" &&
    change.filter(isUntyped).length >
      change.filter(
        (output) =>
          isPaymentType(output) &&
          (output.token?.amount ?? 0n) >= payment.amount,
      ).length +
        1
  )
    violations.push("unpaired-untyped-change");

  const { ordered } = decomposeBoundedValueInputs(
    inputs,
    payment,
    profile,
  );
  let coverLength = 0;
  let coverPlan: PolicyPlan | undefined;
  for (let length = 1; length <= ordered.length; length += 1) {
    const candidate = constructQuantumMinimalPlan(
      ordered.slice(0, length),
      payment,
      profile,
    );
    if (!candidate) continue;
    coverLength = length;
    coverPlan = candidate;
    break;
  }
  if (!coverPlan) {
    violations.push("invalid-payment-cover");
    return violations;
  }

  const repair = ordered.slice(coverLength);
  const unresolved =
    options.confirmedInventory.unresolved?.untyped === true ||
    (payment.asset.kind === "xudt" &&
      options.confirmedInventory.unresolved?.paymentType === true);
  if (target === 0 || unresolved) {
    const minimal = constructQuantumMinimalPlan(
      ordered.slice(0, coverLength),
      payment,
      profile,
    );
    const expected = minimal
      ? materializeChange(minimal.change, payment, profile)
      : undefined;
    const isCanonicalMinimal =
      repair.length === 0 &&
      expected !== undefined &&
      change.length === expected.length &&
      change.every((output, index) => {
        const canonical = expected[index];
        return (
          output.capacity === canonical.capacity &&
          output.lockId === canonical.lockId &&
          output.lockBytes === canonical.lockBytes &&
          output.typeBytes === canonical.typeBytes &&
          output.dataBytes === canonical.dataBytes &&
          output.token?.typeId === canonical.token?.typeId &&
          output.token?.amount === canonical.token?.amount
        );
      });
    if (!isCanonicalMinimal)
      violations.push(
        target === 0
          ? "target-zero-nonminimal"
          : "unresolved-inventory-nonminimal",
      );
  }
  if (repair.length === 0) return violations;
  if (change.length > inputs.length)
    violations.push("repair-inventory-growth");

  if (payment.asset.kind === "native") {
    const quantum = nativeQuantum(payment, profile);
    if (
      repair.length > generationLimit ||
      repair.some((cell) => !isUntyped(cell) || cell.capacity >= quantum)
    )
      violations.push("invalid-repair-inputs");
  } else {
    const mate = xudtMateQuantum(payment, profile);
    const typedRepair = repair.filter(isPaymentType);
    const untypedRepair = repair.filter(isUntyped);
    const fullTypedRepair = typedRepair.filter(
      (cell) => (cell.token?.amount ?? 0n) >= payment.amount,
    ).length;
    const fullUntypedRepair = untypedRepair.filter(
      (cell) => cell.capacity >= mate,
    ).length;
    if (
      typedRepair.length > generationLimit ||
      untypedRepair.length > generationLimit ||
      typedRepair.length + untypedRepair.length !== repair.length ||
      fullTypedRepair > change.filter(isPaymentType).length ||
      fullUntypedRepair > change.filter(isUntyped).length
    )
      violations.push("invalid-repair-inputs");
    const restoredReplacementPairs = Math.min(
      fullTypedRepair,
      fullUntypedRepair,
    );
    if (
      usefulLanes(change) <
      Math.min(
        generationLimit,
        usefulLanes(materializeChange(coverPlan.change, payment, profile)) +
          restoredReplacementPairs,
      )
    )
      violations.push("replacement-lanes-not-restored");
  }

  const coverChange = materializeChange(coverPlan.change, payment, profile);
  if (
    usefulLanes(change) <= usefulLanes(coverChange) &&
    !reducedOverTargetInventory
  )
    violations.push("unproductive-repair-inputs");

  if (usefulLanes(change) === 0)
    violations.push("repair-did-not-restore-lane");
  return violations;
};

export const validateEqualRemainderBoundary = (
  payment: Payment,
  inputs: Cell[],
  change: ChangeOutput[],
  profile: PolicyLimits,
  options: PlanValidationOptions,
): string[] => {
  const inventory = options.confirmedInventory;
  if (!inventory) return ["missing-confirmed-inventory"];
  if (!Number.isSafeInteger(inventory.target) || inventory.target < 0)
    return ["invalid-inventory-target"];
  const violations: string[] = [];
  const target = inventory.target;
  const pending = inventory.pendingOutputs ?? [];
  const isUntyped = (value: Cell | ChangeOutput): boolean =>
    isUntypedCustody(value, profile);
  const isTyped = (value: Cell | ChangeOutput): boolean =>
    isPaymentTypeCustody(value, payment, profile);
  const exceedsCeiling = (
    accepts: (value: Cell | ChangeOutput) => boolean,
    unresolved: boolean,
  ): boolean => {
    const counted =
      inventory.cells.filter(accepts).length + pending.filter(accepts).length;
    const before = unresolved ? Math.max(target, counted) : counted;
    const after =
      Math.max(0, before - inputs.filter(accepts).length) +
      change.filter(accepts).length;
    return after > Math.max(target, before);
  };
  if (exceedsCeiling(isUntyped, inventory.unresolved?.untyped === true))
    violations.push("inventory-growth-ceiling");
  if (
    payment.asset.kind === "xudt" &&
    exceedsCeiling(isTyped, inventory.unresolved?.paymentType === true)
  )
    violations.push("inventory-growth-ceiling");
  const ordered = orderBoundedValueCells(inputs, payment, profile);
  let coverLength = 0;
  let coverPlan: PolicyPlan | undefined;
  for (let length = 1; length <= ordered.length; length += 1) {
    coverPlan = constructCanonicalPlan(ordered.slice(0, length), payment, profile);
    if (!coverPlan) continue;
    coverLength = length;
    break;
  }
  const unresolved =
    inventory.unresolved?.untyped === true ||
    (payment.asset.kind === "xudt" &&
      inventory.unresolved?.paymentType === true);
  if ((target === 0 || unresolved) && coverPlan) {
    const expected = materializeChange(coverPlan.change, payment, profile);
    const canonical =
      inputs.length === coverLength &&
      change.length === expected.length &&
      change.every((output, index) => {
        const value = expected[index];
        return (
          output.capacity === value.capacity &&
          output.lockId === value.lockId &&
          output.lockBytes === value.lockBytes &&
          output.typeBytes === value.typeBytes &&
          output.dataBytes === value.dataBytes &&
          output.token?.typeId === value.token?.typeId &&
          output.token?.amount === value.token?.amount
        );
      });
    if (!canonical)
      violations.push(
        target === 0
          ? "target-zero-nonminimal"
          : "unresolved-inventory-nonminimal",
      );
  }
  return violations;
};

export const validateOrderQuantumBoundary = (
  payment: Payment,
  inputs: Cell[],
  change: ChangeOutput[],
  profile: PolicyLimits,
): string[] => {
  const violations: string[] = [];
  const target = maximumQuantumLanes(payment, profile);
  const untyped = change.filter((output) => isUntypedCustody(output, profile));
  const typed = change.filter((output) =>
    isPaymentTypeCustody(output, payment, profile),
  );
  if (untyped.length > target || typed.length > target)
    violations.push("shaping-output-limit");
  const nearlyEqual = (values: bigint[]): boolean => {
    if (values.length < 2) return true;
    const ordered = values.toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return ordered[ordered.length - 1] - ordered[0] <= 1n;
  };
  if (
    untyped.length > 1 &&
    (!untyped.every(
      (output) =>
        output.capacity >=
        (payment.asset.kind === "native"
          ? nativeQuantum(payment, profile)
          : xudtMateQuantum(payment, profile)),
    ) ||
      !nearlyEqual(untyped.map((output) => output.capacity)))
  )
    violations.push("invalid-untyped-shaping");
  if (
    typed.length > 1 &&
    (!typed.every((output) => (output.token?.amount ?? 0n) >= payment.amount) ||
      !nearlyEqual(typed.map((output) => output.token?.amount ?? 0n)))
  )
    violations.push("invalid-typed-shaping");
  const ordered = orderBoundedValueCells(inputs, payment, profile);
  let coverLength = 0;
  let coverPlan: PolicyPlan | undefined;
  for (let length = 1; length <= ordered.length; length += 1) {
    coverPlan = constructCanonicalPlan(ordered.slice(0, length), payment, profile);
    if (!coverPlan) continue;
    coverLength = length;
    break;
  }
  if (!coverPlan) return [...violations, "invalid-payment-cover"];
  const recipient = makeRecipient(payment);
  const baseSize = transactionFee(
    {
      inputs: ordered.slice(0, coverLength),
      recipient,
      change: materializeChange(coverPlan.change, payment, profile),
    },
    profile.structural,
  ).size;
  const actualSize = transactionFee(
    { inputs, recipient, change },
    profile.structural,
  ).size;
  if (actualSize - baseSize > shapingByteBudget(payment, profile))
    violations.push("shaping-byte-allowance");
  return violations;
};

export const validatePlan = (
  payment: Payment,
  candidatePlan: unknown,
  readableCells: Cell[],
  profile: BenchmarkProfile,
  window: number,
  options: PlanValidationOptions = {},
): ValidationResult => {
  if (
    !candidatePlan ||
    typeof candidatePlan !== "object" ||
    !Array.isArray((candidatePlan as PolicyPlan).inputIds) ||
    !(candidatePlan as PolicyPlan).inputIds.every((id) => typeof id === "string") ||
    !Array.isArray((candidatePlan as PolicyPlan).change) ||
    !(candidatePlan as PolicyPlan).change.every(
      (intent) =>
        intent &&
        typeof intent === "object" &&
        typeof intent.capacity === "bigint" &&
        (intent.tokenAmount === undefined || typeof intent.tokenAmount === "bigint"),
    )
  )
    return {
      ok: false,
      violations: ["malformed-plan"],
      fee: 0n,
      size: 0,
    };
  const plan = candidatePlan as PolicyPlan;
  const violations = validatePayment(payment, profile.custodyLockId);
  const byId = new Map(readableCells.map((cell) => [cell.id, cell]));
  const inputs: Cell[] = [];
  const seen = new Set<string>();

  for (const id of plan.inputIds) {
    if (seen.has(id)) {
      violations.push(`duplicate-input:${id}`);
      continue;
    }
    seen.add(id);
    const cell = byId.get(id);
    if (!cell) {
      violations.push(`unreadable-input:${id}`);
      continue;
    }
    inputs.push(cell);
    if (
      cell.lockId !== profile.custodyLockId ||
      cell.lockBytes !== profile.custodyLockBytes
    )
      violations.push(`foreign-custody-lock:${id}`);
    if (!cell.eligible || cell.confirmedAt > window || cell.matureAt > window)
      violations.push(`ineligible-input:${id}`);
    if (cell.reservedUntil !== undefined && cell.reservedUntil > window)
      violations.push(`reserved-input:${id}`);
    if (payment.asset.kind === "native") {
      if (cell.token !== undefined || cell.typeBytes !== 0 || cell.dataBytes !== 0)
        violations.push(`invalid-native-input:${id}`);
    } else if (cell.token === undefined) {
      if (cell.typeBytes !== 0 || cell.dataBytes !== 0)
        violations.push(`invalid-capacity-input:${id}`);
    } else if (
      cell.token.typeId !== payment.asset.typeId ||
      cell.typeBytes !== payment.asset.typeBytes ||
      cell.dataBytes !== 16
    ) {
      violations.push(`foreign-or-malformed-type-input:${id}`);
    }
  }

  for (const [index, intent] of plan.change.entries()) {
    if (payment.asset.kind === "native" && intent.tokenAmount !== undefined)
      violations.push(`typed-native-change:${index}`);
    if (intent.tokenAmount !== undefined && intent.tokenAmount <= 0n)
      violations.push(`nonpositive-token-change:${index}`);
  }
  const recipient = makeRecipient(payment);
  const change = materializeChange(plan.change, payment, profile);
  const sizedPlan: SizedPlan = { inputs, recipient, change };
  const { fee, size } = transactionFee(sizedPlan, profile.structural);

  for (const [index, output] of change.entries()) {
    const floor = occupiedCapacity(output);
    if (output.capacity < floor)
      violations.push(`change-below-floor:${index}`);
    if (output.token !== undefined && output.capacity !== floor)
      violations.push("typed-change-not-at-floor");
  }

  if (sumCapacity(inputs) !== recipient.capacity + sumCapacity(change) + fee)
    violations.push("capacity-conservation");

  if (payment.asset.kind === "xudt") {
    const inputTokens = tokenAmount(inputs, payment.asset.typeId);
    const outputTokens = payment.amount + tokenAmount(change, payment.asset.typeId);
    if (inputTokens !== outputTokens) violations.push("token-conservation");
  }

  if (size + 4 > profile.maxTransactionBytes)
    violations.push("transaction-size-limit");

  const actualChangeBytes = change.reduce(
    (sum, output) => sum + outputSerializedBytes(output),
    0,
  );
  const baseChangeBytes = minimumChangeBytes(inputs, payment, profile);
  if (actualChangeBytes > baseChangeBytes + shapingByteBudget(payment, profile))
    violations.push("change-byte-allowance");

  if (options.boundary === "damped-quantum")
    violations.push(
      ...validateDampedQuantumBoundary(payment, inputs, change, profile, options),
    );
  if (options.boundary === "equal-remainder")
    violations.push(
      ...validateEqualRemainderBoundary(payment, inputs, change, profile, options),
    );
  if (options.boundary === "order-quantum")
    violations.push(
      ...validateOrderQuantumBoundary(payment, inputs, change, profile),
    );

  return violations.length === 0
    ? { ok: true, fee, size, plan: sizedPlan, intents: structuredClone(plan.change) }
    : { ok: false, violations, fee, size };
};
