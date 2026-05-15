/**
 * Postcard-compatible binary serialization for Kontor BLS ops.
 *
 * Postcard is a Rust crate for compact binary serialization using varint encoding.
 * This module encodes `(SignerClaim, nonce, Inst)` tuples for
 * `KONTOR-OP-V1 || postcard((claim, nonce, inst))` signing.
 *
 * Format:
 * - Strings: varint length + UTF-8 bytes
 * - Bytes: varint length + raw bytes
 * - Enums: varint variant index + fields
 *
 * @see https://github.com/jamesmunns/postcard
 */
import type { NftAttribute } from "./types";

/**
 * Encodes a number as a varint (variable-length integer).
 * Uses LEB128 (Little Endian Base 128) encoding.
 */
function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

/**
 * Encodes a string as varint length + UTF-8 bytes.
 */
function encodeString(str: string): Uint8Array {
  const utf8Bytes = new TextEncoder().encode(str);
  const lengthVarint = encodeVarint(utf8Bytes.length);
  const result = new Uint8Array(lengthVarint.length + utf8Bytes.length);
  result.set(lengthVarint, 0);
  result.set(utf8Bytes, lengthVarint.length);
  return result;
}

/**
 * Concatenates multiple Uint8Arrays into a single buffer.
 */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// --- Kontor protocol constants ---

/** BLS DST used for Kontor protocol operations (create_agreement, register, etc.) */
export const KONTOR_BLS_DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';

const KONTOR_OP_PREFIX = new TextEncoder().encode('KONTOR-OP-V1');
const CHUNK_SIZE_BYTES = 31;
const DATA_SYMBOLS_PER_CODEWORD = 231;
const PARITY_SYMBOLS_PER_CODEWORD = 24;

// --- Low-level encoding helpers ---

/** LEB128 varint encoding for u64 values, using BigInt internally for full 64-bit range. */
export function encodeU64Varint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= BigInt(0x80)) {
    bytes.push(Number(v & BigInt(0x7f)) | 0x80);
    v >>= BigInt(7);
  }
  bytes.push(Number(v & BigInt(0x7f)));
  return new Uint8Array(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return result;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Encodes Vec<u8>: varint length prefix + raw bytes. */
export function encodeBytes(bytes: Uint8Array): Uint8Array {
  return concat(encodeVarint(bytes.length), bytes);
}

// --- High-level message builders ---

export function buildKontorOpMessage(opBytes: Uint8Array): Uint8Array {
  return concat(KONTOR_OP_PREFIX, opBytes);
}

/**
 * Escapes `\` and `"` for inclusion inside a WAVE string literal. Order matters:
 * the backslash replacement must run BEFORE the quote replacement, otherwise the
 * backslashes injected by the quote step would be double-escaped.
 *
 * Mirrors Rust `wave_escape_string` in `kontor_op.rs`.
 */
function waveEscapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildCreateAgreementExpr(
  fileId: string,
  fileHash: string,
  merkleRootHex: string,
  paddedLen: number,
  originalSize: number,
  filename: string,
): string {
  const rootBytes = Array.from(hexToBytes(merkleRootHex)).join(', ');
  return `create-agreement({file-id: "${waveEscapeString(fileId)}", object-id: "${waveEscapeString(fileHash)}", nonce: [], root: [${rootBytes}], padded-len: ${paddedLen}, original-size: ${originalSize}, filename: "${waveEscapeString(filename)}"})`;
}

/**
 * Builds the WAVE expression for the NFT contract's
 * `mint(nft_id, attributes, file_descriptor)` entrypoint.
 *
 * Must match Rust `build_mint_nft_expr` in `kontor_op.rs` byte-for-byte —
 * BLS verification on the Portal side reconstructs this exact string.
 */
export function buildMintNftExpr(
  nftId: string,
  attributes: NftAttribute[],
  fileId: string,
  fileHash: string,
  merkleRootHex: string,
  paddedLen: number,
  originalSize: number,
  filename: string,
): string {
  const attrsStr =
    attributes.length === 0
      ? '[]'
      : '[' +
        attributes
          .map(
            (a) =>
              `{key: "${waveEscapeString(a.key)}", value: "${waveEscapeString(a.value)}"}`,
          )
          .join(', ') +
        ']';
  const rootBytes = Array.from(hexToBytes(merkleRootHex)).join(', ');
  return `mint("${waveEscapeString(nftId)}", ${attrsStr}, {file-id: "${waveEscapeString(fileId)}", object-id: "${waveEscapeString(fileHash)}", nonce: [], root: [${rootBytes}], padded-len: ${paddedLen}, original-size: ${originalSize}, filename: "${waveEscapeString(filename)}"})`;
}

// --- Full signing message builders ---

// Builds: KONTOR-OP-V1 || postcard((SignerClaim::PubKey(xonly), 0, Inst { Sponsored, RegisterBlsKey }))
export function buildRegistrationMessage(
  xOnlyPubKeyHex: string,
  blsPubkeyHex: string,
  schnorrSigHex: string,
  blsSigHex: string,
): Uint8Array {
  const opBytes = concat(
    encodeVarint(1),                          // SignerClaim::PubKey variant
    encodeBytes(hexToBytes(xOnlyPubKeyHex)),  // 32 raw bytes with length prefix
    encodeU64Varint(0),                       // nonce = 0 (first-time registration)
    encodeVarint(1),                          // PaymentIntent::Sponsored variant
    encodeVarint(3),                          // InstKind::RegisterBlsKey variant
    encodeBytes(hexToBytes(blsPubkeyHex)),
    encodeBytes(hexToBytes(schnorrSigHex)),
    encodeBytes(hexToBytes(blsSigHex)),
  );
  return buildKontorOpMessage(opBytes);
}

// Builds: KONTOR-OP-V1 || postcard((SignerClaim::Id(signer_id), nonce, Inst { Sponsored, Call { contract, expr } }))
export function buildCreateAgreementMessage(
  signerId: number | bigint,
  nonce: number | bigint,
  contract: string,
  expr: string,
): Uint8Array {
  const opBytes = concat(
    encodeVarint(0),           // SignerClaim::Id variant
    encodeU64Varint(signerId),
    encodeU64Varint(nonce),
    encodeVarint(1),           // PaymentIntent::Sponsored variant
    encodeVarint(1),           // InstKind::Call variant
    encodeString(contract),
    encodeString(expr),
  );
  return buildKontorOpMessage(opBytes);
}

// --- RS parameter computation ---

export function computeCryptoParams(
  originalSize: number,
  paddedLen: number,
): { dataSymbols: number; paritySymbols: number; blobSize: number } {
  const dataSymbols = Math.ceil(originalSize / CHUNK_SIZE_BYTES);
  const paritySymbols =
    Math.ceil(dataSymbols / DATA_SYMBOLS_PER_CODEWORD) *
    PARITY_SYMBOLS_PER_CODEWORD;
  const blobSize = paddedLen * CHUNK_SIZE_BYTES;
  return { dataSymbols, paritySymbols, blobSize };
}

