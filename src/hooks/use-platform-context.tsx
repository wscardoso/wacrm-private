"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

import type { AccountAccessMode } from "@/lib/auth/account-context";

export interface PlatformContextValue {
  /** Always true when provided by the /act/[accountId] tree. */
  isPlatformContext: boolean;
  /** The tenant being viewed (from the validated URL). Null outside platform context. */
  activeAccountId: string | null;
  /** How the account scope was reached. */
  accessMode: AccountAccessMode | null;
  /** The REAL authenticated operator (auth.uid()). Never the tenant's user. */
  actorUserId: string | null;
  /** Operator's per-tenant access role, when in platform context. */
  accessRole: string | null;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

/**
 * PlatformContextProvider — wraps the /act/[accountId] subtree. The
 * `value` is computed server-side by the route (after requirePlatformContext
 * has validated authorization and stamped the audit log), so the client
 * never performs or trusts authorization. It only carries the already
 * validated view metadata down to client components (inbox, etc.) that
 * need to know "I am viewing tenant X as operator Y".
 */
export function PlatformContextProvider({
  value,
  children,
}: {
  value: PlatformContextValue;
  children: ReactNode;
}) {
  return (
    <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
  );
}

/**
 * usePlatformContext — read the current platform-view metadata.
 * Returns a non-platform default (isPlatformContext: false) when used
 * outside the /act tree, so normal pages are unaffected.
 */
export function usePlatformContext(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) {
    return {
      isPlatformContext: false,
      activeAccountId: null,
      accessMode: null,
      actorUserId: null,
      accessRole: null,
    };
  }
  return ctx;
}
