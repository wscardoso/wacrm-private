import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyMetaWebhookSignature } from "./webhook-signature";

const SECRET = process.env.META_APP_SECRET ?? "test-meta-app-secret";

function makeSignature(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// ─── Valid signatures ──────────────────────────────────────────────────────

describe("verifyMetaWebhookSignature — valid", () => {
  it("accepts a correctly signed payload", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyMetaWebhookSignature(body, makeSignature(body))).toBe(true);
  });

  it("accepts an empty body with correct signature", () => {
    expect(verifyMetaWebhookSignature("", makeSignature(""))).toBe(true);
  });

  it("accepts a large payload (10 KB)", () => {
    const body = "x".repeat(10_000);
    expect(verifyMetaWebhookSignature(body, makeSignature(body))).toBe(true);
  });
});

// ─── Invalid signatures ────────────────────────────────────────────────────

describe("verifyMetaWebhookSignature — invalid", () => {
  it("returns false for wrong signature", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyMetaWebhookSignature(body, "sha256=deadbeef")).toBe(false);
  });

  it("returns false when body is tampered after signing", () => {
    const original = JSON.stringify({ data: "original" });
    const sig = makeSignature(original);
    expect(verifyMetaWebhookSignature(JSON.stringify({ data: "tampered" }), sig)).toBe(false);
  });

  it("returns false for signature from wrong secret", () => {
    const body = "payload";
    expect(verifyMetaWebhookSignature(body, makeSignature(body, "wrong-secret"))).toBe(false);
  });

  it("returns false for null signature header", () => {
    expect(verifyMetaWebhookSignature("payload", null)).toBe(false);
  });

  it("returns false for empty signature string", () => {
    expect(verifyMetaWebhookSignature("payload", "")).toBe(false);
  });

  it("returns false when sha256= prefix is missing", () => {
    const body = "payload";
    const hmac = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyMetaWebhookSignature(body, hmac)).toBe(false);
  });

  // Regression: reproduces the "amputated header" symptom seen when a
  // test script fails to compute the hash (e.g. the signing secret is
  // unset in that shell session) but still concatenates the prefix —
  // producing a syntactically valid but hash-less header. Confirmed
  // 2026-07-16: not a webhook bug, the header itself was malformed
  // before it ever left the client.
  it("returns false for a valid-prefix header with an empty hash (sha256=)", () => {
    expect(verifyMetaWebhookSignature("payload", "sha256=")).toBe(false);
  });
});

// ─── Timing safety ─────────────────────────────────────────────────────────

describe("verifyMetaWebhookSignature — timing safety", () => {
  it("does not throw on signature length mismatch", () => {
    expect(() =>
      verifyMetaWebhookSignature("payload", "sha256=short")
    ).not.toThrow();
  });
});
