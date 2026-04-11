import type { BLSPoP, Agreement, AgreementsResponse } from "../../types";
import type { PrepareResult } from "../../kontor-crypto";

export const PORTAL_HOST = "https://portal.test";
export const UPLOAD_URL = "https://storage.test/upload/abc123";

export const VALID_TPUB =
  "tpubD6NzVbkrYhZ4WPB6jquaemFyk4ywU78S1J8e2t5oBaMUGmY1C9AXJKPFim4RPJqmrSX8GELPGGDDbD9pebsM2wSGRAx8vdkp1KaTrXimcyC";

export const VALID_X_ONLY =
  "8ec4dc550d7b767c7c648c95d52c6349c999f7f2b477c377001f785c847509fd";

export const POP: BLSPoP = {
  xpubkey: VALID_TPUB,
  blsPubkey: "aabbccdd" + "00".repeat(44),
  schnorrSig: "1122334455" + "00".repeat(27),
  blsSig: "deadbeef" + "00".repeat(44),
};

export const BLS_SIGNATURE = "ff".repeat(48);

export const X_ONLY_PUBKEY = "ab".repeat(32);

export function makeJwt(overrides?: {
  exp?: number;
  user_id?: string;
  role?: string;
}): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      exp: overrides?.exp ?? Math.floor(Date.now() / 1000) + 3600,
      user_id: overrides?.user_id ?? "user-1",
      role: overrides?.role ?? "user",
    }),
  );
  return `${header}.${payload}.fake-sig`;
}

export function makeExpiredJwt(): string {
  return makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
}

export const PREPARE_RESULT: PrepareResult = {
  metadata: {
    root: "aa".repeat(32),
    objectId: "bb".repeat(32),
    fileId: "file-id-123",
    nonce: [1, 2, 3],
    paddedLen: 512,
    originalSize: 100,
    filename: "test.txt",
  },
  preparedFile: {
    root: "aa".repeat(32),
    fileId: "file-id-123",
    treeLeavesHex: ["cc".repeat(32)],
  },
  descriptor: {
    fileId: "file-id-123",
    objectId: "bb".repeat(32),
    nonce: [1, 2, 3],
    root: Array.from({ length: 32 }, (_, i) => i),
    paddedLen: 512,
    originalSize: 100,
    filename: "test.txt",
  },
};

export const AGREEMENT: Agreement = {
  agreement_id: "agr-1",
  user_id: "user-1",
  file_id: "file-1",
  filename: "test.txt",
  mime_type: "text/plain",
  original_size: 100,
  created_at: "2025-01-01T00:00:00Z",
  status: "pending",
  nodes: ["node-1"],
};

export const AGREEMENTS_RESPONSE: AgreementsResponse = {
  offset: 0,
  limit: 20,
  total: 1,
  agreements: [AGREEMENT],
};
