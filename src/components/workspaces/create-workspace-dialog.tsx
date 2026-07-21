"use client";

// ============================================================
// P2.2 / P2.3-B — Workspace provisioning dialog (Client Component).
//
// Rendered on /act for authenticated platform operators. Collects a
// Workspace name (required), optional CNPJ, and required owner email,
// then provisions via the `createWorkspaceAction` Server Action. The
// UI performs NO authorization — whether the caller may create a
// Workspace and whether the owner email resolves to a valid user is
// decided entirely server-side by the SECURITY DEFINER RPC. Currency
// is fixed to BRL and shown read-only.
//
// On success we navigate using ONLY the server-returned accountId.
// On failure we surface the typed, already-sanitized error message and
// preserve the values the operator typed.
// ============================================================

import * as React from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, TriangleAlert } from "lucide-react";

import { createWorkspaceAction } from "@/app/act/actions";
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

export function CreateWorkspaceDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [cnpj, setCnpj] = React.useState("");
  const [ownerEmail, setOwnerEmail] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Reset transient form state whenever the dialog is dismissed so a
  // fresh open never shows a stale error or leftover input.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setCnpj("");
      setOwnerEmail("");
      setError(null);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return; // guard against concurrent submissions

    // UX-only guards; the authoritative validation lives server-side.
    // We still show a friendly message without a round trip.
    if (name.trim() === "") {
      setError("Workspace name is required.");
      return;
    }
    if (ownerEmail.trim() === "") {
      setError("Owner email is required.");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await createWorkspaceAction({
        name,
        // Optional: empty string means "no CNPJ" → let the server
        // normalize to null. Non-empty is validated/normalized server-side.
        cnpj: cnpj.trim() === "" ? null : cnpj,
        ownerEmail: ownerEmail.trim(),
      });

      if (result.success) {
        // Navigate using ONLY the server-returned id — never anything
        // the operator typed.
        router.push(`/act/${result.accountId}/inbox`);
        return;
      }

      // Preserve typed values; surface the safe, typed error message.
      setError(result.error.message);
    });
  }

  const errorId = "create-workspace-error";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button>
            <PlusIcon />
            New Workspace
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>New Workspace</DialogTitle>
            <DialogDescription>
              Provision a new tenant workspace with its Owner.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 flex flex-col gap-4">
            {error && (
              <Alert
                variant="destructive"
                id={errorId}
                aria-live="polite"
              >
                <TriangleAlert />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-name">
                Workspace name<span aria-hidden="true"> *</span>
              </Label>
              <Input
                id="workspace-name"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
                disabled={pending}
                aria-required="true"
                aria-invalid={error != null && name.trim() === ""}
                aria-describedby={error ? errorId : undefined}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-cnpj">CNPJ (optional)</Label>
              <Input
                id="workspace-cnpj"
                name="cnpj"
                value={cnpj}
                onChange={(e) => setCnpj(e.target.value)}
                inputMode="numeric"
                placeholder="00.000.000/0000-00"
                disabled={pending}
                aria-describedby={error ? errorId : undefined}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-email">
                Owner e-mail <span aria-hidden="true">*</span>
              </Label>
              <Input
                id="workspace-email"
                name="ownerEmail"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="izabela@oralunic.com.br"
                disabled={pending}
                aria-describedby={error ? errorId : undefined}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-currency">Currency</Label>
              <Input
                id="workspace-currency"
                value="BRL"
                readOnly
                disabled
                aria-readonly="true"
              />
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
