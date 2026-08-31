import assert from "node:assert/strict";
import test from "node:test";
import { XUDT_A, makeCell, makePayment } from "../src/fixtures.ts";
import {
  DEFAULT_PROFILE,
  occupiedCapacity,
  policyLimits,
  makeRecipient,
  transactionFee,
  type Cell,
  type Payment,
} from "../src/model.ts";
import {
  constructEqualRemainderPlan,
  equalRemainder,
  remainderAllocators,
  remainderPolicies,
} from "../src/policies/equal-remainder.ts";
import { CandidateView, LaneView, type Policy } from "../src/policy.ts";
import { maximumQuantumLanes } from "../src/quantum-budget.ts";
import { validatePlan } from "../src/validator.ts";

const proposeUnchecked = (
  cells: Cell[],
  payment: Payment,
  policy: Policy = equalRemainder,
  unresolved?: { untyped: boolean; paymentType: boolean },
) => {
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  const untyped = cells.filter((cell) => cell.token === undefined);
  const typed = cells.filter(
    (cell) =>
      payment.asset.kind === "xudt" &&
      cell.token?.typeId === payment.asset.typeId,
  );
  return policy.propose({
    window: 0,
    payment,
    limits,
    candidates: new CandidateView(cells, limits),
    lanes: {
      untyped: new LaneView(untyped, limits),
      paymentType:
        payment.asset.kind === "xudt"
          ? new LaneView(typed, limits)
          : undefined,
    },
    confirmedInventory: { cells, queried: true, target, unresolved },
    pendingOutputs: [],
  });
};

const propose = (
  cells: Cell[],
  payment: Payment,
  policy: Policy = equalRemainder,
  unresolved?: { untyped: boolean; paymentType: boolean },
) => {
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  const plan = proposeUnchecked(cells, payment, policy, unresolved);
  assert.ok(plan);
  assert.equal(
    validatePlan(payment, plan, cells, DEFAULT_PROFILE, 0, {
      boundary: "equal-remainder",
      confirmedInventory: { cells, queried: true, target, unresolved },
    }).ok,
    true,
  );
  return { plan, target };
};

const advance = (cells: Cell[], payment: Payment, step: number): Cell[] => {
  const { plan, target } = propose(cells, payment);
  const validation = validatePlan(payment, plan, cells, DEFAULT_PROFILE, 0, {
    boundary: "equal-remainder",
    confirmedInventory: { cells, queried: true, target },
  });
  assert.ok(validation.ok);
  const assertEqual = (values: bigint[]) => {
    if (values.length < 2) return;
    const ordered = values.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    assert.ok(ordered[ordered.length - 1] - ordered[0] <= 1n);
  };
  assertEqual(
    validation.plan.change
      .filter((output) => output.token !== undefined)
      .map((output) => output.token!.amount),
  );
  assertEqual(
    validation.plan.change
      .filter((output) => output.token === undefined)
      .map((output) => output.capacity),
  );
  const consumed = new Set(validation.plan.inputs.map((cell) => cell.id));
  return [
    ...cells.filter((cell) => !consumed.has(cell.id)),
    ...validation.plan.change.map((output, index): Cell => ({
      id: `state-${step}-${index}`,
      blockNumber: step + 1,
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

test("one native whale folds twenty-four smallest cells into equal change", () => {
  const payment = makePayment("equal-native-dust", 100, 0);
  const cells = [
    makeCell("equal-native-whale", 100_000, 0),
    ...Array.from({ length: 24 }, (_, index) =>
      makeCell(`equal-native-dust-${index}`, 61, index + 1),
    ),
  ];
  const { plan, target } = propose(cells, payment);
  assert.equal(plan.inputIds.length, 25);
  assert.equal(plan.change.length, target);
  const capacities = plan.change.map((output) => output.capacity);
  assert.ok(Math.max(...capacities.map(Number)) - Math.min(...capacities.map(Number)) <= target);
});

test("one xUDT whale folds twenty-four same-type cells into floor-typed pairs", () => {
  const payment = makePayment("equal-xudt-dust", 0, 0, XUDT_A, 100n);
  const cells = [
    makeCell("equal-xudt-whale", 100_000, 0, {
      typeId: XUDT_A.typeId,
      amount: 10_000n,
    }),
    ...Array.from({ length: 24 }, (_, index) =>
      makeCell(`equal-xudt-dust-${index}`, 142, index + 1, {
        typeId: XUDT_A.typeId,
        amount: 1n,
      }),
    ),
  ];
  const { plan, target } = propose(cells, payment);
  assert.equal(plan.inputIds.length, 25);
  assert.equal(plan.change.length, target * 2);
  const typed = plan.change.filter((output) => output.tokenAmount !== undefined);
  const untyped = plan.change.filter((output) => output.tokenAmount === undefined);
  assert.equal(typed.length, target);
  assert.equal(untyped.length, target);
  const typedFloor = occupiedCapacity({
    lockBytes: DEFAULT_PROFILE.custodyLockBytes,
    typeBytes: XUDT_A.typeBytes,
    dataBytes: 16,
  });
  assert.ok(typed.every((output) => output.capacity === typedFloor));
});

test("one whale self-bootstraps to the byte-derived target", () => {
  const payment = makePayment("equal-native-bootstrap", 100, 0);
  const { plan, target } = propose(
    [makeCell("equal-native-bootstrap-whale", 100_000, 0)],
    payment,
  );
  assert.equal(plan.inputIds.length, 1);
  assert.equal(plan.change.length, target);
});

test("an all-small pool compacts through an ordinary payment", () => {
  const payment = makePayment("equal-native-all-small", 100, 0);
  const cells = Array.from({ length: 24 }, (_, index) =>
    makeCell(`equal-native-all-small-${index}`, 61, index),
  );
  const { plan, target } = propose(cells, payment);
  assert.equal(plan.inputIds.length, 24);
  assert.equal(plan.change.length, target);
});

test("every remainder allocator conserves value and respects output floors", () => {
  for (const policy of remainderPolicies) {
    const native = makePayment(`${policy.id}-native`, 100, 0);
    const nativeResult = propose(
      [makeCell(`${policy.id}-native-whale`, 100_000, 0)],
      native,
      policy,
    );
    assert.equal(nativeResult.plan.change.length, nativeResult.target);

    const xudt = makePayment(`${policy.id}-xudt`, 0, 0, XUDT_A, 100n);
    const xudtResult = propose(
      [
        makeCell(`${policy.id}-xudt-whale`, 100_000, 0, {
          typeId: XUDT_A.typeId,
          amount: 100_000n,
        }),
      ],
      xudt,
      policy,
    );
    assert.ok(
      xudtResult.plan.change
        .filter((output) => output.tokenAmount !== undefined)
        .every((output) => output.capacity === occupiedCapacity({
          lockBytes: DEFAULT_PROFILE.custodyLockBytes,
          typeBytes: XUDT_A.typeBytes,
          dataBytes: 16,
        })),
    );
  }
});

test("a sub-target xUDT remainder falls back to one typed output", () => {
  const payment = makePayment("equal-xudt-small-remainder", 0, 0, XUDT_A, 100n);
  const cells = [
    makeCell("equal-xudt-small-remainder-typed", 500, 0, {
      typeId: XUDT_A.typeId,
      amount: 101n,
    }),
    makeCell("equal-xudt-small-remainder-capacity", 500, 1),
  ];
  const { plan } = propose(cells, payment);
  assert.equal(
    plan.change.filter((output) => output.tokenAmount !== undefined).length,
    1,
  );
});

test("an exact-token cover does not engage above-target padding", () => {
  const payment = makePayment("equal-xudt-exact-token", 0, 0, XUDT_A, 100n);
  const cells = [
    ...Array.from({ length: 4 }, (_, index) =>
      makeCell(`equal-xudt-exact-token-${index}`, 142, index, {
        typeId: XUDT_A.typeId,
        amount: 100n,
      }),
    ),
    makeCell("equal-xudt-exact-token-capacity", 500, 4),
  ];
  const { plan } = propose(cells, payment);
  assert.equal(plan.inputIds.length, 2);
  assert.equal(plan.change.length, 1);
  assert.equal(plan.change[0].tokenAmount, undefined);
});

test("a smaller exact-token cell beats a larger inexact cell", () => {
  const payment = makePayment("equal-xudt-best-exact", 0, 0, XUDT_A, 100n);
  const exact = makeCell("equal-xudt-best-exact-100", 0, 1, {
    typeId: XUDT_A.typeId,
    amount: 100n,
  });
  exact.capacity =
    payment.recipientCapacity +
    transactionFee(
      { inputs: [exact], recipient: makeRecipient(payment), change: [] },
      DEFAULT_PROFILE.structural,
    ).fee;
  const inexact = makeCell("equal-xudt-best-exact-101", 142, 0, {
    typeId: XUDT_A.typeId,
    amount: 101n,
  });
  const { plan } = propose([inexact, exact], payment);
  assert.deepEqual(plan.inputIds, [exact.id]);
  assert.deepEqual(plan.change, []);
});

test("an exact-token subset beats an inexact largest-first cover", () => {
  const payment = makePayment("equal-xudt-exact-subset", 0, 0, XUDT_A, 100n);
  const cells = [70n, 60n, 40n].map((amount, index) =>
    makeCell(`equal-xudt-exact-subset-${amount}`, 500, index, {
      typeId: XUDT_A.typeId,
      amount,
    }),
  );
  const { plan } = propose(cells, payment);
  assert.deepEqual(new Set(plan.inputIds), new Set([
    "equal-xudt-exact-subset-60",
    "equal-xudt-exact-subset-40",
  ]));
  assert.ok(plan.change.every((output) => output.tokenAmount === undefined));
});

test("weighted residue goes to the largest fractional share", () => {
  const payment = makePayment("binary-residue", 0, 0, XUDT_A, 100n);
  const cell = makeCell("binary-residue-cell", 100_000, 0, {
    typeId: XUDT_A.typeId,
    amount: 104n,
  });
  const plan = constructEqualRemainderPlan(
    [cell],
    payment,
    policyLimits(DEFAULT_PROFILE),
    3,
    1,
    remainderAllocators.find(({ id }) => id === "binary")!,
  );
  assert.ok(plan);
  assert.deepEqual(
    plan.change
      .filter((output) => output.tokenAmount !== undefined)
      .map((output) => output.tokenAmount),
    [1n, 1n, 2n],
  );
});

test("unresolved inventory falls back to canonical change", () => {
  const payment = makePayment("equal-native-unresolved-fallback", 100, 0);
  const { plan } = propose(
    [makeCell("equal-native-unresolved-fallback-cell", 100_000, 0)],
    payment,
    equalRemainder,
    { untyped: true, paymentType: false },
  );
  assert.equal(plan.change.length, 1);
});

test("unresolved canonical fallback declines growth above the ceiling", () => {
  const payment = makePayment("equal-xudt-unresolved-ceiling", 0, 0, XUDT_A, 100n);
  const cells = [
    makeCell("equal-xudt-unresolved-ceiling-typed", 1_000, 0, {
      typeId: XUDT_A.typeId,
      amount: 100n,
    }),
  ];
  assert.equal(
    proposeUnchecked(cells, payment, equalRemainder, {
      untyped: true,
      paymentType: false,
    }),
    undefined,
  );
  const canonical = proposeUnchecked(cells, payment);
  assert.ok(canonical);
  const target = maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE));
  const validation = validatePlan(payment, canonical, cells, DEFAULT_PROFILE, 0, {
    boundary: "equal-remainder",
    confirmedInventory: {
      cells,
      queried: true,
      target,
      unresolved: { untyped: true, paymentType: false },
    },
  });
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("inventory-growth-ceiling"));
});

test("agreement rejects shaping while relevant change is unresolved", () => {
  const payment = makePayment("equal-native-unresolved", 100, 0);
  const limits = policyLimits(DEFAULT_PROFILE);
  const target = maximumQuantumLanes(payment, limits);
  const cells = Array.from({ length: 3 }, (_, index) =>
    makeCell(`equal-native-unresolved-${index}`, 100_000, index),
  );
  const plan = constructEqualRemainderPlan(
    cells,
    payment,
    limits,
    0,
    cells.length,
  );
  assert.ok(plan);
  const validation = validatePlan(payment, plan, cells, DEFAULT_PROFILE, 0, {
    boundary: "equal-remainder",
    confirmedInventory: {
      cells,
      queried: true,
      target,
      unresolved: { untyped: true, paymentType: false },
    },
  });
  assert.equal(validation.ok, false);
  if (!validation.ok) {
    assert.ok(
      validation.violations.includes("unresolved-inventory-nonminimal"),
    );
    assert.ok(!validation.violations.includes("inventory-growth-ceiling"));
  }
});

test("agreement rejects above-floor typed change at the equal-remainder boundary", () => {
  const payment = makePayment("equal-xudt-typed-floor", 0, 0, XUDT_A, 100n);
  const input = makeCell("equal-xudt-typed-floor-input", 500, 0, {
    typeId: XUDT_A.typeId,
    amount: 200n,
  });
  const limits = policyLimits(DEFAULT_PROFILE);
  const plan = constructEqualRemainderPlan(
    [input],
    payment,
    limits,
    1,
    1,
  );
  assert.ok(plan);
  const typedChange = plan.change.find(
    (output) => output.tokenAmount !== undefined,
  );
  const untypedChange = plan.change.find(
    (output) => output.tokenAmount === undefined,
  );
  assert.ok(typedChange);
  assert.ok(untypedChange);
  typedChange.capacity += 1n;
  untypedChange.capacity -= 1n;
  const validation = validatePlan(payment, plan, [input], DEFAULT_PROFILE, 0, {
    boundary: "equal-remainder",
    confirmedInventory: {
      cells: [input],
      queried: true,
      target: maximumQuantumLanes(payment, limits),
    },
  });
  assert.equal(validation.ok, false);
  if (!validation.ok)
    assert.ok(validation.violations.includes("typed-change-not-at-floor"));
});

test("alternating native breakpoints stay bounded after whale-and-dust recovery", () => {
  let cells = [
    makeCell("native-state-whale", 1_000_000, 0),
    ...Array.from({ length: 24 }, (_, index) =>
      makeCell(`native-state-dust-${index}`, 61, index + 1),
    ),
  ];
  const amounts = [67, 68, 199, 200, 201, 20_000];
  for (let step = 0; step < 120; step += 1) {
    const payment = makePayment(`native-state-payment-${step}`, amounts[step % amounts.length], 0);
    cells = advance(cells, payment, step);
    assert.ok(
      cells.length <= maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE)),
    );
  }
});

test("alternating xUDT breakpoints keep typed and capacity pools bounded", () => {
  let cells = [
    makeCell("xudt-state-whale", 1_000_000, 0, {
      typeId: XUDT_A.typeId,
      amount: 1_000_000n,
    }),
    ...Array.from({ length: 24 }, (_, index) =>
      makeCell(`xudt-state-dust-${index}`, 142, index + 1, {
        typeId: XUDT_A.typeId,
        amount: 1n,
      }),
    ),
  ];
  const amounts = [1n, 99n, 100n, 101n, 1_000n];
  for (let step = 0; step < 120; step += 1) {
    const payment = makePayment(
      `xudt-state-payment-${step}`,
      0,
      0,
      XUDT_A,
      amounts[step % amounts.length],
    );
    cells = advance(cells, payment, step);
    const target = maximumQuantumLanes(payment, policyLimits(DEFAULT_PROFILE));
    assert.ok(cells.filter((cell) => cell.token !== undefined).length <= target);
    assert.ok(cells.filter((cell) => cell.token === undefined).length <= target);
  }
});
