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
}

export interface BLSSigner {
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
}

export interface KontorPortalClientConfig {
  portalHost: string;
  /** Defaults to `"filestorage_0_0"`. */
  kontorContractAddress?: string;
  /** Defaults to signet (`testnet` from bitcoinjs-lib). */
  network?: Network;
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
  nextNonce: number;
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
}

export class PortalNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalNotFoundError";
  }
}
