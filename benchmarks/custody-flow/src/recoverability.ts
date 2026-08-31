import { XUDT_A, makeCell, makePayment } from "./fixtures.ts";
import {
  DEFAULT_PROFILE,
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  policyLimits,
  type BenchmarkProfile,
  type Cell,
  type Payment,
  type ValidationResult,
} from "./model.ts";
import {
  exactEqualRemainderOracle,
  exactOrderQuantumOracle,
} from "./oracle.ts";
import {
  constructEqualRemainderPlan,
  equalRemainder,
  remainderAllocators,
} from "./policies/equal-remainder.ts";
import {
  orderQuantum,
  orderQuantumNoCleanup,
  orderQuantumTriggeredCleanup,
} from "./policies/order-quantum.ts";
import { CandidateView, LaneView, type Policy } from "./policy.ts";
import {
  maximumQuantumLanes,
  xudtMateQuantum,
} from "./quantum-budget.ts";
import { validatePlan } from "./validator.ts";

type Counterexample = {
  typedAmounts: string[];
  untypedCapacities: string[];
  reason: string;
};

export type EqualRemainderRecoverabilityReport = {
  statesEnumerated: number;
  admissiblyPayableStates: number;
  acceptedPlans: number;
  targetRecoverableStates: number;
  targetRecoveredPlans: number;
  unrecoveredStates: number;
  falseNoFitStates: number;
  invalidPlanStates: number;
  nonFloorTypedChangeStates: number;
  counterexamples: Counterexample[];
};

const combinationsWithReplacement = <T>(
  values: T[],
  maximumLength: number,
): T[][] => {
  const result: T[][] = [[]];
  const extend = (prefix: T[], start: number) => {
    if (prefix.length === maximumLength) return;
    for (let index = start; index < values.length; index += 1) {
      const next = [...prefix, values[index]];
      result.push(next);
      extend(next, index);
    }
  };
  extend([], 0);
  return result;
};

const makeState = (
  typedAmounts: bigint[],
  untypedCapacities: bigint[],
  typedFloor: bigint,
): Cell[] => [
  ...typedAmounts.map((amount, index) => {
    const cell = makeCell(`typed-${index}`, 0, index, {
      typeId: XUDT_A.typeId,
      typeBytes: XUDT_A.typeBytes,
      amount,
    });
    cell.capacity = typedFloor;
    return cell;
  }),
  ...untypedCapacities.map((capacity, index) => {
    const cell = makeCell(`untyped-${index}`, 0, typedAmounts.length + index);
    cell.capacity = capacity;
    return cell;
  }),
];

const confirmedInventory = (cells: Cell[], target: number) => ({
  cells,
  queried: true as const,
  target,
});

const project = (cells: Cell[], validation: ValidationResult): Cell[] => {
  if (!validation.ok) return cells;
  const consumed = new Set(validation.plan.inputs.map((cell) => cell.id));
  return [
    ...cells.filter((cell) => !consumed.has(cell.id)),
    ...validation.plan.change.map((output, index): Cell => ({
      id: `change-${index}`,
      blockNumber: 1,
      transactionIndex: 0,
      outputIndex: index,
      capacity: output.capacity,
      token: output.token,
      lockId: output.lockId,
      lockBytes: output.lockBytes,
      typeBytes: output.typeBytes,
      dataBytes: output.dataBytes,
      confirmedAt: 0,
      matureAt: 0,
      eligible: true,
    })),
  ];
};

const usefulPairs = (
  cells: Cell[],
  payment: Payment,
  mate: bigint,
): number =>
  Math.min(
    cells.filter(
      (cell) =>
        cell.token?.typeId === XUDT_A.typeId &&
        cell.token.amount >= payment.amount,
    ).length,
    cells.filter(
      (cell) => cell.token === undefined && cell.capacity >= mate,
    ).length,
  );

const exactEqualRecoveryExists = (
  cells: Cell[],
  payment: Payment,
  profile: BenchmarkProfile,
  target: number,
  mate: bigint,
  typedFloor: bigint,
): boolean => {
  const tokenTotal = cells.reduce(
    (sum, cell) => sum + (cell.token?.amount ?? 0n),
    0n,
  );
  const capacityTotal = cells.reduce((sum, cell) => sum + cell.capacity, 0n);
  if (
    tokenTotal - payment.amount < payment.amount * BigInt(target) ||
    capacityTotal <
      makeRecipient(payment).capacity +
        (typedFloor + mate) * BigInt(target)
  )
    return false;

  const limits = policyLimits(profile);
  const inventory = confirmedInventory(cells, target);
  const upper = 2 ** cells.length;
  for (let mask = 1; mask < upper; mask += 1) {
    const selected = cells.filter((_, index) => (mask & 2 ** index) !== 0);
    for (let typed = 1; typed <= target; typed += 1) {
      for (let untyped = 0; untyped <= target; untyped += 1) {
        const plan = constructEqualRemainderPlan(
          selected,
          payment,
          limits,
          typed,
          untyped,
          remainderAllocators[0],
        );
        if (!plan) continue;
        const validation = validatePlan(payment, plan, cells, profile, 0, {
          boundary: "equal-remainder",
          confirmedInventory: inventory,
        });
        if (
          validation.ok &&
          usefulPairs(project(cells, validation), payment, mate) >= target
        )
          return true;
      }
    }
  }
  return false;
};

const runInventoryShapingRecoverabilityProof = (
  policy: Policy,
  paymentId: string,
  profile: BenchmarkProfile,
): EqualRemainderRecoverabilityReport => {
  const payment = makePayment(paymentId, 0, 0, XUDT_A, 100n);
  const limits = policyLimits(profile);
  const target = maximumQuantumLanes(payment, limits);
  const mate = xudtMateQuantum(payment, limits);
  const typedFloor = occupiedCapacity(
    materializeChange(
      [{ capacity: 0n, tokenAmount: 1n }],
      payment,
      limits,
    )[0],
  );
  const untypedFloor = occupiedCapacity(
    materializeChange([{ capacity: 0n }], payment, limits)[0],
  );
  const typedStates = combinationsWithReplacement(
    [1n, 99n, 100n, 200n, 400n],
    4,
  );
  const untypedStates = combinationsWithReplacement(
    [untypedFloor, mate - 1n, mate, mate * 2n, mate * 4n],
    4,
  );
  const report: EqualRemainderRecoverabilityReport = {
    statesEnumerated: 0,
    admissiblyPayableStates: 0,
    acceptedPlans: 0,
    targetRecoverableStates: 0,
    targetRecoveredPlans: 0,
    unrecoveredStates: 0,
    falseNoFitStates: 0,
    invalidPlanStates: 0,
    nonFloorTypedChangeStates: 0,
    counterexamples: [],
  };
  const record = (
    typedAmounts: bigint[],
    untypedCapacities: bigint[],
    reason: string,
  ) => {
    if (report.counterexamples.length >= 20) return;
    report.counterexamples.push({
      typedAmounts: typedAmounts.map(String),
      untypedCapacities: untypedCapacities.map(String),
      reason,
    });
  };

  for (const typedAmounts of typedStates) {
    for (const untypedCapacities of untypedStates) {
      const cells = makeState(typedAmounts, untypedCapacities, typedFloor);
      const inventory = confirmedInventory(cells, target);
      report.statesEnumerated += 1;
      const oracle =
        policy.validationBoundary === "order-quantum"
          ? exactOrderQuantumOracle(
              payment,
              cells,
              profile,
              0,
              inventory,
              [],
            )
          : exactEqualRemainderOracle(
              payment,
              cells,
              profile,
              0,
              inventory,
              [],
            );
      const plan = policy.propose({
        window: 0,
        payment,
        limits,
        candidates: new CandidateView(cells, limits),
        lanes: {
          untyped: new LaneView(
            cells.filter((cell) => cell.token === undefined),
            limits,
          ),
          paymentType: new LaneView(
            cells.filter((cell) => cell.token?.typeId === XUDT_A.typeId),
            limits,
          ),
        },
        confirmedInventory: inventory,
        pendingOutputs: [],
      });
      if (!oracle.adjudicated || !oracle.plan) continue;
      report.admissiblyPayableStates += 1;
      const recoverable = exactEqualRecoveryExists(
        cells,
        payment,
        profile,
        target,
        mate,
        typedFloor,
      );
      if (recoverable) report.targetRecoverableStates += 1;
      if (!plan) {
        report.falseNoFitStates += 1;
        if (recoverable) report.unrecoveredStates += 1;
        record(typedAmounts, untypedCapacities, "heuristic-no-fit");
        continue;
      }
      const validation = validatePlan(payment, plan, cells, profile, 0, {
        boundary: policy.validationBoundary,
        confirmedInventory: inventory,
      });
      if (!validation.ok) {
        report.invalidPlanStates += 1;
        if (recoverable) report.unrecoveredStates += 1;
        record(
          typedAmounts,
          untypedCapacities,
          `invalid:${validation.violations.join(",")}`,
        );
        continue;
      }
      report.acceptedPlans += 1;
      if (usefulPairs(project(cells, validation), payment, mate) >= target)
        report.targetRecoveredPlans += 1;
      else if (recoverable) report.unrecoveredStates += 1;
      if (
        validation.plan.change.some(
          (output) =>
            output.token?.typeId === XUDT_A.typeId &&
            output.capacity !== typedFloor,
        )
      ) {
        report.nonFloorTypedChangeStates += 1;
        record(typedAmounts, untypedCapacities, "typed-change-above-floor");
      }
    }
  }
  return report;
};

export const runEqualRemainderRecoverabilityProof = (
  profile: BenchmarkProfile = DEFAULT_PROFILE,
): EqualRemainderRecoverabilityReport =>
  runInventoryShapingRecoverabilityProof(
    equalRemainder,
    "equal-remainder-recoverability",
    profile,
  );

export const runOrderQuantumRecoverabilityProof = (
  profile: BenchmarkProfile = DEFAULT_PROFILE,
): EqualRemainderRecoverabilityReport =>
  runInventoryShapingRecoverabilityProof(
    orderQuantum,
    "order-quantum-recoverability",
    profile,
  );

export const runOrderQuantumNoCleanupRecoverabilityProof = (
  profile: BenchmarkProfile = DEFAULT_PROFILE,
): EqualRemainderRecoverabilityReport =>
  runInventoryShapingRecoverabilityProof(
    orderQuantumNoCleanup,
    "order-quantum-no-cleanup-recoverability",
    profile,
  );

export const runOrderQuantumTriggeredCleanupRecoverabilityProof = (
  profile: BenchmarkProfile = DEFAULT_PROFILE,
): EqualRemainderRecoverabilityReport =>
  runInventoryShapingRecoverabilityProof(
    orderQuantumTriggeredCleanup,
    "order-quantum-triggered-cleanup-recoverability",
    profile,
  );
