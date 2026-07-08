import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// ---------------------------------------------------------------
// Mocks — hoisted before the module import so vi.mock works.
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
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
}))

const mockSendTextMessage = vi.fn()
const mockSendTemplateMessage = vi.fn()
const mockSendMediaMessage = vi.fn()
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: mockSendTextMessage,
  sendTemplateMessage: mockSendTemplateMessage,
  sendMediaMessage: mockSendMediaMessage,
}))

const mockDecrypt = vi.fn()
const mockIsLegacyFormat = vi.fn()
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mockDecrypt,
  encrypt: (t: string) => t,
  isLegacyFormat: mockIsLegacyFormat,
}))

const mockPhoneVariants = vi.fn()
const mockIsRecipientNotAllowedError = vi.fn()
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: (p: string) => p.replace(/\D/g, ''),
  isValidE164: (p: string) => /^\+?[1-9]\d{6,14}$/.test(p),
  phoneVariants: mockPhoneVariants,
  isRecipientNotAllowedError: mockIsRecipientNotAllowedError,
}))

const mockSupabaseAdmin = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}))

const mockIsMessageTemplate = vi.fn()
vi.mock('@/lib/whatsapp/template-row-guard', () => ({
  isMessageTemplate: mockIsMessageTemplate,
}))

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/**
 * Build a thenable Supabase chain.
 * @param defaultResult — resolved value for queries where no override is set.
 */
function mockSupabase(defaultResult: unknown = { data: null, error: null }) {
  const tables = new Map<string, unknown>()

  const chain = { then: (resolve: (v: unknown) => void) => resolve(defaultResult) }
  for (const m of ['select', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt', 'update', 'insert']) {
    ;(chain as Record<string, unknown>)[m] = vi.fn(() => chain)
  }

  const withResult = (result: unknown) => {
    const c = { then: (resolve: (v: unknown) => void) => resolve(result) }
    for (const m of ['select', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt', 'update', 'insert']) {
      ;(c as Record<string, unknown>)[m] = vi.fn(() => c)
    }
    return c
  }

  return {
    from: vi.fn((table: string) => tables.get(table) ?? chain),
    /**
     * Override the result for a specific table.
     */
    setResult(table: string, result: unknown) {
      tables.set(table, withResult(result))
    },
  }
}

function createDefaultSupabase() {
  const db = mockSupabase()
  db.setResult('conversations', { data: { id: 'c1', account_id: 'a1', contact: { id: 'contact-1', phone: '+5511999999999' } }, error: null })
  db.setResult('whatsapp_config', { data: { id: 'cfg1', phone_number_id: '123', access_token: 'encrypted', account_id: 'a1' }, error: null })
  db.setResult('messages', { data: { id: 'msg-1' }, error: null })
  return db
}

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/whatsapp/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let db: ReturnType<typeof createDefaultSupabase>

beforeEach(() => {
  vi.clearAllMocks()

  mockDecrypt.mockReturnValue('decrypted-token')
  mockIsLegacyFormat.mockReturnValue(false)
  mockPhoneVariants.mockImplementation((p: string) => [p])
  mockIsRecipientNotAllowedError.mockReturnValue(false)
  db = createDefaultSupabase()
  mockSupabaseAdmin.mockReturnValue(db)

  mockRequireRole.mockResolvedValue({
    supabase: db,
    userId: 'user-1',
    accountId: 'account-1',
  })

  mockCheckRateLimit.mockReturnValue({ success: true, remaining: 59, reset: 0, limit: 60 })
  mockRateLimitResponse.mockReturnValue(NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }))
})

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('POST /api/whatsapp/send', () => {
  it('rejects missing conversation_id', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ message_type: 'text', content_text: 'hi' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('conversation_id')
  })

  it('rejects missing message_type', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('message_type')
  })

  it('rejects unsupported message_type', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'fax' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Unsupported message_type')
  })

  it('rejects text message without content_text', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('content_text')
  })

  it('rejects template without template_name', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'template' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('template_name')
  })

  it('rejects media without media_url', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'image' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('media_url')
  })

  it('rejects caption over 1024 chars', async () => {
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1', message_type: 'image', media_url: 'https://example.com/img.jpg',
      content_text: 'x'.repeat(1025),
    }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('1024-character')
  })

  it('rejects when requireRole throws', async () => {
    mockRequireRole.mockRejectedValueOnce(new Error('Unauthorized'))
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'hi' }))
    expect(res.status).toBe(401)
  })

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ success: false, remaining: 0, reset: 9999999999999, limit: 60 })
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'hi' }))
    expect(res.status).toBe(429)
  })

  it('returns 404 when conversation not found', async () => {
    // Override conversations to simulate missing conversation
    const localDb = createDefaultSupabase()
    localDb.setResult('conversations', { data: null, error: { message: 'not found', code: 'PGRST116' } })
    mockRequireRole.mockResolvedValueOnce({
      supabase: localDb,
      userId: 'user-1',
      accountId: 'account-1',
    })
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'hi' }))
    expect(res.status).toBe(404)
  })

  it('sends a text message successfully', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.abc123' })
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'Hello!',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.whatsapp_message_id).toBe('wamid.abc123')
  })

  it('sends a template message successfully', async () => {
    mockSendTemplateMessage.mockResolvedValueOnce({ messageId: 'wamid.tpl456' })
    mockIsMessageTemplate.mockReturnValueOnce(true)
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'template',
      template_name: 'welcome',
      template_language: 'en_US',
      template_params: ['Alice'],
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.whatsapp_message_id).toBe('wamid.tpl456')
  })

  it('returns 502 when all Meta API attempts fail', async () => {
    mockSendTextMessage.mockRejectedValue(new Error('token expired'))
    mockIsRecipientNotAllowedError.mockReturnValue(false)

    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'This will fail',
    }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('Meta API error')
  })

  it('retries with phone variants on sandbox error', async () => {
    mockPhoneVariants.mockImplementation((p: string) => [p, `1${p}`, `10${p}`])
    mockSendTextMessage
      .mockRejectedValueOnce(new Error('131030: not in allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid.retry' })
    mockIsRecipientNotAllowedError.mockReturnValue(true)

    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'Hello via retry!',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.whatsapp_message_id).toBe('wamid.retry')
  })

  it('returns 502 when all phone variants fail', async () => {
    mockPhoneVariants.mockImplementation((p: string) => [p, `${p}x`])
    mockSendTextMessage
      .mockRejectedValueOnce(new Error('131030: not in allowed list'))
      .mockRejectedValueOnce(new Error('131030: still not allowed'))
    mockIsRecipientNotAllowedError.mockReturnValue(true)

    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'This will fail',
    }))
    expect(res.status).toBe(502)
  })

  it('pauses flow runs after sending', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.pause' })
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'Pause flows!',
    }))
    expect(res.status).toBe(200)
  })
})
