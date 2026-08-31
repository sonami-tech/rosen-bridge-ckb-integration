import type { Scenario } from "./engine.ts";
import { XUDT_A, XUDT_B, makeCell, makePayment } from "./fixtures.ts";

const MASK_64 = (1n << 64n) - 1n;

export class Prng {
  #state: bigint;

  constructor(seed: string) {
    const parsed = BigInt(seed);
    const masked = parsed & MASK_64;
    this.#state = masked === 0n ? 1n : masked;
  }

  next(): bigint {
    let value = this.#state;
    value ^= (value << 13n) & MASK_64;
    value ^= value >> 7n;
    value ^= (value << 17n) & MASK_64;
    this.#state = value & MASK_64;
    return this.#state;
  }

  integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0)
      throw new Error("maxExclusive must be a positive safe integer");
    return Number(this.next() % BigInt(maxExclusive));
  }
}

export const generateScenario = (seed: string): Scenario => {
  const random = new Prng(seed);
  const cellCount = 112 + random.integer(17);
  const paymentCount = 8 + random.integer(9);
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const beyondInitialDust = index >= 100;
    const typed = !beyondInitialDust || index % 3 !== 0;
    const asset = index % 2 === 0 ? XUDT_B : XUDT_A;
    const cell = makeCell(
      `generated-cell-${index}`,
      typed
        ? beyondInitialDust
          ? 150 + random.integer(1_851)
          : 150
        : 200 + random.integer(1_801),
      index,
      typed
        ? {
            typeId: asset.typeId,
            amount: beyondInitialDust ? BigInt(1_000 + random.integer(9_001)) : 1n,
          }
        : undefined,
    );
    if (index === 1) cell.matureAt = 2;
    return cell;
  });
  const payments = Array.from({ length: paymentCount }, (_, index) =>
    index % 4 === 0
      ? makePayment(
          `generated-payment-${index}`,
          0,
          random.integer(Math.max(1, paymentCount - 2)),
          Math.floor(index / 4) % 2 === 0 ? XUDT_B : XUDT_A,
          BigInt(1 + random.integer(500)),
        )
      : makePayment(
          `generated-payment-${index}`,
          67 + random.integer(734),
          random.integer(Math.max(1, paymentCount - 2)),
        ),
  );
  return {
    id: `generated-${seed.slice(2)}`,
    windows: paymentCount + 8,
    exactGate: false,
    cells,
    deposits: [
      {
        window: 2,
        cell: makeCell("generated-deposit", 200 + random.integer(801), 50_000),
      },
    ],
    payments,
    lifecycle: Object.fromEntries(
      payments
        .filter((_, index) => index % 7 === 0)
        .map((payment) => [payment.id, ["rpc-rejection", "success"]]),
    ),
  };
};
