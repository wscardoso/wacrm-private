'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { AlertTriangle, History, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { usePlatformContext } from '@/hooks/use-platform-context';
import { useLocale } from '@/lib/i18n-provider';
import { AuditLogError, fetchAuditPage, type AuditLogEntry } from '@/lib/platform-ops/audit-log';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Platform audit trail for the supervised tenant. Read-only. The tenant
// comes exclusively from the already-validated platform context; the
// authorization (active operator authorized for this tenant) and the
// e-mail visibility rules are enforced inside list_platform_audit_log
// (097), so this page only renders what the database returned.

const KNOWN_ACTIONS = [
  'context_entered',
  'context_exited',
  'context_access_denied',
  'create_workspace',
  'update_workspace_identity',
  'grant_operator',
  'revoke_operator',
  'assign_operator_account',
  'unassign_operator_account',
] as const;

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; code: 'unauthorized' | 'unexpected' };

export default function PlatformAuditPage() {
  const t = useTranslations('act.audit');
  const { locale } = useLocale();
  const { activeAccountId } = usePlatformContext();
  const supabaseRef = useRef(createClient());

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  // Bumped on tenant switch / reload so a late response from a previous
  // tenant can never be appended to the current list.
  const generation = useRef(0);

  const loadFirst = useCallback(async () => {
    if (!activeAccountId) return;
    const mine = ++generation.current;
    setState({ kind: 'loading' });
    setEntries([]);
    setCursor(null);
    setMoreFailed(false);
    try {
      const page = await fetchAuditPage(supabaseRef.current, activeAccountId, null);
      if (mine !== generation.current) return;
      setEntries(page.entries);
      setCursor(page.nextCursor);
      setState({ kind: 'ready' });
    } catch (err) {
      if (mine !== generation.current) return;
      console.error('[act audit] load failed:', err);
      setState({ kind: 'error', code: err instanceof AuditLogError ? err.code : 'unexpected' });
    }
  }, [activeAccountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFirst();
  }, [loadFirst]);

  async function loadMore() {
    if (!activeAccountId || !cursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const page = await fetchAuditPage(supabaseRef.current, activeAccountId, cursor);
      if (mine !== generation.current) return;
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (err) {
      if (mine !== generation.current) return;
      console.error('[act audit] load more failed:', err);
      setMoreFailed(true);
    } finally {
      if (mine === generation.current) setLoadingMore(false);
    }
  }

  const stamp = (iso: string) => format(new Date(iso), locale === 'pt-BR' ? 'dd/MM/yyyy HH:mm:ss' : 'MMM d, yyyy HH:mm:ss');

  function actionLabel(action: string): string {
    return (KNOWN_ACTIONS as readonly string[]).includes(action) ? t(`action_${action}`) : action;
  }

  function actorLabel(e: AuditLogEntry): string {
    if (e.actorEmail) return e.actorEmail;
    return e.actorIsOperator ? t('actor_operator') : t('actor_external');
  }

  function detail(e: AuditLogEntry): string | null {
    const m = e.metadata ?? {};
    switch (e.action) {
      case 'update_workspace_identity': {
        const fields = Array.isArray(m.fields_changed) ? (m.fields_changed as string[]) : [];
        return fields.length ? t('detail_fields', { fields: fields.join(', ') }) : null;
      }
      case 'grant_operator':
        return [e.targetUserEmail, typeof m.role === 'string' ? m.role : null].filter(Boolean).join(' · ') || null;
      case 'assign_operator_account':
        return [e.targetUserEmail, typeof m.access_role === 'string' ? m.access_role : null].filter(Boolean).join(' · ') || null;
      case 'revoke_operator':
      case 'unassign_operator_account':
        return e.targetUserEmail;
      case 'create_workspace':
        return typeof m.name === 'string' ? m.name : null;
      default:
        return null;
    }
  }

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {state.kind === 'loading' ? (
        <div className="flex items-center justify-center gap-2 p-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span>{t('loading')}</span>
        </div>
      ) : state.kind === 'error' ? (
        <div className="flex flex-col items-center gap-3 p-12 text-center" role="alert">
          <AlertTriangle className="size-8 text-destructive" />
          <p className="text-sm text-destructive">
            {state.code === 'unauthorized' ? t('unauthorized') : t('load_failed')}
          </p>
          {state.code !== 'unauthorized' && (
            <Button variant="outline" size="sm" onClick={loadFirst}>
              {t('retry')}
            </Button>
          )}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-12 text-center">
          <History className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">{t('col_when')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('col_action')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('col_actor')}</TableHead>
                  <TableHead className="hidden text-muted-foreground md:table-cell">{t('col_detail')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={e.id} className="border-border">
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {stamp(e.createdAt)}
                    </TableCell>
                    <TableCell className="text-foreground">{actionLabel(e.action)}</TableCell>
                    <TableCell className="text-sm text-foreground">{actorLabel(e)}</TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {detail(e) ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col items-center gap-2">
            {moreFailed && (
              <p className="text-sm text-destructive" role="alert">
                {t('load_more_failed')}
              </p>
            )}
            {cursor ? (
              <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t('loading_more') : t('load_more')}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t('end_of_trail', { count: entries.length })}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
