import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KontorPortalClient,
  InMemoryNonceProvider,
} from "../kontor-portal-client";
import { PortalNotFoundError } from "../types";
import { createMockSigner } from "./helpers/mock-signer";
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
import type { KontorPortalClientConfig } from "../types";

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

  describe("register", () => {
    it("happy path: returns RegistrationResult", async () => {
      const signer = createMockSigner();
      const client = makeClient({ signer });

      const result = await client.register("tb1addr");
      expect(result.userId).toBe("user-1");
      expect(result.xOnlyPubkey).toBe("ab".repeat(32));
      expect(result.blsPubkey).toBe("cd".repeat(48));
      expect(result.xpubkey).toBe(POP.xpubkey);
    });

    it("calls onStep in correct order", async () => {
      const client = makeClient();
      const steps: string[] = [];
      await client.register("tb1addr", {
        onStep: (s) => steps.push(s),
      });
      expect(steps).toEqual(["pop", "signing", "registering"]);
    });

    it("calls signer.getBLSPoP with the taproot address", async () => {
      const signer = createMockSigner();
      const client = makeClient({ signer });
      await client.register("tb1myaddr");
      expect(signer.getBLSPoP).toHaveBeenCalledWith("tb1myaddr");
      expect(signer.signBLS).toHaveBeenCalledWith(
        expect.objectContaining({ address: "tb1myaddr" }),
      );
    });

    it("throws on 500 with portal unreachable message", async () => {
      mockFetch = createMockFetch({
        register: () => textResponse("Internal Server Error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.register("addr")).rejects.toThrow(
        "Portal server is unreachable",
      );
    });

    it("throws structured error from server", async () => {
      mockFetch = createMockFetch({
        register: () =>
          jsonResponse(
            { error: { code: "DUP", message: "Already registered" } },
            409,
          ),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.register("addr")).rejects.toThrow(
        "Already registered",
      );
    });

    it("throws on string error body", async () => {
      mockFetch = createMockFetch({
        register: () =>
          jsonResponse({ error: "Bad key format" }, 400),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.register("addr")).rejects.toThrow("Bad key format");
    });

    it("throws on invalid response shape", async () => {
      mockFetch = createMockFetch({
        register: () => jsonResponse({ user_id: "u1" }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.register("addr")).rejects.toThrow(
        "missing required fields",
      );
    });
  });

  describe("login", () => {
    it("happy path: returns LoginResult and stores JWT", async () => {
      const client = makeClient();
      const result = await client.login("user-1", "tb1addr");
      expect(result.jwt).toBeTruthy();
      expect(result.userId).toBe("user-1");
      expect(client.getJwt()).toBe(result.jwt);
      expect(client.isAuthenticated()).toBe(true);
    });

    it("calls onStep in correct order", async () => {
      const client = makeClient();
      const steps: string[] = [];
      await client.login("user-1", "tb1addr", { onStep: (s) => steps.push(s) });
      expect(steps).toEqual(["challenge", "signing", "authenticating"]);
    });

    it("throws on challenge failure", async () => {
      mockFetch = createMockFetch({
        loginChallenge: () => textResponse("error", 500),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.login("user-1", "tb1addr")).rejects.toThrow(
        "Failed to get challenge",
      );
    });

    it("throws on invalid challenge response", async () => {
      mockFetch = createMockFetch({
        loginChallenge: () => jsonResponse({}),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.login("user-1", "tb1addr")).rejects.toThrow(
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
      await expect(client.login("user-1", "tb1addr")).rejects.toThrow(
        "Invalid signature",
      );
    });

    it("throws on missing token in response", async () => {
      mockFetch = createMockFetch({
        loginPost: () => jsonResponse({ user_id: "u1" }),
      });
      vi.stubGlobal("fetch", mockFetch);
      const client = makeClient();
      await expect(client.login("user-1", "tb1addr")).rejects.toThrow("missing token");
    });

    it("signs challenge with correct DST and address", async () => {
      const signer = createMockSigner();
      const client = makeClient({ signer });
      await client.login("user-1", "tb1addr");
      expect(signer.signBLS).toHaveBeenCalledWith({
        message: "challenge-hex-abc123",
        dst: "HORIZON_PORTAL_HTTP_SIG",
        address: "tb1addr",
      });
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
      const result = await client.login("user-1", "tb1addr");
      expect(result.role).toBe("admin");
      expect(result.expiresIn).toBeGreaterThan(7000);
    });
  });

  describe("getSignerInfo", () => {
    it("returns signer info", async () => {
      const client = makeClient();
      const info = await client.getSignerInfo("ab".repeat(32));
      expect(info.signerId).toBe(42);
      expect(info.nextNonce).toBe(5);
    });

    it("includes auth header when JWT is set", async () => {
      const client = makeClient();
      client.setJwt(makeJwt());
      await client.getSignerInfo("pub");
      const call = mockFetch.mock.calls.find((c) =>
        String(c[0]).includes("/api/registry/entry/"),
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
      ).rejects.toThrow("Upload initiation failed");
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
});
