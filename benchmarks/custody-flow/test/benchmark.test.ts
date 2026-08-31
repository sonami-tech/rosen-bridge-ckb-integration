import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  comparisonPolicies,
  eligibleComparisonPolicies,
} from "../src/comparison-policies.ts";
import { assertExactGateCoverage, runScenario, type Scenario } from "../src/engine.ts";
import { XUDT_A, XUDT_B, makeCell, makePayment } from "../src/fixtures.ts";
import { Prng, generateScenario } from "../src/generator.ts";
import { summarizePolicy } from "../src/evaluator.ts";
import { serializeFixtureTransaction } from "../src/fixture-serializer.ts";
import { constructCanonicalPlan } from "../src/canonical-change.ts";
import { constructLanePreservingPlan } from "../src/lane-preserving-change.ts";
import {
  DEFAULT_PROFILE,
  DEFAULT_STRUCTURAL_PROFILE,
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  policyLimits,
  transactionFee,
  transactionSize,
  type Cell,
  type Payment,
  type PolicyPlan,
  type SizedPlan,
} from "../src/model.ts";
import { biggestFirstSingleChange } from "../src/policies/biggest-first-single-change.ts";
import { boundedValueQuantum } from "../src/policies/bounded-value-quantum.ts";
import { orderQuantum } from "../src/policies/order-quantum.ts";
import {
  oldestFirstLanePreserving,
  oldestFirstRepresentativeFloorEight,
} from "../src/policies/oldest-first-lane-preserving.ts";
import { CandidateView, LaneView, type Policy } from "../src/policy.ts";
import { comparisonProfiles } from "../src/profiles.ts";
import { scenarios } from "../src/scenarios.ts";
import { constructSingleChangePlan } from "../src/single-change.ts";
import {
  constructQuantumMinimalPlan,
  constructQuantumPlan,
} from "../src/quantum-change.ts";
import {
  maximumQuantumLanes,
  nativeQuantum,
  provisionalInventoryTarget,
  xudtMateQuantum,
} from "../src/quantum-budget.ts";
import { validatePlan } from "../src/validator.ts";

const queriedInventory = (cells: Cell[], payment: Payment) => ({
  cells,
  queried: true as const,
  target: provisionalInventoryTarget(payment, policyLimits(DEFAULT_PROFILE)),
});

test("agreement enforces exact-floor typed change", () => {
  const payment = makePayment("typed-floor-agreement", 0, 0, XUDT_A, 100n);
  const input = makeCell("typed-floor-agreement-input", 500, 0, {
    typeId: XUDT_A.typeId,
    amount: 200n,
  });
  const plan = constructQuantumMinimalPlan(
    [input],
    payment,
    policyLimits(DEFAULT_PROFILE),
  );
  assert.ok(plan);
  plan.change[0].capacity += 1n;
  plan.change[1].capacity -= 1n;
  const validation = validatePlan(
    payment,
    plan,
    [input],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([input], payment),
    },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("typed-change-not-at-floor"));
});

test("floor representation consumes every capacity fragment needed for payment", () => {
  const payment = makePayment("fragment-floor-cover", 0, 0, XUDT_A, 100n);
  const typed = makeCell("fragment-floor-cover-typed", 142, 0, {
    typeId: XUDT_A.typeId,
    amount: 200n,
  });
  const fragments = Array.from({ length: 4 }, (_, index) =>
    makeCell(`fragment-floor-cover-capacity-${index}`, 61, index + 1),
  );
  const cells = [typed, ...fragments];
  const limits = policyLimits(DEFAULT_PROFILE);
  const plan = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView(cells, limits),
    lanes: {
      untyped: new LaneView(fragments, limits),
      paymentType: new LaneView([typed], limits),
    },
    confirmedInventory: queriedInventory(cells, payment),
    pendingOutputs: [],
  });
  assert.ok(plan);
  assert.deepEqual(new Set(plan.inputIds), new Set(cells.map((cell) => cell.id)));
  assert.equal(
    validatePlan(payment, plan, cells, DEFAULT_PROFILE, 0, {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory(cells, payment),
    }).ok,
    true,
  );
});

test("agreement rejects full replacements that erase feasible pairs", () => {
  const payment = makePayment("replacement-pair-erosion", 0, 0, XUDT_A, 100n);
  const typed = [200n, 100n, 100n].map((amount, index) =>
    makeCell(`replacement-pair-typed-${index}`, 142, index, {
      typeId: XUDT_A.typeId,
      amount,
    }),
  );
  const untyped = Array.from({ length: 3 }, (_, index) =>
    makeCell(`replacement-pair-untyped-${index}`, 500, index + 3),
  );
  const cells = [...typed, ...untyped];
  const plan = constructQuantumPlan(
    cells,
    payment,
    policyLimits(DEFAULT_PROFILE),
    2,
  );
  assert.ok(plan);
  plan.change[0].tokenAmount = 299n;
  plan.change[1].tokenAmount = 1n;
  const validation = validatePlan(
    payment,
    plan,
    cells,
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory(cells, payment),
    },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(
      validation.violations.includes("replacement-lanes-not-restored"),
    );
});

test("serialized size matches complete native and typed fixture lengths", () => {
  const fixtures = JSON.parse(
    readFileSync(new URL("../fixtures/serialized-fixtures.json", import.meta.url), "utf8"),
  ) as { id: string; hex: string }[];
  const nativePayment = makePayment("native-size", 100, 0);
  const native: SizedPlan = {
    inputs: [makeCell("native-input", 100, 0)],
    recipient: makeRecipient(nativePayment),
    change: [],
  };
  assert.equal(transactionSize(native, DEFAULT_STRUCTURAL_PROFILE), 357);
  assert.equal(
    transactionSize(native, DEFAULT_STRUCTURAL_PROFILE),
    serializeFixtureTransaction(native, DEFAULT_STRUCTURAL_PROFILE).length,
  );
  assert.equal(
    Buffer.from(serializeFixtureTransaction(native, DEFAULT_STRUCTURAL_PROFILE)).toString("hex"),
    fixtures.find((fixture) => fixture.id === "native-exact")?.hex,
  );

  const typedPayment = makePayment("typed-size", 0, 0, XUDT_A, 100n);
  const input = makeCell("typed-input", 500, 0, {
    typeId: XUDT_A.typeId,
    amount: 200n,
  });
  const plan = constructSingleChangePlan([input], typedPayment, DEFAULT_PROFILE);
  assert.ok(plan);
  const sized: SizedPlan = {
    inputs: [input],
    recipient: makeRecipient(typedPayment),
    change: materializeChange(plan.change, typedPayment, DEFAULT_PROFILE),
  };
  assert.equal(transactionSize(sized, DEFAULT_STRUCTURAL_PROFILE), 705);
  assert.equal(
    transactionSize(sized, DEFAULT_STRUCTURAL_PROFILE),
    serializeFixtureTransaction(sized, DEFAULT_STRUCTURAL_PROFILE).length,
  );
  assert.equal(
    Buffer.from(
      serializeFixtureTransaction(sized, DEFAULT_STRUCTURAL_PROFILE),
    ).toString("hex"),
    fixtures.find((fixture) => fixture.id === "xudt-typed-change")?.hex,
  );
});

test("xUDT validates token quantity separately from recipient capacity", () => {
  const payment = makePayment("xudt", 0, 0, XUDT_A, 150n);
  const input = makeCell("typed", 500, 0, {
    typeId: XUDT_A.typeId,
    amount: 300n,
  });
  const plan = constructCanonicalPlan(
    [input],
    payment,
    policyLimits(DEFAULT_PROFILE),
  );
  assert.ok(plan);
  assert.equal(validatePlan(payment, plan, [input], DEFAULT_PROFILE, 0).ok, true);
});

test("foreign xUDT cannot fund a payment", () => {
  const payment = makePayment("xudt", 0, 0, XUDT_A, 150n);
  const foreign = makeCell("foreign", 500, 0, {
    typeId: XUDT_B.typeId,
    amount: 300n,
  });
  const plan: PolicyPlan = {
    inputIds: [foreign.id],
    change: [{ capacity: 200n * 100_000_000n, tokenAmount: 150n }],
  };
  const result = validatePlan(payment, plan, [foreign], DEFAULT_PROFILE, 0);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(
      result.violations.some((violation) =>
        violation.startsWith("foreign-or-malformed-type-input"),
      ),
    );
});

test("foreign custody lock cannot fund a payment", () => {
  const payment = makePayment("native", 100, 0);
  const foreign = makeCell("foreign-lock", 500, 0);
  foreign.lockId = "not-rosen-lock";
  const plan = constructSingleChangePlan([foreign], payment, DEFAULT_PROFILE);
  assert.ok(plan);
  const result = validatePlan(payment, plan, [foreign], DEFAULT_PROFILE, 0);
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(result.violations.includes("foreign-custody-lock:foreign-lock"));
});

test("agreement validation enforces the shared shaping byte budget", () => {
  const nativePayment = makePayment("native-shape", 100, 0);
  const nativeCell = makeCell("native-shape-input", 1_000, 0);
  const native = validatePlan(
    nativePayment,
    {
      inputIds: [nativeCell.id],
      change: Array.from({ length: 20 }, () => ({ capacity: 100n })),
    },
    [nativeCell],
    DEFAULT_PROFILE,
    0,
  );
  assert.equal(native.ok, false);
  if (!native.ok)
    assert.ok(native.violations.includes("change-byte-allowance"));

  const xudtPayment = makePayment("xudt-shape", 0, 0, XUDT_A, 100n);
  const xudtCell = makeCell("xudt-shape-input", 1_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 1_000n,
  });
  const xudt = validatePlan(
    xudtPayment,
    {
      inputIds: [xudtCell.id],
      change: [
        ...Array.from({ length: 20 }, () => ({
          capacity: 100n,
          tokenAmount: 1n,
        })),
        { capacity: 100n },
        { capacity: 100n },
      ],
    },
    [xudtCell],
    DEFAULT_PROFILE,
    0,
  );
  assert.equal(xudt.ok, false);
  if (!xudt.ok)
    assert.ok(xudt.violations.includes("change-byte-allowance"));
});

test("agreement validation rejects inputs outside bounded repair", () => {
  const payment = makePayment("native-extra-input", 100, 0);
  const cells = [
    makeCell("native-extra-input-cover", 500, 0),
    makeCell("native-extra-input-consolidation", 500, 1),
  ];
  const plan = constructSingleChangePlan(cells, payment, DEFAULT_PROFILE);
  assert.ok(plan);
  const result = validatePlan(
    payment,
    plan,
    cells,
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory(cells, payment),
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(result.violations.includes("invalid-repair-inputs"));

  const orderedPayment = makePayment("native-ordered-extra-input", 300, 0);
  const whale = makeCell("native-ordered-whale", 500, 0);
  const smalls = Array.from({ length: 3 }, (_, index) =>
    makeCell(`native-ordered-small-${index}`, 100, index + 1),
  );
  const orderedPlan = constructSingleChangePlan(
    [...smalls, whale],
    orderedPayment,
    DEFAULT_PROFILE,
  );
  assert.ok(orderedPlan);
  const orderedResult = validatePlan(
    orderedPayment,
    orderedPlan,
    [whale, ...smalls],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([whale, ...smalls], orderedPayment),
    },
  );
  const whaleFirstPlan = constructSingleChangePlan(
    [whale, ...smalls],
    orderedPayment,
    DEFAULT_PROFILE,
  );
  assert.ok(whaleFirstPlan);
  const whaleFirstResult = validatePlan(
    orderedPayment,
    whaleFirstPlan,
    [whale, ...smalls],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([whale, ...smalls], orderedPayment),
    },
  );
  assert.equal(orderedResult.ok, true);
  assert.equal(whaleFirstResult.ok, orderedResult.ok);

  const ceilingPayment = makePayment("native-growth-ceiling", 100, 0);
  const ceilingWhale = makeCell("native-growth-ceiling-whale", 100_000, 0);
  const ceilingPlan = constructQuantumPlan(
    [ceilingWhale],
    ceilingPayment,
    policyLimits(DEFAULT_PROFILE),
    maximumQuantumLanes(ceilingPayment, policyLimits(DEFAULT_PROFILE)),
  );
  assert.ok(ceilingPlan);
  const ceilingCells = [
    ceilingWhale,
    ...Array.from({ length: 6 }, (_, index) =>
      makeCell(`native-growth-ceiling-lane-${index}`, 500, index + 1),
    ),
  ];
  const ceilingResult = validatePlan(
    ceilingPayment,
    ceilingPlan,
    [ceilingWhale],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory(ceilingCells, ceilingPayment),
    },
  );
  assert.equal(ceilingResult.ok, false);
  if (!ceilingResult.ok)
    assert.ok(ceilingResult.violations.includes("inventory-growth-ceiling"));
});

test("agreement rejects fragmented subquantum change on minimal cover", () => {
  const payment = makePayment("fragmented-minimal-cover", 0, 0, XUDT_A, 100n);
  const input = makeCell("fragmented-minimal-cover-input", 1_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 150n,
  });
  const typedFloor = occupiedCapacity(
    materializeChange(
      [{ capacity: 0n, tokenAmount: 25n }],
      payment,
      DEFAULT_PROFILE,
    )[0],
  );
  const intents = [
    { capacity: typedFloor, tokenAmount: 25n },
    { capacity: typedFloor, tokenAmount: 25n },
    { capacity: 0n },
  ];
  const sample = materializeChange(intents, payment, DEFAULT_PROFILE);
  const fee = transactionFee(
    {
      inputs: [input],
      recipient: makeRecipient(payment),
      change: sample,
    },
    DEFAULT_PROFILE.structural,
  ).fee;
  intents[2].capacity =
    input.capacity - payment.recipientCapacity - typedFloor * 2n - fee;
  const validation = validatePlan(
    payment,
    { inputIds: [input.id], change: intents },
    [input],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([input], payment),
    },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("fragmented-subquantum-change"));
});

test("agreement rejects full-sized exact-token xUDT fragmentation", () => {
  const payment = makePayment("fragmented-exact-token", 0, 0, XUDT_A, 100n);
  const input = makeCell("fragmented-exact-token-input", 1_000, 0, {
    typeId: XUDT_A.typeId,
    amount: payment.amount,
  });
  const intents = [
    { capacity: 200n * 100_000_000n },
    { capacity: 200n * 100_000_000n },
    { capacity: 0n },
  ];
  const fee = transactionFee(
    {
      inputs: [input],
      recipient: makeRecipient(payment),
      change: materializeChange(intents, payment, DEFAULT_PROFILE),
    },
    DEFAULT_PROFILE.structural,
  ).fee;
  intents[2].capacity =
    input.capacity - payment.recipientCapacity - intents[0].capacity -
    intents[1].capacity - fee;
  const validation = validatePlan(
    payment,
    { inputIds: [input.id], change: intents },
    [input],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([input], payment),
    },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("invalid-exact-token-change"));
});

test("agreement rejects unpaired full-sized xUDT capacity outputs", () => {
  const payment = makePayment("unpaired-xudt-capacity", 0, 0, XUDT_A, 100n);
  const input = makeCell("unpaired-xudt-capacity-input", 1_000, 0, {
    typeId: XUDT_A.typeId,
    amount: payment.amount + 1n,
  });
  const typedFloor = occupiedCapacity(
    materializeChange(
      [{ capacity: 0n, tokenAmount: 1n }],
      payment,
      DEFAULT_PROFILE,
    )[0],
  );
  const intents = [
    { capacity: typedFloor, tokenAmount: 1n },
    { capacity: 200n * 100_000_000n },
    { capacity: 0n },
  ];
  const fee = transactionFee(
    {
      inputs: [input],
      recipient: makeRecipient(payment),
      change: materializeChange(intents, payment, DEFAULT_PROFILE),
    },
    DEFAULT_PROFILE.structural,
  ).fee;
  intents[2].capacity =
    input.capacity - payment.recipientCapacity - typedFloor -
    intents[1].capacity - fee;
  const validation = validatePlan(
    payment,
    { inputIds: [input.id], change: intents },
    [input],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([input], payment),
    },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("unpaired-untyped-change"));
});

test("one processed window gives a censored wait of one", () => {
  const scenario: Scenario = {
    id: "censored-wait",
    windows: 1,
    exactGate: false,
    cells: [],
    payments: [makePayment("payment", 100, 0)],
  };
  const result = runScenario(
    scenario,
    { id: "no-plan", propose: () => undefined },
    DEFAULT_PROFILE,
  );
  assert.deepEqual(result.metrics.waits, [1]);
});

test("candidate access is sequential and counts actual reads", () => {
  const cells = Array.from({ length: 250 }, (_, index) =>
    makeCell(`cell-${index}`, 100, index),
  );
  const view = new CandidateView(cells, policyLimits(DEFAULT_PROFILE));
  assert.equal(view.readNextPage().length, 100);
  assert.equal(view.readNextPage().length, 100);
  assert.equal(view.cellsRead, 200);
  assert.equal(view.pagesRead, 2);
});

test("unsupported custody cells do not consume the candidate limit", () => {
  const poison = Array.from({ length: 25 }, (_, index) => {
    if (index % 2 === 1)
      return makeCell(`candidate-poison-type-${index}`, 142, index, {
        typeId: XUDT_B.typeId,
        amount: 1n,
      });
    const cell = makeCell(`candidate-poison-data-${index}`, 62, index);
    cell.dataBytes = 1;
    return cell;
  });
  const scenario: Scenario = {
    id: "candidate-limit-poison",
    windows: 7,
    exactGate: false,
    cells: [...poison, makeCell("candidate-poison-seed", 1_000_000, 1_000)],
    payments: Array.from({ length: 5 }, (_, index) =>
      makePayment(`candidate-poison-payment-${index}`, 5_000, index),
    ),
  };
  const result = runScenario(scenario, boundedValueQuantum, {
    ...structuredClone(DEFAULT_PROFILE),
    id: "candidate-limit-poison",
    candidateLimit: 20,
    pageSize: 10,
    pageLimit: 2,
  });
  assert.equal(result.metrics.accepted, 5);
  assert.equal(result.metrics.backlogArea, 0);
  assert.equal(result.metrics.invalidProposals, 0);
});

test("lane existence queries are repeatable and charge every scan", () => {
  const lanes = new LaneView(
    [makeCell("selected", 100, 0), makeCell("other", 100, 1)],
    policyLimits(DEFAULT_PROFILE),
  );
  const selected = new Set(["selected"]);
  assert.equal(lanes.countUnselected(selected, 1), 1);
  assert.equal(lanes.countUnselected(selected, 1), 1);
  assert.deepEqual(
    lanes.takeUnselected(selected, 1, (cell) => cell.capacity > 0n).map((cell) => cell.id),
    ["other"],
  );
  assert.equal(lanes.readableCells.length, 2);
  assert.equal(lanes.cellsRead, 6);
  assert.equal(lanes.pagesRead, 3);
});

test("lane counts scan beyond every selectable input up to the target", () => {
  const limits = {
    ...policyLimits(DEFAULT_PROFILE),
    pageSize: 1,
    candidateLimit: 2,
    pageLimit: 2,
  };
  const lanes = new LaneView(
    Array.from({ length: 6 }, (_, index) =>
      makeCell(`lane-count-${index}`, 100, index),
    ),
    limits,
  );
  assert.equal(
    lanes.countUnselected(new Set(["lane-count-0", "lane-count-1"]), 4),
    4,
  );
  assert.equal(lanes.cellsRead, 6);
  assert.equal(lanes.pagesRead, 6);
});

test("oracle never reaches beyond the readable block prefix", () => {
  const profile = {
    ...structuredClone(DEFAULT_PROFILE),
    id: "prefix-two",
    pageSize: 2,
    candidateLimit: 2,
    pageLimit: 1,
  };
  const scenario: Scenario = {
    id: "prefix",
    windows: 1,
    exactGate: false,
    cells: [
      makeCell("native-prefix-0", 61, 0),
      makeCell("native-prefix-1", 61, 1),
      makeCell("native-beyond-prefix", 500, 2),
    ],
    payments: [makePayment("payment", 200, 0)],
  };
  const result = runScenario(scenario, biggestFirstSingleChange, profile);
  assert.equal(result.metrics.exactMisses, 0);
  assert.equal(result.outcomes[0].kind, "policy-no-fit");
  assert.equal(result.outcomes[0].fundability, "unproven");
});

test("no-plan adjudication preserves shortage, structural, and intrinsic classes", () => {
  const noPlan: Policy = { id: "no-plan", propose: () => undefined };
  const shortage: Scenario = {
    id: "aggregate-shortage",
    windows: 1,
    exactGate: true,
    cells: [makeCell("short", 50, 0)],
    payments: [makePayment("short-payment", 100, 0)],
  };
  assert.equal(
    runScenario(shortage, noPlan, DEFAULT_PROFILE).outcomes[0].kind,
    "aggregate-shortage",
  );

  const structural: Scenario = {
    id: "structural",
    windows: 1,
    exactGate: true,
    cells: Array.from({ length: 3 }, (_, index) => makeCell(`structural-${index}`, 80, index)),
    payments: [makePayment("structural-payment", 100, 0)],
  };
  assert.equal(
    runScenario(structural, noPlan, {
      ...structuredClone(DEFAULT_PROFILE),
      maxTransactionBytes: 400,
    }).outcomes[0].kind,
    "size-or-structural-infeasibility",
  );

  const residue = scenarios.find((scenario) => scenario.id === "native-residue-1");
  assert.ok(residue);
  assert.equal(
    runScenario(residue, noPlan, DEFAULT_PROFILE).outcomes[0].kind,
    "intrinsic-no-fit",
  );
});

test("policy mutations cannot alter engine profile or reservations", () => {
  const profile = structuredClone(DEFAULT_PROFILE);
  const mutator: Policy = {
    id: "mutator",
    propose(context) {
      context.limits.candidateLimit = 0;
      return undefined;
    },
  };
  const reserved = makeCell("reserved", 500, 0);
  reserved.reservedUntil = 2;
  const scenario: Scenario = {
    id: "mutation",
    windows: 1,
    exactGate: true,
    cells: [reserved],
    payments: [makePayment("payment", 100, 0)],
  };
  const result = runScenario(scenario, mutator, profile);
  assert.equal(profile.candidateLimit, 1_000);
  assert.equal(result.finalCells[0].reservedUntil, 2);
});

test("reserved cells remain inside the frozen candidate prefix", () => {
  const seen: string[] = [];
  const policy: Policy = {
    id: "prefix-observer",
    propose(context) {
      seen.push(...context.candidates.readNextPage().map((cell) => cell.id));
      return undefined;
    },
  };
  const reserved = makeCell("reserved-prefix", 500, 0);
  reserved.reservedUntil = 2;
  const scenario: Scenario = {
    id: "reservation-prefix",
    windows: 1,
    exactGate: false,
    cells: [reserved, makeCell("low-prefix", 50, 1), makeCell("beyond-prefix", 500, 2)],
    payments: [makePayment("payment", 100, 0)],
  };
  const result = runScenario(scenario, policy, {
    ...structuredClone(DEFAULT_PROFILE),
    pageSize: 2,
    candidateLimit: 2,
    pageLimit: 1,
  });
  assert.deepEqual(seen, ["low-prefix"]);
  assert.equal(result.metrics.accepted, 0);
  assert.equal(result.outcomes[0].kind, "policy-no-fit");
});

test("malformed policy output is an invalid proposal instead of a crash", () => {
  const malformed: Policy = {
    id: "malformed",
    propose: () => ({}) as PolicyPlan,
  };
  const scenario: Scenario = {
    id: "malformed",
    windows: 1,
    exactGate: true,
    cells: [makeCell("cell", 500, 0)],
    payments: [makePayment("payment", 100, 0)],
  };
  const result = runScenario(scenario, malformed, DEFAULT_PROFILE);
  assert.equal(result.outcomes[0].kind, "invalid-proposal");
  assert.equal(result.eligible, false);
});

test("a no-fit event does not consume the signing ceiling", () => {
  const policy: Policy = {
    id: "skip-first",
    propose(context) {
      if (context.payment.id === "skip") return undefined;
      const cells = context.candidates.readNextPage();
      return constructSingleChangePlan(
        cells.slice(0, 1),
        context.payment,
        context.limits,
      );
    },
  };
  const scenario: Scenario = {
    id: "ceiling",
    windows: 1,
    exactGate: false,
    cells: [makeCell("a", 500, 0), makeCell("b", 500, 1)],
    payments: [
      makePayment("skip", 100, 0),
      makePayment("serve", 100, 0),
    ],
  };
  const profile = {
    ...structuredClone(DEFAULT_PROFILE),
    signingRoundCeiling: 1,
  };
  const result = runScenario(scenario, policy, profile);
  assert.equal(result.metrics.accepted, 1);
});

test("declared eligible policies remain eligible in every comparison profile", () => {
  for (const policy of comparisonPolicies)
    for (const profile of comparisonProfiles)
      for (const scenario of scenarios) {
        const result = runScenario(scenario, policy, structuredClone(profile));
        if (eligibleComparisonPolicies.includes(policy)) {
          assert.equal(
            result.metrics.invalidProposals,
            0,
            `${policy.id}/${profile.id}/${scenario.id}: ${result.gateFailures.join(", ")}`,
          );
          assert.equal(
            result.eligible,
            true,
            `${policy.id}/${profile.id}/${scenario.id}: ${result.gateFailures.join(", ")}`,
          );
        }
      }
});

test("every exact-gate public scenario stays inside oracle coverage", () => {
  for (const scenario of scenarios)
    assert.doesNotThrow(() =>
      assertExactGateCoverage(scenario, structuredClone(DEFAULT_PROFILE)),
    );
});

test("public generator is deterministic and uses integer arithmetic", () => {
  const left = generateScenario("0x1234");
  const right = generateScenario("0x1234");
  assert.deepEqual(left, right);
  const random = new Prng("0x1234");
  assert.deepEqual(
    [random.integer(100), random.integer(100), random.integer(100)],
    [16, 46, 84],
  );
  assert.notEqual(new Prng("0x10000000000000000").next(), 0n);
});

test("generated workloads preserve safety and eligible policy coverage", () => {
  const seeds = JSON.parse(
    readFileSync(new URL("../fixtures/public-seeds.json", import.meta.url), "utf8"),
  ) as string[];
  for (const policy of comparisonPolicies)
    for (const profile of comparisonProfiles)
      for (const seed of seeds) {
        const result = runScenario(generateScenario(seed), policy, profile);
        if (eligibleComparisonPolicies.includes(policy)) {
          assert.equal(
            result.metrics.invalidProposals,
            0,
            `${policy.id}/${profile.id}/${seed}`,
          );
          assert.equal(
            result.eligible,
            true,
            `${policy.id}/${profile.id}/${seed}: ${result.gateFailures.join(", ")}`,
          );
        }
      }
});

test("generated workloads interleave both registered xUDT payment routes", () => {
  const generated = generateScenario("0x1234");
  assert.deepEqual(
    new Set(
      generated.payments.flatMap((payment) =>
        payment.asset.kind === "xudt" ? [payment.asset.typeId] : [],
      ),
    ),
    new Set([XUDT_A.typeId, XUDT_B.typeId]),
  );
  assert.ok(generated.cells.length > 100);
});

test("RPC rejection reserves inputs through the current window", () => {
  const scenario: Scenario = {
    id: "rpc-reservation",
    windows: 1,
    exactGate: true,
    cells: [makeCell("only-cell", 500, 0)],
    payments: [makePayment("first", 100, 0), makePayment("second", 100, 0)],
    lifecycle: { first: ["rpc-rejection"] },
  };
  const result = runScenario(
    scenario,
    biggestFirstSingleChange,
    structuredClone(DEFAULT_PROFILE),
  );
  assert.ok(
    result.outcomes.some(
      (outcome) =>
        outcome.paymentId === "second" &&
        outcome.kind === "reservation-shortage",
    ),
  );
});

test("agreement inventory includes locally reserved confirmed cells", () => {
  const scenario: Scenario = {
    id: "agreement-reservation-inventory",
    windows: 1,
    exactGate: true,
    cells: Array.from({ length: 6 }, (_, index) =>
      makeCell(`agreement-reservation-cell-${index}`, 500, index),
    ),
    payments: [
      makePayment("agreement-reservation-first", 100, 0),
      makePayment("agreement-reservation-second", 100, 0),
    ],
    lifecycle: { "agreement-reservation-first": ["rpc-rejection"] },
    maximumPerIdentityNetCellGrowth: 0,
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  const accepted = result.outcomes.find(
    (outcome) => outcome.paymentId === "agreement-reservation-second",
  );
  assert.equal(accepted?.kind, "accepted");
  assert.equal(accepted?.changeCount, 1);
  assert.equal(result.metrics.invalidProposals, 0);
  assert.deepEqual(result.gateFailures, []);
});

test("confirmed-view divergence rejects shaping but not minimal payment", () => {
  const payment = makePayment("agreement-confirmed-view", 100, 0);
  const whale = makeCell("agreement-confirmed-whale", 10_000, 0);
  const extra = makeCell("agreement-confirmed-extra", 500, 1);
  const limits = policyLimits(DEFAULT_PROFILE);
  const shaped = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView([whale], limits),
    lanes: { untyped: new LaneView([whale], limits) },
    confirmedInventory: queriedInventory([whale], payment),
    pendingOutputs: [],
  });
  assert.ok(shaped);
  assert.equal(shaped.change.length, maximumQuantumLanes(payment, limits));
  const divergent = validatePlan(
    payment,
    shaped,
    [whale],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([whale, extra], payment),
    },
  );
  assert.equal(divergent.ok, false);
  if (!divergent.ok)
    assert.ok(divergent.violations.includes("inventory-growth-ceiling"));

  const lagged = validatePlan(
    payment,
    shaped,
    [whale],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([extra], payment),
    },
  );
  assert.equal(lagged.ok, false);
  if (!lagged.ok)
    assert.ok(lagged.violations.includes("inventory-growth-ceiling"));

  const minimal = constructSingleChangePlan([whale], payment, limits);
  assert.ok(minimal);
  assert.equal(
    validatePlan(payment, minimal, [whale], DEFAULT_PROFILE, 0, {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([whale, extra], payment),
    }).ok,
    true,
  );
});

test("pending outputs cannot justify cleanup rejected by confirmed agreement", () => {
  const payment = makePayment("pending-cleanup-agreement", 1_520, 0);
  const whale = makeCell("pending-cleanup-whale", 3_105, 0);
  const dust = [
    makeCell("pending-cleanup-dust-a", 147, 1),
    makeCell("pending-cleanup-dust-b", 145, 2),
    makeCell("pending-cleanup-dust-c", 238, 3),
  ];
  const pendingInputs = [
    makeCell("pending-cleanup-spent-a", 500, 4),
    makeCell("pending-cleanup-spent-b", 500, 5),
  ];
  const selectable = [whale, ...dust];
  const confirmed = [...selectable, ...pendingInputs];
  const limits = policyLimits(DEFAULT_PROFILE);
  const pendingOutputs = materializeChange(
    Array.from({ length: 5 }, () => ({
      capacity: makeCell("pending-cleanup-output", 61, 0).capacity,
    })),
    payment,
    limits,
  );

  const plan = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView(selectable, limits),
    lanes: { untyped: new LaneView(selectable, limits) },
    confirmedInventory: queriedInventory(confirmed, payment),
    pendingOutputs,
  });
  assert.ok(plan);
  assert.deepEqual(plan.inputIds, [whale.id]);
  assert.equal(
    validatePlan(payment, plan, confirmed, DEFAULT_PROFILE, 0, {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory(confirmed, payment),
    }).ok,
    true,
  );
});

test("shared repair decomposition preserves an xUDT capacity cover", () => {
  const payment = makePayment("shared-xudt-repair-cover", 0, 0, XUDT_A, 115n);
  const typed = [
    makeCell("shared-xudt-token-cover", 142, 0, {
      typeId: XUDT_A.typeId,
      amount: 200n,
    }),
    makeCell("shared-xudt-capacity-cover", 500, 1, {
      typeId: XUDT_A.typeId,
      amount: 150n,
    }),
  ];
  const repair = Array.from({ length: 3 }, (_, index) =>
    makeCell(`shared-xudt-repair-${index}`, 80, index + 2),
  );
  const confirmed = [...typed, ...repair];
  const limits = policyLimits(DEFAULT_PROFILE);
  const plan = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView(typed, limits),
    lanes: {
      untyped: new LaneView(repair, limits),
      paymentType: new LaneView(typed, limits),
    },
    confirmedInventory: queriedInventory(confirmed, payment),
    pendingOutputs: [],
  });
  assert.ok(plan);
  assert.ok(repair.every((cell) => plan.inputIds.includes(cell.id)));

  for (const inputIds of [plan.inputIds, [...plan.inputIds].reverse()])
    assert.equal(
      validatePlan(
        payment,
        { ...plan, inputIds },
        confirmed,
        DEFAULT_PROFILE,
        0,
        {
          boundary: "damped-quantum",
          confirmedInventory: queriedInventory(confirmed, payment),
        },
      ).ok,
      true,
    );
});

test("canonical xUDT fallback preserves selected untyped capacity", () => {
  const payment = makePayment("canonical-xudt-fallback", 0, 0, XUDT_A, 100n);
  const typedCover = makeCell("canonical-xudt-fallback-cover", 142, 0, {
    typeId: XUDT_A.typeId,
    amount: 200n,
  });
  const capacityInput = makeCell("canonical-xudt-fallback-capacity", 500, 1);
  const typedLanes = Array.from({ length: 3 }, (_, index) =>
    makeCell(`canonical-xudt-fallback-typed-${index}`, 142, index + 2, {
      typeId: XUDT_A.typeId,
      amount: 100n,
    }),
  );
  const capacityLanes = Array.from({ length: 3 }, (_, index) =>
    makeCell(`canonical-xudt-fallback-untyped-${index}`, 500, index + 5),
  );
  const confirmed = [
    typedCover,
    capacityInput,
    ...typedLanes,
    ...capacityLanes,
  ];
  const limits = policyLimits(DEFAULT_PROFILE);
  const plan = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView([typedCover, capacityInput], limits),
    lanes: {
      untyped: new LaneView([capacityInput, ...capacityLanes], limits),
      paymentType: new LaneView([typedCover, ...typedLanes], limits),
    },
    confirmedInventory: queriedInventory(confirmed, payment),
    pendingOutputs: [],
  });
  assert.ok(plan);
  assert.deepEqual(plan.inputIds, [typedCover.id, capacityInput.id]);
  assert.equal(
    plan.change.filter((output) => output.tokenAmount !== undefined).length,
    1,
  );
  assert.equal(
    plan.change.filter((output) => output.tokenAmount === undefined).length,
    1,
  );
  assert.equal(
    validatePlan(payment, plan, confirmed, DEFAULT_PROFILE, 0, {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory(confirmed, payment),
    }).ok,
    true,
  );
});

test("cumulative xUDT token cover cannot absorb useful untyped surplus", () => {
  const payment = makePayment("cumulative-xudt-cover", 0, 0, XUDT_A, 100n);
  const typed = [
    makeCell("cumulative-xudt-cover-a", 500, 0, {
      typeId: XUDT_A.typeId,
      amount: 60n,
    }),
    makeCell("cumulative-xudt-cover-b", 500, 1, {
      typeId: XUDT_A.typeId,
      amount: 60n,
    }),
  ];
  const surplus = Array.from({ length: 6 }, (_, index) =>
    makeCell(`cumulative-xudt-surplus-${index}`, 500, index + 2),
  );
  const cells = [...typed, ...surplus];
  const plan = constructSingleChangePlan(cells, payment, DEFAULT_PROFILE);
  assert.ok(plan);

  for (const inputIds of [plan.inputIds, [...plan.inputIds].reverse()]) {
    const result = validatePlan(
      payment,
      { ...plan, inputIds },
      cells,
      DEFAULT_PROFILE,
      0,
      {
        boundary: "damped-quantum",
        confirmedInventory: queriedInventory(cells, payment),
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.ok(result.violations.includes("invalid-repair-inputs"));
  }
});

test("agreement rejects oversized and unproductive repair suffixes", () => {
  const payment = makePayment("repair-suffix-boundaries", 100, 0);
  const whale = makeCell("repair-suffix-whale", 500, 0);
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  const dust = Array.from({ length: target + 1 }, (_, index) =>
    makeCell(`repair-suffix-dust-${index}`, 80, index + 1),
  );
  const oversized = constructSingleChangePlan(
    [whale, ...dust],
    payment,
    limits,
  );
  assert.ok(oversized);
  const oversizedResult = validatePlan(
    payment,
    oversized,
    [whale, ...dust],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([whale, ...dust], payment),
    },
  );
  assert.equal(oversizedResult.ok, false);
  if (!oversizedResult.ok)
    assert.ok(oversizedResult.violations.includes("invalid-repair-inputs"));

  const unproductive = constructSingleChangePlan(
    [whale, dust[0]],
    payment,
    limits,
  );
  assert.ok(unproductive);
  const unproductiveResult = validatePlan(
    payment,
    unproductive,
    [whale, dust[0]],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([whale, dust[0]], payment),
    },
  );
  assert.equal(unproductiveResult.ok, false);
  if (!unproductiveResult.ok)
    assert.ok(
      unproductiveResult.violations.includes("unproductive-repair-inputs"),
    );
});

test("damped agreement fails closed without confirmed inventory", () => {
  const payment = makePayment("missing-confirmed-inventory", 100, 0);
  const whale = makeCell("missing-confirmed-inventory-whale", 10_000, 0);
  const plan = constructQuantumPlan(
    [whale],
    payment,
    policyLimits(DEFAULT_PROFILE),
    maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE)),
  );
  assert.ok(plan);
  const result = validatePlan(payment, plan, [whale], DEFAULT_PROFILE, 0, {
    boundary: "damped-quantum",
  });
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.ok(result.violations.includes("missing-confirmed-inventory"));
});

test("one inventory target owns construction, query, and agreement", () => {
  const payment = makePayment("shared-inventory-target", 100, 0);
  const limits = policyLimits(DEFAULT_PROFILE);
  const generationLimit = maximumQuantumLanes(payment, limits);
  const whale = makeCell("shared-inventory-target-whale", 10_000, 0);
  const lowerTarget = 2;
  const lowerSnapshot = {
    cells: [whale],
    queried: true as const,
    target: lowerTarget,
  };
  const shaped = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView([whale], limits),
    lanes: { untyped: new LaneView([whale], limits) },
    confirmedInventory: lowerSnapshot,
    pendingOutputs: [],
  });
  assert.ok(shaped);
  assert.equal(shaped.change.length, lowerTarget);

  const zeroTarget = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView([whale], limits),
    lanes: { untyped: new LaneView([whale], limits) },
    confirmedInventory: {
      cells: [whale],
      queried: true,
      target: 0,
    },
    pendingOutputs: [],
  });
  assert.ok(zeroTarget);
  assert.equal(zeroTarget.change.length, 1);

  const exactInput = makeCell("shared-inventory-target-exact", 1_000, 0);
  const exactPayment = makePayment("shared-inventory-target-exact", 1, 0);
  const exactFee = transactionFee(
    {
      inputs: [exactInput],
      recipient: makeRecipient(exactPayment),
      change: [],
    },
    DEFAULT_PROFILE.structural,
  ).fee;
  exactPayment.amount = exactInput.capacity - exactFee;
  exactPayment.recipientCapacity = exactPayment.amount;
  const exactPlan = constructQuantumMinimalPlan(
    [exactInput],
    exactPayment,
    limits,
  );
  assert.ok(exactPlan);
  assert.equal(exactPlan.change.length, 0);
  for (const confirmedInventory of [
    { cells: [exactInput], queried: true as const, target: 0 },
    {
      cells: [exactInput],
      queried: true as const,
      target: generationLimit,
      unresolved: { untyped: true, paymentType: false },
    },
  ])
    assert.equal(
      validatePlan(
        exactPayment,
        exactPlan,
        [exactInput],
        DEFAULT_PROFILE,
        0,
        { boundary: "damped-quantum", confirmedInventory },
      ).ok,
      true,
    );

  const repair = makeCell("shared-inventory-target-repair", 80, 1);
  const nonminimalAtZero = constructQuantumPlan(
    [whale, repair],
    payment,
    limits,
    2,
  );
  assert.ok(nonminimalAtZero);
  const zeroValidation = validatePlan(
    payment,
    nonminimalAtZero,
    [whale, repair],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: {
        cells: [whale, repair],
        queried: true,
        target: 0,
      },
    },
  );
  assert.equal(zeroValidation.ok, false);
  if (!zeroValidation.ok)
    assert.ok(zeroValidation.violations.includes("target-zero-nonminimal"));

  const invalidValidation = validatePlan(
    payment,
    zeroTarget,
    [whale],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: {
        cells: [whale],
        queried: true,
        target: Number.NaN,
      },
    },
  );
  assert.equal(invalidValidation.ok, false);
  if (!invalidValidation.ok)
    assert.ok(invalidValidation.violations.includes("invalid-inventory-target"));

  const overTarget = constructQuantumPlan([whale], payment, limits, 4);
  assert.ok(overTarget);
  const saturatedSnapshot = {
    cells: [
      whale,
      makeCell("shared-inventory-target-existing-a", 500, 1),
      makeCell("shared-inventory-target-existing-b", 500, 2),
    ],
    queried: true as const,
    target: lowerTarget,
  };
  const validation = validatePlan(
    payment,
    overTarget,
    [whale],
    DEFAULT_PROFILE,
    0,
    { boundary: "damped-quantum", confirmedInventory: saturatedSnapshot },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("inventory-growth-ceiling"));

  const raisedTarget = generationLimit + 3;
  const cells = Array.from({ length: raisedTarget + 2 }, (_, index) =>
    makeCell(`shared-inventory-target-${index}`, 500, index),
  );
  let targetDerivations = 0;
  const policy: Policy = {
    id: "shared-inventory-target",
    inventoryTarget: () => {
      targetDerivations += 1;
      return raisedTarget;
    },
    validationBoundary: "damped-quantum",
    propose(context) {
      assert.equal(context.confirmedInventory?.queried, true);
      assert.equal(context.confirmedInventory?.target, raisedTarget);
      assert.equal(context.confirmedInventory?.cells.length, raisedTarget + 1);
      return undefined;
    },
  };
  runScenario(
    {
      id: "shared-inventory-target",
      windows: 2,
      exactGate: false,
      maximumPerIdentityNetCellGrowth: 0,
      cells,
      payments: [payment],
    },
    policy,
    DEFAULT_PROFILE,
  );
  assert.equal(targetDerivations, 1);

  let invalidTargetDerivations = 0;
  const invalidTargetPolicy: Policy = {
    id: "invalid-inventory-target",
    inventoryTarget: () => {
      invalidTargetDerivations += 1;
      return Number.NaN;
    },
    validationBoundary: "damped-quantum",
    propose(context) {
      assert.equal(context.confirmedInventory, undefined);
      return undefined;
    },
  };
  const invalidTargetResult = runScenario(
    {
      id: "invalid-inventory-target",
      windows: 2,
      exactGate: false,
      cells: [whale],
      payments: [payment],
    },
    invalidTargetPolicy,
    DEFAULT_PROFILE,
  );
  assert.equal(invalidTargetDerivations, 1);
  assert.equal(invalidTargetResult.metrics.accepted, 0);
  assert.equal(
    boundedValueQuantum.inventoryTarget?.(payment, limits),
    provisionalInventoryTarget(payment, limits),
  );
});

test("failed lifecycle proposals are not counted as transactions", () => {
  const scenario: Scenario = {
    id: "failed-multi-change",
    windows: 1,
    exactGate: true,
    cells: [makeCell("failed-multi-change-cell", 1_000, 0)],
    payments: [makePayment("failed-multi-change-payment", 100, 0)],
    lifecycle: { "failed-multi-change-payment": ["rpc-rejection"] },
  };
  const result = runScenario(
    scenario,
    oldestFirstLanePreserving,
    DEFAULT_PROFILE,
  );
  const summary = summarizePolicy([result]);
  assert.equal(result.metrics.accepted, 0);
  assert.equal(summary.totalChangeOutputs, 0);
  assert.equal(summary.multiChangeTransactions, 0);
  assert.equal(summary.maximumChangeOutputs, 0);
});

test("only exact-floor typed change is accepted", () => {
  const floorScenarios = scenarios.filter((scenario) =>
    scenario.id.startsWith("xudt-typed-change-floor-"),
  );
  const accepted = floorScenarios.map(
    (scenario) =>
      runScenario(
        scenario,
        biggestFirstSingleChange,
        structuredClone(DEFAULT_PROFILE),
      ).metrics.accepted,
  );
  assert.deepEqual(accepted, [0, 1, 0]);
});

test("invalid orders do not make a policy ineligible", () => {
  const payment = makePayment("below-floor", 67, 0);
  payment.amount -= 1n;
  payment.recipientCapacity = payment.amount;
  const scenario: Scenario = {
    id: "invalid-order",
    windows: 1,
    exactGate: false,
    cells: [makeCell("cell", 500, 0)],
    payments: [payment],
  };
  const result = runScenario(scenario, biggestFirstSingleChange, DEFAULT_PROFILE);
  assert.equal(result.outcomes[0].kind, "invalid-order");
  assert.equal(result.eligible, true);
});

test("every proven oracle miss is a hard gate", () => {
  const noPlan: Policy = { id: "no-plan", propose: () => undefined };
  const scenario: Scenario = {
    id: "proven-miss",
    windows: 1,
    exactGate: false,
    cells: [makeCell("cell", 500, 0)],
    payments: [makePayment("payment", 100, 0)],
  };
  const result = runScenario(scenario, noPlan, DEFAULT_PROFILE);
  assert.equal(result.metrics.exactMisses, 1);
  assert.equal(result.eligible, false);
});

test("signing delay hides outputs until signing succeeds", () => {
  let observedPending = -1;
  const policy: Policy = {
    id: "pending-observer",
    propose(context) {
      if (context.payment.id === "second")
        observedPending = context.pendingOutputs.length;
      const cells = context.candidates.readNextPage();
      return constructSingleChangePlan(cells.slice(0, 1), context.payment, context.limits);
    },
  };
  const scenario: Scenario = {
    id: "signing-delay",
    windows: 2,
    exactGate: true,
    cells: [makeCell("first-cell", 500, 0), makeCell("second-cell", 500, 1)],
    payments: [makePayment("first", 100, 0), makePayment("second", 100, 1)],
    lifecycle: { first: ["signing-delay"] },
  };
  runScenario(scenario, policy, DEFAULT_PROFILE);
  assert.equal(observedPending, 0);
});

test("H1 treats same-window accepted change as unresolved", () => {
  const payment = makePayment("same-window-unresolved", 100, 0);
  const result = runScenario(
    {
      id: "same-window-unresolved",
      windows: 1,
      exactGate: true,
      maximumPerIdentityNetCellGrowth: 4,
      cells: [
        makeCell("same-window-first", 500, 0),
        makeCell("same-window-second", 500, 1),
      ],
      payments: [payment, { ...payment, id: "same-window-follow-up" }],
    },
    orderQuantum,
    DEFAULT_PROFILE,
  );
  const changeCounts = result.outcomes
    .filter((outcome) => outcome.kind === "accepted")
    .map((outcome) => outcome.changeCount);
  assert.ok(changeCounts[0] !== undefined && changeCounts[0] > 1);
  assert.equal(changeCounts[1], 1);
});

test("H1 inventory excludes locally reserved confirmed cells", () => {
  const result = runScenario(
    {
      id: "order-quantum-reservation-inventory",
      windows: 1,
      exactGate: true,
      cells: Array.from({ length: 5 }, (_, index) =>
        makeCell(`order-quantum-reservation-cell-${index}`, 500, index),
      ),
      payments: [
        makePayment("order-quantum-reservation-first", 100, 0),
        makePayment("order-quantum-reservation-second", 100, 0),
      ],
      lifecycle: { "order-quantum-reservation-first": ["rpc-rejection"] },
      maximumPerIdentityNetCellGrowth: 1,
    },
    orderQuantum,
    DEFAULT_PROFILE,
  );
  const accepted = result.outcomes.find(
    (outcome) => outcome.paymentId === "order-quantum-reservation-second",
  );
  assert.equal(accepted?.kind, "accepted");
  assert.equal(accepted?.changeCount, 2);
});

test("unresolved signing change permits only canonical minimal follow-up", () => {
  const first = makePayment("unresolved-shaping-first", 100, 0);
  const second = makePayment("unresolved-shaping-second", 100, 0);
  const third = makePayment("unresolved-shaping-third", 100, 1);
  const cells = [
    makeCell("unresolved-shaping-first-cell", 10_000, 0),
    makeCell("unresolved-shaping-second-cell", 10_000, 1),
    makeCell("unresolved-shaping-third-cell", 10_000, 2),
  ];
  const result = runScenario(
    {
      id: "unresolved-shaping",
      windows: 5,
      exactGate: true,
      maximumPerIdentityNetCellGrowth: 4,
      cells,
      payments: [first, second, third],
      lifecycle: {
        [first.id]: ["signing-delay"],
        [second.id]: ["signing-delay"],
      },
    },
    boundedValueQuantum,
    DEFAULT_PROFILE,
  );
  const target = provisionalInventoryTarget(first, policyLimits(DEFAULT_PROFILE));
  assert.deepEqual(
    result.outcomes
      .filter((outcome) => outcome.kind === "accepted")
      .map((outcome) => outcome.changeCount),
    [target - 2, 1, 1],
  );
  assert.equal(result.metrics.policyNetCellGrowth, target - 3);
  assert.deepEqual(result.gateFailures, []);

  const limits = policyLimits(DEFAULT_PROFILE);
  const shaped = constructQuantumPlan([cells[0]], first, limits, target);
  assert.ok(shaped);
  const validation = validatePlan(
    first,
    shaped,
    [cells[0]],
    DEFAULT_PROFILE,
    1,
    {
      boundary: "damped-quantum",
      confirmedInventory: {
        cells,
        queried: true,
        target: provisionalInventoryTarget(first, limits),
        unresolved: { untyped: true, paymentType: false },
      },
    },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(
      validation.violations.includes("unresolved-inventory-nonminimal"),
    );

  const xudtPayment = makePayment(
    "unresolved-payment-type",
    0,
    0,
    XUDT_A,
    100n,
  );
  const xudtInput = makeCell("unresolved-payment-type-input", 10_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 10_000n,
  });
  const xudtShaped = constructQuantumPlan(
    [xudtInput],
    xudtPayment,
    limits,
    3,
  );
  assert.ok(xudtShaped);
  const xudtMinimal = constructQuantumMinimalPlan(
    [xudtInput],
    xudtPayment,
    limits,
  );
  assert.ok(xudtMinimal);
  for (const unresolved of [
    { untyped: true, paymentType: false },
    { untyped: false, paymentType: true },
    { untyped: true, paymentType: true },
  ]) {
    const options = {
      boundary: "damped-quantum" as const,
      confirmedInventory: {
        cells: [xudtInput],
        queried: true as const,
        target: provisionalInventoryTarget(xudtPayment, limits),
        unresolved,
      },
    };
    const shapedValidation = validatePlan(
      xudtPayment,
      xudtShaped,
      [xudtInput],
      DEFAULT_PROFILE,
      0,
      options,
    );
    assert.equal(shapedValidation.ok, false);
    if (!shapedValidation.ok)
      assert.ok(
        shapedValidation.violations.includes(
          "unresolved-inventory-nonminimal",
        ),
      );
    assert.equal(
      validatePlan(
        xudtPayment,
        xudtMinimal,
        [xudtInput],
        DEFAULT_PROFILE,
        0,
        options,
      ).ok,
      true,
    );
  }
});

test("ambiguous restart exercises confirmation and declared release", () => {
  const scenario = scenarios.find((item) => item.id === "lifecycle-matrix");
  assert.ok(scenario);
  const result = runScenario(scenario, biggestFirstSingleChange, DEFAULT_PROFILE);
  assert.ok(
    result.outcomes.some(
      (outcome) =>
        outcome.paymentId === "ambiguous-confirm-payment" &&
        outcome.kind === "confirmed",
    ),
  );
  assert.ok(
    result.outcomes.some(
      (outcome) =>
        outcome.paymentId === "ambiguous-release-payment" &&
        outcome.kind === "accepted" &&
        outcome.attempt === 2,
    ),
  );
});

test("events beyond the signing ceiling remain unattempted", () => {
  let calls = 0;
  const policy: Policy = {
    id: "call-counter",
    propose(context) {
      calls += 1;
      const cells = context.candidates.readNextPage();
      return constructSingleChangePlan(cells.slice(0, 1), context.payment, context.limits);
    },
  };
  const scenario: Scenario = {
    id: "unattempted",
    windows: 1,
    exactGate: false,
    cells: [makeCell("first-cell", 500, 0), makeCell("second-cell", 500, 1)],
    payments: [makePayment("first", 100, 0), makePayment("second", 100, 0)],
  };
  runScenario(scenario, policy, {
    ...structuredClone(DEFAULT_PROFILE),
    signingRoundCeiling: 1,
  });
  assert.equal(calls, 1);
});

test("native floor and residue boundary scenarios retain distinct outcomes", () => {
  const byId = new Map(
    scenarios.map((scenario) => [
      scenario.id,
      runScenario(scenario, biggestFirstSingleChange, DEFAULT_PROFILE),
    ]),
  );
  assert.equal(
    byId.get("native-recipient-floor--1")?.outcomes[0].kind,
    "invalid-order",
  );
  assert.equal(byId.get("native-recipient-floor--1")?.eligible, true);
  assert.equal(byId.get("native-exact-cover")?.metrics.accepted, 1);
  assert.equal(byId.get("native-residue-1")?.metrics.accepted, 0);
  assert.equal(
    byId.get(`native-residue-${61n * 100_000_000n - 1n}`)?.metrics.accepted,
    0,
  );
  assert.equal(
    byId.get(`native-residue-${61n * 100_000_000n}`)?.metrics.accepted,
    1,
  );
  assert.equal(
    byId.get(`native-residue-${61n * 100_000_000n + 1n}`)?.metrics.accepted,
    1,
  );
});

test("maturing inputs become selectable at their scheduled window", () => {
  const scenario = scenarios.find(
    (item) => item.id === "cellbase-maturity-transition",
  );
  assert.ok(scenario);
  const result = runScenario(scenario, biggestFirstSingleChange, DEFAULT_PROFILE);
  assert.ok(
    result.outcomes.some(
      (outcome) => outcome.kind === "accepted" && outcome.window === 2,
    ),
  );
});

test("pending inventory replaces its reserved predecessors", () => {
  const scenario: Scenario = {
    id: "pending-inventory",
    windows: 1,
    exactGate: true,
    cells: [makeCell("cell", 500, 0)],
    payments: [makePayment("payment", 100, 0)],
  };
  const result = runScenario(scenario, biggestFirstSingleChange, DEFAULT_PROFILE);
  assert.equal(result.metrics.peakPendingCells, 1);
  assert.equal(result.metrics.finalPendingCells, 1);
  assert.equal(result.metrics.finalProjectedCells, 1);
});

test("H1 constructor receives outputs from unresolved pending transactions", () => {
  const pendingOutputCounts: number[] = [];
  const policy: Policy = {
    ...orderQuantum,
    id: "order-quantum-pending-observer",
    propose(context) {
      pendingOutputCounts.push(context.pendingOutputs.length);
      return orderQuantum.propose(context);
    },
  };
  const scenario: Scenario = {
    id: "order-quantum-unresolved-pending",
    windows: 1,
    exactGate: false,
    cells: [
      makeCell("order-quantum-pending-a", 100_000, 0),
      makeCell("order-quantum-pending-b", 100_000, 1),
    ],
    payments: [
      makePayment("order-quantum-pending-first", 100, 0),
      makePayment("order-quantum-pending-second", 100, 0),
    ],
    lifecycle: {
      "order-quantum-pending-first": ["signing-delay"],
    },
  };
  const result = runScenario(scenario, policy, DEFAULT_PROFILE);
  assert.equal(result.metrics.accepted, 2);
  assert.equal(pendingOutputCounts[0], 0);
  assert.ok(pendingOutputCounts[1] > 0);
});

test("pending replacements do not hide a lane-target deficit", () => {
  const scenario: Scenario = {
    id: "pending-target-deficit",
    windows: 2,
    exactGate: true,
    cells: Array.from({ length: 6 }, (_, index) =>
      makeCell(`pending-target-${index}`, 500, index),
    ),
    payments: [
      makePayment("pending-target-payment-0", 100, 0),
      makePayment("pending-target-payment-1", 100, 0),
    ],
  };
  const result = runScenario(
    scenario,
    oldestFirstRepresentativeFloorEight,
    DEFAULT_PROFILE,
  );
  assert.equal(result.metrics.accepted, 2);
  assert.deepEqual(
    result.outcomes
      .filter((outcome) => outcome.kind === "accepted")
      .map((outcome) => outcome.changeCount),
    [2, 2],
  );
  assert.equal(result.metrics.finalProjectedCells, 8);
});

test("quantum shaping provisions one byte-bounded native generation", () => {
  const payment = makePayment("quantum-native-seed", 100, 0);
  const target = maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE));
  assert.equal(target, 5);
  const scenario: Scenario = {
    id: "quantum-native-generation",
    windows: 3,
    exactGate: false,
    cells: [makeCell("quantum-native-whale", 100_000, 0)],
    payments: [
      payment,
      ...Array.from({ length: target }, (_, index) =>
        makePayment(`quantum-native-burst-${index}`, 100, 1),
      ),
    ],
    burstWindow: 1,
    burstKind: "warm",
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  assert.equal(result.metrics.burstImmediate, target);
  const seed = result.outcomes.find(
    (outcome) =>
      outcome.paymentId === payment.id && outcome.kind === "accepted",
  );
  assert.equal(seed?.changeCount, target);
  assert.ok(
    seed?.change?.every(
      (change) =>
        change.capacity >= nativeQuantum(payment, policyLimits(DEFAULT_PROFILE)),
    ),
  );
});

test("quantum shaping provisions complete xUDT pairs", () => {
  const payment = makePayment("quantum-xudt-seed", 0, 0, XUDT_A, 50n);
  const target = maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE));
  assert.equal(target, 3);
  const scenario: Scenario = {
    id: "quantum-xudt-generation",
    windows: 3,
    exactGate: false,
    cells: [
      makeCell("quantum-xudt-whale", 100_000, 0, {
        typeId: XUDT_A.typeId,
        amount: 100_000n,
      }),
    ],
    payments: [
      payment,
      ...Array.from({ length: target }, (_, index) =>
        makePayment(`quantum-xudt-burst-${index}`, 0, 1, XUDT_A, 50n),
      ),
    ],
    burstWindow: 1,
    burstKind: "warm",
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  assert.equal(result.metrics.burstImmediate, target);
  const seed = result.outcomes.find(
    (outcome) =>
      outcome.paymentId === payment.id && outcome.kind === "accepted",
  );
  assert.equal(seed?.changeCount, target * 2);
  const typed = seed?.change?.filter(
    (change) => change.tokenAmount !== undefined,
  );
  const untyped = seed?.change?.filter(
    (change) => change.tokenAmount === undefined,
  );
  assert.equal(typed?.length, target);
  assert.equal(untyped?.length, target);
  assert.ok(typed?.every((change) => change.tokenAmount! >= payment.amount));
  assert.ok(
    untyped?.every(
      (change) =>
        change.capacity >= xudtMateQuantum(payment, policyLimits(DEFAULT_PROFILE)),
    ),
  );
});

test("exact-cover exhaustion recovers from the next deposit", () => {
  const cell = makeCell("quantum-exact-drain", 100_000, 0);
  const drain = makePayment("quantum-exact-drain-payment", 100, 0);
  drain.amount = cell.capacity;
  drain.recipientCapacity = drain.amount;
  const fee = transactionFee(
    { inputs: [cell], recipient: makeRecipient(drain), change: [] },
    DEFAULT_PROFILE.structural,
  ).fee;
  drain.amount -= fee;
  drain.recipientCapacity = drain.amount;
  const target = maximumQuantumLanes(
    makePayment("quantum-recovery-template", 100, 1),
    policyLimits(DEFAULT_PROFILE),
  );
  const scenario: Scenario = {
    id: "quantum-exact-drain-recovery",
    windows: 4,
    exactGate: false,
    cells: [cell],
    deposits: [
      { window: 1, cell: makeCell("quantum-recovery-deposit", 100_000, 1) },
    ],
    payments: [
      drain,
      makePayment("quantum-recovery-payment", 100, 1),
      ...Array.from({ length: target }, (_, index) =>
        makePayment(`quantum-recovery-burst-${index}`, 100, 2),
      ),
    ],
    burstWindow: 2,
    burstKind: "warm",
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  const accepted = result.outcomes.filter(
    (outcome) => outcome.kind === "accepted",
  );
  assert.equal(accepted[0].changeCount, 0);
  assert.equal(accepted[1].changeCount, target);
  assert.equal(result.metrics.burstImmediate, target);
});

test("xUDT exact-cover exhaustion recovers from the next deposit", () => {
  const drain = makePayment("quantum-xudt-drain-payment", 0, 0, XUDT_A, 100n);
  const cell = makeCell("quantum-xudt-drain", 0, 0, {
    typeId: XUDT_A.typeId,
    amount: 100n,
  });
  cell.capacity = drain.recipientCapacity;
  cell.capacity += transactionFee(
    { inputs: [cell], recipient: makeRecipient(drain), change: [] },
    DEFAULT_PROFILE.structural,
  ).fee;
  const template = makePayment("quantum-xudt-recovery-template", 0, 1, XUDT_A, 100n);
  const target = maximumQuantumLanes(template, policyLimits(DEFAULT_PROFILE));
  const scenario: Scenario = {
    id: "quantum-xudt-exact-drain-recovery",
    windows: 4,
    exactGate: false,
    cells: [cell],
    deposits: [
      {
        window: 1,
        cell: makeCell("quantum-xudt-recovery-deposit", 100_000, 1, {
          typeId: XUDT_A.typeId,
          amount: 10_000n,
        }),
      },
    ],
    payments: [
      drain,
      makePayment("quantum-xudt-recovery-payment", 0, 1, XUDT_A, 100n),
      ...Array.from({ length: target }, (_, index) =>
        makePayment(`quantum-xudt-recovery-burst-${index}`, 0, 2, XUDT_A, 100n),
      ),
    ],
    burstWindow: 2,
    burstKind: "warm",
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  const accepted = result.outcomes.filter(
    (outcome) => outcome.kind === "accepted",
  );
  assert.equal(accepted[0].changeCount, 0);
  assert.equal(accepted[1].changeCount, target * 2);
  assert.equal(result.metrics.burstImmediate, target);
});

test("quantum damping is bounded under serial and bimodal traffic", () => {
  const cases: Array<{
    scenario: Scenario;
    expectedInventory: number;
  }> = [
    {
      scenario: {
        id: "quantum-serial-500",
        windows: 502,
        exactGate: false,
        cells: [makeCell("quantum-serial-whale", 1_000_000, 0)],
        payments: Array.from({ length: 500 }, (_, index) =>
          makePayment(`quantum-serial-${index}`, 100, index),
        ),
      },
      expectedInventory: 5,
    },
    {
      scenario: {
        id: "quantum-bimodal-500",
        windows: 502,
        exactGate: false,
        cells: [makeCell("quantum-bimodal-whale", 10_000_000, 0)],
        payments: Array.from({ length: 500 }, (_, index) =>
          makePayment(
            `quantum-bimodal-${index}`,
            index % 2 === 0 ? 200 : 20_000,
            index,
          ),
        ),
      },
      expectedInventory: 5,
    },
    {
      scenario: {
        id: "quantum-xudt-serial-500",
        windows: 502,
        exactGate: false,
        cells: [
          makeCell("quantum-xudt-serial-whale", 1_000_000, 0, {
            typeId: XUDT_A.typeId,
            amount: 1_000_000n,
          }),
        ],
        payments: Array.from({ length: 500 }, (_, index) =>
          makePayment(`quantum-xudt-serial-${index}`, 0, index, XUDT_A, 50n),
        ),
      },
      expectedInventory: 6,
    },
  ];
  for (const { scenario, expectedInventory } of cases) {
    const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
    assert.equal(result.metrics.accepted, 500, scenario.id);
    assert.equal(result.metrics.backlogArea, 0, scenario.id);
    assert.equal(result.metrics.finalProjectedCells, expectedInventory, scenario.id);
    assert.equal(result.metrics.peakProjectedCells, expectedInventory, scenario.id);
  }
});

test("xUDT remainders consolidate to bounded paired inventory", () => {
  const template = makePayment(
    "quantum-xudt-remainder-template",
    0,
    0,
    XUDT_A,
    100n,
  );
  const target = maximumQuantumLanes(template, policyLimits(DEFAULT_PROFILE));
  const scenario: Scenario = {
    id: "quantum-xudt-many-small-remainders",
    windows: 502,
    exactGate: false,
    cells: Array.from({ length: 500 }, (_, index) =>
      makeCell(`quantum-xudt-remainder-${index}`, 500, index, {
        typeId: XUDT_A.typeId,
        amount: 200n,
      }),
    ),
    payments: Array.from({ length: 500 }, (_, index) =>
      makePayment(`quantum-xudt-remainder-payment-${index}`, 0, index, XUDT_A, 100n),
    ),
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  assert.equal(result.metrics.accepted, 500);
  assert.equal(result.metrics.backlogArea, 0);
  assert.equal(result.metrics.policyNetCellGrowth, target * 2 - 500);
  assert.equal(result.metrics.finalProjectedCells, target * 2);
  assert.equal(result.metrics.peakProjectedCells, 500 + target - 1);
  assert.ok(
    result.outcomes
      .filter((outcome) => outcome.kind === "accepted")
      .every((outcome) => outcome.changeCount === 2),
  );
});

test("bounded identity cleanup replaces hidden native floor donations", () => {
  const target = maximumQuantumLanes(
    makePayment("quantum-donation-template", 20_000, 0),
    policyLimits(DEFAULT_PROFILE),
  );
  const scenario: Scenario = {
    id: "quantum-hidden-native-floor-donations",
    windows: 4,
    exactGate: false,
    cells: [
      makeCell("quantum-donation-whale", 10_000_000, 0),
      ...Array.from({ length: 99 }, (_, index) =>
        makeCell(`quantum-donation-foreign-${index}`, 500, index + 1, {
          typeId: XUDT_B.typeId,
          amount: 1n,
        }),
      ),
      ...Array.from({ length: target }, (_, index) =>
        makeCell(`quantum-donation-floor-${index}`, 61, 5_000 + index),
      ),
    ],
    payments: [
      makePayment("quantum-donation-seed", 20_000, 0),
      ...Array.from({ length: target }, (_, index) =>
        makePayment(`quantum-donation-burst-${index}`, 20_000, 1),
      ),
    ],
    burstWindow: 1,
    burstKind: "warm",
  };
  const result = runScenario(scenario, boundedValueQuantum, {
    ...structuredClone(DEFAULT_PROFILE),
    id: "hidden-donation-prefix",
    candidateLimit: 100,
    pageLimit: 1,
  });
  const seed = result.outcomes.find(
    (outcome) => outcome.paymentId === "quantum-donation-seed" && outcome.kind === "accepted",
  );
  assert.equal(seed?.inputCount, target + 1);
  assert.equal(seed?.changeCount, target);
  assert.equal(result.metrics.invalidProposals, 0);
});

test("bounded identity cleanup replaces small xUDT donations", () => {
  const payment = makePayment("quantum-xudt-donation-template", 0, 0, XUDT_A, 100n);
  const target = maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE));
  const scenario: Scenario = {
    id: "quantum-small-xudt-donations",
    windows: 4,
    exactGate: false,
    cells: [
      makeCell("quantum-xudt-donation-whale", 100_000, 0, {
        typeId: XUDT_A.typeId,
        amount: 10_000n,
      }),
      ...Array.from({ length: target }, (_, index) =>
        makeCell(`quantum-xudt-donation-${index}`, 142, index + 1, {
          typeId: XUDT_A.typeId,
          amount: 1n,
        }),
      ),
    ],
    payments: [
      payment,
      ...Array.from({ length: target }, (_, index) =>
        makePayment(`quantum-xudt-donation-burst-${index}`, 0, 1, XUDT_A, 100n),
      ),
    ],
    burstWindow: 1,
    burstKind: "warm",
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  const seed = result.outcomes.find(
    (outcome) =>
      outcome.paymentId === "quantum-xudt-donation-template" &&
      outcome.kind === "accepted",
  );
  const repairedPairs = Math.floor((target + 1) / 2);
  assert.equal(seed?.inputCount, target + 1);
  assert.equal(seed?.changeCount, repairedPairs * 2);
  assert.ok((seed?.changeCount ?? Infinity) <= (seed?.inputCount ?? 0));
  assert.equal(result.metrics.burstImmediate, repairedPairs);
  assert.ok(result.metrics.finalProjectedCells <= target * 2);
  assert.equal(result.metrics.invalidProposals, 0);
});

test("xUDT cleanup reaches beyond the mixed candidate prefix", () => {
  const payment = makePayment("quantum-xudt-beyond-prefix", 0, 0, XUDT_A, 100n);
  const target = maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE));
  const donations = Array.from({ length: target }, (_, index) =>
    makeCell(`quantum-xudt-beyond-prefix-donation-${index}`, 142, 5_000 + index, {
      typeId: XUDT_A.typeId,
      amount: 1n,
    }),
  );
  const scenario: Scenario = {
    id: "quantum-xudt-beyond-prefix",
    windows: 2,
    exactGate: false,
    cells: [
      makeCell("quantum-xudt-beyond-prefix-cover", 100_000, 0, {
        typeId: XUDT_A.typeId,
        amount: 10_000n,
      }),
      ...Array.from({ length: 99 }, (_, index) =>
        makeCell(`quantum-xudt-beyond-prefix-floor-${index}`, 61, index + 1),
      ),
      ...donations,
    ],
    payments: [payment],
  };
  const result = runScenario(scenario, boundedValueQuantum, {
    ...structuredClone(DEFAULT_PROFILE),
    id: "xudt-beyond-prefix",
    candidateLimit: 100,
    pageSize: 100,
    pageLimit: 1,
  });
  const accepted = result.outcomes.find(
    (outcome) => outcome.paymentId === payment.id && outcome.kind === "accepted",
  );
  assert.equal(accepted?.inputCount, target * 2 + 1);
  assert.equal(accepted?.changeCount, target * 2);
  assert.ok(donations.every((cell) => accepted?.inputIds?.includes(cell.id)));
  assert.ok(result.metrics.policyNetCellGrowth <= 0);
  assert.equal(result.metrics.invalidProposals, 0);
});

test("xUDT cleanup uses bounded padding to restore feasible pairs", () => {
  const payment = makePayment("quantum-xudt-insufficient-repair", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const mate = xudtMateQuantum(payment, limits);
  const cover = makeCell("quantum-xudt-insufficient-cover", 500, 0, {
    typeId: XUDT_A.typeId,
    amount: 150n,
  });
  const typedUseful = Array.from({ length: 2 }, (_, index) =>
    makeCell(`quantum-xudt-insufficient-typed-${index}`, 142, index + 1, {
      typeId: XUDT_A.typeId,
      amount: 100n,
    }),
  );
  const untypedUseful = Array.from({ length: 2 }, (_, index) => {
    const cell = makeCell(
      `quantum-xudt-insufficient-untyped-${index}`,
      0,
      index + 3,
    );
    cell.capacity = mate;
    return cell;
  });
  const typedDonation = makeCell("quantum-xudt-insufficient-token", 142, 5, {
    typeId: XUDT_A.typeId,
    amount: 1n,
  });
  const untypedDonation = makeCell("quantum-xudt-insufficient-capacity", 61, 6);
  const cells = [
    cover,
    ...typedUseful,
    ...untypedUseful,
    typedDonation,
    untypedDonation,
  ];
  const plan = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView(cells, limits),
    lanes: {
      untyped: new LaneView([...untypedUseful, untypedDonation], limits),
      paymentType: new LaneView(
        [cover, ...typedUseful, typedDonation],
        limits,
      ),
    },
    confirmedInventory: queriedInventory(cells, payment),
    pendingOutputs: [],
  });
  assert.ok(plan);
  assert.deepEqual(new Set(plan.inputIds), new Set(cells.map((cell) => cell.id)));
  const recoveredPairs = 2;
  assert.equal(
    plan.change.filter((output) => output.tokenAmount !== undefined).length,
    recoveredPairs,
  );
  assert.equal(
    plan.change.filter((output) => output.tokenAmount === undefined).length,
    recoveredPairs,
  );

  const malicious = constructSingleChangePlan(
    [cover, typedDonation, untypedDonation],
    payment,
    limits,
  );
  assert.ok(malicious);
  const validation = validatePlan(
    payment,
    malicious,
    [cover, typedDonation, untypedDonation],
    DEFAULT_PROFILE,
    0,
    {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory(cells, payment),
    },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("repair-did-not-restore-lane"));
});

test("xUDT exact-token cover does not engage untyped-only repair", () => {
  const payment = makePayment("quantum-xudt-zero-remainder", 0, 0, XUDT_A, 100n);
  const scenario: Scenario = {
    id: "quantum-xudt-zero-remainder",
    windows: 2,
    exactGate: false,
    cells: [
      makeCell("quantum-xudt-zero-cover", 150, 0, {
        typeId: XUDT_A.typeId,
        amount: 100n,
      }),
      makeCell("quantum-xudt-zero-funding", 400, 1),
      ...Array.from({ length: 4 }, (_, index) =>
        makeCell(`quantum-xudt-zero-fragment-${index}`, 61, index + 2),
      ),
    ],
    payments: [payment],
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  const accepted = result.outcomes.find(
    (outcome) => outcome.paymentId === payment.id && outcome.kind === "accepted",
  );
  assert.equal(accepted?.inputCount, 2);
  assert.equal(accepted?.changeCount, 1);
  assert.equal(result.metrics.invalidProposals, 0);
});

test("exact-token xUDT capacity return obeys the strict identity ceiling", () => {
  const payment = makePayment("exact-token-conversion", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = provisionalInventoryTarget(payment, limits);
  for (let existing = 0; existing < 10; existing += 1) {
    const input = makeCell(`exact-token-conversion-input-${existing}`, 1_000, 0, {
      typeId: XUDT_A.typeId,
      amount: payment.amount,
    });
    const plan = constructQuantumMinimalPlan([input], payment, limits);
    assert.ok(plan);
    assert.equal(plan.change.length, 1);
    assert.equal(plan.change[0].tokenAmount, undefined);
    const confirmed = [
      input,
      ...Array.from({ length: Math.min(existing, target + 1) }, (_, index) =>
        makeCell(
          `exact-token-conversion-untyped-${existing}-${index}`,
          500,
          index + 1,
        ),
      ),
    ];
    const validation = validatePlan(payment, plan, [input], DEFAULT_PROFILE, 0, {
        boundary: "damped-quantum",
        confirmedInventory: {
          cells: confirmed,
          queried: true,
          target,
        },
      });
    assert.equal(validation.ok, existing < target);
  }

  const splitInputs = [
    makeCell("exact-token-conversion-split-a", 500, 0, {
      typeId: XUDT_A.typeId,
      amount: 40n,
    }),
    makeCell("exact-token-conversion-split-b", 500, 1, {
      typeId: XUDT_A.typeId,
      amount: 60n,
    }),
  ];
  const splitPlan = constructQuantumMinimalPlan(
    splitInputs,
    payment,
    limits,
  );
  assert.ok(splitPlan);
  assert.equal(splitPlan.inputIds.length, 2);
  assert.equal(splitPlan.change.length, 1);
  assert.equal(splitPlan.change[0].tokenAmount, undefined);
  assert.equal(
    validatePlan(payment, splitPlan, splitInputs, DEFAULT_PROFILE, 0, {
      boundary: "damped-quantum",
      confirmedInventory: {
        cells: splitInputs,
        queried: true,
        target,
      },
    }).ok,
    true,
  );
});

test("xUDT exact-token cover without cleanup remains minimal", () => {
  const payment = makePayment("quantum-xudt-zero-only", 0, 0, XUDT_A, 100n);
  const cover = makeCell("quantum-xudt-zero-only-cover", 400, 0, {
    typeId: XUDT_A.typeId,
    amount: payment.amount,
  });
  const limits = policyLimits(DEFAULT_PROFILE);
  const plan = boundedValueQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView([cover], limits),
    lanes: {
      untyped: new LaneView([], limits),
      paymentType: new LaneView([cover], limits),
    },
    confirmedInventory: queriedInventory([cover], payment),
    pendingOutputs: [],
  });
  assert.ok(plan);
  assert.deepEqual(plan.inputIds, [cover.id]);
  assert.equal(plan.change.length, 1);
  assert.equal(plan.change[0].tokenAmount, undefined);
  assert.equal(
    validatePlan(payment, plan, [cover], DEFAULT_PROFILE, 0, {
      boundary: "damped-quantum",
      confirmedInventory: queriedInventory([cover], payment),
    }).ok,
    true,
  );
});

test("bounded identity cleanup absorbs repeated floor donations", () => {
  const payment = makePayment("quantum-repeated-donation-template", 100, 0);
  const target = maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE));
  const scenario: Scenario = {
    id: "quantum-repeated-floor-donations",
    windows: 32,
    exactGate: false,
    cells: [
      makeCell("quantum-repeated-donation-whale", 10_000_000, 0),
      ...Array.from({ length: target * 3 }, (_, index) =>
        makeCell(`quantum-repeated-donation-initial-${index}`, 61, index + 1),
      ),
    ],
    deposits: Array.from({ length: 29 }, (_, index) => ({
      window: index + 1,
      cell: makeCell(`quantum-repeated-donation-${index}`, 61, 100 + index),
    })),
    payments: Array.from({ length: 30 }, (_, index) =>
      makePayment(`quantum-repeated-donation-payment-${index}`, 100, index),
    ),
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  assert.equal(result.metrics.accepted, 30);
  assert.equal(result.metrics.backlogArea, 0);
  assert.equal(result.metrics.policyNetCellGrowth, -30);
  assert.ok(result.metrics.finalProjectedCells <= target * 3);
  assert.equal(result.metrics.invalidProposals, 0);
});

test("same-type capacity funding preserves its extra token remainder", () => {
  const scenario: Scenario = {
    id: "quantum-same-type-capacity",
    windows: 2,
    exactGate: true,
    cells: [
      makeCell("quantum-token-cover", 142, 0, {
        typeId: XUDT_A.typeId,
        amount: 100n,
      }),
      makeCell("quantum-same-type-capacity", 5_000, 1, {
        typeId: XUDT_A.typeId,
        amount: 1n,
      }),
    ],
    payments: [makePayment("quantum-same-type-payment", 0, 0, XUDT_A, 100n)],
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  const accepted = result.outcomes.find((outcome) => outcome.kind === "accepted");
  assert.deepEqual(
    new Set(accepted?.inputIds),
    new Set(["quantum-token-cover", "quantum-same-type-capacity"]),
  );
  assert.equal(
    result.finalCells.reduce(
      (sum, cell) => sum + (cell.token?.typeId === XUDT_A.typeId ? cell.token.amount : 0n),
      0n,
    ),
    1n,
  );
});

test("oversized minimal fallback is a no-plan instead of an invalid proposal", () => {
  const cells = Array.from({ length: 300 }, (_, index) =>
    makeCell(`quantum-oversized-${index}`, 100, index),
  );
  const exact = makePayment("quantum-oversized-exact-payment", 1, 0);
  const exactFee = transactionFee(
    { inputs: cells, recipient: makeRecipient(exact), change: [] },
    DEFAULT_PROFILE.structural,
  ).fee;
  exact.amount = cells.reduce((sum, cell) => sum + cell.capacity, 0n) - exactFee;
  exact.recipientCapacity = exact.amount;
  const profile = {
    ...structuredClone(DEFAULT_PROFILE),
    id: "small-size-limit",
    maxTransactionBytes: 8_000,
  };
  for (const payment of [
    makePayment("quantum-oversized-change-payment", 25_000, 0),
    exact,
  ]) {
    const result = runScenario(
      {
        id: `quantum-oversized-${payment.id}`,
        windows: 1,
        exactGate: false,
        cells,
        payments: [payment],
      },
      boundedValueQuantum,
      profile,
    );
    assert.equal(result.metrics.invalidProposals, 0);
    assert.equal(result.metrics.accepted, 0);
    assert.ok(
      result.outcomes.some(
        (outcome) =>
          outcome.kind === "policy-no-fit" ||
          outcome.kind === "size-or-structural-infeasibility",
      ),
    );
  }
  assert.equal(constructQuantumPlan(cells, exact, profile, 6), undefined);
});

test("quantum shaping drains a burst without chaining", () => {
  const scenario: Scenario = {
    id: "quantum-three-cell-burst",
    windows: 20,
    exactGate: false,
    burstWindow: 0,
    burstKind: "cold",
    cells: Array.from({ length: 3 }, (_, index) =>
      makeCell(`quantum-burst-${index}`, 10_000, index),
    ),
    payments: Array.from({ length: 40 }, (_, index) =>
      makePayment(`quantum-burst-payment-${index}`, 100, 0),
    ),
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  assert.equal(result.metrics.burstImmediate, 3);
  assert.equal(result.metrics.accepted, 40);
  assert.ok(result.metrics.peakProjectedCells <= 9);
  assert.equal(result.metrics.invalidProposals, 0);
});

test("quantum selection makes bounded progress through hostile dust", () => {
  const scenario: Scenario = {
    id: "quantum-hostile-dust",
    windows: 102,
    exactGate: false,
    cells: Array.from({ length: 10_000 }, (_, index) =>
      makeCell(`quantum-hostile-dust-${index}`, 80, index),
    ),
    payments: Array.from({ length: 100 }, (_, index) =>
      makePayment(`quantum-hostile-dust-payment-${index}`, 100, index),
    ),
  };
  const result = runScenario(scenario, boundedValueQuantum, DEFAULT_PROFILE);
  assert.equal(result.metrics.accepted, 100);
  assert.equal(result.metrics.backlogArea, 0);
  assert.ok(result.metrics.finalProjectedCells < scenario.cells.length);
  assert.ok(result.metrics.cellsRead <= 230_000);
});

test("lane preservation does not grow an inventory that already has lanes", () => {
  const scenario: Scenario = {
    id: "stable-lanes",
    windows: 8,
    exactGate: false,
    cells: Array.from({ length: 5 }, (_, index) =>
      makeCell(`stable-${index}`, 1_000, index),
    ),
    payments: Array.from({ length: 5 }, (_, index) =>
      makePayment(`stable-payment-${index}`, 100, index),
    ),
  };
  const result = runScenario(
    scenario,
    oldestFirstLanePreserving,
    DEFAULT_PROFILE,
  );
  assert.equal(result.finalCells.length, 5);
  assert.ok(
    result.outcomes
      .filter((outcome) => outcome.kind === "accepted")
      .every((outcome) => outcome.changeCount === 1),
  );
});

test("transaction-relevant filtering excludes foreign prefix pressure", () => {
  const boundedPrefixOnly: Policy = {
    id: "bounded-prefix-only-lanes",
    propose(context) {
      const visible: Cell[] = [];
      for (;;) {
        const page = context.candidates.readNextPage();
        if (page.length === 0) break;
        visible.push(...page);
      }
      const isUntyped = (cell: Cell): boolean => cell.token === undefined;
      const isPaymentType = (cell: Cell): boolean =>
        context.payment.asset.kind === "xudt" &&
        cell.token?.typeId === context.payment.asset.typeId;
      const relevant = visible.filter(
        (cell) => isUntyped(cell) || isPaymentType(cell),
      );
      const selected: Cell[] = [];
      for (const cell of relevant) {
        selected.push(cell);
        const selectedIds = new Set(selected.map((input) => input.id));
        const outside = relevant.filter(
          (candidate) => !selectedIds.has(candidate.id),
        );
        const plan = constructLanePreservingPlan(
          selected,
          context.payment,
          context.limits,
          {
            untyped:
              context.payment.asset.kind === "native"
                ? outside.some(isUntyped)
                  ? 1
                  : 2
                : 0,
            paymentType:
              context.payment.asset.kind === "xudt"
                ? outside.some(isPaymentType)
                  ? 1
                  : 2
                : 0,
          },
        );
        if (plan) return plan;
      }
      return undefined;
    },
  };

  for (const id of ["native-hidden-lane-pressure"]) {
    const scenario = scenarios.find((item) => item.id === id);
    assert.ok(scenario);
    const result = runScenario(scenario, oldestFirstLanePreserving, {
      ...structuredClone(DEFAULT_PROFILE),
      id: "hidden-lane-prefix",
      candidateLimit: 100,
      pageLimit: 1,
    });
    const fragile = runScenario(scenario, boundedPrefixOnly, {
      ...structuredClone(DEFAULT_PROFILE),
      id: "hidden-lane-prefix",
      candidateLimit: 100,
      pageLimit: 1,
    });
    const targeted = runScenario(
      scenario,
      oldestFirstRepresentativeFloorEight,
      {
        ...structuredClone(DEFAULT_PROFILE),
        id: "hidden-lane-prefix",
        candidateLimit: 100,
        pageLimit: 1,
      },
    );
    const relevant = result.finalCells.filter((cell) =>
      id.startsWith("native")
        ? cell.token === undefined
        : cell.token?.typeId === XUDT_A.typeId,
    );
    assert.equal(result.eligible, true);
    assert.equal(result.metrics.accepted, 10);
    assert.equal(result.metrics.policyNetCellGrowth, 0);
    assert.equal(relevant.length, 2);
    assert.equal(fragile.eligible, true);
    assert.equal(fragile.metrics.accepted, 10);
    assert.equal(fragile.metrics.policyNetCellGrowth, 0);
    assert.equal(targeted.eligible, true);
    assert.equal(targeted.metrics.policyNetCellGrowth, 6);
    assert.equal(
      fragile.finalCells.filter((cell) =>
        id.startsWith("native")
          ? cell.token === undefined
          : cell.token?.typeId === XUDT_A.typeId,
      ).length,
      2,
    );
    assert.equal(
      targeted.finalCells.filter((cell) =>
        id.startsWith("native")
          ? cell.token === undefined
          : cell.token?.typeId === XUDT_A.typeId,
      ).length,
      8,
    );
    assert.ok(
      result.outcomes
        .filter((outcome) => outcome.kind === "accepted")
        .every((outcome) => outcome.changeCount === 1),
    );
  }
});

test("lane preservation falls back when two floors do not fit", () => {
  const scenario = scenarios.find((item) =>
    item.id.startsWith("native-residue-6100000000"),
  );
  assert.ok(scenario);
  const result = runScenario(
    scenario,
    oldestFirstLanePreserving,
    DEFAULT_PROFILE,
  );
  const accepted = result.outcomes.find((outcome) => outcome.kind === "accepted");
  assert.equal(accepted?.changeCount, 1);
});

test("pending-view differences change shape but both shapes verify", () => {
  const payment = makePayment("view-payment", 100, 0);
  const cell = makeCell("view-cell", 1_000, 0);
  const propose = (pendingOutputs: ReturnType<typeof materializeChange>) =>
    oldestFirstLanePreserving.propose({
      window: 0,
      payment,
      limits: policyLimits(DEFAULT_PROFILE),
      candidates: new CandidateView([cell], policyLimits(DEFAULT_PROFILE)),
      lanes: {
        untyped: new LaneView([cell], policyLimits(DEFAULT_PROFILE)),
      },
      pendingOutputs,
    });
  const withoutPending = propose([]);
  const withPending = propose(
    materializeChange(
      [{ capacity: 500n * 100_000_000n }],
      payment,
      DEFAULT_PROFILE,
    ),
  );
  assert.equal(withoutPending?.change.length, 2);
  assert.equal(withPending?.change.length, 1);
  assert.equal(
    validatePlan(payment, withoutPending!, [cell], DEFAULT_PROFILE, 0).ok,
    true,
  );
  assert.equal(
    validatePlan(payment, withPending!, [cell], DEFAULT_PROFILE, 0).ok,
    true,
  );
});
