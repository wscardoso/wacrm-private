import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadTenantMetrics, summarizeTenantMetrics, TenantMetricsError } from "./tenant-metrics";

// Fake Supabase client: loadTenantMetrics makes exactly two RPC calls
// (list_platform_tenant_metrics, list_platform_tenant_whatsapp_status) and
// no table reads. The SQL side is covered end-to-end against the real
// migration in src/test/platform-tenant-metrics.pglite.test.ts.

interface MetricsRow {
  account_id: string;
  contacts_count: number | string | null;
  unread_count: number | string | null;
  last_message_at: string | null;
  messages_today: number | string | null;
}
interface WaRow {
  account_id: string;
  status: string;
  provider: string;
}
type RpcResult = { data: unknown; error: { message: string } | null };

function fakeClient(opts: { metrics?: MetricsRow[] | RpcResult; wa?: WaRow[] | RpcResult }) {
  const asResult = (v: unknown): RpcResult =>
    Array.isArray(v) || v === undefined ? { data: v ?? [], error: null } : (v as RpcResult);
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "list_platform_tenant_metrics") return asResult(opts.metrics);
    if (fn === "list_platform_tenant_whatsapp_status") return asResult(opts.wa);
    throw new Error(`unexpected rpc ${fn}`);
  });
  const from = vi.fn();
  return { rpc, from, client: { rpc, from } as unknown as SupabaseClient };
}

describe("loadTenantMetrics", () => {
  it("returns an empty Map without querying anything when given no account ids", async () => {
    const { client, rpc, from } = fakeClient({});

    const result = await loadTenantMetrics(client, []);

    expect(result.size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("seeds every requested account id with zeroed/unconfigured defaults, even with no data anywhere", async () => {
    const { client } = fakeClient({});

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

  it("reads only the two aggregate RPCs (no table reads) and sends the UTC day start", async () => {
    const { client, rpc, from } = fakeClient({});

    await loadTenantMetrics(client, ["acc-1"], new Date("2026-03-04T15:30:00-03:00"));

    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("list_platform_tenant_metrics", { p_messages_since: "2026-03-04T00:00:00.000Z" });
    expect(rpc).toHaveBeenCalledWith("list_platform_tenant_whatsapp_status");
  });

  it("maps each aggregate row onto its account and ignores accounts that were not requested", async () => {
    const { client } = fakeClient({
      metrics: [
        { account_id: "acc-1", contacts_count: 1500, unread_count: 7, last_message_at: "2026-01-05T00:00:00Z", messages_today: 2 },
        { account_id: "acc-2", contacts_count: 0, unread_count: 0, last_message_at: null, messages_today: 0 },
        { account_id: "stranger", contacts_count: 99, unread_count: 99, last_message_at: null, messages_today: 99 },
      ],
    });

    const result = await loadTenantMetrics(client, ["acc-1", "acc-2"]);

    expect(result.get("acc-1")).toMatchObject({
      contactsCount: 1500,
      unreadCount: 7,
      messagesToday: 2,
      lastMessageAt: "2026-01-05T00:00:00Z",
    });
    expect(result.get("acc-2")?.lastMessageAt).toBeNull();
    expect(result.has("stranger")).toBe(false);
  });

  it("accepts bigint counts serialised as strings", async () => {
    const { client } = fakeClient({
      metrics: [{ account_id: "acc-1", contacts_count: "2500", unread_count: "3", last_message_at: null, messages_today: "1200" }],
    });

    const result = await loadTenantMetrics(client, ["acc-1"]);

    expect(result.get("acc-1")).toMatchObject({ contactsCount: 2500, unreadCount: 3, messagesToday: 1200 });
  });

  it("maps whatsapp status: connected row -> connected, disconnected row -> pending, no row -> unconfigured", async () => {
    const { client } = fakeClient({
      wa: [
        { account_id: "acc-1", status: "connected", provider: "meta" },
        { account_id: "acc-2", status: "disconnected", provider: "zapi" },
        // acc-3 has no row at all.
      ],
    });

    const result = await loadTenantMetrics(client, ["acc-1", "acc-2", "acc-3"]);

    expect(result.get("acc-1")).toMatchObject({ whatsappStatus: "connected", whatsappProvider: "meta" });
    expect(result.get("acc-2")).toMatchObject({ whatsappStatus: "pending", whatsappProvider: "zapi" });
    expect(result.get("acc-3")).toMatchObject({ whatsappStatus: "unconfigured", whatsappProvider: null });
  });

  it("never includes a whatsapp_config column beyond account_id/status/provider in its output shape", async () => {
    const { client } = fakeClient({ wa: [{ account_id: "acc-1", status: "connected", provider: "meta" }] });

    const result = await loadTenantMetrics(client, ["acc-1"]);

    const metric = result.get("acc-1")!;
    expect(Object.keys(metric).sort()).toEqual(
      ["contactsCount", "lastMessageAt", "messagesToday", "unreadCount", "whatsappProvider", "whatsappStatus"].sort(),
    );
  });

  it("throws a metrics-sourced TenantMetricsError when the aggregate RPC fails — never zeros", async () => {
    const { client } = fakeClient({ metrics: { data: null, error: { message: "boom" } } });

    const err = await loadTenantMetrics(client, ["acc-1"]).catch((e) => e);

    expect(err).toBeInstanceOf(TenantMetricsError);
    expect(err).toMatchObject({ source: "metrics", message: "boom" });
  });

  it("throws a whatsapp_status-sourced TenantMetricsError when the status RPC fails", async () => {
    const { client } = fakeClient({ wa: { data: null, error: { message: "denied" } } });

    const err = await loadTenantMetrics(client, ["acc-1"]).catch((e) => e);

    expect(err).toBeInstanceOf(TenantMetricsError);
    expect(err).toMatchObject({ source: "whatsapp_status", message: "denied" });
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
