import { describe, it, expect } from "vitest";
import {
  encodeU64Varint,
  hexToBytes,
  bytesToHex,
  encodeBytes,
  buildKontorOpMessage,
  buildRegistrationMessage,
  buildCreateAgreementMessage,
  buildCreateAgreementExpr,
  buildMintNftExpr,
  computeCryptoParams,
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
  // Format: KONTOR-OP-V1 || postcard((SignerRef::XOnlyPubkey(xonly), nonce=0, sponsored=true, Inst { gas_limit, RegisterBlsKey }))
  // XOnlyPublicKey serializes as a postcard tuple of 32 u8 — raw bytes, NO length prefix.
  // Binary after prefix: [0x01, 32 raw bytes, 0x00, 0x01, varint(100_000), 0x04, len(bls), bls, len(schnorr), schnorr, len(bls_sig), bls_sig]
  // 0x04 is `InstKind::RegisterBlsKey`: Publish(0), Call(1), UpdateProvenance(2),
  // Issuance(3), RegisterBlsKey(4), Sponsor(5).

  it("starts with KONTOR-OP-V1", () => {
    const msg = buildRegistrationMessage(
      "ab".repeat(32),
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    expect(new TextDecoder().decode(msg.slice(0, 12))).toBe("KONTOR-OP-V1");
  });

  it("byte[12] = 0x01 (SignerRef::XOnlyPubkey variant)", () => {
    const msg = buildRegistrationMessage(
      "ab".repeat(32),
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    expect(msg[12]).toBe(1);
  });

  it("byte[13] starts the 32 raw x-only bytes (no length prefix — postcard tuple)", () => {
    const xOnlyHex = "ab".repeat(32);
    const msg = buildRegistrationMessage(
      xOnlyHex,
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    expect(msg[13]).toBe(0xab);
  });

  it("encodes x-only pubkey as 32 raw bytes (not hex string)", () => {
    const xOnlyHex = "ab".repeat(32); // 64 hex chars = 32 bytes
    const msg = buildRegistrationMessage(
      xOnlyHex,
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    // bytes 13..44 = raw x-only pubkey (all 0xab) — no length prefix
    const xOnlyBytes = msg.slice(13, 45);
    expect(Array.from(xOnlyBytes).every((b) => b === 0xab)).toBe(true);
  });

  it("byte after xonly = 0x00 (nonce = 0)", () => {
    const msg = buildRegistrationMessage(
      "ab".repeat(32),
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    // After prefix(12) + variant(1) + xonly(32) = offset 45
    expect(msg[45]).toBe(0); // nonce = 0
  });

  it("sponsored=true (0x01) + gas_limit varint + InstKind::RegisterBlsKey (0x04) follow nonce", () => {
    const msg = buildRegistrationMessage(
      "ab".repeat(32),
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    expect(msg[46]).toBe(0x01);   // sponsored = true (bool)
    expect(msg[47]).toBe(0xa0);   // gas_limit = 100_000 varint byte 0
    expect(msg[48]).toBe(0x8d);   // gas_limit varint byte 1
    expect(msg[49]).toBe(0x06);   // gas_limit varint byte 2
    expect(msg[50]).toBe(0x04);   // InstKind::RegisterBlsKey
  });

  it("does NOT length-prefix the x-only pubkey (regression: postcard tuple, not Vec<u8>)", () => {
    // XOnlyPublicKey serializes as `tuple(32)` in postcard non-human-readable mode.
    // A spurious 0x20 length byte would shift every downstream field by 1 and cause
    // REGISTRATION_SIGNATURE_VERIFICATION_FAILED on the Portal.
    //
    // Pick an x-only whose first byte is NOT 0x20 so a regression that re-inserts
    // the length prefix is visible at msg[13] regardless of the body bytes.
    const xOnlyHex = "ab".repeat(32);
    const msg = buildRegistrationMessage(
      xOnlyHex,
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    expect(msg[13]).not.toBe(0x20);
  });

  it("has the exact expected total length", () => {
    // KONTOR-OP-V1 (12) + variant (1) + xonly (32) + nonce (1)
    //   + sponsored bool (1) + gas_limit varint 100_000 (3) + RegisterBlsKey (1)
    //   + varint(96) (1) + bls (96)
    //   + varint(64) (1) + schnorr (64)
    //   + varint(48) (1) + bls_sig (48)
    // = 12 + 1 + 32 + 1 + 1 + 3 + 1 + 1 + 96 + 1 + 64 + 1 + 48 = 262
    const msg = buildRegistrationMessage(
      "ab".repeat(32),
      "cd".repeat(96),
      "ef".repeat(64),
      "12".repeat(48),
    );
    expect(msg.length).toBe(262);
  });

  it("byte-exact layout end-to-end (canary against any encoding drift)", () => {
    const xOnlyHex = "ab".repeat(32);
    const blsHex = "cd".repeat(96);
    const schnorrHex = "ef".repeat(64);
    const blsSigHex = "12".repeat(48);
    const msg = buildRegistrationMessage(xOnlyHex, blsHex, schnorrHex, blsSigHex);

    expect(new TextDecoder().decode(msg.slice(0, 12))).toBe("KONTOR-OP-V1");
    expect(msg[12]).toBe(0x01); // SignerRef::XOnlyPubkey variant
    expect(Array.from(msg.slice(13, 45))).toEqual(Array(32).fill(0xab)); // 32 raw x-only bytes
    expect(msg[45]).toBe(0x00); // nonce = 0
    expect(msg[46]).toBe(0x01); // sponsored = true (bool)
    expect(msg[47]).toBe(0xa0); // gas_limit = 100_000 varint byte 0
    expect(msg[48]).toBe(0x8d); // gas_limit varint byte 1
    expect(msg[49]).toBe(0x06); // gas_limit varint byte 2
    expect(msg[50]).toBe(0x04); // InstKind::RegisterBlsKey
    expect(msg[51]).toBe(96);   // varint(96) — single byte since 96 < 128
    expect(Array.from(msg.slice(52, 148))).toEqual(Array(96).fill(0xcd));
    expect(msg[148]).toBe(64);
    expect(Array.from(msg.slice(149, 213))).toEqual(Array(64).fill(0xef));
    expect(msg[213]).toBe(48);
    expect(Array.from(msg.slice(214, 262))).toEqual(Array(48).fill(0x12));
    expect(msg.length).toBe(262);
  });
});

describe("buildCreateAgreementMessage", () => {
  // Format: KONTOR-OP-V1 || postcard((SignerRef::SignerId(signer_id), nonce, sponsored=true, Inst { gas_limit, Call { contract, expr } }))
  // Binary after prefix: [0x00, varint(signer_id), varint(nonce), 0x01, varint(100_000), 0x01, str(contract), str(expr)]

  it("starts with KONTOR-OP-V1", () => {
    const msg = buildCreateAgreementMessage(
      42,
      5,
      "filestorage_0_0",
      "create-agreement(...)",
    );
    expect(new TextDecoder().decode(msg.slice(0, 12))).toBe("KONTOR-OP-V1");
  });

  it("byte[12] = 0x00 (SignerRef::SignerId variant)", () => {
    const msg = buildCreateAgreementMessage(
      42,
      5,
      "filestorage_0_0",
      "create-agreement(...)",
    );
    expect(msg[12]).toBe(0);
  });

  it("encodes signer_id and nonce as varints, then sponsored=true + gas_limit varint + Call(0x01)", () => {
    // signer_id=1 (1 byte), nonce=0 (1 byte) → offset 15 for sponsored bool
    const msg = buildCreateAgreementMessage(1, 0, "filestorage_0_0", "expr");
    expect(msg[12]).toBe(0);    // SignerRef::SignerId
    expect(msg[13]).toBe(1);    // signer_id = 1
    expect(msg[14]).toBe(0);    // nonce = 0
    expect(msg[15]).toBe(0x01); // sponsored = true (bool)
    expect(msg[16]).toBe(0xa0); // gas_limit = 100_000 varint byte 0
    expect(msg[17]).toBe(0x8d); // gas_limit varint byte 1
    expect(msg[18]).toBe(0x06); // gas_limit varint byte 2
    expect(msg[19]).toBe(0x01); // InstKind::Call
  });

  it("contains gas_limit bytes [0xa0, 0x8d, 0x06]", () => {
    const msg = buildCreateAgreementMessage(1, 0, "filestorage_0_0", "expr");
    const hex = bytesToHex(msg);
    expect(hex).toContain("a08d06");
  });
});

describe("cross-language postcard vectors", () => {
  // Ground truth produced by Kontor's own encoder — `Inst::aggregate_signing_message`
  // from `core/indexer-types` at the revision Horizon-Portal pins
  // (`b8e40260`), which is what the Portal re-derives and verifies against.
  // A drift in Kontor's `SignerRef` / `InstKind` declaration order or in the
  // tuple layout breaks these two vectors before it breaks a user's login.

  it("matches Kontor's bytes for a RegisterBlsKey op", () => {
    // SignerRef::XOnlyPubkey(G.x), nonce 0, sponsored true,
    // Inst { gas_limit: 100_000, RegisterBlsKey { aabb, cc, ddeeff } }
    const msg = buildRegistrationMessage(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      "aabb",
      "cc",
      "ddeeff",
    );
    expect(bytesToHex(msg)).toBe(
      "4b4f4e544f522d4f502d5631" + // "KONTOR-OP-V1"
        "01" +
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
        "00" +
        "01" +
        "a08d06" +
        "04" +
        "02aabb" +
        "01cc" +
        "03ddeeff",
    );
  });

  it("matches Kontor's bytes for a Call op", () => {
    // SignerRef::SignerId(7), nonce 3, sponsored true,
    // Inst { gas_limit: 100_000, Call { filestorage_0_0, "create-agreement()" } }
    const msg = buildCreateAgreementMessage(
      7,
      3,
      "filestorage_0_0",
      "create-agreement()",
    );
    expect(bytesToHex(msg)).toBe(
      "4b4f4e544f522d4f502d5631" +
        "00" +
        "07" +
        "03" +
        "01" +
        "a08d06" +
        "01" +
        "0f66696c6573746f726167655f305f30" +
        "126372656174652d61677265656d656e742829",
    );
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

  it("escapes backslashes and quotes in string fields", () => {
    const expr = buildCreateAgreementExpr(
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      'weird "name".txt',
    );
    expect(expr).toContain('filename: "weird \\"name\\".txt"');
  });

  it("escapes ASCII control characters as \\xNN (Rust wave_escape_string parity)", () => {
    const expr = buildCreateAgreementExpr(
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      "a\nb\rc\td\0e\x7Ff",
    );
    expect(expr).toContain('filename: "a\\x0Ab\\x0Dc\\x09d\\x00e\\x7Ff"');
  });
});

describe("buildMintNftExpr", () => {
  it("renders empty attributes as []", () => {
    const expr = buildMintNftExpr(
      "nft_42",
      [],
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      "test.txt",
    );
    expect(expr.startsWith('mint("nft_42", [], {file-id: ')).toBe(true);
    expect(expr).toContain('file-id: "fid-1"');
    expect(expr).toContain('object-id: "hash-1"');
    expect(expr).toContain("root: [170, 187]");
    expect(expr).toContain("padded-len: 512");
    expect(expr).toContain("original-size: 100");
    expect(expr).toContain('filename: "test.txt"');
  });

  it("renders one attribute with exact spacing", () => {
    const expr = buildMintNftExpr(
      "nft_42",
      [{ key: "artist", value: "Leonardo" }],
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      "test.txt",
    );
    expect(expr).toContain('[{key: "artist", value: "Leonardo"}]');
  });

  it("renders two attributes with `, ` separator", () => {
    const expr = buildMintNftExpr(
      "nft_42",
      [
        { key: "k1", value: "v1" },
        { key: "k2", value: "v2" },
      ],
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      "test.txt",
    );
    expect(expr).toContain(
      '[{key: "k1", value: "v1"}, {key: "k2", value: "v2"}]',
    );
  });

  it("escapes `\\` and `\"` in nftId, attribute key, attribute value, and filename", () => {
    const expr = buildMintNftExpr(
      'a"b\\c',
      [{ key: 'k"\\', value: 'v"\\' }],
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      'na"me\\.txt',
    );
    expect(expr).toContain('mint("a\\"b\\\\c"');
    expect(expr).toContain('{key: "k\\"\\\\", value: "v\\"\\\\"}');
    expect(expr).toContain('filename: "na\\"me\\\\.txt"');
  });

  it("renders the merkle root as a decimal byte list", () => {
    const expr = buildMintNftExpr(
      "nft_42",
      [],
      "fid-1",
      "hash-1",
      "aabb",
      512,
      100,
      "test.txt",
    );
    expect(expr).toContain("root: [170, 187]");
  });

  it("matches the Rust doc-test substring shape", () => {
    const expr = buildMintNftExpr(
      "nft_42",
      [{ key: "k", value: "v" }],
      "file_abc",
      "obj_abc",
      "aabb",
      32,
      2048,
      "test.png",
    );
    expect(expr.startsWith('mint("nft_42", ')).toBe(true);
    expect(expr).toContain('{key: "k", value: "v"}');
    expect(expr).toContain('file-id: "file_abc"');
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
  it("KONTOR_BLS_DST matches expected value", () => {
    expect(KONTOR_BLS_DST).toBe(
      "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_",
    );
  });
});
