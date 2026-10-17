/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetUser = vi.fn()
let profileResult: { data: unknown; error: unknown } = { data: null, error: null }
let convResult: { data: unknown; error: unknown } = { data: null, error: null }

const mockRun = vi.fn(async () => {})
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: (...a: any[]) => mockRun(...(a as [])),
}))

function chain(result: { data: unknown; error: unknown }): any {
  const c: Record<string, unknown> = {}
  Object.assign(c, {
    select: () => c,
    eq: () => c,
    maybeSingle: () => Promise.resolve(result),
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
  supabaseAdmin: () => ({ from: () => chain(convResult) }),
}))

function req(body: unknown): Request {
  return new Request('http://localhost/api/conversations/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  profileResult = { data: { account_id: 'acct-1' }, error: null }
  convResult = {
    data: { id: 'conv-1', contact_id: 'contact-1', assigned_agent_id: 'agent-7' },
    error: null,
  }
})

describe('POST /api/conversations/events', () => {
  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const { POST } = await import('./route')
    expect((await POST(req({ event: 'conversation_assigned', conversationId: 'c' }))).status).toBe(401)
  })

  it('returns 400 for a missing conversation id or unsupported event', async () => {
    const { POST } = await import('./route')
    expect((await POST(req({ event: 'conversation_assigned' }))).status).toBe(400)
    expect((await POST(req({ event: 'other', conversationId: 'c' }))).status).toBe(400)
  })

  it('returns 404 when the conversation is not in the caller account', async () => {
    convResult = { data: null, error: null }
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'conversation_assigned', conversationId: 'foreign' }))
    expect(res.status).toBe(404)
    expect(mockRun).not.toHaveBeenCalled()
  })

  it('dispatches with the persisted assignee', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'conversation_assigned', conversationId: 'conv-1' }))
    expect(res.status).toBe(200)
    expect(mockRun).toHaveBeenCalledWith({
      accountId: 'acct-1',
      triggerType: 'conversation_assigned',
      contactId: 'contact-1',
      context: { conversation_id: 'conv-1', agent_id: 'agent-7' },
    })
  })

  it('does not dispatch when the conversation is unassigned', async () => {
    convResult = { data: { id: 'conv-1', contact_id: 'c', assigned_agent_id: null }, error: null }
    const { POST } = await import('./route')
    const res = await POST(req({ event: 'conversation_assigned', conversationId: 'conv-1' }))
    expect(await res.json()).toEqual({ ok: true, dispatched: false })
    expect(mockRun).not.toHaveBeenCalled()
  })
})
