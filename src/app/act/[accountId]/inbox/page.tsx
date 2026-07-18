"use client";

import { Suspense } from "react";
import InboxPage from "@/app/(dashboard)/inbox/page";
import { usePlatformContext } from "@/hooks/use-platform-context";

// Minimal read-only proof for P1b: a platform operator authorized for a
// tenant (validated server-side by the /act/[accountId] layout) views the
// same inbox UI as a member. All data reads are RLS-scoped to the tenant
// via can_access_account(); the operator cannot write. This page only adds
// a non-interactive banner identifying the supervised tenant.
export default function ActInboxPage() {
  const { isPlatformContext, activeAccountId, accessRole } = usePlatformContext();

  return (
    <div className="flex h-full flex-col">
      {isPlatformContext && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Platform view — supervising tenant{" "}
          <code className="font-mono text-xs">{activeAccountId}</code> as{" "}
          <strong>{accessRole ?? "viewer"}</strong>. Read-only; writes are
          disabled.
        </div>
      )}
      <Suspense fallback={null}>
        <InboxPage />
      </Suspense>
    </div>
  );
}
