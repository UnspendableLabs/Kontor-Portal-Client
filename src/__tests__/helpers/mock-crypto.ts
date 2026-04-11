import { vi } from "vitest";
import type { KontorCryptoProvider } from "../../types";
import { PREPARE_RESULT } from "./fixtures";

export function createMockCrypto(): KontorCryptoProvider & {
  prepareFile: ReturnType<typeof vi.fn>;
} {
  return {
    prepareFile: vi.fn().mockResolvedValue(structuredClone(PREPARE_RESULT)),
  };
}
