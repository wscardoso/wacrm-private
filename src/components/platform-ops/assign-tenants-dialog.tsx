"use client";

// ============================================================
// E9 / Fase 2 — "Manage tenants" dialog for one operator. Wraps
// assign_platform_operator_account / unassign_platform_operator_account
// (037, UNCHANGED signatures) via the Server Actions in
// src/app/act/actions.ts.
//
// KNOWN LIMITATION (documented, not a bug — confirmed with the
// requester): the "assign a new tenant" list is sourced from
// list_platform_operator_accounts() — i.e. only the tenants the
// CALLING admin themself supervises. There is no
// "list every tenant on the platform" RPC, and none should be added
// just for this picker (it would widen the read surface beyond what
// this Sprint's scope covers). This is correct for the current setup
// (a single admin who supervises every tenant they provision via
// create_platform_workspace). If a second admin starts provisioning
// tenants independently, this picker will not show tenants outside the
// calling admin's own assignments — revisit then, not now.
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";

import { assignTenantAction, unassignTenantAction } from "@/app/act/actions";
import type { PlatformOperatorAccount } from "@/lib/auth/platform-accounts";
import type { PlatformAccessRoleValue, PlatformOperatorRow } from "@/lib/platform-ops/operators";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface AssignTenantsDialogProps {
  operator: PlatformOperatorRow;
  supervisedAccounts: PlatformOperatorAccount[];
  onClose: () => void;
  onChanged: () => void;
}

export function AssignTenantsDialog({
  operator,
  supervisedAccounts,
  onClose,
  onChanged,
}: AssignTenantsDialogProps) {
  const t = useTranslations("act.assign_dialog");
  const [accessRole, setAccessRole] = useState<PlatformAccessRoleValue>("viewer");
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    supervisedAccounts[0]?.account_id ?? null,
  );
  const [pending, setPending] = useState(false);

  const assignedIds = new Set(operator.assigned_accounts.map((a) => a.account_id));
  const assignableAccounts = supervisedAccounts.filter((a) => !assignedIds.has(a.account_id));

  async function handleAssign() {
    if (!selectedAccountId) return;
    setPending(true);
    await assignTenantAction({
      operatorUserId: operator.user_id,
      accountId: selectedAccountId,
      accessRole,
    });
    setPending(false);
    onChanged();
  }

  async function handleUnassign(accountId: string) {
    setPending(true);
    await unassignTenantAction({ operatorUserId: operator.user_id, accountId });
    setPending(false);
    onChanged();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title", { email: operator.email })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-4">
          {operator.assigned_accounts.length > 0 && (
            <div className="flex flex-col gap-2">
              {operator.assigned_accounts.map((a) => (
                <div
                  key={a.account_id}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-foreground">{a.name}</span>
                    <Badge variant="outline">{a.access_role}</Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => handleUnassign(a.account_id)}
                  >
                    {t("unassign")}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {assignableAccounts.length > 0 && (
            <div className="flex items-end gap-2 border-t border-border pt-4">
              <div className="flex flex-1 flex-col gap-2">
                <Select
                  value={selectedAccountId ?? undefined}
                  onValueChange={setSelectedAccountId}
                  disabled={pending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {assignableAccounts.map((a) => (
                      <SelectItem key={a.account_id} value={a.account_id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Select
                  value={accessRole}
                  onValueChange={(v) => setAccessRole(v as PlatformAccessRoleValue)}
                  disabled={pending}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">viewer</SelectItem>
                    <SelectItem value="agent">agent</SelectItem>
                    <SelectItem value="admin">admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleAssign} disabled={pending || !selectedAccountId}>
                {t("assign")}
              </Button>
            </div>
          )}

          <p className="text-xs text-muted-foreground">{t("assigned_note")}</p>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
