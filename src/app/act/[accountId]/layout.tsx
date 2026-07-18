import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import {
  requirePlatformContext,
  toPlatformErrorResponse,
} from "@/lib/auth/account-context";
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

  const value = {
    isPlatformContext: true,
    activeAccountId: ctx.accountId,
    accessMode: "platform_operator" as const,
    actorUserId: ctx.actorUserId,
    accessRole: ctx.accessRole ?? null,
  };

  return (
    <PlatformContextProvider value={value}>
      <PlatformContextAuditExit accountId={ctx.accountId} />
      {children}
    </PlatformContextProvider>
  );
}
