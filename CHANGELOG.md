# Changelog

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
