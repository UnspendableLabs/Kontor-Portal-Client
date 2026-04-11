import { vi } from "vitest";
import type { BLSSigner } from "../../types";
import { POP, BLS_SIGNATURE } from "./fixtures";

export function createMockSigner(): BLSSigner & {
  getBLSPoP: ReturnType<typeof vi.fn>;
  signBLS: ReturnType<typeof vi.fn>;
} {
  return {
    getBLSPoP: vi.fn().mockResolvedValue({ ...POP }),
    signBLS: vi.fn().mockResolvedValue(BLS_SIGNATURE),
  };
}
