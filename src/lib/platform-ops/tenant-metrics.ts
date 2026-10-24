// ============================================================
// E9 / Fase 1 — metrics for the platform operator "control tower"
// grid (/act, Tenants tab).
//
// The numbers come from two RPCs, both scoped inside the database by
// auth.uid() to the operator's active assignments:
//
//   * list_platform_tenant_metrics()          (096) — contacts, unread,
//     last message and today's message count, AGGREGATED in SQL: one row
//     per supervised tenant. The previous implementation selected every
//     contact/conversation/message row and counted on the client, which
//     PostgREST silently truncates at its max-rows cap (finding E-1).
//   * list_platform_tenant_whatsapp_status()  (059) — whatsapp_config is
//     deliberately excluded from the 038 operator read grant (it holds
//     credentials), so only account_id/status/provider are exposed.
//
// A failed call is NEVER rendered as zero: loadTenantMetrics throws a
// TenantMetricsError and the caller shows an error state.
//
// "Mensagens hoje" uses a UTC day boundary, not the viewer's local
// day — a deliberate, documented simplification. An operator in a
// different timezone than a tenant's agents may see "today" roll over
// a few hours off from that tenant's own dashboard, which uses the
// visitor's local day (src/lib/dashboard/date-utils.ts). Acceptable
// for a cross-tenant summary view; revisit if this becomes confusing
// in practice.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type WhatsappTenantStatus = "connected" | "pending" | "unconfigured";

export interface TenantMetrics {
  contactsCount: number;
  messagesToday: number;
  unreadCount: number;
  /** ISO timestamp of the most recent message across the tenant's
   *  conversations, or null if the tenant has no conversations yet. */
  lastMessageAt: string | null;
  whatsappStatus: WhatsappTenantStatus;
  whatsappProvider: string | null;
}

export interface TenantMetricsSummary {
  tenantsSupervised: number;
  whatsappConnected: number;
  totalUnread: number;
  totalMessagesToday: number;
}

function emptyMetrics(): TenantMetrics {
  return {
    contactsCount: 0,
    messagesToday: 0,
    unreadCount: 0,
    lastMessageAt: null,
    whatsappStatus: "unconfigured",
    whatsappProvider: null,
  };
}

function startOfTodayUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export type TenantMetricsErrorSource = "metrics" | "whatsapp_status";

export class TenantMetricsError extends Error {
  constructor(
    readonly source: TenantMetricsErrorSource,
    message: string,
  ) {
    super(message);
    this.name = "TenantMetricsError";
  }
}

interface MetricsRow {
  account_id: string;
  contacts_count: number | string | null;
  unread_count: number | string | null;
  last_message_at: string | null;
  messages_today: number | string | null;
}

interface WhatsappStatusRow {
  account_id: string;
  status: string;
  provider: string;
}

/**
 * Load per-tenant metrics for the given (already-authorized) list of
 * account ids with two RPC calls, independent of how many rows the
 * tenants hold. Returns a Map keyed by account_id; a tenant the RPCs
 * return nothing for still gets an entry with zeroed/unconfigured
 * defaults, so callers never need a fallback branch per tenant.
 *
 * Throws TenantMetricsError when either RPC fails — a failure is never
 * reported as zero.
 */
export async function loadTenantMetrics(
  db: SupabaseClient,
  accountIds: string[],
  now: Date = new Date(),
): Promise<Map<string, TenantMetrics>> {
  const metrics = new Map<string, TenantMetrics>();
  for (const id of accountIds) metrics.set(id, emptyMetrics());
  if (accountIds.length === 0) return metrics;

  const [metricsRes, waStatusRes] = await Promise.all([
    db.rpc("list_platform_tenant_metrics", { p_messages_since: startOfTodayUtc(now) }),
    db.rpc("list_platform_tenant_whatsapp_status"),
  ]);

  if (metricsRes.error) {
    throw new TenantMetricsError("metrics", metricsRes.error.message || "list_platform_tenant_metrics failed");
  }
  if (waStatusRes.error) {
    throw new TenantMetricsError(
      "whatsapp_status",
      waStatusRes.error.message || "list_platform_tenant_whatsapp_status failed",
    );
  }

  for (const row of (metricsRes.data ?? []) as MetricsRow[]) {
    const m = metrics.get(row.account_id);
    if (!m) continue;
    m.contactsCount = Number(row.contacts_count ?? 0);
    m.unreadCount = Number(row.unread_count ?? 0);
    m.messagesToday = Number(row.messages_today ?? 0);
    m.lastMessageAt = row.last_message_at;
  }

  for (const row of (waStatusRes.data ?? []) as WhatsappStatusRow[]) {
    const m = metrics.get(row.account_id);
    if (!m) continue;
    // No row at all -> "unconfigured" (the map's default). A row exists
    // but never finished connecting -> "pending". status === 'connected'
    // is the only literal DB value beyond 'disconnected' (see 059's doc
    // comment — there is no third status value in the CHECK constraint).
    m.whatsappStatus = row.status === "connected" ? "connected" : "pending";
    m.whatsappProvider = row.provider;
  }

  return metrics;
}

export function summarizeTenantMetrics(metrics: Map<string, TenantMetrics>): TenantMetricsSummary {
  let whatsappConnected = 0;
  let totalUnread = 0;
  let totalMessagesToday = 0;
  for (const m of metrics.values()) {
    if (m.whatsappStatus === "connected") whatsappConnected += 1;
    totalUnread += m.unreadCount;
    totalMessagesToday += m.messagesToday;
  }
  return {
    tenantsSupervised: metrics.size,
    whatsappConnected,
    totalUnread,
    totalMessagesToday,
  };
}
