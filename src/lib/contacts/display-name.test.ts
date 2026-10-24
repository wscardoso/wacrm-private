import { describe, expect, it } from "vitest";
import { contactDisplayName } from "./display-name";

describe("contactDisplayName", () => {
  it("returns the trimmed name when it has readable content", () => {
    expect(contactDisplayName("  Thiago ", "5531999999999")).toBe("Thiago");
    expect(contactDisplayName("João", null)).toBe("João");
    expect(contactDisplayName("2B", null)).toBe("2B");
  });

  it("falls back to the phone for punctuation-only or blank names", () => {
    expect(contactDisplayName(".", "5531999999999")).toBe("5531999999999");
    expect(contactDisplayName(" - ", "5531999999999")).toBe("5531999999999");
    expect(contactDisplayName("   ", "5531999999999")).toBe("5531999999999");
    expect(contactDisplayName(null, "5531999999999")).toBe("5531999999999");
  });

  it("returns null when neither name nor phone is usable", () => {
    expect(contactDisplayName(".", "")).toBeNull();
    expect(contactDisplayName(undefined, undefined)).toBeNull();
  });
});
