import { readFile, writeFile } from "node:fs/promises";
import { comparisonPolicies } from "../src/comparison-policies.ts";
import { runScenario } from "../src/engine.ts";
import { canonicalJson, summarizePolicy } from "../src/evaluator.ts";
import { generateScenario } from "../src/generator.ts";
import { comparisonProfiles } from "../src/profiles.ts";
import { scenarios } from "../src/scenarios.ts";

const publicSeeds = JSON.parse(
  await readFile(new URL("../fixtures/public-seeds.json", import.meta.url), "utf8"),
) as string[];
const comparisonScenarioIds = new Set([
  "native-serial-reservoir",
  "native-warm-burst",
  "native-cold-burst",
  "native-collapse-burst",
  "native-collapse-overrun-burst",
  "native-exact-cover-erosion-burst",
  "native-single-lane-pressure",
  "native-hidden-lane-pressure",
  "native-fragmented",
  "candidate-window-pressure",
  "xudt-capacity-contention",
  "xudt-warm-burst",
  "xudt-cold-burst",
  "xudt-collapse-burst",
  "xudt-collapse-overrun-burst",
  "xudt-exact-cover-erosion-burst",
  "xudt-capacity-migration-burst",
  "mixed-capacity-demand-native-first-burst",
  "mixed-capacity-demand-xudt-first-burst",
  "xudt-single-lane-pressure",
  "xudt-hidden-lane-pressure",
  "xudt-exact-token-with-foreign-type",
  "lifecycle-recovery",
  "lifecycle-matrix",
]);
const workloads = [
  ...scenarios.filter((scenario) => comparisonScenarioIds.has(scenario.id)),
  ...publicSeeds.map((seed) => generateScenario(seed)),
];
const summaries = Object.fromEntries(
  comparisonPolicies.map((policy) => [
    policy.id,
    Object.fromEntries(
      comparisonProfiles.map((profile) => {
        const first = workloads.map((scenario) =>
          runScenario(scenario, policy, profile),
        );
        const repeated = workloads.map((scenario) =>
          runScenario(scenario, policy, profile),
        );
        if (canonicalJson(first) !== canonicalJson(repeated))
          throw new Error(`${policy.id}/${profile.id}: nondeterministic result`);
        return [profile.id, summarizePolicy(first)];
      }),
    ),
  ]),
);

const report = {
  schema: "ckb-custody-flow-comparison-v1",
  node: process.version,
  command: ["pnpm", "generate:comparison"],
  publicSeeds,
  sourcePins: {
    guard: "ac5702608e8f441a932b01582881a01be32155b0",
    ckb: "91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987",
    tss: {
      version: "5.2.0",
      sha256: "cc41b79a04cb6515c723935f08101cc86efb0164d9048f671898ad460febd61e",
    },
  },
  workloads: workloads.map((workload) => workload.id),
  profiles: comparisonProfiles.map((profile) => profile.id),
  policies: comparisonPolicies.map((policy) => policy.id),
  summaries,
};
const json = `${canonicalJson(report)}\n`;
await writeFile(new URL("../results/comparison.json", import.meta.url), json);
