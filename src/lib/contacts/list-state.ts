import { createClient } from '@/lib/supabase/client'
import {
  listContacts,
  listTags,
  type ContactWithTags,
} from '@/lib/contacts/queries'
import type { Tag } from '@/types'

export const PAGE_SIZE = 25

/**
 * Pure controllers for the Platform Contacts list local state.
 *
 * Kept free of React so they can be unit-tested without a DOM/React
 * runtime. Each function returns the next slice of state given an
 * incoming event, mirroring the rules the page must follow:
 *   - search change resets page to 0
 *   - tag selection change resets page to 0
 *   - tenant (accountId) change resets page/search/selectedTagIds
 *   - totalPages derived from totalCount (never from the loaded array)
 */

export interface ListState {
  search: string
  page: number
  selectedTagIds: string[]
}

/** New search text -> reset page to 0 (preserve tags). */
export function onSearchChange(prev: ListState, search: string): ListState {
  return { ...prev, search, page: 0 }
}

/** Toggle a tag in/out of the selection -> reset page to 0. */
export function onToggleTag(prev: ListState, tagId: string): ListState {
  const selectedTagIds = prev.selectedTagIds.includes(tagId)
    ? prev.selectedTagIds.filter((id) => id !== tagId)
    : [...prev.selectedTagIds, tagId]
  return { ...prev, selectedTagIds, page: 0 }
}

/** Tenant switch -> wipe local filters so A never bleeds into B. */
export function onTenantChange(): ListState {
  return { search: '', page: 0, selectedTagIds: [] }
}

/** Total pages from the authoritative server count. */
export function totalPagesFrom(totalCount: number, pageSize = PAGE_SIZE): number {
  return Math.ceil(totalCount / pageSize)
}

export interface LoadListParams {
  supabase: ReturnType<typeof createClient>
  accountId: string
  search: string
  selectedTagIds: string[]
  page: number
  pageSize: number
  seq: number
  latestSeq: () => number
}

export interface LoadListResult {
  contacts: ContactWithTags[]
  totalCount: number
}

/**
 * Runs listContacts, honoring the fetchSeq guard. The caller owns the
 * `seq`/`latestSeq` pair; the function returns null when superseded so the
 * caller knows NOT to commit the (now stale) result. This is the same
 * protection the dashboard page uses — a plain `cancelled` boolean would be
 * weaker because it can't represent concurrent overlapping fetches.
 */
export async function loadList(
  params: LoadListParams,
): Promise<LoadListResult | null> {
  const { supabase, accountId, search, selectedTagIds, page, pageSize, seq, latestSeq } =
    params

  const result = await listContacts(supabase, accountId, {
    search: search.trim() || undefined,
    tagIds: selectedTagIds,
    page,
    pageSize,
  })

  // A newer fetch started while we awaited — discard this response.
  if (seq !== latestSeq()) return null

  return { contacts: result.contacts, totalCount: result.totalCount }
}

export async function loadTags(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
): Promise<Tag[]> {
  return listTags(supabase, accountId)
}
