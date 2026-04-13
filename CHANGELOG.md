# Changelog

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
