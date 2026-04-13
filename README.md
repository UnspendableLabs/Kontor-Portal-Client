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
  kontorContractAddress: "my_contract", // default: "filestorage_0_0"
  // signer: myCustomSigner, // default: new HorizonWalletSigner()
  // crypto: myCustomCrypto, // default: WASM via @kontor/kontor-crypto
  // wasmUrl: "/custom/path/index.js", // default: "/kontor-crypto/index.js"
  // nonceProvider: myNonceProvider, // default: new InMemoryNonceProvider()
});
```

## Quick start

Full flow: register, log in, then upload. Each step supports optional progress callbacks.

```typescript
// Register
const reg = await client.register("bc1p...", {
  onStep: (step) => console.log("Register step:", step),
});

// Login
const { jwt } = await client.login(reg.userId, "bc1p...", {
  onStep: (step) => console.log("Login step:", step),
});

// Upload a file
const result = await client.uploadFile(file, {
  xOnlyPubkey: reg.xOnlyPubkey,
  address: "bc1p...",
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

## API reference

### `register(taprootAddress, options?)`

- **Signature:** `register(taprootAddress: string, options?: RegisterOptions): Promise<RegistrationResult>`
- **Description:** Fetches a BLS proof-of-possession from the signer, builds the registration payload, signs it with BLS, and POSTs to the portal. Does not set a JWT.
- **Parameters:**
  - `taprootAddress` — Taproot address passed to the signer for PoP.
  - `options?.onStep` — Called with register step names (see [Progress callbacks](#progress-callbacks)).
- **Returns:** `RegistrationResult` with `userId`, `xOnlyPubkey`, `blsPubkey`, and `xpubkey`.

### `login(userId, address, options?)`

- **Signature:** `login(userId: string, address: string, options?: LoginOptions): Promise<LoginResult>`
- **Description:** Fetches a challenge, signs it with BLS (HTTP SIG domain), POSTs credentials, and stores the returned JWT on the client.
- **Parameters:**
  - `userId` — User id returned from registration.
  - `address` — Taproot address used for BLS key derivation.
  - `options?.onStep` — Called with login step names.
- **Returns:** `LoginResult` with `jwt`, `userId`, optional `role`, and optional `expiresIn` (seconds until JWT expiry, derived from the token when possible).

### `getSignerInfo(xOnlyPubkey)`

- **Signature:** `getSignerInfo(xOnlyPubkey: string): Promise<SignerInfo>`
- **Description:** Looks up the signer in the portal registry and returns signer id and next nonce. If a `nonceProvider` is configured, `nextNonce` may be adjusted by `getNextNonce`.
- **Parameters:**
  - `xOnlyPubkey` — Hex x-only pubkey for the signer (e.g. from registration).
- **Returns:** `{ signerId: number; nextNonce: number }`. Sends `Authorization` when a JWT is present.

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
- **Description:** GETs a single agreement by ID for the authenticated user.
- **Parameters:**
  - `agreementId` — The agreement ID to fetch.
- **Returns:** `Agreement`. Throws if not found (404) or on other errors.

### `listAgreements(options?)`

- **Signature:** `listAgreements(options?: ListAgreementsOptions): Promise<AgreementsResponse>`
- **Description:** GETs paginated agreements for the authenticated user.
- **Parameters:**
  - `options?.limit` — Page size (default 20).
  - `options?.offset` — Offset (default 0).
- **Returns:** `AgreementsResponse` with `offset`, `limit`, `total`, and `agreements[]`.

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
| Register | `"pop"` → `"signing"` → `"registering"` |
| Login | `"challenge"` → `"signing"` → `"authenticating"` |
| Upload | `"preparing"` → `"signing"` → `"initiating"` → `"uploading"` → `"validating"` |

**`onPrepareProgress(progress, phase)`** — Passed through to `KontorCryptoProvider.prepareFile`. `progress` is in the inclusive range **0–1**. `phase` is a `ProgressPhase` from kontor-crypto: `"reading"`, `"encoding"`, `"merkle"`, or `"finalizing"`.

**`onUploadProgress(bytesUploaded, totalBytes)`** — Reports uploaded byte count after each chunk advance; the final call uses `(totalBytes, totalBytes)`.

## Custom adapters

### `BLSSigner` (no Horizon Wallet)

```typescript
import type { BLSSigner, BLSPoP, BLSSignParams } from "@unspendablelabs/kontor-portal-client";

class MyCustomSigner implements BLSSigner {
  async getBLSPoP(address: string): Promise<BLSPoP> {
    /* return xpubkey, blsPubkey, schnorrSig, blsSig */
  }
  async signBLS(params: BLSSignParams): Promise<string> {
    /* sign with either params.message or params.messageHex; params.dst is required; params.address identifies the account */
  }
}
```

`BLSSignParams`: supply either `message` (UTF-8) or `messageHex`, not both, plus `dst` (domain separation tag). `address` (optional) identifies the account whose BLS key should sign.

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
    login,           // () => Promise<void>
    logout,          // () => void
    saveRegistration,// (data) => void — persist registration result
    reset,           // () => void — clear all stored state
  } = usePortalClient();
}
```

`PortalAuthStatus` is one of `"loading"` | `"authenticated"` | `"needs_registration"` | `"needs_login"` | `"logging_in"` | `"error"`.

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
