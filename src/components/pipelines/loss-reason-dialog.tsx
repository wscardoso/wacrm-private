"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_LOSS_REASON_LENGTH } from "@/lib/deals/status";

interface LossReasonDialogProps {
  open: boolean;
  dealTitle?: string;
  /** Pre-filled reason (e.g. already typed in the deal form). */
  initialReason?: string;
  saving: boolean;
  onConfirm: (reason: string) => void;
  /** Cancelling must leave the deal untouched. */
  onCancel: () => void;
}

export function LossReasonDialog({
  open,
  dealTitle,
  initialReason = "",
  saving,
  onConfirm,
  onCancel,
}: LossReasonDialogProps) {
  const t = useTranslations("pipelines");
  const [reason, setReason] = useState(initialReason);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) setReason(initialReason);
  }, [open, initialReason]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const trimmed = reason.trim();
  const canConfirm = trimmed.length > 0 && !saving;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("loss_dialog_title")}</DialogTitle>
        </DialogHeader>
        {dealTitle && (
          <p className="text-sm text-muted-foreground">{dealTitle}</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canConfirm) onConfirm(trimmed);
          }}
          className="space-y-3"
        >
          <Input
            autoFocus
            value={reason}
            maxLength={MAX_LOSS_REASON_LENGTH}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("loss_reason_placeholder")}
            className="border-border bg-muted text-foreground"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
              {t("loss_dialog_cancel")}
            </Button>
            <Button
              type="submit"
              disabled={!canConfirm}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("loss_dialog_confirm")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
