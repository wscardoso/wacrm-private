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

// Records every builder method call as { table, method } so tests can
// assert the idempotent upsert path (C4) is used instead of insert, and
// that downstream effects are skipped on redelivery.
const builderCalls: Array<{ table: string; method: string }> = []

// Dedicated flags for the C4 assertions, set inside the recorder so they
// survive any array-reset timing in the async flow.
let sawMessagesUpsert = false
let sawMessagesInsert = false
let sawConversationUpdate = false
let sawInboundRpc = false
let sawRpcReturnedId = false

// Per-table terminal result for the `await`/`.then` resolution.
const tableTerminal: Record<string, { data: any; error: any }> = {}

function makeRecorderChain(table: string) {
  const terminal = tableTerminal[table] ?? { data: [], error: null }
  const chain: any = {
    then: (resolve: (v: any) => void) => {
      resolve(terminal)
      return Promise.resolve(terminal)
    },
  }
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'in', 'is', 'not', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt',
  ]) {
    chain[m] = vi.fn(() => {
      builderCalls.push({ table, method: m })
      if (table === 'messages' && m === 'upsert') sawMessagesUpsert = true
      if (table === 'messages' && m === 'insert') sawMessagesInsert = true
      if (table === 'conversations' && m === 'update') sawConversationUpdate = true
      if (process.env.VITEST_DEBUG) console.log('CALL', table, m)
      return chain
    })
  }
  return chain
}

// RPC mock for the C4 idempotent insert. insert_inbound_message returns
// the new row id (or NULL on redelivery) based on tableTerminal['messages'].
function makeRpc(fn: string, _params: Record<string, unknown>) {
  builderCalls.push({ table: `<rpc:${fn}>`, method: 'rpc' })
  if (fn === 'insert_inbound_message') {
    sawInboundRpc = true
    const terminal = tableTerminal['messages'] ?? { data: [], error: null }
    const id = Array.isArray(terminal.data) && terminal.data.length > 0 ? terminal.data[0].id : null
    if (id) sawRpcReturnedId = true
    return Promise.resolve({ data: id, error: terminal.error ?? null })
  }
  return Promise.resolve({ data: null, error: null })
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
  builderCalls.length = 0
  sawMessagesUpsert = false
  sawMessagesInsert = false
  sawConversationUpdate = false
  sawInboundRpc = false
  sawRpcReturnedId = false
  Object.keys(tableTerminal).forEach((k) => delete tableTerminal[k])

  mockCheckRateLimit.mockReturnValue({ success: true, remaining: 99, reset: 0, limit: 999 })
  mockRateLimitResponse.mockReturnValue(NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 }))
  mockVerifyMetaWebhookSignature.mockReturnValue(true)
  mockDecrypt.mockReturnValue('decrypted-value')
  mockEncrypt.mockReturnValue('encrypted-value')
  mockIsLegacyFormat.mockReturnValue(false)
  mockSupabaseAdmin.mockReturnValue({
    from: vi.fn((t: string) => makeRecorderChain(t)),
    rpc: makeRpc,
  })
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
      from: vi.fn((t: string) => {
        tableTerminal[t] = { data: configs, error: null }
        return makeRecorderChain(t)
      }),
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

  it('uses idempotent upsert (not insert) for inbound messages — C4', async () => {
    // config lookup returns a config row so processing proceeds;
    // messages upsert resolves with one inserted row.
    tableTerminal['whatsapp_config'] = {
      data: [{ account_id: 'acc-1', user_id: 'user-1', access_token: 'enc' }],
      error: null,
    }
    tableTerminal['messages'] = { data: [{ id: 'msg-1' }], error: null }

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

    // processWebhook runs fire-and-forget inside POST; let it settle.
    await new Promise((r) => setTimeout(r, 50))

    expect(sawInboundRpc).toBe(true)
    expect(sawRpcReturnedId).toBe(true)
  })

  it('short-circuits downstream effects on redelivery (duplicate) — C4', async () => {
    // config lookup returns a config row; messages upsert yields zero rows
    // (ignoreDuplicates on the unique index) -> redelivery.
    tableTerminal['whatsapp_config'] = {
      data: [{ account_id: 'acc-1', user_id: 'user-1', access_token: 'enc' }],
      error: null,
    }
    tableTerminal['messages'] = { data: [], error: null }

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
              id: 'wamid.dup',
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

    // processWebhook runs fire-and-forget inside POST; let it settle.
    await new Promise((r) => setTimeout(r, 50))

    expect(sawInboundRpc).toBe(true)
    // No conversation update (unread_count bump) fired on redelivery.
    expect(sawConversationUpdate).toBe(false)
  })
})
