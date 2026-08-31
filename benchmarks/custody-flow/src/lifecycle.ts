import {
  isPaymentTypeCustody,
  isUntypedCustody,
} from "./custody-policy.ts";
import {
  compareBlockPosition,
  isPaymentToken,
  materializeChange,
  policyLimits,
  type BenchmarkProfile,
  type Cell,
  type Payment,
  type PolicyPlan,
} from "./model.ts";
import { CandidateView, LaneView } from "./policy.ts";
import { orderQuantum } from "./policies/order-quantum.ts";
import { maximumQuantumLanes } from "./quantum-budget.ts";

export const LIFECYCLE = {
  stepMs: 1_000,
  proposerSlotMs: 180_000,
  proposerActiveMs: 120_000,
  agreementDrainMs: 5_000,
  processorMs: 60_000,
  tssRoundMs: 60_000,
  tssFreshLimit: 5,
  tssScope: "bridge-wide-ecdsa" as const,
  tssTimeoutMs: 600_000,
  blockMs: 9_300,
  deepBlocks: 150,
} as const;

export type CellProvenance = "seed" | "deposit" | "guard-change";

export type LifecycleCell = Cell & {
  provenance: CellProvenance;
  indexedAt: number;
  deepAt: number;
  blockedUntil?: number;
  spentAt?: number;
};

export type LifecycleRequest = {
  id: string;
  arrivalAt: number;
  payment: Payment;
};

export type InventoryEvent = {
  at: number;
  reason: "deposit" | "cold-storage" | "manual-replenishment";
  add?: LifecycleCell[];
  removeIds?: string[];
};

export type LifecycleProfile = {
  id: string;
  transactionProfile: BenchmarkProfile;
  durationMs: number;
  constructionMs: number;
  agreementLatencyMs: number;
  processorOffsetMs: number;
  tssOffsetMs: number;
  signingMs: number;
  commitDelaysMs: number[];
  indexerLagMs: number;
  externalTssSlots?: number[];
  stalledRequestIds?: string[];
};

export type LifecycleScenario = {
  id: string;
  cells: LifecycleCell[];
  requests: LifecycleRequest[];
  inventoryEvents?: InventoryEvent[];
};

type Stage =
  | "candidate"
  | "agreement"
  | "approved"
  | "tss-queued"
  | "signing"
  | "signed"
  | "broadcast"
  | "committed";

type Transaction = {
  id: string;
  request: LifecycleRequest;
  inputIds: string[];
  plan: PolicyPlan;
  stage: Stage;
  generatedAt: number;
  activeEnd: number;
  approvalDueAt?: number;
  approvedAt?: number;
  tssQueuedAt?: number;
  signDueAt?: number;
  signedAt?: number;
  broadcastAt?: number;
  commitAt?: number;
};

type ResourceStats = {
  supplied: number;
  maxReserved: number;
  maxUnavailable: number;
  maxErosion: number;
  maxRequired: number;
  minCanonical: number;
  minVisible: number;
  minCapacity: bigint;
  minQuantity?: bigint;
};

export type LifecycleReport = {
  scenario: string;
  profile: string;
  assumptions: typeof LIFECYCLE & {
    transactionProfile: BenchmarkProfile;
    constructionMs: number;
    agreementLatencyMs: number;
    commitDelaysMs: number[];
    indexerLagMs: number;
  };
  stages: Record<
    | "arrived"
    | "candidate"
    | "agreementStarted"
    | "candidateExpired"
    | "approved"
    | "tssQueued"
    | "tssAdmitted"
    | "tssTimedOut"
    | "signed"
    | "broadcast"
    | "committed"
    | "indexed",
    number
  >;
  queues: {
    maxPayments: number;
    maxCandidates: number;
    maxTss: number;
    censoredPayments: number;
  };
  noFit: Record<string, number>;
  inventoryEvents: {
    scheduled: number;
    applied: number;
  };
  tss: {
    rounds: number;
    admittedByRound: number[];
    externalSlotsByRound: number[];
    headBlockedJobRounds: number;
  };
  latencyMs: {
    arrivalToCandidate: number[];
    approvalToTss: number[];
    tssQueue: number[];
    broadcastToCommit: number[];
    commitToIndexer: number[];
    endToEnd: number[];
  };
  inventory: Record<
    string,
    Omit<ResourceStats, "minCapacity" | "minQuantity"> & {
      minCapacity: string;
      minQuantity?: string;
    }
  >;
  completedRequestIds: string[];
};

const resourceId = (cell: Pick<Cell, "token">): string =>
  cell.token ? `typed:${cell.token.typeId}` : "untyped";

const activeEndAt = (now: number): number =>
  now - (now % LIFECYCLE.proposerSlotMs) + LIFECYCLE.proposerActiveMs;

const inActiveTurn = (now: number): boolean =>
  now % LIFECYCLE.proposerSlotMs < LIFECYCLE.proposerActiveMs;

const toModelCell = (cell: LifecycleCell): Cell => ({
  ...cell,
  confirmedAt: cell.indexedAt,
  matureAt: cell.deepAt,
});

const makeResourceStats = (): ResourceStats => ({
  supplied: 0,
  maxReserved: 0,
  maxUnavailable: 0,
  maxErosion: 0,
  maxRequired: 0,
  minCanonical: Number.POSITIVE_INFINITY,
  minVisible: Number.POSITIVE_INFINITY,
  minCapacity: 2n ** 255n,
});

const percentileSort = (values: number[]): number[] =>
  values.slice().sort((left, right) => left - right);

export const runLifecycleScenario = (
  scenario: LifecycleScenario,
  profile: LifecycleProfile,
): LifecycleReport => {
  const transactionLimits = policyLimits(profile.transactionProfile);
  const cells = scenario.cells.map((cell) => structuredClone(cell));
  const requests = scenario.requests
    .map((request) => structuredClone(request))
    .sort((left, right) =>
      left.arrivalAt - right.arrivalAt || left.id.localeCompare(right.id),
    );
  const events = (scenario.inventoryEvents ?? [])
    .map((event) => structuredClone(event))
    .sort((left, right) => left.at - right.at);
  const transactions = new Map<string, Transaction>();
  const reserved = new Map<string, string>();
  const paymentQueue: LifecycleRequest[] = [];
  const completed = new Set<string>();
  const resourceStats = new Map<string, ResourceStats>();
  const suppliedByResource = new Map<string, number>();
  const indexedTransactions = new Set<string>();
  let requestCursor = 0;
  let eventCursor = 0;
  let appliedInventoryEvents = 0;
  let changeSequence = 0;
  let broadcastSequence = 0;
  let nextConstructionAt = 0;
  let tssRound = 0;

  const stages: LifecycleReport["stages"] = {
    arrived: 0,
    candidate: 0,
    agreementStarted: 0,
    candidateExpired: 0,
    approved: 0,
    tssQueued: 0,
    tssAdmitted: 0,
    tssTimedOut: 0,
    signed: 0,
    broadcast: 0,
    committed: 0,
    indexed: 0,
  };
  const queues = {
    maxPayments: 0,
    maxCandidates: 0,
    maxTss: 0,
    censoredPayments: 0,
  };
  const noFit: Record<string, number> = {};
  const admittedByRound: number[] = [];
  const externalSlotsByRound: number[] = [];
  let headBlockedJobRounds = 0;
  const latencyMs: LifecycleReport["latencyMs"] = {
    arrivalToCandidate: [],
    approvalToTss: [],
    tssQueue: [],
    broadcastToCommit: [],
    commitToIndexer: [],
    endToEnd: [],
  };

  const markSupplied = (cell: LifecycleCell) => {
    const resource = resourceId(cell);
    suppliedByResource.set(resource, (suppliedByResource.get(resource) ?? 0) + 1);
  };
  cells.forEach(markSupplied);

  const eligibleUniverse = (
    payment: Payment,
    now: number,
  ): { typed: LifecycleCell[]; untyped: LifecycleCell[] } => {
    const visible = cells
      .filter(
        (cell) =>
          cell.spentAt === undefined &&
          cell.indexedAt <= now &&
          cell.eligible,
      )
      .sort(compareBlockPosition);
    const completeIdentity = (filter: (cell: LifecycleCell) => boolean) => {
      const matching = visible.filter(filter);
      return matching.filter(
        (cell) =>
          !reserved.has(cell.id) &&
          (cell.blockedUntil === undefined || cell.blockedUntil <= now),
      );
    };
    return {
      typed:
        payment.asset.kind === "xudt"
          ? completeIdentity((cell) => isPaymentToken(cell, payment))
          : [],
      untyped: completeIdentity((cell) => cell.token === undefined),
    };
  };

  const constructFrom = (
    request: LifecycleRequest,
    now: number,
  ):
    | { plan: PolicyPlan; selected: LifecycleCell[]; pass: "deep" | "shallow" }
    | undefined => {
    const views = eligibleUniverse(request.payment, now);
    const tryPass = (allowShallow: boolean) => {
      const admitted = (cell: LifecycleCell) =>
        cell.deepAt <= now ||
        (allowShallow && cell.provenance === "guard-change");
      const candidates = [...views.typed, ...views.untyped]
        .filter(admitted)
        .map(toModelCell);
      const pendingTransactions = [...transactions.values()]
        .filter(
          (tx) =>
            tx.stage !== "candidate" &&
            tx.stage !== "agreement" &&
            (tx.stage !== "committed" || !indexedTransactions.has(tx.id)),
        )
        .map((tx) => ({
          tx,
          inputs: tx.inputIds
            .map((id) => cells.find((cell) => cell.id === id))
            .filter((cell): cell is LifecycleCell => cell !== undefined),
          outputs: materializeChange(
            tx.plan.change,
            tx.request.payment,
            transactionLimits,
          ),
        }));
      const pendingOutputs = pendingTransactions.flatMap(({ outputs }) => outputs);
      const unresolvedTransactions = pendingTransactions.filter(
        ({ tx }) => tx.stage !== "committed",
      );
      const unresolved = {
        untyped: unresolvedTransactions.some(
          ({ inputs, outputs }) =>
            inputs.some((cell) => isUntypedCustody(cell, transactionLimits)) ||
            outputs.some((output) =>
              isUntypedCustody(output, transactionLimits),
            ),
        ),
        paymentType:
          request.payment.asset.kind === "xudt" &&
          unresolvedTransactions.some(
            ({ inputs, outputs }) =>
              inputs.some((cell) =>
                isPaymentTypeCustody(
                  cell,
                  request.payment,
                  transactionLimits,
                ),
              ) ||
              outputs.some((output) =>
                isPaymentTypeCustody(
                  output,
                  request.payment,
                  transactionLimits,
                ),
              ),
          ),
      };
      const target = maximumQuantumLanes(request.payment, transactionLimits);
      const visibleInventory = cells
        .filter(
          (cell) =>
            cell.spentAt === undefined &&
            cell.indexedAt <= now &&
            cell.eligible &&
            !reserved.has(cell.id),
        )
        .map(toModelCell);
      const inventoryCells = [
        ...visibleInventory
          .filter((cell) => isUntypedCustody(cell, transactionLimits))
          .slice(0, target + 1),
        ...visibleInventory
          .filter((cell) =>
            isPaymentTypeCustody(cell, request.payment, transactionLimits),
          )
          .slice(0, target + 1),
      ];
      const plan = orderQuantum.propose({
        window: now,
        payment: request.payment,
        limits: transactionLimits,
        candidates: new CandidateView(candidates, transactionLimits),
        lanes: {
          untyped: new LaneView(
            candidates.filter((cell) =>
              isUntypedCustody(cell, transactionLimits),
            ),
            transactionLimits,
          ),
          paymentType:
            request.payment.asset.kind === "xudt"
              ? new LaneView(
                  candidates.filter((cell) =>
                    isPaymentTypeCustody(
                      cell,
                      request.payment,
                      transactionLimits,
                    ),
                  ),
                  transactionLimits,
                )
              : undefined,
        },
        confirmedInventory: {
          cells: inventoryCells,
          pendingOutputs,
          queried: true,
          target,
          unresolved,
        },
        pendingOutputs,
      });
      if (!plan) return undefined;
      const byId = new Map(
        [...views.typed, ...views.untyped].map((cell) => [cell.id, cell]),
      );
      const selected = plan.inputIds.map((id) => byId.get(id));
      if (selected.some((cell) => cell === undefined)) return undefined;
      return {
        plan,
        selected: selected as LifecycleCell[],
        pass: allowShallow ? ("shallow" as const) : ("deep" as const),
      };
    };
    return tryPass(false) ?? tryPass(true);
  };

  const recordNoFit = () => {
    const reason = "insufficient-visible-cover";
    noFit[reason] = (noFit[reason] ?? 0) + 1;
  };

  const releaseCandidate = (tx: Transaction) => {
    tx.inputIds.forEach((id) => reserved.delete(id));
    transactions.delete(tx.id);
    if (!completed.has(tx.request.id)) paymentQueue.push(tx.request);
  };

  const updateInventoryMetrics = (now: number) => {
    const resources = new Set<string>([
      ...cells.map(resourceId),
      ...suppliedByResource.keys(),
    ]);
    for (const resource of resources) {
      const stat = resourceStats.get(resource) ?? makeResourceStats();
      const canonical = cells.filter(
        (cell) => cell.spentAt === undefined && resourceId(cell) === resource,
      );
      const visible = canonical.filter((cell) => cell.indexedAt <= now);
      const reservedCount = canonical.filter((cell) => reserved.has(cell.id)).length;
      const unavailableCount = canonical.filter(
        (cell) =>
          reserved.has(cell.id) ||
          cell.indexedAt > now ||
          (cell.blockedUntil !== undefined && cell.blockedUntil > now),
      ).length;
      const supplied = suppliedByResource.get(resource) ?? 0;
      const erosion = Math.max(0, supplied - canonical.length);
      stat.supplied = supplied;
      stat.maxReserved = Math.max(stat.maxReserved, reservedCount);
      stat.maxUnavailable = Math.max(stat.maxUnavailable, unavailableCount);
      stat.maxErosion = Math.max(stat.maxErosion, erosion);
      stat.maxRequired = Math.max(stat.maxRequired, unavailableCount + erosion);
      stat.minCanonical = Math.min(stat.minCanonical, canonical.length);
      stat.minVisible = Math.min(stat.minVisible, visible.length);
      stat.minCapacity =
        canonical.length === 0
          ? 0n
          : canonical.reduce((sum, cell) => sum + cell.capacity, 0n) <
              stat.minCapacity
            ? canonical.reduce((sum, cell) => sum + cell.capacity, 0n)
            : stat.minCapacity;
      if (resource.startsWith("typed:")) {
        const quantity = canonical.reduce(
          (sum, cell) => sum + (cell.token?.amount ?? 0n),
          0n,
        );
        stat.minQuantity =
          stat.minQuantity === undefined || quantity < stat.minQuantity
            ? quantity
            : stat.minQuantity;
      }
      resourceStats.set(resource, stat);
    }
  };

  for (let now = 0; now <= profile.durationMs; now += LIFECYCLE.stepMs) {
    for (const tx of transactions.values()) {
      if (tx.stage === "broadcast" && tx.commitAt! <= now) {
        tx.stage = "committed";
        tx.commitAt = now;
        stages.committed += 1;
        tx.inputIds.forEach((id) => {
          const input = cells.find((cell) => cell.id === id);
          if (input) input.spentAt = now;
          reserved.delete(id);
        });
        const outputs = materializeChange(
          tx.plan.change,
          tx.request.payment,
          transactionLimits,
        );
        outputs.forEach((output, index) => {
          const cell: LifecycleCell = {
            id: `${tx.id}:change:${index}`,
            blockNumber: 1_000_000 + changeSequence,
            transactionIndex: 0,
            outputIndex: index,
            capacity: output.capacity,
            token: output.token,
            lockId: output.lockId,
            lockBytes: output.lockBytes,
            typeBytes: output.typeBytes,
            dataBytes: output.dataBytes,
            confirmedAt: now,
            matureAt: now + LIFECYCLE.deepBlocks * LIFECYCLE.blockMs,
            eligible: true,
            provenance: "guard-change",
            indexedAt: now + profile.indexerLagMs,
            deepAt: now + LIFECYCLE.deepBlocks * LIFECYCLE.blockMs,
          };
          changeSequence += 1;
          cells.push(cell);
        });
        completed.add(tx.request.id);
        latencyMs.broadcastToCommit.push(now - tx.broadcastAt!);
        latencyMs.endToEnd.push(now - tx.request.arrivalAt);
      }
      if (
        tx.stage === "committed" &&
        !indexedTransactions.has(tx.id) &&
        tx.commitAt! + profile.indexerLagMs <= now
      ) {
        indexedTransactions.add(tx.id);
        stages.indexed += 1;
        latencyMs.commitToIndexer.push(profile.indexerLagMs);
      }
    }

    while (eventCursor < events.length && events[eventCursor].at <= now) {
      const event = events[eventCursor];
      const seenRemovalIds = new Set<string>();
      const unavailable = (event.removeIds ?? []).filter((id) => {
        const cell = cells.find((candidate) => candidate.id === id);
        const duplicate = seenRemovalIds.has(id);
        seenRemovalIds.add(id);
        return duplicate || !cell || cell.spentAt !== undefined || reserved.has(id);
      });
      const seenAdditionIds = new Set<string>();
      const duplicateAdds = (event.add ?? []).filter((addition) => {
        const duplicate =
          seenAdditionIds.has(addition.id) ||
          cells.some((cell) => cell.id === addition.id);
        seenAdditionIds.add(addition.id);
        return duplicate;
      });
      if (unavailable.length > 0 || duplicateAdds.length > 0)
        throw new Error(
          `${scenario.id}: cannot apply ${event.reason} inventory event at ${event.at}; unavailable removals [${unavailable.join(", ")}], duplicate additions [${duplicateAdds.map((cell) => cell.id).join(", ")}]`,
        );
      for (const id of event.removeIds ?? []) {
        const cell = cells.find((candidate) => candidate.id === id)!;
        cell.spentAt = now;
      }
      for (const cell of event.add ?? []) {
        cells.push(cell);
        markSupplied(cell);
      }
      appliedInventoryEvents += 1;
      eventCursor += 1;
    }

    while (
      requestCursor < requests.length &&
      requests[requestCursor].arrivalAt <= now
    ) {
      paymentQueue.push(requests[requestCursor]);
      requestCursor += 1;
      stages.arrived += 1;
    }

    for (const tx of [...transactions.values()]) {
      if (
        (tx.stage === "candidate" || tx.stage === "agreement") &&
        tx.activeEnd <= now
      ) {
        stages.candidateExpired += 1;
        releaseCandidate(tx);
      }
    }

    for (const tx of transactions.values()) {
      if (tx.stage === "agreement" && tx.approvalDueAt! <= now) {
        tx.stage = "approved";
        tx.approvedAt = now;
        stages.approved += 1;
      }
      if (tx.stage === "signing" && tx.signDueAt! <= now) {
        tx.stage = "signed";
        tx.signedAt = now;
        stages.signed += 1;
      }
    }

    if (
      now >= profile.processorOffsetMs &&
      (now - profile.processorOffsetMs) % LIFECYCLE.processorMs === 0
    ) {
      for (const tx of transactions.values()) {
        if (tx.stage === "signed") {
          tx.stage = "broadcast";
          tx.broadcastAt = now;
          tx.commitAt =
            now +
            profile.commitDelaysMs[
              broadcastSequence % profile.commitDelaysMs.length
            ];
          broadcastSequence += 1;
          stages.broadcast += 1;
        } else if (tx.stage === "approved") {
          tx.stage = "tss-queued";
          tx.tssQueuedAt = now;
          stages.tssQueued += 1;
          latencyMs.approvalToTss.push(now - tx.approvedAt!);
        }
      }
    }

    for (const tx of transactions.values()) {
      if (
        tx.stage === "tss-queued" &&
        now - tx.tssQueuedAt! >= LIFECYCLE.tssTimeoutMs
      ) {
        tx.stage = "approved";
        tx.tssQueuedAt = undefined;
        stages.tssTimedOut += 1;
      }
    }

    if (
      now >= profile.tssOffsetMs &&
      (now - profile.tssOffsetMs) % LIFECYCLE.tssRoundMs === 0
    ) {
      const queued = [...transactions.values()]
        .filter((tx) => tx.stage === "tss-queued")
        .sort((left, right) =>
          left.tssQueuedAt! - right.tssQueuedAt! || left.id.localeCompare(right.id),
        );
      const external = Math.min(
        LIFECYCLE.tssFreshLimit,
        profile.externalTssSlots?.[tssRound] ?? 0,
      );
      const head = queued.slice(0, LIFECYCLE.tssFreshLimit - external);
      let admitted = 0;
      for (const tx of head) {
        if (profile.stalledRequestIds?.includes(tx.request.id)) continue;
        tx.stage = "signing";
        tx.signDueAt = now + profile.signingMs;
        admitted += 1;
        stages.tssAdmitted += 1;
        latencyMs.tssQueue.push(now - tx.tssQueuedAt!);
      }
      if (queued.length > head.length || head.some((tx) => tx.stage === "tss-queued"))
        headBlockedJobRounds += Math.max(0, queued.length - admitted);
      admittedByRound.push(admitted);
      externalSlotsByRound.push(external);
      tssRound += 1;
    }

    if (inActiveTurn(now) && now % LIFECYCLE.agreementDrainMs === 0) {
      for (const tx of transactions.values()) {
        if (tx.stage !== "candidate") continue;
        tx.stage = "agreement";
        tx.approvalDueAt = now + profile.agreementLatencyMs;
        stages.agreementStarted += 1;
      }
    }

    if (
      inActiveTurn(now) &&
      now >= nextConstructionAt &&
      paymentQueue.length > 0
    ) {
      const request = paymentQueue.shift()!;
      if (!completed.has(request.id)) {
        const construction = constructFrom(request, now);
        if (construction) {
          const tx: Transaction = {
            id: `tx:${request.id}`,
            request,
            inputIds: construction.selected.map((cell) => cell.id),
            plan: construction.plan,
            stage: "candidate",
            generatedAt: now,
            activeEnd: activeEndAt(now),
          };
          tx.inputIds.forEach((id) => reserved.set(id, tx.id));
          transactions.set(tx.id, tx);
          stages.candidate += 1;
          latencyMs.arrivalToCandidate.push(now - request.arrivalAt);
        } else {
          recordNoFit();
          paymentQueue.push(request);
        }
      }
      nextConstructionAt = now + profile.constructionMs;
    }

    queues.maxPayments = Math.max(queues.maxPayments, paymentQueue.length);
    queues.maxCandidates = Math.max(
      queues.maxCandidates,
      [...transactions.values()].filter(
        (tx) => tx.stage === "candidate" || tx.stage === "agreement",
      ).length,
    );
    queues.maxTss = Math.max(
      queues.maxTss,
      [...transactions.values()].filter((tx) => tx.stage === "tss-queued").length,
    );
    updateInventoryMetrics(now);
  }

  if (eventCursor !== events.length)
    throw new Error(
      `${scenario.id}: ${events.length - eventCursor} inventory events fall outside the lifecycle horizon`,
    );

  queues.censoredPayments =
    requests.length - completed.size;
  const inventory = Object.fromEntries(
    [...resourceStats.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([resource, stat]) => [
        resource,
        {
          ...stat,
          minCanonical: Number.isFinite(stat.minCanonical) ? stat.minCanonical : 0,
          minVisible: Number.isFinite(stat.minVisible) ? stat.minVisible : 0,
          minCapacity: stat.minCapacity.toString(),
          minQuantity: stat.minQuantity?.toString(),
        },
      ],
    ),
  );

  return {
    scenario: scenario.id,
    profile: profile.id,
    assumptions: {
      ...LIFECYCLE,
      transactionProfile: structuredClone(profile.transactionProfile),
      constructionMs: profile.constructionMs,
      agreementLatencyMs: profile.agreementLatencyMs,
      commitDelaysMs: profile.commitDelaysMs,
      indexerLagMs: profile.indexerLagMs,
    },
    stages,
    queues,
    noFit,
    inventoryEvents: {
      scheduled: events.length,
      applied: appliedInventoryEvents,
    },
    tss: {
      rounds: admittedByRound.length,
      admittedByRound,
      externalSlotsByRound,
      headBlockedJobRounds,
    },
    latencyMs: Object.fromEntries(
      Object.entries(latencyMs).map(([key, values]) => [key, percentileSort(values)]),
    ) as LifecycleReport["latencyMs"],
    inventory,
    completedRequestIds: [...completed].sort(),
  };
};
