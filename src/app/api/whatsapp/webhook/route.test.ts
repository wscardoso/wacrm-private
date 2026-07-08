import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// ---------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------

const mockSupabaseAdmin = vi.fn()
vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}))

const mockCheckRateLimit = vi.fn()
const mockRateLimitResponse = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitResponse: mockRateLimitResponse,
  RATE_LIMITS: {
    webhookVerify: { limit: 30, windowMs: 60_000 },
    webhookInbound: { limit: 300, windowMs: 60_000 },
  },
}))

const mockVerifyMetaWebhookSignature = vi.fn()
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: mockVerifyMetaWebhookSignature,
}))

const mockDecrypt = vi.fn()
const mockEncrypt = vi.fn()
const mockIsLegacyFormat = vi.fn()
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: mockDecrypt,
  encrypt: mockEncrypt,
  isLegacyFormat: mockIsLegacyFormat,
}))

// Stub the remaining imports so the module loads without error.
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  normalizePhone: (p: string) => p.replace(/\D/g, ''),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(),
  isUniqueViolation: vi.fn(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(),
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  handleTemplateWebhookChange: vi.fn(),
  isTemplateWebhookField: vi.fn(),
}))

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function q<T>(result: T) {
  const chain = { then: (resolve: (v: T) => void) => resolve(result) }
  for (const m of ['select', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt', 'update']) {
    ;(chain as Record<string, unknown>)[m] = vi.fn(() => chain)
  }
  return chain
}

function getRequest(url: string): Request {
  return new Request(url, { method: 'GET' })
}

function postRequest(body: string): Request {
  return new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

beforeEach(() => {
  vi.clearAllMocks()

  mockCheckRateLimit.mockReturnValue({ success: true, remaining: 99, reset: 0, limit: 999 })
  mockRateLimitResponse.mockReturnValue(NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }))
  mockVerifyMetaWebhookSignature.mockReturnValue(true)
  mockDecrypt.mockReturnValue('decrypted-value')
  mockEncrypt.mockReturnValue('encrypted-value')
  mockIsLegacyFormat.mockReturnValue(false)
  mockSupabaseAdmin.mockReturnValue({ from: vi.fn(() => q({ data: [], error: null })) })
})

// ---------------------------------------------------------------
// GET — Webhook verification
// ---------------------------------------------------------------

describe('GET /api/whatsapp/webhook', () => {
  const verifyUrl = (token: string) =>
    `http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=123456&hub.verify_token=${token}`

  it('returns 400 when parameters are missing', async () => {
    const { GET } = await import('./route')
    const res = await GET(getRequest('http://localhost/api/whatsapp/webhook'))
    expect(res.status).toBe(400)
  })

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValueOnce({ success: false, remaining: 0, reset: 9999999999999, limit: 30 })
    const { GET } = await import('./route')
    const res = await GET(getRequest(verifyUrl('mytoken')))
    expect(res.status).toBe(429)
  })

  it('returns 403 when no configs match', async () => {
    const { GET } = await import('./route')
    const res = await GET(getRequest(verifyUrl('wrongtoken')))
    expect(res.status).toBe(403)
  })

  it('returns challenge when verify_token matches', async () => {
    const configs = [
      { id: 'c1', verify_token: 'encrypted-token' },
      { id: 'c2', verify_token: 'encrypted-other' },
    ]
    mockSupabaseAdmin.mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => q({ data: configs, error: null })) })),
    })
    // First call (c1) fails decryption, second (c2) matches
    mockDecrypt
      .mockReturnValueOnce('wrong-token')
      .mockReturnValueOnce('mytoken')

    const { GET } = await import('./route')
    const res = await GET(getRequest(verifyUrl('mytoken')))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe('123456')
  })

  it('returns 403 on decryption error', async () => {
    // No configs returned
    const { GET } = await import('./route')
    const res = await GET(getRequest(verifyUrl('mytoken')))
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------
// POST — Inbound messages
// ---------------------------------------------------------------

describe('POST /api/whatsapp/webhook', () => {
  it('rejects payload with Content-Length over 512KB', async () => {
    const { POST } = await import('./route')
    const req = new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'Content-Length': '600000' },
    })
    const res = await POST(req)
    expect(res.status).toBe(413)
  })

  it('rejects payload exceeding actual size threshold', async () => {
    const { POST } = await import('./route')
    const res = await POST(postRequest('x'.repeat(600_000)))
    expect(res.status).toBe(413)
  })

  it('rejects request with invalid HMAC signature', async () => {
    mockVerifyMetaWebhookSignature.mockReturnValueOnce(false)
    const { POST } = await import('./route')
    const res = await POST(postRequest(JSON.stringify({ entry: [] })))
    expect(res.status).toBe(401)
  })

  it('rejects invalid JSON body', async () => {
    mockVerifyMetaWebhookSignature.mockReturnValueOnce(true)
    const { POST } = await import('./route')
    const res = await POST(postRequest('not-json'))
    expect(res.status).toBe(400)
  })

  it('returns 429 when rate limited', async () => {
    mockCheckRateLimit.mockReturnValue({ success: false, remaining: 0, reset: 9999999999999, limit: 300 })

    const { POST } = await import('./route')
    const body = JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: '123' },
          },
        }],
      }],
    })
    const res = await POST(postRequest(body))
    expect(res.status).toBe(429)
  })

  it('returns 200 for a valid inbound message', async () => {
    const { POST } = await import('./route')
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'wa-account',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15551234567', phone_number_id: '123' },
            contacts: [{ profile: { name: 'Alice' }, wa_id: '15559876543' }],
            messages: [{
              from: '15559876543',
              id: 'wamid.msg1',
              timestamp: '1710000000',
              type: 'text',
              text: { body: 'Hello!' },
            }],
          },
          field: 'messages',
        }],
      }],
    })
    const res = await POST(postRequest(body))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.status).toBe('received')
  })
})
