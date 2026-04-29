# Kontor Portal Client

[![CI](https://github.com/UnspendableLabs/Kontor-Portal-Client/actions/workflows/ci.yml/badge.svg)](https://github.com/UnspendableLabs/Kontor-Portal-Client/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/UnspendableLabs/Kontor-Portal-Client/graph/badge.svg?token=HbSf99y0yG)](https://codecov.io/gh/UnspendableLabs/Kontor-Portal-Client)
[![npm version](https://img.shields.io/npm/v/@unspendablelabs/kontor-portal-client.svg)](https://www.npmjs.com/package/@unspendablelabs/kontor-portal-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

## Overview

`KontorPortalClient` is a framework-agnostic TypeScript client for Kontor Portal. It handles BLS-backed registration (proof of possession), challenge-response login, and authenticated file upload with Reed–Solomon encoding parameters, Merkle roots, and chunked PUT uploads.

The client uses dependency injection for the wallet signer (`BLSSigner`) and for file preparation (`KontorCryptoProvider`), so you can swap Horizon Wallet for another implementation or test doubles.

## Installation

```bash
npm install @unspendablelabs/kontor-portal-client @kontor/kontor-crypto
```

Peer dependencies (install if not already present):

```bash
npm install bip32 @bitcoinerlab/secp256k1 bitcoinjs-lib
```

For React bindings, also install React 18+.

`@kontor/kontor-crypto` is optional — you can skip it if you provide your own `KontorCryptoProvider` (see [Custom adapters](#kontorcryptoprovider)).

`@noble/curves` and `@noble/hashes` are optional peer dependencies, only required when using `InBrowserCustomSigner` or the `/bls` subpath export:

```bash
npm install @noble/curves @noble/hashes
```

## Setup

```typescript
import { KontorPortalClient } from "@unspendablelabs/kontor-portal-client";

const client = new KontorPortalClient({
  portalHost: "https://portal.example.com",
});
```

All other config fields are optional with sensible defaults (signet network, Horizon Wallet signer, WASM crypto, `filestorage_0_0` contract). Override any of them as needed:

```typescript
import { KontorPortalClient } from "@unspendablelabs/kontor-portal-client";
import { networks } from "bitcoinjs-lib";

const client = new KontorPortalClient({
  portalHost: "https://portal.example.com",
  network: networks.bitcoin, // default: signet (testnet)
  walletNetwork: "mainnet", // default: derived from `network` (mainnet | signet)
  kontorContractAddress: "my_contract", // default: "filestorage_0_0"
  // signer: myCustomSigner, // default: new HorizonWalletSigner()
  // crypto: myCustomCrypto, // default: WASM via @kontor/kontor-crypto
  // wasmUrl: "/custom/path/index.js", // default: "/kontor-crypto/index.js"
  // nonceProvider: myNonceProvider, // default: new InMemoryNonceProvider()
});
```

### `walletNetwork`

`walletNetwork` is the wallet-side network identifier (`"mainnet"`, `"testnet4"`, or `"signet"`) that the client expects from the connected wallet. When omitted, it is derived from `network`:

| `network`              | Derived `walletNetwork` |
| ---------------------- | ----------------------- |
| `networks.bitcoin`     | `"mainnet"`             |
| anything else (default `networks.testnet`) | `"signet"` |

Set `walletNetwork: "testnet4"` explicitly when targeting testnet4 — bitcoinjs-lib's `networks.testnet` covers testnet3/testnet4/signet (same bech32 parameters), so the default mapping cannot disambiguate.

## Quick start

The unified `login()` method auto-detects whether the wallet is registered with the Portal and runs registration on the fly when needed. Each step supports optional progress callbacks.

```typescript
// One call: register if needed + login. Returns the JWT and (when the user
// was just registered) the registration data. The JWT is also stored on the
// client for subsequent authenticated requests.
const result = await client.login({
  onStep: (step) => console.log("Login step:", step),
});

if (result.registration) {
  console.log("Registered new user:", result.registration.userId);
}

// Upload a file. `result.xOnlyPubkey` is always populated (sourced from
// the registration on the new-user path, or from the registry lookup on
// the already-registered path), so you never have to call
// getSignerInfo() yourself just to get this value.
const uploadResult = await client.uploadFile(file, {
  xOnlyPubkey: result.xOnlyPubkey,
  tags: ["document", "contract"],
  onStep: (step) => console.log("Upload step:", step),
  onPrepareProgress: (progress, phase) => {
    console.log(`${phase}: ${Math.round(progress * 100)}%`);
  },
  onUploadProgress: (uploaded, total) => {
    console.log(`Upload: ${Math.round((uploaded / total) * 100)}%`);
  },
});
```

`uploadFile` requires a prior successful `login()` (or a JWT set with `setJwt`) because uploads use authenticated portal APIs.

### Network validation

`login()` calls `signer.getAddress()` and validates the wallet's reported network against `walletNetwork`. On mismatch it throws `NetworkMismatchError` before any Portal request:

```typescript
import { NetworkMismatchError } from "@unspendablelabs/kontor-portal-client";

try {
  await client.login();
} catch (err) {
  if (err instanceof NetworkMismatchError) {
    console.error(
      `Wallet on ${err.walletNetwork}, client expects ${err.clientNetwork}.`,
    );
  }
}
```

You can also probe the wallet network without triggering a login flow:

```typescript
const { walletNetwork, clientNetwork, matches } =
  await client.detectWalletNetwork();
```

If you already know the address and want to skip the wallet round-trip (and the network check), pass `address` directly:

```typescript
await client.login({ address: "bc1p..." });
```

## API reference

### `login(options?)`

- **Signature:** `login(options?: UnifiedLoginOptions): Promise<UnifiedLoginResult>`
- **Description:** Unified flow that detects whether the wallet is registered with the Portal and either logs in directly or runs registration first. Stores the resulting JWT on the client.
- **Parameters:**
  - `options?.address` — Taproot address. When omitted, the signer's `getAddress()` is called and the returned network is validated against the client's configured `walletNetwork`.
  - `options?.onStep` — Called with `UnifiedLoginStep` names (see [Progress callbacks](#progress-callbacks)).
- **Returns:** `UnifiedLoginResult` extending `LoginResult` with:
  - `address` — Taproot address used for the login (either `options.address` or the wallet-resolved address).
  - `xOnlyPubkey` — x-only pubkey of the signer that just logged in. Always populated (sourced from the registration on the new-user path, or from the registry lookup on the already-registered path). Use this directly as `UploadOptions.xOnlyPubkey` — no follow-up `getSignerInfo()` round-trip required.
  - `blsPubkey` — BLS public key of the signer. Same lifecycle as `xOnlyPubkey`. `null` only when the registry entry has no bound BLS key (should not happen for users that completed `client.login()`).
  - `registration` — `null` when the user was already registered, or a `RegistrationResult` (`userId`, `xOnlyPubkey`, `blsPubkey`, `xpubkey`) when a registration was performed during this call.
- **Throws:** `NetworkMismatchError` when the wallet network does not match the client's configured `walletNetwork` (only when `options.address` is omitted).

### `detectWalletNetwork()`

- **Signature:** `detectWalletNetwork(): Promise<{ walletNetwork: WalletNetwork; clientNetwork: WalletNetwork; matches: boolean }>`
- **Description:** Calls `signer.getAddress()` and reports whether the wallet's network matches the client's configured `walletNetwork`. Useful for surfacing a clear error to the user before initiating a login flow.

### `getSignerInfo(idOrPubkeyOrAddress)`

- **Signature:** `getSignerInfo(idOrPubkeyOrAddress: string): Promise<SignerInfo>`
- **Description:** Looks up the signer in the portal registry and returns signer id and next nonce. If a `nonceProvider` is configured, `nextNonce` may be adjusted by `getNextNonce`.
- **Parameters:**
  - `idOrPubkeyOrAddress` — Any identifier accepted by `GET /api/registry/entry/{pubkey_or_id}`:
    - a numeric Kontor `signer_id` (e.g. `"0"`),
    - an x-only public key in hex (64 hex chars), or
    - a Bitcoin address registered with the Portal (via `login()` or node registration).
- **Returns:** `SignerInfo` — `{ signerId: number; nextNonce: number; chainNonce: number; userId?: string; xOnlyPubkey: string; blsPubkey: string | null }`.
  - `nextNonce` — effective nonce after `NonceProvider.getNextNonce` arbitration.
  - `chainNonce` — raw value returned by the Portal registry (Portal-authoritative, used by `login()` to resync the local nonce tracker).
  - `userId` — present when the registry entry resolves to a `users` row (lookup by Bitcoin address or x-only pubkey of a registered user).
  - `xOnlyPubkey` — 64-char hex x-only public key of the signer, as recorded by Kontor. Always present.
  - `blsPubkey` — BLS12-381 G1 public key (hex), or `null` when the registry entry has no bound BLS key (e.g. some node entries before `register_bls_key`).
- Sends `Authorization` when a JWT is present. Throws `PortalNotFoundError` on 404 (e.g. address not registered). Throws a generic error when the registry response is malformed (missing `x_only_pubkey`).

### `uploadFile(file, options)`

- **Signature:** `uploadFile(file: File, options: UploadOptions): Promise<UploadResult>`
- **Description:** Prepares the file (RS params, Merkle metadata), fetches signer info, signs the create-agreement message, initiates the upload session, uploads in chunks, optionally validates the session, and optionally reports nonce usage.
- **Parameters:**
  - `file` — Browser `File` to upload.
  - `options.xOnlyPubkey` — Signer x-only pubkey for registry lookup.
  - `options.address` — Taproot address used for BLS key derivation (recommended when using Horizon Wallet).
  - `options.tags` — Optional string tags for the file.
  - `options.onStep`, `options.onPrepareProgress`, `options.onUploadProgress` — See [Progress callbacks](#progress-callbacks).
- **Returns:** `UploadResult` with `sessionId`, `fileId`, `merkleRoot`, `filename`, and `size`.

### `getAgreement(agreementId)`

- **Signature:** `getAgreement(agreementId: string): Promise<Agreement>`
- **Description:** GETs a single agreement by ID. **Public endpoint** — no JWT required (you do not need to call `setJwt()` first; any stored JWT is ignored for this call).
- **Parameters:**
  - `agreementId` — The agreement ID to fetch.
- **Returns:** `Agreement` (see fields below, including on-chain `txid`, `block_height`, `block_time`). Throws if not found (404) or on other errors.

### `listAgreements(options?)`

- **Signature:** `listAgreements(options?: ListAgreementsOptions): Promise<AgreementsResponse>`
- **Description:** GETs paginated agreements with optional filtering and sorting. **Public endpoint** — no JWT required.
- **Parameters:**
  - `options?.limit` — Page size (default 20).
  - `options?.offset` — Offset (default 0).
  - `options?.status` — Filter by status. Pass a single string (e.g. `"ready"`) or an array (e.g. `["ready", "pending"]`) which is serialized as a pipe-separated value (`status=ready|pending`).
  - `options?.users` — Array of user IDs, serialized as a comma-separated list.
  - `options?.nodes` — Array of node IDs, serialized as a comma-separated list.
  - `options?.mimeType` — MIME type filter (sent as `mime_type`).
  - `options?.sort` — Sort field: `"created_at"` (default on the server), `"size"`, or `"filename"`.
  - `options?.sortDir` — Sort direction: `"asc"` or `"desc"` (sent as `sort_dir`).
- **Returns:** `AgreementsResponse` with `offset`, `limit`, `total`, and `agreements[]`.

The `Agreement` type includes the on-chain fields `txid` (Bitcoin transaction id, hex), `block_height`, and `block_time` (Unix timestamp in seconds). All three are nullable until the agreement is confirmed on-chain. The internal `transaction_id` (UUID) remains available for backward compatibility.

### `getDownloadUrl(agreementId, options?)`

- **Signature:** `getDownloadUrl(agreementId: string, options?: DownloadFileOptions): Promise<DownloadUrlResult>`
- **Description:** Resolves the download URL for an agreement file via `GET /api/agreements/{agreement_id}/download?no_redirect=true`. The URL is a signed Google Cloud Storage URL when the agreement is `ready`, or a storage node URL when `confirmed`. **Public endpoint** — no JWT required.
- **Parameters:**
  - `agreementId` — The agreement ID to download.
  - `options?.forceDownload` — When `true`, sends `force_download=true` so the resulting URL serves with `Content-Disposition: attachment`.
- **Returns:** `{ downloadUrl: string }`. Throws `PortalNotFoundError` on 404, or a generic error with the server message for other failures (e.g. `403` when the agreement is not yet downloadable, `503` when no storage node is available).

### `downloadFile(agreementId, options?)`

- **Signature:** `downloadFile(agreementId: string, options?: DownloadFileOptions): Promise<Blob>`
- **Description:** Convenience wrapper that calls `getDownloadUrl()` and then fetches the resulting URL, returning the file content as a `Blob`. Use it when you want the file bytes in memory; otherwise prefer `getDownloadUrl()` and pass the URL to `<a href>`, `window.open`, or a streaming consumer.
- **Parameters:** Same as `getDownloadUrl`.
- **Returns:** `Blob` with the downloaded file contents.

```typescript
const blob = await client.downloadFile("file_a1b2...");
const url = URL.createObjectURL(blob);
```

### `healthCheck()`

- **Signature:** `healthCheck(): Promise<boolean>`
- **Description:** GETs `{portalHost}/health` and returns whether the response is OK. Does not require authentication.
- **Returns:** `true` if the request succeeds with an OK status; `false` on network or non-OK responses.

### `setJwt(jwt)` / `clearJwt()` / `getJwt()` / `isAuthenticated()`

- **`setJwt(jwt: string): void`** — Stores the JWT for subsequent authenticated calls.
- **`clearJwt(): void`** — Removes the stored JWT (used for logout flows).
- **`getJwt(): string | null`** — Returns the stored JWT or `null`.
- **`isAuthenticated(): boolean`** — `true` only if a JWT is set, the payload decodes, an `exp` claim exists, and `exp` is in the future.

### `HorizonWalletSigner`

- **Signature:** `new HorizonWalletSigner(timeoutMs?: number)` (default `30000`)
- **Description:** `BLSSigner` implementation that talks to `window.HorizonWalletProvider` (browser extension). Throws if the provider is missing or RPC calls fail or time out.

## Progress callbacks

**Step callbacks** fire in order:

| Flow | Steps |
|------|--------|
| Login (already registered) | `"checking_wallet"` → `"checking_registration"` → `"challenge"` → `"signing"` → `"authenticating"` |
| Login (new user) | `"checking_wallet"` → `"checking_registration"` → `"pop"` → `"signing"` → `"registering"` → `"challenge"` → `"signing"` → `"authenticating"` |
| Upload | `"preparing"` → `"signing"` → `"initiating"` → `"uploading"` → `"validating"` |

> **Note:** the login flow skips `"checking_wallet"` when `options.address` is supplied (the signer's `getAddress()` is not called and the network check is bypassed).

**`onPrepareProgress(progress, phase)`** — Passed through to `KontorCryptoProvider.prepareFile`. `progress` is in the inclusive range **0–1**. `phase` is a `ProgressPhase` from kontor-crypto: `"reading"`, `"encoding"`, `"merkle"`, or `"finalizing"`.

**`onUploadProgress(bytesUploaded, totalBytes)`** — Reports uploaded byte count after each chunk advance; the final call uses `(totalBytes, totalBytes)`.

## Custom adapters

### `BLSSigner` (no Horizon Wallet)

```typescript
import type {
  BLSSigner,
  BLSPoP,
  BLSSignParams,
  WalletAddress,
} from "@unspendablelabs/kontor-portal-client";

class MyCustomSigner implements BLSSigner {
  async getAddress(): Promise<WalletAddress> {
    /* return { address: "bc1p...", network: "mainnet" | "testnet4" | "signet" } */
  }
  async getBLSPoP(address: string): Promise<BLSPoP> {
    /* return xpubkey, blsPubkey, schnorrSig, blsSig */
  }
  async signBLS(params: BLSSignParams): Promise<string> {
    /* sign with either params.message or params.messageHex; params.dst is required; params.address identifies the account */
  }
}
```

`BLSSignParams`: supply either `message` (UTF-8) or `messageHex`, not both, plus `dst` (domain separation tag). `address` (optional) identifies the account whose BLS key should sign.

> **Breaking change in v0.2.0:** `BLSSigner` now requires a `getAddress()` method. The unified `login()` calls it to obtain the active Taproot address and to validate the wallet's network against the client's configured `walletNetwork`.

### `InBrowserCustomSigner`

A reference, no-extension `BLSSigner` that derives a Taproot key + a BLS12-381 G1 (min-sig) key entirely in the browser. It supports two real-world key sources via a discriminated-union config:

1. **BIP-39 seed** — Horizon-Wallet parity. Uses the same EIP-2333 derivation path (`m/12381/{coinType}/{accountIndex}/0`) and Taproot path (default `m/86'/{coinType}'/{accountIndex}'/0/0`) as the Horizon Wallet extension.
2. **Single 32-byte secp256k1 private key** — for Web3Auth and other social wallets that hand back a raw key (e.g. `provider.request({ method: "private_key" })`). The BIP-32 chain code is synthesized deterministically from the private key (`HMAC-SHA512("KONTOR-WEB3AUTH-CHAINCODE-V1", privateKey).slice(32)`) so we still produce a valid `xpub` that Portal already understands.

```typescript
import { InBrowserCustomSigner, KontorPortalClient } from "@unspendablelabs/kontor-portal-client";
import { mnemonicToSeedSync } from "bip39";
import { networks } from "bitcoinjs-lib";

// 1. From a BIP-39 seed (Horizon-Wallet parity)
const seedSigner = new InBrowserCustomSigner({
  seed: mnemonicToSeedSync("..."),
  network: networks.bitcoin,
  // accountIndex: 0,                                    // optional, default 0
  // taprootDerivationPath: "m/86'/0'/0'/0/0",           // optional, derived from network coinType + accountIndex
  // walletNetwork: "mainnet",                           // optional, derived from network
});

// 2. From a single secp256k1 private key (Web3Auth, social wallets)
const pkSigner = new InBrowserCustomSigner({
  privateKey: web3authPrivateKey, // 32 bytes
  network: networks.bitcoin,
});

const client = new KontorPortalClient({
  portalHost: "https://portal.example.com",
  signer: seedSigner, // or pkSigner
});
```

`InBrowserCustomSigner` is a single-account signer: `getBLSPoP(address)` and `signBLS({ address })` validate the supplied address against the cached Taproot address and throw on mismatch.

### `/bls` subpath (raw BLS primitives)

For downstream wallets that want the underlying BLS12-381 helpers without the rest of the client (e.g. Horizon-Wallet bundling them directly into the extension), this package re-exports them under a stable `/bls` subpath whose API matches Horizon-Wallet's `tool/bls-entry.js` byte-for-byte:

```typescript
import {
  KONTOR_BLS_DST,
  sign,
  getPublicKey,
  deriveMasterSK,
  deriveBlsKey,
  signBlsBinding,
  schnorrBindingHash,
} from "@unspendablelabs/kontor-portal-client/bls";
```

All functions are pure (no `window` access, no async) and faithful TypeScript ports of the JS reference: same EIP-2333 key derivation, same `KONTOR_BLS_DST`, same Schnorr/BLS binding prefixes, same BLS12-381 G1 min-sig signatures.

### `KontorCryptoProvider`

```typescript
import type { KontorCryptoProvider } from "@unspendablelabs/kontor-portal-client";

const crypto: KontorCryptoProvider = {
  async prepareFile(file, onProgress) {
    /* File | Uint8Array | ArrayBuffer — return PrepareResult; optional onProgress */
  },
};
```

### `NonceProvider`

```typescript
import type { NonceProvider } from "@unspendablelabs/kontor-portal-client";

const nonceProvider: NonceProvider = {
  async getNextNonce(signerId, chainNonce) {
    /* return the nonce to use (e.g. coordinated with chainNonce from registry) */
  },
  async reportNonceUsed(signerId, nonceUsed) {
    /* optional — called after a successful upload using that nonce */
  },
  async setNonce(signerId, nonce) {
    /* optional — called by login() to force-overwrite the local tracker
       with the Portal's authoritative next_nonce (resync across tabs/sessions) */
  },
};
```

## React bindings

The library ships a React context provider and hook that manage a single `KontorPortalClient` instance per component tree, along with authentication state (JWT persistence via `localStorage`).

### `PortalClientProvider`

Wrap your app (or a subtree) with the provider. It accepts the same `KontorPortalClientConfig` used by the client constructor.

> **Note:** `config` is read once on mount. Changing `config` after the initial render has no effect. Keep the reference stable (module-level constant or `useMemo`).

```tsx
import { PortalClientProvider } from "@unspendablelabs/kontor-portal-client/react";

<PortalClientProvider
  config={{
    portalHost: "https://portal.example.com",
    nonceProvider, // optional — defaults to InMemoryNonceProvider
  }}
>
  {children}
</PortalClientProvider>
```

### `usePortalClient()`

Returns the shared client and auth helpers:

```tsx
import { usePortalClient } from "@unspendablelabs/kontor-portal-client/react";

function MyComponent() {
  const {
    client,          // KontorPortalClient instance
    status,          // PortalAuthStatus
    jwt,             // current JWT or null
    isRegistered,    // true when a userId is stored
    portalUserId,
    taprootAddress,
    xOnlyPubkey,
    login,           // () => Promise<void> — register-if-needed + login
    logout,          // () => void
    reset,           // () => void — clear all stored state
  } = usePortalClient();
}
```

`PortalAuthStatus` is one of `"loading"` | `"authenticated"` | `"needs_login"` | `"logging_in"` | `"error"`. `login()` handles registration on demand, so there is no separate `"needs_registration"` state.

On failure, `login()` updates `status` to `"error"` (with `error` set to the message) **and** re-throws the underlying error, so callers awaiting the call can `try/catch` it directly without also subscribing to `status` / `error`:

```tsx
try {
  await login();
} catch (err) {
  // handle the failure (e.g. toast, retry button, …)
  // `status` is already `"error"` and `error` already holds `err.message`
}
```

## WASM crypto setup

`@kontor/kontor-crypto` is a WASM module that handles Reed–Solomon encoding, Merkle tree computation, and file preparation. Because WASM cannot be bundled like regular JavaScript, the module must be **served as a static asset** by your application.

At runtime the client loads the module with a dynamic `import()` from a URL (default: `/kontor-crypto/index.js`). You need to copy the package files into your public/static directory so the browser can fetch them.

### Copy the files

After installing `@kontor/kontor-crypto`, copy its contents to a `kontor-crypto/` folder inside your public directory:

```bash
cp -r node_modules/@kontor/kontor-crypto/dist/* public/kontor-crypto/
```

> **Tip:** Add this to a `postinstall` script so it stays in sync:
>
> ```jsonc
> // package.json
> "scripts": {
>   "postinstall": "cp -r node_modules/@kontor/kontor-crypto/dist/* public/kontor-crypto/"
> }
> ```

### Framework-specific examples

**Vite** — files in `public/` are served at the root:

```bash
cp -r node_modules/@kontor/kontor-crypto/dist/* public/kontor-crypto/
```

No config change needed — the default `/kontor-crypto/index.js` URL will work.

**Next.js** — same approach with the `public/` directory:

```bash
cp -r node_modules/@kontor/kontor-crypto/dist/* public/kontor-crypto/
```

### Custom URL

If you serve the files from a different path, pass `wasmUrl`:

```typescript
const client = new KontorPortalClient({
  portalHost: "https://portal.example.com",
  wasmUrl: "/assets/crypto/index.js",
});
```

Or create a standalone crypto provider with `createCryptoProvider`:

```typescript
import { createCryptoProvider } from "@unspendablelabs/kontor-portal-client";

const crypto = createCryptoProvider("/assets/crypto/index.js");
const client = new KontorPortalClient({
  portalHost: "https://portal.example.com",
  crypto,
});
```

When `crypto` is provided, `wasmUrl` is ignored.

## Development

```bash
npm install
npm run lint        # ESLint
npm run typecheck   # TypeScript (no emit)
npm test            # Vitest
npm run test:coverage
```

A pre-push git hook runs lint, typecheck, and tests automatically.

## License

[MIT](https://opensource.org/licenses/MIT)
