// ============================================================
// Shared post-authentication destination resolver.
//
// Used everywhere a session is freshly established client-side
// (password login, a mount-time check for an already-authenticated
// visitor, or right after a reset-password success) so the "active
// platform operators land on /act" rule lives in exactly one place
// instead of being re-implemented per call site. Mirrors the same
// is_platform_operator() gate enforced server-side by
// src/app/act/page.tsx — the redirect target and the route's own
// access check can never disagree, because they call the same RPC.
//
// A failed/errored RPC call falls back to "/dashboard" rather than
// blocking navigation — an operator who hits a transient error here
// can still navigate to /act manually; a broken redirect that traps
// every user at a blank screen would be worse.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolvePostAuthDestination(
  supabase: SupabaseClient,
): Promise<"/act" | "/dashboard"> {
  const { data: isOperator } = await supabase.rpc("is_platform_operator");
  return isOperator ? "/act" : "/dashboard";
}
