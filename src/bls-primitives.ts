/**
 * Portable BLS primitives — direct TypeScript port of
 * `Horizon-Wallet/tool/bls-entry.js`.
 *
 * Public surface (re-exported under the
 * `@unspendablelabs/kontor-portal-client/bls` subpath, names matching
 * `bls-entry.js` byte-for-byte): `KONTOR_BLS_DST`, `deriveMasterSK`,
 * `deriveBlsKey`, `sign`, `getPublicKey`, `signBlsBinding`,
 * `schnorrBindingHash`. The internal binding-prefix constants
 * `SCHNORR_BINDING_PREFIX` / `BLS_BINDING_PREFIX` are kept module-private
 * to mirror the JS reference exactly.
 *
 * Algorithms:
 * - EIP-2333 (BLS12-381 hierarchical key derivation): `deriveMasterSK`,
 *   `parentSKToLamportPK`, `deriveChildSK`, `deriveBlsKey`.
 * - BLS12-381 G1 min-sig signatures (`bls12_381.shortSignatures`).
 * - Schnorr <-> BLS binding helpers (`signBlsBinding`, `schnorrBindingHash`).
 */

import { bls12_381 } from "@noble/curves/bls12-381.js";
import { hkdf, extract, expand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { KONTOR_BLS_DST } from "./postcard";

export { KONTOR_BLS_DST };

const BLS_ORDER = BigInt(
  "0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001",
);

const SCHNORR_BINDING_PREFIX = new TextEncoder().encode(
  "KONTOR_XONLY_TO_BLS_V1",
);
const BLS_BINDING_PREFIX = new TextEncoder().encode("KONTOR_BLS_TO_XONLY_V1");

/**
 * EIP-2333 `HKDF_mod_r` step: deterministically derive a 32-byte BLS
 * scalar from input keying material, retrying with a re-hashed salt
 * whenever the candidate scalar reduces to 0 mod r.
 */
function hkdfModR(ikm: Uint8Array): Uint8Array {
  let salt = new TextEncoder().encode("BLS-SIG-KEYGEN-SALT-");
  const ikmPadded = new Uint8Array(ikm.length + 1);
  ikmPadded.set(ikm);
  ikmPadded[ikm.length] = 0;
  const L = 48;

  for (;;) {
    salt = sha256(salt);
    const okm = hkdf(sha256, ikmPadded, salt, new Uint8Array([0, L]), L);
    let sk = BigInt(0);
    for (let i = 0; i < okm.length; i++) {
      sk = (sk << BigInt(8)) + BigInt(okm[i]);
    }
    sk = sk % BLS_ORDER;
    if (sk !== BigInt(0)) {
      const skBytes = new Uint8Array(32);
      for (let i = 31; i >= 0; i--) {
        skBytes[i] = Number(sk & BigInt(0xff));
        sk >>= BigInt(8);
      }
      return skBytes;
    }
  }
}

/**
 * EIP-2333 `derive_master_SK`.
 */
export function deriveMasterSK(seed: Uint8Array): Uint8Array {
  return hkdfModR(seed);
}

/**
 * EIP-2333 `parent_SK_to_lamport_PK`. Returns a 32-byte sha256 digest
 * of the concatenated 255+255 lamport leaves.
 */
function parentSKToLamportPK(parentSK: Uint8Array, index: number): Uint8Array {
  const salt = new Uint8Array(4);
  new DataView(salt.buffer).setUint32(0, index, false);

  const ikm = parentSK;

  const prk0 = extract(sha256, ikm, salt);
  const okm0 = expand(sha256, prk0, new Uint8Array(0), 8160);

  const notIKM = new Uint8Array(ikm.length);
  for (let i = 0; i < ikm.length; i++) notIKM[i] = ~ikm[i] & 0xff;

  const prk1 = extract(sha256, notIKM, salt);
  const okm1 = expand(sha256, prk1, new Uint8Array(0), 8160);

  const lamportPK = new Uint8Array(255 * 32 * 2);
  let offset = 0;
  for (let i = 0; i < 255; i++) {
    lamportPK.set(sha256(okm0.subarray(i * 32, (i + 1) * 32)), offset);
    offset += 32;
  }
  for (let i = 0; i < 255; i++) {
    lamportPK.set(sha256(okm1.subarray(i * 32, (i + 1) * 32)), offset);
    offset += 32;
  }

  return sha256(lamportPK);
}

/**
 * EIP-2333 `derive_child_SK`.
 */
function deriveChildSK(parentSK: Uint8Array, index: number): Uint8Array {
  const compressedLamportPK = parentSKToLamportPK(parentSK, index);
  return hkdfModR(compressedLamportPK);
}

/**
 * Derive a BLS private key from a BIP-39/Web3Auth IKM using the EIP-2333
 * derivation path `m/12381/{coinType}/{account}/0` (matches
 * Horizon-Wallet's `pop_service_web.dart` and `bls_service_web.dart`).
 */
export function deriveBlsKey(
  seed: Uint8Array,
  coinType: number,
  account: number,
): Uint8Array {
  let sk = deriveMasterSK(seed);
  for (const idx of [12381, coinType, account, 0]) {
    sk = deriveChildSK(sk, idx);
  }
  return sk;
}

/**
 * BLS12-381 G1 min-sig signature. `messageHex` is the hex-encoded
 * message bytes (matching Horizon-Wallet `tool/bls-entry.js`).
 *
 * @param messageHex - hex-encoded message bytes
 * @param privateKey - 32-byte BLS scalar
 * @param dst - optional domain separation tag; defaults to `KONTOR_BLS_DST`
 * @returns 96-character hex string (48 bytes — G1 compressed)
 */
export function sign(
  messageHex: string,
  privateKey: Uint8Array,
  dst?: string,
): string {
  const msgBytes = hexToBytes(messageHex);
  const effectiveDst = dst || KONTOR_BLS_DST;
  const hashedMsg = bls12_381.shortSignatures.hash(msgBytes, effectiveDst);
  const sigPoint = bls12_381.shortSignatures.sign(hashedMsg, privateKey);
  return bls12_381.shortSignatures.Signature.toHex(sigPoint);
}

/**
 * BLS12-381 G2 public key (192-character hex / 96 bytes compressed).
 */
export function getPublicKey(privateKey: Uint8Array): string {
  const pubPoint = bls12_381.shortSignatures.getPublicKey(privateKey);
  return pubPoint.toHex();
}

/**
 * Sign the BLS-side of the Schnorr<->BLS binding:
 * `BLS_BINDING_PREFIX || xOnlyBytes` under `KONTOR_BLS_DST`.
 *
 * @param blsPrivateKey - 32-byte BLS scalar
 * @param xOnlyPubkeyHex - 64-character hex (32-byte x-only secp256k1 pubkey)
 */
export function signBlsBinding(
  blsPrivateKey: Uint8Array,
  xOnlyPubkeyHex: string,
): string {
  const xOnlyBytes = hexToBytes(xOnlyPubkeyHex);
  const msg = new Uint8Array(BLS_BINDING_PREFIX.length + xOnlyBytes.length);
  msg.set(BLS_BINDING_PREFIX);
  msg.set(xOnlyBytes, BLS_BINDING_PREFIX.length);
  const hashedMsg = bls12_381.shortSignatures.hash(msg, KONTOR_BLS_DST);
  const sigPoint = bls12_381.shortSignatures.sign(hashedMsg, blsPrivateKey);
  return bls12_381.shortSignatures.Signature.toHex(sigPoint);
}

/**
 * Compute the 32-byte sha256 hash that the Schnorr side of the binding
 * signs: `sha256(SCHNORR_BINDING_PREFIX || blsPubkeyBytes)`.
 *
 * @param blsPubkeyHex - 192-character hex (96-byte G2 compressed pub)
 */
export function schnorrBindingHash(blsPubkeyHex: string): Uint8Array {
  const blsPubkeyBytes = hexToBytes(blsPubkeyHex);
  const preimage = new Uint8Array(
    SCHNORR_BINDING_PREFIX.length + blsPubkeyBytes.length,
  );
  preimage.set(SCHNORR_BINDING_PREFIX);
  preimage.set(blsPubkeyBytes, SCHNORR_BINDING_PREFIX.length);
  return sha256(preimage);
}
