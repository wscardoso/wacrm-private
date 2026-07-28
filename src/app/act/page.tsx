import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { listPlatformOperatorAccounts } from "@/lib/auth/platform-accounts";
import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";
import { ActControlTower } from "@/components/platform-ops/act-control-tower";

// P1c / Lot 2 — Platform Account Discovery page (server component).
//
// This is the operator's "control tower" entry point. It lists ONLY the
// tenants the authenticated operator is authorized to supervise, sourced
// exclusively from list_platform_operator_accounts() (migration 039). The
// RPC filters by auth.uid() inside the database, so this page never reads
// platform_operator_accounts directly and never trusts a client-supplied
// account_id. Active-operator status is verified via is_platform_operator()
// (037); non-operators and inactive operators are redirected home.
export default async function ActDiscoveryPage() {
  const supabase = await createClient();

  // 1. Must be authenticated at all.
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    redirect("/");
  }

  // 2. Must be an ACTIVE platform operator (037 RPC: true only when
  //    is_active). Non-operators / inactive operators get bounced.
  const { data: isOp, error: opErr } = await supabase.rpc("is_platform_operator");
  if (opErr || !isOp) {
    redirect("/");
  }

  // 3. Load ONLY the caller's own assignments from the discovery RPC.
  let accounts;
  try {
    accounts = await listPlatformOperatorAccounts(supabase);
  } catch (err) {
    // Let the error surface rather than silently showing an empty list —
    // a real RPC failure should not be masked as "no tenants".
    console.error("[act discovery] list_platform_operator_accounts failed:", err);
    throw err;
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            Supervised tenants
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Select a tenant to open its inbox in read-only platform view.
          </p>
        </div>
        <CreateWorkspaceDialog />
      </div>

      <div className="mt-6">
        <ActControlTower accounts={accounts} />
      </div>
    </main>
  );
}
