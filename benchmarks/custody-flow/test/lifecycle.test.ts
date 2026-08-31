import assert from "node:assert/strict";
import test from "node:test";
import { constructCanonicalPlan } from "../src/canonical-change.ts";
import { XUDT_A, makeCell, makePayment } from "../src/fixtures.ts";
import { runLifecycleScenario } from "../src/lifecycle.ts";
import {
  candidateExpiry,
  deepBeyondRpcPage,
  illustrativeLifecycleProfile,
  mixedSharedCapacity,
  planningLifecycleCases,
  persistedShallowOutsidePage,
  shallowCommittedReuse,
  shallowDepositFlood,
  shallowDepositWaits,
  slowLifecycleProfile,
  stalledTssHead,
  tssBurst,
  typedMergeErosion,
} from "../src/lifecycle-scenarios.ts";
import {
  DEFAULT_PROFILE,
  compareBlockPosition,
  policyLimits,
} from "../src/model.ts";

test("canonical xUDT change keeps typed quantity and shared untyped capacity separate", () => {
  const payment = makePayment("canonical-xudt", 0, 0, XUDT_A, 100n);
  const typed = makeCell("typed", 142, 0, {
    typeId: XUDT_A.typeId,
    typeBytes: XUDT_A.typeBytes,
    amount: 200n,
  });
  const untyped = makeCell("untyped", 500, 1);
  const plan = constructCanonicalPlan(
    [typed, untyped],
    payment,
    policyLimits(DEFAULT_PROFILE),
  );
  assert.ok(plan);
  assert.equal(plan.change.length, 2);
  assert.equal(plan.change[0].tokenAmount, 100n);
  assert.equal(plan.change[1].tokenAmount, undefined);
});

test("deployment transaction limits affect lifecycle constructibility", () => {
  const scenario = {
    id: "deployment-fee-profile",
    cells: [
      {
        ...makeCell("fee-sensitive", 1_062, 0),
        provenance: "seed" as const,
        indexedAt: 0,
        deepAt: 0,
      },
    ],
    requests: [
      {
        id: "fee-sensitive-payment",
        arrivalAt: 0,
        payment: makePayment("fee-sensitive-payment", 1_000, 0),
      },
    ],
  };
  const defaultReport = runLifecycleScenario(
    scenario,
    illustrativeLifecycleProfile,
  );
  const expensiveReport = runLifecycleScenario(scenario, {
    ...illustrativeLifecycleProfile,
    id: "deployment-fee-profile-expensive",
    transactionProfile: {
      ...structuredClone(DEFAULT_PROFILE),
      structural: {
        ...structuredClone(DEFAULT_PROFILE.structural),
        feeRate: 1_000_000_000n,
      },
    },
  });
  assert.equal(defaultReport.stages.committed, 1);
  assert.equal(expensiveReport.stages.committed, 0);
  assert.ok(expensiveReport.noFit["insufficient-visible-cover"] > 0);
});

test("unavailable exact inventory events fail closed", () => {
  assert.throws(
    () =>
      runLifecycleScenario(
        {
          id: "reserved-cold-removal",
          cells: [
            {
              ...makeCell("reserved-for-payment", 10_000, 0),
              provenance: "seed",
              indexedAt: 0,
              deepAt: 0,
            },
          ],
          requests: [
            {
              id: "reserving-payment",
              arrivalAt: 0,
              payment: makePayment("reserving-payment", 1_000, 0),
            },
          ],
          inventoryEvents: [
            {
              at: 1_000,
              reason: "cold-storage",
              removeIds: ["reserved-for-payment"],
            },
          ],
        },
        illustrativeLifecycleProfile,
      ),
    /cannot apply cold-storage inventory event/,
  );
});

test("eleven fresh requests enter TSS five, five, and one", () => {
  const report = runLifecycleScenario(tssBurst, illustrativeLifecycleProfile);
  assert.equal(report.stages.committed, 11);
  assert.deepEqual(
    report.tss.admittedByRound.filter((count) => count > 0),
    [5, 5, 1],
  );
});

test("agreement candidates expire at the proposer active-window boundary", () => {
  const report = runLifecycleScenario(candidateExpiry, {
    ...illustrativeLifecycleProfile,
    id: "expiry-test",
    agreementLatencyMs: 130_000,
  });
  assert.equal(report.stages.approved, 0);
  assert.ok(report.stages.candidateExpired > 1);
  assert.equal(report.queues.censoredPayments, 1);
});

test("complete in-memory inventory reaches a later usable cell", () => {
  const report = runLifecycleScenario(
    deepBeyondRpcPage,
    illustrativeLifecycleProfile,
  );
  assert.equal(report.stages.committed, 1);
  assert.equal(report.noFit["insufficient-visible-cover"], undefined);
});

test("complete in-memory inventory finds deep cells beyond shallow deposits", () => {
  const deep = shallowDepositFlood.cells.find((cell) => cell.id === "deep-seed");
  const shallow = shallowDepositFlood.cells.filter(
    (cell) => cell.provenance === "deposit",
  );
  assert.ok(deep);
  assert.equal(shallow.length, 101);
  assert.ok(shallow.every((cell) => compareBlockPosition(cell, deep) < 0));
  const report = runLifecycleScenario(
    shallowDepositFlood,
    illustrativeLifecycleProfile,
  );
  assert.equal(report.stages.committed, 1);
  assert.equal(report.noFit["insufficient-visible-cover"], undefined);
});

test("a shallow Guard-change fixture supplements the deep set", () => {
  const report = runLifecycleScenario(
    persistedShallowOutsidePage,
    illustrativeLifecycleProfile,
  );
  assert.equal(report.stages.committed, 1);
  assert.equal(report.latencyMs.arrivalToCandidate[0], 0);
});

test("Guard change is reusable after commitment and indexing without becoming deep", () => {
  const report = runLifecycleScenario(
    shallowCommittedReuse,
    illustrativeLifecycleProfile,
  );
  assert.equal(report.stages.committed, 2);
  assert.ok(report.noFit["insufficient-visible-cover"] > 0);
  assert.ok(
    report.latencyMs.endToEnd.every(
      (latency) => latency < 150 * 9_300,
    ),
  );
});

test("inventory requirements include committed change awaiting indexing", () => {
  const lifecycleCell = (id: string, position: number) => ({
    ...makeCell(id, 10_000, position),
    provenance: "seed" as const,
    indexedAt: 0,
    deepAt: 0,
  });
  const report = runLifecycleScenario(
    {
      id: "unindexed-change-overlap",
      cells: [lifecycleCell("seed-a", 0), lifecycleCell("seed-b", 1)],
      requests: [
        {
          id: "first",
          arrivalAt: 0,
          payment: makePayment("first", 1_000, 0),
        },
        {
          id: "second",
          arrivalAt: 103_000,
          payment: makePayment("second", 1_000, 0),
        },
      ],
    },
    {
      ...illustrativeLifecycleProfile,
      id: "unindexed-change-overlap",
      commitDelaysMs: [23_494],
      indexerLagMs: 20_000,
    },
  );
  assert.equal(report.inventory.untyped.maxReserved, 1);
  assert.equal(report.inventory.untyped.maxUnavailable, 5);
  assert.equal(report.inventory.untyped.maxRequired, 5);
});

test("lifecycle distinguishes candidates from active unresolved change", () => {
  const lifecycleCell = (id: string, position: number) => ({
    ...makeCell(id, 100_000, position),
    provenance: "seed" as const,
    indexedAt: 0,
    deepAt: 0,
  });
  const speculative = runLifecycleScenario(
    {
      id: "speculative-concurrent-h1",
      cells: [lifecycleCell("unresolved-a", 0), lifecycleCell("unresolved-b", 1)],
      requests: [
        { id: "unresolved-first", arrivalAt: 0, payment: makePayment("first", 100, 0) },
        { id: "unresolved-second", arrivalAt: 0, payment: makePayment("second", 100, 0) },
      ],
    },
    { ...illustrativeLifecycleProfile, id: "speculative-concurrent-h1" },
  );
  assert.equal(speculative.stages.committed, 2);
  assert.equal(speculative.inventory.untyped.maxUnavailable, 9);

  const active = runLifecycleScenario(
    {
      id: "active-unresolved-h1",
      cells: [lifecycleCell("active-a", 0), lifecycleCell("active-b", 1)],
      requests: [
        { id: "active-first", arrivalAt: 0, payment: makePayment("first", 100, 0) },
        { id: "active-second", arrivalAt: 8_000, payment: makePayment("second", 100, 0) },
      ],
    },
    { ...illustrativeLifecycleProfile, id: "active-unresolved-h1" },
  );
  assert.equal(active.stages.committed, 2);
  assert.equal(active.inventory.untyped.maxUnavailable, 5);
});

test("a shallow user deposit waits for the deep pass", () => {
  const report = runLifecycleScenario(shallowDepositWaits, slowLifecycleProfile);
  assert.equal(report.stages.committed, 1);
  assert.ok(report.latencyMs.arrivalToCandidate[0] >= 150 * 9_300);
});

test("multi-input exact-token covers erode typed cells and create shared capacity", () => {
  const report = runLifecycleScenario(
    typedMergeErosion,
    illustrativeLifecycleProfile,
  );
  assert.equal(report.inventory[`typed:${XUDT_A.typeId}`].maxErosion, 4);
  assert.equal(report.inventory.untyped.minCanonical, 1);
  assert.equal(report.stages.committed, 2);
});

test("global untyped occupancy can exceed either typed asset occupancy", () => {
  const report = runLifecycleScenario(
    mixedSharedCapacity,
    illustrativeLifecycleProfile,
  );
  const typedA = report.inventory[`typed:${XUDT_A.typeId}`].maxReserved;
  assert.ok(report.inventory.untyped.maxReserved > typedA);
  assert.equal(report.stages.committed, 50);
});

test("planning seeds do not censor inventory peaks with no-fit retries", () => {
  for (const { scenario, profile } of planningLifecycleCases) {
    const report = runLifecycleScenario(scenario, profile);
    assert.equal(
      Object.values(report.noFit).reduce((sum, count) => sum + count, 0),
      0,
      `${scenario.id}/${profile.id}`,
    );
  }
});

test("stalled TSS head entries block later work until timeout", () => {
  const report = runLifecycleScenario(stalledTssHead, {
    ...illustrativeLifecycleProfile,
    id: "stalled-test",
    durationMs: 12 * 60_000,
    stalledRequestIds: Array.from({ length: 5 }, (_, index) => `stalled-${index}`),
  });
  assert.ok(report.stages.tssTimedOut > 0);
  assert.ok(report.tss.headBlockedJobRounds > 0);
  assert.ok(report.stages.committed < report.stages.arrived);
  assert.ok(report.queues.censoredPayments > 0);
});

test("the lifecycle model is deterministic", () => {
  const first = runLifecycleScenario(mixedSharedCapacity, slowLifecycleProfile);
  const second = runLifecycleScenario(mixedSharedCapacity, slowLifecycleProfile);
  assert.deepEqual(second, first);
});
