// ============================================================
// Server-side platform context resolver (P1b).
//
// This module adds an EXPLICIT, separate context path for platform
// operators who open a tenant via a URL like /act/[accountId]/inbox.
// It is intentionally parallel to (never mixed into) getCurrentAccount():
//
//   * getCurrentAccount()        — unchanged; members only; reads the
//                                   caller's own profile.account_id.
//   * getCurrentAccountContext() — superset wrapper that ALSO exposes
//                                   accessMode / isPlatformContext for
//                                   code that wants to branch on either
//                                   path without caring which one it is.
//   * requirePlatformContext(a)  — the ONLY sanctioned way to resolve a
//                                   URL-supplied tenant for an operator.
//                                   Re-validates in the DB every call.
//
// SECURITY MODEL
// -------------
// The accountId from the URL is a SELECTOR, not authorization. We never
// trust it: requirePlatformContext() re-derives authorization from
// auth.uid() via is_platform_operator_for() + can_access_account(), and
// writes an audit row stamped with the REAL actor (auth.uid()). A URL
// pointing at an account the operator isn't assigned to yields 403 and
// an `context_access_denied` audit entry. The operator's auth.uid() is
// never changed; they never become a member/owner of the target.
//
// IMPORTANT: this module is server-only (imports next/headers via
// createClient). Do not import it from a client component.
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import {
  UnauthorizedError,
  ForbiddenError,
  toErrorResponse,
  getCurrentAccount,
  type AccountContext,
} from "./account";
import { hasMinRole, type AccountRole } from "./roles";

export type AccountAccessMode = "member" | "platform_operator";

export interface PlatformAccountContext extends AccountContext {
  /** The REAL authenticated user (auth.uid()). Never the target tenant's user. */
  actorUserId: string;
  /** True when this context was resolved through requirePlatformContext(). */
  isPlatformContext: boolean;
  /** How the account scope was reached. */
  accessMode: AccountAccessMode;
  /** Operator's per-tenant access role when in platform context, else undefined. */
  accessRole?: string;
}

/**
 * Resolve the caller's account context in a mode-agnostic way.
 *
 * For a normal member this is equivalent to getCurrentAccount() plus the
 * extra fields (accessMode: "member", isPlatformContext: false). It does
 * NOT take any URL parameter, so the member path is byte-for-byte the
 * same authorization as before. Use requirePlatformContext() for the
 * operator URL path.
 */
export async function getCurrentAccountContext(): Promise<PlatformAccountContext> {
  const ctx = await getCurrentAccount();
  return {
    ...ctx,
    actorUserId: ctx.userId,
    isPlatformContext: false,
    accessMode: "member",
  };
}

/**
 * Resolve a platform-operator context for a tenant named by the URL.
 *
 * Steps (all server-side, all re-validated):
 *   1. get auth.uid() from the real session;
 *   2. confirm the user is an active platform operator;
 *   3. confirm the operator is authorized for `targetAccountId`
 *      (is_platform_operator_for = can_access_account path);
 *   4. on success: log `context_entered` and return the validated context;
 *   5. on any failure: log `context_access_denied` and throw
 *      UnauthorizedError / ForbiddenError.
 *
 * The `targetAccountId` argument comes from the URL param of the route,
 * but authorization is NEVER derived from it — only from the database
 * given the real auth.uid(). A forged/guessed account id fails step 3.
 *
 * `callerSupabase` is optional; if provided (e.g. an already-opened
 * client from a route) it's reused so we don't open a second connection.
 */
export async function requirePlatformContext(
  targetAccountId: string,
  callerSupabase?: SupabaseClient,
): Promise<PlatformAccountContext> {
  const supabase = callerSupabase ?? (await createClient());

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    await logDenied(supabase, targetAccountId);
    throw new UnauthorizedError();
  }

  // Active platform operator?
  const { data: isOp, error: opErr } = await supabase.rpc("is_platform_operator");
  if (opErr) {
    console.error("[requirePlatformContext] is_platform_operator rpc error:", opErr);
    await logDenied(supabase, targetAccountId);
    throw new ForbiddenError("Could not resolve platform context");
  }
  if (!isOp) {
    // Not an operator at all — deny (and do NOT expose tenant existence).
    await logDenied(supabase, targetAccountId);
    throw new ForbiddenError("Not authorized for this account");
  }

  // Authorized for THIS tenant specifically?
  const { data: canAccess, error: accErr } = await supabase.rpc(
    "can_access_account",
    { target_account_id: targetAccountId },
  );
  if (accErr) {
    console.error("[requirePlatformContext] can_access_account rpc error:", accErr);
    await logDenied(supabase, targetAccountId);
    throw new ForbiddenError("Could not resolve platform context");
  }
  if (!canAccess) {
    await logDenied(supabase, targetAccountId);
    throw new ForbiddenError("Not authorized for this account");
  }

  // Load the tenant's account meta (idempotent point lookup; RLS on
  // accounts now also permits the operator via accounts_select).
  const { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", targetAccountId)
    .maybeSingle();
  if (accountErr || !account) {
    await logDenied(supabase, targetAccountId);
    throw new ForbiddenError("Account not found");
  }

  // Read the operator's per-tenant access role (for UI/route gating).
  const { data: accessRole, error: roleErr } = await supabase
    .from("platform_operator_accounts")
    .select("access_role")
    .eq("operator_user_id", user.id)
    .eq("account_id", targetAccountId)
    .maybeSingle();
  if (roleErr) {
    console.error("[requirePlatformContext] access role fetch error:", roleErr);
  }

  // Audit the entry with the REAL actor.
  await logEntered(supabase, targetAccountId);

  return {
    // Reuse the same shape as AccountContext; userId is the operator's
    // real auth.uid(), accountId is the TARGET tenant they are viewing.
    supabase,
    userId: user.id,
    accountId: account.id,
    role: (accessRole?.access_role as AccountRole) ?? ("viewer" as AccountRole),
    account: { id: account.id, name: account.name },
    actorUserId: user.id,
    isPlatformContext: true,
    accessMode: "platform_operator",
    accessRole: accessRole?.access_role,
  };
}

/** Convert a platform-context error into a NextResponse (same contract as account.ts). */
export function toPlatformErrorResponse(err: unknown): NextResponse {
  return toErrorResponse(err);
}

// --- internal audit helpers (actor always = auth.uid() inside the RPC) ---

async function logEntered(supabase: SupabaseClient, targetAccountId: string) {
  const { error } = await supabase.rpc("log_platform_context_entered", {
    p_target_account_id: targetAccountId,
  });
  if (error) console.error("[requirePlatformContext] audit entered failed:", error);
}

async function logDenied(supabase: SupabaseClient, targetAccountId: string) {
  const { error } = await supabase.rpc("log_platform_context_denied", {
    p_target_account_id: targetAccountId,
  });
  if (error) console.error("[requirePlatformContext] audit denied failed:", error);
}
