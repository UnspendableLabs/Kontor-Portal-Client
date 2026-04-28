import { describe, it, expect } from "vitest";
import ecc from "@bitcoinerlab/secp256k1";
import { BIP32Factory } from "bip32";
import { networks } from "bitcoinjs-lib";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { InBrowserCustomSigner } from "../in-browser-custom-signer";
import { schnorrBindingHash, KONTOR_BLS_DST } from "../bls-primitives";
import { bytesToHex, hexToBytes } from "../postcard";

const bip32 = BIP32Factory(ecc);

const SEED = Uint8Array.from(Array.from({ length: 64 }, (_, i) => i));
const PRIV_KEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));

const EXPECTED_SEED_MAINNET = {
  xpubkey:
    "xpub6GKKynNhXjxiLKACb8M6cFX2xTJWPSUtvAtsBDdfoAm6xg6LiS64ckTf9szqR9U7xKpHi9gvsXDgV8cAUDwuHyjELVeWWbq44E5Jxx5Dn9y",
  xOnlyHex:
    "0afbc62f6ded5812d22151535dddb302d8b42f9097a8faa7fcf6ac1513ca6d25",
  address: "bc1p6cn3q2p5fgdj5l48r25clf3e4pztd9rvtvpxgg9tym5z3wjn6nusclnhlz",
  blsPubkey:
    "9251e095439a37075b48b3fca3f63b53134743456646f5173f63b765d93164824f08b722b4339a7eab55c614548751dc178b7b2a7ac21829dfbd95b72620d9ebfa423c15966b4d07a25e4dde4091f229f2dadc1db8c48a9da7536da86db77aa5",
  blsSig:
    "b5b79407de0a11d00a50f68deb7c0b500d6c68fc21e123a138738dffba71430a1aed51d006f94682e7e70cbd7c4771fa",
};

const EXPECTED_SEED_TESTNET = {
  xpubkey:
    "tpubDFyrhGPMgHrgRxrCzx2uovMmxtmEq1VzRJhaq8p2xqxSZXpa6z2MEJJyKMW6XxJbxnNeAPqUwVproU7kVPKnKRuT9ic7YVQWrNrNdJztXBs",
  address: "tb1p92pmjh2ljkactjjlqrhl3xzwuv7wd6rh9x5hvmle8n9zdky46mdqm7qa9z",
  blsPubkey:
    "a56dd059afccd191121b9bb8ec2ff6b9b18e302064e18faca45b6e1b38eb7c7f37130d01ead92037459663c4ff9be3d8198223658e0a0196af2fe68de58cbce9e0299c76e6ec5223791344f3bbda528b7b81dea5fd55b204027d54fa242fdcec",
};

const EXPECTED_PK_MAINNET = {
  xpubkey:
    "xpub661MyMwAqRbcFa4LuksQJq1p7p8nyuou2sECHV6iPtY7bWmnwVD99TwnjRDYE56SLnZ4NBjkNXFQdaHRxqv8671eKbfupQseDWTUCnosnnu",
  xOnlyHex:
    "84bf7562262bbd6940085748f3be6afa52ae317155181ece31b66351ccffa4b0",
  address: "bc1pf22hwrhley3ah6qjt6234rs00fn84c2396ky4yea305kl02ezyns3k932r",
  blsPubkey:
    "8d3a402d12fa41b8521af49d77a485926ff395a3a0a071be25f3469da9765be09bea7452440e3aa686f8cf45592e02a01861eba661483ab33f2126becb01616db016e957930edec680b1f88d0411498c4aef0744ddcd02a3b7a3c956a4aac9d6",
  blsSig:
    "a285e49c063783cd0fbc49bcf7fdc55113bc21ac02172d257171decd8aa9da978468692c9d005b9b1859a2aea9ae1f6f",
};

/**
 * Helper: rebuild the BLS signature hashed message exactly as
 * `signBlsBinding` does, so we can verify the cached `blsSig`.
 */
function blsBindingHashed(xOnlyHex: string) {
  const prefix = new TextEncoder().encode("KONTOR_BLS_TO_XONLY_V1");
  const xOnlyBytes = hexToBytes(xOnlyHex);
  const msg = new Uint8Array(prefix.length + xOnlyBytes.length);
  msg.set(prefix);
  msg.set(xOnlyBytes, prefix.length);
  return bls12_381.shortSignatures.hash(msg, KONTOR_BLS_DST);
}

describe("InBrowserCustomSigner", () => {
  describe("constructor (seed branch)", () => {
    it("derives the expected mainnet xpub, x-only key, and Taproot address", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const addr = await signer.getAddress();
      expect(addr).toEqual({
        address: EXPECTED_SEED_MAINNET.address,
        network: "mainnet",
      });

      const pop = await signer.getBLSPoP(EXPECTED_SEED_MAINNET.address);
      expect(pop.xpubkey).toBe(EXPECTED_SEED_MAINNET.xpubkey);
      expect(pop.blsPubkey).toBe(EXPECTED_SEED_MAINNET.blsPubkey);
      expect(pop.blsSig).toBe(EXPECTED_SEED_MAINNET.blsSig);
    });

    it("derives the expected signet xpub and Taproot address", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.testnet,
      });
      const addr = await signer.getAddress();
      expect(addr).toEqual({
        address: EXPECTED_SEED_TESTNET.address,
        network: "signet",
      });

      const pop = await signer.getBLSPoP(EXPECTED_SEED_TESTNET.address);
      expect(pop.xpubkey).toBe(EXPECTED_SEED_TESTNET.xpubkey);
      expect(pop.blsPubkey).toBe(EXPECTED_SEED_TESTNET.blsPubkey);
    });

    it("respects an explicit walletNetwork override", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.testnet,
        walletNetwork: "testnet4",
      });
      const addr = await signer.getAddress();
      expect(addr.network).toBe("testnet4");
    });

    it("respects an explicit accountIndex (different blsPubkey from index 0)", async () => {
      const signerDefault = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.testnet,
      });
      const signerIdx5 = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.testnet,
        accountIndex: 5,
      });
      const popDefault = await signerDefault.getBLSPoP(
        EXPECTED_SEED_TESTNET.address,
      );
      const popIdx5 = await signerIdx5.getBLSPoP(
        (await signerIdx5.getAddress()).address,
      );
      expect(popIdx5.blsPubkey).not.toBe(popDefault.blsPubkey);
    });

    it("respects an explicit taprootDerivationPath", async () => {
      const signerDefault = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const signerCustom = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
        taprootDerivationPath: "m/86'/0'/0'/0/1",
      });
      const a = await signerDefault.getAddress();
      const b = await signerCustom.getAddress();
      expect(a.address).not.toBe(b.address);
    });

    it("produces a Schnorr signature that verifies for the seed branch", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const pop = await signer.getBLSPoP(EXPECTED_SEED_MAINNET.address);
      const hash = schnorrBindingHash(pop.blsPubkey);
      const sigBytes = hexToBytes(pop.schnorrSig);
      const xOnly = hexToBytes(EXPECTED_SEED_MAINNET.xOnlyHex);
      expect(sigBytes.length).toBe(64);
      expect(ecc.verifySchnorr!(hash, xOnly, sigBytes)).toBe(true);
    });

    it("produces a BLS binding signature that verifies for the seed branch", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const pop = await signer.getBLSPoP(EXPECTED_SEED_MAINNET.address);
      const sigPoint = bls12_381.shortSignatures.Signature.fromHex(pop.blsSig);
      const pubPoint = bls12_381.G2.Point.fromHex(pop.blsPubkey);
      const hashed = blsBindingHashed(EXPECTED_SEED_MAINNET.xOnlyHex);
      expect(
        bls12_381.shortSignatures.verify(sigPoint, hashed, pubPoint),
      ).toBe(true);
    });
  });

  describe("constructor (privateKey branch)", () => {
    it("derives the expected synthetic xpub and Taproot address", async () => {
      const signer = new InBrowserCustomSigner({
        privateKey: PRIV_KEY,
        network: networks.bitcoin,
      });
      const addr = await signer.getAddress();
      expect(addr).toEqual({
        address: EXPECTED_PK_MAINNET.address,
        network: "mainnet",
      });

      const pop = await signer.getBLSPoP(EXPECTED_PK_MAINNET.address);
      expect(pop.xpubkey).toBe(EXPECTED_PK_MAINNET.xpubkey);
      expect(pop.blsPubkey).toBe(EXPECTED_PK_MAINNET.blsPubkey);
      expect(pop.blsSig).toBe(EXPECTED_PK_MAINNET.blsSig);
    });

    it("xpub round-trips back to the same compressed pubkey", async () => {
      const signer = new InBrowserCustomSigner({
        privateKey: PRIV_KEY,
        network: networks.bitcoin,
      });
      const pop = await signer.getBLSPoP(EXPECTED_PK_MAINNET.address);
      const node = bip32.fromBase58(pop.xpubkey, networks.bitcoin);
      const compressed = bytesToHex(new Uint8Array(node.publicKey));
      const xOnly = bytesToHex(new Uint8Array(node.publicKey).subarray(1));
      expect(xOnly).toBe(EXPECTED_PK_MAINNET.xOnlyHex);
      expect(compressed.startsWith("02") || compressed.startsWith("03")).toBe(
        true,
      );
    });

    it("produces a Schnorr signature that verifies for the privateKey branch", async () => {
      const signer = new InBrowserCustomSigner({
        privateKey: PRIV_KEY,
        network: networks.bitcoin,
      });
      const pop = await signer.getBLSPoP(EXPECTED_PK_MAINNET.address);
      const hash = schnorrBindingHash(pop.blsPubkey);
      const sigBytes = hexToBytes(pop.schnorrSig);
      const xOnly = hexToBytes(EXPECTED_PK_MAINNET.xOnlyHex);
      expect(ecc.verifySchnorr!(hash, xOnly, sigBytes)).toBe(true);
    });

    it("produces a BLS binding signature that verifies for the privateKey branch", async () => {
      const signer = new InBrowserCustomSigner({
        privateKey: PRIV_KEY,
        network: networks.bitcoin,
      });
      const pop = await signer.getBLSPoP(EXPECTED_PK_MAINNET.address);
      const sigPoint = bls12_381.shortSignatures.Signature.fromHex(pop.blsSig);
      const pubPoint = bls12_381.G2.Point.fromHex(pop.blsPubkey);
      const hashed = blsBindingHashed(EXPECTED_PK_MAINNET.xOnlyHex);
      expect(
        bls12_381.shortSignatures.verify(sigPoint, hashed, pubPoint),
      ).toBe(true);
    });

    it("derives a different Taproot address on testnet vs mainnet", async () => {
      const main = new InBrowserCustomSigner({
        privateKey: PRIV_KEY,
        network: networks.bitcoin,
      });
      const test = new InBrowserCustomSigner({
        privateKey: PRIV_KEY,
        network: networks.testnet,
      });
      const a = await main.getAddress();
      const b = await test.getAddress();
      expect(a.address).not.toBe(b.address);
      expect(a.network).toBe("mainnet");
      expect(b.network).toBe("signet");
    });
  });

  describe("getBLSPoP", () => {
    it("throws when the address does not match the cached one", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      await expect(signer.getBLSPoP("bc1p_other")).rejects.toThrow(
        "single-account",
      );
    });

    it("throws on empty address", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      await expect(signer.getBLSPoP("")).rejects.toThrow("non-empty address");
    });

    it("returns a fresh object each call (does not leak the cached reference)", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const a = await signer.getBLSPoP(EXPECTED_SEED_MAINNET.address);
      const b = await signer.getBLSPoP(EXPECTED_SEED_MAINNET.address);
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("signBLS", () => {
    it("signs with messageHex and matches the BLS primitive output", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const sig = await signer.signBLS({
        messageHex: "aabbccdd",
        dst: KONTOR_BLS_DST,
      });
      expect(sig).toBe(
        "b1ec7ccc407fa4ad88548f2348dd9176d514da830bc90b05b245a6f1fe61cf1dbaf466251735230eeab9660f645c6e24",
      );
    });

    it("signs with UTF-8 message (hex-encodes internally)", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const sig = await signer.signBLS({
        message: "hello",
        dst: KONTOR_BLS_DST,
      });
      expect(sig).toBe(
        "8c598f4cb5c9efd80e18c4bacbe671f55df8f0e98070ceb9c140ba2320d7118a26b576edb81135972b8cce6e87a8a0ee",
      );
    });

    it("respects a custom DST", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      const sig = await signer.signBLS({
        messageHex: "aabbccdd",
        dst: "CUSTOM_DST",
      });
      expect(sig).toBe(
        "a72b8140c308ef31f8d48653c3a6caa87077f9efce112bf3f73dac08c1d36f768f22727e099a2e0cf706ea70a440eed6",
      );
    });

    it("forwards the cached address when provided", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      await expect(
        signer.signBLS({
          messageHex: "aabbccdd",
          dst: KONTOR_BLS_DST,
          address: EXPECTED_SEED_MAINNET.address,
        }),
      ).resolves.toBeTypeOf("string");
    });

    it("throws when both message and messageHex are provided", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      await expect(
        signer.signBLS({
          message: "hi",
          messageHex: "aabb",
          dst: KONTOR_BLS_DST,
        }),
      ).rejects.toThrow("exactly one of message or messageHex");
    });

    it("throws when neither message nor messageHex is provided", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      await expect(
        signer.signBLS({ dst: KONTOR_BLS_DST }),
      ).rejects.toThrow("requires either message or messageHex");
    });

    it("throws on missing or empty dst", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      await expect(
        signer.signBLS({ messageHex: "aabb", dst: "" }),
      ).rejects.toThrow("non-empty dst");
    });

    it("throws on address mismatch", async () => {
      const signer = new InBrowserCustomSigner({
        seed: SEED,
        network: networks.bitcoin,
      });
      await expect(
        signer.signBLS({
          messageHex: "aabb",
          dst: KONTOR_BLS_DST,
          address: "bc1p_wrong",
        }),
      ).rejects.toThrow("single-account");
    });

    it("works in the privateKey branch with messageHex", async () => {
      const signer = new InBrowserCustomSigner({
        privateKey: PRIV_KEY,
        network: networks.bitcoin,
      });
      const sig = await signer.signBLS({
        messageHex: "aabb",
        dst: KONTOR_BLS_DST,
      });
      expect(sig).toMatch(/^[0-9a-f]{96}$/);
    });
  });

  describe("input validation", () => {
    it("throws when config is missing", () => {
      expect(
        () =>
          new InBrowserCustomSigner(
            undefined as unknown as ConstructorParameters<
              typeof InBrowserCustomSigner
            >[0],
          ),
      ).toThrow("config object");
    });

    it("throws when network is missing", () => {
      expect(
        () =>
          new InBrowserCustomSigner({
            seed: SEED,
          } as unknown as ConstructorParameters<
            typeof InBrowserCustomSigner
          >[0]),
      ).toThrow("Network");
    });

    it("throws when seed is not a Uint8Array", () => {
      expect(
        () =>
          new InBrowserCustomSigner({
            seed: "abc" as unknown as Uint8Array,
            network: networks.bitcoin,
          }),
      ).toThrow("Uint8Array");
    });

    it("throws when seed is too short", () => {
      expect(
        () =>
          new InBrowserCustomSigner({
            seed: new Uint8Array(8),
            network: networks.bitcoin,
          }),
      ).toThrow("at least 16 bytes");
    });

    it("throws when accountIndex is negative", () => {
      expect(
        () =>
          new InBrowserCustomSigner({
            seed: SEED,
            network: networks.bitcoin,
            accountIndex: -1,
          }),
      ).toThrow("accountIndex");
    });

    it("throws when privateKey is not a Uint8Array", () => {
      expect(
        () =>
          new InBrowserCustomSigner({
            privateKey: "abc" as unknown as Uint8Array,
            network: networks.bitcoin,
          }),
      ).toThrow("Uint8Array");
    });

    it("throws when privateKey is the wrong length", () => {
      expect(
        () =>
          new InBrowserCustomSigner({
            privateKey: new Uint8Array(31),
            network: networks.bitcoin,
          }),
      ).toThrow("32 bytes");
    });
  });
});
