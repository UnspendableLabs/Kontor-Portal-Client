import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_WASM_URL } from "../kontor-crypto";

describe("kontor-crypto", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("DEFAULT_WASM_URL", () => {
    it("has expected value", () => {
      expect(DEFAULT_WASM_URL).toBe("/kontor-crypto/index.js");
    });
  });

  describe("prepareFile (default export)", () => {
    it("delegates to the default crypto provider", async () => {
      const mockResult = {
        metadata: {
          root: "r",
          objectId: "o",
          fileId: "f",
          nonce: [],
          paddedLen: 0,
          originalSize: 0,
          filename: "",
        },
        preparedFile: { root: "r", fileId: "f", treeLeavesHex: [] },
        descriptor: {
          fileId: "f",
          objectId: "o",
          nonce: [],
          root: [],
          paddedLen: 0,
          originalSize: 0,
          filename: "",
        },
      };

      vi.doMock("/kontor-crypto/index.js", () => ({
        prepareFile: vi.fn().mockResolvedValue(mockResult),
      }));

      const { prepareFile } = await import("../kontor-crypto");
      const result = await prepareFile(new Uint8Array([1]));
      expect(result).toEqual(mockResult);
    });
  });

  describe("createCryptoProvider", () => {
    it("lazily loads the module and calls prepareFile", async () => {
      const mockResult = {
        metadata: {
          root: "aa",
          objectId: "bb",
          fileId: "fid",
          nonce: [],
          paddedLen: 512,
          originalSize: 10,
          filename: "f.txt",
        },
        preparedFile: { root: "aa", fileId: "fid", treeLeavesHex: [] },
        descriptor: {
          fileId: "fid",
          objectId: "bb",
          nonce: [],
          root: [],
          paddedLen: 512,
          originalSize: 10,
          filename: "f.txt",
        },
      };

      const mockPrepareFile = vi.fn().mockResolvedValue(mockResult);
      const mockModule = { prepareFile: mockPrepareFile };

      vi.doMock("/test-wasm/index.js", () => mockModule);

      const { createCryptoProvider } = await import("../kontor-crypto");
      const provider = createCryptoProvider("/test-wasm/index.js");

      const file = new Uint8Array([1, 2, 3]);
      const result = await provider.prepareFile(file);

      expect(result).toEqual(mockResult);
      expect(mockPrepareFile).toHaveBeenCalledWith(
        file,
        undefined,
        undefined,
        undefined,
      );
    });

    it("caches the module across calls", async () => {
      let importCount = 0;
      const mockModule = {
        prepareFile: vi.fn().mockResolvedValue({
          metadata: {
            root: "r",
            objectId: "o",
            fileId: "f",
            nonce: [],
            paddedLen: 0,
            originalSize: 0,
            filename: "",
          },
          preparedFile: { root: "r", fileId: "f", treeLeavesHex: [] },
          descriptor: {
            fileId: "f",
            objectId: "o",
            nonce: [],
            root: [],
            paddedLen: 0,
            originalSize: 0,
            filename: "",
          },
        }),
      };

      vi.doMock("/cache-test/index.js", () => {
        importCount++;
        return mockModule;
      });

      const { createCryptoProvider } = await import("../kontor-crypto");
      const provider = createCryptoProvider("/cache-test/index.js");

      await provider.prepareFile(new Uint8Array(0));
      await provider.prepareFile(new Uint8Array(0));

      expect(importCount).toBe(1);
    });

    it("passes onProgress callback through", async () => {
      const mockPrepareFile = vi.fn().mockResolvedValue({
        metadata: {
          root: "r",
          objectId: "o",
          fileId: "f",
          nonce: [],
          paddedLen: 0,
          originalSize: 0,
          filename: "",
        },
        preparedFile: { root: "r", fileId: "f", treeLeavesHex: [] },
        descriptor: {
          fileId: "f",
          objectId: "o",
          nonce: [],
          root: [],
          paddedLen: 0,
          originalSize: 0,
          filename: "",
        },
      });

      vi.doMock("/progress-test/index.js", () => ({
        prepareFile: mockPrepareFile,
      }));

      const { createCryptoProvider } = await import("../kontor-crypto");
      const provider = createCryptoProvider("/progress-test/index.js");
      const cb = vi.fn();

      await provider.prepareFile(new Uint8Array(0), cb);
      expect(mockPrepareFile).toHaveBeenCalledWith(
        new Uint8Array(0),
        undefined,
        undefined,
        cb,
      );
    });
  });
});
