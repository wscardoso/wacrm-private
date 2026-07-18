"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { LogOut, Menu, Settings as SettingsIcon, User } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ModeToggle } from "@/components/layout/mode-toggle";

function getPageTitle(pathname: string, t: (key: string) => string): string {
  const titles: Record<string, string> = {
    "/dashboard": t("nav_dashboard"),
    "/inbox": t("nav_inbox"),
    "/contacts": t("nav_contacts"),
    "/pipelines": t("nav_pipelines"),
    "/broadcasts": t("nav_broadcasts"),
    "/automations": t("nav_automations"),
    "/settings": t("nav_settings"),
  };
  if (titles[pathname]) return titles[pathname];
  const match = Object.entries(titles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : t("nav_dashboard");
}

interface HeaderProps {
  /** Wired to the shell's drawer state. Used only on mobile — the
   *  hamburger button is hidden on lg+. */
  onOpenSidebar?: () => void;
}

export function Header({ onOpenSidebar }: HeaderProps) {
  const pathname = usePathname();
  const t = useTranslations("layout.sidebar");
  const th = useTranslations("layout.header");
  const { profile, account, accountRole, signOut } = useAuth();
  const tr = useTranslations("roles");
  const title = getPageTitle(pathname, t);

  const initial =
    profile?.full_name?.charAt(0)?.toUpperCase() ??
    profile?.email?.charAt(0)?.toUpperCase() ??
    "U";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        {/* Hamburger — mobile only. 44×44 hit target per Apple HIG. */}
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={th("open_menu")}
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-1 sm:gap-2">
        <ModeToggle />

        <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70 sm:gap-3 sm:pl-1 sm:pr-3"
          aria-label={th("open_account_menu")}
        >
          <Avatar className="size-8">
            {profile?.avatar_url ? (
              <AvatarImage
                src={profile.avatar_url}
                alt={profile.full_name ?? th("avatar_alt")}
              />
            ) : null}
            <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-sm font-medium text-foreground sm:inline">
            {profile?.full_name ?? th("user_fallback")}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="min-w-56 bg-popover text-popover-foreground ring-border"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-sm font-medium text-foreground flex items-center gap-1.5">
              {profile?.full_name ?? th("user_fallback")}
              {accountRole && (
                <span className="inline-flex shrink-0 items-center rounded-full border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-primary">
                  {tr(accountRole)}
                </span>
              )}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {profile?.email ?? ""}
            </p>
            {account?.name && (
              <p className="truncate text-[11px] text-muted-foreground mt-1">
                {th("workspace", { name: account.name })}
              </p>
            )}
          </div>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            render={
              <Link
                href="/settings?tab=profile"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <User className="size-4" />
            {th("profile")}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link
                href="/settings"
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <SettingsIcon className="size-4" />
            {th("settings")}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem
            onClick={signOut}
            className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <LogOut className="size-4" />
            {th("sign_out")}
          </DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
