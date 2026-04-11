import { describe, it, expect } from "vitest";
import {
  encodeU64Varint,
  hexToBytes,
  bytesToHex,
  encodeBytes,
  encodeSignerXOnlyPubKey,
  encodeBlsBulkOpCall,
  encodeBlsBulkOpRegisterBlsKey,
  buildKontorOpMessage,
  buildRegistrationMessage,
  buildCreateAgreementMessage,
  buildCreateAgreementExpr,
  computeCryptoParams,
  DEFAULT_GAS_LIMIT,
  KONTOR_BLS_DST,
} from "../postcard";

describe("hexToBytes / bytesToHex", () => {
  it("round-trips arbitrary hex", () => {
    const hex = "deadbeef01020304";
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });

  it("handles empty input", () => {
    expect(bytesToHex(hexToBytes(""))).toBe("");
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
    expect(bytesToHex(new Uint8Array(0))).toBe("");
  });

  it("converts known bytes", () => {
    expect(bytesToHex(new Uint8Array([0, 255, 16]))).toBe("00ff10");
    expect(hexToBytes("00ff10")).toEqual(new Uint8Array([0, 255, 16]));
  });
});

describe("encodeU64Varint", () => {
  it("encodes 0", () => {
    expect(encodeU64Varint(0)).toEqual(new Uint8Array([0]));
  });

  it("encodes single-byte values (< 128)", () => {
    expect(encodeU64Varint(1)).toEqual(new Uint8Array([1]));
    expect(encodeU64Varint(127)).toEqual(new Uint8Array([127]));
  });

  it("encodes two-byte boundary (128)", () => {
    expect(encodeU64Varint(128)).toEqual(new Uint8Array([0x80, 0x01]));
  });

  it("encodes 16383 (max 2-byte varint)", () => {
    expect(encodeU64Varint(16383)).toEqual(new Uint8Array([0xff, 0x7f]));
  });

  it("encodes larger values", () => {
    expect(encodeU64Varint(300)).toEqual(new Uint8Array([0xac, 0x02]));
  });

  it("accepts BigInt", () => {
    expect(encodeU64Varint(BigInt(128))).toEqual(
      new Uint8Array([0x80, 0x01]),
    );
  });

  it("encodes DEFAULT_GAS_LIMIT (100000)", () => {
    const encoded = encodeU64Varint(DEFAULT_GAS_LIMIT);
    expect(encoded.length).toBeGreaterThan(1);
    expect(encoded[0] & 0x80).toBe(0x80);
  });
});

describe("encodeBytes", () => {
  it("prefixes with varint length", () => {
    const data = new Uint8Array([1, 2, 3]);
    const encoded = encodeBytes(data);
    expect(encoded[0]).toBe(3);
    expect(encoded.slice(1)).toEqual(data);
  });

  it("handles empty bytes", () => {
    const encoded = encodeBytes(new Uint8Array(0));
    expect(encoded).toEqual(new Uint8Array([0]));
  });

  it("uses varint for lengths >= 128", () => {
    const data = new Uint8Array(200);
    const encoded = encodeBytes(data);
    expect(encoded[0]).toBe(0xc8);
    expect(encoded[1]).toBe(0x01);
    expect(encoded.length).toBe(202);
  });
});

describe("encodeSignerXOnlyPubKey", () => {
  it("encodes variant tag 1 + string", () => {
    const hex = "ab".repeat(32);
    const encoded = encodeSignerXOnlyPubKey(hex);
    expect(encoded[0]).toBe(1);
    expect(encoded[1]).toBe(64);
    const strPart = new TextDecoder().decode(encoded.slice(2));
    expect(strPart).toBe(hex);
  });
});

describe("encodeBlsBulkOpCall", () => {
  it("starts with variant tag 0", () => {
    const encoded = encodeBlsBulkOpCall(1, 0, 100_000, "contract", "expr");
    expect(encoded[0]).toBe(0);
  });

  it("encodes all fields in order", () => {
    const encoded = encodeBlsBulkOpCall(
      42,
      5,
      DEFAULT_GAS_LIMIT,
      "filestorage_0_0",
      "create-agreement(...)",
    );
    expect(encoded.length).toBeGreaterThan(20);
    expect(encoded[0]).toBe(0);
  });
});

describe("encodeBlsBulkOpRegisterBlsKey", () => {
  it("starts with variant tag 1", () => {
    const encoded = encodeBlsBulkOpRegisterBlsKey(
      "ab".repeat(32),
      "cd".repeat(48),
      "ef".repeat(32),
      "12".repeat(48),
    );
    expect(encoded[0]).toBe(1);
  });
});

describe("buildKontorOpMessage", () => {
  it("prefixes with KONTOR-OP-V1", () => {
    const op = new Uint8Array([0x01, 0x02]);
    const msg = buildKontorOpMessage(op);
    const prefix = new TextDecoder().decode(msg.slice(0, 12));
    expect(prefix).toBe("KONTOR-OP-V1");
    expect(msg.slice(12)).toEqual(op);
  });
});

describe("buildRegistrationMessage", () => {
  it("produces a message starting with KONTOR-OP-V1", () => {
    const msg = buildRegistrationMessage(
      "ab".repeat(32),
      "cd".repeat(48),
      "ef".repeat(32),
      "12".repeat(48),
    );
    const prefix = new TextDecoder().decode(msg.slice(0, 12));
    expect(prefix).toBe("KONTOR-OP-V1");
    expect(msg[12]).toBe(1);
  });
});

describe("buildCreateAgreementMessage", () => {
  it("produces a message with variant 0 (Call)", () => {
    const msg = buildCreateAgreementMessage(
      42,
      5,
      "filestorage_0_0",
      "create-agreement(...)",
    );
    const prefix = new TextDecoder().decode(msg.slice(0, 12));
    expect(prefix).toBe("KONTOR-OP-V1");
    expect(msg[12]).toBe(0);
  });
});

describe("buildCreateAgreementExpr", () => {
  it("interpolates all fields", () => {
    const expr = buildCreateAgreementExpr(
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      "test.txt",
    );
    expect(expr).toContain('file-id: "fid-1"');
    expect(expr).toContain('object-id: "hash-1"');
    expect(expr).toContain("root: [170, 187]");
    expect(expr).toContain("padded-len: 512");
    expect(expr).toContain("original-size: 100");
    expect(expr).toContain('filename: "test.txt"');
    expect(expr).toMatch(/^create-agreement\(/);
  });
});

describe("computeCryptoParams", () => {
  it("returns correct values for small file", () => {
    const { dataSymbols, paritySymbols, blobSize } = computeCryptoParams(
      100,
      512,
    );
    expect(dataSymbols).toBe(Math.ceil(100 / 31));
    expect(paritySymbols).toBe(24);
    expect(blobSize).toBe(512 * 31);
  });

  it("scales parity for larger files", () => {
    const size = 231 * 31 + 1;
    const { dataSymbols, paritySymbols } = computeCryptoParams(size, 1024);
    expect(dataSymbols).toBe(Math.ceil(size / 31));
    expect(paritySymbols).toBe(48);
  });

  it("handles size 0", () => {
    const { dataSymbols, paritySymbols, blobSize } = computeCryptoParams(
      0,
      0,
    );
    expect(dataSymbols).toBe(0);
    expect(paritySymbols).toBe(0);
    expect(blobSize).toBe(0);
  });
});

describe("constants", () => {
  it("DEFAULT_GAS_LIMIT is 100000", () => {
    expect(DEFAULT_GAS_LIMIT).toBe(100_000);
  });

  it("KONTOR_BLS_DST matches expected value", () => {
    expect(KONTOR_BLS_DST).toBe(
      "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
    );
  });
});
