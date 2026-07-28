"use client";

// ============================================================
// E9 — the /act "control tower". Server-side auth/redirect gate stays
// in src/app/act/page.tsx (a Server Component); this Client Component
// owns everything downstream: the Tenants/Equipe tabs, the metrics
// grid, and the team-management surface. Mirrors the established
// convention in this app (every next-intl usage lives in a "use
// client" component; src/app/(dashboard)/dashboard/page.tsx is the
// reference) rather than introducing server-side getTranslations,
// which nothing else in this codebase uses.
// ============================================================

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Building2, Inbox, MessageSquareText, Radio } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { MetricCard } from "@/components/dashboard/metric-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PlatformOperatorAccount } from "@/lib/auth/platform-accounts";
import {
  loadTenantMetrics,
  summarizeTenantMetrics,
  type TenantMetrics,
} from "@/lib/platform-ops/tenant-metrics";
import { TenantCard } from "@/components/platform-ops/tenant-card";
import { TeamTab } from "@/components/platform-ops/team-tab";

interface ActControlTowerProps {
  accounts: PlatformOperatorAccount[];
}

export function ActControlTower({ accounts }: ActControlTowerProps) {
  const t = useTranslations("act");
  const [metrics, setMetrics] = useState<Map<string, TenantMetrics> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    loadTenantMetrics(
      supabase,
      accounts.map((a) => a.account_id),
    ).then((result) => {
      if (!cancelled) setMetrics(result);
    });
    return () => {
      cancelled = true;
    };
    // accounts is derived server-side once per page load; re-fetching on
    // every render of the same list would be wasted work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = metrics ? summarizeTenantMetrics(metrics) : null;

  return (
    <Tabs defaultValue="tenants">
      <TabsList>
        <TabsTrigger value="tenants">{t("tabs.tenants")}</TabsTrigger>
        <TabsTrigger value="team">{t("tabs.team")}</TabsTrigger>
      </TabsList>

      <TabsContent value="tenants" className="mt-6 flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title={t("summary.tenants_supervised")}
            value={String(summary?.tenantsSupervised ?? accounts.length)}
            icon={Building2}
          />
          <MetricCard
            title={t("summary.whatsapp_connected")}
            value={summary ? String(summary.whatsappConnected) : "—"}
            icon={Radio}
          />
          <MetricCard
            title={t("summary.total_unread")}
            value={summary ? String(summary.totalUnread) : "—"}
            icon={Inbox}
          />
          <MetricCard
            title={t("summary.messages_today")}
            value={summary ? String(summary.totalMessagesToday) : "—"}
            icon={MessageSquareText}
          />
        </div>

        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty_state")}</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((account) => (
              <TenantCard
                key={account.account_id}
                account={account}
                metrics={
                  metrics?.get(account.account_id) ?? {
                    contactsCount: 0,
                    messagesToday: 0,
                    unreadCount: 0,
                    lastMessageAt: null,
                    whatsappStatus: "unconfigured",
                    whatsappProvider: null,
                  }
                }
              />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="team" className="mt-6">
        <TeamTab supervisedAccounts={accounts} />
      </TabsContent>
    </Tabs>
  );
}
