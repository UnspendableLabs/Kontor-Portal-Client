/**
 * Browser-safe xpub utilities for Kontor Portal.
 * Uses only bip32 + ecc (no Node.js "crypto") so it can run in client components.
 */

import ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory } from "bip32";
import type { Network } from "bitcoinjs-lib";
import { bytesToHex } from "./postcard";

const bip32 = BIP32Factory(ecc);

/**
 * Derives the 32-byte x-only public key from an extended public key (xpub/tpub).
 * Matches Horizon-Portal server derivation: Xpub::from_str then xpub.public_key.x_only_public_key().
 * Compressed public key from the node is 33 bytes; drop the first byte (02/03 prefix) to get the 32-byte x-only key.
 *
 * @param xpub - The extended public key in base58 format
 * @param network - The Bitcoin network (mainnet or testnet/signet)
 * @returns The x-only public key (32 bytes) as hex
 */
export function getXOnlyPubkeyHexFromXpub(xpub: string, network: Network): string {
  const node = bip32.fromBase58(xpub, network);
  const compressed = node.publicKey; // 33 bytes: 02/03 prefix + 32-byte x
  const xOnly = compressed.slice(1); // drop prefix -> 32 bytes
  return bytesToHex(new Uint8Array(xOnly));
}
