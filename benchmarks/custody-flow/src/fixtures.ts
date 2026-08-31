import {
  SHANNONS_PER_CKB,
  occupiedCapacity,
  type Asset,
  type Cell,
  type Payment,
} from "./model.ts";

export const XUDT_A = {
  kind: "xudt",
  typeId: "0xasset-a",
  typeBytes: 65,
} satisfies Asset;

export const XUDT_B = {
  kind: "xudt",
  typeId: "0xasset-b",
  typeBytes: 65,
} satisfies Asset;

export const makeCell = (
  id: string,
  capacityCkb: number,
  position: number,
  token?: { typeId: string; amount: bigint; typeBytes?: number },
): Cell => ({
  id,
  blockNumber: Math.floor(position / 1_000),
  transactionIndex: position % 1_000,
  outputIndex: 0,
  capacity: BigInt(capacityCkb) * SHANNONS_PER_CKB,
  token: token ? { typeId: token.typeId, amount: token.amount } : undefined,
  lockId: "rosen-lock",
  lockBytes: 53,
  typeBytes: token?.typeBytes ?? (token ? 65 : 0),
  dataBytes: token ? 16 : 0,
  confirmedAt: 0,
  matureAt: 0,
  eligible: true,
});

export const makePayment = (
  id: string,
  amountCkb: number,
  arrivalWindow: number,
  asset: Asset = { kind: "native" },
  tokenAmount?: bigint,
): Payment => ({
  id,
  arrivalWindow,
  asset,
  amount:
    asset.kind === "native"
      ? BigInt(amountCkb) * SHANNONS_PER_CKB
      : (tokenAmount ?? 1n),
  recipientCapacity:
    asset.kind === "native"
      ? BigInt(amountCkb) * SHANNONS_PER_CKB
      : occupiedCapacity({
          lockBytes: 59,
          typeBytes: asset.typeBytes,
          dataBytes: 16,
        }),
  recipientLockId: `recipient:${id}`,
  recipientLockBytes: 59,
  recipientDataBytes: asset.kind === "xudt" ? 16 : 0,
});
