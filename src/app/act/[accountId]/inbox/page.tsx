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

  // The dashboard Inbox cancels its layout's padding with -m-4 / sm:-m-6 and
  // sizes itself to the viewport minus the 3.5rem dashboard header. Under /act
  // there is no such padding and the platform chrome (banner + section nav +
  // tenant switcher) sits above, so give the margins something to cancel and
  // size the inbox to what is left.
  return (
    <div className="flex h-full flex-col p-4 sm:p-6 [&>div:not([hidden])]:!h-[calc(100vh-12rem)]">
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
