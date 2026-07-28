"use client";

// ============================================================
// E9 / Fase 2 — "Equipe" tab: admin-only directory of platform
// operators (list_platform_operators, migration 062) with grant/
// revoke/assign/unassign actions (all via the existing 037 RPCs,
// through the Server Actions in src/app/act/actions.ts).
//
// This tab is reachable by any operator who can open /act, but the
// underlying RPC is admin-gated — a non-admin operator sees the
// `team.unauthorized` message instead of the table (see 062's own doc
// comment: the operator directory is not exposed more broadly than
// that, by design).
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { UserPlus } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { listOperatorsAction, revokeOperatorAction } from "@/app/act/actions";
import type { PlatformOperatorAccount } from "@/lib/auth/platform-accounts";
import type { PlatformOperatorRow } from "@/lib/platform-ops/operators";
import { InviteOperatorDialog } from "@/components/platform-ops/invite-operator-dialog";
import { AssignTenantsDialog } from "@/components/platform-ops/assign-tenants-dialog";

interface TeamTabProps {
  /** The CALLING admin's own supervised tenants (list_platform_operator_accounts,
   *  039) — the only tenant list available to assign from. See
   *  assign_dialog.assigned_note (i18n) for the known limitation this
   *  implies if a second admin provisions tenants independently. */
  supervisedAccounts: PlatformOperatorAccount[];
}

function initialsFromEmail(email: string): string {
  return (email[0] ?? "?").toUpperCase();
}

export function TeamTab({ supervisedAccounts }: TeamTabProps) {
  const t = useTranslations("act.team");
  const [operators, setOperators] = useState<PlatformOperatorRow[] | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PlatformOperatorRow | null>(null);
  const [manageTarget, setManageTarget] = useState<PlatformOperatorRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  // Returns the promise (so callers like handleRevoke can await the
  // refetch) but keeps every setState call nested inside the .then()
  // callback rather than directly in this function's own body —
  // mirrors src/app/(dashboard)/dashboard/page.tsx's loadAll(), which
  // avoids react-hooks/set-state-in-effect the same way.
  const refresh = useCallback(() => {
    return listOperatorsAction().then((result) => {
      if (!result.success) {
        setUnauthorized(result.error.code === "unauthorized");
        setOperators([]);
        return;
      }
      setUnauthorized(false);
      setOperators(result.operators);
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    await revokeOperatorAction({ userId: revokeTarget.user_id });
    setRevoking(false);
    setRevokeTarget(null);
    await refresh();
  }

  if (unauthorized) {
    return <p className="text-sm text-muted-foreground">{t("unauthorized")}</p>;
  }

  if (operators === null) {
    return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <InviteOperatorDialog onInvited={refresh}>
          <Button>
            <UserPlus />
            {t("invite_operator")}
          </Button>
        </InviteOperatorDialog>
      </div>

      {operators.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("no_operators")}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">{t("column_operator")}</th>
                <th className="px-4 py-3 font-medium">{t("column_role")}</th>
                <th className="px-4 py-3 font-medium">{t("column_status")}</th>
                <th className="px-4 py-3 font-medium">{t("column_tenants")}</th>
                <th className="px-4 py-3 font-medium">{t("column_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {operators.map((op) => (
                <tr key={op.user_id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Avatar size="sm">
                        <AvatarFallback>{initialsFromEmail(op.email)}</AvatarFallback>
                      </Avatar>
                      <span className="text-foreground">{op.email}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline">
                      {op.role === "admin" ? t("role_admin") : t("role_operator")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="outline"
                      className={
                        op.is_active
                          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                          : "border-border bg-muted text-muted-foreground"
                      }
                    >
                      {op.is_active ? t("status_active") : t("status_revoked")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {op.assigned_accounts.length === 0 ? (
                      <span className="text-muted-foreground">{t("assigned_tenants_none")}</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {op.assigned_accounts.map((a) => (
                          <Badge key={a.account_id} variant="secondary">
                            {a.name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setManageTarget(op)}>
                        {t("manage_tenants")}
                      </Button>
                      {op.is_active && (
                        <Button variant="outline" size="sm" onClick={() => setRevokeTarget(op)}>
                          {t("revoke_access")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={revokeTarget != null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revoke_confirm_title")}</DialogTitle>
            <DialogDescription>
              {revokeTarget && t("revoke_confirm_description", { email: revokeTarget.email })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setRevokeTarget(null)} disabled={revoking}>
              {t("revoke_cancel")}
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={revoking}>
              {t("revoke_confirm_action")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {manageTarget && (
        <AssignTenantsDialog
          operator={manageTarget}
          supervisedAccounts={supervisedAccounts}
          onClose={() => setManageTarget(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
