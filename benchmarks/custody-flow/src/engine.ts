import {
  compareBlockPosition,
  compareCellId,
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  outputSerializedBytes,
  paymentTokenAmount,
  policyLimits,
  relevantForPayment,
  transactionFee,
  type BenchmarkProfile,
  type Cell,
  type ChangeOutput,
  type ConfirmedInventorySnapshot,
  type Payment,
  type ChangeIntent,
} from "./model.ts";
import {
  isPaymentTypeCustody,
  isUntypedCustody,
} from "./custody-policy.ts";
import {
  exactEqualRemainderOracle,
  exactOrderQuantumOracle,
  exactQuantumMinimalOracle,
  exactCanonicalOracle,
} from "./oracle.ts";
import { CandidateView, LaneView, type Policy } from "./policy.ts";
import { validatePayment, validatePlan } from "./validator.ts";
import { shapingByteBudget } from "./shaping-budget.ts";

export type LifecycleResult =
  | "success"
  | "signing-delay"
  | "signing-failure"
  | "rpc-rejection"
  | "conflict"
  | "ambiguous-restart"
  | "cycle-rejection";

export type Deposit = { window: number; cell: Cell };
export type BurstKind =
  | "cold"
  | "warm"
  | "collapse-matched"
  | "collapse-overrun"
  | "capacity-migration"
  | "mixed-capacity-demand"
  | "exact-cover-erosion";

export type Scenario = {
  id: string;
  windows: number;
  exactGate: boolean;
  cells: Cell[];
  deposits?: Deposit[];
  payments: Payment[];
  burstWindow?: number;
  burstKind?: BurstKind;
  lifecycle?: Record<string, LifecycleResult[]>;
  ambiguousResolution?: Record<
    string,
    { kind: "confirm" } | { kind: "release"; window: number }
  >;
  maximumPerIdentityNetCellGrowth?: number;
};

export type OutcomeKind =
  | "invalid-order"
  | "invalid-proposal"
  | "aggregate-shortage"
  | "reservation-shortage"
  | "size-or-structural-infeasibility"
  | "intrinsic-no-fit"
  | "policy-no-fit"
  | "accepted"
  | "confirmed"
  | "censored";

export type PaymentOutcome = {
  paymentId: string;
  attempt: number;
  window: number;
  kind: OutcomeKind;
  lifecycle?: LifecycleResult;
  submitted?: boolean;
  fundability?: "proven" | "disproven" | "unproven";
  cellsRead: number;
  pagesRead: number;
  details?: string[];
  fee?: bigint;
  size?: number;
  inputCount?: number;
  changeCount?: number;
  inputIds?: string[];
  change?: ChangeIntent[];
};

export type SimulationMetrics = {
  arrived: number;
  accepted: number;
  admitted: number;
  confirmed: number;
  invalidProposals: number;
  exactMisses: number;
  unprovenNoFits: number;
  totalFee: bigint;
  totalBytes: number;
  totalInputs: number;
  totalChangeOutputs: number;
  cellsRead: number;
  pagesRead: number;
  peakProjectedCells: number;
  finalProjectedCells: number;
  peakPendingCells: number;
  finalPendingCells: number;
  policyNetCellGrowth: number;
  burstArrived: number;
  burstAccepted: number;
  burstImmediate: number;
  burstImmediateByAsset: { native: number; xudt: number };
  backlogMaximum: number;
  backlogArea: number;
  waits: number[];
};

export type SimulationResult = {
  scenarioId: string;
  policyId: string;
  profileId: string;
  burstKind?: BurstKind;
  eligible: boolean;
  gateFailures: string[];
  outcomes: PaymentOutcome[];
  metrics: SimulationMetrics;
  finalCells: Cell[];
};

type PendingTransaction = {
  payment: Payment;
  inputs: Cell[];
  change: ChangeOutput[];
  visibleAt: number;
  confirmAt: number;
};

const metricsFor = (scenario: Scenario): SimulationMetrics => ({
  arrived: scenario.payments.length,
  accepted: 0,
  admitted: 0,
  confirmed: 0,
  invalidProposals: 0,
  exactMisses: 0,
  unprovenNoFits: 0,
  totalFee: 0n,
  totalBytes: 0,
  totalInputs: 0,
  totalChangeOutputs: 0,
  cellsRead: 0,
  pagesRead: 0,
  peakProjectedCells: scenario.cells.length,
  finalProjectedCells: scenario.cells.length,
  peakPendingCells: 0,
  finalPendingCells: 0,
  policyNetCellGrowth: 0,
  burstArrived:
    scenario.burstWindow === undefined
      ? 0
      : scenario.payments.filter(
          (payment) => payment.arrivalWindow === scenario.burstWindow,
        ).length,
  burstAccepted: 0,
  burstImmediate: 0,
  burstImmediateByAsset: { native: 0, xudt: 0 },
  backlogMaximum: 0,
  backlogArea: 0,
  waits: [],
});

const lifecycleFor = (
  scenario: Scenario,
  paymentId: string,
  signedAttempt: number,
): LifecycleResult =>
  scenario.lifecycle?.[paymentId]?.[signedAttempt - 1] ?? "success";

const unboundedProfile = (profile: BenchmarkProfile): BenchmarkProfile => ({
  ...structuredClone(profile),
  id: `${profile.id}:unbounded`,
  maxTransactionBytes: Number.MAX_SAFE_INTEGER,
  shapingBudget: "unbounded",
});

const exactValueFeasibility = (
  payment: Payment,
  cells: Cell[],
  profile: BenchmarkProfile,
): { adjudicated: boolean; feasible: boolean } => {
  if (cells.length > profile.oracleCandidateLimit)
    return { adjudicated: false, feasible: false };
  const recipient = makeRecipient(payment);
  const upper = 2 ** cells.length;
  for (let mask = 1; mask < upper; mask += 1) {
    const selected = cells.filter((_, index) => (mask & 2 ** index) !== 0);
    const capacity = selected.reduce((sum, cell) => sum + cell.capacity, 0n);
    const tokenRemainder =
      payment.asset.kind === "xudt"
        ? selected.reduce(
            (sum, cell) => sum + paymentTokenAmount(cell, payment),
            0n,
          ) - payment.amount
        : 0n;
    if (tokenRemainder < 0n) continue;
    const change =
      tokenRemainder > 0n
        ? materializeChange(
            [{ capacity: 0n, tokenAmount: tokenRemainder }],
            payment,
            profile,
          )
        : [];
    const fee = transactionFee(
      { inputs: selected, recipient, change },
      profile.structural,
    ).fee;
    const floor = change.reduce((sum, output) => sum + occupiedCapacity(output), 0n);
    if (capacity >= recipient.capacity + floor + fee)
      return { adjudicated: true, feasible: true };
  }
  return { adjudicated: true, feasible: false };
};

export const assertExactGateCoverage = (
  scenario: Scenario,
  profile: BenchmarkProfile,
): void => {
  if (!scenario.exactGate) return;
  if (profile.shapingBudget === "unbounded")
    throw new Error(`${scenario.id}: exact gate cannot use unbounded change`);
  const initial = [...scenario.cells, ...(scenario.deposits ?? []).map((item) => item.cell)];
  const maximumChangeOutputs = scenario.payments.map((producer) => {
    const untyped = materializeChange([{ capacity: 0n }], producer, profile)[0];
    const minimumBytes = outputSerializedBytes(untyped);
    const baselineBytes =
      producer.asset.kind === "xudt"
        ? outputSerializedBytes(
            materializeChange(
              [{ capacity: 0n, tokenAmount: 1n }],
              producer,
              profile,
            )[0],
          )
        : minimumBytes;
    return Math.floor(
      (baselineBytes + shapingByteBudget(producer, policyLimits(profile))) /
        minimumBytes,
    );
  });
  for (const payment of scenario.payments) {
    const relevant = initial.filter((cell) => relevantForPayment(cell, payment)).length;
    const reachable =
      relevant + maximumChangeOutputs.reduce((sum, count) => sum + count - 1, 0);
    if (reachable > profile.oracleCandidateLimit)
      throw new Error(
        `${scenario.id}: exact gate can reach ${reachable} relevant cells, limit ${profile.oracleCandidateLimit}`,
      );
  }
};

const classifyNoPlan = (
  payment: Payment,
  allPrefix: Cell[],
  availablePrefix: Cell[],
  profile: BenchmarkProfile,
  window: number,
  completePrefix: boolean,
  boundary: Policy["validationBoundary"],
  confirmedInventory?: ConfirmedInventorySnapshot,
  pendingOutputs: ChangeOutput[] = [],
): {
  kind: Exclude<OutcomeKind, "invalid-order" | "invalid-proposal" | "accepted" | "confirmed" | "censored">;
  fundability: "proven" | "disproven" | "unproven";
} => {
  const available = exactCanonicalOracle(
    payment,
    availablePrefix,
    profile,
    window,
  );
  const admissible =
    boundary === "order-quantum"
      ? confirmedInventory
        ? exactOrderQuantumOracle(
            payment,
            availablePrefix,
            profile,
            window,
            confirmedInventory,
            pendingOutputs,
          )
        : available
      : boundary === "equal-remainder"
        ? confirmedInventory
          ? exactEqualRemainderOracle(
              payment,
              availablePrefix,
              profile,
              window,
              confirmedInventory,
              pendingOutputs,
            )
          : available
        : boundary === "damped-quantum" && confirmedInventory
          ? exactQuantumMinimalOracle(
              payment,
              availablePrefix,
              profile,
              window,
              confirmedInventory,
            )
          : available;
  const aggregateValue = exactValueFeasibility(payment, allPrefix, profile);
  const availableValue = exactValueFeasibility(payment, availablePrefix, profile);
  if (
    completePrefix &&
    aggregateValue.adjudicated &&
    !aggregateValue.feasible
  )
    return { kind: "aggregate-shortage", fundability: "disproven" };
  if (
    completePrefix &&
    aggregateValue.feasible &&
    availableValue.adjudicated &&
    !availableValue.feasible
  )
    return { kind: "reservation-shortage", fundability: "disproven" };

  const withoutLimits = exactCanonicalOracle(
    payment,
    availablePrefix,
    unboundedProfile(profile),
    window,
  );
  if (
    withoutLimits.adjudicated &&
    withoutLimits.plan &&
    available.adjudicated &&
    !available.plan
  )
    return {
      kind: "size-or-structural-infeasibility",
      fundability: "disproven",
    };
  if (
    completePrefix &&
    availableValue.feasible &&
    admissible.adjudicated &&
    !admissible.plan
  )
    return { kind: "intrinsic-no-fit", fundability: "disproven" };
  return {
    kind: "policy-no-fit",
    fundability:
      admissible.adjudicated && admissible.plan ? "proven" : "unproven",
  };
};

export const runScenario = (
  scenario: Scenario,
  policy: Policy,
  profile: BenchmarkProfile,
): SimulationResult => {
  if (profile.candidateLimit > profile.pageLimit * profile.pageSize)
    throw new Error(`${profile.id}: candidate limit exceeds readable page budget`);
  assertExactGateCoverage(scenario, profile);
  let cells = structuredClone(scenario.cells).sort(compareBlockPosition);
  const outcomes: PaymentOutcome[] = [];
  const metrics = metricsFor(scenario);
  const laneKey = (value: Cell | ChangeOutput): string | undefined => {
    if (
      value.lockId !== profile.custodyLockId ||
      value.lockBytes !== profile.custodyLockBytes
    )
      return undefined;
    if (
      value.token === undefined &&
      value.typeBytes === 0 &&
      value.dataBytes === 0
    )
      return "untyped";
    return value.token === undefined
      ? undefined
      : `${value.token.typeId}:${value.typeBytes}:${value.dataBytes}`;
  };
  const initialLaneCounts = new Map<string, number>();
  for (const cell of scenario.cells) {
    const key = laneKey(cell);
    if (key !== undefined)
      initialLaneCounts.set(key, (initialLaneCounts.get(key) ?? 0) + 1);
  }
  const laneGrowth = new Map<string, number>();
  const maximumLaneGrowth = new Map<string, number>();
  const waiting = new Map<string, Payment>();
  const terminal = new Set<string>();
  const attempts = new Map<string, number>();
  const signedAttempts = new Map<string, number>();
  const inventoryTargets = new Map<string, number | null>();
  const deferredUntil = new Map<string, number>();
  const pending: PendingTransaction[] = [];
  const gateFailures: string[] = [];

  for (let window = 0; window < scenario.windows; window += 1) {
    for (const cell of cells) {
      if (cell.reservedUntil !== undefined && cell.reservedUntil <= window)
        cell.reservedUntil = undefined;
    }

    let confirmationTransactionIndex = 0;
    for (const transaction of pending.filter((item) => item.confirmAt === window)) {
      const spent = new Set(transaction.inputs.map((cell) => cell.id));
      cells = cells.filter((cell) => !spent.has(cell.id));
      transaction.change.forEach((output, outputIndex) => {
        cells.push({
          id: `${transaction.payment.id}:change:${outputIndex}`,
          blockNumber: window,
          transactionIndex: confirmationTransactionIndex,
          outputIndex,
          ...structuredClone(output),
          confirmedAt: window,
          matureAt: window,
          eligible: true,
        });
      });
      confirmationTransactionIndex += 1;
      terminal.add(transaction.payment.id);
      metrics.confirmed += 1;
      outcomes.push({
        paymentId: transaction.payment.id,
        attempt: attempts.get(transaction.payment.id) ?? 1,
        window,
        kind: "confirmed",
        cellsRead: 0,
        pagesRead: 0,
      });
    }

    for (const deposit of scenario.deposits ?? []) {
      if (deposit.window === window) cells.push(structuredClone(deposit.cell));
    }
    cells.sort(compareBlockPosition);

    for (const payment of scenario.payments) {
      if (payment.arrivalWindow === window) waiting.set(payment.id, payment);
    }

    const queue = [...waiting.values()].sort(
      (left, right) =>
        left.arrivalWindow - right.arrivalWindow || compareCellId(left, right),
    );
    let signingRounds = 0;
    for (const payment of queue) {
      if (signingRounds >= profile.signingRoundCeiling) break;
      if (terminal.has(payment.id)) continue;
      if ((deferredUntil.get(payment.id) ?? 0) > window) continue;
      const attempt = (attempts.get(payment.id) ?? 0) + 1;
      attempts.set(payment.id, attempt);
      const orderViolations = validatePayment(payment, profile.custodyLockId);
      if (orderViolations.length > 0) {
        terminal.add(payment.id);
        waiting.delete(payment.id);
        outcomes.push({
          paymentId: payment.id,
          attempt,
          window,
          kind: "invalid-order",
          cellsRead: 0,
          pagesRead: 0,
          details: orderViolations,
        });
        continue;
      }

      const allVisible = cells.filter(
        (cell) =>
          cell.eligible && cell.confirmedAt <= window && cell.matureAt <= window,
      );
      const isUntyped = (cell: Cell): boolean =>
        isUntypedCustody(cell, profile);
      const isPaymentType = (cell: Cell): boolean =>
        isPaymentTypeCustody(cell, payment, profile);
      const transactionRelevant = allVisible.filter(
        (cell) => isUntyped(cell) || isPaymentType(cell),
      );
      const authoritativePrefix = transactionRelevant.slice(
        0,
        profile.candidateLimit,
      );
      const isUnreserved = (cell: Cell): boolean =>
        cell.reservedUntil === undefined || cell.reservedUntil <= window;
      const available = authoritativePrefix.filter(isUnreserved);
      const visiblePending = pending.filter(
        (transaction) =>
          transaction.visibleAt <= window && transaction.confirmAt > window,
      );
      const unresolvedPending = pending.filter(
        (transaction) =>
          transaction.visibleAt > window && transaction.confirmAt > window,
      );
      const unresolvedForConstructor =
        policy.validationBoundary === "order-quantum"
          ? [...visiblePending, ...unresolvedPending]
          : unresolvedPending;
      const pendingInputIds = new Set(
        (policy.validationBoundary === "equal-remainder" ||
          policy.validationBoundary === "order-quantum"
          ? [...visiblePending, ...unresolvedPending]
          : visiblePending
        ).flatMap((transaction) =>
          transaction.inputs.map((input) => input.id),
        ),
      );
      const isOrderQuantumInventoryCell = (cell: Cell): boolean =>
        !pendingInputIds.has(cell.id) && isUnreserved(cell);
      const policyInventory =
        policy.validationBoundary === "order-quantum"
          ? transactionRelevant.filter(isOrderQuantumInventoryCell)
          : policy.validationBoundary === "damped-quantum" ||
              policy.validationBoundary === "equal-remainder"
          ? transactionRelevant.filter((cell) => !pendingInputIds.has(cell.id))
          : transactionRelevant.filter(
              isUnreserved,
            );
      const limits = policyLimits(profile);
      const view = new CandidateView(available, limits);
      const untypedLanes = new LaneView(
        policyInventory.filter(isUntyped),
        limits,
      );
      const paymentTypeLanes =
        payment.asset.kind === "xudt"
          ? new LaneView(policyInventory.filter(isPaymentType), limits)
          : undefined;
      const pendingOutputs = structuredClone(
        (policy.validationBoundary === "order-quantum"
          ? [...visiblePending, ...unresolvedPending]
          : visiblePending
        ).flatMap((transaction) => transaction.change),
      );
      if (!inventoryTargets.has(payment.id)) {
        const derivedTarget = policy.inventoryTarget?.(payment, limits);
        inventoryTargets.set(
          payment.id,
          derivedTarget !== undefined &&
            Number.isSafeInteger(derivedTarget) &&
            derivedTarget >= 0
            ? derivedTarget
            : null,
        );
      }
      const inventoryTarget = inventoryTargets.get(payment.id) ?? undefined;
      const constructorInventory = (() => {
        if (
          policy.validationBoundary !== "damped-quantum" &&
          policy.validationBoundary !== "equal-remainder" &&
          policy.validationBoundary !== "order-quantum"
        )
          return { snapshot: undefined, cellsRead: 0, pagesRead: 0 };
        if (inventoryTarget === undefined)
          return { snapshot: undefined, cellsRead: 0, pagesRead: 0 };
        const maximum = inventoryTarget + 1;
        const constructorLimits = {
          ...limits,
          pageSize: maximum,
          candidateLimit: maximum,
          pageLimit: 1,
        };
        const inventoryCells =
          policy.validationBoundary === "order-quantum"
            ? transactionRelevant.filter(isOrderQuantumInventoryCell)
            : policy.validationBoundary === "equal-remainder"
            ? transactionRelevant.filter((cell) => !pendingInputIds.has(cell.id))
            : transactionRelevant;
        const untyped = new LaneView(
          inventoryCells.filter(isUntyped),
          constructorLimits,
        );
        const paymentType =
          payment.asset.kind === "xudt"
              ? new LaneView(
                inventoryCells.filter(isPaymentType),
                constructorLimits,
              )
            : undefined;
        const excluded = new Set<string>();
        const cells = [
          ...untyped.takeUnselected(excluded, maximum, () => true),
          ...(paymentType?.takeUnselected(excluded, maximum, () => true) ?? []),
        ];
        return {
          snapshot: {
            cells,
            pendingOutputs,
            queried: true as const,
            target: inventoryTarget,
            unresolved: {
              untyped: unresolvedForConstructor.some(
                (transaction) =>
                  transaction.inputs.some(isUntyped) ||
                  transaction.change.some((output) =>
                    isUntypedCustody(output, profile),
                  ),
              ),
              paymentType: unresolvedForConstructor.some(
                (transaction) =>
                  transaction.inputs.some(isPaymentType) ||
                  transaction.change.some((output) =>
                    isPaymentTypeCustody(output, payment, profile),
                  ),
              ),
            },
          },
          cellsRead: untyped.cellsRead + (paymentType?.cellsRead ?? 0),
          pagesRead: untyped.pagesRead + (paymentType?.pagesRead ?? 0),
        };
      })();
      const plan = policy.propose({
        window,
        payment: structuredClone(payment),
        limits: structuredClone(limits),
        candidates: view,
        lanes: { untyped: untypedLanes, paymentType: paymentTypeLanes },
        confirmedInventory: structuredClone(constructorInventory.snapshot),
        pendingOutputs: structuredClone(pendingOutputs),
      });
      const cellsRead =
        view.cellsRead +
        untypedLanes.cellsRead +
        (paymentTypeLanes?.cellsRead ?? 0) +
        constructorInventory.cellsRead;
      const pagesRead =
        view.pagesRead +
        untypedLanes.pagesRead +
        (paymentTypeLanes?.pagesRead ?? 0) +
        constructorInventory.pagesRead;
      metrics.cellsRead += cellsRead;
      metrics.pagesRead += pagesRead;

      if (!plan) {
        const allPrefix = authoritativePrefix;
        const availablePrefix = available;
        const classification = classifyNoPlan(
          payment,
          allPrefix,
          availablePrefix,
          profile,
          window,
          transactionRelevant.length <= profile.candidateLimit,
          policy.validationBoundary,
          constructorInventory.snapshot,
          pendingOutputs,
        );
        if (scenario.exactGate && classification.fundability === "unproven")
          throw new Error(`${scenario.id}: exact-gate attempt was not adjudicated`);
        if (classification.fundability === "proven") {
          metrics.exactMisses += 1;
          gateFailures.push(`${payment.id}:exact-oracle-miss:${window}`);
        }
        if (classification.fundability === "unproven")
          metrics.unprovenNoFits += 1;
        outcomes.push({
          paymentId: payment.id,
          attempt,
          window,
          ...classification,
          cellsRead,
          pagesRead,
        });
        continue;
      }

      const validation = validatePlan(
        payment,
        plan,
        [
          ...new Map(
            [
              ...view.readableCells,
              ...untypedLanes.readableCells,
              ...(paymentTypeLanes?.readableCells ?? []),
            ].map((cell) => [cell.id, cell]),
          ).values(),
        ],
        profile,
        window,
        {
          boundary: policy.validationBoundary,
          confirmedInventory:
            policy.validationBoundary === "order-quantum"
              ? undefined
              : structuredClone(constructorInventory.snapshot),
        },
      );
      if (!validation.ok) {
        terminal.add(payment.id);
        waiting.delete(payment.id);
        metrics.invalidProposals += 1;
        gateFailures.push(`${payment.id}:invalid-proposal`);
        outcomes.push({
          paymentId: payment.id,
          attempt,
          window,
          kind: "invalid-proposal",
          cellsRead,
          pagesRead,
          details: validation.violations,
          fee: validation.fee,
          size: validation.size,
        });
        continue;
      }

      signingRounds += 1;
      metrics.admitted += 1;
      const signedAttempt = (signedAttempts.get(payment.id) ?? 0) + 1;
      signedAttempts.set(payment.id, signedAttempt);
      const lifecycle = lifecycleFor(scenario, payment.id, signedAttempt);
      const ambiguousResolution = scenario.ambiguousResolution?.[payment.id];
      if (
        lifecycle === "ambiguous-restart" &&
        ambiguousResolution?.kind === "release"
      )
        deferredUntil.set(payment.id, ambiguousResolution.window);
      const holdUntil =
        lifecycle === "ambiguous-restart" && ambiguousResolution?.kind === "release"
          ? ambiguousResolution.window
          : window + (lifecycle === "conflict" || lifecycle === "ambiguous-restart" ? 2 : 1);
      for (const input of validation.plan.inputs) {
        const cell = cells.find((candidate) => candidate.id === input.id);
        if (cell) cell.reservedUntil = holdUntil;
      }

      const succeeds =
        lifecycle === "success" ||
        lifecycle === "signing-delay" ||
        (lifecycle === "ambiguous-restart" && ambiguousResolution?.kind !== "release");
      if (succeeds) {
        waiting.delete(payment.id);
        const delay = lifecycle === "success" ? 0 : 2;
        const confirmAt = window + delay + profile.confirmationDelay;
        const visibleAt =
          lifecycle === "signing-delay" ? window + 2 : window;
        for (const input of validation.plan.inputs) {
          const cell = cells.find((candidate) => candidate.id === input.id);
          if (cell) cell.reservedUntil = confirmAt;
        }
        pending.push({
          payment,
          inputs: validation.plan.inputs,
          change: validation.plan.change,
          visibleAt,
          confirmAt,
        });
        metrics.accepted += 1;
        metrics.waits.push(window - payment.arrivalWindow);
        metrics.totalFee += validation.fee;
        metrics.totalBytes += validation.size;
        metrics.totalInputs += validation.plan.inputs.length;
        metrics.totalChangeOutputs += validation.plan.change.length;
        metrics.policyNetCellGrowth +=
          validation.plan.change.length - validation.plan.inputs.length;
        if (payment.arrivalWindow === scenario.burstWindow) {
          metrics.burstAccepted += 1;
          if (window === scenario.burstWindow) {
            metrics.burstImmediate += 1;
            metrics.burstImmediateByAsset[payment.asset.kind] += 1;
          }
        }
        for (const value of validation.plan.inputs) {
          const key = laneKey(value);
          if (key !== undefined) laneGrowth.set(key, (laneGrowth.get(key) ?? 0) - 1);
        }
        for (const value of validation.plan.change) {
          const key = laneKey(value);
          if (key !== undefined) {
            const growth = (laneGrowth.get(key) ?? 0) + 1;
            laneGrowth.set(key, growth);
            maximumLaneGrowth.set(
              key,
              Math.max(maximumLaneGrowth.get(key) ?? 0, growth),
            );
          }
        }
      }
      outcomes.push({
        paymentId: payment.id,
        attempt,
        window,
        kind: "accepted",
        lifecycle,
        submitted: succeeds,
        cellsRead,
        pagesRead,
        fee: validation.fee,
        size: validation.size,
        inputCount: validation.plan.inputs.length,
        changeCount: validation.plan.change.length,
        inputIds: validation.plan.inputs.map((input) => input.id),
        change: structuredClone(validation.intents),
      });
    }

    const queued = [...waiting.keys()].filter((id) => !terminal.has(id)).length;
    metrics.backlogMaximum = Math.max(metrics.backlogMaximum, queued);
    metrics.backlogArea += queued;
    const activePending = pending.filter(
      (transaction) => transaction.confirmAt > window,
    );
    const pendingCellCount = activePending.reduce(
      (sum, transaction) => sum + transaction.change.length,
      0,
    );
    const pendingInputIds = new Set(
      activePending.flatMap((transaction) =>
        transaction.inputs.map((input) => input.id),
      ),
    );
    const projectedCellCount =
      cells.filter((cell) => !pendingInputIds.has(cell.id)).length +
      pendingCellCount;
    metrics.peakPendingCells = Math.max(
      metrics.peakPendingCells,
      pendingCellCount,
    );
    metrics.peakProjectedCells = Math.max(
      metrics.peakProjectedCells,
      projectedCellCount,
    );
  }

  for (const payment of waiting.values()) {
    if (terminal.has(payment.id)) continue;
    metrics.waits.push(scenario.windows - payment.arrivalWindow);
    outcomes.push({
      paymentId: payment.id,
      attempt: attempts.get(payment.id) ?? 0,
      window: scenario.windows,
      kind: "censored",
      cellsRead: 0,
      pagesRead: 0,
    });
  }
  const finalPending = pending.filter(
    (transaction) => transaction.confirmAt >= scenario.windows,
  );
  metrics.finalPendingCells = finalPending.reduce(
    (sum, transaction) => sum + transaction.change.length,
    0,
  );
  const finalPendingInputIds = new Set(
    finalPending.flatMap((transaction) =>
      transaction.inputs.map((input) => input.id),
    ),
  );
  metrics.finalProjectedCells =
    cells.filter((cell) => !finalPendingInputIds.has(cell.id)).length +
    metrics.finalPendingCells;
  if (
    scenario.maximumPerIdentityNetCellGrowth !== undefined &&
    policy.inventoryTarget
  ) {
    const policyLaneTargets = new Map<string, number>();
    for (const payment of scenario.payments) {
      const target = inventoryTargets.get(payment.id);
      if (target === undefined || target === null) continue;
      policyLaneTargets.set(
        "untyped",
        Math.max(policyLaneTargets.get("untyped") ?? 0, target),
      );
      if (payment.asset.kind === "xudt") {
        const key = `${payment.asset.typeId}:${payment.asset.typeBytes}:16`;
        policyLaneTargets.set(
          key,
          Math.max(policyLaneTargets.get(key) ?? 0, target),
        );
      }
    }
    for (const [key, growth] of maximumLaneGrowth) {
      const allowed =
        scenario.maximumPerIdentityNetCellGrowth +
        Math.max(
          0,
          (policyLaneTargets.get(key) ?? initialLaneCounts.get(key) ?? 0) -
            (initialLaneCounts.get(key) ?? 0),
        );
      if (growth > allowed)
        gateFailures.push(
          `${scenario.id}:per-identity-net-cell-growth:${growth}>${allowed}:${key}`,
        );
    }
  }
  return {
    scenarioId: scenario.id,
    policyId: policy.id,
    profileId: profile.id,
    burstKind: scenario.burstKind,
    eligible: gateFailures.length === 0,
    gateFailures,
    outcomes,
    metrics,
    finalCells: cells,
  };
};
