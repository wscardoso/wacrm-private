// ============================================================
// E9 / Fase 2 — thin wrappers around the platform-operator RPCs
// (grant/revoke/assign/unassign — migration 037; list — 062; email
// lookup — 061).
//
// None of the four 037 write RPCs are modified here — this module
// calls them with their EXISTING signatures only. All authorization
// (active admin check, self-promotion/self-revocation rejection,
// hierarchy enforcement) lives inside those RPCs; this layer never
// re-implements it and never accepts an actor_user_id / timestamp from
// the caller — every mutation is stamped server-side from auth.uid().
//
// Mirrors the thin-wrapper convention of
// src/lib/crypto/keyLifecycle.ts and src/lib/workspaces/create-workspace.ts:
// server-only (createClient imports next/headers) but accepts an
// injected SupabaseClient so every function is unit-testable without a
// live session.
// ============================================================

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

export type PlatformOperatorRoleValue = "admin" | "operator";
export type PlatformAccessRoleValue = "viewer" | "agent" | "admin";

export interface PlatformOperatorAssignedAccount {
  account_id: string;
  name: string;
  access_role: PlatformAccessRoleValue;
}

export interface PlatformOperatorRow {
  user_id: string;
  email: string;
  role: PlatformOperatorRoleValue;
  is_active: boolean;
  created_at: string;
  assigned_accounts: PlatformOperatorAssignedAccount[];
}

export type OperatorErrorCode = "validation" | "unauthorized" | "unexpected";

export interface OperatorError {
  code: OperatorErrorCode;
  message: string;
}

export type OperatorActionResult = { success: true } | { success: false; error: OperatorError };
export type ListOperatorsResult =
  | { success: true; operators: PlatformOperatorRow[] }
  | { success: false; error: OperatorError };
export type LookupUserIdResult =
  | { success: true; userId: string }
  | { success: false; error: OperatorError };

// Unlike src/lib/crypto/keyLifecycle.ts's translateRpcError, this one
// forwards the RPC's own message on 42501/22023 rather than collapsing
// it to a generic string: 037's write RPCs deliberately raise distinct,
// human-readable messages per failure mode ("Unauthorized" vs "This
// action requires an active platform admin" vs "Cannot grant operator
// status to yourself"), and an admin managing operators needs to see
// which one actually happened.
function translateRpcError(error: PostgrestError): OperatorError {
  switch (error.code) {
    case "42501":
      return { code: "unauthorized", message: error.message || "You are not authorized to perform this action." };
    case "22023":
      return { code: "validation", message: error.message || "Invalid request." };
    default:
      console.error("[platform-ops/operators] unexpected RPC error:", error);
      return { code: "unexpected", message: "Something went wrong. Please try again." };
  }
}

async function requireSession(
  callerSupabase?: SupabaseClient,
): Promise<{ supabase: SupabaseClient; error: null } | { supabase: null; error: OperatorError }> {
  const supabase = callerSupabase ?? (await createClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      supabase: null,
      error: { code: "unauthorized", message: "You must be signed in to manage platform operators." },
    };
  }
  return { supabase, error: null };
}

/** Admin-only directory of every operator (active and revoked), with
 *  their assigned tenants. See migration 062 — the directory is not
 *  exposed via any table SELECT policy, only through this RPC. */
export async function listPlatformOperators(callerSupabase?: SupabaseClient): Promise<ListOperatorsResult> {
  const session = await requireSession(callerSupabase);
  if (session.error) return { success: false, error: session.error };

  const { data, error } = await session.supabase.rpc("list_platform_operators");
  if (error) return { success: false, error: translateRpcError(error) };
  return { success: true, operators: (data ?? []) as PlatformOperatorRow[] };
}

/** Resolves an e-mail to an existing user's UUID (migration 061). The
 *  target user must already have an account — this never creates one. */
export async function lookupOperatorUserIdByEmail(
  email: string,
  callerSupabase?: SupabaseClient,
): Promise<LookupUserIdResult> {
  const session = await requireSession(callerSupabase);
  if (session.error) return { success: false, error: session.error };

  const { data, error } = await session.supabase.rpc("platform_lookup_user_id_by_email", {
    p_email: email,
  });
  if (error) return { success: false, error: translateRpcError(error) };
  if (typeof data !== "string" || data === "") {
    console.error("[platform-ops/operators] platform_lookup_user_id_by_email returned no id:", data);
    return { success: false, error: { code: "unexpected", message: "Could not resolve that e-mail." } };
  }
  return { success: true, userId: data };
}

/** grant_platform_operator(p_user_id, p_role) — 037, UNCHANGED signature. */
export async function grantPlatformOperator(
  userId: string,
  role: PlatformOperatorRoleValue,
  callerSupabase?: SupabaseClient,
): Promise<OperatorActionResult> {
  const session = await requireSession(callerSupabase);
  if (session.error) return { success: false, error: session.error };

  const { error } = await session.supabase.rpc("grant_platform_operator", {
    p_user_id: userId,
    p_role: role,
  });
  if (error) return { success: false, error: translateRpcError(error) };
  return { success: true };
}

/** revoke_platform_operator(p_user_id) — 037, UNCHANGED signature. */
export async function revokePlatformOperator(
  userId: string,
  callerSupabase?: SupabaseClient,
): Promise<OperatorActionResult> {
  const session = await requireSession(callerSupabase);
  if (session.error) return { success: false, error: session.error };

  const { error } = await session.supabase.rpc("revoke_platform_operator", {
    p_user_id: userId,
  });
  if (error) return { success: false, error: translateRpcError(error) };
  return { success: true };
}

/** assign_platform_operator_account(p_operator_user_id, p_account_id, p_access_role) — 037, UNCHANGED signature. */
export async function assignPlatformOperatorAccount(
  operatorUserId: string,
  accountId: string,
  accessRole: PlatformAccessRoleValue,
  callerSupabase?: SupabaseClient,
): Promise<OperatorActionResult> {
  const session = await requireSession(callerSupabase);
  if (session.error) return { success: false, error: session.error };

  const { error } = await session.supabase.rpc("assign_platform_operator_account", {
    p_operator_user_id: operatorUserId,
    p_account_id: accountId,
    p_access_role: accessRole,
  });
  if (error) return { success: false, error: translateRpcError(error) };
  return { success: true };
}

/** unassign_platform_operator_account(p_operator_user_id, p_account_id) — 037, UNCHANGED signature. */
export async function unassignPlatformOperatorAccount(
  operatorUserId: string,
  accountId: string,
  callerSupabase?: SupabaseClient,
): Promise<OperatorActionResult> {
  const session = await requireSession(callerSupabase);
  if (session.error) return { success: false, error: session.error };

  const { error } = await session.supabase.rpc("unassign_platform_operator_account", {
    p_operator_user_id: operatorUserId,
    p_account_id: accountId,
  });
  if (error) return { success: false, error: translateRpcError(error) };
  return { success: true };
}
