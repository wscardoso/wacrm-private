import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  onSearchChange,
  onToggleTag,
  onTenantChange,
  totalPagesFrom,
  loadList,
  loadTags,
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
    const next = onSearchChange(
      { search: 'old', page: 3, selectedTagIds: ['t1'] },
      'new',
    )
    expect(next).toEqual({ search: 'new', page: 0, selectedTagIds: ['t1'] })
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

describe('P2.1 Lote 2 — loadList uses the query layer correctly', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes activeAccountId and the right args to listContacts', async () => {
    listContactsMock.mockResolvedValue({
      contacts: [{ id: 'c1', tags: [] } as never],
      totalCount: 1,
    })
    const res = await loadList({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '  bob  ',
      selectedTagIds: ['t1', 't2'],
      page: 1,
      pageSize: PAGE_SIZE,
      seq: 1,
      latestSeq: () => 1,
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

  it('returns null when superseded by a newer fetch (late response guard)', async () => {
    listContactsMock.mockResolvedValue({
      contacts: [{ id: 'stale', tags: [] } as never],
      totalCount: 9,
    })
    const res = await loadList({
      supabase: {} as SupabaseClient,
      accountId: 'accA',
      search: '',
      selectedTagIds: [],
      page: 0,
      pageSize: PAGE_SIZE,
      seq: 1,
      // a newer fetch already claimed seq 2 before this resolved
      latestSeq: () => 2,
    })
    expect(res).toBeNull()
    expect(listContactsMock).toHaveBeenCalledTimes(1)
  })

  it('propagates listContacts errors to the caller', async () => {
    listContactsMock.mockRejectedValue(new Error('boom'))
    await expect(
      loadList({
        supabase: {} as SupabaseClient,
        accountId: 'accA',
        search: '',
        selectedTagIds: [],
        page: 0,
        pageSize: PAGE_SIZE,
        seq: 1,
        latestSeq: () => 1,
      }),
    ).rejects.toThrow('boom')
  })

  it('loadTags passes activeAccountId to listTags', async () => {
    listTagsMock.mockResolvedValue([{ id: 't1', name: 'VIP' } as never])
    const tags = await loadTags({} as SupabaseClient, 'accA')
    expect(listTagsMock).toHaveBeenCalledTimes(1)
    expect(listTagsMock.mock.calls[0][0]).toEqual({})
    expect(listTagsMock.mock.calls[0][1]).toBe('accA')
    expect(tags).toEqual([{ id: 't1', name: 'VIP' }])
  })

  it('loadTags propagates listTags errors', async () => {
    listTagsMock.mockRejectedValue(new Error('tags-down'))
    await expect(loadTags({} as SupabaseClient, 'accA')).rejects.toThrow(
      'tags-down',
    )
  })
})
