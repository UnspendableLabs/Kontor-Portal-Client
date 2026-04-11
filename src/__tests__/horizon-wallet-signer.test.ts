import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HorizonWalletSigner } from "../horizon-wallet-signer";
import type { HorizonWalletProviderLike } from "../types";

function installProvider(
  provider: HorizonWalletProviderLike,
): void {
  (window as Window & { HorizonWalletProvider?: HorizonWalletProviderLike }).HorizonWalletProvider =
    provider;
}

function removeProvider(): void {
  delete (window as Window & { HorizonWalletProvider?: unknown })
    .HorizonWalletProvider;
}

describe("HorizonWalletSigner", () => {
  afterEach(() => {
    removeProvider();
    vi.restoreAllMocks();
  });

  describe("getProvider", () => {
    it("throws when provider is not installed", async () => {
      const signer = new HorizonWalletSigner();
      await expect(signer.getBLSPoP("addr")).rejects.toThrow(
        "Horizon Wallet not detected",
      );
    });
  });

  describe("getBLSPoP", () => {
    it("returns PoP on success", async () => {
      const pop = {
        xpubkey: "xpub123",
        blsPubkey: "bls123",
        schnorrSig: "sig123",
        blsSig: "blssig123",
      };
      installProvider({
        request: vi.fn().mockResolvedValue({ result: pop }),
      });

      const signer = new HorizonWalletSigner();
      const result = await signer.getBLSPoP("tb1addr");
      expect(result).toEqual(pop);
    });

    it("calls provider with correct method and params", async () => {
      const requestFn = vi.fn().mockResolvedValue({
        result: {
          xpubkey: "x",
          blsPubkey: "b",
          schnorrSig: "s",
          blsSig: "bs",
        },
      });
      installProvider({ request: requestFn });

      const signer = new HorizonWalletSigner();
      await signer.getBLSPoP("tb1myaddr");
      expect(requestFn).toHaveBeenCalledWith("getBLSPoP", {
        address: "tb1myaddr",
      });
    });

    it("throws on wallet RPC error (string)", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({ error: "User rejected" }),
      });
      const signer = new HorizonWalletSigner();
      await expect(signer.getBLSPoP("addr")).rejects.toThrow("User rejected");
    });

    it("throws on wallet RPC error (object with message)", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({
          error: { message: "Permission denied" },
        }),
      });
      const signer = new HorizonWalletSigner();
      await expect(signer.getBLSPoP("addr")).rejects.toThrow(
        "Permission denied",
      );
    });

    it("throws on wallet RPC error (object without message)", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({
          error: { code: 42 },
        }),
      });
      const signer = new HorizonWalletSigner();
      await expect(signer.getBLSPoP("addr")).rejects.toThrow('{"code":42}');
    });

    it("throws on null PoP result", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({ result: null }),
      });
      const signer = new HorizonWalletSigner();
      await expect(signer.getBLSPoP("addr")).rejects.toThrow(
        "Proof of Possession data",
      );
    });

    it("throws on invalid PoP shape (missing field)", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({
          result: { xpubkey: "x", blsPubkey: "", schnorrSig: "s", blsSig: "b" },
        }),
      });
      const signer = new HorizonWalletSigner();
      await expect(signer.getBLSPoP("addr")).rejects.toThrow(
        "valid Proof of Possession",
      );
    });

    it("times out when wallet does not respond", async () => {
      installProvider({
        request: () => new Promise(() => {}),
      });
      const signer = new HorizonWalletSigner(50);
      await expect(signer.getBLSPoP("addr")).rejects.toThrow(
        "did not respond",
      );
    });
  });

  describe("signBLS", () => {
    const validSig = "abcdef";

    beforeEach(() => {
      installProvider({
        request: vi.fn().mockResolvedValue({
          result: { signature: validSig },
        }),
      });
    });

    it("signs with messageHex", async () => {
      const signer = new HorizonWalletSigner();
      const sig = await signer.signBLS({
        messageHex: "aabb",
        dst: "TEST_DST",
      });
      expect(sig).toBe(validSig);
    });

    it("signs with message (UTF-8)", async () => {
      const signer = new HorizonWalletSigner();
      const sig = await signer.signBLS({
        message: "hello",
        dst: "TEST_DST",
      });
      expect(sig).toBe(validSig);
    });

    it("prefers messageHex over message", async () => {
      const requestFn = vi.fn().mockResolvedValue({
        result: { signature: validSig },
      });
      installProvider({ request: requestFn });

      const signer = new HorizonWalletSigner();
      await signer.signBLS({
        messageHex: "aabb",
        message: "ignored",
        dst: "DST",
      });
      expect(requestFn).toHaveBeenCalledWith("signMessageBLS", {
        messageHex: "aabb",
        dst: "DST",
      });
    });

    it("throws when neither message nor messageHex provided", async () => {
      const signer = new HorizonWalletSigner();
      await expect(
        signer.signBLS({ dst: "DST" }),
      ).rejects.toThrow("requires either message or messageHex");
    });

    it("throws on empty signature", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({
          result: { signature: "" },
        }),
      });
      const signer = new HorizonWalletSigner();
      await expect(
        signer.signBLS({ message: "hi", dst: "DST" }),
      ).rejects.toThrow("valid signature");
    });

    it("throws on missing signature field", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({ result: {} }),
      });
      const signer = new HorizonWalletSigner();
      await expect(
        signer.signBLS({ message: "hi", dst: "DST" }),
      ).rejects.toThrow("valid signature");
    });

    it("times out", async () => {
      installProvider({
        request: () => new Promise(() => {}),
      });
      const signer = new HorizonWalletSigner(50);
      await expect(
        signer.signBLS({ message: "hi", dst: "DST" }),
      ).rejects.toThrow("did not respond");
    });

    it("throws on RPC error", async () => {
      installProvider({
        request: vi.fn().mockResolvedValue({ error: "Nope" }),
      });
      const signer = new HorizonWalletSigner();
      await expect(
        signer.signBLS({ message: "hi", dst: "DST" }),
      ).rejects.toThrow("Nope");
    });
  });
});
