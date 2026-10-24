'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { usePlatformContext } from '@/hooks/use-platform-context';
import { type ContactWithTags } from '@/lib/contacts/queries';
import {
  PAGE_SIZE,
  onSearchChange,
  onToggleTag,
  onTenantChange,
  totalPagesFrom,
  createContactsLoader,
  createTagsLoader,
} from '@/lib/contacts/list-state';
import {
  onSelectContact,
  onCloseDetail,
  onTenantChangeDetail,
  initialDetailSelection,
} from '@/lib/contacts/detail-state';
import { PlatformContactDetailView } from '@/components/contacts/platform-contact-detail-view';
import type { Tag } from '@/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Search,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  AlertTriangle,
} from 'lucide-react';

// Platform read-only Contacts list. Tenant is taken exclusively from the
// already-validated platform context (the /act layout re-derived the
// operator's authorization server-side). No writes, no auth resolution, no
// detail/form/import components are wired here.
//
// All data loading is delegated to the reusable loaders in list-state.ts,
// which own INDEPENDENT sequence guards for the contacts and tags flows. A
// contacts page/filter change never cancels a pending tags load, and vice
// versa. Switching tenants calls reset() on both loaders so any response from
// the previous tenant is discarded, and the first contact fetch after a
// switch uses the reset (empty) filters so no stale-filter query is sent.
export default function PlatformContactsPage() {
  const t = useTranslations('act.contacts');
  const { activeAccountId } = usePlatformContext();
  const supabase = createClient();

  const contactsLoader = useRef(createContactsLoader());
  const tagsLoader = useRef(createTagsLoader());

  // The tenant the last fetch actually used. When it changes, the very next
  // contact fetch must run with reset (empty) filters instead of the state
  // still belonging to the previous tenant — this avoids a redundant first
  // query carrying stale filters.
  const appliedAccountRef = useRef<string | null>(activeAccountId);

  const [contacts, setContacts] = useState<ContactWithTags[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const [tags, setTags] = useState<Tag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState<string | null>(null);

  // Read-only detail Sheet selection. The detail loader lives inside
  // PlatformContactDetailView (own independent sequence guard); here we only
  // own which contact is selected and whether the Sheet is open.
  const [detail, setDetail] = useState(initialDetailSelection);

  const fetchTags = useCallback(async () => {
    if (!activeAccountId) return;
    setTagsLoading(true);
    setTagsError(null);
    try {
      const tagsResult = await tagsLoader.current.load({
        supabase,
        accountId: activeAccountId,
      });
      if (tagsResult === null) return; // superseded (tenant switch / newer load)
      setTags(tagsResult);
    } catch (err) {
      console.error('[act contacts] tags load failed:', err);
      setTagsError('load_failed');
    }
    setTagsLoading(false);
  }, [supabase, activeAccountId]);

  const fetchContacts = useCallback(async () => {
    if (!activeAccountId) return;
    setLoading(true);
    setError(null);

    // On tenant switch, the local filter state still belongs to the previous
    // tenant for this first render. Use the reset defaults so we never send a
    // query carrying the old tenant's search/tags/page.
    const tenantChanged = appliedAccountRef.current !== activeAccountId;
    const effective = tenantChanged ? onTenantChange() : { search, selectedTagIds, page };
    if (tenantChanged) {
      appliedAccountRef.current = activeAccountId;
      // Also discard any pending tags response from the previous tenant.
      tagsLoader.current.reset();
    }

    try {
      const result = await contactsLoader.current.load({
        supabase,
        accountId: activeAccountId,
        search: effective.search,
        selectedTagIds: effective.selectedTagIds,
        page: effective.page,
        pageSize: PAGE_SIZE,
      });
      if (result === null) return; // superseded by a newer contacts fetch

      setContacts(result.contacts);
      setTotalCount(result.totalCount);
    } catch (err) {
      // A failed load is shown as an error, never as an empty list.
      console.error('[act contacts] contacts load failed:', err);
      setError('load_failed');
    }
    setLoading(false);
  }, [supabase, activeAccountId, search, selectedTagIds, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  // Tenant switch: wipe local UI filters so list A is replaced by list B and
  // never merged, and reset the contacts loader so the stale-filter fetch
  // (already guarded in fetchContacts) is also discarded if it somehow races.
  useEffect(() => {
    if (appliedAccountRef.current === activeAccountId) return;
    contactsLoader.current.reset();
    const reset = onTenantChange();
    setSearch(reset.search);
    setPage(reset.page);
    setSelectedTagIds(reset.selectedTagIds);
    // Tenant switch: close the detail Sheet and wipe the selection so a
    // contact of the previous tenant is never shown (or refetched) under the
    // new one. The Sheet's own loader is reset inside the component when its
    // contactId/activeAccountId change to null.
    setDetail(onTenantChangeDetail());
    appliedAccountRef.current = activeAccountId;
    // Re-fetch now that filters are clean. fetchContacts is keyed on these
    // values, so it will also run; the guard above ensures the earlier stale
    // fetch is discarded.
  }, [activeAccountId]);

  const totalPages = totalPagesFrom(totalCount);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0;

  function handleSearchChange(value: string) {
    const next = onSearchChange({ search, page, selectedTagIds }, value);
    setSearch(next.search);
    setPage(next.page);
  }

  function toggleTag(tagId: string) {
    const next = onToggleTag({ search, page, selectedTagIds }, tagId);
    setSelectedTagIds(next.selectedTagIds);
    setPage(next.page);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  const allTags = [...tags].sort((a, b) => a.name.localeCompare(b.name));
  const tagsMap = new Map(tags.map((t) => [t.id, t]));

  return (
    <div className="mx-auto w-full max-w-screen-xl space-y-6 p-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('read_only')}{' '}
          {totalCount > 0 && t('count', { count: totalCount })}
        </p>
      </div>

      {/* Search + tag filter */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t('search_placeholder')}
              className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                />
              }
            >
              <Filter className="size-4" />
              {t('filter_by_tags')}
              {selectedTagIds.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {selectedTagIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-sm font-medium text-popover-foreground">
                  {t('filter_by_tags')}
                </span>
                {selectedTagIds.length > 0 && (
                  <button
                    onClick={clearTagFilters}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('clear')}
                  </button>
                )}
              </div>
              {tagsError ? (
                <p className="px-3 py-4 text-sm text-destructive text-center">
                  {t('tags_load_failed')}
                </p>
              ) : tagsLoading ? (
                <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {t('tags_loading')}
                </p>
              ) : allTags.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {t('tags_empty')}
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {allTags.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={selectedTagIds.includes(tag.id)}
                        onCheckedChange={() => toggleTag(tag.id)}
                        aria-label={t('filter_by_tag', { name: tag.name })}
                      />
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color ?? '#888' }}
                      />
                      <span className="text-sm text-popover-foreground truncate">
                        {tag.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Active tag-filter chips */}
        {selectedTagIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedTagIds.map((id) => {
              const tag = tagsMap.get(id);
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: (tag.color ?? '#888') + '20',
                    color: tag.color ?? '#888',
                  }}
                >
                  {tag.name}
                  <button
                    onClick={() => toggleTag(id)}
                    aria-label={t('remove_tag_filter', { name: tag.name })}
                    className="hover:opacity-70"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={clearTagFilters}
              className="text-xs text-muted-foreground hover:text-foreground px-1"
            >
              {t('clear')}
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t('col_name')}</TableHead>
              <TableHead className="text-muted-foreground">{t('col_phone')}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t('col_email')}</TableHead>
              <TableHead className="text-muted-foreground hidden md:table-cell">{t('col_tags')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={4} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow className="border-border">
                <TableCell colSpan={4} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <AlertTriangle className="size-8 text-destructive" />
                    <p className="text-sm text-destructive">{t('load_failed')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : contacts.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={4} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? t('empty_filtered')
                        : t('empty')}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow
                  key={contact.id}
                  onClick={() => setDetail(onSelectContact(contact.id))}
                  className="border-border hover:bg-muted/50 cursor-pointer"
                >
                  <TableCell className="text-foreground font-medium">
                    {contact.name || (
                      <span className="text-muted-foreground italic">{t('unnamed')}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {contact.phone}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell text-sm">
                    {contact.email || <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {contact.tags.length > 0 ? (
                        contact.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: (tag.color ?? '#888') + '20',
                              color: tag.color ?? '#888',
                            }}
                          >
                            {tag.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                      {contact.tags.length > 3 && (
                        <span className="text-[10px] text-muted-foreground">
                          +{contact.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('showing', {
              from: page * PAGE_SIZE + 1,
              to: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-xs text-muted-foreground px-2">
              {t('page_of', { page: page + 1, pages: totalPages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Read-only detail Sheet. Tenant is resolved inside the component from
          usePlatformContext().activeAccountId — the sole tenant source. */}
      <PlatformContactDetailView
        open={detail.open}
        contactId={detail.selectedContactId}
        onOpenChange={(open) => {
          if (!open) setDetail(onCloseDetail());
        }}
      />
    </div>
  );
}
