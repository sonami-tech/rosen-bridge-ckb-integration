export const SHANNONS_PER_CKB = 100_000_000n;

export type Asset =
  | { kind: "native" }
  | { kind: "xudt"; typeId: string; typeBytes: number };

export type TokenValue = { typeId: string; amount: bigint };

export type Cell = {
  id: string;
  blockNumber: number;
  transactionIndex: number;
  outputIndex: number;
  capacity: bigint;
  token?: TokenValue;
  lockId: string;
  lockBytes: number;
  typeBytes: number;
  dataBytes: number;
  confirmedAt: number;
  matureAt: number;
  reservedUntil?: number;
  eligible: boolean;
};

export type ConfirmedInventorySnapshot = {
  cells: Cell[];
  pendingOutputs?: ChangeOutput[];
  queried: true;
  target: number;
  unresolved?: { untyped: boolean; paymentType: boolean };
};

export type Payment = {
  id: string;
  arrivalWindow: number;
  asset: Asset;
  amount: bigint;
  recipientCapacity: bigint;
  recipientLockId: string;
  recipientLockBytes: number;
  recipientDataBytes: number;
};

export type ChangeIntent = {
  capacity: bigint;
  tokenAmount?: bigint;
};

export type ChangeOutput = {
  capacity: bigint;
  token?: TokenValue;
  lockId: string;
  lockBytes: number;
  typeBytes: number;
  dataBytes: number;
};

export type PolicyPlan = { inputIds: string[]; change: ChangeIntent[] };

export type StructuralProfile = {
  cellDeps: number;
  headerDeps: number;
  firstGroupWitnessBytes: number;
  feeRate: bigint;
  cycleWeightBytes: number;
};

export type BenchmarkProfile = {
  id: string;
  pageSize: number;
  candidateLimit: number;
  pageLimit: number;
  oracleCandidateLimit: number;
  maxTransactionBytes: number;
  shapingBudget: "template" | "unbounded";
  confirmationDelay: number;
  signingRoundCeiling: number;
  custodyLockId: string;
  custodyLockBytes: number;
  structural: StructuralProfile;
};

export type PolicyLimits = Pick<
  BenchmarkProfile,
  | "pageSize"
  | "candidateLimit"
  | "pageLimit"
  | "maxTransactionBytes"
  | "shapingBudget"
  | "custodyLockId"
  | "custodyLockBytes"
  | "structural"
>;

export type SizedPlan = {
  inputs: Cell[];
  recipient: ChangeOutput;
  change: ChangeOutput[];
};

export type ValidationResult =
  | {
      ok: true;
      fee: bigint;
      size: number;
      plan: SizedPlan;
      intents: ChangeIntent[];
    }
  | {
      ok: false;
      violations: string[];
      fee: bigint;
      size: number;
    };

export const DEFAULT_STRUCTURAL_PROFILE: StructuralProfile = {
  cellDeps: 1,
  headerDeps: 0,
  firstGroupWitnessBytes: 85,
  feeRate: 1_000n,
  cycleWeightBytes: 0,
};

export const DEFAULT_PROFILE: BenchmarkProfile = {
  id: "binding-moderate",
  pageSize: 100,
  candidateLimit: 1_000,
  pageLimit: 10,
  oracleCandidateLimit: 20,
  maxTransactionBytes: 512_000,
  shapingBudget: "template",
  confirmationDelay: 1,
  signingRoundCeiling: 120,
  custodyLockId: "rosen-lock",
  custodyLockBytes: 53,
  structural: DEFAULT_STRUCTURAL_PROFILE,
};

export const occupiedCapacity = (output: {
  lockBytes: number;
  typeBytes: number;
  dataBytes: number;
}): bigint =>
  BigInt(8 + output.lockBytes + output.typeBytes + output.dataBytes) *
  SHANNONS_PER_CKB;

export const materializeChange = (
  intents: ChangeIntent[],
  payment: Payment,
  profile: Pick<PolicyLimits, "custodyLockId" | "custodyLockBytes">,
): ChangeOutput[] =>
  intents.map((intent) => {
    const typed = intent.tokenAmount !== undefined;
    return {
      capacity: intent.capacity,
      token:
        typed && payment.asset.kind === "xudt"
          ? { typeId: payment.asset.typeId, amount: intent.tokenAmount! }
          : undefined,
      lockId: profile.custodyLockId,
      lockBytes: profile.custodyLockBytes,
      typeBytes:
        typed && payment.asset.kind === "xudt" ? payment.asset.typeBytes : 0,
      dataBytes: typed ? 16 : 0,
    };
  });

const scriptSerializedBytes = (contentBytes: number): number =>
  contentBytes === 0 ? 0 : contentBytes + 20;

export const outputSerializedBytes = (output: ChangeOutput): number =>
  24 +
  scriptSerializedBytes(output.lockBytes) +
  scriptSerializedBytes(output.typeBytes) +
  output.dataBytes +
  12;

const dynvecBytes = (items: number[]): number =>
  items.length === 0
    ? 4
    : 4 + items.length * 4 + items.reduce((sum, size) => sum + size, 0);

export const transactionSize = (
  plan: SizedPlan,
  profile: StructuralProfile,
): number => {
  const outputs = [plan.recipient, ...plan.change];
  // The profile counts the custody-lock dep; typed outputs add the xUDT dep.
  const cellDeps =
    profile.cellDeps + (outputs.some((output) => output.typeBytes > 0) ? 1 : 0);
  const outputCells = outputs.map(
    (output) =>
      24 +
      scriptSerializedBytes(output.lockBytes) +
      scriptSerializedBytes(output.typeBytes),
  );
  const outputData = outputs.map((output) => 4 + output.dataBytes);
  const witnesses =
    plan.inputs.length === 0
      ? []
      : [4 + profile.firstGroupWitnessBytes].concat(
          Array.from({ length: plan.inputs.length - 1 }, () => 4),
        );
  const raw =
    28 +
    4 +
    (4 + cellDeps * 37) +
    (4 + profile.headerDeps * 32) +
    (4 + plan.inputs.length * 44) +
    dynvecBytes(outputCells) +
    dynvecBytes(outputData);
  return 12 + raw + dynvecBytes(witnesses);
};

export const transactionFee = (
  plan: SizedPlan,
  profile: StructuralProfile,
): { fee: bigint; size: number } => {
  const size = transactionSize(plan, profile);
  // CKB fee weight uses the transaction's containing-vector offset.
  const weight = Math.max(size + 4, profile.cycleWeightBytes);
  return {
    fee: (profile.feeRate * BigInt(weight) + 999n) / 1_000n,
    size,
  };
};

export const compareCellId = (
  left: { id: string },
  right: { id: string },
): number =>
  left.id === right.id ? 0 : left.id < right.id ? -1 : 1;

export const compareBlockPosition = (left: Cell, right: Cell): number =>
  left.blockNumber - right.blockNumber ||
  left.transactionIndex - right.transactionIndex ||
  left.outputIndex - right.outputIndex ||
  compareCellId(left, right);

export const relevantForPayment = (cell: Cell, payment: Payment): boolean =>
  cell.token === undefined ||
  (payment.asset.kind === "xudt" && cell.token.typeId === payment.asset.typeId);

export const isPaymentToken = (
  value: Cell | ChangeOutput,
  payment: Payment,
): value is (Cell | ChangeOutput) & { token: TokenValue } =>
  payment.asset.kind === "xudt" &&
  value.token?.typeId === payment.asset.typeId;

export const paymentTokenAmount = (
  value: Cell | ChangeOutput,
  payment: Payment,
): bigint => (isPaymentToken(value, payment) ? value.token.amount : 0n);

export const makeRecipient = (payment: Payment): ChangeOutput => ({
  capacity:
    payment.asset.kind === "native" ? payment.amount : payment.recipientCapacity,
  token:
    payment.asset.kind === "xudt"
      ? { typeId: payment.asset.typeId, amount: payment.amount }
      : undefined,
  lockId: payment.recipientLockId,
  lockBytes: payment.recipientLockBytes,
  typeBytes: payment.asset.kind === "xudt" ? payment.asset.typeBytes : 0,
  dataBytes: payment.recipientDataBytes,
});

export const policyLimits = (profile: BenchmarkProfile): PolicyLimits => ({
  pageSize: profile.pageSize,
  candidateLimit: profile.candidateLimit,
  pageLimit: profile.pageLimit,
  maxTransactionBytes: profile.maxTransactionBytes,
  shapingBudget: profile.shapingBudget,
  custodyLockId: profile.custodyLockId,
  custodyLockBytes: profile.custodyLockBytes,
  structural: structuredClone(profile.structural),
});
