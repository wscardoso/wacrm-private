/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetUser = vi.fn()
let profileResult: { data: unknown; error: unknown } = { data: null, error: null }
let updateResult: { data: unknown; error: unknown } = { data: null, error: null }
const calls: { payload?: any; filters: [string, unknown][] } = { filters: [] }

function profileChain(): any {
  const c: any = {}
  c.select = () => c
  c.eq = () => c
  c.maybeSingle = () => Promise.resolve(profileResult)
  return c
}
function dealsChain(): any {
  const c: any = {}
  c.update = (payload: unknown) => {
    calls.payload = payload
    return c
  }
  c.eq = (col: string, val: unknown) => {
    calls.filters.push([col, val])
    return c
  }
  c.select = () => c
  c.maybeSingle = () => Promise.resolve(updateResult)
  return c
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: () => profileChain() }),
}))
vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => dealsChain() }),
}))

function req(body: unknown, raw?: string): Request {
  return new Request('http://localhost/api/deals/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.payload = undefined
  calls.filters = []
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  profileResult = { data: { account_id: 'acct-1', account_role: 'agent' }, error: null }
  updateResult = { data: { id: 'd1', status: 'lost', loss_reason: 'Preço' }, error: null }
})

describe('POST /api/deals/status', () => {
  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const { POST } = await import('./route')
    expect((await POST(req({ dealId: 'd1', status: 'lost', lossReason: 'x' }))).status).toBe(401)
  })

  it('400 when the caller has no account', async () => {
    profileResult = { data: null, error: null }
    const { POST } = await import('./route')
    expect((await POST(req({ dealId: 'd1', status: 'open' }))).status).toBe(400)
  })

  it('403 for a viewer, with no write', async () => {
    profileResult = { data: { account_id: 'acct-1', account_role: 'viewer' }, error: null }
    const { POST } = await import('./route')
    expect((await POST(req({ dealId: 'd1', status: 'open' }))).status).toBe(403)
    expect(calls.payload).toBeUndefined()
  })

  it('400 for malformed JSON, missing dealId, invalid status', async () => {
    const { POST } = await import('./route')
    expect((await POST(req(null, '{not json'))).status).toBe(400)
    expect((await POST(req({ status: 'open' }))).status).toBe(400)
    expect((await POST(req({ dealId: 'd1', status: 'closed' }))).status).toBe(400)
    expect(calls.payload).toBeUndefined()
  })

  it('400 and no write when marking lost without a reason', async () => {
    const { POST } = await import('./route')
    expect((await POST(req({ dealId: 'd1', status: 'lost' }))).status).toBe(400)
    expect((await POST(req({ dealId: 'd1', status: 'lost', lossReason: '  ' }))).status).toBe(400)
    expect(calls.payload).toBeUndefined()
  })

  it('writes status + trimmed reason scoped by id and account_id', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({ dealId: 'd1', status: 'lost', lossReason: ' Preço ' }))
    expect(res.status).toBe(200)
    expect(calls.payload).toMatchObject({ status: 'lost', loss_reason: 'Preço' })
    expect(calls.filters).toContainEqual(['id', 'd1'])
    expect(calls.filters).toContainEqual(['account_id', 'acct-1'])
  })

  it.each(['open', 'won'])('%s clears any stored reason', async (status) => {
    updateResult = { data: { id: 'd1', status, loss_reason: null }, error: null }
    const { POST } = await import('./route')
    const res = await POST(req({ dealId: 'd1', status, lossReason: 'stale' }))
    expect(res.status).toBe(200)
    expect(calls.payload).toMatchObject({ status, loss_reason: null })
  })

  it('404 when the deal is not in the caller account', async () => {
    updateResult = { data: null, error: null }
    const { POST } = await import('./route')
    expect((await POST(req({ dealId: 'foreign', status: 'lost', lossReason: 'x' }))).status).toBe(404)
  })

  it('500 on a database error without leaking details', async () => {
    updateResult = { data: null, error: { message: 'secret detail' } }
    const { POST } = await import('./route')
    const res = await POST(req({ dealId: 'd1', status: 'lost', lossReason: 'x' }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
