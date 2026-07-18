import Link from "next/link";
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
// renders read-only chrome (banner + name + role + account switch links).
// It does NOT hold business logic, does NOT write, and does NOT introduce
// any global/cookie context. The account switcher is plain server-rendered
// <Link> navigation sourced from list_platform_operator_accounts(); each
// link re-enters requirePlatformContext() for the target tenant.
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

      {/* Shared platform read-only chrome (moved here from Inbox). */}
      <div className="border-b border-amber-300 bg-amber-50">
        <div className="mx-auto flex max-w-screen-xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm text-amber-900">
          <div className="flex items-center gap-2">
            <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide">
              Platform view
            </span>
            <span>
              supervising tenant{" "}
              <code className="font-mono text-xs">{value.accountName}</code> as{" "}
              <strong>{value.accessRole ?? "viewer"}</strong>
            </span>
            <span className="rounded-full border border-amber-400 px-1.5 py-0.5 text-xs">
              read-only
            </span>
          </div>
          <Link
            href="/act"
            className="text-xs font-medium underline underline-offset-2 hover:text-amber-700"
          >
            ← All tenants
          </Link>
        </div>
      </div>

      {/* Account switcher — only the operator's own assigned tenants. */}
      {accounts.length > 1 && (
        <nav
          aria-label="Switched tenants"
          className="border-b border-border bg-muted/40"
        >
          <div className="mx-auto flex max-w-screen-xl flex-wrap gap-1 px-4 py-2">
            {accounts.map((acc) => {
              const active = acc.account_id === ctx.accountId;
              return (
                <Link
                  key={acc.account_id}
                  href={`/act/${acc.account_id}/inbox`}
                  aria-current={active ? "page" : undefined}
                  className={
                    "rounded-md px-2 py-1 text-xs transition-colors " +
                    (active
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-accent")
                  }
                >
                  {acc.name}
                </Link>
              );
            })}
          </div>
        </nav>
      )}

      {children}
    </PlatformContextProvider>
  );
}
