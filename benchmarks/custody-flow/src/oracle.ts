import type {
  BenchmarkProfile,
  Cell,
  ChangeOutput,
  ConfirmedInventorySnapshot,
  Payment,
  PolicyPlan,
} from "./model.ts";
import { policyLimits } from "./model.ts";
import { constructCanonicalPlan } from "./canonical-change.ts";
import { validatePlan } from "./validator.ts";
import { respectsOrderQuantumCeiling } from "./policies/order-quantum.ts";

export type OracleResult =
  | { adjudicated: true; plan?: PolicyPlan; subsetsChecked: number }
  | { adjudicated: false; reason: string; subsetsChecked: 0 };

export const exactCanonicalOracle = (
  payment: Payment,
  readableCells: Cell[],
  profile: BenchmarkProfile,
  window: number,
): OracleResult => {
  if (readableCells.length > profile.oracleCandidateLimit)
    return {
      adjudicated: false,
      reason: `candidate-count-exceeds-exact-limit:${profile.oracleCandidateLimit}`,
      subsetsChecked: 0,
    };
  if (readableCells.length > 30)
    throw new Error("exact oracle bit mask requires at most 30 candidates");

  let subsetsChecked = 0;
  const upper = 2 ** readableCells.length;
  for (let mask = 1; mask < upper; mask += 1) {
    const selected: Cell[] = [];
    for (let index = 0; index < readableCells.length; index += 1) {
      if ((mask & 2 ** index) !== 0) selected.push(readableCells[index]);
    }
    subsetsChecked += 1;
    const plan = constructCanonicalPlan(selected, payment, policyLimits(profile));
    if (!plan) continue;
    if (validatePlan(payment, plan, readableCells, profile, window).ok)
      return { adjudicated: true, plan, subsetsChecked };
  }
  return { adjudicated: true, subsetsChecked };
};

export const exactQuantumMinimalOracle = (
  payment: Payment,
  readableCells: Cell[],
  profile: BenchmarkProfile,
  window: number,
  confirmedInventory: ConfirmedInventorySnapshot,
): OracleResult => {
  if (readableCells.length > profile.oracleCandidateLimit)
    return {
      adjudicated: false,
      reason: `candidate-count-exceeds-exact-limit:${profile.oracleCandidateLimit}`,
      subsetsChecked: 0,
    };
  if (readableCells.length > 30)
    throw new Error("exact oracle bit mask requires at most 30 candidates");

  let subsetsChecked = 0;
  const upper = 2 ** readableCells.length;
  for (let mask = 1; mask < upper; mask += 1) {
    const selected = readableCells.filter(
      (_, index) => (mask & 2 ** index) !== 0,
    );
    subsetsChecked += 1;
    const plan = constructCanonicalPlan(
      selected,
      payment,
      policyLimits(profile),
    );
    if (!plan) continue;
    if (
      validatePlan(payment, plan, readableCells, profile, window, {
        boundary: "damped-quantum",
        confirmedInventory,
      }).ok
    )
      return { adjudicated: true, plan, subsetsChecked };
  }
  return { adjudicated: true, subsetsChecked };
};

export const exactEqualRemainderOracle = (
  payment: Payment,
  readableCells: Cell[],
  profile: BenchmarkProfile,
  window: number,
  confirmedInventory: ConfirmedInventorySnapshot,
  pendingOutputs: ChangeOutput[],
): OracleResult => {
  if (readableCells.length > profile.oracleCandidateLimit)
    return {
      adjudicated: false,
      reason: `candidate-count-exceeds-exact-limit:${profile.oracleCandidateLimit}`,
      subsetsChecked: 0,
    };
  if (readableCells.length > 30)
    throw new Error("exact oracle bit mask requires at most 30 candidates");
  let subsetsChecked = 0;
  const upper = 2 ** readableCells.length;
  for (let mask = 1; mask < upper; mask += 1) {
    const selected = readableCells.filter(
      (_, index) => (mask & 2 ** index) !== 0,
    );
    subsetsChecked += 1;
    const plan = constructCanonicalPlan(
      selected,
      payment,
      policyLimits(profile),
    );
    if (!plan) continue;
    const validation = validatePlan(payment, plan, readableCells, profile, window, {
      boundary: "equal-remainder",
      confirmedInventory: { ...confirmedInventory, pendingOutputs },
    });
    if (!validation.ok) continue;
    return { adjudicated: true, plan, subsetsChecked };
  }
  return { adjudicated: true, subsetsChecked };
};

export const exactOrderQuantumOracle = (
  payment: Payment,
  readableCells: Cell[],
  profile: BenchmarkProfile,
  window: number,
  confirmedInventory: ConfirmedInventorySnapshot,
  pendingOutputs: ChangeOutput[],
): OracleResult => {
  if (readableCells.length > profile.oracleCandidateLimit)
    return {
      adjudicated: false,
      reason: `candidate-count-exceeds-exact-limit:${profile.oracleCandidateLimit}`,
      subsetsChecked: 0,
    };
  if (readableCells.length > 30)
    throw new Error("exact oracle bit mask requires at most 30 candidates");
  const limits = policyLimits(profile);
  let subsetsChecked = 0;
  const upper = 2 ** readableCells.length;
  for (let mask = 1; mask < upper; mask += 1) {
    const selected = readableCells.filter(
      (_, index) => (mask & 2 ** index) !== 0,
    );
    subsetsChecked += 1;
    const plan = constructCanonicalPlan(selected, payment, limits);
    if (
      !plan ||
      !respectsOrderQuantumCeiling(
        selected,
        plan,
        payment,
        limits,
        confirmedInventory,
        pendingOutputs,
      )
    )
      continue;
    if (
      validatePlan(payment, plan, readableCells, profile, window, {
        boundary: "order-quantum",
      }).ok
    )
      return { adjudicated: true, plan, subsetsChecked };
  }
  return { adjudicated: true, subsetsChecked };
};
