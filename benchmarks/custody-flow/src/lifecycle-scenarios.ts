import { XUDT_A, XUDT_B, makeCell, makePayment } from "./fixtures.ts";
import { Prng } from "./generator.ts";
import { DEFAULT_PROFILE } from "./model.ts";
import {
  LIFECYCLE,
  type InventoryEvent,
  type LifecycleCell,
  type LifecycleProfile,
  type LifecycleRequest,
  type LifecycleScenario,
} from "./lifecycle.ts";

const asLifecycle = (
  cell: ReturnType<typeof makeCell>,
  options: Partial<LifecycleCell> = {},
): LifecycleCell => ({
  ...cell,
  provenance: "seed",
  indexedAt: 0,
  deepAt: 0,
  ...options,
});

const untypedCells = (
  count: number,
  capacityCkb: number,
  prefix = "untyped",
): LifecycleCell[] =>
  Array.from({ length: count }, (_, index) =>
    asLifecycle(makeCell(`${prefix}-${index}`, capacityCkb, index)),
  );

const typedCells = (
  type: typeof XUDT_A,
  count: number,
  quantity: bigint,
  capacityCkb: number,
  offset: number,
): LifecycleCell[] =>
  Array.from({ length: count }, (_, index) =>
    asLifecycle(
      makeCell(
        `${type.typeId}-cell-${index}`,
        capacityCkb,
        offset + index,
        { typeId: type.typeId, typeBytes: type.typeBytes, amount: quantity },
      ),
    ),
  );

const blockCellsUntil = (
  cells: LifecycleCell[],
  ids: string[],
  blockedUntil: number,
): LifecycleCell[] => {
  const blocked = new Set(ids);
  return cells.map((cell) =>
    blocked.has(cell.id) ? { ...cell, blockedUntil } : cell,
  );
};

const request = (
  id: string,
  arrivalAt: number,
  asset: "native" | typeof XUDT_A | typeof XUDT_B,
  amount: number | bigint,
): LifecycleRequest => ({
  id,
  arrivalAt,
  payment:
    asset === "native"
      ? makePayment(id, amount as number, 0)
      : makePayment(id, 0, 0, asset, amount as bigint),
});

export const illustrativeLifecycleProfile: LifecycleProfile = {
  id: "illustrative-two-minute-commit",
  transactionProfile: structuredClone(DEFAULT_PROFILE),
  durationMs: 20 * 60_000,
  constructionMs: 2_000,
  agreementLatencyMs: 2_000,
  processorOffsetMs: 17_000,
  tssOffsetMs: 31_000,
  signingMs: 5_000,
  commitDelaysMs: [120_000],
  indexerLagMs: 5_000,
};

export const promptEdgeProfile: LifecycleProfile = {
  ...illustrativeLifecycleProfile,
  id: "proposal-window-edges",
  commitDelaysMs: [27_900, 102_300],
  indexerLagMs: 15_000,
};

export const slowLifecycleProfile: LifecycleProfile = {
  ...illustrativeLifecycleProfile,
  id: "delayed-proposal-and-indexer",
  durationMs: 30 * 60_000,
  commitDelaysMs: [120_000, 180_000, 300_000],
  indexerLagMs: 60_000,
  externalTssSlots: [2, 1, 3, 0, 2, 1, 0, 3, 2, 0],
};

const mixedRequests = Array.from({ length: 50 }, (_, index) => {
  const arrivalAt = Math.floor(index / 5) * 60_000 + (index % 5) * 8_000;
  const asset =
    index % 5 === 0 ? "native" : index % 2 === 0 ? XUDT_A : XUDT_B;
  return request(
    `mixed-${index}`,
    arrivalAt,
    asset,
    asset === "native" ? 1_000 : 100n,
  );
});

export const mixedSharedCapacity: LifecycleScenario = {
  id: "mixed-shared-capacity",
  cells: [
    ...untypedCells(40, 5_000),
    ...typedCells(XUDT_A, 20, 1_000n, 142, 10_000),
    ...typedCells(XUDT_B, 20, 1_000n, 142, 20_000),
  ],
  requests: mixedRequests,
};

export const tssBurst: LifecycleScenario = {
  id: "tss-burst-eleven",
  cells: untypedCells(11, 5_000),
  requests: Array.from({ length: 11 }, (_, index) =>
    request(`burst-${index}`, 0, "native", 1_000),
  ),
};

export const deepBeyondRpcPage: LifecycleScenario = {
  id: "deep-beyond-rpc-page",
  cells: [
    ...Array.from({ length: 100 }, (_, index) =>
      asLifecycle(makeCell(`blocked-${index}`, 100, index), {
        blockedUntil: 10 * 60_000,
      }),
    ),
    asLifecycle(makeCell("usable-row-101", 10_000, 100)),
  ],
  requests: [request("paginated-payment", 0, "native", 1_000)],
};

export const shallowDepositFlood: LifecycleScenario = {
  id: "shallow-deposit-flood",
  cells: [
    ...Array.from({ length: 101 }, (_, index) =>
      asLifecycle(makeCell(`shallow-deposit-${index}`, 10_000, index), {
        provenance: "deposit",
        deepAt: LIFECYCLE.deepBlocks * LIFECYCLE.blockMs,
      }),
    ),
    asLifecycle(makeCell("deep-seed", 10_000, 500)),
  ],
  requests: [request("deposit-flood-payment", 0, "native", 1_000)],
};

export const persistedShallowOutsidePage: LifecycleScenario = {
  id: "persisted-shallow-outside-page",
  cells: [
    ...Array.from({ length: 100 }, (_, index) =>
      asLifecycle(makeCell(`blocked-deep-${index}`, 100, index), {
        blockedUntil: 10 * 60_000,
      }),
    ),
    asLifecycle(makeCell("persisted-shallow-change", 10_000, 100), {
      provenance: "guard-change",
      deepAt: LIFECYCLE.deepBlocks * LIFECYCLE.blockMs,
    }),
  ],
  requests: [request("persisted-shallow-payment", 0, "native", 1_000)],
};

export const shallowCommittedReuse: LifecycleScenario = {
  id: "shallow-committed-reuse",
  cells: untypedCells(1, 10_000),
  requests: [
    request("reuse-first", 0, "native", 1_000),
    request("reuse-second", 10_000, "native", 1_000),
  ],
};

export const shallowDepositWaits: LifecycleScenario = {
  id: "shallow-user-deposit-waits",
  cells: [],
  inventoryEvents: [
    {
      at: 0,
      reason: "deposit",
      add: [
        asLifecycle(makeCell("user-deposit", 10_000, 0), {
          provenance: "deposit",
          indexedAt: 5_000,
          deepAt: 5_000 + LIFECYCLE.deepBlocks * LIFECYCLE.blockMs,
        }),
      ],
    },
  ],
  requests: [request("deposit-funded", 10_000, "native", 1_000)],
};

export const typedMergeErosion: LifecycleScenario = {
  id: "typed-merge-erosion",
  cells: typedCells(XUDT_A, 4, 50n, 142, 0),
  requests: [
    request("merge-0", 0, XUDT_A, 100n),
    request("merge-1", 180_000, XUDT_A, 100n),
  ],
};

export const candidateExpiry: LifecycleScenario = {
  id: "candidate-expiry",
  cells: untypedCells(2, 5_000),
  requests: [request("expires", 110_000, "native", 1_000)],
};

export const stalledTssHead: LifecycleScenario = {
  id: "stalled-tss-head",
  cells: untypedCells(11, 5_000),
  requests: Array.from({ length: 11 }, (_, index) =>
    request(`stalled-${index}`, 0, "native", 1_000),
  ),
};

export const coldAndDeposit: LifecycleScenario = {
  id: "cold-and-deposit-inventory",
  cells: [
    ...blockCellsUntil(
      untypedCells(8, 5_000),
      ["untyped-6", "untyped-7"],
      241_000,
    ),
    ...blockCellsUntil(
      typedCells(XUDT_A, 6, 1_000n, 142, 10_000),
      [`${XUDT_A.typeId}-cell-5`],
      241_000,
    ),
  ],
  requests: Array.from({ length: 12 }, (_, index) =>
    request(
      `cold-load-${index}`,
      index * 45_000,
      index % 2 === 0 ? XUDT_A : "native",
      index % 2 === 0 ? 100n : 1_000,
    ),
  ),
  inventoryEvents: [
    {
      at: 240_000,
      reason: "cold-storage",
      removeIds: ["untyped-6", "untyped-7", `${XUDT_A.typeId}-cell-5`],
    },
    {
      at: 360_000,
      reason: "deposit",
      add: [
        asLifecycle(makeCell("later-native-deposit", 5_000, 50_000), {
          provenance: "deposit",
          indexedAt: 365_000,
          deepAt: 365_000 + LIFECYCLE.deepBlocks * LIFECYCLE.blockMs,
        }),
      ],
    },
  ],
};

export const generatedLifecycleScenario = (seed: string): LifecycleScenario => {
  const random = new Prng(seed);
  const assets = ["native", XUDT_A, XUDT_B] as const;
  const requests = Array.from({ length: 60 }, (_, index) => {
    const asset = assets[random.integer(assets.length)];
    return request(
      `generated-${seed.slice(2)}-${index}`,
      index * 12_000 + random.integer(8_000),
      asset,
      asset === "native"
        ? 500 + random.integer(2_501)
        : BigInt(50 + random.integer(351)),
    );
  });
  const coldRemovalIds = [
    `${XUDT_A.typeId}-cell-11`,
    `${XUDT_B.typeId}-cell-11`,
    "untyped-23",
  ];
  const inventoryEvents: InventoryEvent[] = [
    {
      at: 420_000,
      reason: "cold-storage",
      removeIds: coldRemovalIds,
    },
  ];
  return {
    id: `generated-lifecycle-${seed.slice(2)}`,
    cells: blockCellsUntil(
      [
        ...untypedCells(48, 6_000),
        ...typedCells(XUDT_A, 26, 1_500n, 142, 10_000),
        ...typedCells(XUDT_B, 26, 1_500n, 142, 20_000),
      ],
      coldRemovalIds,
      421_000,
    ),
    requests,
    inventoryEvents,
  };
};

export const planningLifecycleCases: Array<{
  scenario: LifecycleScenario;
  profile: LifecycleProfile;
}> = [
  { scenario: mixedSharedCapacity, profile: illustrativeLifecycleProfile },
  { scenario: mixedSharedCapacity, profile: promptEdgeProfile },
  { scenario: mixedSharedCapacity, profile: slowLifecycleProfile },
];

export const lifecycleCases: Array<{
  scenario: LifecycleScenario;
  profile: LifecycleProfile;
}> = [
  ...planningLifecycleCases,
  { scenario: tssBurst, profile: illustrativeLifecycleProfile },
  { scenario: deepBeyondRpcPage, profile: illustrativeLifecycleProfile },
  { scenario: shallowCommittedReuse, profile: illustrativeLifecycleProfile },
  { scenario: shallowDepositWaits, profile: slowLifecycleProfile },
  { scenario: typedMergeErosion, profile: illustrativeLifecycleProfile },
  {
    scenario: candidateExpiry,
    profile: {
      ...illustrativeLifecycleProfile,
      id: "agreement-misses-active-window",
      agreementLatencyMs: 130_000,
    },
  },
  {
    scenario: stalledTssHead,
    profile: {
      ...illustrativeLifecycleProfile,
      id: "first-five-stalled",
      durationMs: 12 * 60_000,
      stalledRequestIds: Array.from({ length: 5 }, (_, index) => `stalled-${index}`),
    },
  },
  { scenario: coldAndDeposit, profile: illustrativeLifecycleProfile },
];
