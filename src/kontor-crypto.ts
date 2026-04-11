interface FileMetadata {
  root: string;
  objectId: string;
  fileId: string;
  nonce: number[];
  paddedLen: number;
  originalSize: number;
  filename: string;
}

interface PreparedFileData {
  root: string;
  fileId: string;
  treeLeavesHex: string[];
}

interface RawFileDescriptor {
  fileId: string;
  objectId: string;
  nonce: number[];
  root: number[];
  paddedLen: number;
  originalSize: number;
  filename: string;
}

export interface PrepareResult {
  metadata: FileMetadata;
  preparedFile: PreparedFileData;
  descriptor: RawFileDescriptor;
}

export type ProgressPhase = "reading" | "encoding" | "merkle" | "finalizing";
export type OnProgress = (progress: number, phase: ProgressPhase) => void;

interface KontorCryptoModule {
  prepareFile(
    file: File | Uint8Array | ArrayBuffer,
    filename?: string,
    nonce?: Uint8Array,
    onProgress?: OnProgress,
  ): Promise<PrepareResult>;
}

export const DEFAULT_WASM_URL = "/kontor-crypto/index.js";

export function createCryptoProvider(wasmUrl = DEFAULT_WASM_URL) {
  let modPromise: Promise<KontorCryptoModule> | null = null;

  function loadModule(): Promise<KontorCryptoModule> {
    if (!modPromise) {
      modPromise = import(
        /* webpackIgnore: true */ wasmUrl
      ) as Promise<KontorCryptoModule>;
      modPromise.catch(() => {
        modPromise = null;
      });
    }
    return modPromise;
  }

  return {
    async prepareFile(
      file: File | Uint8Array | ArrayBuffer,
      onProgress?: OnProgress,
    ): Promise<PrepareResult> {
      const mod = await loadModule();
      return mod.prepareFile(file, undefined, undefined, onProgress);
    },
  };
}

const defaultCrypto = createCryptoProvider();

export async function prepareFile(
  file: File | Uint8Array | ArrayBuffer,
  onProgress?: OnProgress,
): Promise<PrepareResult> {
  return defaultCrypto.prepareFile(file, onProgress);
}
