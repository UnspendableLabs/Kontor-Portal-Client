import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { PortalClientProvider, usePortalClient } from "../use-portal-client";
import type { KontorPortalClientConfig } from "../types";
import { createMockSigner } from "./helpers/mock-signer";
import { createMockCrypto } from "./helpers/mock-crypto";
import { createMockFetch } from "./helpers/mock-fetch";
import { PORTAL_HOST, makeJwt, makeExpiredJwt } from "./helpers/fixtures";

function createMockLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, String(value))),
    removeItem: vi.fn((key: string) => store.delete(key)),
    clear: vi.fn(() => store.clear()),
    get length() {
      return store.size;
    },
    key: vi.fn((index: number) => [...store.keys()][index] ?? null),
  };
}

function makeConfig(
  overrides?: Partial<KontorPortalClientConfig>,
): KontorPortalClientConfig {
  return {
    portalHost: PORTAL_HOST,
    signer: createMockSigner(),
    crypto: createMockCrypto(),
    validationDelayMs: 0,
    ...overrides,
  };
}

function wrapper(config: KontorPortalClientConfig) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <PortalClientProvider config={config}>{children}</PortalClientProvider>
    );
  };
}

describe("usePortalClient", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let mockStorage: ReturnType<typeof createMockLocalStorage>;

  beforeEach(() => {
    mockStorage = createMockLocalStorage();
    vi.stubGlobal("localStorage", mockStorage);
    mockFetch = createMockFetch();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when used outside PortalClientProvider", () => {
    expect(() => {
      renderHook(() => usePortalClient());
    }).toThrow("usePortalClient must be used within a PortalClientProvider");
  });

  it("starts with needs_registration when no stored data", async () => {
    const config = makeConfig();
    const { result } = renderHook(() => usePortalClient(), {
      wrapper: wrapper(config),
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe("needs_registration");
    });
    expect(result.current.jwt).toBeNull();
    expect(result.current.isRegistered).toBe(false);
  });

  it("restores authenticated state from valid stored JWT", async () => {
    const jwt = makeJwt();
    mockStorage.setItem("portal_jwt", jwt);
    mockStorage.setItem("portal_user_id", "user-1");

    const config = makeConfig();
    const { result } = renderHook(() => usePortalClient(), {
      wrapper: wrapper(config),
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe("authenticated");
    });
    expect(result.current.jwt).toBe(jwt);
    expect(result.current.portalUserId).toBe("user-1");
  });

  it("falls back to needs_login when stored JWT is expired", async () => {
    mockStorage.setItem("portal_jwt", makeExpiredJwt());
    mockStorage.setItem("portal_user_id", "user-1");

    const config = makeConfig();
    const { result } = renderHook(() => usePortalClient(), {
      wrapper: wrapper(config),
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe("needs_login");
    });
    expect(result.current.jwt).toBeNull();
  });

  it("falls back to needs_registration when expired JWT and no user", async () => {
    mockStorage.setItem("portal_jwt", makeExpiredJwt());

    const config = makeConfig();
    const { result } = renderHook(() => usePortalClient(), {
      wrapper: wrapper(config),
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe("needs_registration");
    });
  });

  it("shows needs_login when user exists but no JWT", async () => {
    mockStorage.setItem("portal_user_id", "user-1");

    const config = makeConfig();
    const { result } = renderHook(() => usePortalClient(), {
      wrapper: wrapper(config),
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe("needs_login");
    });
  });

  describe("login", () => {
    it("transitions through logging_in to authenticated", async () => {
      mockStorage.setItem("portal_user_id", "user-1");

      const config = makeConfig();
      const { result } = renderHook(() => usePortalClient(), {
        wrapper: wrapper(config),
      });

      await vi.waitFor(() => {
        expect(result.current.status).toBe("needs_login");
      });

      await act(async () => {
        await result.current.login();
      });

      expect(result.current.status).toBe("authenticated");
      expect(result.current.jwt).toBeTruthy();
      expect(mockStorage.getItem("portal_jwt")).toBeTruthy();
    });

    it("sets error when no user ID", async () => {
      const config = makeConfig();
      const { result } = renderHook(() => usePortalClient(), {
        wrapper: wrapper(config),
      });

      await vi.waitFor(() => {
        expect(result.current.status).not.toBe("loading");
      });

      await act(async () => {
        await result.current.login();
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toContain("register first");
    });

    it("handles login failure", async () => {
      mockStorage.setItem("portal_user_id", "user-1");
      mockFetch = createMockFetch({
        loginChallenge: () => new Response("fail", { status: 500 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const config = makeConfig();
      const { result } = renderHook(() => usePortalClient(), {
        wrapper: wrapper(config),
      });

      await vi.waitFor(() => {
        expect(result.current.status).toBe("needs_login");
      });

      await act(async () => {
        await result.current.login();
      });

      expect(result.current.status).toBe("error");
      expect(result.current.error).toBeTruthy();
    });
  });

  describe("logout", () => {
    it("clears JWT and goes to needs_login", async () => {
      mockStorage.setItem("portal_user_id", "user-1");

      const config = makeConfig();
      const { result } = renderHook(() => usePortalClient(), {
        wrapper: wrapper(config),
      });

      await vi.waitFor(() => {
        expect(result.current.status).toBe("needs_login");
      });

      await act(async () => {
        await result.current.login();
      });
      expect(result.current.status).toBe("authenticated");

      act(() => {
        result.current.logout();
      });

      expect(result.current.status).toBe("needs_login");
      expect(result.current.jwt).toBeNull();
      expect(mockStorage.getItem("portal_jwt")).toBeNull();
    });
  });

  describe("saveRegistration", () => {
    it("stores registration data and transitions to needs_login", async () => {
      const config = makeConfig();
      const { result } = renderHook(() => usePortalClient(), {
        wrapper: wrapper(config),
      });

      await vi.waitFor(() => {
        expect(result.current.status).toBe("needs_registration");
      });

      act(() => {
        result.current.saveRegistration({
          portalUserId: "user-42",
          xpubkey: "xpub-test",
          xOnlyPubkey: "xonly-test",
          blsPubkey: "bls-test",
        });
      });

      expect(result.current.status).toBe("needs_login");
      expect(result.current.portalUserId).toBe("user-42");
      expect(result.current.xpubkey).toBe("xpub-test");
      expect(result.current.xOnlyPubkey).toBe("xonly-test");
      expect(result.current.blsPubkey).toBe("bls-test");
      expect(result.current.isRegistered).toBe(true);
      expect(mockStorage.getItem("portal_user_id")).toBe("user-42");
    });
  });

  describe("reset", () => {
    it("clears all state and storage", async () => {
      mockStorage.setItem("portal_user_id", "user-1");
      mockStorage.setItem("portal_jwt", makeJwt());
      mockStorage.setItem("portal_xpubkey", "xpub");
      mockStorage.setItem("portal_x_only_pubkey", "xonly");
      mockStorage.setItem("portal_bls_pubkey", "bls");

      const config = makeConfig();
      const { result } = renderHook(() => usePortalClient(), {
        wrapper: wrapper(config),
      });

      await vi.waitFor(() => {
        expect(result.current.status).toBe("authenticated");
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.status).toBe("needs_registration");
      expect(result.current.jwt).toBeNull();
      expect(result.current.portalUserId).toBeNull();
      expect(result.current.xpubkey).toBeNull();
      expect(result.current.xOnlyPubkey).toBeNull();
      expect(result.current.blsPubkey).toBeNull();
      expect(result.current.isRegistered).toBe(false);
      expect(mockStorage.getItem("portal_jwt")).toBeNull();
      expect(mockStorage.getItem("portal_user_id")).toBeNull();
    });
  });

  it("restores stored xpubkey and blsPubkey", async () => {
    mockStorage.setItem("portal_user_id", "user-1");
    mockStorage.setItem("portal_xpubkey", "xpub-restored");
    mockStorage.setItem("portal_x_only_pubkey", "xonly-restored");
    mockStorage.setItem("portal_bls_pubkey", "bls-restored");

    const config = makeConfig();
    const { result } = renderHook(() => usePortalClient(), {
      wrapper: wrapper(config),
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe("needs_login");
    });
    expect(result.current.xpubkey).toBe("xpub-restored");
    expect(result.current.xOnlyPubkey).toBe("xonly-restored");
    expect(result.current.blsPubkey).toBe("bls-restored");
  });

  it("provides client instance", async () => {
    const config = makeConfig();
    const { result } = renderHook(() => usePortalClient(), {
      wrapper: wrapper(config),
    });

    await vi.waitFor(() => {
      expect(result.current.status).not.toBe("loading");
    });
    expect(result.current.client).toBeDefined();
  });
});
