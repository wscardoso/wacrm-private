import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  onSelectContact,
  onCloseDetail,
  onTenantChangeDetail,
  initialDetailSelection,
  createContactDetailLoader,
} from './detail-state'
import {
  getContactById,
  listContactTags,
  listContactNotes,
  listCustomFields,
  listContactCustomValues,
  listContactDeals,
  getContactAttribution,
} from './queries'

// Mock the query layer so we test only the orchestration logic in
// detail-state (argument construction, sequencing, tenant isolation, the
// optional attribution fetch). These mocks assert HOW detail-state calls the
// public query functions — they do NOT validate PostgREST behaviour.
vi.mock('./queries', () => ({
  getContactById: vi.fn(),
  listContactTags: vi.fn(),
  listContactNotes: vi.fn(),
  listCustomFields: vi.fn(),
  listContactCustomValues: vi.fn(),
  listContactDeals: vi.fn(),
  getContactAttribution: vi.fn(),
}))

const getContactByIdMock = vi.mocked(getContactById)
const listContactTagsMock = vi.mocked(listContactTags)
const listContactNotesMock = vi.mocked(listContactNotes)
const listCustomFieldsMock = vi.mocked(listCustomFields)
const listContactCustomValuesMock = vi.mocked(listContactCustomValues)
const listContactDealsMock = vi.mocked(listContactDeals)
const getContactAttributionMock = vi.mocked(getContactAttribution)

const supabase = {} as SupabaseClient

function primeDependents() {
  listContactTagsMock.mockResolvedValue([{ id: 't1', name: 'VIP' } as never])
  listContactNotesMock.mockResolvedValue([{ id: 'n1', note_text: 'hi' } as never])
  listCustomFieldsMock.mockResolvedValue([{ id: 'f1', field_name: 'CPF' } as never])
  listContactCustomValuesMock.mockResolvedValue({ f1: '123' })
  listContactDealsMock.mockResolvedValue([{ id: 'd1', title: 'Deal' } as never])
  getContactAttributionMock.mockResolvedValue({ id: 'a1', source_channel: 'ctwa_meta' } as never)
}

describe('P2.1 Lote 3 — detail-state pure selection controllers', () => {
  it('initialDetailSelection is closed with no selection', () => {
    expect(initialDetailSelection).toEqual({ selectedContactId: null, open: false })
  })

  it('onSelectContact opens the sheet for the chosen contact', () => {
    expect(onSelectContact('c1')).toEqual({ selectedContactId: 'c1', open: true })
  })

  it('onCloseDetail wipes selection and closes', () => {
    expect(onCloseDetail()).toEqual({ selectedContactId: null, open: false })
  })

  it('onTenantChangeDetail wipes selection and closes (no contact of A under B)', () => {
    expect(onTenantChangeDetail()).toEqual({ selectedContactId: null, open: false })
  })
})

describe('P2.1 Lote 3 — detail loader: independent sequence + tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads a contact and all its dependent data into one bundle', async () => {
    getContactByIdMock.mockResolvedValue({ id: 'c1', first_attribution_id: 'a1' } as never)
    primeDependents()

    const loader = createContactDetailLoader()
    const res = await loader.load({ supabase, accountId: 'accA', contactId: 'c1' })

    expect(res).toEqual({
      status: 'found',
      data: {
        contact: { id: 'c1', first_attribution_id: 'a1' },
        tags: [{ id: 't1', name: 'VIP' }],
        notes: [{ id: 'n1', note_text: 'hi' }],
        customFields: [{ id: 'f1', field_name: 'CPF' }],
        customValues: { f1: '123' },
        deals: [{ id: 'd1', title: 'Deal' }],
        attribution: { id: 'a1', source_channel: 'ctwa_meta' },
      },
    })
  })

  it('passes the active accountId (not any other source) to every query', async () => {
    getContactByIdMock.mockResolvedValue({ id: 'c1', first_attribution_id: 'a1' } as never)
    primeDependents()

    const loader = createContactDetailLoader()
    await loader.load({ supabase, accountId: 'accA', contactId: 'c1' })

    expect(getContactByIdMock.mock.calls[0][1]).toBe('accA')
    expect(getContactByIdMock.mock.calls[0][2]).toBe('c1')
    expect(listContactTagsMock.mock.calls[0][1]).toBe('accA')
    expect(listContactNotesMock.mock.calls[0][1]).toBe('accA')
    expect(listCustomFieldsMock.mock.calls[0][1]).toBe('accA')
    expect(listContactCustomValuesMock.mock.calls[0][1]).toBe('accA')
    expect(listContactDealsMock.mock.calls[0][1]).toBe('accA')
    expect(getContactAttributionMock.mock.calls[0][1]).toBe('accA')
    expect(getContactAttributionMock.mock.calls[0][2]).toBe('a1')
  })

  it('returns not_found when getContactById resolves null (cross-tenant / missing)', async () => {
    getContactByIdMock.mockResolvedValue(null)

    const loader = createContactDetailLoader()
    const res = await loader.load({ supabase, accountId: 'accA', contactId: 'other-tenant' })

    expect(res).toEqual({ status: 'not_found' })
    // No dependent data is fetched for a contact that isn't in this tenant.
    expect(listContactTagsMock).not.toHaveBeenCalled()
    expect(getContactAttributionMock).not.toHaveBeenCalled()
  })

  it('skips the attribution fetch when the contact has no first_attribution_id', async () => {
    getContactByIdMock.mockResolvedValue({ id: 'c1', first_attribution_id: null } as never)
    primeDependents()

    const loader = createContactDetailLoader()
    const res = await loader.load({ supabase, accountId: 'accA', contactId: 'c1' })

    expect(getContactAttributionMock).not.toHaveBeenCalled()
    expect(res).toEqual(
      expect.objectContaining({ status: 'found', data: expect.objectContaining({ attribution: null }) }),
    )
  })

  it('discards a late response when a newer load supersedes it', async () => {
    let resolveFirst!: (v: unknown) => void
    const first = new Promise((r) => (resolveFirst = r))
    getContactByIdMock
      .mockReturnValueOnce(first as never)
      .mockResolvedValueOnce({ id: 'c2', first_attribution_id: null } as never)
    primeDependents()

    const loader = createContactDetailLoader()
    const p1 = loader.load({ supabase, accountId: 'accA', contactId: 'c1' })
    const p2 = loader.load({ supabase, accountId: 'accA', contactId: 'c2' })

    resolveFirst({ id: 'stale', first_attribution_id: null })
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1).toBeNull() // superseded
    expect(r2).toEqual(
      expect.objectContaining({ status: 'found', data: expect.objectContaining({ contact: { id: 'c2', first_attribution_id: null } }) }),
    )
  })

  it('discards a pending response after reset() (tenant switch)', async () => {
    let resolveFirst!: (v: unknown) => void
    const first = new Promise((r) => (resolveFirst = r))
    getContactByIdMock.mockReturnValueOnce(first as never)
    primeDependents()

    const loader = createContactDetailLoader()
    const p1 = loader.load({ supabase, accountId: 'accA', contactId: 'c1' })

    // Tenant switch -> reset() bumps the detail sequence.
    loader.reset()

    resolveFirst({ id: 'stale', first_attribution_id: null })
    const r1 = await p1
    expect(r1).toBeNull()
  })

  it('propagates query errors to the caller', async () => {
    getContactByIdMock.mockRejectedValue(new Error('boom'))
    const loader = createContactDetailLoader()
    await expect(
      loader.load({ supabase, accountId: 'accA', contactId: 'c1' }),
    ).rejects.toThrow('boom')
  })

  it('a rejected getContactAttribution is non-fatal (attribution null, rest shown)', async () => {
    getContactByIdMock.mockResolvedValue({ id: 'c1', first_attribution_id: 'a1' } as never)
    primeDependents()
    // The secondary attribution fetch fails — must NOT reject the loader.
    getContactAttributionMock.mockRejectedValue(new Error('attribution-down'))

    const loader = createContactDetailLoader()
    const res = await loader.load({ supabase, accountId: 'accA', contactId: 'c1' })

    // Success state, not a rejection.
    expect(res).not.toBeNull()
    expect(res!.status).toBe('found')
    expect(res).toEqual(
      expect.objectContaining({
        status: 'found',
        data: expect.objectContaining({
          contact: { id: 'c1', first_attribution_id: 'a1' },
          tags: [{ id: 't1', name: 'VIP' }],
          notes: [{ id: 'n1', note_text: 'hi' }],
          customFields: [{ id: 'f1', field_name: 'CPF' }],
          customValues: { f1: '123' },
          deals: [{ id: 'd1', title: 'Deal' }],
          attribution: null,
        }),
      }),
    )
  })
})
