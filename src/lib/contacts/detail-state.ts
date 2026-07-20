import { createClient } from '@/lib/supabase/client'
import {
  getContactById,
  listContactTags,
  listContactNotes,
  listContactCustomValues,
  listCustomFields,
  listContactDeals,
  getContactAttribution,
} from '@/lib/contacts/queries'
import type {
  Contact,
  Tag,
  ContactNote,
  CustomField,
  Deal,
  LeadAttribution,
} from '@/types'

/**
 * Pure controllers + loader for the Platform Contact DETAIL local state.
 *
 * Kept free of React so the sequencing/reset rules can be unit-tested in a
 * plain node runtime (no DOM/React), exactly like `list-state.ts`. The detail
 * loader owns its OWN monotonic sequence — independent of the list's contacts
 * and tags loaders — so a still-in-flight detail fetch for tenant A can never
 * overwrite the detail Sheet after the operator switches to tenant B or
 * selects a different contact.
 *
 * Tenant scoping is defense-in-depth over RLS: `getContactById` filters by the
 * explicit `accountId`, so a `contactId` from another supervised tenant
 * resolves to `null` here — never another tenant's data. The caller renders a
 * "not found" state for that case.
 */

// ------------------------------------------------------------
// Selection state (pure, React-free)
// ------------------------------------------------------------

export interface DetailSelectionState {
  selectedContactId: string | null
  open: boolean
}

export const initialDetailSelection: DetailSelectionState = {
  selectedContactId: null,
  open: false,
}

/** Open the detail Sheet for a contact row. */
export function onSelectContact(contactId: string): DetailSelectionState {
  return { selectedContactId: contactId, open: true }
}

/** Explicit close (user dismissed the Sheet). */
export function onCloseDetail(): DetailSelectionState {
  return { selectedContactId: null, open: false }
}

/**
 * Tenant switch — the Sheet must close and the selection must be wiped so a
 * contact of tenant A is never shown (or refetched) under tenant B. Callers
 * must also `reset()` the detail loader in the same flow.
 */
export function onTenantChangeDetail(): DetailSelectionState {
  return { selectedContactId: null, open: false }
}

// ------------------------------------------------------------
// Detail loader (independent sequence guard)
// ------------------------------------------------------------

export interface ContactDetailData {
  contact: Contact
  tags: Tag[]
  notes: ContactNote[]
  customFields: CustomField[]
  /** custom_field_id -> value */
  customValues: Record<string, string>
  deals: Deal[]
  /** null when the contact has no first-touch attribution — a NORMAL state. */
  attribution: LeadAttribution | null
}

export type ContactDetailResult =
  | { status: 'found'; data: ContactDetailData }
  | { status: 'not_found' }

export interface ContactDetailLoader {
  reset(): void
  load(params: {
    supabase: ReturnType<typeof createClient>
    accountId: string
    contactId: string
  }): Promise<ContactDetailResult | null>
}

export function createContactDetailLoader(): ContactDetailLoader {
  let seq = 0
  return {
    reset() {
      seq++
    },
    async load({ supabase, accountId, contactId }) {
      const my = ++seq

      // The contact fetch is the security gate: getContactById filters by the
      // explicit accountId, so a contactId from another tenant resolves to
      // null → not_found (never another tenant's row).
      const contact = await getContactById(supabase, accountId, contactId)
      if (my !== seq) return null // superseded during the contact fetch
      if (!contact) return { status: 'not_found' }

      // Dependent reads — all account-scoped via queries.ts. Attribution is a
      // secondary, optional fetch: absence of first_attribution_id is normal.
      const [tags, notes, customFields, customValues, deals] = await Promise.all([
        listContactTags(supabase, accountId, contactId),
        listContactNotes(supabase, accountId, contactId),
        listCustomFields(supabase, accountId),
        listContactCustomValues(supabase, accountId, contactId),
        listContactDeals(supabase, accountId, contactId),
      ])
      const attribution = contact.first_attribution_id
        ? await getContactAttribution(supabase, accountId, contact.first_attribution_id)
        : null

      if (my !== seq) return null // superseded during the dependent fetches

      return {
        status: 'found',
        data: { contact, tags, notes, customFields, customValues, deals, attribution },
      }
    },
  }
}
