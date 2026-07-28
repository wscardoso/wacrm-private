"use client";

// ============================================================
// E9 / Fase 2 — "Invite operator" dialog. Resolves an e-mail to an
// existing user (platform_lookup_user_id_by_email, 061) and grants
// operator status (grant_platform_operator, 037 — UNCHANGED
// signature), both via inviteOperatorAction. The target user must
// already have an account — this never creates one, same known
// limitation as CreateWorkspaceDialog's owner e-mail field.
// ============================================================

import * as React from "react";
import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";

import { inviteOperatorAction } from "@/app/act/actions";
import type { PlatformOperatorRoleValue } from "@/lib/platform-ops/operators";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface InviteOperatorDialogProps {
  children: React.ReactElement;
  onInvited: () => void;
}

export function InviteOperatorDialog({ children, onInvited }: InviteOperatorDialogProps) {
  const t = useTranslations("act.invite_dialog");
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<PlatformOperatorRoleValue>("operator");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setEmail("");
      setRole("operator");
      setError(null);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (email.trim() === "") {
      setError(t("email_required"));
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await inviteOperatorAction({ email: email.trim(), role });
      if (result.success) {
        onInvited();
        handleOpenChange(false);
        return;
      }
      setError(result.error.message);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={children} />
      <DialogContent>
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 flex flex-col gap-4">
            {error && (
              <Alert variant="destructive" aria-live="polite">
                <TriangleAlert />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-operator-email">{t("email_label")}</Label>
              <Input
                id="invite-operator-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("email_placeholder")}
                required
                autoFocus
                disabled={pending}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="invite-operator-role">{t("role_label")}</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as PlatformOperatorRoleValue)}
                disabled={pending}
              >
                <SelectTrigger id="invite-operator-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="operator">{t("role_operator")}</SelectItem>
                  <SelectItem value="admin">{t("role_admin")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t("inviting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
