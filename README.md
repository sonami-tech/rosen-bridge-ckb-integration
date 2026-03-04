# CKB Integration for Rosen Bridge

Technical assessment and implementation plan for integrating [Nervos CKB](https://www.nervos.org/) into [Rosen Bridge](https://rosen.tech/) using the [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/master/rcs-003).

## Why Rosen Bridge

Rosen Bridge is a bidirectional cross-chain asset bridge with a [Proof of Event](https://github.com/rosen-bridge/rcs) security model: two layers of incentivized off-chain verifiers (Watchers and Guards) validate every transfer, minimizing smart contract exposure. It is [live on mainnet](https://app.rosen.tech/), [audited](https://drive.google.com/file/d/1BbLMbmhm0GtaajTZymbZkbX6HNptNZvE/view?usp=sharing), and currently connects Cardano, Ergo, Ethereum, Binance, Dogecoin, Bitcoin, and Bitcoin Runes.

Adding CKB means every connected chain becomes reachable in both directions: CKB-native assets (CKB, iCKB, SEAL) flow outward as wrapped tokens (rsCKB, rsiCKB, rsSEAL), while assets from those chains flow inward. This would be the first fully decentralized bridge on Nervos, complementing RGB++ (UTXO-only, no account-model chains) and Fiber (payment channels, no cross-chain token bridging). Community members can participate as Watchers, staking RSN and earning bridge fees for validating CKB transactions.

Development is led by [Sonami](https://sonami.cc/) and funded by the Nervos [Community Fund DAO](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756).

## Technical Assessment

### Base Requirements

RCS-003 defines three base requirements. CKB satisfies all three.

#### 1. Multi-Signer Addresses

CKB's Cell model uses programmable lock scripts to control asset ownership. Multi-signature custody is achieved through:

- **On-chain multisig**: CKB has a [multisig lock script](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_multisig_all.c) deployed as a system script, supporting M-of-N threshold signing (N up to 255, covering the target ~30-guard set). [Omnilock](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0042-omnilock/0042-omnilock.md) (auth flag `0x06`) provides the same multisig with composable modes (Anyone-Can-Pay, time-lock, supply).

- **Threshold Signature Scheme (TSS)**: CKB's default [secp256k1-blake160-sighash-all](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_sighash_all.c) lock script supports standard ECDSA signatures, making it compatible with the ECDSA TSS scheme used by Rosen Bridge for Bitcoin, Doge, and Ethereum.

**Chosen approach: ECDSA TSS (Threshold Signature Scheme).** The default lock verifies a standard ECDSA signature, indistinguishable from the one produced by TSS. The lock address is `blake160(tss_shared_pubkey)`. CKB uses the same signing backend as Bitcoin, Ethereum, Doge, and Binance: the existing [tss-api](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api) Go binary and [TssSigner](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/tssSigner.ts) TypeScript coordination. No new signing package is needed.

On-chain multisig was not selected (see [signing approach comparison](./guard-signing/comparison.md)) because:

- **Security parity**: On-chain multisig makes the M-of-N threshold visible to observers, but the security guarantee is equivalent: TSS cannot produce a valid signature without M parties participating in the MPC protocol ([proven in tss-lib](https://github.com/bnb-chain/tss-lib)). The same TSS backend already secures 5+ chains with higher TVL than CKB would carry. Hardening only CKB does not strengthen the bridge as a whole.
- **Operational isolation**: During guard rotation, every non-Ergo chain must migrate assets to the new address. With TSS, CKB piggybacks on the bridge-wide migration event (all ECDSA chains rotate together using the same tooling). With multisig, CKB would be the only non-Ergo chain migrating through a non-TSS signing path, requiring its own migration procedures and tooling that no other chain uses. Ergo does not need migration (its Lock address is stable across rotations).
- **New signing package**: Both multisig variants require a new `@rosen-bridge/ckb-multi-sig` package for P2P signature collection and witness assembly (~500-1000 LOC). TSS reuses the existing signing backend shared by 5+ chains with zero new signing code.
- **Draft tooling dependency (Omnilock)**: Omnilock multisig witness encoding depends on CCC PR [#360](https://github.com/ckb-devrel/ccc/pull/360) (draft, not merged). The system multisig script avoids PR #360 but depends on CCC PR [#349](https://github.com/ckb-devrel/ccc/pull/349) (open, not merged) for multisig signer support, and still lacks ACP composability (requires a separate ACP lock for deposits, same as TSS, without the benefit of reusing existing signing infrastructure).

Deposits use the standalone [RFC 0026 Anyone-Can-Pay (ACP)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) lock, which extends `secp256k1-blake160-sighash-all` with relaxed deposit rules; see [State Rent](#state-rent) and [Lock Scripts](#lock-scripts) for details.

The [Quantum Resistant Lock (QRL)](https://github.com/cryptape/quantum-resistant-lock-script) was also considered for its post-quantum security, but was not selected for v1.0 because:

- **Premature**: Every other chain in Rosen Bridge uses ECDSA or EdDSA TSS, none of which are quantum resistant. Hardening only the CKB side protects nothing, since an attacker who can break ECDSA can compromise the bridge through any other connected chain.
- **Maturity**: The bridge minimizes smart contract risk by depending only on battle-tested scripts (default secp256k1-blake160 lock, RFC 0026 ACP, xUDT). QRL has been [audited by Scalebit](https://scalebit.xyz/reports/20251216-Quantum-Resistant-Lock-Script-Final-Audit-Report.pdf), but it has no production track record. The default lock and ACP lock use the same secp256k1 algorithm that has been in production since CKB genesis.
- **ACP**: QRL has no built-in ACP support. The bridge's deposit cells use the [RFC 0026 ACP](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) lock, which requires a secp256k1 signature for spending. QRL on custody cells would leave deposit cells (and their spending path) quantum-vulnerable, providing incomplete protection.
- **Upgrade risk**: QRL is deployed by type (upgradable). The bridge's current lock scripts are both referenced by `data` hash, with zero upgrade risk (the default lock is a genesis system script; the ACP lock has not been upgraded since 2020). Adding QRL would introduce an upgradable dependency where currently there are none.
- **Tooling**: CCC has no QRL support. Address generation, witness construction, and sighash computation would all require custom implementation.

QRL can be revisited for a future v2.0 upgrade once other Rosen Bridge chains adopt quantum-resistant signing, QRL gains adoption in the Nervos ecosystem, and CCC adds support for it.

#### 2. Data Writing

CKB transactions support two locations for embedding Rosen Bridge request data:

- **Cell data**: Output cells can carry arbitrary data in their `data` field. xUDT validates only the first 16 bytes (the token amount), so bridge metadata can be appended freely (see [Token Support](#token-support) for extension bit constraints). Cell data is covered by the transaction hash, making it tamper-proof.
- **Witness fields**: Arbitrary data can be included in a transaction's witness array (analogous to Bitcoin's SegWit witness data). However, witness data is not always covered by the signature, depending on the lock script (e.g. ACP locks have no signature to validate witnesses).

Both locations can carry the required bridge request fields (`toChain`, `toAddress`, `bridgeFee`, `networkFee`).

**Chosen approach: cell data.** Bridge request metadata is appended after the 16-byte xUDT amount in the ACP output cell. This applies to all CKB lock transactions: both xUDT and native CKB deposits go into the bridge's ACP cells (see [State Rent](#state-rent)). Cell data was chosen over witnesses because ACP locks have no signature, so witness data is unauthenticated and could be tampered with by anyone relaying the transaction.

On-chain validation of bridge metadata is not required: watchers and guards validate it off-chain, cross-matching against the actual transaction. Malformed or malicious metadata cannot harm the bridge; in the worst case, the malicious user loses their own funds.

#### 3. Sufficient Endpoints

The reference node ([ckb](https://github.com/nervosnetwork/ckb)) exposes a JSON-RPC API covering both chain data and cell/transaction indexing (built-in indexer since v0.105.0; must be enabled in node configuration). Multiple independent RPC nodes can be operated to avoid single points of failure, satisfying the decentralization requirement.

### Additional Requirements

#### Token Support

CKB supports fungible tokens through on-chain scripts:

- **[sUDT (Simple UDT)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0025-simple-udt/0025-simple-udt.md)**: The original token standard. Stores a 16-byte little-endian `u128` amount in cell data. Token identity is the type script hash. Validates that total output amount does not exceed total input amount (unless in owner mode). No extension mechanism.
- **[xUDT (Extensible UDT)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0052-extensible-udt/0052-extensible-udt.md)**: Successor to sUDT. Same cell data layout and amount validation, plus a 4-byte flags field in type script args that controls owner mode (upper bits) and optional extension scripts (lower bits). With no active extensions, xUDT behaves identically to sUDT.
- **[CoTA (Compact Token Aggregator)](https://github.com/nervina-labs/cota-docs)**: A layer-1.5 account-based token protocol. Stores token state as a Sparse Merkle Tree root rather than explicit balances. Never gained significant ecosystem traction.

Under sUDT and xUDT, each token balance lives in a cell, and native CKB is carried as cell capacity, not as a token amount (see [State Rent](#state-rent)). CoTA's account-based model is fundamentally different: it aggregates balances into a Sparse Merkle Tree, so this per-cell distinction does not apply.

**Chosen standard: xUDT.** While only sUDT-compatible features are needed (no active extensions), the ecosystem has moved to xUDT: dominant adoption on [CKB Explorer](https://explorer.nervos.org/xudts), broader wallet support through [CCC](https://github.com/ckb-devrel/ccc), and active tooling development.

**Minting bridge tokens:** Bridged token representations on CKB (e.g. rsADA, rsERG) are minted once at maximum supply (2^128 - 1) using a [single-use lock](https://github.com/ckb-devrel/ckb-proxy-locks/tree/main/contracts/single-use-lock) (referenced immutably by `data1` on mainnet). The lock permanently destroys the mint key after the initial mint, eliminating infinite-mint attack vectors. This is a deliberate tradeoff applied across all Rosen Bridge chains: tokens with uncapped supply on their home chain cannot have their full supply bridged, but 2^128 is large enough that this is never a practical constraint.

Beyond the standard choice, each candidate token must be compatible with bridge metadata in cell data and free of issuer-controlled transfer restrictions.

**Bridging existing ecosystem tokens:** A token is bridgeable if its type script validates only the first 16 bytes of cell data (the little-endian `u128` amount), since bridge metadata appended after the amount is ignored. sUDT tokens qualify unconditionally (no extension mechanism).

For xUDT tokens, bridgeability requires extension bits = 0 in the flags field (no active extension scripts). Owner mode bits in the same flags field control minting authority but do not affect bridgeability. For example, [iCKB](https://github.com/ickb/whitepaper) sets owner mode bits to enable minting via its logic script, but has no active extensions, so it is bridgeable. See [xudt_rce.c](https://github.com/nervosnetwork/ckb-production-scripts/blob/master/c/xudt_rce.c) for the flags layout and `simple_udt()` validation logic.

**Retroactive extension safety:** An issuer cannot add extensions to an existing xUDT after the fact. Token identity is determined by the full type script hash (including `args`, which contain the flags field), so changing the flags would change the type script hash, creating a different token.

**Clawback and freeze exclusion:** The bridge commingles deposits from many users into shared custody cells. If an issuer froze the bridge address, all bridged representations of that token would become unbacked at once, affecting every holder across every connected chain. Rosen Bridge therefore excludes tokens with issuer-controlled freeze or clawback capabilities as a protocol-level policy.

For xUDT, the extension bits = 0 filter handles this: the [Regulation Compliance Extension](https://github.com/nervosnetwork/ckb-production-scripts/blob/master/c/rce.h) (RCE) can enforce address blacklists, whitelists, and emergency halts, but only activates when extension bits != 0.

Non-xUDT token standards with admin-controlled pause capabilities are also excluded. For example, [Pausable UDT](https://github.com/ckb-devrel/pausable-udt/) is a standalone SSRI-compliant type script that allows admins to halt all transfers involving specific addresses ([USDi](https://interpaystellar.com/) [uses it](https://github.com/interpaystellar/pausable-udt/tree/usdi/deploy)). An admin pause on the bridge address would freeze commingled funds from every connected chain.

#### State Rent

Unlike most chains, CKB requires every cell (UTXO) to carry enough CKB to cover its on-chain storage (1 CKB per byte of cell data + scripts). A basic cell requires 61 CKB; an xUDT cell requires 142 CKB. This "state rent" affects bridge design:

- **Inbound (bridge pays user):** The bridge must create a new cell for the recipient, funding it with sufficient CKB for state rent. This CKB cost is factored into the network fee charged to the user. At current CKB prices, this overhead is reasonable, but a significant CKB price increase could raise bridge costs.

- **Outbound (user pays bridge):** To avoid users losing CKB to state rent when depositing xUDT tokens, the bridge maintains [ACP](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) cells for each supported xUDT. Users deposit by adding tokens to an available bridge-owned ACP cell rather than creating a new cell, so they transfer only the xUDT amount. Bridge request metadata is included in the cell data of the ACP output.

Multiple ACP cells per token avoid state contention when users deposit concurrently. The UI selects an available ACP cell; when all are consumed by pending deposits, it chains off a pending transaction's output.

For native CKB deposits, the user adds CKB to a designated xUDT ACP cell, increasing its CKB capacity without affecting the xUDT amount or bridge metadata already present (see [Token Support](#token-support) for why this is safe).

#### Lock Scripts

The two lock scripts introduced in [Multi-Signer Addresses](#1-multi-signer-addresses) both use `blake160(tss_shared_pubkey)` in lock args: the [default secp256k1-blake160-sighash-all](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_sighash_all.c) lock for custody cells, and the [RFC 0026 Anyone-Can-Pay (ACP)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) lock for deposit cells. The default lock is a [system script](https://github.com/nervosnetwork/ckb-system-scripts) deployed in CKB's genesis block; the ACP lock was deployed post-genesis but has never been upgraded since 2020. Both are safe to reference by `data` hash (immutable content addressing).

**Custody cells (default lock):** Guards spend custody cells by placing the TSS-produced 65-byte recoverable ECDSA signature in `WitnessArgs.lock`. The lock recovers the public key from the signature, computes `blake160(recovered_pubkey)`, and compares against lock args. Bridge custody cells require 142 CKB minimum capacity with xUDT.

**Deposit cells (ACP lock):** The RFC 0026 ACP lock extends `secp256k1-blake160-sighash-all` with relaxed deposit rules. Users deposit without signature: at least one of CKB or xUDT must increase by at least the configured minimum (`10^n`, where `n` is the corresponding byte in lock args after the 20-byte pubkey hash). The other must remain exactly unchanged ([`anyone_can_pay.c`](https://github.com/cryptape/anyone-can-pay/blob/main/c/anyone_can_pay.c) rejects any delta below the minimum, including partial increases). Bridge ACP cells require 144 CKB minimum capacity with xUDT (before metadata).

**Consolidation:** The bridge spends ACP cells using the standard spending path (TSS signature in `WitnessArgs.lock`). The ACP lock uses the same sighash algorithm as the default lock, so the same TSS key signs for both cell types. When a transaction mixes both lock scripts as inputs (e.g. ACP deposit cells plus a custody cell for fee funding), each [script group](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0022-transaction-structure/0022-transaction-structure.md) requires its own witness entry with a separate TSS signature over its sighash. TSS supports up to 5 parallel signatures per turn, so this does not constrain throughput.

#### Transaction Fee Handling

CKB transaction fees are denominated in CKB, based on transaction weight: `max(serialized_size, cycles * bytes_per_cycle)`. For typical bridge transactions (simple transfers, no heavy computation), size dominates and fees are stable and low (typically < 0.001 CKB), keeping fee management simple for the guard service.

For inbound transfers, the network fee must also cover the state rent for the recipient's output cell (see [State Rent](#state-rent)). Rosen Bridge enforces a minimum fee (periodically updated via fee estimation plus slippage) that overrides user-specified fees: `actual_fee = max(min_fee, user_fee)`.

#### dApp Connector

CKB has wallet connectivity through CCC, which provides a unified interface for browser extension wallets (JoyID, UniSat, OKX, UTXO Global, and EVM wallets like MetaMask via EIP-6963). Lock transactions can be constructed and signed through CCC's signer abstraction.

#### Transaction Chaining

CKB's Cell model supports transaction chaining: an output cell from one transaction can be referenced as an input in a subsequent transaction before the first is confirmed, so bridge payment events can be batched.

Chain depth is bounded by the node's `max_ancestors_count` mempool policy (default well above what bridge batching requires).

#### Event Distinguishability

Each CKB output has a unique OutPoint (transaction hash + output index), so every bridge deposit is distinguishable.

### CKB Technical Parameters

| Parameter | Value |
| --- | --- |
| Block time | ~10 seconds (variable, difficulty-adjusted) |
| Confirmation policy | 50 blocks (~8 minutes) |
| Address format | [CKB Address Format (RFC 0021)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0021-ckb-address-format/0021-ckb-address-format.md). Bech32m with `ckb` prefix (mainnet) |
| Key derivation | BIP-32/44 path `m/44'/309'/0'` (coin type 309) |
| Native token | CKB (1 CKB = 10^8 shannons) |
| Cell capacity | 1 CKB per byte of on-chain storage |
| Basic cell | 61 CKB |
| xUDT cell | 142 CKB |
| Bridge custody cell | 142 CKB (default lock xUDT) |
| Bridge ACP cell | 144 CKB (before metadata) |
| Full node resources | Configuration-dependent (some [community nodes](https://talk.nervos.org/t/dis-build-and-distribute-efficient-network-nodes/7594) run on ARM SBCs). Bridge nodes need the built-in indexer RPC enabled |

The 50-block confirmation policy is based on the [RGB++ security analysis](https://github.com/utxostack/RGBPlusPlus-design/blob/main/docs/security-analysis-en.md) ([Ren Zhang's](https://scholar.google.com/citations?hl=en&user=JB1uRvQAAAAJ) research), which shows 24 CKB confirmations match the security of 6 Bitcoin confirmations (30% adversary hash rate, 2.5% orphan rate). We double that to 50 for additional safety margin, matching CCC's [`DEFAULT_CONFIRMED_BLOCK_TIME`](https://github.com/ckb-devrel/ccc/blob/master/packages/core/src/client/cache/memory.advanced.ts).

## Implementation Plan

Implementation follows the RCS-003 module order. CKB naming convention: `Ckb` for the chain, `Rpc` for the network API.

### Phase 1: Scanner

**Repo:** [scanner](https://github.com/rosen-bridge/scanner) | **Package:** `@rosen-bridge/ckb-scanner`

| Component         | Class           | Description                                                                                                                        |
| ----------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Network connector | `CkbRpcNetwork` | Wraps CKB JSON-RPC (`get_block_by_number`, `get_block`, `get_transaction`, `get_tip_block_number`) via `@rosen-clients/rate-limited-axios` |
| Scanner           | `CkbRpcScanner` | Extends `GeneralScanner`, fetches blocks and extracts transactions                                                                 |

The scanner fetches blocks by number via `get_block_by_number` (default `verbosity=2`), which returns full transaction objects in a single call, and converts them into the scanner's internal transaction format for registered extractors. Inputs in the RPC response contain only OutPoint references, so the scanner must resolve each input's cell data separately (e.g. via `get_transaction` on the creating transaction).

**CKB transaction type:** Transaction hash, inputs (previous OutPoints + resolved cell data), outputs (capacity, lock/type scripts, data), and witnesses.

**Chain reorganization handling:** `CkbRpcScanner` inherits reorg detection from `GeneralScanner`, which compares saved block hashes against the network at each sync cycle. On fork detection, `stepBackward()` walks back to the fork point and removes invalidated blocks, then `stepForward()` re-scans the canonical chain. CKB's NC-Max consensus permits short-lived forks, so this handling is necessary. The 50-block confirmation policy (see [CKB Technical Parameters](#ckb-technical-parameters)) is the primary mitigation: extractors only act on sufficiently confirmed data.

### Phase 2: Address Codec

**Repo:** [utils](https://github.com/rosen-bridge/utils) | **Package:** `@rosen-bridge/address-codec`

CKB addresses (RFC 0021) are human-readable Bech32m encodings of the underlying lock script (`code_hash + hash_type + args`), using the full format (`0x00`). The codec must:

- **Encode**: Convert a CKB address into the hex-serialized lock script expected by Rosen (no `0x` prefix)
- **Decode**: Reconstruct a CKB address from the hex-serialized lock script
- **Validate**: Verify address format (correct Bech32m checksum, valid HRP `ckb`, valid payload format)

The [CCC SDK](https://github.com/ckb-devrel/ccc) provides address encoding/decoding utilities for this.

### Phase 3: Rosen Extractor (Network-based)

**Repo:** [utils](https://github.com/rosen-bridge/utils) | **Package:** `@rosen-bridge/rosen-extractor`

| Component     | Class                  |
| ------------- | ---------------------- |
| RPC extractor | `CkbRpcRosenExtractor` |

The extractor parses CKB lock transactions to extract bridge request data (`toChain`, `toAddress`, `bridgeFee`, `networkFee`, `fromAddress`, amount, token IDs, source tx ID).

**Data encoding approach:** Metadata is encoded in cell data as described in [Data Writing](#2-data-writing). This applies to both xUDT and native CKB lock transactions. For native CKB, the user adds capacity to an existing xUDT ACP cell, which retains its type script. Cell data is permitted because [RFC 0026](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md) rule 2.c only rejects cell data on cells without a type script.

**Wire format:** The extractor uses the same binary serialization format (`parseRosenData`) used by Bitcoin and similar chains: `[1B toChain index][8B bridgeFee BE u64][8B networkFee BE u64][1B toAddress length][variable toAddress]`. The fixed overhead is 18 bytes; total metadata size varies by destination address length (e.g. 38 bytes for Ethereum, 51 bytes for Ergo, 75 bytes for Cardano).

Since metadata is stored in cell data, it increases the ACP cell's minimum capacity requirement by the same byte count (a bridge ACP cell targeting Cardano destinations needs 144 + 75 = 219 CKB minimum).

**Amount computation:** Unlike non-ACP chains where the output value equals the deposit amount, ACP deposits add to an existing cell. The transferred amount is computed as the difference between the output and input cell values (CKB capacity for native deposits, xUDT amount for token deposits), using the resolved input data provided by the scanner (see [Phase 1](#phase-1-scanner)).

**Chain index registration:** `parseRosenData` encodes `toChain` as a 1-byte index into the `SUPPORTED_CHAINS` array. CKB must be registered at the next available index (currently 9, after Firo). This index is baked into the binary wire format of every bridge request, so all services (watchers, guards, UI) must agree. Coordinate the assignment with the Rosen team to avoid conflicts with other in-progress integrations.

### Phase 4: Observation Extractor

**Repo:** [scanner](https://github.com/rosen-bridge/scanner) | **Package:** `@rosen-bridge/ckb-observation-extractor`

| Component             | Class                        |
| --------------------- | ---------------------------- |
| Observation extractor | `CkbRpcObservationExtractor` |

Extends `AbstractObservationExtractor`, wiring the CKB scanner type to the CKB Rosen extractor. Minimal custom logic: the abstract base class handles most observation processing.

### Phase 5: Rosen Chain

**Repo:** [guard-service](https://github.com/rosen-bridge/guard-service)

This is the largest module, implemented in four sub-phases per RCS-003.

#### 5a. Abstract Chain (Bases)

**Package:** `@rosen-chains/ckb`

CKB is a UTXO-based chain, so the chain class inherits from `AbstractUtxoChain`.

| Component         | Class                                                   |
| ----------------- | ------------------------------------------------------- |
| Chain             | `CkbChain` extends `AbstractUtxoChain<CkbTx, CkbUtxo>`  |
| Network interface | `AbstractCkbNetwork` extends `AbstractUtxoChainNetwork` |

**`CkbTx` type:** Represents a CKB transaction with hash, inputs, outputs, and witnesses.

**`CkbUtxo` type:** Represents a CKB live cell (UTXO equivalent) with OutPoint, capacity, lock script, type script, and data.

Design considerations:

- **Box selection**: CKB cells have a minimum capacity requirement (61+ CKB). The chain implementation must account for this when selecting inputs and creating change outputs.
- **xUDT handling**: Token transfers require creating output cells with the correct type script and UDT amount in cell data, plus sufficient CKB capacity to cover cell storage.
- **ACP cell management**: The bridge maintains a pool of ACP cells for receiving xUDT deposits. The chain must manage consolidation and keep enough ACP cells available for concurrent deposits. Key operational parameters:
  - Initial pool size per token
  - Threshold for deploying additional ACP cells
  - Consolidation strategy for cells that accumulate many small deposits (merging capacity back into fewer cells)
  - Recovery when all ACP cells for a token are consumed in the same block
- **Fee estimation**: Transaction fee is based on transaction weight (see [Transaction Fee Handling](#transaction-fee-handling)). The chain must calculate fees after transaction construction and iterate if additional inputs are needed.

#### 5b. Rosen Extractor (Universal)

**Repo:** [utils](https://github.com/rosen-bridge/utils) | **Package:** `@rosen-bridge/rosen-extractor`

| Component           | Class               |
| ------------------- | ------------------- |
| Universal extractor | `CkbRosenExtractor` |

Accepts stringified JSON of `CkbTx` (the guard-service transaction type) and extracts the same Rosen data fields as the network-based extractor.

#### 5c. Abstract Chain (Implementation)

Key `CkbChain` method implementations (inherited from `AbstractChain` and `AbstractUtxoChain`):

- **`generateMultipleTransactions`**: Build payment transactions for bridge events, creating outputs to destination addresses with correct CKB/xUDT amounts
- **`getTransactionAssets`**: Extract CKB capacity and xUDT amounts from transaction inputs/outputs (parse 16-byte LE `u128` from cell data, identify tokens by type script)
- **`extractTransactionOrder`**: Extract the payment order (destination addresses and asset amounts) from a `PaymentTransaction`
- **`verifyTransactionFee`**: Validate that the fee covers transaction weight (`max(serialized_size, cycles * bytes_per_cycle)`)
- **`signTransaction`**: Place the TSS-produced 65-byte ECDSA signature in `WitnessArgs.lock` for each script group
- **`submitTransaction`**: Broadcast signed transaction via CKB RPC (`send_transaction`)
- **`rawTxToPaymentTransaction`**: Convert a raw CKB transaction JSON into the guard-service `PaymentTransaction` format
- **`getMempoolBoxMapping`**: Map spent OutPoints to their replacement cells from the CKB tx pool, preventing double-spend during concurrent bridge operations
- **`verifyPaymentTransaction`**: Verify internal consistency of a `PaymentTransaction` (txId matches serialized transaction, input metadata is accurate)
- **`isTxValid`**: Check that a transaction's inputs are still unspent and conflict-free
- **`verifyTransactionExtraConditions`**: CKB-specific validation (e.g. verify outputs use the correct lock script: RFC 0026 ACP for deposit cells, default secp256k1-blake160 for custody/change cells)
- **`getMinimumNativeToken`**: Return the minimum CKB required to transfer assets, accounting for cell capacity (see [Lock Scripts](#lock-scripts))
- **`isTransactionInSign`**: Check if the signer service is still processing a transaction
- **`isTxInMempool`**: Check if a transaction is in the mempool
- **`PaymentTransactionFromJson`**: Deserialize a `PaymentTransaction` from JSON
- **`serializeTx`** (protected): Serialize a CKB transaction to string for the Rosen extractor
- **`boxSelection`** (protected property): `AbstractBoxSelection<CkbUtxo>` implementation for UTXO selection during transaction construction

**TSS signing:** CKB is wired as another ECDSA TSS chain, identical to how Bitcoin, Ethereum, Doge, and Binance are wired in [chainHandler.ts](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/chainHandler.ts). The existing [TssSigner](https://github.com/rosen-bridge/sign-protocols/blob/dev/packages/tss/lib/tss/tssSigner.ts) and [tss-api](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api) infrastructure handles everything: 4-message approval protocol, MPC signing via [BNB tss-lib](https://github.com/bnb-chain/tss-lib), and signature caching. No new signing package is needed. See [guard rotation with TSS](./guard-signing/tss.md) for keygen, rotation, and asset migration details.

**Signing flow:** `CkbChain` computes the `sighash_all` (a blake2b digest over the transaction hash and witnesses, via CCC's `Transaction.getSignHashInfo()`) for each script group and submits it to the TSS signer. The Go binary runs the MPC protocol with other guards, producing a standard 65-byte recoverable ECDSA signature per sighash. The signature is placed in `WitnessArgs.lock`. Key derivation uses BIP-44 path `m/44'/309'/0'` via the existing ECDSA TSS `DerivingPubkeyFromPath()` mechanism.

#### 5d. Abstract Chain Network

**Package:** `@rosen-chains/ckb-rpc`

| Component | Class                                        |
| --------- | -------------------------------------------- |
| Network   | `CkbRpcNetwork` extends `AbstractCkbNetwork` |

Implements the network interface using CKB JSON-RPC. The Rosen Bridge testbed uses zero-value test tokens on CKB mainnet (not testnet), so all code targets mainnet from the start. System script references (xUDT, default lock, ACP) should be configurable, since deployment hashes may differ across networks.

Abstract network methods (from `AbstractChainNetwork` and `AbstractUtxoChainNetwork`):

- `getHeight`: Get current blockchain height
- `getTxConfirmation`: Get confirmation count for a transaction (or -1 if not found)
- `getAddressAssets`: Get CKB and xUDT balances at an address
- `getBlockTransactionIds`: Fetch the IDs of all transactions in a block
- `getBlockInfo`: Get block header info (hash, height, parent hash)
- `getTransaction`: Fetch a specific transaction by hash
- `submitTransaction`: Send a signed transaction
- `getMempoolTransactions`: Get pending transactions from the tx pool
- `getTokenDetail`: Get xUDT token name and decimals
- `getActualTxId`: Map a transaction hash to its canonical ID (identity on CKB)
- `getAddressBoxes`: Query live cells at an address (via CKB indexer RPC)
- `isBoxUnspentAndValid`: Check if a cell is still unspent and valid

Additional methods for `CkbChain` (not in base classes):

- `getUtxo`: Get a specific live cell by OutPoint (common UTXO chain pattern, also defined by Bitcoin, Cardano, and Doge abstract networks)
- `getAcpCells`: Query bridge-owned ACP cells for xUDT deposit management (CKB-specific)

### Phase 6: Health Check

**Repo:** [health-check](https://github.com/rosen-bridge/health-check) | **Package:** `@rosen-bridge/asset-check`

| Component   | Class                         |
| ----------- | ----------------------------- |
| Asset check | `CkbRpcAssetHealthCheckParam` |

Monitors CKB and xUDT balances at the bridge guard address via CKB RPC, ensuring guards have sufficient CKB to pay transaction fees.

### Phase 7: Service Integration

Wiring modules into the main services.

#### Watcher Service

**Repo:** [watcher](https://github.com/rosen-bridge/watcher)

- Add `CkbConfig` class with RPC URL, initial scan height, and scan interval
- Initialize `CkbRpcScanner` and `CkbRpcObservationExtractor` in scanner creation
- Register scanner sync health check for CKB
- Add default configuration in `default.yaml`

#### Guard Service

**Repo:** [guard-service](https://github.com/rosen-bridge/guard-service)

- Add `GuardsCkbConfigs` with bridge address, cold address, RPC URL, confirmation counts (observation, payment, cold, manual, arbitrary), system script hashes (xUDT, default lock, ACP), `tssChainCode`, and `derivationPath` per network
- Wire CKB as an ECDSA TSS chain in `chainHandler.ts` via [`wrapCurveSignMediator()`](https://github.com/rosen-bridge/guard-service/blob/dev/services/guard-service/src/handlers/tssHandler.ts)
- Initialize `CkbChain` with `CkbRpcNetwork` in chain handler
- Register asset health check for CKB and scanner sync health check (`ScannerSyncHealthCheckParam`)
- Add CKB to `SUPPORTED_CHAINS` and `ChainNativeToken` at index 9
- Add default configuration in `default.yaml` (including `ckb.tssChainCode` and `ckb.derivationPath`)

### Phase 8: UI

**Repo:** [ui](https://github.com/rosen-bridge/ui)

- Add CKB chain icon, constants, and address/token/tx URL helpers
- Implement `@rosen-network/ckb` package with lock transaction generation via CCC (constructing RFC 0026 ACP deposit transactions for both xUDT and native CKB, with metadata in cell data)
- Add CCC-based wallet integration (JoyID and other CKB-compatible wallets)
- Configure asset calculator for CKB
- Wire CKB scanner and extractors into Rosen Service

### Phase 9: Contracts

**Repo:** [contract](https://github.com/rosen-bridge/contract)

Handled by the Rosen Bridge team:

- Mint CKB bridge config tokens on Ergo (RWT, AWC)
- Register CKB native token and xUDT bridge tokens on Ergo
- Deploy bridged token xUDT cells on CKB using single-use lock (mint full supply, destroy mint key)
- Deploy RFC 0026 ACP cells for each bridged xUDT (`blake160(tss_shared_pubkey)` as lock args, with `min_ckb` and `min_udt` bytes). Each cell must carry enough CKB for its structure plus the largest expected metadata payload (144 base + 75 bytes for Cardano addresses = 219 CKB minimum)
- Audit target ecosystem xUDT tokens (iCKB, SEAL, etc.) before registration (see [Token Support](#token-support) for bridgeability and freeze exclusion criteria)

## Delivery Timeline

| Phase | Module                                    | Target     |
| ----- | ----------------------------------------- | ---------- |
| 1-4   | Scanner, Address Codec, Extractors        | Q2 2026    |
| 5-6   | Rosen Chain, Health Check                 | Q2 2026    |
| 7     | Service Integration (Watcher + Guard)     | Q2-Q3 2026 |
| 8     | UI                                        | Q3 2026    |
| 9     | Contracts (Rosen team)                    | Q3 2026    |
| .     | Testbed deployment                        | Q2-Q3 2026 |
| .     | Mainnet release (external audit optional) | Q3-Q4 2026 |

## References

- [Grant Proposal (DIS)](https://talk.nervos.org/t/dis-ckb-integration-for-rosen-bridge/9756)
- [Bridge Expansion Kit (RCS-003)](https://github.com/rosen-bridge/rcs/tree/master/rcs-003)
- [Rosen Contribution Standards](https://github.com/rosen-bridge/rcs)
- [Rosen Sign Protocols](https://github.com/rosen-bridge/sign-protocols)
- [tss-api (Go MPC binary)](https://github.com/rosen-bridge/sign-protocols/tree/dev/services/tss-api)
- [BNB tss-lib](https://github.com/bnb-chain/tss-lib)
- [CCC SDK](https://github.com/ckb-devrel/ccc)
- [CKB Address Format (RFC 0021)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0021-ckb-address-format/0021-ckb-address-format.md)
- [xUDT Standard (RFC 0052)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0052-extensible-udt/0052-extensible-udt.md)
- [xUDT Implementation (xudt_rce.c)](https://github.com/nervosnetwork/ckb-production-scripts/blob/master/c/xudt_rce.c)
- [sUDT Standard (RFC 0025)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0025-simple-udt/0025-simple-udt.md)
- [secp256k1-blake160-sighash-all (default lock)](https://github.com/nervosnetwork/ckb-system-scripts/blob/master/c/secp256k1_blake160_sighash_all.c)
- [Anyone-Can-Pay Lock (RFC 0026)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md)
- [Omnilock (RFC 0042)](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0042-omnilock/0042-omnilock.md)
- [Single-Use Lock](https://github.com/ckb-devrel/ckb-proxy-locks/tree/main/contracts/single-use-lock)
- [RGB++ Security Analysis](https://github.com/utxostack/RGBPlusPlus-design/blob/main/docs/security-analysis-en.md)
- [Guard rotation: multi-sig](./guard-signing/multisig.md)
- [Guard rotation: TSS](./guard-signing/tss.md)
- [Signing approach comparison](./guard-signing/comparison.md)
