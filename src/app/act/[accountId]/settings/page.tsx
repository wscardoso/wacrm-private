'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePlatformContext } from '@/hooks/use-platform-context';
import { updateWorkspaceIdentityAction } from './actions';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

// Platform Settings — write surface for E5b. Tenant is taken exclusively
// from the already-validated platform context (the /act layout already
// re-derived the operator's authorization server-side via
// requirePlatformContext / can_access_account for the READ). The actual
// WRITE authorization is independently re-checked inside the
// update_platform_workspace_identity RPC (054) via
// is_platform_operator_for(accountId) — this page never assumes write
// access just because it rendered.
//
// Unlike the read-only Contacts page, this is a THIN CONSUMER of the
// updateWorkspaceIdentityAction server action (mirrors
// CreateWorkspaceDialog → createWorkspaceAction), not a second
// implementation of validation or authorization.

interface IdentityRow {
  id: string;
  name: string;
  legal_name: string | null;
  commercial_phone: string | null;
  commercial_email: string | null;
  cnpj: string | null;
  updated_at: string;
}

type FieldKey = 'name' | 'legal_name' | 'commercial_phone' | 'commercial_email' | 'cnpj';

export default function PlatformSettingsPage() {
  const { activeAccountId } = usePlatformContext();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [account, setAccount] = useState<IdentityRow | null>(null);

  // Form state — undefined for a field means "not touched yet" (so an
  // untouched field is simply not sent, preserving partial-update
  // semantics for fields the operator never opened).
  const [form, setForm] = useState<Partial<Record<FieldKey, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});

  const fetchAccount = useCallback(async () => {
    if (!activeAccountId) return;
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase
      .from('accounts')
      .select('id, name, legal_name, commercial_phone, commercial_email, cnpj, updated_at')
      .eq('id', activeAccountId)
      .single();
    if (error || !data) {
      setLoadError('Failed to load workspace identity.');
      setLoading(false);
      return;
    }
    setAccount(data as IdentityRow);
    setForm({});
    setTouched({});
    setLoading(false);
  }, [supabase, activeAccountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchAccount();
  }, [fetchAccount]);

  function setField(key: FieldKey, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setTouched((t) => ({ ...t, [key]: true }));
    setSaveSuccess(false);
  }

  /** Empty string in a touched text input means "clear this field" —
   *  translated to explicit `null` in the submitted partial-update
   *  payload (§7.5), except `name` which can never be cleared. */
  function toSubmitValue(key: FieldKey): string | null {
    const raw = (form[key] ?? '').trim();
    if (key === 'name') return raw;
    return raw === '' ? null : raw;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeAccountId) return;

    const fields: Record<string, string | null> = {};
    for (const key of Object.keys(touched) as FieldKey[]) {
      if (touched[key]) fields[key] = toSubmitValue(key);
    }
    if (Object.keys(fields).length === 0) return;

    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    setFieldErrors({});

    const result = await updateWorkspaceIdentityAction(activeAccountId, fields);

    setSaving(false);
    if (!result.success) {
      setSaveError(result.error.message);
      if (result.error.field) {
        setFieldErrors({ [result.error.field]: result.error.message });
      }
      return;
    }

    setAccount(result.account);
    setForm({});
    setTouched({});
    setSaveSuccess(true);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span>Loading workspace identity…</span>
      </div>
    );
  }

  if (loadError || !account) {
    return (
      <div className="flex flex-col items-center gap-2 p-12 text-center">
        <AlertTriangle className="size-8 text-destructive" />
        <p className="text-sm text-destructive">{loadError ?? 'Workspace not found.'}</p>
      </div>
    );
  }

  const fieldValue = (key: FieldKey) =>
    touched[key] ? (form[key] ?? '') : (account[key] ?? '');

  return (
    <div className="mx-auto max-w-xl space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Workspace settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Commercial identity for <code className="font-mono text-xs">{account.name}</code>.
          Blank a field to clear it.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground" htmlFor="name">
            Workspace name
          </label>
          <Input
            id="name"
            value={fieldValue('name')}
            onChange={(e) => setField('name', e.target.value)}
          />
          {fieldErrors.name && <p className="text-xs text-destructive">{fieldErrors.name}</p>}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground" htmlFor="legal_name">
            Legal name (razão social)
          </label>
          <Input
            id="legal_name"
            value={fieldValue('legal_name')}
            onChange={(e) => setField('legal_name', e.target.value)}
          />
          {fieldErrors.legal_name && (
            <p className="text-xs text-destructive">{fieldErrors.legal_name}</p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground" htmlFor="commercial_phone">
            Commercial phone
          </label>
          <Input
            id="commercial_phone"
            value={fieldValue('commercial_phone')}
            onChange={(e) => setField('commercial_phone', e.target.value)}
          />
          {fieldErrors.commercial_phone && (
            <p className="text-xs text-destructive">{fieldErrors.commercial_phone}</p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground" htmlFor="commercial_email">
            Commercial email
          </label>
          <Input
            id="commercial_email"
            value={fieldValue('commercial_email')}
            onChange={(e) => setField('commercial_email', e.target.value)}
          />
          {fieldErrors.commercial_email && (
            <p className="text-xs text-destructive">{fieldErrors.commercial_email}</p>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground" htmlFor="cnpj">
            CNPJ
          </label>
          <Input
            id="cnpj"
            value={fieldValue('cnpj')}
            onChange={(e) => setField('cnpj', e.target.value)}
          />
          {fieldErrors.cnpj && <p className="text-xs text-destructive">{fieldErrors.cnpj}</p>}
        </div>

        {saveError && !Object.keys(fieldErrors).length && (
          <p className="text-sm text-destructive">{saveError}</p>
        )}
        {saveSuccess && (
          <p className="flex items-center gap-1.5 text-sm text-emerald-600">
            <CheckCircle2 className="size-4" /> Workspace identity updated.
          </p>
        )}

        <Button type="submit" disabled={saving || Object.keys(touched).length === 0}>
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Saving…
            </>
          ) : (
            'Save changes'
          )}
        </Button>
      </form>
    </div>
  );
}
