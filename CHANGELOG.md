# Changelog

## [Unreleased]

## 0.2.6 (2026-05-25)

### Breaking changes

- **`Agreement.nodes` is now `AgreementNode[]` instead of `string[]`** — each entry is now `{ node_id: string; status: "valid" | "failed" }` instead of a bare node ID string. Consumers iterating `agreement.nodes` must update to `.node_id` for the ID and may now inspect `.status` to distinguish nodes whose `join_agreement` op was rejected on-chain.
- **`DEFAULT_GAS_LIMIT` removed** — this constant and its re-export are gone. The new signing format (`PaymentIntent::Sponsored`) does not include a gas limit field; the Portal pays gas as publisher-sponsor.

### Features

- **New exported type `AgreementNode`** — `{ node_id: string; status: "valid" | "failed" }`.
- **`Agreement.status` now includes `"failed"`** — replaces `"completed"` in the union, matching the server's `AgreementStatus` (`pending | ready | confirmed | failed`). A `failed` agreement means the Bitcoin transaction was confirmed but the Kontor `create_agreement` op did not land.

### Fixes

- **`getSignerInfo` treats `next_nonce: null` as `0`** — Kontor returns `null` until the signer's first op is processed. The client now coalesces explicitly (`?? 0`), matching Horizon-Portal's `nonces.rs` `unwrap_or(0)`, instead of relying on JavaScript coercion.
- **`waveEscapeString` now escapes ASCII control characters as `\xNN`** — parity with Rust `wave_escape_string` in `kontor_op.rs` (previously only `\` and `"` were escaped).
- **Signer lookup now hits `GET /api/signers/{identifier}` instead of the removed `/api/registry/entry/{...}`** — Horizon-Portal renamed the registry proxy route on 2026-05-13 (server commit `7f8eb71`). The old path returns 404, which `getSignerInfo` then surfaced as `PortalNotFoundError`, making `login()` fall through to `registerInternal()` and fail with `409 Conflict` whenever the user already existed. The new path accepts the same three identifier formats (numeric `signer_id`, x-only pubkey hex, Bitcoin address) so call sites are unchanged.
- **Registration message: x-only pubkey is now emitted as a postcard tuple (32 raw bytes, no length prefix)** — `buildRegistrationMessage` previously length-prefixed the `XOnlyPublicKey` bytes (`0x20 || 32 bytes`), which did not match the Rust `secp256k1::XOnlyPublicKey` serde implementation. Postcard serializes that type as `tuple(32)` of `u8` — raw bytes, no varint length tag. The extra prefix byte shifted every downstream field by one in the canonical signing message, so the BLS signature verified against different bytes than the Portal reconstructed, causing every `POST /api/users/register` to fail with `REGISTRATION_SIGNATURE_VERIFICATION_FAILED`. `buildCreateAgreementMessage` is unaffected (it uses `SignerClaim::Id(u64)`, not `PubKey`).
- **Registration message now encodes x-only pubkey as 32 raw bytes** — `buildRegistrationMessage` previously encoded the x-only public key as a 64-character hex ASCII string. It now encodes it as 32 raw bytes (with postcard-compatible length prefix), matching the Rust `SignerClaim::PubKey(XOnlyPublicKey)` non-human-readable serde representation.
- **Signing message format updated to `(SignerClaim, nonce, Inst)` tuple** — both `buildRegistrationMessage` and `buildCreateAgreementMessage` now emit `KONTOR-OP-V1 || postcard((claim, nonce, Inst { payment, kind }))`, matching the Rust `Inst::aggregate_signing_message`. The old format used a legacy `BlsBulkOp` wrapper with an embedded `gas_limit` field that no longer exists in the protocol.
- **BLS public key type corrected to G2** — `SignerInfo.blsPubkey` doc comment updated from G1 to G2 (192 hex chars = 96 bytes), matching the Portal API and Kontor registry.

### Documentation

- **README** — `getSignerInfo` docs updated to reference `GET /api/signers/{identifier}` (replacing the removed `/api/registry/entry/...` path) and to describe `blsPubkey` as G2 (192 hex chars), not G1.

## 0.2.5 (2026-05-13)

### Features

- **`UploadOptions.nft`** — new optional payload on `uploadFile` that mints a Kontor NFT in the same Bitcoin operation as the agreement creation. When `nft` is set, the BLS signature is built over the NFT contract's `mint(nft_id, attributes, file_descriptor)` entrypoint instead of `create-agreement(...)`, and the on-chain `agreement_id` equals the `file_id`. The Portal creates an `nft_mints` row in the same database transaction as the agreement, mirroring its status (`ready` → `pending` → `confirmed`, or `failed`). Shape: `{ nftId: string; attributes?: Array<{ key: string; value: string }> }` — `attributes` defaults to `[]` and order is preserved end-to-end.
- **`KontorPortalClientConfig.kontorNftContractAddress`** — new optional config field for the Kontor NFT contract address used by NFT mints. Defaults to `"nft_0_0"`. Set at client init only; not overridable per call.
- **`buildMintNftExpr` exported helper** — builds the WAVE expression for the NFT contract's `mint(...)` entrypoint. Byte-for-byte parity with the Rust `build_mint_nft_expr` in `kontor_op.rs` so Portal-side BLS verification can reconstruct the exact signed string.
- **New exported types** — `NftAttribute`, `NftMintRequest`.

### Fixes

- **WAVE string escaping in `create-agreement(...)` and `mint(...)` exprs** — `file-id`, `object-id`, and `filename` are now escaped (`\` → `\\`, `"` → `\"`) before being interpolated into the signed WAVE expression, matching the Rust `wave_escape_string` helper in `kontor_op.rs`. Without this, filenames or file IDs containing `"` or `\` produced a malformed expression that Portal-side BLS verification rejected. Pure client-side fix; no Portal change required.
- **Upload initiation now surfaces the Portal's structured error message** — `POST /api/files` failures previously threw `Error("Upload initiation failed: <status> <body>")`, leaking the raw response body into the message. They now flow through the same response-parsing path as the rest of the client: when the Portal returns a JSON envelope (`{ error: { message } }` or `{ error: <string> }`), the thrown `Error.message` is the Portal-supplied message; otherwise it falls back to `Upload initiation failed (<status>)`. Existing `try/catch` on the thrown error keeps working.

## 0.2.4 (2026-05-11)

### Features

- **`Agreement.thumbnail_url`** — new optional string field on `Agreement` exposing a 400×400 preview asset for the file. Either a short-lived GCS V4 signed URL (auto-generated `*.thumb.jpg` for raster images, `*.thumb.svg` placeholder for other MIME types) or the public SVG fallback at `GET /api/thumbnails/fallback?filename=<filename>` for legacy rows or thumbnail-generation failures. Optional because older Portal deployments without thumbnail support omit this field — guard against `undefined` before use. Intended for previews only — does not replace `getDownloadUrl()` / `downloadFile()` for the original file bytes. Requires the Portal-side thumbnail support (`apiary.apib` "Thumbnails" change).

## 0.2.3 (2026-04-29)

### Fixes

- **`HorizonWalletSigner.getAddress()` falls back to inferring the network from the Taproot address prefix** — older Horizon Wallet builds (and any custom wallet implementation) whose `getAddresses` RPC response omits or returns an unrecognized `network` field no longer break `client.login()`. When the wallet-supplied `network` is missing or not in `["mainnet", "testnet4", "signet"]`, the signer infers it from the bech32m HRP on the returned p2tr address (`bc1p…` → `"mainnet"`, `tb1p…` → `"signet"`, mirroring `KontorPortalClient.toWalletNetwork`'s testnet→signet default). The wallet-supplied `network` is still preferred when it is one of the known values, and the subsequent `walletNetwork` mismatch check in `login()` still protects against accidentally talking to the wrong network. The signer still throws `"Wallet did not return a valid network"` when both the supplied `network` and the address prefix are unrecognized (e.g. `bcrt1p…` regtest).
- **React hook `login()` re-throws on failure** — the `login` callback returned by `usePortalClient()` now re-throws the underlying error after setting `status: "error"` / `error: <message>`, instead of resolving silently. Consumers awaiting `login()` can now `try/catch` the failure directly without also subscribing to `status`/`error`. Reactive consumers reading `status`/`error` keep working unchanged.

## 0.2.2 (2026-04-29)

### Fixes

- **`getSignerInfo()` now exposes `xOnlyPubkey` and `blsPubkey`** — fields are read from the registry response (`x_only_pubkey`, `bls_pubkey`) and surfaced on `SignerInfo`. `blsPubkey` is `null` when the registry entry has no bound BLS key. `getSignerInfo()` now throws when `x_only_pubkey` is missing from the response (the field is always present in well-formed Portal responses).
- **`UnifiedLoginResult` now always carries `xOnlyPubkey` and `blsPubkey`** — populated from the registration payload on the auto-register path and from the registry lookup on the already-registered path. Callers no longer need to make a follow-up `getSignerInfo()` call (or persist `xOnlyPubkey` themselves at registration time) to obtain the value required by `UploadOptions.xOnlyPubkey`.
- **React hook persists `xOnlyPubkey` / `blsPubkey` on the already-registered path** — fixes a regression where a fresh browser session (no `localStorage`) on an already-registered wallet would leave `xOnlyPubkey` `null`, breaking the next `uploadFile()` call. The hook now writes both fields to `localStorage` after every successful `login()`, regardless of whether registration was performed.

## 0.2.1 (2026-04-28)

### Features

- **`InBrowserCustomSigner`** — new browser-friendly `BLSSigner` implementation that derives a Taproot key + a BLS12-381 G1 (min-sig) key entirely in-process from either a BIP-39 seed (Horizon-Wallet parity, same EIP-2333 derivation) or a single 32-byte secp256k1 private key (Web3Auth / social wallets). In the private-key branch the BIP-32 chain code is synthesized deterministically (`HMAC-SHA512("KONTOR-WEB3AUTH-CHAINCODE-V1", privateKey)`) so the resulting `xpub` stays compatible with Portal. All keys are pre-derived in the constructor; `getAddress`, `getBLSPoP`, and `signBLS` only return cached values plus a fresh BLS signature when needed.
- **`/bls` subpath export** — new `@unspendablelabs/kontor-portal-client/bls` entry point exposing portable BLS primitives (`KONTOR_BLS_DST`, `deriveMasterSK`, `deriveBlsKey`, `sign`, `getPublicKey`, `signBlsBinding`, `schnorrBindingHash`). Direct port of `Horizon-Wallet/tool/bls-entry.js`, names matching byte-for-byte.
- **`NonceProvider.setNonce(signerId, nonce)`** — new optional method on the `NonceProvider` interface. `login()` calls it after the registry lookup to force-overwrite the local "last used" tracker with the Portal's authoritative `next_nonce`. Resyncs across tabs/sessions where the local state may be stale (e.g. another tab advanced the nonce, or a persistent provider holds a value ahead of the chain). `InMemoryNonceProvider` implements it. Existing custom providers without `setNonce` keep working unchanged (the call site uses optional chaining).
- **`SignerInfo.chainNonce`** — new field exposing the raw `next_nonce` value returned by `GET /api/signers/{identifier}` (coalesced to `0` when the Portal returns `null`), alongside the existing `nextNonce` (which remains the post-`NonceProvider` effective value).
- **New exported types** — `InBrowserCustomSignerConfig`.

### Dependencies

- **New optional peer dependencies** — `@noble/curves@^2.0.0` and `@noble/hashes@^2.0.0`. Only required when using `InBrowserCustomSigner` or the `/bls` subpath export; existing consumers using only `HorizonWalletSigner` are unaffected.

## 0.2.0 (2026-04-27)

### Breaking changes

- **`BLSSigner.getAddress()` is now required.** The interface gains a `getAddress(): Promise<WalletAddress>` method that returns the active Taproot (p2tr) address along with the wallet's current network (`"mainnet"` | `"testnet4"` | `"signet"`). Custom signer implementations must add this method. `HorizonWalletSigner` implements it via the `getAddresses` RPC and filters for `p2tr` addresses.
- **`client.register(taprootAddress, options?)` removed.** Use `client.login(options?)` — it auto-registers when needed and returns the registration data on `result.registration`.
- **`client.login(userId, address, options?)` removed.** The new `login()` takes a single optional `UnifiedLoginOptions` argument (or no argument). It calls `signer.getAddress()` to resolve the address, looks up the registry, and either logs in or auto-registers.
- **React hook `saveRegistration` removed.** `login()` persists registration data automatically when a registration was performed.
- **`PortalAuthStatus` no longer includes `"needs_registration"`.** `login()` handles registration on demand, so the React hook goes directly to `"needs_login"`.
- **Removed exports** — `RegisterStep`, `RegisterOptions`, `LoginStep`, `LoginOptions`. These were only useful for the removed entry points; use `UnifiedLoginStep` / `UnifiedLoginOptions` instead.

### Features

- **`client.login(options?)`** — auto-detects whether the wallet is registered with the Portal and either logs in directly or runs registration on the fly. Returns `UnifiedLoginResult` with an `address` field (the Taproot address used for the login — either `options.address` or the wallet-resolved one) and a `registration` field that is `null` when the user was already registered, or the registration payload when a new registration was performed during the call.
- **`client.detectWalletNetwork()`** — reads the wallet's network via `getAddress()` and compares it with the client's configured `walletNetwork`. Returns `{ walletNetwork, clientNetwork, matches }`.
- **`NetworkMismatchError`** — thrown by `login()` (when `options.address` is omitted) if the wallet's reported network differs from the client's configured `walletNetwork`. Surfaces the mismatch before any Portal request.
- **`KontorPortalClientConfig.walletNetwork`** — explicit override for the wallet-side network identifier. When omitted, derived from `network` (`networks.bitcoin` → `"mainnet"`, anything else → `"signet"`). Set explicitly when targeting `"testnet4"` since bitcoinjs-lib's `testnet` cannot disambiguate testnet3/testnet4/signet.
- **`SignerInfo.userId`** — present when the registry entry resolves to a `users` row. `login()` uses it to decide between login and register paths. Requires backend support (Portal returns `user_id` in `GET /api/signers/{identifier}` when the identifier matches a registered user).
- **New exported types** — `WalletNetwork`, `WalletAddress`, `UnifiedLoginStep`, `UnifiedLoginOptions`, `UnifiedLoginResult`.

### Migration guide

```diff
- const reg = await client.register("bc1p...");
- const { jwt } = await client.login(reg.userId, "bc1p...");
+ const result = await client.login();
+ if (result.registration) {
+   // First login: persist registration fields if you need them locally
+ }
+ const jwt = result.jwt;
```

If you don't want `login()` to call `signer.getAddress()` (e.g. you already have the address cached and want to avoid the extra wallet round-trip and network check), pass it explicitly:

```ts
await client.login({ address: "bc1p..." });
```

## 0.1.1 (2026-04-21)

### Features

- **`downloadFile(agreementId, options?)`** — convenience wrapper that resolves the download URL and fetches the file as a `Blob`.
- **`getDownloadUrl(agreementId, options?)`** — resolves a signed GCS URL (when `ready`) or storage node URL (when `confirmed`) via `GET /api/agreements/{id}/download?no_redirect=true`. Supports `forceDownload` to set `Content-Disposition: attachment`.
- **`listAgreements()` filtering & sorting** — new options: `status` (string or array, pipe-serialized), `users`, `nodes`, `mimeType`, `sort` (`created_at` | `size` | `filename`), and `sortDir` (`asc` | `desc`).
- **On-chain fields on `Agreement`** — added nullable `txid` (Bitcoin transaction id, hex), `block_height`, and `block_time` (Unix seconds). Internal `transaction_id` (UUID) kept for backward compatibility.
- **New exported types** — `DownloadFileOptions`, `DownloadUrlResult`.

### Changes

- `getAgreement()` and `listAgreements()` now hit the public endpoints directly (no JWT required); any stored JWT is ignored for these calls.

## 0.1.0 (2026-04-13)

Initial public release.

### Features

- **KontorPortalClient** — framework-agnostic TypeScript client for Kontor Portal
  - BLS-backed registration (proof of possession)
  - Challenge-response login with JWT management
  - Authenticated file upload with Reed–Solomon encoding, Merkle roots, and chunked PUT uploads
  - `healthCheck()`, `getAgreement()`, `listAgreements()` API helpers
- **HorizonWalletSigner** — `BLSSigner` implementation for the Horizon Wallet browser extension
- **EIP-2334 key derivation** — BLS child key derived at `m/12381/{coinType}/{account}/0`
- **Custom adapters** — pluggable `BLSSigner`, `KontorCryptoProvider`, and `NonceProvider` interfaces
- **React bindings** (`kontor-portal-client/react`)
  - `PortalClientProvider` context provider
  - `usePortalClient()` hook with auth state management and `localStorage` persistence
- **WASM crypto support** — `createCryptoProvider()` helper for `@kontor/kontor-crypto` integration
- **InMemoryNonceProvider** — default nonce tracking to avoid nonce reuse across uploads
- **Progress callbacks** — `onStep`, `onPrepareProgress`, and `onUploadProgress` for all flows
