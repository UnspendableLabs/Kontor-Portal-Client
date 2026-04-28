# Changelog

## Unreleased

### Features

- **`NonceProvider.setNonce(signerId, nonce)`** — new optional method on the `NonceProvider` interface. `login()` calls it after the registry lookup to force-overwrite the local "last used" tracker with the Portal's authoritative `next_nonce`. Resyncs across tabs/sessions where the local state may be stale (e.g. another tab advanced the nonce, or a persistent provider holds a value ahead of the chain). `InMemoryNonceProvider` implements it. Existing custom providers without `setNonce` keep working unchanged (the call site uses optional chaining).
- **`SignerInfo.chainNonce`** — new field exposing the raw `next_nonce` value returned by `/api/registry/entry`, alongside the existing `nextNonce` (which remains the post-`NonceProvider` effective value).

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
- **`SignerInfo.userId`** — present when the registry entry resolves to a `users` row. `login()` uses it to decide between login and register paths. Requires backend support (Portal returns `user_id` in `GET /api/registry/entry/{pubkey_or_id}`).
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
