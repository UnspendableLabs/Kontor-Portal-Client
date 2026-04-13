import { vi } from "vitest";
import {
  PORTAL_HOST,
  UPLOAD_URL,
  makeJwt,
  AGREEMENT,
  AGREEMENTS_RESPONSE,
} from "./fixtures";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

export interface MockFetchOverrides {
  health?: () => Response | Promise<Response>;
  register?: () => Response | Promise<Response>;
  loginChallenge?: () => Response | Promise<Response>;
  loginPost?: () => Response | Promise<Response>;
  registryEntry?: () => Response | Promise<Response>;
  filesPost?: () => Response | Promise<Response>;
  uploadPut?: () => Response | Promise<Response>;
  filesValidate?: () => Response | Promise<Response>;
  agreementGet?: () => Response | Promise<Response>;
  agreementsList?: () => Response | Promise<Response>;
  faucetPost?: () => Response | Promise<Response>;
}

export function createMockFetch(overrides: MockFetchOverrides = {}) {
  const mockFn = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url === `${PORTAL_HOST}/health`) {
        return (
          overrides.health?.() ??
          jsonResponse({ status: "ok", service: "horizon-portal" })
        );
      }

      if (
        url === `${PORTAL_HOST}/api/users/register` &&
        method === "POST"
      ) {
        return (
          overrides.register?.() ??
          jsonResponse({
            user_id: "user-1",
            x_only_pubkey: "ab".repeat(32),
            bls_pubkey: "cd".repeat(48),
          })
        );
      }

      if (url.startsWith(`${PORTAL_HOST}/api/users/login`)) {
        if (method === "GET") {
          return (
            overrides.loginChallenge?.() ??
            jsonResponse({ challenge: "challenge-hex-abc123" })
          );
        }
        if (method === "POST") {
          return (
            overrides.loginPost?.() ??
            jsonResponse({
              token: makeJwt(),
              user_id: "user-1",
              role: "user",
              expires_in: 3600,
            })
          );
        }
      }

      if (
        url.startsWith(`${PORTAL_HOST}/api/registry/entry/`)
      ) {
        return (
          overrides.registryEntry?.() ??
          jsonResponse({ signer_id: 42, next_nonce: 5, kor_balance: "100.5" })
        );
      }

      if (url === `${PORTAL_HOST}/api/faucet` && method === "POST") {
        return (
          overrides.faucetPost?.() ??
          jsonResponse({ status: "pending", message: "Faucet request submitted, will be included in next batch" }, 201)
        );
      }

      if (
        url === `${PORTAL_HOST}/api/files` &&
        method === "POST"
      ) {
        return (
          overrides.filesPost?.() ??
          jsonResponse({
            uploads: [
              {
                upload_url: UPLOAD_URL,
                upload_session_id: "session-1",
              },
            ],
          })
        );
      }

      if (url === UPLOAD_URL && method === "PUT") {
        return overrides.uploadPut?.() ?? jsonResponse({}, 200);
      }

      if (
        url.startsWith(`${PORTAL_HOST}/api/files/validate`) &&
        method === "POST"
      ) {
        return overrides.filesValidate?.() ?? jsonResponse({ ok: true });
      }

      if (
        url.match(/\/api\/agreements\/[^?]/) &&
        method === "GET"
      ) {
        return (
          overrides.agreementGet?.() ?? jsonResponse(AGREEMENT)
        );
      }

      if (
        url.startsWith(`${PORTAL_HOST}/api/agreements`) &&
        method === "GET"
      ) {
        return (
          overrides.agreementsList?.() ??
          jsonResponse(AGREEMENTS_RESPONSE)
        );
      }

      return textResponse("Not Found", 404);
    },
  );

  return mockFn;
}

export { jsonResponse, textResponse };
