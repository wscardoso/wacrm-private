import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  onSearchChange,
  onToggleTag,
  onTenantChange,
  totalPagesFrom,
  createContactsLoader,
  createTagsLoader,
  PAGE_SIZE,
} from './list-state'
import { listContacts, listTags } from './queries'

// Mock the query layer so we test only the orchestration logic in
// list-state (argument construction, sequencing, tenant isolation). These
// mocks assert HOW list-state calls the public query functions — they do
// NOT validate PostgREST relationship resolution (no real PostgREST here).
vi.mock('./queries', () => ({
  listContacts: vi.fn(),
  listTags: vi.fn(),
}))

const listContactsMock = vi.mocked(listContacts)
const listTagsMock = vi.mocked(listTags)

describe('P2.1 Lote 2 — list-state pure controllers', () => {
  it('onSearchChange resets page to 0 and keeps tags', () => {
    expect(
      onSearchChange({ search: 'old', page: 3, selectedTagIds: ['t1'] }, 'new'),
    ).toEqual({ search: 'new', page: 0, selectedTagIds: ['t1'] })
  })

  it('onToggleTag adds then removes a tag and resets page to 0', () => {
    const added = onToggleTag({ search: '', page: 2, selectedTagIds: [] }, 't1')
    expect(added).toEqual({ search: '', page: 0, selectedTagIds: ['t1'] })
    const removed = onToggleTag(added, 't1')
    expect(removed).toEqual({ search: '', page: 0, selectedTagIds: [] })
  })

  it('onTenantChange wipes search, page and selected tags', () => {
    expect(onTenantChange()).toEqual({ search: '', page: 0, selectedTagIds: [] })
  })

  it('totalPagesFrom derives pages from the server count, not array length', () => {
    expect(totalPagesFrom(0)).toBe(0)
    expect(totalPagesFrom(25)).toBe(1)
    expect(totalPagesFrom(26)).toBe(2)
    expect(totalPagesFrom(50, 10)).toBe(5)
  })
})

describe('P2.1 Lote 2 — loaders: independent sequence guards', () => {
  beforeEach(() => vi.clearAllMocks())

  it('contacts loader passes accountId/search/tagIds/page/pageSize to listContacts', async () => {
    listContactsMock.mockResolvedValue({
      contacts: [{ id: 'c1', tags: [] } as never],
      totalCount: 1,
    })
    const loader = createContactsLoader()
    const res = await loader.load({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '  bob  ',
      selectedTagIds: ['t1', 't2'],
      page: 1,
      pageSize: PAGE_SIZE,
    })
    expect(listContactsMock).toHaveBeenCalledTimes(1)
    const call = listContactsMock.mock.calls[0]
    expect(call[0]).toEqual({})
    expect(call[1]).toBe('accA')
    expect(call[2]).toEqual({
      search: 'bob',
      tagIds: ['t1', 't2'],
      page: 1,
      pageSize: PAGE_SIZE,
    })
    expect(res).toEqual({ contacts: [{ id: 'c1', tags: [] } as never], totalCount: 1 })
  })

  it('tags loader passes accountId to listTags', async () => {
    listTagsMock.mockResolvedValue([{ id: 't1', name: 'VIP' } as never])
    const loader = createTagsLoader()
    const tags = await loader.load({ supabase: {} as SupabaseClient, accountId: 'accA' })
    expect(listTagsMock).toHaveBeenCalledTimes(1)
    expect(listTagsMock.mock.calls[0][0]).toEqual({})
    expect(listTagsMock.mock.calls[0][1]).toBe('accA')
    expect(tags).toEqual([{ id: 't1', name: 'VIP' } as never])
  })

  it('a newer loadList invalidates the previous contacts response only', async () => {
    let resolveFirst!: (v: unknown) => void
    const first = new Promise((r) => (resolveFirst = r))
    listContactsMock
      .mockReturnValueOnce(first as never)
      .mockResolvedValueOnce({ contacts: [{ id: 'c2', tags: [] } as never], totalCount: 1 })

    const loader = createContactsLoader()
    const p1 = loader.load({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '',
      selectedTagIds: [],
      page: 0,
      pageSize: PAGE_SIZE,
    })
    const p2 = loader.load({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '',
      selectedTagIds: [],
      page: 1,
      pageSize: PAGE_SIZE,
    })

    resolveFirst({ contacts: [{ id: 'stale', tags: [] } as never], totalCount: 9 })
    const [r1, r2] = await Promise.all([p1, p2])

    // The older contacts response is discarded; the newer one wins.
    expect(r1).toBeNull()
    expect(r2).toEqual({ contacts: [{ id: 'c2', tags: [] } as never], totalCount: 1 })
  })

  it('a newer loadTags invalidates the previous tags response only', async () => {
    let resolveFirst!: (v: unknown) => void
    const first = new Promise((r) => (resolveFirst = r))
    listTagsMock
      .mockReturnValueOnce(first as never)
      .mockResolvedValueOnce([{ id: 't2', name: 'New' } as never])

    const loader = createTagsLoader()
    const p1 = loader.load({ supabase: {} as SupabaseClient, accountId: 'accA' })
    const p2 = loader.load({ supabase: {} as SupabaseClient, accountId: 'accA' })

    resolveFirst([{ id: 't1', name: 'Old' } as never])
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toBeNull()
    expect(r2).toEqual([{ id: 't2', name: 'New' } as never])
  })

  it('a contacts load does NOT invalidate a pending tags load', async () => {
    let resolveContacts!: (v: unknown) => void
    let resolveTags!: (v: unknown) => void
    const contactsP = new Promise((r) => (resolveContacts = r))
    const tagsP = new Promise((r) => (resolveTags = r))
    listContactsMock.mockReturnValueOnce(contactsP as never)
    listTagsMock.mockReturnValueOnce(tagsP as never)

    const cLoader = createContactsLoader()
    const tLoader = createTagsLoader()
    const cp = cLoader.load({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '',
      selectedTagIds: [],
      page: 0,
      pageSize: PAGE_SIZE,
    })
    const tp = tLoader.load({ supabase: {} as SupabaseClient, accountId: 'accA' })

    // Fire a SECOND contacts load — should only bump the contacts sequence.
    cLoader.load({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '',
      selectedTagIds: [],
      page: 1,
      pageSize: PAGE_SIZE,
    }).catch(() => {})

    resolveContacts({ contacts: [{ id: 'c2', tags: [] } as never], totalCount: 1 })
    resolveTags([{ id: 't1', name: 'Old' } as never])

    const [cr, tr] = await Promise.all([cp, tp])
    // Contacts r1 discarded (superseded by contacts r2); tags still valid.
    expect(cr).toBeNull()
    expect(tr).toEqual([{ id: 't1', name: 'Old' } as never])
  })

  it('a tags load does NOT invalidate a pending contacts load', async () => {
    let resolveContacts!: (v: unknown) => void
    let resolveTags!: (v: unknown) => void
    const contactsP = new Promise((r) => (resolveContacts = r))
    const tagsP = new Promise((r) => (resolveTags = r))
    listContactsMock.mockReturnValueOnce(contactsP as never)
    listTagsMock.mockReturnValueOnce(tagsP as never)

    const cLoader = createContactsLoader()
    const tLoader = createTagsLoader()
    const cp = cLoader.load({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '',
      selectedTagIds: [],
      page: 0,
      pageSize: PAGE_SIZE,
    })
    const tp = tLoader.load({ supabase: {} as SupabaseClient, accountId: 'accA' })

    // Fire a SECOND tags load — should only bump the tags sequence.
    tLoader.load({ supabase: {} as SupabaseClient, accountId: 'accA' }).catch(() => {})

    resolveContacts({ contacts: [{ id: 'c1', tags: [] } as never], totalCount: 1 })
    resolveTags([{ id: 't2', name: 'New' } as never])

    const [cr, tr] = await Promise.all([cp, tp])
    // Tags r1 discarded (superseded by tags r2); contacts still valid.
    expect(tr).toBeNull()
    expect(cr).toEqual({ contacts: [{ id: 'c1', tags: [] } as never], totalCount: 1 })
  })

  it('tenant switch (reset) invalidates a pending contacts response from the old tenant', async () => {
    let resolveFirst!: (v: unknown) => void
    const first = new Promise((r) => (resolveFirst = r))
    listContactsMock.mockReturnValueOnce(first as never)

    const loader = createContactsLoader()
    const p1 = loader.load({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: 'old',
      selectedTagIds: ['t1'],
      page: 3,
      pageSize: PAGE_SIZE,
    })

    // Tenant switch -> reset() bumps the contacts sequence.
    loader.reset()

    resolveFirst({ contacts: [{ id: 'stale', tags: [] } as never], totalCount: 9 })
    const r1 = await p1
    expect(r1).toBeNull()
  })

  it('tenant switch (reset) invalidates a pending tags response from the old tenant', async () => {
    let resolveFirst!: (v: unknown) => void
    const first = new Promise((r) => (resolveFirst = r))
    listTagsMock.mockReturnValueOnce(first as never)

    const loader = createTagsLoader()
    const p1 = loader.load({ supabase: {} as SupabaseClient, accountId: 'accA' })

    loader.reset()

    resolveFirst([{ id: 't1', name: 'Old' } as never])
    const r1 = await p1
    expect(r1).toBeNull()
  })

  it('propagates listContacts errors to the caller', async () => {
    listContactsMock.mockRejectedValue(new Error('boom'))
    const loader = createContactsLoader()
    await expect(
      loader.load({
        supabase: {} as SupabaseClient,
        accountId: 'accA',
        search: '',
        selectedTagIds: [],
        page: 0,
        pageSize: PAGE_SIZE,
      }),
    ).rejects.toThrow('boom')
  })

  it('propagates listTags errors to the caller', async () => {
    listTagsMock.mockRejectedValue(new Error('tags-down'))
    const loader = createTagsLoader()
    await expect(
      loader.load({ supabase: {} as SupabaseClient, accountId: 'accA' }),
    ).rejects.toThrow('tags-down')
  })
})
