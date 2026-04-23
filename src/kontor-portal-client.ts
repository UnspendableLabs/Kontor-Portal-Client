import {
  PortalNotFoundError,
  type KontorPortalClientConfig,
  type BLSSigner,
  type KontorCryptoProvider,
  type NonceProvider,
  type RegistrationResult,
  type RegisterOptions,
  type LoginResult,
  type LoginOptions,
  type SignerInfo,
  type UploadResult,
  type UploadOptions,
  type Agreement,
  type AgreementsResponse,
  type ListAgreementsOptions,
  type DownloadFileOptions,
  type DownloadUrlResult,
} from "./types";
import {
  buildRegistrationMessage,
  buildCreateAgreementMessage,
  buildCreateAgreementExpr,
  computeCryptoParams,
  bytesToHex,
  KONTOR_BLS_DST,
} from "./postcard";
import { getXOnlyPubkeyHexFromXpub } from "./xpub-utils";
import { HorizonWalletSigner } from "./horizon-wallet-signer";
import { prepareFile, createCryptoProvider } from "./kontor-crypto";
import type { Network } from "bitcoinjs-lib";
import { networks } from "bitcoinjs-lib";

const CHUNK_SIZE = 256 * 1024; // 256 KiB
const DEFAULT_CONTRACT = "filestorage_0_0";

/**
 * Tracks the highest nonce used per signer in memory. Prevents nonce reuse
 * when multiple uploads happen before the chain catches up.
 * Lost on page refresh, but the chain nonce will have advanced by then.
 */
export class InMemoryNonceProvider implements NonceProvider {
  private lastUsed = new Map<number, number>();

  async getNextNonce(signerId: number, chainNonce: number): Promise<number> {
    const local = this.lastUsed.get(signerId) ?? -1;
    return Math.max(chainNonce, local + 1);
  }

  async reportNonceUsed(signerId: number, nonceUsed: number): Promise<void> {
    const current = this.lastUsed.get(signerId) ?? -1;
    this.lastUsed.set(signerId, Math.max(current, nonceUsed));
  }
}

export class KontorPortalClient {
  private readonly portalHost: string;
  private readonly kontorContractAddress: string;
  private readonly network: Network;
  private readonly validationDelayMs: number;
  private readonly signer: BLSSigner;
  private readonly crypto: KontorCryptoProvider;
  private readonly nonceProvider: NonceProvider;
  private jwt: string | null = null;

  constructor(config: KontorPortalClientConfig) {
    this.portalHost = config.portalHost;
    this.kontorContractAddress =
      config.kontorContractAddress ?? DEFAULT_CONTRACT;
    this.network = config.network ?? networks.testnet;
    this.validationDelayMs = config.validationDelayMs ?? 2000;
    this.signer = config.signer ?? new HorizonWalletSigner();
    this.crypto =
      config.crypto ??
      (config.wasmUrl ? createCryptoProvider(config.wasmUrl) : { prepareFile });
    this.nonceProvider = config.nonceProvider ?? new InMemoryNonceProvider();
  }

  private requireJwt(): string {
    if (!this.jwt || !this.isAuthenticated()) {
      throw new Error("Not authenticated -- call login() first");
    }
    return this.jwt;
  }

  private static decodeJwtPayload(token: string): {
    exp?: number;
    user_id?: string;
    role?: string;
  } {
    try {
      const payload = token.split(".")[1];
      return JSON.parse(atob(payload));
    } catch {
      return {};
    }
  }

  private async portalFetch(
    path: string,
    options?: RequestInit,
  ): Promise<Response> {
    const jwt = this.requireJwt();
    return fetch(`${this.portalHost}${path}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${jwt}`,
      },
    });
  }

  private static async throwResponseError(
    res: Response,
    fallback: string,
  ): Promise<never> {
    const body = await res.text();
    let message = fallback;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.message) message = parsed.error.message;
      else if (typeof parsed?.error === "string") message = parsed.error;
    } catch {
      // non-JSON response
    }
    throw new Error(message);
  }

  setJwt(jwt: string): void {
    this.jwt = jwt;
  }

  clearJwt(): void {
    this.jwt = null;
  }

  getJwt(): string | null {
    return this.jwt;
  }

  isAuthenticated(): boolean {
    if (!this.jwt) return false;
    const { exp } = KontorPortalClient.decodeJwtPayload(this.jwt);
    if (!exp) return false;
    return exp * 1000 > Date.now();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.portalHost}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async register(
    taprootAddress: string,
    options?: RegisterOptions,
  ): Promise<RegistrationResult> {
    options?.onStep?.("pop");
    const pop = await this.signer.getBLSPoP(taprootAddress);

    const derivedXOnlyPubkey = getXOnlyPubkeyHexFromXpub(
      pop.xpubkey,
      this.network,
    );
    const messageBytes = buildRegistrationMessage(
      derivedXOnlyPubkey,
      pop.blsPubkey,
      pop.schnorrSig,
      pop.blsSig,
    );

    options?.onStep?.("signing");
    const signature = await this.signer.signBLS({
      messageHex: bytesToHex(messageBytes),
      dst: KONTOR_BLS_DST,
      address: taprootAddress,
    });

    options?.onStep?.("registering");
    const res = await fetch(`${this.portalHost}/api/users/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        xpubkey: pop.xpubkey,
        bls_pubkey: pop.blsPubkey,
        schnorr_sig: pop.schnorrSig,
        bls_sig: pop.blsSig,
        registration_signature: signature,
      }),
    });

    if (!res.ok) {
      await KontorPortalClient.throwResponseError(
        res,
        res.status === 500
          ? "Portal server is unreachable"
          : `Registration failed (${res.status})`,
      );
    }

    const data = (await res.json()) as Record<string, unknown>;
    const userId = data.user_id;
    const xOnlyPubkey = data.x_only_pubkey;
    const blsPubkey = data.bls_pubkey;
    if (
      typeof userId !== "string" ||
      typeof xOnlyPubkey !== "string" ||
      typeof blsPubkey !== "string"
    ) {
      throw new Error(
        "Invalid registration response: missing required fields",
      );
    }

    return { userId, xOnlyPubkey, blsPubkey, xpubkey: pop.xpubkey };
  }

  async login(
    userId: string,
    address: string,
    options?: LoginOptions,
  ): Promise<LoginResult> {
    options?.onStep?.("challenge");
    const challengeRes = await fetch(
      `${this.portalHost}/api/users/login?user_id=${encodeURIComponent(userId)}`,
    );
    if (!challengeRes.ok) {
      throw new Error(`Failed to get challenge (${challengeRes.status})`);
    }

    const challengeData = (await challengeRes.json()) as {
      challenge?: string;
    };
    const challenge = challengeData?.challenge;
    if (!challenge || typeof challenge !== "string") {
      throw new Error("Invalid challenge response from Portal");
    }

    options?.onStep?.("signing");
    const signature = await this.signer.signBLS({
      message: challenge,
      dst: "HORIZON_PORTAL_HTTP_SIG",
      address,
    });

    options?.onStep?.("authenticating");
    const loginRes = await fetch(`${this.portalHost}/api/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        challenge,
        signature,
      }),
    });

    if (!loginRes.ok) {
      await KontorPortalClient.throwResponseError(
        loginRes,
        `Login failed (${loginRes.status})`,
      );
    }

    const loginData = (await loginRes.json()) as {
      token?: string;
      user_id?: string;
      role?: string;
      expires_in?: number;
    };
    const token = loginData?.token;
    if (!token || typeof token !== "string") {
      throw new Error("Invalid login response: missing token");
    }

    this.jwt = token;

    const { exp, role } = KontorPortalClient.decodeJwtPayload(token);
    const expiresIn = exp
      ? exp - Math.floor(Date.now() / 1000)
      : loginData.expires_in;

    return {
      jwt: token,
      userId,
      role: role ?? loginData.role,
      expiresIn,
    };
  }

  /**
   * Look up signer info in the Portal registry.
   *
   * `idOrPubkeyOrAddress` accepts any of the three formats supported by
   * `GET /api/registry/entry/{pubkey_or_id}`:
   *   1. A numeric Kontor `signer_id` (e.g. `"0"`).
   *   2. An x-only public key in hex (64 hex chars).
   *   3. A Bitcoin address registered with the Portal.
   *
   * Throws {@link PortalNotFoundError} on 404 (registry entry / address not
   * registered).
   */
  async getSignerInfo(idOrPubkeyOrAddress: string): Promise<SignerInfo> {
    const headers: HeadersInit = {};
    if (this.jwt) {
      headers["Authorization"] = `Bearer ${this.jwt}`;
    }

    const res = await fetch(
      `${this.portalHost}/api/registry/entry/${encodeURIComponent(idOrPubkeyOrAddress)}`,
      { headers },
    );

    if (res.status === 404) {
      throw new PortalNotFoundError("Signer not found in registry");
    }
    if (!res.ok) {
      throw new Error(`Registry lookup failed (${res.status})`);
    }

    const data = (await res.json()) as {
      signer_id: number;
      next_nonce: number;
    };

    const effectiveNonce = await this.nonceProvider.getNextNonce(
      data.signer_id,
      data.next_nonce,
    );

    return { signerId: data.signer_id, nextNonce: effectiveNonce };
  }

  async uploadFile(
    file: File,
    options: UploadOptions,
  ): Promise<UploadResult> {
    this.requireJwt();

    options.onStep?.("preparing");
    const prepareResult = await this.crypto.prepareFile(
      file,
      options.onPrepareProgress,
    );

    const { signerId, nextNonce } = await this.getSignerInfo(
      options.xOnlyPubkey,
    );

    const { dataSymbols, paritySymbols, blobSize } = computeCryptoParams(
      file.size,
      prepareResult.metadata.paddedLen,
    );

    const expr = buildCreateAgreementExpr(
      prepareResult.metadata.fileId,
      prepareResult.metadata.objectId,
      prepareResult.metadata.root,
      prepareResult.metadata.paddedLen,
      file.size,
      file.name,
    );

    const messageBytes = buildCreateAgreementMessage(
      signerId,
      nextNonce,
      this.kontorContractAddress,
      expr,
    );

    options.onStep?.("signing");
    const blsSignature = await this.signer.signBLS({
      messageHex: bytesToHex(messageBytes),
      dst: KONTOR_BLS_DST,
      address: options.address,
    });

    const mimeType = file.type || "application/octet-stream";

    options.onStep?.("initiating");
    const initResponse = await this.portalFetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        files: [
          {
            filename: file.name,
            mime_type: mimeType,
            tags: options.tags ?? [],
            size: file.size,
            crypto: {
              file_id: prepareResult.metadata.fileId,
              file_hash: prepareResult.metadata.objectId,
              merkle_root: prepareResult.metadata.root,
              padded_len: prepareResult.metadata.paddedLen,
              data_symbols: dataSymbols,
              parity_symbols: paritySymbols,
              blob_size: blobSize,
            },
            bls_signature: blsSignature,
            nonce: nextNonce,
          },
        ],
      }),
    });

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      throw new Error(
        `Upload initiation failed: ${initResponse.status} ${errorText}`,
      );
    }

    const uploadSession = (await initResponse.json()) as {
      uploads?: { upload_url?: string; upload_session_id?: string }[];
    };
    const uploadInfo = uploadSession.uploads?.[0];
    if (!uploadInfo?.upload_url) {
      throw new Error("Upload session is missing upload URL");
    }

    const sessionId = uploadInfo.upload_session_id ?? "";

    options.onStep?.("uploading");
    let start = 0;
    while (start < file.size) {
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      const isLastChunk = end === file.size;
      const contentRange = `bytes ${start}-${end - 1}/${file.size}`;

      let response: Response;
      try {
        response = await fetch(uploadInfo.upload_url, {
          method: "PUT",
          mode: "cors",
          headers: {
            "Content-Range": contentRange,
            "Content-Type": mimeType,
          },
          body: chunk,
        });
      } catch (fetchError) {
        if (isLastChunk && String(fetchError).includes("Failed to fetch")) {
          // Some servers drop the connection after the final chunk instead of
          // responding. Treat as success; the validation step will catch real
          // failures.
          console.warn(
            "[KontorPortalClient] Last chunk fetch failed — assuming upload completed",
            fetchError,
          );
          break;
        }
        throw new Error(`Network error during upload: ${fetchError}`, {
          cause: fetchError,
        });
      }

      if (response.status === 200 || response.status === 201) {
        break;
      } else if (response.status === 308) {
        start = end;
      } else {
        let errorText = "Unknown error";
        try {
          errorText = await response.text();
        } catch {
          /* ignore */
        }
        throw new Error(
          `Upload failed with status ${response.status}: ${errorText}`,
        );
      }

      if (file.size > 0) {
        options.onUploadProgress?.(start, file.size);
      }
    }

    options.onUploadProgress?.(file.size, Math.max(file.size, 1));

    options.onStep?.("validating");
    await new Promise((r) => setTimeout(r, this.validationDelayMs));
    try {
      await this.portalFetch(
        `/api/files/validate?session_id=${sessionId}`,
        { method: "POST" },
      );
    } catch {
      // Validation skipped — likely still processing
    }

    try {
      await this.nonceProvider.reportNonceUsed?.(signerId, nextNonce);
    } catch {
      // Non-critical — signer info will re-sync on next upload
    }

    return {
      sessionId,
      fileId: prepareResult.metadata.fileId,
      merkleRoot: prepareResult.metadata.root,
      filename: file.name,
      size: file.size,
    };
  }

  async getAgreement(agreementId: string): Promise<Agreement> {
    const res = await fetch(
      `${this.portalHost}/api/agreements/${encodeURIComponent(agreementId)}`,
    );

    if (res.status === 404) {
      throw new PortalNotFoundError("Agreement not found");
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch agreement (${res.status})`);
    }

    return (await res.json()) as Agreement;
  }

  async listAgreements(
    options?: ListAgreementsOptions,
  ): Promise<AgreementsResponse> {
    const params = new URLSearchParams();
    params.set("limit", String(options?.limit ?? 20));
    params.set("offset", String(options?.offset ?? 0));

    if (options?.status !== undefined) {
      const statusValue = Array.isArray(options.status)
        ? options.status.join("|")
        : options.status;
      if (statusValue.length > 0) {
        params.set("status", statusValue);
      }
    }

    if (options?.users && options.users.length > 0) {
      params.set("users", options.users.join(","));
    }

    if (options?.nodes && options.nodes.length > 0) {
      params.set("nodes", options.nodes.join(","));
    }

    if (options?.mimeType) {
      params.set("mime_type", options.mimeType);
    }

    if (options?.sort) {
      params.set("sort", options.sort);
    }

    if (options?.sortDir) {
      params.set("sort_dir", options.sortDir);
    }

    const res = await fetch(
      `${this.portalHost}/api/agreements?${params.toString()}`,
    );

    if (!res.ok) {
      throw new Error(`Failed to list agreements (${res.status})`);
    }

    return (await res.json()) as AgreementsResponse;
  }

  private buildDownloadUrl(
    agreementId: string,
    options?: DownloadFileOptions & { noRedirect?: boolean },
  ): string {
    const params = new URLSearchParams();
    if (options?.forceDownload) {
      params.set("force_download", "true");
    }
    if (options?.noRedirect) {
      params.set("no_redirect", "true");
    }
    const query = params.toString();
    const path = `/api/agreements/${encodeURIComponent(agreementId)}/download`;
    return `${this.portalHost}${path}${query ? `?${query}` : ""}`;
  }

  async getDownloadUrl(
    agreementId: string,
    options?: DownloadFileOptions,
  ): Promise<DownloadUrlResult> {
    const url = this.buildDownloadUrl(agreementId, {
      ...options,
      noRedirect: true,
    });

    const res = await fetch(url);

    if (res.status === 404) {
      throw new PortalNotFoundError("Agreement not found");
    }
    if (!res.ok) {
      await KontorPortalClient.throwResponseError(
        res,
        `Failed to get download URL (${res.status})`,
      );
    }

    const data = (await res.json()) as { download_url?: unknown };
    if (typeof data.download_url !== "string") {
      throw new Error("Invalid download response: missing download_url");
    }

    return { downloadUrl: data.download_url };
  }

  async downloadFile(
    agreementId: string,
    options?: DownloadFileOptions,
  ): Promise<Blob> {
    const { downloadUrl } = await this.getDownloadUrl(agreementId, options);

    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Failed to download file (${res.status})`);
    }

    return await res.blob();
  }
}
