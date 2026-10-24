"use client";

// ============================================================
// Platform chrome for /act/[accountId]/* — the context banner, the
// section navigation (inbox / contacts / settings / audit) and the
// tenant switcher. Rendered by the server layout, which has already
// re-derived the operator's authorization (requirePlatformContext); this
// component only presents already-validated data and performs no
// authorization of its own.
//
// It is a Client Component because locale is resolved client-side
// (I18nProvider reads a cookie) and the active section comes from the
// pathname.
//
// Banner semantics: every section is read-only EXCEPT /settings for an
// operator whose access_role on this tenant is 'admin' — the one place
// an operator can write (update_platform_workspace_identity, 054). The
// banner states which of the two applies instead of always claiming
// read-only.
// ============================================================

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export interface ChromeAccount {
  account_id: string;
  name: string;
}

interface PlatformTenantChromeProps {
  activeAccountId: string;
  accountName: string | null;
  accessRole: string | null;
  accounts: ChromeAccount[];
}

const SECTIONS = ["inbox", "contacts", "settings", "audit"] as const;
type Section = (typeof SECTIONS)[number];

function sectionFromPath(pathname: string, accountId: string): Section {
  const rest = pathname.split(`/act/${accountId}/`)[1]?.split("/")[0];
  return (SECTIONS as readonly string[]).includes(rest ?? "") ? (rest as Section) : "inbox";
}

export function PlatformTenantChrome({
  activeAccountId,
  accountName,
  accessRole,
  accounts,
}: PlatformTenantChromeProps) {
  const t = useTranslations("act.chrome");
  const pathname = usePathname() ?? "";
  const section = sectionFromPath(pathname, activeAccountId);

  const role = accessRole ?? "viewer";
  const roleLabel = ["viewer", "agent", "admin"].includes(role) ? t(`role_${role}`) : role;
  const canEditIdentity = section === "settings" && role === "admin";

  return (
    <>
      <div className="border-b border-amber-300 bg-amber-50">
        <div className="mx-auto flex max-w-screen-xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm text-amber-900">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide">
              {t("platform_view")}
            </span>
            <span>
              {t("supervising")} <code className="font-mono text-xs">{accountName}</code> {t("as")}{" "}
              <strong>{roleLabel}</strong>
            </span>
            <span
              data-testid="platform-mode-badge"
              className="rounded-full border border-amber-400 px-1.5 py-0.5 text-xs"
            >
              {canEditIdentity ? t("identity_editable") : t("read_only")}
            </span>
          </div>
          <Link
            href="/act"
            className="text-xs font-medium underline underline-offset-2 hover:text-amber-700"
          >
            {t("all_tenants")}
          </Link>
        </div>
      </div>

      <nav aria-label={t("sections_label")} className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-screen-xl gap-1 overflow-x-auto px-4 py-2">
          {SECTIONS.map((s) => {
            const active = s === section;
            return (
              <Link
                key={s}
                href={`/act/${activeAccountId}/${s}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {t(`section_${s}`)}
              </Link>
            );
          })}
        </div>
      </nav>

      {accounts.length > 1 && (
        <nav aria-label={t("switcher_label")} className="border-b border-border bg-muted/40">
          <div className="mx-auto flex max-w-screen-xl flex-wrap gap-1 px-4 py-2">
            {accounts.map((acc) => {
              const active = acc.account_id === activeAccountId;
              return (
                <Link
                  key={acc.account_id}
                  href={`/act/${acc.account_id}/${section}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-accent",
                  )}
                >
                  {acc.name}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </>
  );
}
