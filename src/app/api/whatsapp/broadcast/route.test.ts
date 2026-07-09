import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// ---------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/account', () => ({
  requireRole: mockRequireRole,
  toErrorResponse: (err: unknown) =>
    NextResponse.json({ error: (err as Error).message ?? 'Auth error' }, { status: 401 }),
}))

const mockCheckRateLimit = vi.fn()
const mockRateLimitResponse = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitResponse: mockRateLimitResponse,
  RATE_LIMITS: { broadcast: { limit: 5, windowMs: 60_000 } },
}))

const mockSendTemplateMessage = vi.fn()
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: mockSendTemplateMessage,
}))

const mockDecrypt = vi.fn()
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mockDecrypt,
}))

const mockIsMessageTemplate = vi.fn()
vi.mock('@/lib/whatsapp/template-row-guard', () => ({
  isMessageTemplate: mockIsMessageTemplate,
}))

vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: (p: string) => p.replace(/\D/g, ''),
  isValidE164: (p: string) => /^\+?[1-9]\d{6,14}$/.test(p),
  phoneVariants: (p: string) => [p],
  isRecipientNotAllowedError: () => false,
}))

const mockBroadcastAuthGetUser = vi.fn()
const mockBroadcastCreateClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: mockBroadcastCreateClient,
}))

const mockBroadcastSupabaseAdmin = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mockBroadcastSupabaseAdmin,
}))

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function q<T>(result: T) {
  const chain = { then: (resolve: (v: T) => void) => resolve(result) }
  for (const m of ['select', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt']) {
    ;(chain as Record<string, unknown>)[m] = vi.fn(() => chain)
  }
  return chain
}

function mockDb() {
  const tables = new Map<string, unknown>()

  const withResult = (result: unknown) => {
    const c = { then: (resolve: (v: unknown) => void) => resolve(result) }
    for (const m of ['select', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt']) {
      ;(c as Record<string, unknown>)[m] = vi.fn(() => c)
    }
    return c
  }

  return {
    from: vi.fn((table: string) => tables.get(table) ?? q({ data: null, error: null })),
    setResult(table: string, result: unknown) {
      tables.set(table, withResult(result))
    },
  }
}

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let db: ReturnType<typeof mockDb>

beforeEach(() => {
  vi.clearAllMocks()
  db = mockDb()

  mockBroadcastAuthGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockBroadcastCreateClient.mockResolvedValue({
    auth: { getUser: mockBroadcastAuthGetUser },
    from: (table: string) => db.from(table),
  })
  mockBroadcastSupabaseAdmin.mockReturnValue({
    from: (table: string) => db.from(table),
  })

  mockDecrypt.mockReturnValue('decrypted-token')
  mockIsMessageTemplate.mockReturnValue(true)

  db.setResult('profiles', { data: { account_id: 'account-1' }, error: null })
  db.setResult('whatsapp_config', {
    data: { id: 'cfg1', phone_number_id: '123', access_token: 'encrypted', account_id: 'a1' },
    error: null,
  })
  db.setResult('message_templates', {
    data: { id: 'tpl1', name: 'welcome', language: 'en_US', account_id: 'a1' },
    error: null,
  })

  mockRequireRole.mockResolvedValue({ supabase: db, userId: 'user-1', accountId: 'account-1' })
  mockCheckRateLimit.mockReturnValue({ success: true, remaining: 4, reset: 0, limit: 5 })
  mockRateLimitResponse.mockReturnValue(NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }))
})

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('POST /api/whatsapp/broadcast', () => {
  it('rejects missing recipients', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ template_name: 'welcome' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('recipients')
  })

  it('rejects missing template_name', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ recipients: [{ phone: '+5511999999999' }] }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('template_name')
  })

  it('rejects when auth.getUser returns error', async () => {
    mockBroadcastAuthGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('Unauthorized') })
    const { POST } = await import('./route')
    const res = await POST(request({
      recipients: [{ phone: '+5511999999999' }],
      template_name: 'welcome',
    }))
    expect(res.status).toBe(401)
  })

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ success: false, remaining: 0, reset: 9999999999999, limit: 5 })
    const { POST } = await import('./route')
    const res = await POST(request({
      recipients: [{ phone: '+5511999999999' }],
      template_name: 'welcome',
    }))
    expect(res.status).toBe(429)
  })

  it('returns 400 when no whatsapp config', async () => {
    db.setResult('whatsapp_config', { data: null, error: null })
    const { POST } = await import('./route')
    const res = await POST(request({
      recipients: [{ phone: '+5511999999999' }],
      template_name: 'welcome',
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('WhatsApp not configured')
  })

  it('returns 500 for malformed template row', async () => {
    mockIsMessageTemplate.mockReturnValue(false)
    const { POST } = await import('./route')
    const res = await POST(request({
      recipients: [{ phone: '+5511999999999' }],
      template_name: 'welcome',
    }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain('malformed')
  })

  it('sends to all recipients with the new format', async () => {
    mockSendTemplateMessage.mockResolvedValue({ messageId: 'wamid.abc' })
    const { POST } = await import('./route')
    const res = await POST(request({
      recipients: [
        { phone: '+5511999999999', params: ['Alice'] },
        { phone: '+5521988888888', params: ['Bob'] },
      ],
      template_name: 'welcome',
      template_language: 'en_US',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(2)
    expect(body.failed).toBe(0)
    expect(body.total).toBe(2)
    expect(body.results).toHaveLength(2)
  })

  it('sends with legacy phone_numbers format', async () => {
    mockSendTemplateMessage.mockResolvedValue({ messageId: 'wamid.legacy' })
    const { POST } = await import('./route')
    const res = await POST(request({
      phone_numbers: ['+5511999999999', '+5521988888888'],
      template_params: ['Alice', 'Bob'],
      template_name: 'welcome',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(2)
    expect(body.failed).toBe(0)
  })

  it('skips invalid phone numbers', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({
      recipients: [
        { phone: 'invalid' },
        { phone: '+5511999999999' },
      ],
      template_name: 'welcome',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(1)
    expect(body.failed).toBe(1)
    expect(body.results[0].status).toBe('failed')
    expect(body.results[0].error).toContain('Invalid phone')
  })

  it('gracefully handles individual failures and returns 200 with partial results', async () => {
    mockSendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.1' })
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ messageId: 'wamid.3' })

    const { POST } = await import('./route')
    const res = await POST(request({
      recipients: [
        { phone: '+5511999999999' },
        { phone: '+5521988888888' },
        { phone: '+5531977777777' },
      ],
      template_name: 'welcome',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sent).toBe(2)
    expect(body.failed).toBe(1)
    expect(body.results).toHaveLength(3)
  })
})
