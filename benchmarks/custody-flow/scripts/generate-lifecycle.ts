import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/evaluator.ts";
import { runLifecycleScenario } from "../src/lifecycle.ts";
import {
  generatedLifecycleScenario,
  illustrativeLifecycleProfile,
  lifecycleCases,
  planningLifecycleCases,
  promptEdgeProfile,
  slowLifecycleProfile,
} from "../src/lifecycle-scenarios.ts";

const publicSeeds = JSON.parse(
  await readFile(new URL("../fixtures/public-seeds.json", import.meta.url), "utf8"),
) as string[];
const generatedCases = publicSeeds.flatMap((seed, index) => {
  const scenario = generatedLifecycleScenario(seed);
  const profiles = [
    illustrativeLifecycleProfile,
    promptEdgeProfile,
    slowLifecycleProfile,
  ];
  return [{ scenario, profile: profiles[index % profiles.length] }];
});
const cases = [...lifecycleCases, ...generatedCases];
const planningKeys = new Set(
  [...planningLifecycleCases, ...generatedCases].map(
    ({ scenario, profile }) => `${scenario.id}\0${profile.id}`,
  ),
);
const run = () =>
  cases.map(({ scenario, profile }) => runLifecycleScenario(scenario, profile));
const first = run();
const repeated = run();
if (canonicalJson(first) !== canonicalJson(repeated))
  throw new Error("custody-flow lifecycle benchmark is nondeterministic");
first.forEach((result, index) => {
  const { scenario, profile } = cases[index];
  if (!planningKeys.has(`${scenario.id}\0${profile.id}`)) return;
  const noFits = Object.values(result.noFit).reduce((sum, count) => sum + count, 0);
  if (noFits !== 0)
    throw new Error(
      `${scenario.id}/${profile.id}: planning seed produced ${noFits} no-fits`,
    );
});

const percentile = (values: number[], quantile: number): number | undefined =>
  values.length === 0
    ? undefined
    : values[Math.ceil(quantile * values.length) - 1];
const summarize = ({
  completedRequestIds,
  latencyMs,
  ...report
}: ReturnType<typeof runLifecycleScenario>) => ({
  ...report,
  completedRequestCount: completedRequestIds.length,
  latencyMs: Object.fromEntries(
    Object.entries(latencyMs).map(([stage, values]) => [
      stage,
      {
        count: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: values.length === 0 ? undefined : values[values.length - 1],
      },
    ]),
  ),
});

const report = {
  schema: "ckb-custody-flow-lifecycle-v1",
  node: process.version,
  command: ["pnpm", "generate:lifecycle"],
  sourcePins: {
    guard: "ac5702608e8f441a932b01582881a01be32155b0",
    ckb: "91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987",
    tss: {
      version: "5.2.0",
      sha256: "cc41b79a04cb6515c723935f08101cc86efb0164d9048f671898ad460febd61e",
    },
  },
  publicSeeds,
  planningGate: "every planning report must complete with zero no-fit observations",
  simplifications: [
    "one-second deterministic event-loop resolution",
    "agreement responses use scenario latency rather than peer simulation",
    "cold storage is an explicit inventory event plus optional external TSS occupancy",
    "the historical byte/fee fixtures remain the exact transaction-size evidence",
    "identity inventory is an in-memory array; RPC pagination, cursor failures, and persisted provenance verification are not modeled",
    "production deviations require a new model run; the benchmark does not self-tune",
    "the two-minute commitment profile is an illustrative assumption, not an observed bound",
  ],
  reports: first.map(summarize),
};
const json = `${canonicalJson(report)}\n`;
await writeFile(new URL("../results/lifecycle.json", import.meta.url), json);
