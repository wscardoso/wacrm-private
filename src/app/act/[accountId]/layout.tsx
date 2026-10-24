import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  requirePlatformContext,
  toPlatformErrorResponse,
} from "@/lib/auth/account-context";
import { listPlatformOperatorAccounts } from "@/lib/auth/platform-accounts";
import {
  PlatformContextProvider,
} from "@/hooks/use-platform-context";
import { PlatformTenantChrome } from "@/components/platform-ops/platform-tenant-chrome";
import { PlatformContextAuditExit } from "./platform-context-audit-exit";

// Server layout for the platform-operator "act as tenant" subtree.
//
// The accountId in the URL is ONLY a selector. Authorization is re-derived
// here, server-side, from the real auth.uid() via requirePlatformContext(),
// which also writes the `context_entered` audit row. If the operator is not
// authorized for this tenant, requirePlatformContext throws and we redirect
// to a safe location (the denied case is already audited inside it).
//
// This layout is intentionally a SHELL: it validates, stamps audit, and
// hands the validated metadata to PlatformTenantChrome (banner, section
// navigation, tenant switcher). It does NOT hold business logic, does NOT
// write, and does NOT introduce any global/cookie context. The switcher
// links come from list_platform_operator_accounts(); each link re-enters
// requirePlatformContext() for the target tenant.
export default async function ActLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountId: string }>;
}) {
  const { accountId } = await params;

  let ctx;
  try {
    ctx = await requirePlatformContext(accountId);
  } catch (err) {
    // Map to a response purely to reuse the status/redirect logic; we
    // don't render JSON in a layout, we send the operator back to the
    // dashboard. The denial is already audited by requirePlatformContext.
    toPlatformErrorResponse(err);
    redirect("/");
    return;
  }

  // Chrome accounts for the switcher — ONLY the caller's own assignments,
  // straight from the discovery RPC (no direct select on
  // platform_operator_accounts, no service-role).
  let accounts: Awaited<ReturnType<typeof listPlatformOperatorAccounts>> = [];
  try {
    accounts = await listPlatformOperatorAccounts(ctx.supabase);
  } catch (err) {
    // Switcher is non-critical; log and fall back to the single active
    // account so the page still renders. Audit/authorization are unaffected.
    console.error("[act layout] account switcher discovery failed:", err);
    accounts = [];
  }

  const value = {
    isPlatformContext: true,
    activeAccountId: ctx.accountId,
    accessMode: "platform_operator" as const,
    actorUserId: ctx.actorUserId,
    accessRole: ctx.accessRole ?? null,
    accountName: ctx.account?.name ?? null,
  };

  return (
    <PlatformContextProvider value={value}>
      <PlatformContextAuditExit accountId={ctx.accountId} />

      <PlatformTenantChrome
        activeAccountId={ctx.accountId}
        accountName={value.accountName}
        accessRole={value.accessRole}
        accounts={accounts.map((acc) => ({ account_id: acc.account_id, name: acc.name }))}
      />

      {children}
    </PlatformContextProvider>
  );
}
