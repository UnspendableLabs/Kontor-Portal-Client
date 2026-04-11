/**
 * Postcard-compatible binary serialization for Kontor BLS ops.
 *
 * Postcard is a Rust crate for compact binary serialization using varint encoding.
 * This module encodes instructions and `BlsBulkOp` variants for
 * `KONTOR-OP-V1 || postcard(...)` signing.
 *
 * Format:
 * - Strings: varint length + UTF-8 bytes
 * - Vectors: varint length + each element encoded
 *
 * @see https://github.com/jamesmunns/postcard
 */

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

export const DEFAULT_GAS_LIMIT = 100_000;

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

// --- Kontor enum serializers ---
// Enum variants are encoded as varint index followed by fields (Postcard/serde convention).

export function encodeSignerXOnlyPubKey(xOnlyHex: string): Uint8Array {
  return concat(encodeVarint(1), encodeString(xOnlyHex));
}

export function encodeBlsBulkOpCall(
  signerId: number | bigint,
  nonce: number | bigint,
  gasLimit: number | bigint,
  contract: string,
  expr: string,
): Uint8Array {
  return concat(
    encodeVarint(0),
    encodeU64Varint(signerId),
    encodeU64Varint(nonce),
    encodeU64Varint(gasLimit),
    encodeString(contract),
    encodeString(expr),
  );
}

export function encodeBlsBulkOpRegisterBlsKey(
  xOnlyPubKeyHex: string,
  blsPubkeyHex: string,
  schnorrSigHex: string,
  blsSigHex: string,
): Uint8Array {
  return concat(
    encodeVarint(1),
    encodeSignerXOnlyPubKey(xOnlyPubKeyHex),
    encodeBytes(hexToBytes(blsPubkeyHex)),
    encodeBytes(hexToBytes(schnorrSigHex)),
    encodeBytes(hexToBytes(blsSigHex)),
  );
}

// --- High-level message builders ---

export function buildKontorOpMessage(opBytes: Uint8Array): Uint8Array {
  return concat(KONTOR_OP_PREFIX, opBytes);
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
  return `create-agreement({file-id: "${fileId}", object-id: "${fileHash}", nonce: [], root: [${rootBytes}], padded-len: ${paddedLen}, original-size: ${originalSize}, filename: "${filename}"})`;
}

// --- Full signing message builders ---

export function buildRegistrationMessage(
  xOnlyPubKeyHex: string,
  blsPubkeyHex: string,
  schnorrSigHex: string,
  blsSigHex: string,
): Uint8Array {
  const opBytes = encodeBlsBulkOpRegisterBlsKey(
    xOnlyPubKeyHex,
    blsPubkeyHex,
    schnorrSigHex,
    blsSigHex,
  );
  return buildKontorOpMessage(opBytes);
}

export function buildCreateAgreementMessage(
  signerId: number | bigint,
  nonce: number | bigint,
  contract: string,
  expr: string,
): Uint8Array {
  const opBytes = encodeBlsBulkOpCall(
    signerId,
    nonce,
    DEFAULT_GAS_LIMIT,
    contract,
    expr,
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

