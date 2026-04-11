import { describe, it, expect } from "vitest";
import { networks } from "bitcoinjs-lib";
import { getXOnlyPubkeyHexFromXpub } from "../xpub-utils";
import { VALID_TPUB, VALID_X_ONLY } from "./helpers/fixtures";

describe("getXOnlyPubkeyHexFromXpub", () => {
  it("returns the correct 64-char x-only pubkey", () => {
    const result = getXOnlyPubkeyHexFromXpub(VALID_TPUB, networks.testnet);
    expect(result).toBe(VALID_X_ONLY);
  });

  it("is deterministic", () => {
    const a = getXOnlyPubkeyHexFromXpub(VALID_TPUB, networks.testnet);
    const b = getXOnlyPubkeyHexFromXpub(VALID_TPUB, networks.testnet);
    expect(a).toBe(b);
  });

  it("throws on invalid xpub", () => {
    expect(() =>
      getXOnlyPubkeyHexFromXpub("not-an-xpub", networks.testnet),
    ).toThrow();
  });
});
