import { writeFile } from "node:fs/promises";
import { canonicalJson } from "../src/evaluator.ts";
import {
  runEqualRemainderRecoverabilityProof,
  runOrderQuantumNoCleanupRecoverabilityProof,
  runOrderQuantumRecoverabilityProof,
  runOrderQuantumTriggeredCleanupRecoverabilityProof,
} from "../src/recoverability.ts";

const variants = [
  {
    id: "equal",
    schema: "ckb-custody-flow-equal-remainder-recoverability-v1",
    output: "equal-remainder-recoverability.json",
    run: runEqualRemainderRecoverabilityProof,
  },
  {
    id: "order-quantum",
    schema: "ckb-custody-flow-order-quantum-recoverability-v1",
    output: "order-quantum-recoverability.json",
    run: runOrderQuantumRecoverabilityProof,
  },
  {
    id: "no-cleanup",
    schema: "ckb-custody-flow-order-quantum-no-cleanup-recoverability-v1",
    output: "order-quantum-no-cleanup-recoverability.json",
    run: runOrderQuantumNoCleanupRecoverabilityProof,
  },
  {
    id: "triggered",
    schema: "ckb-custody-flow-order-quantum-triggered-cleanup-recoverability-v1",
    output: "order-quantum-triggered-cleanup-recoverability.json",
    run: runOrderQuantumTriggeredCleanupRecoverabilityProof,
  },
] as const;

const requested = process.argv.slice(2);
const selected = requested.length
  ? requested.map((id) => {
      const variant = variants.find((candidate) => candidate.id === id);
      if (!variant)
        throw new Error(
          `unknown recoverability variant ${id}; expected ${variants.map(({ id }) => id).join(", ")}`,
        );
      return variant;
    })
  : variants;
const command = ["pnpm", "generate:recoverability"];

for (const variant of selected) {
  const report = {
    schema: variant.schema,
    node: process.version,
    command,
    result: variant.run(),
  };
  await writeFile(
    new URL(`../results/${variant.output}`, import.meta.url),
    `${canonicalJson(report)}\n`,
  );
}
