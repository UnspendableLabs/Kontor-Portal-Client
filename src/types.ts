import type { Network } from "bitcoinjs-lib";
import type {
  OnProgress,
  PrepareResult,
  ProgressPhase,
} from "./kontor-crypto";

export type { PrepareResult, ProgressPhase, OnProgress } from "./kontor-crypto";

export interface BLSPoP {
  xpubkey: string;
  blsPubkey: string;
  schnorrSig: string;
  blsSig: string;
}

/**
 * Parameters for BLS signing. Provide either `message` (UTF-8) or `messageHex`
 * (hex-encoded bytes), not both.
 *
 * `dst` is the domain separation tag (DST) string required by the BLS scheme.
 */
export interface BLSSignParams {
  message?: string;
  messageHex?: string;
  dst: string;
  address?: string;
}

/**
 * Wallet-side network identifier as returned by Horizon Wallet
 * (`getAddresses` RPC). This is a string, distinct from bitcoinjs-lib's
 * structural `Network` object used by `KontorPortalClientConfig.network`.
 */
export type WalletNetwork = "mainnet" | "testnet4" | "signet";

export interface WalletAddress {
  address: string;
  network: WalletNetwork;
}

export interface BLSSigner {
  /**
   * Returns the active Taproot (p2tr) address from the wallet along with the
   * network the wallet is currently connected to. The client validates the
   * returned `network` against its own configured `walletNetwork` and throws
   * {@link NetworkMismatchError} on mismatch.
   */
  getAddress(): Promise<WalletAddress>;
  getBLSPoP(address: string): Promise<BLSPoP>;
  signBLS(params: BLSSignParams): Promise<string>;
}

/** Envelope returned by Horizon Wallet `request()` (extension RPC-style API). */
export interface HorizonWalletRpcResponse<T = unknown> {
  result?: T;
  error?: unknown;
}

/**
 * Minimal provider surface for BLS flows. Matches `window.HorizonWalletProvider`
 * from the extension without importing wallet adapters.
 */
export interface HorizonWalletProviderLike {
  request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<HorizonWalletRpcResponse>;
}

export interface KontorCryptoProvider {
  prepareFile(
    file: File | Uint8Array | ArrayBuffer,
    onProgress?: OnProgress,
  ): Promise<PrepareResult>;
}

export interface NonceProvider {
  getNextNonce(signerId: number, chainNonce: number): Promise<number>;
  reportNonceUsed?(signerId: number, nonceUsed: number): Promise<void>;
  /** Force the local "last used" tracker to `nonce - 1` so the next
   *  getNextNonce returns at least `nonce`. Called on login to resync
   *  with the Portal's authoritative `next_nonce`. */
  setNonce?(signerId: number, nonce: number): Promise<void>;
}

export interface KontorPortalClientConfig {
  portalHost: string;
  /** Defaults to `"filestorage_0_0"`. */
  kontorContractAddress?: string;
  /** Defaults to signet (`testnet` from bitcoinjs-lib). */
  network?: Network;
  /**
   * Expected wallet network (string). When omitted, derived from `network`
   * (`networks.bitcoin` → `"mainnet"`, anything else → `"signet"`). Override
   * this when targeting `"testnet4"`, since bitcoinjs-lib's `testnet` covers
   * testnet3/testnet4/signet (same bech32 parameters).
   */
  walletNetwork?: WalletNetwork;
  /** Defaults to `new HorizonWalletSigner()`. */
  signer?: BLSSigner;
  /** Defaults to `{ prepareFile }` (WASM-based). */
  crypto?: KontorCryptoProvider;
  nonceProvider?: NonceProvider;
  /** Delay (ms) before calling the validation endpoint after upload. Defaults to `2000`. */
  validationDelayMs?: number;
  /** URL to the kontor-crypto WASM loader. Defaults to `"/kontor-crypto/index.js"`. Ignored when `crypto` is provided. */
  wasmUrl?: string;
}

export type RegisterStep = "pop" | "signing" | "registering";
export type LoginStep = "challenge" | "signing" | "authenticating";
export type UploadStep =
  | "preparing"
  | "signing"
  | "initiating"
  | "uploading"
  | "validating";

export interface RegisterOptions {
  onStep?: (step: RegisterStep) => void;
}

export interface LoginOptions {
  onStep?: (step: LoginStep) => void;
}

/**
 * `onPrepareProgress`: `progress` is in the range 0–1 (inclusive), paired with
 * the current `phase` from kontor-crypto preparation (same contract as
 * {@link OnProgress}).
 */
export interface UploadOptions {
  xOnlyPubkey: string;
  address?: string;
  tags?: string[];
  onStep?: (step: UploadStep) => void;
  onPrepareProgress?: (progress: number, phase: ProgressPhase) => void;
  onUploadProgress?: (bytesUploaded: number, totalBytes: number) => void;
}

export interface RegistrationResult {
  userId: string;
  xOnlyPubkey: string;
  blsPubkey: string;
  xpubkey: string;
}

export interface LoginResult {
  jwt: string;
  userId: string;
  role?: string;
  expiresIn?: number;
}

export interface SignerInfo {
  signerId: number;
  /** Effective next nonce after `NonceProvider.getNextNonce` arbitration. */
  nextNonce: number;
  /** Raw `next_nonce` value returned by `/api/registry/entry` (Portal-authoritative). */
  chainNonce: number;
  /**
   * Present when the registry entry resolves to a `users` row (lookup by
   * Bitcoin address or x-only pubkey of a registered user). Absent when the
   * resolved identifier corresponds to a non-user signer (e.g. a node).
   */
  userId?: string;
}

export type UnifiedLoginStep =
  | "checking_wallet"
  | "checking_registration"
  | RegisterStep
  | LoginStep;

export interface UnifiedLoginOptions {
  /**
   * Optional Taproot address. When omitted, the signer's `getAddress()` is
   * called (and the returned network is validated against the client's
   * configured `walletNetwork`).
   */
  address?: string;
  onStep?: (step: UnifiedLoginStep) => void;
}

export interface UnifiedLoginResult extends LoginResult {
  /**
   * Taproot address used for the login flow — either the value from
   * `options.address` or the wallet-resolved address from
   * `signer.getAddress()`. Always populated.
   */
  address: string;
  /**
   * `null` when the user was already registered. Populated with the
   * registration data when this call also performed an automatic
   * registration.
   */
  registration: RegistrationResult | null;
}

export interface UploadResult {
  sessionId: string;
  fileId: string;
  merkleRoot: string;
  filename: string;
  size: number;
}

export interface Agreement {
  agreement_id: string;
  user_id: string;
  file_id: string;
  filename: string;
  mime_type: string;
  original_size: number;
  created_at: string;
  status: "pending" | "ready" | "confirmed" | "completed" | (string & {});
  nodes: string[];
  transaction_id?: string;
  txid?: string | null;
  block_height?: number | null;
  block_time?: number | null;
  curation?: Record<string, unknown>;
  merkle_root?: string;
  data_symbols?: number;
  parity_symbols?: number;
  padded_len?: number;
  blob_size?: number;
  file_hash?: string;
}

export interface AgreementsResponse {
  offset: number;
  limit: number;
  total: number;
  agreements: Agreement[];
}

export interface ListAgreementsOptions {
  limit?: number;
  offset?: number;
  status?: string | string[];
  users?: string[];
  nodes?: string[];
  mimeType?: string;
  sort?: "created_at" | "size" | "filename";
  sortDir?: "asc" | "desc";
}

export interface DownloadFileOptions {
  /** When `true`, set the `force_download` query flag so the URL serves with `Content-Disposition: attachment`. */
  forceDownload?: boolean;
}

export interface DownloadUrlResult {
  /** Signed GCS URL when the agreement is `ready`, or storage node URL when `confirmed`. */
  downloadUrl: string;
}

export class PortalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalNotFoundError";
  }
}

export class NetworkMismatchError extends Error {
  constructor(
    public readonly walletNetwork: WalletNetwork,
    public readonly clientNetwork: WalletNetwork,
  ) {
    super(
      `Wallet network "${walletNetwork}" does not match client network "${clientNetwork}"`,
    );
    this.name = "NetworkMismatchError";
  }
}
