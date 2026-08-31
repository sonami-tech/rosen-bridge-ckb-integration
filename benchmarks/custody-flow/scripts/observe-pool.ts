import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../src/evaluator.ts";

const option = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};

const endpoint = option("--endpoint", "https://mainnet.ckb.dev/");
const output = option(
  "--output",
  fileURLToPath(new URL("../results/pool-observation.json", import.meta.url)),
);
const targetSamples = Number(option("--samples", "20"));
const pollMs = Number(option("--poll-ms", "2000"));
const durationMs = Number(option("--duration-ms", "900000"));
if (
  ![targetSamples, pollMs, durationMs].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  )
)
  throw new Error("samples, poll-ms, and duration-ms must be positive integers");

let rpcId = 0;
const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (body.error)
    throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result as T;
};

type TxStatus = {
  transaction: unknown;
  time_added_to_pool?: string;
  tx_status: {
    status: "pending" | "proposed" | "committed" | "unknown" | "rejected";
    block_hash: string | null;
    reason?: string | null;
  };
};

type Observation = {
  hash: string;
  firstSeenAt: string;
  nodeAddedAt?: string;
  nodeAddedMs?: number;
  initialStatus: string;
  finalStatus?: string;
  blockHash?: string;
  blockNumber?: number;
  blockTimestampAt?: string;
  observedFinalAt?: string;
  poolObservationToCommitMs?: number;
};

const observations = new Map<string, Observation>();
const startedAtMs = Date.now();
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
});

const percentile = (values: number[], quantile: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
};

const save = async () => {
  const rows = [...observations.values()].sort((left, right) =>
    left.hash.localeCompare(right.hash),
  );
  const committed = rows
    .map((row) => row.poolObservationToCommitMs)
    .filter((value): value is number => value !== undefined);
  const report = {
    schema: "ckb-pool-observation-v2",
    endpoint,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date().toISOString(),
    command: ["pnpm", "observe", ...process.argv.slice(2)],
    source: {
      endpointList:
        "https://docs.nervos.org/docs/getting-started/rpcs (last updated 2026-08-19)",
      limitation:
        "One observer's first local pool-status observation to its first local committed-status observation; bounded by polling cadence and not original broadcast time, global propagation, or Guard indexer visibility.",
    },
    summary: {
      observed: rows.length,
      committed: committed.length,
      pending: rows.filter((row) => row.finalStatus === undefined).length,
      p50PoolObservationToCommitMs: percentile(committed, 0.5),
      p95PoolObservationToCommitMs: percentile(committed, 0.95),
      maxPoolObservationToCommitMs:
        committed.length === 0 ? undefined : Math.max(...committed),
    },
    rows,
  };
  await writeFile(output, `${canonicalJson(report)}\n`);
};

while (
  !interrupted &&
  Date.now() - startedAtMs < durationMs &&
  [...observations.values()].filter((row) => row.finalStatus === "committed")
    .length < targetSamples
) {
  const pool = await rpc<{ pending: string[]; proposed: string[] }>(
    "get_raw_tx_pool",
    [false],
  );
  for (const hash of [...pool.pending, ...pool.proposed]) {
    if (observations.has(hash)) continue;
    const tx = await rpc<TxStatus>("get_transaction", [hash, "0x2", false]);
    const nodeAddedMs = tx.time_added_to_pool
      ? Number(BigInt(tx.time_added_to_pool))
      : undefined;
    const firstSeenMs = Date.now();
    observations.set(hash, {
      hash,
      firstSeenAt: new Date(firstSeenMs).toISOString(),
      nodeAddedAt:
        nodeAddedMs === undefined ? undefined : new Date(nodeAddedMs).toISOString(),
      nodeAddedMs,
      initialStatus: tx.tx_status.status,
    });
  }

  for (const row of observations.values()) {
    if (row.finalStatus !== undefined) continue;
    const tx = await rpc<TxStatus>("get_transaction", [row.hash, "0x2", false]);
    if (tx.tx_status.status === "committed" && tx.tx_status.block_hash) {
      const header = await rpc<{ number: string; timestamp: string }>("get_header", [
        tx.tx_status.block_hash,
      ]);
      row.finalStatus = "committed";
      row.blockHash = tx.tx_status.block_hash;
      row.blockNumber = Number(BigInt(header.number));
      row.blockTimestampAt = new Date(
        Number(BigInt(header.timestamp)),
      ).toISOString();
      const observedFinalMs = Date.now();
      row.observedFinalAt = new Date(observedFinalMs).toISOString();
      row.poolObservationToCommitMs =
        observedFinalMs - Date.parse(row.firstSeenAt);
    } else if (
      tx.tx_status.status === "rejected" ||
      tx.tx_status.status === "unknown"
    ) {
      row.finalStatus = tx.tx_status.status;
      row.observedFinalAt = new Date().toISOString();
    }
  }
  await save();
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

await save();
