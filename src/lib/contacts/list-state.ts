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

/**
 * Loaders with INDEPENDENT sequence guards.
 *
 * The contacts loader and the tags loader each own their own monotonic
 * sequence counter. Bumping one flow's sequence never invalidates a pending
 * response of the other flow — a contacts page change must not cancel a
 * still-in-flight tags load, and a tags reload must not cancel a contacts
 * load. A tenant switch calls `reset()` on BOTH loaders so any pending
 * response from the previous tenant is discarded in both flows.
 *
 * The loader returns `null` when its own sequence was superseded, so the
 * caller knows NOT to commit a stale result. This is the same protection the
 * dashboard page uses — a plain `cancelled` boolean would be weaker because it
 * can't represent concurrent overlapping fetches within a single flow.
 */
export interface ContactsLoader {
  reset(): void
  load(params: {
    supabase: ReturnType<typeof createClient>
    accountId: string
    search: string
    selectedTagIds: string[]
    page: number
    pageSize: number
  }): Promise<{ contacts: ContactWithTags[]; totalCount: number } | null>
}

export interface TagsLoader {
  reset(): void
  load(params: {
    supabase: ReturnType<typeof createClient>
    accountId: string
  }): Promise<Tag[] | null>
}

export function createContactsLoader(): ContactsLoader {
  let seq = 0
  return {
    reset() {
      seq++
    },
    async load({ supabase, accountId, search, selectedTagIds, page, pageSize }) {
      const my = ++seq
      const result = await listContacts(supabase, accountId, {
        search: search.trim() || undefined,
        tagIds: selectedTagIds,
        page,
        pageSize,
      })
      if (my !== seq) return null
      return { contacts: result.contacts, totalCount: result.totalCount }
    },
  }
}

export function createTagsLoader(): TagsLoader {
  let seq = 0
  return {
    reset() {
      seq++
    },
    async load({ supabase, accountId }) {
      const my = ++seq
      const tags = await listTags(supabase, accountId)
      if (my !== seq) return null
      return tags
    },
  }
}
