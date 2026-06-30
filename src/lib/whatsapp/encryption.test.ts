import { describe, it, expect } from "vitest";
import { encrypt, decrypt, isLegacyFormat } from "./encryption";

// ─── Roundtrip ─────────────────────────────────────────────────────────────

describe("encrypt / decrypt roundtrip", () => {
  it("returns the original plaintext after roundtrip", () => {
    const plaintext = "whatsapp-token-abc123";
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("produces different ciphertext on every call (random IV)", () => {
    const ct1 = encrypt("same-input");
    const ct2 = encrypt("same-input");
    expect(ct1).not.toBe(ct2);
  });

  it("roundtrips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("roundtrips unicode / emoji", () => {
    const value = "token-🦅-üñíçödé";
    expect(decrypt(encrypt(value))).toBe(value);
  });

  it("roundtrips a long token (512 chars)", () => {
    expect(decrypt(encrypt("x".repeat(512)))).toBe("x".repeat(512));
  });
});

// ─── GCM output format ─────────────────────────────────────────────────────

describe("encrypt output format (GCM)", () => {
  it("produces iv:ciphertext:authTag format (2 colons)", () => {
    const parts = encrypt("test").split(":");
    expect(parts).toHaveLength(3);
  });

  it("is different from plaintext", () => {
    expect(encrypt("supersecret")).not.toBe("supersecret");
  });
});

// ─── isLegacyFormat ────────────────────────────────────────────────────────

describe("isLegacyFormat", () => {
  it("returns false for current GCM output (3 parts)", () => {
    expect(isLegacyFormat(encrypt("anything"))).toBe(false);
  });

  it("returns true for a legacy iv:ciphertext shape (2 parts)", () => {
    expect(isLegacyFormat("aabbcc:ddeeff")).toBe(true);
  });

  it("returns false for unrecognised shape (1 part)", () => {
    expect(isLegacyFormat("nodivider")).toBe(false);
  });
});

// ─── Decrypt error cases ───────────────────────────────────────────────────

describe("decrypt error cases", () => {
  it("throws on unrecognised format", () => {
    expect(() => decrypt("not-valid")).toThrow();
  });

  it("throws when GCM auth tag is tampered", () => {
    const ct = encrypt("original");
    const tampered = ct.slice(0, -4) + "0000";
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws when IV has wrong length for GCM", () => {
    expect(() => decrypt("aabb:ciphertext:authtag")).toThrow();
  });
});
