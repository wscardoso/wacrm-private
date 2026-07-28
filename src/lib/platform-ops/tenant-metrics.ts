// ============================================================
// E9 / Fase 1 — batch metrics for the platform operator "control
// tower" grid (/act, Tenants tab).
//
// Every query here is batched across ALL of the caller's supervised
// tenants at once (account_id = ANY(...) / .in('account_id', ids)),
// never one query per tenant in a loop. RLS (migration 038) already
// scopes contacts/conversations/messages reads to
// is_account_member() OR can_access_account(), so an authenticated
// operator's client can read these tables directly for every tenant
// they supervise — no new RPC needed for those three.
//
// whatsapp_config is the one exception: it was deliberately excluded
// from the 038 operator read grant (it holds credentials), so its
// status is fetched via the narrow list_platform_tenant_whatsapp_status()
// RPC (migration 059), which returns ONLY account_id/status/provider.
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

function startOfTodayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Load per-tenant metrics for the given (already-authorized) list of
 * account ids, in a fixed small number of batched queries — never one
 * query per tenant. Returns a Map keyed by account_id; a tenant with
 * no data anywhere still gets an entry with zeroed/unconfigured
 * defaults, so callers never need a fallback branch per tenant.
 */
export async function loadTenantMetrics(
  db: SupabaseClient,
  accountIds: string[],
): Promise<Map<string, TenantMetrics>> {
  const metrics = new Map<string, TenantMetrics>();
  for (const id of accountIds) metrics.set(id, emptyMetrics());
  if (accountIds.length === 0) return metrics;

  const todayStart = startOfTodayUtc();

  const [contactsRes, conversationsRes, messagesRes, waStatusRes] = await Promise.all([
    db.from("contacts").select("account_id").in("account_id", accountIds),
    db
      .from("conversations")
      .select("account_id, unread_count, last_message_at")
      .in("account_id", accountIds),
    db
      .from("messages")
      .select("id, conversations!inner(account_id)")
      .gte("created_at", todayStart)
      .in("conversations.account_id", accountIds),
    db.rpc("list_platform_tenant_whatsapp_status"),
  ]);

  for (const row of (contactsRes.data ?? []) as { account_id: string }[]) {
    const m = metrics.get(row.account_id);
    if (m) m.contactsCount += 1;
  }

  for (const row of (conversationsRes.data ?? []) as {
    account_id: string;
    unread_count: number | null;
    last_message_at: string | null;
  }[]) {
    const m = metrics.get(row.account_id);
    if (!m) continue;
    m.unreadCount += row.unread_count ?? 0;
    if (row.last_message_at && (!m.lastMessageAt || row.last_message_at > m.lastMessageAt)) {
      m.lastMessageAt = row.last_message_at;
    }
  }

  for (const row of (messagesRes.data ?? []) as {
    conversations: { account_id: string } | { account_id: string }[] | null;
  }[]) {
    // Embedded FK resources come back as an object for a to-one join in
    // most supabase-js versions, but defensively handle the array shape
    // some client/type combinations produce for `!inner` embeds.
    const embedded = row.conversations;
    const accountId = Array.isArray(embedded) ? embedded[0]?.account_id : embedded?.account_id;
    if (!accountId) continue;
    const m = metrics.get(accountId);
    if (m) m.messagesToday += 1;
  }

  for (const row of (waStatusRes.data ?? []) as {
    account_id: string;
    status: string;
    provider: string;
  }[]) {
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
