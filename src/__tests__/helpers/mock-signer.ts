import { vi } from "vitest";
import type { BLSSigner, WalletAddress, WalletNetwork } from "../../types";
import { POP, BLS_SIGNATURE } from "./fixtures";

export const MOCK_TAPROOT_ADDRESS = "tb1pmocktaprootaddress";

export interface MockSignerOptions {
  address?: string;
  network?: WalletNetwork;
}

export function createMockSigner(
  options?: MockSignerOptions,
): BLSSigner & {
  getAddress: ReturnType<typeof vi.fn>;
  getBLSPoP: ReturnType<typeof vi.fn>;
  signBLS: ReturnType<typeof vi.fn>;
} {
  const walletAddress: WalletAddress = {
    address: options?.address ?? MOCK_TAPROOT_ADDRESS,
    network: options?.network ?? "signet",
  };
  return {
    getAddress: vi.fn().mockResolvedValue(walletAddress),
    getBLSPoP: vi.fn().mockResolvedValue({ ...POP }),
    signBLS: vi.fn().mockResolvedValue(BLS_SIGNATURE),
  };
}
