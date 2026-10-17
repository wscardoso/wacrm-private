/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------

const mockGetUser = vi.fn()
let profileResult: { data: unknown; error: unknown } = { data: null, error: null }
let dealResult: { data: unknown; error: unknown } = { data: null, error: null }
let stageResult: { data: unknown; error: unknown } = { data: null, error: null }

const mockNotifyDealCreated = vi.fn(async () => {})
const mockNotifyDealStageChanged = vi.fn(async () => {})
vi.mock('@/lib/deals/events', () => ({
  notifyDealCreated: (...a: any[]) => mockNotifyDealCreated(...(a as [])),
  notifyDealStageChanged: (...a: any[]) => mockNotifyDealStageChanged(...(a as [])),
}))

function chain(result: { data: unknown; error: unknown }): any {
  const c: Record<string, unknown> = {}
  Object.assign(c, {
    select() {
      return c
    },
    eq() {
      return c
    },
    maybeSingle() {
      return Promise.resolve(result)
    },
    single() {
      return Promise.resolve(result)
    },
    then(resolve: (v: unknown) => void) {
      return Promise.resolve(result).then(resolve)
    },
  })
  return c
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: () => chain(profileResult),
  }),
}))

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => chain(table === 'pipeline_stages' ? stageResult : dealResult),
  }),
}))

function req(body: unknown): Request {
  return new Request('http://localhost/api/deals/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const DEAL = {
  id: 'deal-1',
  account_id: 'acct-1',
  contact_id: 'contact-1',
  pipeline_id: 'pl-1',
  stage_id: 'st-2',
  title: 'Deal',
  value: 100,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  profileResult = { data: { account_id: 'acct-1' }, error: null }
  dealResult = { data: DEAL, error: null }
  stageResult = { data: { id: 'st-1' }, error: null }
})

describe('POST /api/deals/events', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no session') })
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'deal_created', dealId: 'deal-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when the caller has no account', async () => {
    profileResult = { data: null, error: null }
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'deal_created', dealId: 'deal-1' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when event or dealId is missing', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'deal_created' }))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the deal is not in the caller account', async () => {
    dealResult = { data: null, error: null }
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'deal_created', dealId: 'foreign' }))
    expect(res.status).toBe(404)
    expect(mockNotifyDealCreated).not.toHaveBeenCalled()
  })

  it('dispatches deal_created for an own-account deal', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'deal_created', dealId: 'deal-1' }))
    expect(res.status).toBe(200)
    expect(mockNotifyDealCreated).toHaveBeenCalledWith({
      accountId: 'acct-1',
      dealId: 'deal-1',
      contactId: 'contact-1',
      pipelineId: 'pl-1',
      stageId: 'st-2',
      title: 'Deal',
      value: 100,
    })
  })

  it('dispatches deal_stage_changed using the persisted stage, not the body stageId', async () => {
    const { POST } = await import('./route')
    const res = await POST(
      req({ event: 'deal_stage_changed', dealId: 'deal-1', oldStageId: 'st-1', stageId: 'st-9' }),
    )
    expect(res.status).toBe(200)
    expect(mockNotifyDealStageChanged).toHaveBeenCalledWith({
      accountId: 'acct-1',
      dealId: 'deal-1',
      contactId: 'contact-1',
      pipelineId: 'pl-1',
      oldStageId: 'st-1',
      newStageId: 'st-2',
    })
  })

  it('drops an oldStageId that is not a stage of the deal pipeline', async () => {
    stageResult = { data: null, error: null }
    const { POST } = await import('./route')
    await POST(req({ event: 'deal_stage_changed', dealId: 'deal-1', oldStageId: 'foreign' }))
    expect(mockNotifyDealStageChanged).toHaveBeenCalledWith(
      expect.objectContaining({ oldStageId: undefined, newStageId: 'st-2' }),
    )
  })
})
