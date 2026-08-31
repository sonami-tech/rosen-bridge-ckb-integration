import type { Scenario } from "./engine.ts";
import { XUDT_A, XUDT_B, makeCell, makePayment } from "./fixtures.ts";
import {
  DEFAULT_PROFILE,
  SHANNONS_PER_CKB,
  makeRecipient,
  materializeChange,
  occupiedCapacity,
  transactionFee,
  type Asset,
} from "./model.ts";

const nativeFloorScenario = (delta: bigint): Scenario => {
  const payment = makePayment(`native-floor-${delta}`, 67, 0);
  payment.amount += delta;
  payment.recipientCapacity = payment.amount;
  return {
    id: `native-recipient-floor-${delta}`,
    windows: 2,
    exactGate: delta >= 0n,
    cells: [makeCell(`native-floor-cell-${delta}`, 500, 0)],
    payments: [payment],
  };
};

const nativeResidueScenario = (residue: bigint): Scenario => {
  const payment = makePayment(`native-residue-${residue}`, 100, 0);
  const cell = makeCell(`native-residue-cell-${residue}`, 0, 0);
  const sample = materializeChange([{ capacity: 0n }], payment, DEFAULT_PROFILE)[0];
  const fee = transactionFee(
    { inputs: [cell], recipient: makeRecipient(payment), change: [sample] },
    DEFAULT_PROFILE.structural,
  ).fee;
  cell.capacity = payment.amount + fee + residue;
  return {
    id: `native-residue-${residue}`,
    windows: 2,
    exactGate: true,
    cells: [cell],
    payments: [payment],
  };
};

const nativeExactCoverScenario = (): Scenario => {
  const payment = makePayment("native-exact-cover", 100, 0);
  const cell = makeCell("native-exact-cover-cell", 0, 0);
  const fee = transactionFee(
    { inputs: [cell], recipient: makeRecipient(payment), change: [] },
    DEFAULT_PROFILE.structural,
  ).fee;
  cell.capacity = payment.amount + fee;
  return {
    id: "native-exact-cover",
    windows: 2,
    exactGate: true,
    cells: [cell],
    payments: [payment],
  };
};

const typedFloorScenario = (delta: bigint): Scenario => {
  const payment = makePayment(`typed-floor-${delta}`, 0, 0, XUDT_A, 100n);
  const sample = materializeChange(
    [{ capacity: 0n, tokenAmount: 100n }],
    payment,
    DEFAULT_PROFILE,
  )[0];
  const cell = makeCell(
    `typed-floor-input-${delta}`,
    0,
    0,
    { typeId: XUDT_A.typeId, amount: 200n },
  );
  const fee = transactionFee(
    { inputs: [cell], recipient: makeRecipient(payment), change: [sample] },
    DEFAULT_PROFILE.structural,
  ).fee;
  cell.capacity =
    payment.recipientCapacity + occupiedCapacity(sample) + fee + delta;
  return {
    id: `xudt-typed-change-floor-${delta}`,
    windows: 3,
    exactGate: true,
    cells: [cell],
    payments: [payment],
  };
};

const warmBurstScenario = (asset: Asset): Scenario => {
  const suffix = asset.kind === "native" ? "native" : "xudt";
  const makeBurstPayment = (id: string, window: number) =>
    asset.kind === "native"
      ? makePayment(id, 100, window)
      : makePayment(id, 0, window, asset, 100n);
  return {
    id: `${suffix}-warm-burst`,
    windows: 45,
    exactGate: false,
    burstWindow: 29,
    burstKind: "warm",
    cells: [
      asset.kind === "native"
        ? makeCell(`${suffix}-warm-reservoir`, 100_000, 0)
        : makeCell(`${suffix}-warm-reservoir`, 100_000, 0, {
            typeId: asset.typeId,
            typeBytes: asset.typeBytes,
            amount: 100_000n,
          }),
    ],
    payments: [
      ...Array.from({ length: 7 }, (_, index) =>
        makeBurstPayment(`${suffix}-warmup-${index}`, index * 4),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        makeBurstPayment(`${suffix}-burst-${index}`, 29),
      ),
    ],
  };
};

const coldBurstScenario = (asset: Asset): Scenario => {
  const suffix = asset.kind === "native" ? "native" : "xudt";
  return {
    id: `${suffix}-cold-burst`,
    windows: 45,
    exactGate: false,
    burstWindow: 0,
    burstKind: "cold",
    cells: [
      asset.kind === "native"
        ? makeCell(`${suffix}-cold-reservoir`, 100_000, 0)
        : makeCell(`${suffix}-cold-reservoir`, 100_000, 0, {
            typeId: asset.typeId,
            typeBytes: asset.typeBytes,
            amount: 100_000n,
          }),
    ],
    payments: Array.from({ length: 8 }, (_, index) =>
      asset.kind === "native"
        ? makePayment(`${suffix}-cold-burst-${index}`, 100, 0)
        : makePayment(`${suffix}-cold-burst-${index}`, 0, 0, asset, 100n),
    ),
  };
};

const collapseBurstScenario = (asset: Asset, overrun = false): Scenario => {
  const suffix = asset.kind === "native" ? "native" : "xudt";
  const makeCollapseCell = (index: number) =>
    asset.kind === "native"
      ? makeCell(`${suffix}-collapse-cell-${index}`, 299, index)
      : makeCell(`${suffix}-collapse-cell-${index}`, 500, index, {
          typeId: asset.typeId,
          typeBytes: asset.typeBytes,
          amount: 200n,
        });
  const makeAssetPayment = (
    id: string,
    window: number,
    nativeAmount: number,
    tokenAmount: bigint,
  ) =>
    asset.kind === "native"
      ? makePayment(id, nativeAmount, window)
      : makePayment(id, 0, window, asset, tokenAmount);
  return {
    id: `${suffix}-collapse${overrun ? "-overrun" : ""}-burst`,
    windows: 20,
    exactGate: false,
    burstWindow: 8,
    burstKind: overrun ? "collapse-overrun" : "collapse-matched",
    cells: Array.from({ length: 8 }, (_, index) => makeCollapseCell(index)),
    payments: [
      makeAssetPayment(`${suffix}-collapse-0`, 0, 300, 250n),
      makeAssetPayment(`${suffix}-collapse-1`, 4, 300, 250n),
      ...Array.from({ length: 8 }, (_, index) =>
        makeAssetPayment(
          `${suffix}-collapse${overrun ? "-overrun" : ""}-burst-${index}`,
          8,
          overrun ? 100 : 67,
          overrun ? 100n : 50n,
        ),
      ),
    ],
  };
};

const xudtCapacityMigrationScenario = (): Scenario => ({
  id: "xudt-capacity-migration-burst",
  windows: 30,
  exactGate: false,
  burstWindow: 16,
  burstKind: "capacity-migration",
  cells: Array.from({ length: 8 }, (_, index) => [
    makeCell(`migration-typed-${index}`, 142, index * 3, {
      typeId: XUDT_A.typeId,
      amount: 200n,
    }),
    ...(index % 2 === 1
      ? [makeCell(`migration-capacity-${Math.floor(index / 2)}`, 500, index * 3 + 1)]
      : []),
  ]).flat().concat(
    Array.from({ length: 4 }, (_, index) =>
      makeCell(`migration-capacity-${index + 4}`, 500, 30 + index),
    ),
  ),
  payments: [
    ...Array.from({ length: 4 }, (_, index) =>
      makePayment(`migration-xudt-${index}`, 0, index * 4, XUDT_A, 250n),
    ),
    ...Array.from({ length: 8 }, (_, index) =>
      makePayment(`migration-native-burst-${index}`, 100, 16),
    ),
  ],
});

const mixedCapacityDemandScenario = (xudtFirst: boolean): Scenario => {
  const migration = xudtCapacityMigrationScenario();
  const first = xudtFirst ? "xudt" : "native";
  return {
    ...migration,
    id: `mixed-capacity-demand-${first}-first-burst`,
    burstKind: "mixed-capacity-demand",
    payments: [
      ...migration.payments.slice(0, 4),
      ...Array.from({ length: 8 }, (_, index) => [
        makePayment(
          `${xudtFirst ? "a" : "z"}-mixed-xudt-burst-${index}`,
          0,
          16,
          XUDT_A,
          50n,
        ),
        makePayment(
          `${xudtFirst ? "z" : "a"}-mixed-native-burst-${index}`,
          100,
          16,
        ),
      ]).flat(),
    ],
  };
};

const exactCoverErosionScenario = (asset: Asset): Scenario => {
  const suffix = asset.kind === "native" ? "native" : "xudt";
  const makeAssetPayment = (id: string, window: number) =>
    asset.kind === "native"
      ? makePayment(id, 100, window)
      : makePayment(id, 0, window, asset, 100n);
  const erosionPayments = Array.from({ length: 4 }, (_, index) =>
    makeAssetPayment(`${suffix}-exact-cover-${index}`, index * 4),
  );
  const exactCells = erosionPayments.map((payment, index) => {
    const cell = makeCell(
      `${suffix}-exact-cover-cell-${index}`,
      0,
      index,
      asset.kind === "xudt"
        ? { typeId: asset.typeId, typeBytes: asset.typeBytes, amount: 100n }
        : undefined,
    );
    cell.capacity =
      payment.recipientCapacity +
      transactionFee(
        { inputs: [cell], recipient: makeRecipient(payment), change: [] },
        DEFAULT_PROFILE.structural,
      ).fee;
    return cell;
  });
  return {
    id: `${suffix}-exact-cover-erosion-burst`,
    windows: 30,
    exactGate: false,
    burstWindow: 16,
    burstKind: "exact-cover-erosion",
    cells: exactCells.concat(
      Array.from({ length: 4 }, (_, index) =>
        asset.kind === "native"
          ? makeCell(`${suffix}-exact-cover-reservoir-${index}`, 10_000, index + 4)
          : makeCell(`${suffix}-exact-cover-reservoir-${index}`, 10_000, index + 4, {
              typeId: asset.typeId,
              typeBytes: asset.typeBytes,
              amount: 10_000n,
            }),
      ),
    ),
    payments: erosionPayments.concat(
      Array.from({ length: 8 }, (_, index) =>
        makeAssetPayment(`${suffix}-post-erosion-burst-${index}`, 16),
      ),
    ),
  };
};

export const scenarios: Scenario[] = [
  nativeFloorScenario(-1n),
  nativeFloorScenario(0n),
  nativeFloorScenario(1n),
  nativeExactCoverScenario(),
  nativeResidueScenario(1n),
  nativeResidueScenario(61n * SHANNONS_PER_CKB - 1n),
  nativeResidueScenario(61n * SHANNONS_PER_CKB),
  nativeResidueScenario(61n * SHANNONS_PER_CKB + 1n),
  {
    id: "cellbase-maturity-transition",
    windows: 4,
    exactGate: true,
    cells: [
      {
        ...makeCell("maturing", 500, 0),
        matureAt: 2,
      },
    ],
    payments: [makePayment("maturity-payment", 100, 0)],
  },
  warmBurstScenario({ kind: "native" }),
  coldBurstScenario({ kind: "native" }),
  collapseBurstScenario({ kind: "native" }),
  collapseBurstScenario({ kind: "native" }, true),
  exactCoverErosionScenario({ kind: "native" }),
  {
    id: "native-serial-reservoir",
    windows: 32,
    exactGate: false,
    cells: [makeCell("reservoir", 20_000, 0)],
    payments: Array.from({ length: 24 }, (_, index) =>
      makePayment(`native-${index}`, 200 + (index % 5) * 50, index),
    ),
  },
  warmBurstScenario(XUDT_A),
  coldBurstScenario(XUDT_A),
  collapseBurstScenario(XUDT_A),
  collapseBurstScenario(XUDT_A, true),
  exactCoverErosionScenario(XUDT_A),
  xudtCapacityMigrationScenario(),
  mixedCapacityDemandScenario(false),
  mixedCapacityDemandScenario(true),
  {
    id: "native-single-lane-pressure",
    windows: 10,
    exactGate: false,
    cells: [makeCell("native-single-lane", 10_000, 0)],
    payments: Array.from({ length: 12 }, (_, index) =>
      makePayment(`native-lane-payment-${index}`, 100, Math.floor(index / 2)),
    ),
  },
  {
    id: "native-hidden-lane-pressure",
    windows: 12,
    exactGate: false,
    maximumPerIdentityNetCellGrowth: 0,
    cells: [
      makeCell("native-hidden-first", 20_000, 0),
      ...Array.from({ length: 99 }, (_, index) =>
        makeCell(`native-hidden-foreign-${index}`, 500, index + 1, {
          typeId: XUDT_B.typeId,
          amount: 1n,
        }),
      ),
      makeCell("native-hidden-second", 20_000, 100),
    ],
    payments: Array.from({ length: 10 }, (_, index) =>
      makePayment(`native-hidden-payment-${index}`, 100, index),
    ),
  },
  {
    id: "native-fragmented",
    windows: 12,
    exactGate: false,
    cells: Array.from({ length: 20 }, (_, index) =>
      makeCell(`fragment-${index}`, 80 + (index % 4) * 20, index),
    ),
    payments: Array.from({ length: 8 }, (_, index) =>
      makePayment(`fragment-payment-${index}`, 180, index),
    ),
  },
  {
    id: "candidate-window-pressure",
    windows: 3,
    exactGate: false,
    cells: [
      ...Array.from({ length: 100 }, (_, index) =>
        makeCell(`candidate-floor-${index}`, 61, index),
      ),
      makeCell("candidate-native-beyond-narrow", 30_000, 100),
    ],
    payments: [makePayment("candidate-window-payment", 20_000, 0)],
  },
  {
    id: "xudt-capacity-contention",
    windows: 12,
    exactGate: false,
    cells: [
      makeCell("a-0", 300, 0, { typeId: XUDT_A.typeId, amount: 1_000n }),
      makeCell("a-1", 200, 1, { typeId: XUDT_A.typeId, amount: 500n }),
      makeCell("foreign", 10_000, 2, {
        typeId: XUDT_B.typeId,
        amount: 9_999n,
      }),
      makeCell("capacity-0", 500, 3),
      makeCell("capacity-1", 500, 4),
    ],
    payments: Array.from({ length: 6 }, (_, index) =>
      makePayment(`xudt-${index}`, 0, index, XUDT_A, 150n),
    ),
  },
  {
    id: "xudt-single-lane-pressure",
    windows: 10,
    exactGate: false,
    cells: [
      makeCell("xudt-single-lane", 10_000, 0, {
        typeId: XUDT_A.typeId,
        amount: 10_000n,
      }),
    ],
    payments: Array.from({ length: 12 }, (_, index) =>
      makePayment(
        `xudt-lane-payment-${index}`,
        0,
        Math.floor(index / 2),
        XUDT_A,
        100n,
      ),
    ),
  },
  {
    id: "xudt-hidden-lane-pressure",
    windows: 12,
    exactGate: false,
    maximumPerIdentityNetCellGrowth: 0,
    cells: [
      makeCell("xudt-hidden-first", 20_000, 0, {
        typeId: XUDT_A.typeId,
        amount: 20_000n,
      }),
      ...Array.from({ length: 99 }, (_, index) =>
        makeCell(`xudt-hidden-foreign-${index}`, 500, index + 1, {
          typeId: XUDT_B.typeId,
          amount: 1n,
        }),
      ),
      makeCell("xudt-hidden-second", 20_000, 100, {
        typeId: XUDT_A.typeId,
        amount: 20_000n,
      }),
    ],
    payments: Array.from({ length: 10 }, (_, index) =>
      makePayment(
        `xudt-hidden-payment-${index}`,
        0,
        index,
        XUDT_A,
        100n,
      ),
    ),
  },
  {
    id: "xudt-exact-token-with-foreign-type",
    windows: 3,
    exactGate: true,
    cells: [
      makeCell("exact-token-a", 500, 0, {
        typeId: XUDT_A.typeId,
        amount: 100n,
      }),
      makeCell("exact-token-foreign", 500, 1, {
        typeId: XUDT_B.typeId,
        amount: 100n,
      }),
    ],
    payments: [makePayment("exact-token-payment", 0, 0, XUDT_A, 100n)],
  },
  {
    id: "lifecycle-recovery",
    windows: 10,
    exactGate: true,
    cells: [makeCell("recovery", 2_000, 0)],
    payments: [makePayment("recover-payment", 500, 0)],
    lifecycle: {
      "recover-payment": ["rpc-rejection", "signing-failure", "success"],
    },
  },
  {
    id: "lifecycle-matrix",
    windows: 6,
    exactGate: false,
    cells: Array.from({ length: 5 }, (_, index) =>
      makeCell(`lifecycle-cell-${index}`, 500, index),
    ),
    payments: [
      makePayment("conflict-payment", 100, 0),
      makePayment("ambiguous-confirm-payment", 100, 0),
      makePayment("ambiguous-release-payment", 100, 0),
      makePayment("cycle-rejection-payment", 100, 0),
      makePayment("signing-delay-payment", 100, 0),
    ],
    lifecycle: {
      "conflict-payment": ["conflict", "success"],
      "ambiguous-confirm-payment": ["ambiguous-restart"],
      "ambiguous-release-payment": ["ambiguous-restart", "success"],
      "cycle-rejection-payment": ["cycle-rejection", "success"],
      "signing-delay-payment": ["signing-delay"],
    },
    ambiguousResolution: {
      "ambiguous-confirm-payment": { kind: "confirm" },
      "ambiguous-release-payment": { kind: "release", window: 2 },
    },
  },
  typedFloorScenario(-1n),
  typedFloorScenario(0n),
  typedFloorScenario(1n),
];
