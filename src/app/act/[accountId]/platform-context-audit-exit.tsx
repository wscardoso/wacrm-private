"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// Fires the `context_exited` audit event when the operator leaves the
// /act/[accountId] subtree (unmount). The actor is stamped server-side by
// the RPC from auth.uid(), so the client cannot forge it. Best-effort:
// failures are logged but never block navigation.
export function PlatformContextAuditExit({ accountId }: { accountId: string }) {
  useEffect(() => {
    return () => {
      const supabase = createClient();
      supabase
        .rpc("log_platform_context_exited", { p_target_account_id: accountId })
        .then(({ error }: { error: unknown }) => {
          if (error) {
            console.error("[PlatformContextAuditExit] exit audit failed:", error);
          }
        });
    };
  }, [accountId]);

  return null;
}
