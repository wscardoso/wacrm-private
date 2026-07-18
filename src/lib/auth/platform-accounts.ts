// ============================================================
// Server-side platform account discovery (P1c / Lot 2).
//
// Thin wrapper around the list_platform_operator_accounts() RPC
// (migration 039). The RPC is SECURITY DEFINER and filters
// exclusively by auth.uid() — this helper just invokes it on the
// caller's own session and returns the rows. It does NOT accept an
// account_id or user_id from the caller, does NOT use the
// service-role client, and does NOT invent any new authorization
// mechanism: it relies entirely on the RPC's own auth.uid() filter.
//
// This module is server-only (imports next/headers via createClient).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

export interface PlatformOperatorAccount {
  account_id: string;
  name: string;
  access_role: string;
  created_at: string;
}

/**
 * Fetch the tenants this authenticated operator is authorized to
 * supervise. Returns an empty array when the caller is not an active
 * platform operator (the RPC itself yields no rows in that case).
 * Errors from the RPC are propagated — no special-casing, no silent
 * fallback that would mask a real failure.
 */
export async function listPlatformOperatorAccounts(
  callerSupabase?: SupabaseClient,
): Promise<PlatformOperatorAccount[]> {
  const supabase = callerSupabase ?? (await createClient());

  const { data, error } = await supabase.rpc("list_platform_operator_accounts");
  if (error) {
    // Propagate as-is; the caller (the /act discovery page) decides how
    // to surface it. We never fabricate an empty/authorized result.
    throw error;
  }
  return (data ?? []) as PlatformOperatorAccount[];
}
