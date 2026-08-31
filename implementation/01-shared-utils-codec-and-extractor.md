# 01. Shared Utils Codec and Extractor

## Outcome

Establish the shared CKB primitives, codec, and normal-output remote procedure call (RPC) extraction contract in Utils, including the extractor-owned chain registration used by the one-byte Rosen wire format.

## Scope and Dependencies

- Read the [work breakdown](./README.md) and [integration contract](../README.md) first. This work item gates the metadata readers and writers in [work item 02](./02-watcher-ingest-path.md), [work item 03](./03-guard-chain-and-rpc-integration.md), and [work item 06](./06-sdk-integration.md).
- Target repositories: [Utils](https://github.com/rosen-bridge/utils) and this integration tracker.

## Requirements

### Primitives and Package Boundary

- Preserve `CKB_CHAIN = "ckb"`, the native token identifier `ckb`, and CKB in `SUPPORTED_CHAINS` as an extractor ordering outcome. Do not independently assign or document the index; use the value fixed when the extractor change is merged.
- Prepare the new `@rosen-bridge/address-codec-ckb` and `@rosen-bridge/ckb-primitives` packages under the version and changeset rule in [AGENTS.md](../AGENTS.md#contribution).
- Add `@rosen-bridge/ckb-primitives` through the Bridge Expansion Kit (RCS-003) Kodegen flow. It owns plain structural CKB types and checked-in strict Molecule codecs adapted from the [pinned CKB `blockchain.mol` schema](https://github.com/nervosnetwork/ckb/blob/91b97ab5f67fea203fdc5e5d6fbc19a5e0f8b987/util/gen-types/schemas/blockchain.mol). The codecs cover scripts, OutPoints, cell deps, inputs, outputs, raw/full transactions, and `WitnessArgs`.
- The same package owns RFC 0021 full addresses; `ckbBlake2b256` using the 16-byte `ckb-default-hash` personalization; transaction hashes; occupied capacity; extensible user-defined token (xUDT) little-endian `u128`; placeholder-preserving SighashAll over explicitly resolved inputs; secp256k1 public-key recovery from a 64-byte compact signature plus a `0..3` recovery identifier; and byte/hex/number bounds.
- Retrieve the schema bytes from that pinned source file. Limit new low-level runtime dependencies to explicit `@noble/hashes`, `@noble/curves`, and `bech32`. Add no dependency on CCC, the CKB ecosystem JavaScript SDK, or on a native addon, RPC client, cache, wallet, signer, selector, deployment discovery, or production code-generation step.
- Reject unrecognized script hash-type bytes, malformed `WitnessArgs`, and any SighashAll input set that is missing, extra, out of transaction order, or not keyed to the corresponding input's exact `previous_output`. A digest helper must not accept an unbound array of resolved cells.
- Preserve RFC 0021 Bech32m full-format mainnet address encode, decode, and validation support through the shared primitives. The first mainnet CKB integration release (v1) intentionally rejects `ckt` addresses. Rosen's 60-byte encoded bound leaves at most 26 lock-argument bytes; valid larger locks are unsupported payout destinations rather than malformed CKB addresses.
- Preserve lossless full-script serialization and equality over `code_hash`, `hash_type`, and `args`; do not reduce identity to a code hash or pubkey fragment.
- Remove CCC from the runtime dependency graph of the CKB address codec, Rosen extractors, Scanner, Watcher, Guard, and Minimum Fee Job consumers. CCC may remain an exact development-only dependency for differential vectors; it must not appear in packed production dependencies. The shared primitives own the codec, script hash, amount, transaction, witness, capacity, signing-digest, and recovery mechanics named above.
- Validate xUDT against the caller-supplied registered full type script and token-map route. Utils and extractors do not execute scripts, own dep OutPoints, discover deployments, or decide issuer and route acceptance.

### Extraction and Routes

- Correct `CkbRpcRosenExtractor` to calculate `metadataIndex = inputs.length`, decode only `witnesses[metadataIndex]` as `[depositOutputIndex][sourceInputIndex][Rosen payload]`, and require two little-endian `u32` transaction-wide indices and exact payload consumption. Do not scan other witnesses.
- Select only the encoded output and input indices. Reject missing inputs/outputs/data/witnesses, missing or malformed metadata, trailing bytes, either index out of range, malformed selected `previous_output`, a selected output whose full lock differs from the configured Rosen lock, and unsupported selected assets. Other matching outputs do not create events.
- Keep the extractor pure and perform no input-cell or dependency resolution. Derive `fromAddress` as `box:<previous_output.tx_hash>.<previous_output.index_decimal>` from `inputs[sourceInputIndex]`.
- Require a selected native CKB output to have no type script and empty output data, and take its amount from output capacity; this matches Guard's rejection of untyped non-empty-data custody cells and has no compatibility path. For xUDT require exactly 16 output-data bytes, parse the little-endian `u128`, identify the token by its full type-script hash, and require one token-map entry containing the requested target representation. Primitive amount decoding accepts zero, but deposit extraction rejects any selected native or xUDT amount that is not positive.
- Enforce `0..2^128-1` at every xUDT cell encode/decode boundary and reject arithmetic that cannot be represented by a valid xUDT transaction; never truncate or downcast an aggregate quantity.
- Resolve exactly one source-token/to-chain route and wrap the extracted amount at the least decimal precision among that token set: divide by `10^(sourceDecimals - minimumRouteDecimals)` and round up. Reject an unavailable or ambiguous route, and cover the high-decimal boundary so an amount cannot be silently truncated or routed through a different token set.
- Preserve normal Rosen-lock outputs and do not add Anyone Can Pay (ACP) input-delta extraction, output-data metadata, or per-input live-cell resolution.

### Runtime and Evidence

- Keep Utils at its declared Node `22.18.0` runtime.
- Correct the tracker wherever the implementation disproves its chain position, address-network, script identity, metadata, or output semantics.
- Prove the packed Utils packages install and expose their declared APIs through a clean package flow, including a Node `20.11.0` import/build check for the shared primitives and extractors. [Work item 02](./02-watcher-ingest-path.md) alone owns the exact final Utils/Scanner dependency lock, CCC-free production graph, and Watcher production-startup proof.

## Done When

- The package slices comply with [AGENTS.md](../AGENTS.md#contribution).
- Recovery tests cover official secp256k1 vectors, each valid recovery identifier, malformed compact signatures, and out-of-range identifiers, and prove `@noble/curves` is declared directly.
- Primitive, codec, full-script, chain registration, and corrected extra-witness/output/source-input extractor tests pass under the declared Utils runtime. They accept an empty-data untyped selected output, reject an untyped Rosen-lock selected output carrying data, and reject a zero-amount selected deposit while primitive xUDT decoding still accepts zero.
- Official vectors and exact-CCC differential tests cover serialized bytes, hashes, occupied capacity, addresses, zero/maximum/overflow xUDT amounts, witness preservation, and SighashAll. Negative tests cover unknown hash-type bytes, malformed first-group `WitnessArgs`, and missing, extra, reordered, or mismatched resolved inputs.
- Address tests cover the exact 60-byte boundary plus rejection of the 28-byte-args multisig `since` form and over-26-byte OmniLock configurations. Positive deployed-lock execution plus wrong-key-encoding and witness-mutation negatives prove the compressed-key lock derivation before custody address finalization.
- The one-byte CKB value comes only from `SUPPORTED_CHAINS`; no Guard or SDK array is treated as its owner.
- Route tests cover exact target filtering, ambiguity rejection, and ceiling division at the wrapped-representation boundary for a source token with more decimals than its target representation.
- Clean packed-package API/build checks pass under both declared consumer runtimes, or the exact incompatibility and blocked graph node remain explicit. Final Watcher startup is not a completion gate for this work item.

## Verification

- In the selected Utils checkout, use `git grep -n -E "CKB_CHAIN|CKB_NATIVE_TOKEN|SUPPORTED_CHAINS|CkbRpcRosenExtractor|depositOutputIndex|sourceInputIndex|ckt" -- packages` for tracked-source evidence, and use `git grep -n "initialize the package" -- .changeset` to verify the required package-initialization changesets.
- Run the strongest repository-native lint, type-check, test, and build checks that cover the changed Utils packages.
- Install or pack Utils with a clean supported flow in the selected downstream consumer and run the narrowest meaningful consumer build/test.
