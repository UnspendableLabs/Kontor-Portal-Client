/**
 * Browser-friendly {@link BLSSigner} implementation that derives a Taproot
 * key + a BLS12-381 G1 (min-sig) key from EITHER:
 * - a BIP-39 seed (Horizon-Wallet parity, with the same EIP-2333
 *   derivation path that `pop_service_web.dart` uses), OR
 * - a single 32-byte secp256k1 private key (Web3Auth, social wallets).
 *
 * In the private-key branch the BIP-32 chain code is synthesized
 * deterministically from the private key itself
 * (`HMAC-SHA512("KONTOR-WEB3AUTH-CHAINCODE-V1", privateKey).slice(32)`)
 * so we still produce a valid `xpub` that Portal already understands.
 * The resulting Schnorr/BLS bindings are computed against the same
 * x-only secp256k1 pubkey either way.
 *
 * All work is pre-derived in the constructor — `getAddress`,
 * `getBLSPoP`, and `signBLS` only return cached values plus a fresh
 * BLS signature when needed.
 */

import ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory, type BIP32Interface } from "bip32";
import { initEccLib, networks, payments, type Network } from "bitcoinjs-lib";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "./postcard";
import {
  deriveBlsKey,
  getPublicKey as blsGetPublicKey,
  schnorrBindingHash,
  sign as blsSign,
  signBlsBinding,
} from "./bls-primitives";
import type {
  BLSPoP,
  BLSSignParams,
  BLSSigner,
  WalletAddress,
  WalletNetwork,
} from "./types";

initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const CHAIN_CODE_DOMAIN = new TextEncoder().encode(
  "KONTOR-WEB3AUTH-CHAINCODE-V1",
);

interface CommonConfig {
  network: Network;
  walletNetwork?: WalletNetwork;
}

interface SeedBranchConfig {
  seed: Uint8Array;
  accountIndex?: number;
  taprootDerivationPath?: string;
}

interface PrivateKeyBranchConfig {
  privateKey: Uint8Array;
}

export type InBrowserCustomSignerConfig = CommonConfig &
  (SeedBranchConfig | PrivateKeyBranchConfig);

function isSeedConfig(
  config: InBrowserCustomSignerConfig,
): config is CommonConfig & SeedBranchConfig {
  return "seed" in config && config.seed !== undefined;
}

function deriveSyntheticChainCode(privateKey: Uint8Array): Uint8Array {
  const mac = hmac(sha512, CHAIN_CODE_DOMAIN, privateKey);
  return mac.slice(32);
}

function deriveWalletNetwork(
  network: Network,
  override: WalletNetwork | undefined,
): WalletNetwork {
  if (override !== undefined) return override;
  return network === networks.bitcoin ? "mainnet" : "signet";
}

export class InBrowserCustomSigner implements BLSSigner {
  private readonly cachedAddress: WalletAddress;
  private readonly cachedPoP: BLSPoP;
  private readonly blsPrivateKey: Uint8Array;

  constructor(config: InBrowserCustomSignerConfig) {
    if (!config || typeof config !== "object") {
      throw new Error("InBrowserCustomSigner requires a config object");
    }
    if (!config.network || typeof config.network !== "object") {
      throw new Error(
        "InBrowserCustomSigner config.network must be a bitcoinjs-lib Network",
      );
    }

    const network = config.network;
    const walletNetwork = deriveWalletNetwork(network, config.walletNetwork);
    const coinType = network === networks.bitcoin ? 0 : 1;

    let node: BIP32Interface;
    let blsIkm: Uint8Array;
    let blsAccountIndex: number;

    if (isSeedConfig(config)) {
      const seed = config.seed;
      if (!(seed instanceof Uint8Array)) {
        throw new Error(
          "InBrowserCustomSigner config.seed must be a Uint8Array",
        );
      }
      if (seed.length < 16) {
        throw new Error(
          "InBrowserCustomSigner config.seed must be at least 16 bytes",
        );
      }
      const accountIndex = config.accountIndex ?? 0;
      if (!Number.isInteger(accountIndex) || accountIndex < 0) {
        throw new Error(
          "InBrowserCustomSigner config.accountIndex must be a non-negative integer",
        );
      }
      const path =
        config.taprootDerivationPath ??
        `m/86'/${coinType}'/${accountIndex}'/0/0`;
      const root = bip32.fromSeed(seed, network);
      node = root.derivePath(path);
      blsIkm = seed;
      blsAccountIndex = accountIndex;
    } else {
      const privateKey = config.privateKey;
      if (!(privateKey instanceof Uint8Array)) {
        throw new Error(
          "InBrowserCustomSigner config.privateKey must be a Uint8Array",
        );
      }
      if (privateKey.length !== 32) {
        throw new Error(
          "InBrowserCustomSigner config.privateKey must be exactly 32 bytes",
        );
      }
      const chainCode = deriveSyntheticChainCode(privateKey);
      node = bip32.fromPrivateKey(privateKey, chainCode, network);
      blsIkm = privateKey;
      blsAccountIndex = 0;
    }

    if (!node.privateKey) {
      throw new Error(
        "InBrowserCustomSigner failed to derive a private key from the provided config",
      );
    }

    const xpubkey = node.neutered().toBase58();
    const xOnlyBytes = node.publicKey.slice(1);
    const xOnlyHex = bytesToHex(xOnlyBytes);

    const taprootAddress = payments.p2tr({
      internalPubkey: xOnlyBytes,
      network,
    }).address;
    if (!taprootAddress) {
      throw new Error(
        "InBrowserCustomSigner failed to derive a Taproot (p2tr) address",
      );
    }

    const blsPrivateKey = deriveBlsKey(blsIkm, coinType, blsAccountIndex);
    const blsPubkey = blsGetPublicKey(blsPrivateKey);
    const schnorrSig = bytesToHex(
      node.signSchnorr(schnorrBindingHash(blsPubkey)),
    );
    const blsSig = signBlsBinding(blsPrivateKey, xOnlyHex);

    this.blsPrivateKey = blsPrivateKey;
    this.cachedAddress = { address: taprootAddress, network: walletNetwork };
    this.cachedPoP = { xpubkey, blsPubkey, schnorrSig, blsSig };
  }

  async getAddress(): Promise<WalletAddress> {
    return { ...this.cachedAddress };
  }

  async getBLSPoP(address: string): Promise<BLSPoP> {
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("getBLSPoP requires a non-empty address");
    }
    if (address !== this.cachedAddress.address) {
      throw new Error(
        "InBrowserCustomSigner is single-account: requested address does not match the derived Taproot address",
      );
    }
    return { ...this.cachedPoP };
  }

  async signBLS(params: BLSSignParams): Promise<string> {
    if (!params || typeof params !== "object") {
      throw new Error("signBLS requires params object");
    }
    if (typeof params.dst !== "string" || params.dst.length === 0) {
      throw new Error("signBLS requires a non-empty dst");
    }
    const hasMessage = typeof params.message === "string";
    const hasMessageHex = typeof params.messageHex === "string";
    if (hasMessage && hasMessageHex) {
      throw new Error(
        "signBLS requires exactly one of message or messageHex (got both)",
      );
    }
    if (!hasMessage && !hasMessageHex) {
      throw new Error("signBLS requires either message or messageHex");
    }
    if (
      params.address !== undefined &&
      params.address !== this.cachedAddress.address
    ) {
      throw new Error(
        "InBrowserCustomSigner is single-account: signBLS address does not match the derived Taproot address",
      );
    }

    const hexPayload = hasMessageHex
      ? (params.messageHex as string)
      : bytesToHex(new TextEncoder().encode(params.message as string));

    return blsSign(hexPayload, this.blsPrivateKey, params.dst);
  }
}
