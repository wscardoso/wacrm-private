import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Contact,
  Tag,
  ContactNote,
  CustomField,
  Deal,
  LeadAttribution,
} from '@/types'

/**
 * Contact with its resolved tags attached. The tags array is always
 * present (possibly empty) on the public result of `listContacts`, so
 * callers never need a separate nullable check.
 *
 * Mirrors the local `ContactWithTags` type used by the dashboard
 * Contacts page (`src/app/(dashboard)/contacts/page.tsx`); redeclared
 * here so the query layer is self-contained and does not depend on a
 * component-local interface.
 */
export interface ContactWithTags extends Contact {
  tags: Tag[]
}

/**
 * Thrown synchronously when a public read function is invoked without a
 * resolved `accountId`. The query layer is stateless and never derives a
 * tenant from the session — the caller (member context or platform
 * context) must pass an already-resolved `accountId`. We fail fast rather
 * than mounting a tenant-less query that would rely solely on RLS (which
 * for a multi-tenant platform operator returns the UNION of every
 * supervised tenant).
 */
class MissingAccountIdError extends Error {
  constructor(fn: string) {
    super(`${fn} requires a non-empty accountId; received empty/undefined`)
    this.name = 'MissingAccountIdError'
  }
}

function assertAccountId(accountId: string): asserts accountId is string {
  if (!accountId || typeof accountId !== 'string') {
    throw new MissingAccountIdError('contacts query')
  }
}

/**
 * Reads for the Contacts domain (P2.1 read-only surface).
 *
 * Architectural contract (frozen):
 *   - A single query layer. No `queryMemberContacts` / `queryPlatformContacts`
 *     split, no optional/variant accountId.
 *   - Every public read takes `accountId: string` (never optional/null) and
 *     scopes the query to it. The layer is stateless: no cache, no React
 *     context, no auth, no platform-context resolution, no authorization.
 *   - RLS remains the security boundary. accountId is defense-in-depth that
 *     also produces the correct single-tenant count/page.
 *   - No writes, no service_role, no policy/migration changes.
 */

export interface ListContactsOptions {
  search?: string
  tagIds?: string[]
  page: number
  pageSize: number
}

export interface ListContactsResult {
  contacts: ContactWithTags[]
  totalCount: number
}

export async function listContacts(
  supabase: SupabaseClient,
  accountId: string,
  options: ListContactsOptions,
): Promise<ListContactsResult> {
  assertAccountId(accountId)

  const { search, tagIds, page, pageSize } = options
  const term = search?.trim() || null
  const from = page * pageSize
  const to = from + pageSize - 1

  let contactRows: Contact[]
  let totalCount: number

  if (tagIds && tagIds.length > 0) {
    // Server-side tag resolution (join + distinct + windowed total +
    // pagination). The RPC MUST always receive p_account_id from this
    // layer — never call it without explicit tenant scope.
    const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
      p_tag_ids: tagIds,
      p_search: term,
      p_limit: pageSize,
      p_offset: from,
      p_account_id: accountId,
    })
    if (error) throw error
    const rows = (data ?? []) as { contact: Contact; total_count: number }[]
    contactRows = rows.map((r) => r.contact)
    totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0
  } else {
    let query = supabase
      .from('contacts')
      .select('*', { count: 'exact' })
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .range(from, to)

    if (term) {
      const like = `%${term}%`
      query = query.or(
        `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`,
      )
    }

    const { data, count, error } = await query
    if (error) throw error
    contactRows = (data ?? []) as Contact[]
    totalCount = count ?? 0
  }

  // Resolve tags for the returned contacts in a single batch query. Never
  // one query per contact.
  const contacts: ContactWithTags[] =
    contactRows.length === 0
      ? []
      : await attachTags(supabase, accountId, contactRows)

  return { contacts, totalCount }
}

async function attachTags(
  supabase: SupabaseClient,
  accountId: string,
  contactRows: Contact[],
): Promise<ContactWithTags[]> {
  const contactIds = contactRows.map((c) => c.id)

  const { data: contactTags, error } = await supabase
    .from('contact_tags')
    .select('contact_id, tag_id')
    .in('contact_id', contactIds)

  if (error) throw error

  // Build a per-contact list of tag_ids.
  const tagIdsByContact = new Map<string, string[]>()
  for (const ct of contactTags ?? []) {
    const list = tagIdsByContact.get(ct.contact_id) ?? []
    list.push(ct.tag_id)
    tagIdsByContact.set(ct.contact_id, list)
  }

  // Load the distinct tags in one query (scoped by account).
  const allTagIds = [...new Set((contactTags ?? []).map((ct) => ct.tag_id))]
  const tagsById = new Map<string, Tag>()
  if (allTagIds.length > 0) {
    const { data: tags, error: tagErr } = await supabase
      .from('tags')
      .select('*')
      .in('id', allTagIds)
      .eq('account_id', accountId)
    if (tagErr) throw tagErr
    for (const t of tags ?? []) tagsById.set(t.id, t)
  }

  return contactRows.map((c) => ({
    ...c,
    tags: (tagIdsByContact.get(c.id) ?? [])
      .map((tid) => tagsById.get(tid))
      .filter((t): t is Tag => Boolean(t)),
  }))
}

export async function getContactById(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<Contact | null> {
  assertAccountId(accountId)

  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  return (data as Contact | null) ?? null
}

export async function listContactTags(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<Tag[]> {
  assertAccountId(accountId)

  // contact_tags has no account_id of its own — validate the parent tenant
  // via an inner join to contacts in the same query.
  const { data, error } = await supabase
    .from('contact_tags')
    .select('tag:tags!inner(*), contact:contacts!inner(account_id)')
    .eq('contact_id', contactId)
    .eq('contact.account_id', accountId)

  if (error) throw error

  // PostgREST returns the embedded `tags!inner` relation as an array;
  // pick the first element (there is exactly one tag per contact_tag row).
  const tags = (data ?? []).flatMap((row: { tag: Tag[] | Tag }) =>
    Array.isArray(row.tag) ? row.tag : [row.tag],
  )
  return tags
}

export async function listContactNotes(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<ContactNote[]> {
  assertAccountId(accountId)

  const { data, error } = await supabase
    .from('contact_notes')
    .select('*')
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as ContactNote[]
}

export async function listContactCustomValues(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<Record<string, string>> {
  assertAccountId(accountId)

  // contact_custom_values has no account_id of its own — validate the
  // parent tenant via an inner join to contacts in the same query.
  const { data, error } = await supabase
    .from('contact_custom_values')
    .select('custom_field_id, value, contact:contacts!inner(account_id)')
    .eq('contact_id', contactId)
    .eq('contact.account_id', accountId)

  if (error) throw error

  const result: Record<string, string> = {}
  for (const row of data ?? []) {
    if (row.custom_field_id && row.value != null) {
      result[row.custom_field_id] = row.value
    }
  }
  return result
}

export async function listContactDeals(
  supabase: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<Deal[]> {
  assertAccountId(accountId)

  const { data, error } = await supabase
    .from('deals')
    .select('*, stage:pipeline_stages(*)')
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []) as Deal[]
}

export async function getContactAttribution(
  supabase: SupabaseClient,
  accountId: string,
  attributionId: string,
): Promise<LeadAttribution | null> {
  assertAccountId(accountId)

  const { data, error } = await supabase
    .from('lead_attributions')
    .select('*')
    .eq('id', attributionId)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  return (data as LeadAttribution | null) ?? null
}

export async function listTags(
  supabase: SupabaseClient,
  accountId: string,
): Promise<Tag[]> {
  assertAccountId(accountId)

  const { data, error } = await supabase
    .from('tags')
    .select('*')
    .eq('account_id', accountId)
    .order('name', { ascending: true })

  if (error) throw error
  return (data ?? []) as Tag[]
}

export async function listCustomFields(
  supabase: SupabaseClient,
  accountId: string,
): Promise<CustomField[]> {
  assertAccountId(accountId)

  const { data, error } = await supabase
    .from('custom_fields')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })

  if (error) throw error
  return (data ?? []) as CustomField[]
}
