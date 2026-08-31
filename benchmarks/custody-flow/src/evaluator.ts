import type { SimulationResult } from "./engine.ts";

export type PolicySummary = {
  policyId: string;
  eligible: boolean;
  gateFailures: string[];
  served: number;
  admitted: number;
  noFits: number;
  noFitRate: bigint;
  exactMisses: number;
  unprovenNoFits: number;
  invalidProposals: number;
  waitMaximum: number;
  backlogMaximum: number;
  backlogArea: number;
  peakInventory: number;
  terminalInventory: number;
  netCellGrowth: number;
  burstArrived: number;
  burstServed: number;
  burstImmediate: number;
  burstImmediateByAsset: { native: number; xudt: number };
  burstImmediateByKind: Record<string, number>;
  burstImmediateByScenario: Record<
    string,
    { native: number; xudt: number; total: number }
  >;
  totalInputs: number;
  totalChangeOutputs: number;
  multiChangeTransactions: number;
  maximumChangeOutputs: number;
  cellsRead: number;
  pagesRead: number;
  totalBytes: number;
  totalFee: bigint;
};

const maximum = (values: number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

export const summarizePolicy = (results: SimulationResult[]): PolicySummary => {
  if (results.length === 0) throw new Error("cannot summarize zero results");
  const policyId = results[0].policyId;
  if (results.some((result) => result.policyId !== policyId))
    throw new Error("mixed policy results");
  const attempts = results.flatMap((result) =>
    result.outcomes.filter(
      (outcome) => outcome.kind !== "confirmed" && outcome.kind !== "censored",
    ),
  );
  const noFitKinds = new Set([
    "aggregate-shortage",
    "reservation-shortage",
    "size-or-structural-infeasibility",
    "intrinsic-no-fit",
    "policy-no-fit",
  ]);
  const noFits = attempts.filter((outcome) => noFitKinds.has(outcome.kind)).length;
  const burstKinds = [
    ...new Set(
      results.flatMap((result) =>
        result.burstKind === undefined ? [] : [result.burstKind],
      ),
    ),
  ].sort();
  const burstImmediateByKind = Object.fromEntries(
    burstKinds.map((kind) => [
        kind,
        results
          .filter((result) => result.burstKind === kind)
          .reduce((sum, result) => sum + result.metrics.burstImmediate, 0),
      ]),
  );
  const burstImmediateByScenario = Object.fromEntries(
    results
      .filter((result) => result.burstKind !== undefined)
      .map((result) => [
        result.scenarioId,
        {
          ...result.metrics.burstImmediateByAsset,
          total: result.metrics.burstImmediate,
        },
      ]),
  );
  return {
    policyId,
    eligible: results.every((result) => result.eligible),
    gateFailures: [...new Set(results.flatMap((result) => result.gateFailures))],
    served: results.reduce((sum, result) => sum + result.metrics.accepted, 0),
    admitted: results.reduce((sum, result) => sum + result.metrics.admitted, 0),
    noFits,
    noFitRate:
      attempts.length === 0
        ? 0n
        : (BigInt(noFits) * 1_000_000_000_000n +
            BigInt(Math.floor(attempts.length / 2))) /
          BigInt(attempts.length),
    exactMisses: results.reduce(
      (sum, result) => sum + result.metrics.exactMisses,
      0,
    ),
    unprovenNoFits: results.reduce(
      (sum, result) => sum + result.metrics.unprovenNoFits,
      0,
    ),
    invalidProposals: results.reduce(
      (sum, result) => sum + result.metrics.invalidProposals,
      0,
    ),
    waitMaximum: maximum(results.flatMap((result) => result.metrics.waits)),
    backlogMaximum: maximum(
      results.map((result) => result.metrics.backlogMaximum),
    ),
    backlogArea: results.reduce(
      (sum, result) => sum + result.metrics.backlogArea,
      0,
    ),
    peakInventory: results.reduce(
      (sum, result) => sum + result.metrics.peakProjectedCells,
      0,
    ),
    terminalInventory: results.reduce(
      (sum, result) => sum + result.metrics.finalProjectedCells,
      0,
    ),
    netCellGrowth: results.reduce(
      (sum, result) => sum + result.metrics.policyNetCellGrowth,
      0,
    ),
    burstArrived: results.reduce(
      (sum, result) => sum + result.metrics.burstArrived,
      0,
    ),
    burstServed: results.reduce(
      (sum, result) => sum + result.metrics.burstAccepted,
      0,
    ),
    burstImmediate: results.reduce(
      (sum, result) => sum + result.metrics.burstImmediate,
      0,
    ),
    burstImmediateByAsset: {
      native: results.reduce(
        (sum, result) => sum + result.metrics.burstImmediateByAsset.native,
        0,
      ),
      xudt: results.reduce(
        (sum, result) => sum + result.metrics.burstImmediateByAsset.xudt,
        0,
      ),
    },
    burstImmediateByKind,
    burstImmediateByScenario,
    totalInputs: results.reduce(
      (sum, result) => sum + result.metrics.totalInputs,
      0,
    ),
    totalChangeOutputs: results.reduce(
      (sum, result) => sum + result.metrics.totalChangeOutputs,
      0,
    ),
    multiChangeTransactions: results.reduce(
      (sum, result) =>
        sum +
        result.outcomes.filter(
          (outcome) =>
            outcome.kind === "accepted" &&
            outcome.submitted === true &&
            (outcome.changeCount ?? 0) > 1,
        ).length,
      0,
    ),
    maximumChangeOutputs: maximum(
      results.flatMap((result) =>
        result.outcomes.flatMap((outcome) =>
          outcome.kind === "accepted" && outcome.submitted === true
            ? [outcome.changeCount ?? 0]
            : [],
        ),
      ),
    ),
    cellsRead: results.reduce(
      (sum, result) => sum + result.metrics.cellsRead,
      0,
    ),
    pagesRead: results.reduce(
      (sum, result) => sum + result.metrics.pagesRead,
      0,
    ),
    totalBytes: results.reduce(
      (sum, result) => sum + result.metrics.totalBytes,
      0,
    ),
    totalFee: results.reduce(
      (sum, result) => sum + result.metrics.totalFee,
      0n,
    ),
  };
};

const canonicalize = (value: unknown): unknown => {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left === right ? 0 : left < right ? -1 : 1,
        )
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  return value;
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value), null, 2);
