"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import {
  Crown,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  Radio,
  Settings,
  Shield,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { AccountRole } from "@/lib/auth/roles";

// Role chip labels are set dynamically in the component via t().
// The label is overwritten before render when translations are available.
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", labelKey: "nav_dashboard", icon: LayoutDashboard },
  { href: "/inbox", labelKey: "nav_inbox", icon: MessageSquare },
  { href: "/contacts", labelKey: "nav_contacts", icon: Users },
  { href: "/pipelines", labelKey: "nav_pipelines", icon: GitBranch },
  { href: "/broadcasts", labelKey: "nav_broadcasts", icon: Radio },
  { href: "/automations", labelKey: "nav_automations", icon: Zap },
  { href: "/flows", labelKey: "nav_flows", icon: Workflow, beta: true },
];

// Nav row styling, shared by the main and bottom lists. The active
// row gets a raised sidebar-accent surface plus a short marker bar in
// --sidebar-primary (gold under the Force theme).
const NAV_ROW =
  // Taller on mobile so fingers can hit the row reliably (>=44px).
  "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2";
const NAV_ACTIVE =
  "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:top-1/2 before:left-0 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-sidebar-primary";
const NAV_IDLE =
  "text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground";

const bottomNavItems = [
  { href: "/settings", labelKey: "nav_settings", icon: Settings },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname();
  const t = useTranslations("layout.sidebar");
  const tr = useTranslations("roles");
  const { profile, profileLoading, account, accountRole } = useAuth();
  const totalUnread = useTotalUnread();
  // Only surface the account-name strip when it actually carries
  // information. A solo user's personal account is named after them
  // (the 017 signup trigger seeds it from `full_name`), so showing it
  // here would just duplicate the user name in the footer below. Once
  // the account is renamed or the user joins a shared account, the
  // name diverges and the strip becomes meaningful — that's the signal
  // we gate on. Wait for the profile fetch to settle first, otherwise
  // the strip flashes in once the row resolves (a layout jump).
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // Close the drawer when route changes — users opened it to navigate,
  // so once they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't positioned there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists on mobile and only when open. Clicking
          it closes the drawer. Hidden from lg+ since the sidebar is
          part of the main flex row there. */}
      <button
        type="button"
        aria-label={t("close_menu")}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: static, always visible — reset all the mobile framing.
          "lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none",
        )}
        aria-label={t("nav_primary")}
      >
        {/* Logo row. On mobile we put a close button here; on desktop the
            close button is hidden since the sidebar is always-visible. */}
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-4">
          {/* Official Digitall Force artwork (white on transparent),
              shown at its native aspect ratio. --logo-plate stays
              transparent on dark sidebars and turns ink green on a
              light one, so the file never needs recoloring. */}
          <Link
            href="/dashboard"
            aria-label={t("app_name")}
            className="flex min-w-0 items-center gap-3"
          >
            <span className="flex shrink-0 items-center rounded-md bg-[var(--logo-plate)] px-1 py-0.5">
              <Image
                src="/brand/digitall-force-logo-white.png"
                alt="Digitall Force"
                width={517}
                height={171}
                priority
                className="h-9 w-auto"
              />
            </span>
            <span className="h-6 w-px shrink-0 bg-sidebar-border" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-highlight">
              CRM
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close_menu")}
            className="flex h-9 w-9 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {navItems.map((item) => {
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" && pathname.startsWith(item.href));

              const showUnreadDot =
                item.href === "/inbox" && totalUnread > 0 && !isActive;

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      NAV_ROW,
                      isActive ? NAV_ACTIVE : NAV_IDLE,
                    )}
                  >
                    <item.icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isActive && "text-sidebar-primary",
                      )}
                    />
                    <span className="flex-1">{t(item.labelKey)}</span>
                    {item.beta && (
                      <span
                        aria-label={t("beta")}
                        className="rounded-full border border-highlight/40 bg-highlight/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-highlight"
                      >
                        {t("beta")}
                      </span>
                    )}
                    {showUnreadDot && (
                      <span
                        aria-label={t("unread_label", { count: totalUnread })}
                        className="relative flex h-2 w-2"
                      >
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sidebar-primary opacity-75" />
                        <span className="relative inline-flex h-2 w-2 rounded-full bg-sidebar-primary" />
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="my-4 border-t border-sidebar-border" />

          <ul className="flex flex-col gap-1">
            {bottomNavItems.map((item) => {
              const isActive = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      NAV_ROW,
                      isActive ? NAV_ACTIVE : NAV_IDLE,
                    )}
                  >
                    <item.icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isActive && "text-sidebar-primary",
                      )}
                    />
                    {t(item.labelKey)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-sidebar-border p-3">
          {/* Account name display — surfaced only when the account
              name differs from the user's own name (see
              `showAccountStrip`). For a default solo account the two
              match, so we hide it to avoid duplicating the user name
              below; for renamed or shared accounts it tells the user
              which account they're acting in. */}
          {showAccountStrip && account?.name ? (
            <div className="mb-2 flex items-center gap-2 px-3 text-xs text-sidebar-foreground/70">
              <UsersRound className="size-3.5 shrink-0" />
              {/* `title=` exposes the full name on hover when it
                  gets truncated (long account names + narrow
                  sidebars). Cheap a11y win. */}
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole ? (
                // Always render the chip — owners used to be
                // invisible here, which made them indistinguishable
                // from admins at a glance. Now everyone sees their
                // role (with a colour cue) regardless of tier.
                (() => {
                  const roleChip: Record<AccountRole, { icon: typeof Crown; className: string }> = {
                    owner: { icon: Crown, className: "border-highlight/40 bg-highlight/10 text-highlight" },
                    admin: { icon: Shield, className: "border-sidebar-primary/40 bg-sidebar-primary/10 text-sidebar-primary" },
                    agent: { icon: UserCog, className: "border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground" },
                    viewer: { icon: User, className: "border-sidebar-border text-sidebar-foreground/70" },
                  };
                  const meta = roleChip[accountRole];
                  const Icon = meta.icon;
                  return (
                    <span
                      className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                    >
                      <Icon className="size-3" />
                      {tr(accountRole)}
                    </span>
                  );
                })()
              ) : null}
            </div>
          ) : null}
          {/* Account actions (Profile / Settings / Sign out) live in the
              header account menu as the single source of truth. This
              footer keeps only the non-interactive identity display so
              the sidebar still shows who is signed in. */}
          <div className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left">
            <Avatar className="size-8 shrink-0">
              {profile?.avatar_url ? (
                <AvatarImage
                  src={profile.avatar_url}
                  alt={profile.full_name ?? t("avatar_alt")}
                />
              ) : null}
              <AvatarFallback className="bg-sidebar-primary/15 text-sm font-medium text-sidebar-primary">
                {profile?.full_name?.charAt(0)?.toUpperCase() ??
                  profile?.email?.charAt(0)?.toUpperCase() ??
                  "U"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-sidebar-accent-foreground">
                {profile?.full_name ?? t("user_fallback")}
              </p>
              <p className="truncate text-xs text-sidebar-foreground/60">
                {profile?.email ?? ""}
              </p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
