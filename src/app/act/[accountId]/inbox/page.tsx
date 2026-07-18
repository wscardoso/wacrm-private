"use client";

import { Suspense } from "react";
import InboxPage from "@/app/(dashboard)/inbox/page";
import { usePlatformContext } from "@/hooks/use-platform-context";

// P1c / Lot 3: the read-only banner and account chrome now live in the
// shared /act/[accountId] layout, so this page is just the Inbox content.
// Authorization and the read-only guarantee are unchanged: the layout
// re-validates requirePlatformContext() on every entry, and all data reads
// remain RLS-scoped to the tenant via can_access_account(); the operator
// cannot write.
export default function ActInboxPage() {
  const { isPlatformContext } = usePlatformContext();

  return (
    <div className="flex h-full flex-col">
      {isPlatformContext && (
        // Marker kept so the page remains distinguishable, but no banner
        // duplication — the chrome is owned by the layout.
        <span hidden data-platform-context="true" />
      )}
      <Suspense fallback={null}>
        <InboxPage />
      </Suspense>
    </div>
  );
}
