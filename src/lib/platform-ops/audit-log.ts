// ============================================================
// Reader for the platform audit trail of one supervised tenant
// (/act/[accountId]/audit). Thin wrapper over list_platform_audit_log()
// (migration 097): authorization (active operator authorized for the
// tenant), tenant scoping and e-mail visibility are enforced inside the
// database; this module only pages through the result and shapes it.
//
// Keyset pagination: the cursor is the id of the last entry already
// shown. The page asks the RPC for pageSize + 1 rows — the extra row only
// tells us whether another page exists and is not returned.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export const AUDIT_PAGE_SIZE = 50;

export interface AuditLogEntry {
  /** bigint primary key, kept as a string so it never loses precision. */
  id: string;
  createdAt: string;
  action: string;
  actorUserId: string;
  /** Only populated when the actor is a platform operator. */
  actorEmail: string | null;
  actorIsOperator: boolean;
  targetUserId: string | null;
  targetUserEmail: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditLogPage {
  entries: AuditLogEntry[];
  /** Pass as `before` to fetch the next (older) page; null when exhausted. */
  nextCursor: string | null;
}

export type AuditLogErrorCode = "unauthorized" | "unexpected";

export class AuditLogError extends Error {
  constructor(
    readonly code: AuditLogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuditLogError";
  }
}

interface AuditRow {
  id: number | string;
  created_at: string;
  action: string;
  actor_user_id: string;
  actor_email: string | null;
  actor_is_operator: boolean;
  target_user_id: string | null;
  target_user_email: string | null;
  metadata: Record<string, unknown> | null;
}

export async function fetchAuditPage(
  db: SupabaseClient,
  accountId: string,
  before: string | null = null,
  pageSize: number = AUDIT_PAGE_SIZE,
): Promise<AuditLogPage> {
  const { data, error } = await db.rpc("list_platform_audit_log", {
    p_account_id: accountId,
    p_limit: pageSize + 1,
    p_before_id: before,
  });

  if (error) {
    // 42501: not an operator for this tenant (or not signed in).
    if (error.code === "42501") {
      throw new AuditLogError("unauthorized", error.message || "Not authorized for this account");
    }
    throw new AuditLogError("unexpected", error.message || "list_platform_audit_log failed");
  }

  const rows = (data ?? []) as AuditRow[];
  const hasMore = rows.length > pageSize;
  const shown = hasMore ? rows.slice(0, pageSize) : rows;

  const entries: AuditLogEntry[] = shown.map((r) => ({
    id: String(r.id),
    createdAt: r.created_at,
    action: r.action,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    actorIsOperator: r.actor_is_operator,
    targetUserId: r.target_user_id,
    targetUserEmail: r.target_user_email,
    metadata: r.metadata,
  }));

  return {
    entries,
    nextCursor: hasMore && entries.length > 0 ? entries[entries.length - 1].id : null,
  };
}
