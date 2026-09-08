import { describe, it, expect, vi, beforeEach } from "vitest";

// S2 (plans/001-private-media-buckets-s2.md) — engine.ts resolves a
// signed URL before forwarding a send_media node's media_url to Meta
// as `link`. Mocked here so the "advanceFromNodeKey — send_media"
// suite below can assert that resolution happens without a real
// Supabase/Storage round trip. Other tests in this file (pure helper
// functions) never touch these modules, so mocking them is inert
// for the rest of the suite.
const mockEngineSendMedia = vi.fn();
vi.mock("./meta-send", () => ({
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
  engineSendMedia: (...args: unknown[]) => mockEngineSendMedia(...args),
  engineSendText: vi.fn(),
}));

const mockResolveSignedMediaUrl = vi.fn(async (_db: unknown, url: string) => url);
vi.mock("@/lib/storage/resolve-media-url", () => ({
  resolveSignedMediaUrl: (...args: Parameters<typeof mockResolveSignedMediaUrl>) => mockResolveSignedMediaUrl(...args),
  MEDIA_SIGNED_URL_TTL_SECONDS: 86400,
}));

import {
  matchReplyId,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
  advanceFromNodeKey,
} from "./engine";
import type { FlowNodeRow, FlowRunRow } from "./types";

describe("matchReplyId", () => {
  it("returns null for nodes without options", () => {
    expect(
      matchReplyId({ node_type: "start", config: { next_node_key: "x" } }, "y"),
    ).toBeNull();
    expect(
      matchReplyId({ node_type: "send_message", config: {} }, "y"),
    ).toBeNull();
    expect(matchReplyId({ node_type: "end", config: {} }, "y")).toBeNull();
  });

  it("matches the buttons array on a send_buttons node", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick one",
        buttons: [
          { reply_id: "yes", title: "Yes", next_node_key: "confirmed" },
          { reply_id: "no", title: "No", next_node_key: "declined" },
        ],
      },
    };
    expect(matchReplyId(node, "yes")).toBe("confirmed");
    expect(matchReplyId(node, "no")).toBe("declined");
  });

  it("returns null when no button reply_id matches", () => {
    const node = {
      node_type: "send_buttons",
      config: {
        text: "Pick",
        buttons: [
          { reply_id: "a", title: "A", next_node_key: "to_a" },
          { reply_id: "b", title: "B", next_node_key: "to_b" },
        ],
      },
    };
    expect(matchReplyId(node, "c")).toBeNull();
    expect(matchReplyId(node, "")).toBeNull();
  });

  it("searches across all sections in a send_list node", () => {
    const node = {
      node_type: "send_list",
      config: {
        text: "Pick an order",
        button_label: "View",
        sections: [
          {
            title: "Recent",
            rows: [
              { reply_id: "o1", title: "Order 1", next_node_key: "ord_1" },
            ],
          },
          {
            title: "Older",
            rows: [
              { reply_id: "o2", title: "Order 2", next_node_key: "ord_2" },
              { reply_id: "o3", title: "Order 3", next_node_key: "ord_3" },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, "o1")).toBe("ord_1");
    expect(matchReplyId(node, "o2")).toBe("ord_2");
    expect(matchReplyId(node, "o3")).toBe("ord_3");
    expect(matchReplyId(node, "o99")).toBeNull();
  });

  it("returns null when send_list has no sections / empty sections", () => {
    expect(
      matchReplyId(
        { node_type: "send_list", config: { text: "x", sections: [] } },
        "x",
      ),
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: "send_list",
          config: { text: "x", sections: [{ rows: [] }] },
        },
        "x",
      ),
    ).toBeNull();
  });
});

describe("matchesKeywordTrigger", () => {
  it("returns false for empty text", () => {
    expect(matchesKeywordTrigger("", { keywords: ["hi"] })).toBe(false);
  });

  it("returns false when keywords array is empty", () => {
    expect(matchesKeywordTrigger("anything", { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ["support"] };
    expect(matchesKeywordTrigger("I need SUPPORT please", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Support is great", cfg)).toBe(true);
    expect(matchesKeywordTrigger("Help me", cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ["help"], match_type: "exact" as const };
    expect(matchesKeywordTrigger("help", cfg)).toBe(true);
    expect(matchesKeywordTrigger("HELP", cfg)).toBe(true);
    expect(matchesKeywordTrigger("help me", cfg)).toBe(false);
  });

  it("case_sensitive=true preserves case", () => {
    const cfg = {
      keywords: ["Support"],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger("I need Support", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need support", cfg)).toBe(false);
  });

  it("matches any one of multiple keywords", () => {
    const cfg = { keywords: ["help", "support", "issue"] };
    expect(matchesKeywordTrigger("I have an issue", cfg)).toBe(true);
    expect(matchesKeywordTrigger("I need Help!", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nothing to see here", cfg)).toBe(false);
  });

  it("skips empty strings in the keywords array", () => {
    const cfg = { keywords: ["", "support", ""] };
    expect(matchesKeywordTrigger("support center", cfg)).toBe(true);
    expect(matchesKeywordTrigger("nope", cfg)).toBe(false);
  });
});

describe("node classification helpers", () => {
  it("isAutoAdvancing covers start + send_message + send_media + condition + set_tag", () => {
    expect(isAutoAdvancing("start")).toBe(true);
    expect(isAutoAdvancing("send_message")).toBe(true);
    expect(isAutoAdvancing("send_media")).toBe(true);
    expect(isAutoAdvancing("condition")).toBe(true);
    expect(isAutoAdvancing("set_tag")).toBe(true);
    expect(isAutoAdvancing("send_buttons")).toBe(false);
    expect(isAutoAdvancing("send_list")).toBe(false);
    expect(isAutoAdvancing("collect_input")).toBe(false);
    expect(isAutoAdvancing("handoff")).toBe(false);
    expect(isAutoAdvancing("end")).toBe(false);
  });

  it("isSuspending covers the input-requiring nodes", () => {
    expect(isSuspending("send_buttons")).toBe(true);
    expect(isSuspending("send_list")).toBe(true);
    expect(isSuspending("collect_input")).toBe(true);
    expect(isSuspending("start")).toBe(false);
    expect(isSuspending("send_message")).toBe(false);
    expect(isSuspending("condition")).toBe(false);
    expect(isSuspending("set_tag")).toBe(false);
    expect(isSuspending("handoff")).toBe(false);
    expect(isSuspending("end")).toBe(false);
  });

  it("isTerminal covers handoff + end", () => {
    expect(isTerminal("handoff")).toBe(true);
    expect(isTerminal("end")).toBe(true);
    expect(isTerminal("start")).toBe(false);
    expect(isTerminal("send_buttons")).toBe(false);
    expect(isTerminal("condition")).toBe(false);
  });

  it("the three classifications are mutually exclusive for known node types", () => {
    const types = [
      "start",
      "send_message",
      "send_buttons",
      "send_list",
      "send_media",
      "collect_input",
      "condition",
      "set_tag",
      "handoff",
      "end",
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe("evaluateConditionPredicate", () => {
  it("present: true when subject has a value", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "alice@example.com",
        configValue: undefined,
      }),
    ).toBe(true);
  });

  it("present: false when subject is undefined or empty", () => {
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: "present",
        subjectValue: "",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("absent: inverse of present", () => {
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: undefined,
        configValue: undefined,
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "absent",
        subjectValue: "x",
        configValue: undefined,
      }),
    ).toBe(false);
  });

  it("equals: exact string comparison; case-sensitive", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "VIP",
        configValue: "VIP",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: "vip",
        configValue: "VIP",
      }),
    ).toBe(false);
  });

  it("equals: undefined subject never matches (even against empty)", () => {
    expect(
      evaluateConditionPredicate({
        operator: "equals",
        subjectValue: undefined,
        configValue: "",
      }),
    ).toBe(false);
  });

  it("contains: substring match", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@example.com",
        configValue: "@example.com",
      }),
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: "support@other.com",
        configValue: "@example.com",
      }),
    ).toBe(false);
  });

  it("contains: undefined subject never matches", () => {
    expect(
      evaluateConditionPredicate({
        operator: "contains",
        subjectValue: undefined,
        configValue: "anything",
      }),
    ).toBe(false);
  });
});

// ─── S2 (plans/001-private-media-buckets-s2.md) — signed URL at dispatch ──

describe("advanceFromNodeKey — send_media resolves a signed URL before dispatch", () => {
  function makeMockDb() {
    const chain = {
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn(function (this: unknown) { return chain; }),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    return { from: vi.fn(() => chain) } as unknown as Parameters<typeof advanceFromNodeKey>[0];
  }

  const run: FlowRunRow = {
    id: "run-1",
    flow_id: "flow-1",
    account_id: "account-1",
    user_id: "user-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    status: "active",
    current_node_key: "media1",
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    started_at: new Date().toISOString(),
    last_advanced_at: new Date().toISOString(),
    ended_at: null,
    end_reason: null,
  };

  function mediaNode(mediaUrl: string): Map<string, FlowNodeRow> {
    const node: FlowNodeRow = {
      id: "node-1",
      flow_id: "flow-1",
      node_key: "media1",
      node_type: "send_media",
      config: {
        media_type: "image",
        media_url: mediaUrl,
        next_node_key: "",
      },
      position_x: 0,
      position_y: 0,
      created_at: new Date().toISOString(),
    };
    return new Map([["media1", node]]);
  }

  beforeEach(() => {
    mockEngineSendMedia.mockReset();
    mockEngineSendMedia.mockResolvedValue({ whatsapp_message_id: "wamid.1" });
    mockResolveSignedMediaUrl.mockReset();
    mockResolveSignedMediaUrl.mockImplementation(async (_db: unknown, url: string) => url);
  });

  it("resolves a signed URL and forwards it (not the raw media_url) as `link`", async () => {
    const rawUrl = "https://proj.supabase.co/storage/v1/object/public/flow-media/account-1/node.png";
    const signedUrl = "https://proj.supabase.co/storage/v1/object/sign/flow-media/account-1/node.png?token=abc";
    mockResolveSignedMediaUrl.mockResolvedValueOnce(signedUrl);

    const db = makeMockDb();
    await advanceFromNodeKey(db, run, "media1", mediaNode(rawUrl));

    expect(mockResolveSignedMediaUrl).toHaveBeenCalledWith(db, rawUrl, 86400);
    expect(mockEngineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ link: signedUrl }),
    );
  });

  it("forwards a non-bucket media_url unchanged (resolver pass-through)", async () => {
    const inboundUrl = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=xyz";
    const db = makeMockDb();
    await advanceFromNodeKey(db, run, "media1", mediaNode(inboundUrl));

    expect(mockEngineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ link: inboundUrl }),
    );
  });
});
