import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { networks } from "bitcoinjs-lib";
import {
  KontorPortalClient,
  InMemoryNonceProvider,
} from "../kontor-portal-client";
import { NetworkMismatchError, PortalNotFoundError } from "../types";
import { createMockSigner, MOCK_TAPROOT_ADDRESS } from "./helpers/mock-signer";
import { createMockCrypto } from "./helpers/mock-crypto";
import { createMockFetch, jsonResponse, textResponse } from "./helpers/mock-fetch";
import {
  PORTAL_HOST,
  UPLOAD_URL,
  makeJwt,
  makeExpiredJwt,
  PREPARE_RESULT,
  POP,
  DOWNLOAD_URL,
  DOWNLOAD_FILE_CONTENT,
} from "./helpers/fixtures";
import type { KontorPortalClientConfig, NonceProvider } from "../types";
import {
  buildCreateAgreementMessage,
  buildMintNftExpr,
  bytesToHex,
} from "../postcard";

function makeClient(overrides?: Partial<KontorPortalClientConfig>) {
  return new KontorPortalClient({
    portalHost: PORTAL_HOST,
    signer: createMockSigner(),
    crypto: createMockCrypto(),
    nonceProvider: new InMemoryNonceProvider(),
    validationDelayMs: 0,
    ...overrides,
  });
}

describe("InMemoryNonceProvider", () => {
  it("returns chainNonce when no local history", async () => {
    const np = new InMemoryNonceProvider();
    expect(await np.getNextNonce(1, 5)).toBe(5);
  });

  it("returns local + 1 when higher than chain", async () => {
    const np = new InMemoryNonceProvider();
    await np.reportNonceUsed(1, 10);
    expect(await np.getNextNonce(1, 5)).toBe(11);
  });

  it("returns chainNonce when chain is higher", async () => {
    const np = new InMemoryNonceProvider();
    await np.reportNonceUsed(1, 3);
    expect(await np.getNextNonce(1, 10)).toBe(10);
  });

  it("tracks multiple signers independently", async () => {
    const np = new InMemoryNonceProvider();
    await np.reportNonceUsed(1, 10);
    await np.reportNonceUsed(2, 20);
    expect(await np.getNextNonce(1, 0)).toBe(11);
    expect(await np.getNextNonce(2, 0)).toBe(21);
  });

  it("keeps max of reported nonces", async () => {
    const np = new InMemoryNonceProvider();
    await np.reportNonceUsed(1, 10);
    await np.reportNonceUsed(1, 5);
    expect(await np.getNextNonce(1, 0)).toBe(11);
  });

  describe("setNonce", () => {
    it("stores nonce - 1 so the next getNextNonce returns nonce", async () => {
      const np = new InMemoryNonceProvider();
      await np.setNonce(1, 7);
      expect(await np.getNextNonce(1, 0)).toBe(7);
    });

    it("overwrites a higher local state with a lower Portal value", async () => {
      const np = new InMemoryNonceProvider();
      await np.reportNonceUsed(1, 50);
      await np.setNonce(1, 10);
      expect(await np.getNextNonce(1, 10)).toBe(10);
    });

    it("does not affect other signers", async () => {
      const np = new InMemoryNonceProvider();
      await np.reportNonceUsed(1, 50);
      await np.reportNonceUsed(2, 30);
      await np.setNonce(1, 5);
      expect(await np.getNextNonce(1, 0)).toBe(5);
      expect(await np.getNextNonce(2, 0)).toBe(31);
    });

    it("yields chainNonce when chain advanced past the set nonce", async () => {
      const np = new InMemoryNonceProvider();
      await np.setNonce(1, 5);
      expect(await np.getNextNonce(1, 12)).toBe(12);
    });

    it("handles nonce=0 safely (lastUsed=-1, next nonce=0)", async () => {
      // Register branch: a freshly-registered user has next_nonce=0.
      // setNonce(_, 0) must store -1 without breaking the following calls,
      // and the next getNextNonce(_, 0) must return 0 (not -1, not NaN).
      const np = new InMemoryNonceProvider();
      await np.setNonce(1, 0);
      expect(await np.getNextNonce(1, 0)).toBe(0);
      expect(await np.getNextNonce(1, 3)).toBe(3);
    });
  });
});

describe("KontorPortalClient", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("JWT management", () => {
    it("starts with null JWT", () => {
      const client = makeClient();
      expect(client.getJwt()).toBeNull();
      expect(client.isAuthenticated()).toBe(false);
    });

    it("setJwt / getJwt / clearJwt", () => {
      const client = makeClient();
      const jwt = makeJwt();
      client.setJwt(jwt);
      expect(client.getJwt()).toBe(jwt);
      client.clearJwt();
      expect(client.getJwt()).toBeNull();
    });

    it("isAuthenticated returns true for valid JWT", () => {
      const client = makeClient();
      client.setJwt(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      expect(client.isAuthenticated()).toBe(true);
    });

    it("isAuthenticated returns false for expired JWT", () => {
      const client = makeClient();
      client.setJwt(makeExpiredJwt());
      expect(client.isAuthenticated()).toBe(false);
    });

    it("isAuthenticated returns false for malformed JWT", () => {
      const client = makeClient();
      client.setJwt("not.a.jwt");
      expect(client.isAuthenticated()).toBe(false);
    });
  });

  describe("healthCheck", () => {
    it("returns true on 200", async () => {
      const client = makeClient();
      expect(await client.healthCheck()).toBe(true);
    });

    it("returns false on non-ok", async () => {
      mockFetch = createMockFetch({
        health: () => textResponse("error", 503),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      expect(await client.healthCheck()).toBe(false);
    });

    it("returns false on network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );
      const client = makeClient();
      expect(await client.healthCheck()).toBe(false);
    });
  });

  describe("login", () => {
    it("already-registered: skips registration and returns registration=null", async () => {
      const signer = createMockSigner();
      const client = makeClient({ signer });

      const result = await client.login();

      expect(result.registration).toBeNull();
      expect(result.jwt).toBeTruthy();
      expect(result.userId).toBe("user-1");
      expect(client.getJwt()).toBe(result.jwt);
      expect(client.isAuthenticated()).toBe(true);
      expect(signer.getAddress).toHaveBeenCalledTimes(1);
      expect(signer.getBLSPoP).not.toHaveBeenCalled();
    });

    it("already-registered: signs challenge with the wallet address", async () => {
      const signer = createMockSigner();
      const client = makeClient({ signer });

      await client.login();

      expect(signer.signBLS).toHaveBeenCalledWith({
        message: "challenge-hex-abc123",
        dst: "HORIZON_PORTAL_HTTP_SIG",
        address: MOCK_TAPROOT_ADDRESS,
      });
    });

    it("not-registered: auto-registers then logs in (registration is non-null)", async () => {
      let registryCalls = 0;
      mockFetch = createMockFetch({
        registryEntry: () => {
          registryCalls++;
          return textResponse("Not Found", 404);
        },
      });
      vi.stubGlobal("fetch", mockFetch);

      const signer = createMockSigner();
      const client = makeClient({ signer });
      const result = await client.login();

      // 2 registry hits: pre-register check (404) + post-register nonce
      // resync (also 404 here in the mock; the resync swallows the error).
      expect(registryCalls).toBe(2);
      expect(result.registration).not.toBeNull();
      expect(result.registration?.userId).toBe("user-1");
      expect(result.registration?.xpubkey).toBe(POP.xpubkey);
      expect(result.jwt).toBeTruthy();
      expect(client.isAuthenticated()).toBe(true);
      expect(signer.getBLSPoP).toHaveBeenCalledWith(MOCK_TAPROOT_ADDRESS);
    });

    it("not-registered (missing user_id field): auto-registers", async () => {
      mockFetch = createMockFetch({
        registryEntry: () =>
          jsonResponse({
            signer_id: 1,
            next_nonce: 0,
            x_only_pubkey: "ee".repeat(32),
            bls_pubkey: null,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const signer = createMockSigner();
      const client = makeClient({ signer });
      const result = await client.login();

      expect(result.registration).not.toBeNull();
      expect(signer.getBLSPoP).toHaveBeenCalled();
    });

    it("with explicit address: skips signer.getAddress() entirely", async () => {
      const signer = createMockSigner();
      const client = makeClient({ signer });

      const result = await client.login({ address: "tb1explicitaddr" });

      expect(result.jwt).toBeTruthy();
      expect(signer.getAddress).not.toHaveBeenCalled();
      expect(signer.signBLS).toHaveBeenCalledWith(
        expect.objectContaining({ address: "tb1explicitaddr" }),
      );
    });

    it("calls onStep in correct order on the already-registered path", async () => {
      const client = makeClient();
      const steps: string[] = [];
      await client.login({ onStep: (s) => steps.push(s) });
      expect(steps).toEqual([
        "checking_wallet",
        "checking_registration",
        "challenge",
        "signing",
        "authenticating",
      ]);
    });

    it("calls onStep in correct order on the auto-register path", async () => {
      mockFetch = createMockFetch({
        registryEntry: () => textResponse("Not Found", 404),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      const steps: string[] = [];
      await client.login({ onStep: (s) => steps.push(s) });
      expect(steps).toEqual([
        "checking_wallet",
        "checking_registration",
        "pop",
        "signing",
        "registering",
        "challenge",
        "signing",
        "authenticating",
      ]);
    });

    it("with explicit address: omits checking_wallet step", async () => {
      const client = makeClient();
      const steps: string[] = [];
      await client.login({ address: "tb1addr", onStep: (s) => steps.push(s) });
      expect(steps).toEqual([
        "checking_registration",
        "challenge",
        "signing",
        "authenticating",
      ]);
    });

    it("throws NetworkMismatchError when wallet network differs from client", async () => {
      const signer = createMockSigner({ network: "mainnet" });
      const client = makeClient({ signer });

      const promise = client.login();
      await expect(promise).rejects.toBeInstanceOf(NetworkMismatchError);

      try {
        await client.login();
      } catch (err) {
        const mismatch = err as NetworkMismatchError;
        expect(mismatch.walletNetwork).toBe("mainnet");
        expect(mismatch.clientNetwork).toBe("signet");
        expect(mismatch.message).toContain("mainnet");
        expect(mismatch.message).toContain("signet");
      }

      expect(signer.signBLS).not.toHaveBeenCalled();
      expect(signer.getBLSPoP).not.toHaveBeenCalled();
    });

    it("network mismatch is bypassed when explicit address is provided", async () => {
      const signer = createMockSigner({ network: "mainnet" });
      const client = makeClient({ signer });

      const result = await client.login({ address: "tb1explicit" });
      expect(result.jwt).toBeTruthy();
      expect(signer.getAddress).not.toHaveBeenCalled();
    });

    it("propagates non-404 registry errors without falling through to register", async () => {
      mockFetch = createMockFetch({
        registryEntry: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);

      const signer = createMockSigner();
      const client = makeClient({ signer });
      await expect(client.login()).rejects.toThrow("Registry lookup failed");
      expect(signer.getBLSPoP).not.toHaveBeenCalled();
    });

    it("propagates signer.getAddress() failure without touching the Portal", async () => {
      const signer = createMockSigner();
      signer.getAddress.mockRejectedValueOnce(new Error("User rejected"));
      const client = makeClient({ signer });

      await expect(client.login()).rejects.toThrow("User rejected");
      expect(signer.signBLS).not.toHaveBeenCalled();
      expect(signer.getBLSPoP).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(client.getJwt()).toBeNull();
    });

    it("does not leave a stale JWT when login fails after a successful register", async () => {
      let registryCalls = 0;
      mockFetch = createMockFetch({
        registryEntry: () => {
          registryCalls++;
          return textResponse("Not Found", 404);
        },
        loginChallenge: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      await expect(client.login()).rejects.toThrow("Failed to get challenge");
      expect(registryCalls).toBe(1);
      expect(client.getJwt()).toBeNull();
      expect(client.isAuthenticated()).toBe(false);
    });

    it("does not fall through to register when post-registry login throws PortalNotFoundError", async () => {
      // Guard against future regressions: a PortalNotFoundError originating
      // from loginWithUserId (e.g. user_id deleted between registry lookup
      // and login) must NOT silently trigger the register flow. The
      // try/catch around the registry lookup must not absorb errors from
      // the subsequent loginWithUserId call.
      const signer = createMockSigner();
      const client = makeClient({ signer });
      // Wrap loginWithUserId on the prototype to simulate a downstream
      // PortalNotFoundError after the registry lookup.
      const proto = Object.getPrototypeOf(client) as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      const original = proto.loginWithUserId;
      proto.loginWithUserId = vi
        .fn()
        .mockRejectedValue(new PortalNotFoundError("simulated downstream 404"));

      try {
        await expect(client.login()).rejects.toBeInstanceOf(
          PortalNotFoundError,
        );
        expect(signer.getBLSPoP).not.toHaveBeenCalled();
      } finally {
        proto.loginWithUserId = original;
      }
    });

    it("populates result.address from the wallet on auto-resolved path", async () => {
      const signer = createMockSigner();
      const client = makeClient({ signer });
      const result = await client.login();
      expect(result.address).toBe(MOCK_TAPROOT_ADDRESS);
    });

    it("populates result.address from explicit options.address", async () => {
      const client = makeClient();
      const result = await client.login({ address: "tb1explicit" });
      expect(result.address).toBe("tb1explicit");
    });

    it("populates result.xOnlyPubkey and result.blsPubkey on the already-registered path", async () => {
      // Default mock fixture returns x_only_pubkey="ab"*32 and
      // bls_pubkey="cd"*48 on the registry endpoint.
      const client = makeClient();
      const result = await client.login();
      expect(result.registration).toBeNull();
      expect(result.xOnlyPubkey).toBe("ab".repeat(32));
      expect(result.blsPubkey).toBe("cd".repeat(48));
    });

    it("populates result.xOnlyPubkey and result.blsPubkey on the auto-register path from the registration payload", async () => {
      mockFetch = createMockFetch({
        registryEntry: () => textResponse("Not Found", 404),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      const result = await client.login();
      expect(result.registration).not.toBeNull();
      // Default register fixture: x_only_pubkey="ab"*32, bls_pubkey="cd"*48.
      expect(result.xOnlyPubkey).toBe(result.registration?.xOnlyPubkey);
      expect(result.blsPubkey).toBe(result.registration?.blsPubkey);
    });

    describe("nonce reset on login", () => {
      it("force-overwrites a stale local nonce ahead of the Portal", async () => {
        const np = new InMemoryNonceProvider();
        // Local tracker is far ahead (e.g. another tab or stale session).
        await np.reportNonceUsed(42, 100);

        const client = makeClient({ nonceProvider: np });
        client.setJwt(makeJwt());
        await client.login();

        // After login, an upload must use the Portal's authoritative nonce
        // (5, from the default registryEntry fixture), not local + 1 = 101.
        const file = new File(["hi"], "a.txt", { type: "text/plain" });
        await client.uploadFile(file, { xOnlyPubkey: "ab".repeat(32) });

        const filesCall = mockFetch.mock.calls.find(
          (c) =>
            String(c[0]).includes("/api/files") &&
            (c[1]?.method ?? "").toUpperCase() === "POST",
        );
        const body = JSON.parse(filesCall?.[1]?.body as string);
        expect(body.files[0].nonce).toBe(5);
      });

      it("calls setNonce with the raw chainNonce on the already-registered path", async () => {
        const np = new InMemoryNonceProvider();
        const setNonceSpy = vi.spyOn(np, "setNonce");
        const client = makeClient({ nonceProvider: np });
        await client.login();
        expect(setNonceSpy).toHaveBeenCalledWith(42, 5);
      });

      it("calls setNonce with the freshly-fetched chainNonce on the auto-register path", async () => {
        // First registry call (pre-register check) → 404, second call
        // (post-register resync) → registry entry with chainNonce=0.
        let registryCalls = 0;
        mockFetch = createMockFetch({
          registryEntry: () => {
            registryCalls++;
            if (registryCalls === 1) return textResponse("Not Found", 404);
            return jsonResponse({
              signer_id: 7,
              next_nonce: 0,
              user_id: "user-1",
              x_only_pubkey: "ab".repeat(32),
              bls_pubkey: "cd".repeat(48),
            });
          },
        });
        vi.stubGlobal("fetch", mockFetch);

        const np = new InMemoryNonceProvider();
        const setNonceSpy = vi.spyOn(np, "setNonce");
        const client = makeClient({ nonceProvider: np });
        await client.login();

        expect(registryCalls).toBe(2);
        expect(setNonceSpy).toHaveBeenCalledWith(7, 0);
      });

      it("calls setNonce unconditionally even when local is behind the Portal", async () => {
        // The semantics of the reset are "overwrite, no comparison". Even when
        // the local tracker has nothing (or is below the Portal), setNonce must
        // still be invoked so any future custom provider tracking divergence
        // sees the resync event.
        const np = new InMemoryNonceProvider();
        const setNonceSpy = vi.spyOn(np, "setNonce");
        const client = makeClient({ nonceProvider: np });
        await client.login();
        expect(setNonceSpy).toHaveBeenCalledTimes(1);
        expect(setNonceSpy).toHaveBeenCalledWith(42, 5);
      });

      it("works with a custom NonceProvider that omits setNonce (back-compat)", async () => {
        // setNonce is optional on the interface. A pre-existing custom provider
        // that doesn't implement it must keep working — the optional-chaining
        // call site (`setNonce?.()`) must not crash, and login() must succeed.
        const customProvider: NonceProvider = {
          async getNextNonce(_signerId, chainNonce) {
            return chainNonce;
          },
        };
        const client = makeClient({ nonceProvider: customProvider });
        const result = await client.login();
        expect(result.jwt).toBeTruthy();
        expect(result.userId).toBe("user-1");
      });
    });

    describe("registration errors (auto-register path)", () => {
      function makeAutoRegisterFetch(
        registerOverride: () => Response | Promise<Response>,
      ): ReturnType<typeof createMockFetch> {
        return createMockFetch({
          registryEntry: () => textResponse("Not Found", 404),
          register: registerOverride,
        });
      }

      it("throws on 500 with portal unreachable message", async () => {
        mockFetch = makeAutoRegisterFetch(() =>
          textResponse("Internal Server Error", 500),
        );
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        await expect(client.login()).rejects.toThrow(
          "Portal server is unreachable",
        );
      });

      it("throws structured error from server", async () => {
        mockFetch = makeAutoRegisterFetch(() =>
          jsonResponse(
            { error: { code: "DUP", message: "Already registered" } },
            409,
          ),
        );
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        await expect(client.login()).rejects.toThrow("Already registered");
      });

      it("throws on string error body", async () => {
        mockFetch = makeAutoRegisterFetch(() =>
          jsonResponse({ error: "Bad key format" }, 400),
        );
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        await expect(client.login()).rejects.toThrow("Bad key format");
      });

      it("throws on invalid response shape", async () => {
        mockFetch = makeAutoRegisterFetch(() =>
          jsonResponse({ user_id: "u1" }),
        );
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        await expect(client.login()).rejects.toThrow(
          "missing required fields",
        );
      });
    });

    describe("login errors (already-registered path)", () => {
      it("throws on invalid challenge response", async () => {
        mockFetch = createMockFetch({
          loginChallenge: () => jsonResponse({}),
        });
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        await expect(client.login()).rejects.toThrow(
          "Invalid challenge response",
        );
      });

      it("throws on login failure with structured error", async () => {
        mockFetch = createMockFetch({
          loginPost: () =>
            jsonResponse(
              { error: { message: "Invalid signature" } },
              401,
            ),
        });
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        await expect(client.login()).rejects.toThrow("Invalid signature");
      });

      it("throws on missing token in response", async () => {
        mockFetch = createMockFetch({
          loginPost: () => jsonResponse({ user_id: "u1" }),
        });
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        await expect(client.login()).rejects.toThrow("missing token");
      });

      it("extracts role and expiresIn from JWT payload", async () => {
        const exp = Math.floor(Date.now() / 1000) + 7200;
        mockFetch = createMockFetch({
          loginPost: () =>
            jsonResponse({
              token: makeJwt({ exp, role: "admin" }),
              user_id: "user-1",
            }),
        });
        vi.stubGlobal("fetch", mockFetch);
        const client = makeClient();
        const result = await client.login();
        expect(result.role).toBe("admin");
        expect(result.expiresIn).toBeGreaterThan(7000);
      });
    });
  });

  describe("detectWalletNetwork", () => {
    it("returns matches=true when networks align", async () => {
      const signer = createMockSigner({ network: "signet" });
      const client = makeClient({ signer });
      const result = await client.detectWalletNetwork();
      expect(result).toEqual({
        walletNetwork: "signet",
        clientNetwork: "signet",
        matches: true,
      });
    });

    it("returns matches=false when wallet network differs", async () => {
      const signer = createMockSigner({ network: "mainnet" });
      const client = makeClient({ signer });
      const result = await client.detectWalletNetwork();
      expect(result).toEqual({
        walletNetwork: "mainnet",
        clientNetwork: "signet",
        matches: false,
      });
    });

    it("respects explicit walletNetwork override (testnet4)", async () => {
      const signer = createMockSigner({ network: "testnet4" });
      const client = makeClient({ signer, walletNetwork: "testnet4" });
      const result = await client.detectWalletNetwork();
      expect(result.matches).toBe(true);
      expect(result.clientNetwork).toBe("testnet4");
    });

    it("derives clientNetwork=mainnet when network=networks.bitcoin", async () => {
      const signer = createMockSigner({ network: "mainnet" });
      const client = makeClient({ signer, network: networks.bitcoin });
      const result = await client.detectWalletNetwork();
      expect(result.clientNetwork).toBe("mainnet");
      expect(result.matches).toBe(true);
    });
  });

  describe("getSignerInfo", () => {
    it("returns signer info from x-only pubkey", async () => {
      const client = makeClient();
      const info = await client.getSignerInfo("ab".repeat(32));
      expect(info.signerId).toBe(42);
      expect(info.nextNonce).toBe(5);
    });

    it("exposes userId when present in registry response", async () => {
      mockFetch = createMockFetch({
        registryEntry: () =>
          jsonResponse({
            signer_id: 42,
            next_nonce: 5,
            user_id: "user-42",
            x_only_pubkey: "ab".repeat(32),
            bls_pubkey: "cd".repeat(48),
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      const info = await client.getSignerInfo("ab".repeat(32));
      expect(info.userId).toBe("user-42");
    });

    it("leaves userId undefined when absent from response", async () => {
      mockFetch = createMockFetch({
        registryEntry: () =>
          jsonResponse({
            signer_id: 1,
            next_nonce: 0,
            x_only_pubkey: "ee".repeat(32),
            bls_pubkey: null,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      const info = await client.getSignerInfo("pub");
      expect(info.userId).toBeUndefined();
    });

    it("exposes xOnlyPubkey and blsPubkey from the registry response", async () => {
      const client = makeClient();
      const info = await client.getSignerInfo("ab".repeat(32));
      expect(info.xOnlyPubkey).toBe("ab".repeat(32));
      expect(info.blsPubkey).toBe("cd".repeat(48));
    });

    it("returns blsPubkey=null when the registry entry has no bound BLS key", async () => {
      mockFetch = createMockFetch({
        registryEntry: () =>
          jsonResponse({
            signer_id: 1,
            next_nonce: 0,
            x_only_pubkey: "ee".repeat(32),
            bls_pubkey: null,
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      const info = await client.getSignerInfo("pub");
      expect(info.blsPubkey).toBeNull();
    });

    it("throws when x_only_pubkey is missing from the registry response", async () => {
      mockFetch = createMockFetch({
        registryEntry: () =>
          jsonResponse({ signer_id: 1, next_nonce: 0 }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getSignerInfo("pub")).rejects.toThrow(
        "missing x_only_pubkey",
      );
    });

    it("treats next_nonce: null as 0 (fresh signer, no ops yet)", async () => {
      mockFetch = createMockFetch({
        registryEntry: () =>
          jsonResponse({
            signer_id: 7,
            next_nonce: null,
            x_only_pubkey: "ee".repeat(32),
            bls_pubkey: "cd".repeat(96),
          }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      const info = await client.getSignerInfo("ee".repeat(32));
      expect(info.chainNonce).toBe(0);
      expect(info.nextNonce).toBe(0);
    });

    it("accepts a numeric signer_id", async () => {
      const client = makeClient();
      const info = await client.getSignerInfo("0");
      expect(info.signerId).toBe(42);
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/signers/"),
      );
      expect(String(call?.[0])).toContain("/api/signers/0");
    });

    it("accepts a Bitcoin address (URL-encoded)", async () => {
      const client = makeClient();
      const address = "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqc8gma6";
      const info = await client.getSignerInfo(address);
      expect(info.signerId).toBe(42);
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/signers/"),
      );
      expect(String(call?.[0])).toContain(
        `/api/signers/${encodeURIComponent(address)}`,
      );
    });

    it("includes auth header when JWT is set", async () => {
      const client = makeClient();
      client.setJwt(makeJwt());
      await client.getSignerInfo("pub");
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/signers/"),
      );
      expect(call?.[1]?.headers).toHaveProperty("Authorization");
    });

    it("throws PortalNotFoundError on 404", async () => {
      mockFetch = createMockFetch({
        registryEntry: () => textResponse("Not Found", 404),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(
        client.getSignerInfo("missing"),
      ).rejects.toBeInstanceOf(PortalNotFoundError);
    });

    it("throws generic error on other failures", async () => {
      mockFetch = createMockFetch({
        registryEntry: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getSignerInfo("pub")).rejects.toThrow(
        "Registry lookup failed",
      );
    });

    it("integrates with nonce provider", async () => {
      const np = new InMemoryNonceProvider();
      await np.reportNonceUsed(42, 100);
      const client = makeClient({ nonceProvider: np });
      const info = await client.getSignerInfo("pub");
      expect(info.nextNonce).toBe(101);
    });
  });

  describe("uploadFile", () => {
    function makeFile(
      name = "test.txt",
      content = "hello world",
      type = "text/plain",
    ): File {
      return new File([content], name, { type });
    }

    function uploadOpts(overrides?: Record<string, unknown>) {
      return {
        xOnlyPubkey: "ab".repeat(32),
        onStep: vi.fn(),
        onUploadProgress: vi.fn(),
        ...overrides,
      };
    }

    it("throws when not authenticated", async () => {
      const client = makeClient();
      await expect(
        client.uploadFile(makeFile(), uploadOpts()),
      ).rejects.toThrow("Not authenticated");
    });

    it("happy path: full upload flow", async () => {
      const client = makeClient();
      client.setJwt(makeJwt());

      const opts = uploadOpts();
      const result = await client.uploadFile(makeFile(), opts);

      expect(result.sessionId).toBe("session-1");
      expect(result.fileId).toBe(PREPARE_RESULT.metadata.fileId);
      expect(result.merkleRoot).toBe(PREPARE_RESULT.metadata.root);
      expect(result.filename).toBe("test.txt");
      expect(result.size).toBe(11);
    });

    it("calls onStep in correct order", async () => {
      const client = makeClient();
      client.setJwt(makeJwt());
      const steps: string[] = [];
      await client.uploadFile(makeFile(), {
        xOnlyPubkey: "ab".repeat(32),
        onStep: (s) => steps.push(s),
      });
      expect(steps).toEqual([
        "preparing",
        "signing",
        "initiating",
        "uploading",
        "validating",
      ]);
    });

    it("reports upload progress", async () => {
      const client = makeClient();
      client.setJwt(makeJwt());
      const progressFn = vi.fn();
      await client.uploadFile(makeFile(), {
        xOnlyPubkey: "ab".repeat(32),
        onUploadProgress: progressFn,
      });
      expect(progressFn).toHaveBeenCalled();
      const lastCall = progressFn.mock.calls[progressFn.mock.calls.length - 1];
      expect(lastCall[0]).toBe(lastCall[1]);
    });

    it("handles multi-chunk upload with 308", async () => {
      const bigContent = "x".repeat(256 * 1024 + 100);
      const bigFile = makeFile("big.bin", bigContent, "application/octet-stream");
      let putCount = 0;

      mockFetch = createMockFetch({
        uploadPut: () => {
          putCount++;
          if (putCount === 1) return new Response(null, { status: 308 });
          return new Response(null, { status: 200 });
        },
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      client.setJwt(makeJwt());
      const result = await client.uploadFile(bigFile, uploadOpts());
      expect(result.size).toBe(bigContent.length);
      expect(putCount).toBe(2);
    });

    it("recovers from last-chunk network error (Failed to fetch)", async () => {
      mockFetch = createMockFetch({
        uploadPut: () => {
          throw new Error("Failed to fetch");
        },
      });
      vi.stubGlobal("fetch", mockFetch);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = makeClient();
      client.setJwt(makeJwt());
      const result = await client.uploadFile(makeFile(), uploadOpts());
      expect(result.sessionId).toBe("session-1");
      warnSpy.mockRestore();
    });

    it("throws on non-last-chunk network error", async () => {
      const bigContent = "x".repeat(256 * 1024 + 100);
      const bigFile = makeFile("big.bin", bigContent);
      mockFetch = createMockFetch({
        uploadPut: () => {
          throw new Error("Connection reset");
        },
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      client.setJwt(makeJwt());
      await expect(
        client.uploadFile(bigFile, uploadOpts()),
      ).rejects.toThrow("Network error during upload");
    });

    it("throws on upload initiation failure", async () => {
      mockFetch = createMockFetch({
        filesPost: () => textResponse("Quota exceeded", 429),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      client.setJwt(makeJwt());
      await expect(
        client.uploadFile(makeFile(), uploadOpts()),
      ).rejects.toThrow("Upload initiation failed (429)");
    });

    it("surfaces Portal `error.message` from a JSON 400 response", async () => {
      mockFetch = createMockFetch({
        filesPost: () =>
          jsonResponse(
            {
              error: {
                code: "INVALID_REQUEST",
                message: "nft_id cannot be empty",
                status: 400,
              },
            },
            400,
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      client.setJwt(makeJwt());
      await expect(
        client.uploadFile(makeFile(), uploadOpts()),
      ).rejects.toThrow("nft_id cannot be empty");
    });

    it("surfaces Portal `error.message` from a JSON 409 NFT_ALREADY_MINTED response", async () => {
      mockFetch = createMockFetch({
        filesPost: () =>
          jsonResponse(
            {
              error: {
                code: "NFT_ALREADY_MINTED",
                message: "NFT mona-lisa-001 is already used by another mint",
                status: 409,
              },
            },
            409,
          ),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      client.setJwt(makeJwt());
      await expect(
        client.uploadFile(
          makeFile(),
          uploadOpts({ nft: { nftId: "mona-lisa-001" } }),
        ),
      ).rejects.toThrow("NFT mona-lisa-001 is already used by another mint");
    });

    it("throws when upload URL is missing", async () => {
      mockFetch = createMockFetch({
        filesPost: () => jsonResponse({ uploads: [{}] }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      client.setJwt(makeJwt());
      await expect(
        client.uploadFile(makeFile(), uploadOpts()),
      ).rejects.toThrow("missing upload URL");
    });

    it("throws on chunk upload error status", async () => {
      mockFetch = createMockFetch({
        uploadPut: () => textResponse("Server Error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      client.setJwt(makeJwt());
      await expect(
        client.uploadFile(makeFile(), uploadOpts()),
      ).rejects.toThrow("Upload failed with status 500");
    });

    it("defaults mime type to application/octet-stream", async () => {
      const client = makeClient();
      client.setJwt(makeJwt());
      const noTypeFile = new File(["data"], "noext");
      await client.uploadFile(noTypeFile, uploadOpts());

      const putCall = mockFetch.mock.calls.find(
        (c) => String(c[0]) === UPLOAD_URL,
      );
      const headers = putCall?.[1]?.headers as Record<string, string> | undefined;
      expect(headers?.["Content-Type"]).toBe("application/octet-stream");
    });

    it("passes tags to initiation request", async () => {
      const client = makeClient();
      client.setJwt(makeJwt());
      await client.uploadFile(
        makeFile(),
        uploadOpts({ tags: ["photo", "vacation"] }),
      );

      const filesCall = mockFetch.mock.calls.find(
        (c) =>
          String(c[0]).includes("/api/files") &&
          c[1]?.method === "POST",
      );
      const body = JSON.parse(filesCall?.[1]?.body as string);
      expect(body.files[0].tags).toEqual(["photo", "vacation"]);
    });

    it("reports nonce to nonceProvider after upload", async () => {
      const np = new InMemoryNonceProvider();
      const reportSpy = vi.spyOn(np, "reportNonceUsed");
      const client = makeClient({ nonceProvider: np });
      client.setJwt(makeJwt());

      await client.uploadFile(makeFile(), uploadOpts());
      expect(reportSpy).toHaveBeenCalledWith(42, 5);
    });

    describe("with NFT mint payload", () => {
      it("includes nft in the request body and signs over mint(...) with the default NFT contract", async () => {
        const signer = createMockSigner();
        const client = makeClient({ signer });
        client.setJwt(makeJwt());

        await client.uploadFile(
          makeFile(),
          uploadOpts({
            nft: {
              nftId: "nft-1",
              attributes: [{ key: "k", value: "v" }],
            },
          }),
        );

        const filesCall = mockFetch.mock.calls.find(
          (c) =>
            String(c[0]).includes("/api/files") &&
            (c[1]?.method ?? "").toUpperCase() === "POST",
        );
        const body = JSON.parse(filesCall?.[1]?.body as string);
        expect(body.files[0].nft).toEqual({
          nft_id: "nft-1",
          attributes: [{ key: "k", value: "v" }],
        });

        const expectedExpr = buildMintNftExpr(
          "nft-1",
          [{ key: "k", value: "v" }],
          PREPARE_RESULT.metadata.fileId,
          PREPARE_RESULT.metadata.objectId,
          PREPARE_RESULT.metadata.root,
          PREPARE_RESULT.metadata.paddedLen,
          11,
          "test.txt",
        );
        const expectedMessage = buildCreateAgreementMessage(
          42,
          5,
          "nft_0_0",
          expectedExpr,
        );
        expect(signer.signBLS).toHaveBeenCalledWith(
          expect.objectContaining({
            messageHex: bytesToHex(expectedMessage),
          }),
        );
      });

      it("uses the configured kontorNftContractAddress when overridden", async () => {
        const signer = createMockSigner();
        const client = makeClient({
          signer,
          kontorNftContractAddress: "nft_test_42",
        });
        client.setJwt(makeJwt());

        await client.uploadFile(
          makeFile(),
          uploadOpts({
            nft: {
              nftId: "nft-1",
              attributes: [],
            },
          }),
        );

        const expectedExpr = buildMintNftExpr(
          "nft-1",
          [],
          PREPARE_RESULT.metadata.fileId,
          PREPARE_RESULT.metadata.objectId,
          PREPARE_RESULT.metadata.root,
          PREPARE_RESULT.metadata.paddedLen,
          11,
          "test.txt",
        );
        const expectedMessage = buildCreateAgreementMessage(
          42,
          5,
          "nft_test_42",
          expectedExpr,
        );
        expect(signer.signBLS).toHaveBeenCalledWith(
          expect.objectContaining({
            messageHex: bytesToHex(expectedMessage),
          }),
        );
      });

      it("defaults missing attributes to [] in both expr and request body", async () => {
        const signer = createMockSigner();
        const client = makeClient({ signer });
        client.setJwt(makeJwt());

        await client.uploadFile(
          makeFile(),
          uploadOpts({
            nft: { nftId: "nft-2" },
          }),
        );

        const filesCall = mockFetch.mock.calls.find(
          (c) =>
            String(c[0]).includes("/api/files") &&
            (c[1]?.method ?? "").toUpperCase() === "POST",
        );
        const body = JSON.parse(filesCall?.[1]?.body as string);
        expect(body.files[0].nft).toEqual({
          nft_id: "nft-2",
          attributes: [],
        });
      });
    });
  });

  describe("getAgreement", () => {
    it("returns agreement", async () => {
      const client = makeClient();
      const agr = await client.getAgreement("agr-1");
      expect(agr.agreement_id).toBe("agr-1");
    });

    it("throws PortalNotFoundError on 404", async () => {
      mockFetch = createMockFetch({
        agreementGet: () => textResponse("Not Found", 404),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      await expect(
        client.getAgreement("missing"),
      ).rejects.toBeInstanceOf(PortalNotFoundError);
    });

    it("throws on other errors", async () => {
      mockFetch = createMockFetch({
        agreementGet: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      await expect(client.getAgreement("agr-1")).rejects.toThrow(
        "Failed to fetch agreement",
      );
    });

    it("works without JWT (public endpoint)", async () => {
      const client = makeClient();
      const agr = await client.getAgreement("agr-1");
      expect(agr.agreement_id).toBe("agr-1");

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements/agr-1"),
      );
      expect(call).toBeDefined();
      const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
    });
  });

  describe("listAgreements", () => {
    it("returns paginated response with defaults", async () => {
      const client = makeClient();
      const res = await client.listAgreements();
      expect(res.agreements).toHaveLength(1);

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(String(call?.[0])).toContain("limit=20");
      expect(String(call?.[0])).toContain("offset=0");
    });

    it("passes custom limit and offset", async () => {
      const client = makeClient();
      await client.listAgreements({ limit: 5, offset: 10 });

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(String(call?.[0])).toContain("limit=5");
      expect(String(call?.[0])).toContain("offset=10");
    });

    it("throws on failure", async () => {
      mockFetch = createMockFetch({
        agreementsList: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);

      const client = makeClient();
      await expect(client.listAgreements()).rejects.toThrow(
        "Failed to list agreements",
      );
    });

    it("works without JWT (public endpoint)", async () => {
      const client = makeClient();
      await client.listAgreements();

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(call).toBeDefined();
      const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
    });

    it("passes status filter as string", async () => {
      const client = makeClient();
      await client.listAgreements({ status: "ready" });

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("status")).toBe("ready");
    });

    it("passes status filter as array (joined by |)", async () => {
      const client = makeClient();
      await client.listAgreements({ status: ["ready", "pending"] });

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(String(call?.[0])).toContain("status=ready%7Cpending");
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("status")).toBe("ready|pending");
    });

    it("passes users filter (joined by ,)", async () => {
      const client = makeClient();
      await client.listAgreements({ users: ["user-1", "user-2"] });

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(String(call?.[0])).toContain("users=user-1%2Cuser-2");
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("users")).toBe("user-1,user-2");
    });

    it("passes nodes filter (joined by ,)", async () => {
      const client = makeClient();
      await client.listAgreements({ nodes: ["node-1", "node-2"] });

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(String(call?.[0])).toContain("nodes=node-1%2Cnode-2");
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("nodes")).toBe("node-1,node-2");
    });

    it("passes mimeType as mime_type", async () => {
      const client = makeClient();
      await client.listAgreements({ mimeType: "application/pdf" });

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(String(call?.[0])).toContain("mime_type=application%2Fpdf");
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("mime_type")).toBe("application/pdf");
    });

    it("passes sort and sort_dir", async () => {
      const client = makeClient();
      await client.listAgreements({ sort: "size", sortDir: "asc" });

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      expect(String(call?.[0])).toContain("sort=size");
      expect(String(call?.[0])).toContain("sort_dir=asc");
    });

    it("omits undefined filters", async () => {
      const client = makeClient();
      await client.listAgreements({});

      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/agreements?"),
      );
      const url = new URL(String(call?.[0]));
      const queryString = url.search.replace(/^\?/, "");
      expect(queryString).toBe("limit=20&offset=0");
    });
  });

  describe("getDownloadUrl", () => {
    function findDownloadCall() {
      return mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/download"),
      );
    }

    it("returns the download URL", async () => {
      const client = makeClient();
      const result = await client.getDownloadUrl("agr-1");
      expect(result.downloadUrl).toBe(DOWNLOAD_URL);
    });

    it("requests no_redirect=true so the API returns JSON", async () => {
      const client = makeClient();
      await client.getDownloadUrl("agr-1");
      const call = findDownloadCall();
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("no_redirect")).toBe("true");
    });

    it("encodes the agreement id", async () => {
      const client = makeClient();
      await client.getDownloadUrl("file_with/slash");
      const call = findDownloadCall();
      expect(String(call?.[0])).toContain(
        "/api/agreements/file_with%2Fslash/download",
      );
    });

    it("passes force_download when requested", async () => {
      const client = makeClient();
      await client.getDownloadUrl("agr-1", { forceDownload: true });
      const call = findDownloadCall();
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("force_download")).toBe("true");
    });

    it("omits force_download by default", async () => {
      const client = makeClient();
      await client.getDownloadUrl("agr-1");
      const call = findDownloadCall();
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("force_download")).toBeNull();
    });

    it("works without JWT (public endpoint)", async () => {
      const client = makeClient();
      await client.getDownloadUrl("agr-1");
      const call = findDownloadCall();
      const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
    });

    it("throws PortalNotFoundError on 404", async () => {
      mockFetch = createMockFetch({
        agreementDownload: () => textResponse("Not Found", 404),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getDownloadUrl("missing")).rejects.toBeInstanceOf(
        PortalNotFoundError,
      );
    });

    it("throws structured error from server (e.g. 403 INVALID_STATUS)", async () => {
      mockFetch = createMockFetch({
        agreementDownload: () =>
          jsonResponse(
            {
              error: {
                code: "INVALID_STATUS",
                message: "Agreement must be in ready or confirmed status to download",
                status: 403,
              },
            },
            403,
          ),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getDownloadUrl("agr-1")).rejects.toThrow(
        "Agreement must be in ready or confirmed status to download",
      );
    });

    it("throws on 503 NO_AVAILABLE_NODE", async () => {
      mockFetch = createMockFetch({
        agreementDownload: () =>
          jsonResponse(
            {
              error: {
                code: "NO_AVAILABLE_NODE",
                message: "No storage node with a public URL is available for this agreement",
                status: 503,
              },
            },
            503,
          ),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getDownloadUrl("agr-1")).rejects.toThrow(
        "No storage node",
      );
    });

    it("throws on invalid response shape", async () => {
      mockFetch = createMockFetch({
        agreementDownload: () => jsonResponse({}),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getDownloadUrl("agr-1")).rejects.toThrow(
        "missing download_url",
      );
    });
  });

  describe("downloadFile", () => {
    it("returns a Blob with the file contents", async () => {
      const client = makeClient();
      const blob = await client.downloadFile("agr-1");
      expect(blob).toBeInstanceOf(Blob);
      expect(await blob.text()).toBe(DOWNLOAD_FILE_CONTENT);
    });

    it("forwards forceDownload to the URL request", async () => {
      const client = makeClient();
      await client.downloadFile("agr-1", { forceDownload: true });
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/download"),
      );
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("force_download")).toBe("true");
    });

    it("throws when the signed URL fetch fails", async () => {
      mockFetch = createMockFetch({
        signedDownload: () => textResponse("Forbidden", 403),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.downloadFile("agr-1")).rejects.toThrow(
        "Failed to download file",
      );
    });

    it("propagates PortalNotFoundError from getDownloadUrl", async () => {
      mockFetch = createMockFetch({
        agreementDownload: () => textResponse("Not Found", 404),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.downloadFile("missing")).rejects.toBeInstanceOf(
        PortalNotFoundError,
      );
    });
  });

  describe("getNft", () => {
    it("returns the NFT for a valid nft_id", async () => {
      const client = makeClient();
      const nft = await client.getNft("mona-lisa-001");
      expect(nft.nft_id).toBe("mona-lisa-001");
      expect(nft.attributes).toHaveLength(1);
    });

    it("throws PortalNotFoundError on 404", async () => {
      mockFetch = createMockFetch({
        nftGet: () => textResponse("Not Found", 404),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getNft("missing")).rejects.toBeInstanceOf(
        PortalNotFoundError,
      );
    });

    it("throws on other errors", async () => {
      mockFetch = createMockFetch({
        nftGet: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.getNft("mona-lisa-001")).rejects.toThrow(
        "Failed to fetch NFT",
      );
    });

    it("works without JWT (public endpoint)", async () => {
      const client = makeClient();
      await client.getNft("mona-lisa-001");
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts/mona-lisa-001"),
      );
      expect(call).toBeDefined();
      const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
    });
  });

  describe("listNfts", () => {
    it("returns paginated response with defaults", async () => {
      const client = makeClient();
      const res = await client.listNfts();
      expect(res.nfts).toHaveLength(1);
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      expect(String(call?.[0])).toContain("limit=20");
      expect(String(call?.[0])).toContain("offset=0");
    });

    it("passes custom limit and offset", async () => {
      const client = makeClient();
      await client.listNfts({ limit: 5, offset: 10 });
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      expect(String(call?.[0])).toContain("limit=5");
      expect(String(call?.[0])).toContain("offset=10");
    });

    it("passes status filter as string", async () => {
      const client = makeClient();
      await client.listNfts({ status: "confirmed" });
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("status")).toBe("confirmed");
    });

    it("passes status filter as array (joined by |)", async () => {
      const client = makeClient();
      await client.listNfts({ status: ["ready", "confirmed"] });
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("status")).toBe("ready|confirmed");
    });

    it("passes users filter (joined by ,)", async () => {
      const client = makeClient();
      await client.listNfts({ users: ["user-1", "user-2"] });
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("users")).toBe("user-1,user-2");
    });

    it("passes mimeType filter", async () => {
      const client = makeClient();
      await client.listNfts({ mimeType: "image/png" });
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("mime_type")).toBe("image/png");
    });

    it("passes sort and sortDir", async () => {
      const client = makeClient();
      await client.listNfts({ sort: "nft_id", sortDir: "asc" });
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      const url = new URL(String(call?.[0]));
      expect(url.searchParams.get("sort")).toBe("nft_id");
      expect(url.searchParams.get("sort_dir")).toBe("asc");
    });

    it("throws on failure", async () => {
      mockFetch = createMockFetch({
        nftsList: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.listNfts()).rejects.toThrow("Failed to list NFTs");
    });

    it("works without JWT (public endpoint)", async () => {
      const client = makeClient();
      await client.listNfts();
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/nfts?"),
      );
      expect(call).toBeDefined();
      const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
    });
  });
});
