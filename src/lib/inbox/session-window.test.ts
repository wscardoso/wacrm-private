import { describe, it, expect } from "vitest";
import { computeSessionInfo } from "./session-window";
import type { Message } from "@/types";

/** Minimal message stub — only fields accessed by computeSessionInfo. */
function makeMsg(overrides: Partial<Message> & Pick<Message, "created_at">): Message {
  return {
    id: "msg-1",
    conversation_id: "conv-1",
    sender_type: "customer",
    content_type: "text",
    status: "delivered",
    ...overrides,
  };
}

describe("computeSessionInfo", () => {
  it("returns expired=false with remaining time when customer messaged <24h ago", () => {
    const createdAt = new Date("2025-06-15T10:00:00Z");
    const now = new Date("2025-06-15T12:00:00Z"); // 2h later

    const result = computeSessionInfo(
      [makeMsg({ created_at: createdAt.toISOString() })],
      now,
    );

    expect(result.expired).toBe(false);
    expect(result.remaining).toBe("22h remaining");
  });

  it("returns expired=true when clock advances beyond 24h without new messages", () => {
    const createdAt = new Date("2025-06-15T10:00:00Z");
    const now = new Date("2025-06-16T11:00:00Z"); // 25h later

    const result = computeSessionInfo(
      [makeMsg({ created_at: createdAt.toISOString() })],
      now,
    );

    expect(result.expired).toBe(true);
    expect(result.remaining).toBe("Expired");
  });

  it("returns expired=false with empty remaining when there are no messages", () => {
    const result = computeSessionInfo([], new Date());

    expect(result.expired).toBe(false);
    expect(result.remaining).toBe("");
  });

  it("returns expired=true when there are messages but none from a customer", () => {
    const result = computeSessionInfo(
      [makeMsg({ sender_type: "agent", created_at: new Date().toISOString() })],
      new Date(),
    );

    expect(result.expired).toBe(true);
    expect(result.remaining).toBe("No customer messages");
  });

  it("shows hours remaining when less than 1 full hour truncated", () => {
    // differenceInHours truncates toward zero: 23h 30m → 23 hours.
    // hoursLeft = 24 - 23 = 1, which is >= 1, so the output is "1h remaining".
    // (The minutes branch is unreachable with integer-truncated hours, but
    // the code is kept byte-identical to the original inline useMemo.)
    const createdAt = new Date("2025-06-15T10:00:00Z");
    const now = new Date("2025-06-16T09:30:00Z"); // 23h 30m later

    const result = computeSessionInfo(
      [makeMsg({ created_at: createdAt.toISOString() })],
      now,
    );

    expect(result.expired).toBe(false);
    expect(result.remaining).toBe("1h remaining");
  });

  it("returns expired=true at exactly 24h (>= boundary)", () => {
    const createdAt = new Date("2025-06-15T10:00:00Z");
    const now = new Date("2025-06-16T10:00:00Z"); // exactly 24h

    const result = computeSessionInfo(
      [makeMsg({ created_at: createdAt.toISOString() })],
      now,
    );

    expect(result.expired).toBe(true);
    expect(result.remaining).toBe("Expired");
  });

  it("uses the LAST customer message, not the first", () => {
    const oldMsg = makeMsg({
      id: "msg-old",
      sender_type: "customer",
      created_at: new Date("2025-06-14T10:00:00Z").toISOString(),
    });
    const recentMsg = makeMsg({
      id: "msg-recent",
      sender_type: "customer",
      created_at: new Date("2025-06-15T20:00:00Z").toISOString(),
    });
    const now = new Date("2025-06-15T22:00:00Z"); // 2h after recent

    const result = computeSessionInfo([oldMsg, recentMsg], now);

    expect(result.expired).toBe(false);
    expect(result.remaining).toBe("22h remaining");
  });
});
