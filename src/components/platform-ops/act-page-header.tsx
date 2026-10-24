"use client";

// Heading of the /act discovery page. Client Component because the
// locale is resolved client-side (I18nProvider); the page itself stays a
// Server Component that owns the authentication/authorization gate.

import { useTranslations } from "next-intl";

import { CreateWorkspaceDialog } from "@/components/workspaces/create-workspace-dialog";

export function ActPageHeader() {
  const t = useTranslations("act.discovery");
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <CreateWorkspaceDialog />
    </div>
  );
}
