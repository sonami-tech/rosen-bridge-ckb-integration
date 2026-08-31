import type {
  Cell,
  ChangeOutput,
  Payment,
  PolicyLimits,
  PolicyPlan,
} from "./model.ts";
import { compareCellId } from "./model.ts";
import { nativeQuantum, xudtMateQuantum } from "./quantum-budget.ts";
import { constructSingleChangePlan } from "./single-change.ts";

type CustodyProfile = Pick<PolicyLimits, "custodyLockId" | "custodyLockBytes">;

export const isUntypedCustody = (
  value: Cell | ChangeOutput,
  profile: CustodyProfile,
): boolean =>
  value.lockId === profile.custodyLockId &&
  value.lockBytes === profile.custodyLockBytes &&
  value.token === undefined &&
  value.typeBytes === 0 &&
  value.dataBytes === 0;

export const isPaymentTypeCustody = (
  value: Cell | ChangeOutput,
  payment: Payment,
  profile: CustodyProfile,
): boolean =>
  payment.asset.kind === "xudt" &&
  value.lockId === profile.custodyLockId &&
  value.lockBytes === profile.custodyLockBytes &&
  value.token?.typeId === payment.asset.typeId &&
  value.typeBytes === payment.asset.typeBytes &&
  value.dataBytes === 16;

export const evaluateIdentityCeilings = (
  confirmed: Cell[],
  inputs: Cell[],
  change: ChangeOutput[],
  payment: Payment,
  profile: CustodyProfile,
  target: number,
): { exceeded: boolean; reduced: boolean } => {
  let exceeded = false;
  let reduced = false;
  const check = (accepts: (value: Cell | ChangeOutput) => boolean): void => {
    const acceptedInputIds = new Set(
      inputs.filter(accepts).map((input) => input.id),
    );
    const beforeIds = new Set(
      confirmed.filter(accepts).map((cell) => cell.id),
    );
    for (const inputId of acceptedInputIds) beforeIds.add(inputId);
    const before = beforeIds.size;
    const after =
      before - acceptedInputIds.size + change.filter(accepts).length;
    if (before > target && after < before) reduced = true;
    if (after > Math.max(target, before)) exceeded = true;
  };
  check((value) => isUntypedCustody(value, profile));
  if (payment.asset.kind === "xudt")
    check((value) => isPaymentTypeCustody(value, payment, profile));
  return { exceeded, reduced };
};

const compareBigintDesc = (left: bigint, right: bigint): number =>
  left === right ? 0 : left > right ? -1 : 1;

export const orderBoundedValueCells = (
  cells: Cell[],
  payment: Payment,
  profile: PolicyLimits,
): Cell[] => {
  const untyped = cells.filter((cell) => isUntypedCustody(cell, profile)).sort(
    (left, right) =>
      compareBigintDesc(left.capacity, right.capacity) ||
      compareCellId(left, right),
  );
  if (payment.asset.kind === "native") return untyped;

  const typed = cells.filter(
    (cell) => isPaymentTypeCustody(cell, payment, profile),
  ).sort(
    (left, right) =>
      compareBigintDesc(left.token?.amount ?? 0n, right.token?.amount ?? 0n) ||
      compareBigintDesc(left.capacity, right.capacity) ||
      compareCellId(left, right),
  );
  let tokenTotal = 0n;
  const covering = typed.filter((cell) => {
    if (tokenTotal >= payment.amount) return false;
    tokenTotal += cell.token?.amount ?? 0n;
    return true;
  });
  const coveringIds = new Set(covering.map((cell) => cell.id));
  const mate = xudtMateQuantum(payment, profile);
  return [
    ...covering,
    ...untyped.filter((cell) => cell.capacity >= mate),
    ...typed.filter((cell) => !coveringIds.has(cell.id)),
    ...untyped.filter((cell) => cell.capacity < mate),
  ];
};

export const isRepairShapedCustody = (
  value: Cell | ChangeOutput,
  payment: Payment,
  profile: PolicyLimits,
): boolean =>
  payment.asset.kind === "native"
    ? isUntypedCustody(value, profile) &&
      value.capacity < nativeQuantum(payment, profile)
    : (isPaymentTypeCustody(value, payment, profile) &&
        (value.token?.amount ?? 0n) < payment.amount) ||
      (isUntypedCustody(value, profile) &&
        value.capacity < xudtMateQuantum(payment, profile));

export const decomposeBoundedValueInputs = (
  inputs: Cell[],
  payment: Payment,
  profile: PolicyLimits,
): { ordered: Cell[]; coverLength: number; coverPlan?: PolicyPlan } => {
  const relevant = orderBoundedValueCells(inputs, payment, profile);
  const relevantIds = new Set(relevant.map((cell) => cell.id));
  const tokenCoverIds = new Set<string>();
  if (payment.asset.kind === "xudt") {
    let tokenTotal = 0n;
    for (const cell of relevant) {
      if (tokenTotal >= payment.amount) break;
      if (!isPaymentTypeCustody(cell, payment, profile)) continue;
      tokenCoverIds.add(cell.id);
      tokenTotal += cell.token?.amount ?? 0n;
    }
  }
  const isRepair = (cell: Cell): boolean =>
    !tokenCoverIds.has(cell.id) &&
    isRepairShapedCustody(cell, payment, profile);
  const ordered = [
    ...relevant.filter((cell) => !isRepair(cell)),
    ...relevant.filter(isRepair),
    ...inputs.filter((cell) => !relevantIds.has(cell.id)),
  ];
  for (let length = 1; length <= ordered.length; length += 1) {
    const coverPlan = constructSingleChangePlan(
      ordered.slice(0, length),
      payment,
      profile,
    );
    if (coverPlan) return { ordered, coverLength: length, coverPlan };
  }
  return { ordered, coverLength: ordered.length };
};
