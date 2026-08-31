import type { SizedPlan, StructuralProfile } from "./model.ts";

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

const join = (parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const table = (fields: Uint8Array[]): Uint8Array => {
  const headerBytes = 4 + fields.length * 4;
  let offset = headerBytes;
  const offsets = fields.map((field) => {
    const current = offset;
    offset += field.length;
    return u32(current);
  });
  return join([u32(offset), ...offsets, ...fields]);
};

const fixvec = (items: Uint8Array[]): Uint8Array =>
  join([u32(items.length), ...items]);

const dynvec = (items: Uint8Array[]): Uint8Array =>
  items.length === 0 ? u32(4) : table(items);

const moleculeBytes = (length: number): Uint8Array =>
  join([u32(length), new Uint8Array(length)]);

const moleculeData = (data: Uint8Array): Uint8Array =>
  join([u32(data.length), data]);

const script = (contentBytes: number): Uint8Array => {
  if (contentBytes < 33) throw new Error("script content must include code hash and hash type");
  return table([
    new Uint8Array(32),
    new Uint8Array(1),
    moleculeBytes(contentBytes - 33),
  ]);
};

export const serializeFixtureTransaction = (
  plan: SizedPlan,
  profile: StructuralProfile,
): Uint8Array => {
  const outputs = [plan.recipient, ...plan.change];
  // Mirror the independent size model's lock-dep plus optional xUDT-dep rule.
  const cellDeps =
    profile.cellDeps + (outputs.some((output) => output.typeBytes > 0) ? 1 : 0);
  const outputCells = outputs.map((output) =>
    table([
      new Uint8Array(8),
      script(output.lockBytes),
      output.typeBytes === 0 ? new Uint8Array() : script(output.typeBytes),
    ]),
  );
  const outputData = outputs.map((output) => moleculeBytes(output.dataBytes));
  const witnesses =
    plan.inputs.length === 0
      ? []
      : [
          moleculeData(
            table([
              moleculeBytes(65),
              new Uint8Array(),
              new Uint8Array(),
            ]),
          ),
          ...Array.from(
            { length: plan.inputs.length - 1 },
            () => moleculeBytes(0),
          ),
        ];
  const raw = table([
    new Uint8Array(4),
    fixvec(
      Array.from({ length: cellDeps }, () => new Uint8Array(37)),
    ),
    fixvec(
      Array.from({ length: profile.headerDeps }, () => new Uint8Array(32)),
    ),
    fixvec(plan.inputs.map(() => new Uint8Array(44))),
    dynvec(outputCells),
    dynvec(outputData),
  ]);
  return table([raw, dynvec(witnesses)]);
};
