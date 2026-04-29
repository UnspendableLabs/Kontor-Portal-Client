import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { KontorPortalClient } from "./kontor-portal-client";
import type { KontorPortalClientConfig } from "./types";

export type PortalAuthStatus =
  | "loading"
  | "authenticated"
  | "needs_login"
  | "logging_in"
  | "error";

const STORAGE_KEYS = {
  jwt: "portal_jwt",
  userId: "portal_user_id",
  taprootAddress: "portal_taproot_address",
  xpubkey: "portal_xpubkey",
  xOnlyPubkey: "portal_x_only_pubkey",
  blsPubkey: "portal_bls_pubkey",
} as const;

interface PortalClientContextValue {
  client: KontorPortalClient;
  status: PortalAuthStatus;
  jwt: string | null;
  error: string | null;
  isRegistered: boolean;
  portalUserId: string | null;
  taprootAddress: string | null;
  xpubkey: string | null;
  xOnlyPubkey: string | null;
  blsPubkey: string | null;
  isLoading: boolean;
  /**
   * Triggers `client.login()`. Sets `status` to `"logging_in"` while in
   * flight, then `"authenticated"` on success or `"error"` on failure
   * (with the message exposed via `error`).
   *
   * On failure the underlying error is **re-thrown** so callers awaiting
   * `login()` can `try/catch` it directly without also having to subscribe
   * to `status` / `error`. The hook still updates state for consumers that
   * prefer the reactive contract.
   */
  login: () => Promise<void>;
  logout: () => void;
  reset: () => void;
}

const PortalClientContext = createContext<PortalClientContextValue | null>(null);

/**
 * `config` is read once on mount to create the client.  Changing `config`
 * after the initial render has no effect — keep the reference stable
 * (module-level constant or `useMemo`).
 */
export function PortalClientProvider({
  config,
  children,
}: {
  config: KontorPortalClientConfig;
  children: ReactNode;
}) {
  const initRef = useRef(false);
  const clientRef = useRef<KontorPortalClient | null>(null);

  if (!clientRef.current) {
    clientRef.current = new KontorPortalClient(config);
  }

  const client = clientRef.current;

  const [status, setStatus] = useState<PortalAuthStatus>("loading");
  const [jwt, setJwt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalUserId, setPortalUserId] = useState<string | null>(null);
  const [taprootAddress, setTaprootAddress] = useState<string | null>(null);
  const [xpubkey, setXpubkey] = useState<string | null>(null);
  const [xOnlyPubkey, setXOnlyPubkey] = useState<string | null>(null);
  const [blsPubkey, setBlsPubkey] = useState<string | null>(null);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const storedJwt = localStorage.getItem(STORAGE_KEYS.jwt);
    const storedUserId = localStorage.getItem(STORAGE_KEYS.userId);
    const storedTaprootAddress = localStorage.getItem(STORAGE_KEYS.taprootAddress);
    const storedXpubkey = localStorage.getItem(STORAGE_KEYS.xpubkey);
    const storedXOnlyPubkey = localStorage.getItem(STORAGE_KEYS.xOnlyPubkey);
    const storedBlsPubkey = localStorage.getItem(STORAGE_KEYS.blsPubkey);

    setPortalUserId(storedUserId);
    setTaprootAddress(storedTaprootAddress);
    setXpubkey(storedXpubkey);
    setXOnlyPubkey(storedXOnlyPubkey);
    setBlsPubkey(storedBlsPubkey);

    if (storedJwt) {
      client.setJwt(storedJwt);
      if (client.isAuthenticated()) {
        setJwt(storedJwt);
        setStatus("authenticated");
        return;
      }
      localStorage.removeItem(STORAGE_KEYS.jwt);
    }
    setStatus("needs_login");
  }, [client]);

  const login = useCallback(async () => {
    setStatus("logging_in");
    setError(null);
    try {
      const result = await client.login(
        taprootAddress ? { address: taprootAddress } : {},
      );

      if (taprootAddress !== result.address) {
        localStorage.setItem(STORAGE_KEYS.taprootAddress, result.address);
        setTaprootAddress(result.address);
      }

      // Persist the userId on the already-registered path too: a fresh
      // browser session may have a stale or missing `portal_user_id`.
      if (!portalUserId || portalUserId !== result.userId) {
        localStorage.setItem(STORAGE_KEYS.userId, result.userId);
        setPortalUserId(result.userId);
      }

      // Persist xOnlyPubkey and blsPubkey on BOTH paths. On the
      // already-registered path the values come from `getSignerInfo` (via
      // the registry lookup performed inside `client.login()`), so callers
      // that lost their `localStorage` (different browser, cleared cache,
      // …) recover the xOnlyPubkey required by `uploadFile`.
      localStorage.setItem(STORAGE_KEYS.xOnlyPubkey, result.xOnlyPubkey);
      setXOnlyPubkey(result.xOnlyPubkey);
      if (result.blsPubkey) {
        localStorage.setItem(STORAGE_KEYS.blsPubkey, result.blsPubkey);
        setBlsPubkey(result.blsPubkey);
      }

      // xpubkey is only known on the auto-register path (the registry
      // entry does not carry it). Persist it when we have it.
      if (result.registration) {
        localStorage.setItem(
          STORAGE_KEYS.xpubkey,
          result.registration.xpubkey,
        );
        setXpubkey(result.registration.xpubkey);
      }

      localStorage.setItem(STORAGE_KEYS.jwt, result.jwt);
      setJwt(result.jwt);
      setStatus("authenticated");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
      setStatus("error");
      // Re-throw so callers awaiting `login()` see the failure directly;
      // state is still updated for consumers reading `status` / `error`.
      throw err;
    }
  }, [client, taprootAddress, portalUserId]);

  const logout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.jwt);
    client.clearJwt();
    setJwt(null);
    setError(null);
    setStatus("needs_login");
  }, [client]);

  const reset = useCallback(() => {
    for (const key of Object.values(STORAGE_KEYS)) {
      localStorage.removeItem(key);
    }
    client.clearJwt();
    setJwt(null);
    setPortalUserId(null);
    setTaprootAddress(null);
    setXpubkey(null);
    setXOnlyPubkey(null);
    setBlsPubkey(null);
    setError(null);
    setStatus("needs_login");
  }, [client]);

  const value = useMemo<PortalClientContextValue>(
    () => ({
      client,
      status,
      jwt,
      error,
      isRegistered: portalUserId !== null,
      portalUserId,
      taprootAddress,
      xpubkey,
      xOnlyPubkey,
      blsPubkey,
      isLoading: status === "loading",
      login,
      logout,
      reset,
    }),
    [client, status, jwt, error, portalUserId, taprootAddress, xpubkey, xOnlyPubkey, blsPubkey, login, logout, reset],
  );

  return (
    <PortalClientContext.Provider value={value}>
      {children}
    </PortalClientContext.Provider>
  );
}

export function usePortalClient(): PortalClientContextValue {
  const ctx = useContext(PortalClientContext);
  if (!ctx) {
    throw new Error(
      "usePortalClient must be used within a PortalClientProvider",
    );
  }
  return ctx;
}
