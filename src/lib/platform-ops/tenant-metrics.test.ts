import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadTenantMetrics, summarizeTenantMetrics } from "./tenant-metrics";

// Fake Supabase client covering the 4 batched calls loadTenantMetrics
// makes: contacts, conversations, messages (embedded conversations
// filter), and the list_platform_tenant_whatsapp_status RPC.

interface TableResponses {
  contacts?: { account_id: string }[];
  conversations?: { account_id: string; unread_count: number | null; last_message_at: string | null }[];
  messages?: { id: string; conversations: { account_id: string } | null }[];
}

function fakeClient(tables: TableResponses, waStatus: { account_id: string; status: string; provider: string }[]) {
  const from = vi.fn((table: string) => {
    const chain = {
      select: () => chain,
      in: () => chain,
      gte: () => chain,
      then: (resolve: (v: { data: unknown; error: null }) => void) => {
        const data =
          table === "contacts" ? (tables.contacts ?? []) : table === "conversations" ? (tables.conversations ?? []) : (tables.messages ?? []);
        return resolve({ data, error: null });
      },
    };
    return chain;
  });

  const rpc = vi.fn(async () => ({ data: waStatus, error: null }));

  return { from, rpc } as unknown as SupabaseClient;
}

describe("loadTenantMetrics", () => {
  it("returns an empty Map without querying anything when given no account ids", async () => {
    const client = fakeClient({}, []);

    const result = await loadTenantMetrics(client, []);

    expect(result.size).toBe(0);
    expect((client.from as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect((client.rpc as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("seeds every requested account id with zeroed/unconfigured defaults, even with no data anywhere", async () => {
    const client = fakeClient({}, []);

    const result = await loadTenantMetrics(client, ["acc-1", "acc-2"]);

    expect(result.size).toBe(2);
    expect(result.get("acc-1")).toEqual({
      contactsCount: 0,
      messagesToday: 0,
      unreadCount: 0,
      lastMessageAt: null,
      whatsappStatus: "unconfigured",
      whatsappProvider: null,
    });
  });

  it("counts contacts per account_id from a single batched query", async () => {
    const client = fakeClient(
      { contacts: [{ account_id: "acc-1" }, { account_id: "acc-1" }, { account_id: "acc-2" }] },
      [],
    );

    const result = await loadTenantMetrics(client, ["acc-1", "acc-2"]);

    expect(result.get("acc-1")?.contactsCount).toBe(2);
    expect(result.get("acc-2")?.contactsCount).toBe(1);
  });

  it("sums unread_count and tracks the most recent last_message_at per account", async () => {
    const client = fakeClient(
      {
        conversations: [
          { account_id: "acc-1", unread_count: 3, last_message_at: "2026-01-01T00:00:00Z" },
          { account_id: "acc-1", unread_count: 2, last_message_at: "2026-01-05T00:00:00Z" },
          { account_id: "acc-2", unread_count: null, last_message_at: null },
        ],
      },
      [],
    );

    const result = await loadTenantMetrics(client, ["acc-1", "acc-2"]);

    expect(result.get("acc-1")?.unreadCount).toBe(5);
    expect(result.get("acc-1")?.lastMessageAt).toBe("2026-01-05T00:00:00Z");
    expect(result.get("acc-2")?.unreadCount).toBe(0);
    expect(result.get("acc-2")?.lastMessageAt).toBeNull();
  });

  it("counts today's messages per account via the embedded conversations.account_id", async () => {
    const client = fakeClient(
      {
        messages: [
          { id: "m1", conversations: { account_id: "acc-1" } },
          { id: "m2", conversations: { account_id: "acc-1" } },
          { id: "m3", conversations: { account_id: "acc-2" } },
        ],
      },
      [],
    );

    const result = await loadTenantMetrics(client, ["acc-1", "acc-2"]);

    expect(result.get("acc-1")?.messagesToday).toBe(2);
    expect(result.get("acc-2")?.messagesToday).toBe(1);
  });

  it("maps whatsapp status: connected row -> connected, disconnected row -> pending, no row -> unconfigured", async () => {
    const client = fakeClient({}, [
      { account_id: "acc-1", status: "connected", provider: "meta" },
      { account_id: "acc-2", status: "disconnected", provider: "zapi" },
      // acc-3 has no row at all.
    ]);

    const result = await loadTenantMetrics(client, ["acc-1", "acc-2", "acc-3"]);

    expect(result.get("acc-1")).toMatchObject({ whatsappStatus: "connected", whatsappProvider: "meta" });
    expect(result.get("acc-2")).toMatchObject({ whatsappStatus: "pending", whatsappProvider: "zapi" });
    expect(result.get("acc-3")).toMatchObject({ whatsappStatus: "unconfigured", whatsappProvider: null });
  });

  it("never includes a whatsapp_config column beyond account_id/status/provider in its output shape", async () => {
    const client = fakeClient({}, [{ account_id: "acc-1", status: "connected", provider: "meta" }]);

    const result = await loadTenantMetrics(client, ["acc-1"]);

    const metric = result.get("acc-1")!;
    expect(Object.keys(metric).sort()).toEqual(
      ["contactsCount", "lastMessageAt", "messagesToday", "unreadCount", "whatsappProvider", "whatsappStatus"].sort(),
    );
  });
});

describe("summarizeTenantMetrics", () => {
  it("aggregates tenant count, connected count, total unread, and total messages today", () => {
    const metrics = new Map([
      [
        "acc-1",
        {
          contactsCount: 5,
          messagesToday: 3,
          unreadCount: 2,
          lastMessageAt: null,
          whatsappStatus: "connected" as const,
          whatsappProvider: "meta",
        },
      ],
      [
        "acc-2",
        {
          contactsCount: 1,
          messagesToday: 1,
          unreadCount: 0,
          lastMessageAt: null,
          whatsappStatus: "pending" as const,
          whatsappProvider: "zapi",
        },
      ],
      [
        "acc-3",
        {
          contactsCount: 0,
          messagesToday: 0,
          unreadCount: 0,
          lastMessageAt: null,
          whatsappStatus: "unconfigured" as const,
          whatsappProvider: null,
        },
      ],
    ]);

    expect(summarizeTenantMetrics(metrics)).toEqual({
      tenantsSupervised: 3,
      whatsappConnected: 1,
      totalUnread: 2,
      totalMessagesToday: 4,
    });
  });

  it("returns zeros for an empty map", () => {
    expect(summarizeTenantMetrics(new Map())).toEqual({
      tenantsSupervised: 0,
      whatsappConnected: 0,
      totalUnread: 0,
      totalMessagesToday: 0,
    });
  });
});
