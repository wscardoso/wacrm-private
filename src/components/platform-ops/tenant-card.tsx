"use client";

// ============================================================
// E9 / Fase 1 — one tenant card in the "control tower" grid
// (/act, Tenants tab). Pure presentational: receives the already
// -authorized account (from list_platform_operator_accounts, 039)
// and its batched metrics (tenant-metrics.ts) as props — no data
// fetching happens here.
// ============================================================

import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { ptBR, enUS } from "date-fns/locale";

import { useLocale } from "@/lib/i18n-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import type { PlatformOperatorAccount } from "@/lib/auth/platform-accounts";
import type { TenantMetrics, WhatsappTenantStatus } from "@/lib/platform-ops/tenant-metrics";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// No --success/--danger tokens exist in globals.css yet. Mirrors the
// border/bg/text triad already used for the login/forgot-password
// error box (border-{color}-500/20 bg-{color}-500/10 text-{color}-400).
const STATUS_STYLES: Record<WhatsappTenantStatus, string> = {
  connected: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
  pending: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  unconfigured: "border-border bg-muted text-muted-foreground",
};

interface TenantCardProps {
  account: PlatformOperatorAccount;
  metrics: TenantMetrics;
}

export function TenantCard({ account, metrics }: TenantCardProps) {
  const t = useTranslations("act.tenant_card");
  const { locale } = useLocale();
  const dateFnsLocale = locale === "pt-BR" ? ptBR : enUS;

  const statusLabel =
    metrics.whatsappStatus === "connected"
      ? t("whatsapp_connected")
      : metrics.whatsappStatus === "pending"
        ? t("whatsapp_pending")
        : t("whatsapp_unconfigured");

  const lastMessage = metrics.lastMessageAt
    ? formatDistanceToNow(new Date(metrics.lastMessageAt), { addSuffix: true, locale: dateFnsLocale })
    : t("last_message_never");

  return (
    <Link
      href={`/act/${account.account_id}/inbox`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>{initials(account.name)}</AvatarFallback>
          </Avatar>
          <div>
            <p className="font-medium text-foreground">{account.name}</p>
            <Badge variant="outline" className="mt-1">
              {account.access_role}
            </Badge>
          </div>
        </div>
        <Badge variant="outline" className={STATUS_STYLES[metrics.whatsappStatus]}>
          {statusLabel}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-muted-foreground">{t("messages_today")}</p>
          <p className="font-medium text-foreground">{metrics.messagesToday}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t("unread")}</p>
          <p className="font-medium text-foreground">{metrics.unreadCount}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t("contacts")}</p>
          <p className="font-medium text-foreground">{metrics.contactsCount}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t("last_message")}</p>
          <p className="font-medium text-foreground">{lastMessage}</p>
        </div>
      </div>
    </Link>
  );
}
