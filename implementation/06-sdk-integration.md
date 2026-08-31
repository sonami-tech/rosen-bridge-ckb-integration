# 06. SDK Integration

## Outcome

Register CKB in the Rosen software development kit (SDK) and provide a mainnet-only `sdk-ckb` metadata writer that consumes the extractor-owned one-byte chain position and shared destination codec.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md), then complete [work item 01](./01-shared-utils-codec-and-extractor.md) first. This work item may proceed while Watcher and Guard work continues.
- Owned repositories: [Rosen SDK](https://github.com/rosen-bridge/rosen-sdk) and this integration tracker. Treat [Utils](https://github.com/rosen-bridge/utils) as the read-only dependency contract for this work item.
- SDK writes Rosen metadata; Watcher and Guard own transaction-level metadata validation. The first mainnet CKB integration release (v1) adds no on-chain metadata validator.

## Requirements

- Add CKB chain and native-token registration to the established SDK constants and public surfaces.
- Consume the CKB wire position assigned by Utils `SUPPORTED_CHAINS`; do not maintain or infer an independent ordering contract.
- Add the `sdk-ckb` package and metadata writer through the repository's established package conventions and changeset flow. CCC, the CKB ecosystem JavaScript SDK, may be used conventionally inside the SDK/UI transaction and wallet boundary, while structural metadata and destination APIs consume library-neutral Utils values. Do not export CCC classes through Rosen package boundaries or add CCC to Watcher/Guard through shared package dependencies.
- Encode mainnet destinations through the shared Utils codec and enforce the 60-byte encoded destination limit. Reject `ckt`, malformed destinations, the 28-byte-args multisig `since` form, and any other lock whose args make the full encoding exceed 60 bytes.
- For target-CKB native routes, expose the derived 67 CKB post-fee client floor. Reject exact full-script matches for configured Rosen hot and cold custody locks in user-facing target validation; do not put deployment-specific custody policy into the structural Utils codec.
- Expose CKB envelope encoding for `[depositOutputIndex: little-endian u32][sourceInputIndex: little-endian u32][existing Rosen payload]`. The transaction builder supplies both transaction-wide indices after input and output construction; SDK must not choose or reorder inputs or outputs.
- Preserve Rosen SDK's declared Node `22.18.0` runtime and prove clean package compatibility with Utils.
- Correct tracker SDK, wire-position, address-network, or metadata-size claims when implementation evidence differs.

## Done When

- SDK exports usable CKB/native constants and `sdk-ckb` metadata construction, not placeholder registration alone.
- Focused tests prove the extractor-assigned destination byte, exact 60-byte boundary, oversized multisig/OmniLock rejection, mainnet acceptance, `ckt` rejection, the 67 CKB post-fee native floor, exact hot/cold full-script rejection without same-`codeHash` overreach, both index boundaries, exact payload consumption without trailing bytes, and round-trip compatibility with the Utils envelope decoder.
- The SDK contains no second chain-order owner and no transaction-level or on-chain metadata validator.

## Verification

- Use tracked-source `git grep` in SDK and Utils for CKB registration, metadata generation, `SUPPORTED_CHAINS`, address validation, and length checks.
- Run SDK repository-native lint, type-check, focused tests, and builds under Node `22.18.0`.
- Pack/install Utils and SDK through clean supported flows and run the metadata round-trip test.
