import assert from "node:assert/strict";
import test from "node:test";
import { constructCanonicalPlan } from "../src/canonical-change.ts";
import { XUDT_A, makeCell, makePayment } from "../src/fixtures.ts";
import {
  DEFAULT_PROFILE,
  isPaymentToken,
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  policyLimits,
  transactionFee,
  transactionSize,
  type Cell,
  type Payment,
} from "../src/model.ts";
import { CandidateView, LaneView } from "../src/policy.ts";
import { exactOrderQuantumOracle } from "../src/oracle.ts";
import { orderQuantum } from "../src/policies/order-quantum.ts";
import {
  maximumQuantumLanes,
  nativeQuantum,
  xudtMateQuantum,
} from "../src/quantum-budget.ts";
import { shapingByteBudget } from "../src/shaping-budget.ts";
import { validatePlan } from "../src/validator.ts";

const proposeUnchecked = (
  cells: Cell[],
  payment: Payment,
  unresolved?: { untyped: boolean; paymentType: boolean },
  pendingOutputs: Cell[] = [],
) => {
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  return orderQuantum.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView(cells, limits),
    lanes: {
      untyped: new LaneView(
        cells.filter((cell) => cell.token === undefined),
        limits,
      ),
      paymentType:
        payment.asset.kind === "xudt"
          ? new LaneView(
              cells.filter((cell) => isPaymentToken(cell, payment)),
              limits,
            )
          : undefined,
    },
    confirmedInventory: { cells, queried: true, target, unresolved },
    pendingOutputs,
  });
};

const propose = (
  cells: Cell[],
  payment: Payment,
  unresolved?: { untyped: boolean; paymentType: boolean },
) => {
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  const plan = proposeUnchecked(cells, payment, unresolved);
  assert.ok(plan);
  const validation = validatePlan(payment, plan, cells, DEFAULT_PROFILE, 0, {
    boundary: "order-quantum",
    confirmedInventory: { cells, queried: true, target, unresolved },
  });
  assert.equal(validation.ok, true);
  return { plan, target };
};

const assertNearEqual = (values: bigint[]) => {
  const ordered = values.toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  assert.ok(ordered[ordered.length - 1] - ordered[0] <= 1n);
};

test("native H1 emits only equal payment-useful pieces", () => {
  const payment = makePayment("h1-native", 100, 0);
  const { plan, target } = propose(
    [makeCell("h1-native-whale", 100_000, 0)],
    payment,
  );
  assert.equal(plan.change.length, target);
  assert.ok(
    plan.change.every(
      (output) =>
        output.tokenAmount === undefined &&
        output.capacity >= nativeQuantum(payment, policyLimits(DEFAULT_PROFILE)),
    ),
  );
  assertNearEqual(plan.change.map((output) => output.capacity));
});

test("unresolved xUDT H1 repairs the ceiling without shaping", () => {
  const payment = makePayment("h1-unresolved-xudt", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  const typed = makeCell("h1-unresolved-xudt-typed", 5_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 1_000n,
  });
  const untyped = Array.from({ length: target }, (_, index) =>
    makeCell(`h1-unresolved-xudt-untyped-${index}`, 500, index + 1),
  );
  const plan = proposeUnchecked(
    [typed, ...untyped],
    payment,
    {
      untyped: true,
      paymentType: false,
    },
  );
  assert.ok(plan);
  assert.deepEqual(
    plan,
    constructCanonicalPlan([typed, untyped[0]], payment, limits),
  );
  const oracle = exactOrderQuantumOracle(
    payment,
    [typed, ...untyped],
    DEFAULT_PROFILE,
    0,
    {
      cells: [typed, ...untyped],
      queried: true,
      target,
      unresolved: { untyped: true, paymentType: false },
    },
    [],
  );
  assert.equal(oracle.adjudicated, true);
  assert.ok(oracle.adjudicated && oracle.plan);
});

test("H1 uses exact-token subsets only when largest-first cannot produce a plan", () => {
  const payment = makePayment("h1-exact-fallback", 0, 0, XUDT_A, 100n);
  const exact = makeCell("h1-exact-fallback-exact", 500, 0, {
    typeId: XUDT_A.typeId,
    amount: 100n,
  });
  const whale = makeCell("h1-exact-fallback-whale", 100_000, 1, {
    typeId: XUDT_A.typeId,
    amount: 1_000n,
  });
  const { plan } = propose([exact, whale], payment);
  assert.ok(plan.inputIds.includes(whale.id));
  assert.ok(!plan.inputIds.includes(exact.id));
  assert.ok(plan.change.some((output) => output.tokenAmount !== undefined));
});

test("H1 cleanup is invariant to IDs assigned to unequal fragments", () => {
  const payment = makePayment("h1-fragment-order", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const mate = xudtMateQuantum(payment, limits);
  const build = (reverseIds: boolean): Cell[] => {
    const typedAmounts = [1n, 80n, 80n, 80n];
    const typed = typedAmounts.map((amount, index) => {
      const cell = makeCell(
        `h1-fragment-typed-${reverseIds ? typedAmounts.length - index : index}`,
        0,
        index,
        { typeId: XUDT_A.typeId, amount },
      );
      cell.capacity = occupiedCapacity(cell);
      return cell;
    });
    const capacities = [mate - 1n, mate - 1n, mate - 1n, mate];
    const untyped = capacities.map((capacity, index) => {
      const cell = makeCell(
        `h1-fragment-untyped-${reverseIds ? capacities.length - index : index}`,
        0,
        typed.length + index,
      );
      cell.capacity = capacity;
      return cell;
    });
    return [...typed, ...untyped];
  };
  const summarize = (cells: Cell[]) => {
    const { plan } = propose(cells, payment);
    return plan.change.map((output) => ({
      capacity: output.capacity.toString(),
      tokenAmount: output.tokenAmount?.toString(),
    }));
  };
  const expected = summarize(build(false));
  assert.deepEqual(summarize(build(true)), expected);
  assert.ok(
    expected.some(
      (output) =>
        output.tokenAmount !== undefined && BigInt(output.tokenAmount) >= 100n,
    ),
  );
});

test("xUDT H1 replenishes typed and untyped payment-useful pieces", () => {
  const payment = makePayment("h1-xudt", 0, 0, XUDT_A, 100n);
  const input = makeCell("h1-xudt-whale", 100_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 1_000n,
  });
  const { plan, target } = propose([input], payment);
  const typed = plan.change.filter(
    (output) => output.tokenAmount !== undefined,
  );
  const untyped = plan.change.filter(
    (output) => output.tokenAmount === undefined,
  );
  assert.equal(typed.length, target);
  assert.equal(untyped.length, target);
  assert.ok(typed.every((output) => output.tokenAmount! >= payment.amount));
  assert.ok(
    untyped.every(
      (output) =>
        output.capacity >= xudtMateQuantum(payment, policyLimits(DEFAULT_PROFILE)),
    ),
  );
  assertNearEqual(typed.map((output) => output.tokenAmount!));
  assertNearEqual(untyped.map((output) => output.capacity));
});

test("unresolved H1 state permits only canonical change", () => {
  const payment = makePayment("h1-unresolved", 100, 0);
  const input = makeCell("h1-unresolved-whale", 100_000, 0);
  const cells = [input];
  const { plan } = propose(cells, payment, {
    untyped: true,
    paymentType: false,
  });
  const inputs = plan.inputIds.map((id) => cells.find((cell) => cell.id === id)!);
  const canonical = constructCanonicalPlan(
    inputs,
    payment,
    policyLimits(DEFAULT_PROFILE),
  );
  assert.deepEqual(plan, canonical);
});

test("unresolved H1 permits bounded growth from known pending outputs", () => {
  const payment = makePayment("h1-unresolved-known-change", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const input = makeCell("h1-unresolved-known-change-input", 5_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 200n,
  });
  const pending = [
    makeCell("h1-unresolved-known-change-typed", 142, 1, {
      typeId: XUDT_A.typeId,
      amount: 100n,
    }),
    makeCell("h1-unresolved-known-change-untyped", 500, 2),
  ];
  const plan = proposeUnchecked(
    [input],
    payment,
    { untyped: true, paymentType: true },
    pending,
  );
  assert.ok(plan);
  assert.deepEqual(plan, constructCanonicalPlan([input], payment, limits));
});

test("H1 consumes a smallest confirmed mate instead of growing a full pool", () => {
  const payment = makePayment("h1-ceiling-repair", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  const typed = makeCell("h1-ceiling-repair-typed", 10_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 10_000n,
  });
  const untyped = Array.from({ length: target }, (_, index) =>
    makeCell(`h1-ceiling-repair-untyped-${index}`, 500 + index, index + 1),
  );
  const { plan } = propose([typed, ...untyped], payment);
  assert.ok(plan.inputIds.includes(untyped[0].id));
});

test("H1 retries exact-token cover when comparator repair cannot fit", () => {
  const payment = makePayment("h1-repair-exact-fallback", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const whale = makeCell("h1-repair-exact-fallback-whale", 5_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 1_000n,
  });
  const exact = makeCell("h1-repair-exact-fallback-exact", 0, 1, {
    typeId: XUDT_A.typeId,
    amount: 100n,
  });
  exact.capacity =
    payment.recipientCapacity +
    transactionFee(
      { inputs: [exact], recipient: makeRecipient(payment), change: [] },
      limits.structural,
    ).fee;
  const pending = Array.from(
    { length: maximumQuantumLanes(payment, limits) },
    (_, index) =>
      makeCell(`h1-repair-exact-fallback-pending-${index}`, 500, index + 2),
  );
  const plan = proposeUnchecked([whale, exact], payment, undefined, pending);
  assert.ok(plan);
  assert.deepEqual(plan.inputIds, [exact.id]);
  assert.deepEqual(plan.change, []);
});

test("H1 searches a bounded feasible window in inventories above 30 cells", () => {
  const payment = makePayment("h1-bounded-exact-window", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const exact = makeCell("h1-bounded-exact-window-exact", 0, 31, {
    typeId: XUDT_A.typeId,
    amount: 100n,
  });
  exact.capacity =
    payment.recipientCapacity +
    transactionFee(
      { inputs: [exact], recipient: makeRecipient(payment), change: [] },
      limits.structural,
    ).fee;
  const whales = Array.from({ length: 31 }, (_, index) =>
    makeCell(`h1-bounded-exact-window-whale-${index}`, 5_000, index, {
      typeId: XUDT_A.typeId,
      amount: 1_000n,
    }),
  );
  const pending = Array.from(
    { length: maximumQuantumLanes(payment, limits) },
    (_, index) => makeCell(`h1-bounded-exact-window-pending-${index}`, 500, index),
  );
  const plan = proposeUnchecked([...whales, exact], payment, undefined, pending);
  assert.ok(plan);
  assert.deepEqual(plan.inputIds, [exact.id]);
});

test("unresolved H1 retries exact-token cover when canonical change grows inventory", () => {
  const payment = makePayment("h1-unresolved-exact-fallback", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const exact = makeCell("h1-unresolved-exact-fallback-exact", 0, 1, {
    typeId: XUDT_A.typeId,
    amount: 100n,
  });
  exact.capacity =
    payment.recipientCapacity +
    transactionFee(
      { inputs: [exact], recipient: makeRecipient(payment), change: [] },
      limits.structural,
    ).fee;
  const whale = makeCell("h1-unresolved-exact-fallback-whale", 5_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 1_000n,
  });
  const pending = Array.from(
    { length: maximumQuantumLanes(payment, limits) },
    (_, index) =>
      makeCell(`h1-unresolved-exact-fallback-pending-${index}`, 500, index + 2),
  );
  const plan = proposeUnchecked(
    [whale, exact],
    payment,
    { untyped: true, paymentType: false },
    pending,
  );
  assert.ok(plan);
  assert.deepEqual(plan.inputIds, [exact.id]);
  assert.deepEqual(plan.change, []);
});

test("H1 exact oracle uses constructor unresolved ceilings", () => {
  const payment = makePayment("h1-unresolved-oracle", 0, 0, XUDT_A, 100n);
  const limits = policyLimits(DEFAULT_PROFILE);
  const whale = makeCell("h1-unresolved-oracle-whale", 5_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 1_000n,
  });
  const result = exactOrderQuantumOracle(
    payment,
    [whale],
    DEFAULT_PROFILE,
    0,
    {
      cells: [whale],
      queried: true,
      target: maximumQuantumLanes(payment, limits),
      unresolved: { untyped: true, paymentType: true },
    },
    [],
  );
  assert.equal(result.adjudicated, true);
  assert.ok(result.adjudicated && result.plan);
});

test("H1 charges padding and split outputs to one proposer allowance", () => {
  const payment = makePayment("h1-combined-allowance", 100, 0);
  const limits = policyLimits(DEFAULT_PROFILE);
  const whale = makeCell("h1-combined-allowance-whale", 1_000_000, 0);
  const dust = Array.from({ length: 100 }, (_, index) =>
    makeCell(`h1-combined-allowance-dust-${index}`, 61, index + 1),
  );
  const cells = [whale, ...dust];
  const { plan } = propose(cells, payment);
  const canonical = constructCanonicalPlan([whale], payment, limits);
  assert.ok(canonical);
  const baselineSize = transactionSize(
    {
      inputs: [whale],
      recipient: makeRecipient(payment),
      change: materializeChange(canonical.change, payment, limits),
    },
    limits.structural,
  );
  const inputs = plan.inputIds.map((id) => cells.find((cell) => cell.id === id)!);
  const actualSize = transactionSize(
    {
      inputs,
      recipient: makeRecipient(payment),
      change: materializeChange(plan.change, payment, limits),
    },
    limits.structural,
  );
  assert.ok(plan.inputIds.length > 1);
  assert.ok(plan.inputIds.length < cells.length);
  assert.ok(actualSize - baselineSize <= shapingByteBudget(payment, limits));
  assert.ok(
    plan.change.every((output) =>
      output.tokenAmount === undefined
        ? output.capacity >= occupiedCapacity(
            materializeChange([output], payment, limits)[0],
          )
        : true,
    ),
  );
});

test("H1 agreement charges cleanup inputs to the shaping allowance", () => {
  const payment = makePayment("h1-full-transaction-allowance", 100, 0);
  const limits = policyLimits(DEFAULT_PROFILE);
  const whale = makeCell("h1-full-transaction-whale", 100_000, 0);
  const dust = Array.from({ length: 100 }, (_, index) =>
    makeCell(`h1-full-transaction-dust-${index}`, 61, index + 1),
  );
  const canonical = constructCanonicalPlan([whale], payment, limits);
  assert.ok(canonical);
  const canonicalChange = canonical.change[0];
  assert.ok(canonicalChange);
  const canonicalFee = transactionFee(
    {
      inputs: [whale],
      recipient: makeRecipient(payment),
      change: materializeChange(canonical.change, payment, limits),
    },
    limits.structural,
  ).fee;
  const inputs = [whale, ...dust];
  const actualFee = transactionFee(
    {
      inputs,
      recipient: makeRecipient(payment),
      change: materializeChange(canonical.change, payment, limits),
    },
    limits.structural,
  ).fee;
  const plan = {
    inputIds: inputs.map((cell) => cell.id),
    change: [
      {
        ...canonicalChange,
        capacity:
          canonicalChange.capacity +
          dust.reduce((sum, cell) => sum + cell.capacity, 0n) -
          (actualFee - canonicalFee),
      },
    ],
  };
  const validation = validatePlan(
    payment,
    plan,
    inputs,
    DEFAULT_PROFILE,
    0,
    { boundary: "order-quantum" },
  );
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("shaping-byte-allowance"));
});
