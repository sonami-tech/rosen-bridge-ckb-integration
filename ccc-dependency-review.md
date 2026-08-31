# CKB TypeScript Library Review

## Reviewed Boundary

The accepted [CKB library-boundary decision](./decisions-and-open-questions.md#accepted-decisions) keeps `@ckb-ccc/core` out of custody and ingestion production runtimes. A bounded Rosen-owned TypeScript package in Utils supplies the required primitives. CCC, the CKB ecosystem JavaScript SDK, remains the wallet and transaction library for the software development kit (SDK) and user interface (UI) and an exact development-only reference for differential tests.

This document records the package evidence and alternatives behind that decision. The [integration README](./README.md#implementation-plan) owns the technical contract, and [work item 01](./implementation/01-shared-utils-codec-and-extractor.md) owns the primitive package requirements and verification. The SDK and UI work items own CCC wallet/provider use; the Watcher and Guard work items own packed-consumer and service-runtime proof.

This is a dependency and review-surface decision, not a claim that CCC is unsafe. Implementation evidence that exceeds the owned surface or disproves its verification bound reopens the decision.

## Evidence

The investigation compared the [pinned Guard source](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0), CCC `@ckb-ccc/core@1.16.1` from its [pinned source revision](https://github.com/ckb-devrel/ccc/tree/5f2f1d433416bd7d60721808d1506fec415ed018), the active and legacy CKB JavaScript libraries, the Nervos Rust SDK, and every existing Rosen chain package.

### Existing Rosen precedent

Rosen has no current chain that forks, vendors, or process-isolates its transaction library to reduce dependency surface. The useful precedents are narrower:

- Bitcoin, Doge, and Firo reuse `bitcoinjs-lib` for partially signed Bitcoin transactions (PSBTs), serialization, addresses, and signature hashes while Rosen owns chain policy and network adapters.
- Bitcoin Runes composes `bitcoinjs-lib` with a separate Runestone codec and adds extensive Rosen-owned policy verification.
- Cardano and Ergo consume upstream Rust/WASM packages in process. Rosen does not own their binding and release pipelines.
- EVM consumes ethers in process.

The selected boundary is new Rosen-owned primitive code rather than established precedent. The material difference is that CCC's only sufficient published entry is also its wallet, multi-chain signer, and network barrel; this exception must remain bounded and independently tested.

### CCC package surface

CCC `1.16.1` exposes the required APIs only through its main entry, whose published module and dependency graph includes wallet, EVM, networking, and duplicate cryptography dependencies that Guard and Watcher do not use. The narrower `./advanced` export omits transactions, `WitnessArgs`, general Molecule codecs, hashing, occupied capacity, SighashAll, and a Client. Build-specific dead-code elimination cannot narrow the installed dependency, provenance, or update-review surface.

The dependency closure has no native addon or lifecycle script, but the main entry is not a narrow core. A frozen production-only install from CCC's exact source lock resolved 44 package-store entries (54 dependency-tree nodes) and occupied 58 MB. The 139-file published package itself is about 2.98 MB unpacked; its manifest has 10 direct runtime dependencies, including JoyID, ethers, networking, and three Noble packages.

Reconstruct the locked measurement by archiving the [pinned CCC source revision](https://github.com/ckb-devrel/ccc/tree/5f2f1d433416bd7d60721808d1506fec415ed018), then run `corepack pnpm@11.8.0 install --filter @ckb-ccc/core --prod --frozen-lockfile --ignore-scripts`, `corepack pnpm@11.8.0 list --filter @ckb-ccc/core --prod --depth Infinity`, and `du -sh node_modules`. The [source lock](https://github.com/ckb-devrel/ccc/blob/5f2f1d433416bd7d60721808d1506fec415ed018/pnpm-lock.yaml) has SHA-256 `6e57b80b9072fbf0f42fbef4eebb6da2a6269431a11496701a3ad8814332fee4`; the [core manifest](https://github.com/ckb-devrel/ccc/blob/5f2f1d433416bd7d60721808d1506fec415ed018/packages/core/package.json) is pinned by the same revision.

Loading the CommonJS main entry executed imports from JoyID, ethers, legacy `@nervosnetwork/ckb-sdk-utils`, elliptic, node-fetch, WebSocket, and multiple cryptography stacks. The `./advanced` entry loaded a smaller network stack but exported none of `Transaction`, `RawTransaction`, `WitnessArgs`, `Script`, `CellInput`, `CellOutput`, or CKB hashing. The sufficient APIs therefore require the broad main entry, not merely installation of unused files.

Guard already carries many dependency names, but exact comparison with the [pinned Guard source](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0) still found nine new non-platform names and incompatible generations of Noble ciphers/curves/hashes, ethers, TypeScript, and WebSocket packages. The frozen CCC lock includes TypeScript `6.0.3` as a production peer through JoyID/abitype and legacy elliptic through `ckb-sdk-utils`. Guard's lockfile would pin the final closure, but CCC's caret manifest alone does not.

### Alternatives considered

- **Full CCC in Guard/Watcher, rejected:** The only sufficient entry executes the broad wallet/EVM/network graph, and Watcher retains Node `20.11.0`.
- **CCC only in Guard with owned Node-20 extraction helpers, rejected:** This retains the broad Guard graph and creates two transaction/codec models.
- **Current `./advanced` only, rejected:** It lacks the load-bearing transaction, codec, capacity, hashing, and signing APIs.
- **Tree-shake the published package, rejected:** Build-specific dead-code elimination does not narrow the installed dependency, provenance, or update-review surface.
- **Upstream CCC `./custody` export:** Technically clean for executed-code reduction, but it does not yet exist and would still install core's broad dependency graph.
- **Upstream `@ckb-ccc/primitives`:** The cleanest CCC-owned endpoint, but it requires a material upstream package split and cannot gate this integration.
- **Rosen source-built CCC custody package:** Feasible, but Rosen would own a filtered fork and its update workflow.
- **Full Nervos Rust SDK through WASM, rejected:** It has no ready JavaScript ABI and adds a second build toolchain.
- **Narrow official-crates WASM:** Viable, but Sonami would own the bindings, loader, memory ABI, reproducible artifact, and release pipeline that Cardano/Ergo upstreams already provide.
- **Legacy `@nervosnetwork/ckb-sdk-*`, rejected:** The project labels itself obsolete and passively maintained; relevant APIs are deprecated toward Lumos.
- **Lumos, rejected:** Deprecated.
- **`ckb-js-toolkit`, insufficient:** It provides generic remote procedure calls (RPCs) only, without transaction codecs, addresses, hashes, or SighashAll.
- **Bounded owned TypeScript primitives, selected:** This provides one runtime model across custody and ingestion, no second toolchain, and no wallet/EVM/network graph.

Git subtree, submodule, sparse checkout, or a SHA-pinned Git dependency does not narrow an import graph by itself. A filtered CCC fork would still need its own manifest, build, tests, notices, and deliberate upstream-diff review, so it is more maintenance than the fixed primitive layer.

## Why This Choice

Owned TypeScript wins because CCC's sufficient entry executes unrelated wallet, EVM, JoyID, legacy SDK, and network stacks in the custody process. The primitive package uses CKB's exact schema pin, existing pure TypeScript cryptography dependencies, and a much narrower API while Guard continues to own chain policy.

This choice accepts ownership of security-critical primitive glue, so [work item 01](./implementation/01-shared-utils-codec-and-extractor.md) combines differential tests with official vectors, malformed-input tests, deployed-lock execution, clean packed consumers, and complete-byte comparisons. Expansion toward a general client, wallet, signer hierarchy, or second cryptographic implementation would exceed the measured rationale for this boundary.

Rosen-owned JSON-RPC packages remain local-node adapters. Deployment data stays explicit, and CCC remains the actively maintained independent reference without entering the production custody graph.

## Evidence Pins

- **Rosen Guard:** [Pinned source revision](https://github.com/rosen-bridge/guard-service/tree/ac5702608e8f441a932b01582881a01be32155b0).
- **CCC source for `@ckb-ccc/core@1.16.1`:** [Pinned source revision](https://github.com/ckb-devrel/ccc/tree/5f2f1d433416bd7d60721808d1506fec415ed018).
- **CCC source lock:** [Pinned `pnpm-lock.yaml`](https://github.com/ckb-devrel/ccc/blob/5f2f1d433416bd7d60721808d1506fec415ed018/pnpm-lock.yaml), SHA-256 `6e57b80b9072fbf0f42fbef4eebb6da2a6269431a11496701a3ad8814332fee4`.
- **CCC npm integrity:** `sha512-KU7qDwJtESJy+wwhzow9+wU4JW7zrpxS/tbdhx68HxBs3wMeYaNew6PgajMVDYRd8DlrsAqX3lDGMDVbSMEyWw==`.
- **Nervos Rust SDK spike:** [Pinned source revision](https://github.com/nervosnetwork/ckb-sdk-rust/tree/1fbf3d4c9b35ef90bdb9e6621a8d26edde6325ce).
- **CKB Rust primitives:** `ckb-gen-types@1.1.1`, `ckb-hash@1.1.1`, `ckb-occupied-capacity@1.1.1`, and `molecule@0.9.2`.
- **Legacy JavaScript SDK review:** [Pinned source revision](https://github.com/ckb-js/ckb-sdk-js/tree/17dcc4286943858c67928cf390b45a55b138fffa), npm `0.109.5`.
- **Official toolkit review:** [Pinned source revision](https://github.com/nervosnetwork/ckb-js-toolkit/tree/cb416bbd6a41996dbd7f69d91c25f9812119471c).
