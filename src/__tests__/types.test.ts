import { describe, it, expect } from "vitest";
import { PortalNotFoundError } from "../types";

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
