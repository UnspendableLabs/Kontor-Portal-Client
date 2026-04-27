import { describe, it, expect } from "vitest";
import { NetworkMismatchError, PortalNotFoundError } from "../types";

describe("PortalNotFoundError", () => {
  it("is an instance of Error", () => {
    const err = new PortalNotFoundError("not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name PortalNotFoundError", () => {
    const err = new PortalNotFoundError("test");
    expect(err.name).toBe("PortalNotFoundError");
  });

  it("preserves the message", () => {
    const err = new PortalNotFoundError("Signer missing");
    expect(err.message).toBe("Signer missing");
  });

  it("has a stack trace", () => {
    const err = new PortalNotFoundError("x");
    expect(err.stack).toBeDefined();
  });
});

describe("NetworkMismatchError", () => {
  it("is an instance of Error", () => {
    const err = new NetworkMismatchError("mainnet", "signet");
    expect(err).toBeInstanceOf(Error);
  });

  it("has name NetworkMismatchError", () => {
    const err = new NetworkMismatchError("mainnet", "signet");
    expect(err.name).toBe("NetworkMismatchError");
  });

  it("exposes walletNetwork and clientNetwork", () => {
    const err = new NetworkMismatchError("testnet4", "signet");
    expect(err.walletNetwork).toBe("testnet4");
    expect(err.clientNetwork).toBe("signet");
  });

  it("formats a descriptive message", () => {
    const err = new NetworkMismatchError("mainnet", "signet");
    expect(err.message).toContain("mainnet");
    expect(err.message).toContain("signet");
  });
});
