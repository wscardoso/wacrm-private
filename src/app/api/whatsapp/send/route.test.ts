import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  decryptWithBindingContext: mockDecrypt,
  encrypt: (t: string) => t,
  encryptWithBindingContext: (t: string) => t,
  isLegacyFormat: mockIsLegacyFormat,
}))

// IMP-E7-001 Phase 4 — KID convergence. Both default to the "nothing to
// converge" state so every pre-existing test (which never touches these)
// keeps its exact prior behavior; only the new tests below override them.
const mockIsWhatsappConfigCanonicalWriteEnabled = vi.fn()
vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
  isWhatsappConfigCanonicalWriteEnabled: mockIsWhatsappConfigCanonicalWriteEnabled,
}))
const mockNeedsKidConvergence = vi.fn()
const mockGetCurrentWriteKid = vi.fn()
vi.mock('@/lib/crypto/kidConvergence', () => ({
  needsKidConvergence: mockNeedsKidConvergence,
  getCurrentWriteKid: mockGetCurrentWriteKid,
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

const mockAuthGetUser = vi.fn()
const mockCreateClientImpl = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClientImpl,
}))

// S2 (plans/001-private-media-buckets-s2.md) — the route resolves a
// signed URL before forwarding media_url to a provider as `link`.
// Default: pass the input straight through (mirrors the real
// resolver's pass-through behavior for anything not one of our
// buckets); individual tests override this to prove the resolved
// value — not the raw media_url — is what reaches the provider.
const mockResolveSignedMediaUrl = vi.fn(async (_supabase: unknown, url: string) => url)
vi.mock('@/lib/storage/resolve-media-url', () => ({
  resolveSignedMediaUrl: (...args: Parameters<typeof mockResolveSignedMediaUrl>) => mockResolveSignedMediaUrl(...args),
  MEDIA_SIGNED_URL_TTL_SECONDS: 86400,
}))

const mockGetProvider = vi.fn()
// Only `getProvider` is replaced: `providerConfigFromRow` and
// `ProviderUnsupportedError` stay real so provider selection is exercised.
vi.mock('@/lib/whatsapp/providers', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/whatsapp/providers')>()),
  getProvider: mockGetProvider,
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
  for (const m of ['select', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt', 'update', 'insert', 'rpc']) {
    ;(chain as Record<string, unknown>)[m] = vi.fn(() => chain)
  }

  const withResult = (result: unknown) => {
    const c = { then: (resolve: (v: unknown) => void) => resolve(result) }
    for (const m of ['select', 'eq', 'single', 'maybeSingle', 'order', 'limit', 'gte', 'lt', 'update', 'insert', 'rpc']) {
      ;(c as Record<string, unknown>)[m] = vi.fn(() => c)
    }
    return c
  }

  return {
    from: vi.fn((table: string) => tables.get(table) ?? chain),
    rpc: vi.fn((name: string, args?: Record<string, unknown>) => { void name; void args; return chain }),
    /**
     * Override the result for a specific table.
     */
    setResult(table: string, result: unknown) {
      tables.set(table, withResult(result))
    },
  }
}

function createDefaultSupabase() {
  const db = mockSupabase({ data: '{"messageId":"msg-1","outcome":"sent"}', error: null })
  db.setResult('conversations', { data: { id: 'c1', account_id: 'a1', contact: { id: 'contact-1', phone: '+5511999999999' } }, error: null })
  db.setResult('whatsapp_config', { data: { id: '00000000-0000-4000-8000-0000000000c1', phone_number_id: '123', access_token: 'encrypted', account_id: 'a1' }, error: null })
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
  mockIsWhatsappConfigCanonicalWriteEnabled.mockReturnValue(false)
  mockNeedsKidConvergence.mockReturnValue(false)
  mockGetCurrentWriteKid.mockReturnValue('ACTIVE_V1')
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

  // profiles lookup used by route to resolve accountId
  db.setResult('profiles', { data: { account_id: 'account-1' }, error: null })

  mockAuthGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  mockCreateClientImpl.mockResolvedValue({
    auth: { getUser: mockAuthGetUser },
    from: (table: string) => db.from(table),
    rpc: (name: string, args?: Record<string, unknown>) => db.rpc(name, args),
  })

  const mockClassifySendFailure = vi.fn().mockReturnValue('deterministic-permanent')

  mockGetProvider.mockReturnValue({
    sendText: mockSendTextMessage,
    sendMedia: mockSendMediaMessage,
    sendTemplate: mockSendTemplateMessage,
    sendReaction: vi.fn().mockResolvedValue({ messageId: 'reaction-id' }),
    sendInteractiveButtons: vi.fn().mockResolvedValue({ messageId: 'interactive-id' }),
    sendInteractiveList: vi.fn().mockResolvedValue({ messageId: 'list-id' }),
    parseInboundMessage: vi.fn(),
    verifyWebhookRequest: vi.fn(),
    classifySendFailure: mockClassifySendFailure,
    capabilities: { nativeIdempotency: false, deliveryReconciliation: false },
  })
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

  it('rejects when auth fails', async () => {
    mockAuthGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('Unauthorized') })
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
    db.setResult('conversations', { data: null, error: { message: 'not found', code: 'PGRST116' } })
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

  // ─── IMP-E7-001 Phase 4 — KID convergence self-heal ──────────────────

  it('self-heals a canonical access_token under a stale KID when canonical write is enabled', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.converge1' })
    mockIsLegacyFormat.mockReturnValue(false)
    mockIsWhatsappConfigCanonicalWriteEnabled.mockReturnValue(true)
    mockNeedsKidConvergence.mockReturnValue(true)

    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'Hello!' }))
    expect(res.status).toBe(200)

    const wcChain = db.from('whatsapp_config') as unknown as { update: ReturnType<typeof vi.fn> }
    expect(wcChain.update).toHaveBeenCalled()
  })

  it('does not self-heal a stale-KID access_token while canonical write is disabled', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.converge2' })
    mockIsLegacyFormat.mockReturnValue(false)
    mockIsWhatsappConfigCanonicalWriteEnabled.mockReturnValue(false)
    // Even if it were consulted, this would say "converge" — the point of
    // this test is that it must NOT be consulted (short-circuited) when
    // the domain hasn't cut over to canonical writes yet.
    mockNeedsKidConvergence.mockReturnValue(true)

    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'Hello!' }))
    expect(res.status).toBe(200)

    const wcChain = db.from('whatsapp_config') as unknown as { update: ReturnType<typeof vi.fn> }
    expect(wcChain.update).not.toHaveBeenCalled()
    expect(mockNeedsKidConvergence).not.toHaveBeenCalled()
  })

  it('does not self-heal when the KID is already current (nothing to converge)', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.converge3' })
    mockIsLegacyFormat.mockReturnValue(false)
    mockIsWhatsappConfigCanonicalWriteEnabled.mockReturnValue(true)
    mockNeedsKidConvergence.mockReturnValue(false)

    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'Hello!' }))
    expect(res.status).toBe(200)

    const wcChain = db.from('whatsapp_config') as unknown as { update: ReturnType<typeof vi.fn> }
    expect(wcChain.update).not.toHaveBeenCalled()
  })

  // ─── S2 (plans/001-private-media-buckets-s2.md) — signed URL at dispatch ──

  it('sends a media message using the resolved signed URL, not the raw stored media_url', async () => {
    const rawUrl = 'https://proj.supabase.co/storage/v1/object/public/chat-media/account-a1/photo.png'
    const signedUrl = 'https://proj.supabase.co/storage/v1/object/sign/chat-media/account-a1/photo.png?token=abc'
    mockResolveSignedMediaUrl.mockResolvedValueOnce(signedUrl)
    mockSendMediaMessage.mockResolvedValueOnce({ messageId: 'wamid.media1', externalIdentities: [] })

    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'image',
      media_url: rawUrl,
    }))
    expect(res.status).toBe(200)
    expect(mockResolveSignedMediaUrl).toHaveBeenCalledWith(expect.anything(), rawUrl, 86400)
    expect(mockSendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ link: signedUrl }),
    )
  })

  it('forwards a non-bucket media_url unchanged (resolver pass-through)', async () => {
    const inboundUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc123'
    // Default mock implementation already passes the URL through unchanged.
    mockSendMediaMessage.mockResolvedValueOnce({ messageId: 'wamid.media2', externalIdentities: [] })

    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'image',
      media_url: inboundUrl,
    }))
    expect(res.status).toBe(200)
    expect(mockSendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ link: inboundUrl }),
    )
  })

  it('returns 500 and does not attempt to send when signed-URL resolution fails', async () => {
    mockResolveSignedMediaUrl.mockRejectedValueOnce(new Error('permission denied'))

    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'image',
      media_url: 'https://proj.supabase.co/storage/v1/object/public/chat-media/account-other/photo.png',
    }))
    expect(res.status).toBe(500)
    expect(mockSendMediaMessage).not.toHaveBeenCalled()
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
    expect(body).toHaveProperty('message_id')
  })

  it('settles as failed when provider throws', async () => {
    mockSendTextMessage.mockRejectedValue(new Error('downstream timeout'))
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'Will fail',
    }))
    expect(res.status).toBe(502)
    expect(db.rpc).toHaveBeenCalledWith(
      'settle_outbound_message',
      expect.objectContaining({ p_status: 'failed' }),
    )
  })

  it('does not trigger conversation effects when outcome is not sent', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.ok' })
    // Override settlement response to simulate failed outcome
    const failedSettlement = Promise.resolve({ data: '{"messageId":"msg-1","outcome":"failed"}', error: null })
    db.rpc.mockReturnValueOnce(failedSettlement)

    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'No effects',
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
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

  // `flow_runs` falls through to the default chain in this harness, so its
  // calls are observable on `db.from('flow_runs')`. Filter by payload: that
  // shared chain also serves any other table without an explicit override.
  function pauseCalls() {
    const chain = db.from('flow_runs') as unknown as {
      update: ReturnType<typeof vi.fn>
      eq: ReturnType<typeof vi.fn>
    }
    const updates = chain.update.mock.calls.filter(
      ([payload]) => (payload as { status?: string })?.status === 'paused_by_agent',
    )
    return { chain, updates }
  }

  // ─── Z-API removal — a persisted provider='zapi' row must be rejected ────
  // Never fall through to Meta: that would run a Z-API credential against
  // the Meta API.
  it('rejects a connection saved with the discontinued zapi provider (400), without sending or creating an intent', async () => {
    db.setResult('whatsapp_config', {
      data: { id: '00000000-0000-4000-8000-0000000000c1', provider: 'zapi', instance_id: 'inst1', access_token: 'encrypted', waba_id: null, phone_number_id: 'inst1', account_id: 'a1' },
      error: null,
    })
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'hello',
    }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Unsupported WhatsApp provider: zapi')
    expect(mockGetProvider).not.toHaveBeenCalled()
    expect(mockSendTextMessage).not.toHaveBeenCalled()
    expect(pauseCalls().updates).toHaveLength(0)
  })

  // ─── Delivery binding: written in the SAME insert that creates the message ──
  const insertedMessage = () => {
    const chain = db.from('messages') as unknown as { insert: ReturnType<typeof vi.fn> }
    return chain.insert.mock.calls.map((c) => c[0] as Record<string, unknown>)
  }

  it('Meta path: the intent is created with the connection, provider and channel fingerprint of the config it is sent through', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.bind' })
    const { POST } = await import('./route')
    expect((await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'hello' }))).status).toBe(200)

    const rows = insertedMessage()
    expect(rows).toHaveLength(1) // one INSERT carries everything — no second write completes the identity
    expect(rows[0]).toMatchObject({
      sender_type: 'agent',
      status: 'sending',
      connection_ref: '00000000-0000-4000-8000-0000000000c1',
      delivery_provider: 'meta',
    })
    expect(rows[0].delivery_channel_fp).toMatch(/^v1:[0-9a-f]{64}$/)
    expect(rows[0].idempotency_key).toBe(rows[0].id)
    // nothing secret in the row
    expect(JSON.stringify(rows[0])).not.toContain('encrypted')
  })

  it('uazapi path: same, with the uazapi provider and its own channel fingerprint', async () => {
    db.setResult('whatsapp_config', {
      data: { id: '00000000-0000-4000-8000-0000000000c1', provider: 'uazapi', instance_id: 'inst1', base_url: 'https://my.uazapi.dev', access_token: 'encrypted', account_id: 'a1' },
      error: null,
    })
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'uazapi.bind' })
    const { POST } = await import('./route')
    expect((await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'hello' }))).status).toBe(200)

    const [row] = insertedMessage()
    expect(row).toMatchObject({ connection_ref: '00000000-0000-4000-8000-0000000000c1', delivery_provider: 'uazapi' })
    expect(row.delivery_channel_fp).toMatch(/^v1:[0-9a-f]{64}$/)
  })

  it('a config that cannot identify its channel creates NO message and sends nothing', async () => {
    db.setResult('whatsapp_config', {
      data: { id: '00000000-0000-4000-8000-0000000000c1', provider: 'meta', phone_number_id: '', access_token: 'encrypted', account_id: 'a1' },
      error: null,
    })
    const { POST } = await import('./route')
    const res = await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'hello' }))
    expect(res.status).toBe(500)
    expect(insertedMessage()).toHaveLength(0)
    expect(mockSendTextMessage).not.toHaveBeenCalled()
  })

  it('selects the Meta adapter for a meta row and the uazapi adapter for a uazapi row', async () => {
    mockSendTextMessage.mockResolvedValue({ messageId: 'wamid.sel' })
    const { POST } = await import('./route')
    await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'm' }))
    expect(mockGetProvider.mock.calls[0][0]).toMatchObject({ provider: 'meta', phoneNumberId: '123' })

    mockGetProvider.mockClear()
    db.setResult('whatsapp_config', {
      data: { id: '00000000-0000-4000-8000-0000000000c1', provider: 'uazapi', instance_id: 'inst1', base_url: 'https://my.uazapi.dev', access_token: 'encrypted', account_id: 'a1' },
      error: null,
    })
    await POST(request({ conversation_id: 'c1', message_type: 'text', content_text: 'u' }))
    expect(mockGetProvider.mock.calls[0][0]).toMatchObject({ provider: 'uazapi', baseUrl: 'https://my.uazapi.dev', instanceId: 'inst1' })
  })

  it('ends active flow runs for the contact after a confirmed Meta send', async () => {
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'wamid.pause' })
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'Pause flows!',
    }))
    expect(res.status).toBe(200)

    const { chain, updates } = pauseCalls()
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({ status: 'paused_by_agent', end_reason: 'agent_replied' })
    expect(updates[0][0].ended_at).toEqual(expect.any(String))
    expect(chain.eq).toHaveBeenCalledWith('account_id', 'account-1')
    expect(chain.eq).toHaveBeenCalledWith('contact_id', 'contact-1')
    expect(chain.eq).toHaveBeenCalledWith('status', 'active')
  })

  it('ends active flow runs after a confirmed non-Meta (uazapi) send', async () => {
    db.setResult('whatsapp_config', {
      data: { id: '00000000-0000-4000-8000-0000000000c1', provider: 'uazapi', instance_id: 'inst1', base_url: 'https://my.uazapi.dev', access_token: 'encrypted', account_id: 'a1' },
      error: null,
    })
    mockSendTextMessage.mockResolvedValueOnce({ messageId: 'uazapi.pause' })
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'Pause flows on uazapi!',
    }))
    expect(res.status).toBe(200)

    const { chain, updates } = pauseCalls()
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({ status: 'paused_by_agent', end_reason: 'agent_replied' })
    expect(chain.eq).toHaveBeenCalledWith('account_id', 'account-1')
    expect(chain.eq).toHaveBeenCalledWith('contact_id', 'contact-1')
  })

  it('does not end flow runs when the non-Meta send fails', async () => {
    db.setResult('whatsapp_config', {
      data: { id: '00000000-0000-4000-8000-0000000000c1', provider: 'uazapi', instance_id: 'inst1', base_url: 'https://my.uazapi.dev', access_token: 'encrypted', account_id: 'a1' },
      error: null,
    })
    mockSendTextMessage.mockRejectedValueOnce(new Error('provider down'))
    const { POST } = await import('./route')
    const res = await POST(request({
      conversation_id: 'c1',
      message_type: 'text',
      content_text: 'Will fail',
    }))
    expect(res.status).toBe(502)
    expect(pauseCalls().updates).toHaveLength(0)
  })
})

// ---------------------------------------------------------------
// Settlement failure AFTER the provider accepted the message.
//
// Once a provider has returned an id the message is out of our hands: a
// database error while settling it must never be handled as a send failure
// (no 502, no "failed" bubble, no invitation to resend, no resend by us) and
// must leave a reconciliation trail that names the provider id.
// ---------------------------------------------------------------
describe('POST /api/whatsapp/send — settlement fails after the provider accepted', () => {
  const META_CFG = { id: '00000000-0000-4000-8000-0000000000c1', phone_number_id: '123', access_token: 'encrypted', account_id: 'a1' }
  const UAZAPI_CFG = { id: '00000000-0000-4000-8000-0000000000c1', provider: 'uazapi', instance_id: 'inst1', base_url: 'https://my.uazapi.dev', access_token: 'encrypted', account_id: 'a1' }

  type RpcResult = { data: unknown; error: unknown }
  const ok = (outcome = 'sent'): RpcResult => ({ data: { messageId: 'msg-1', outcome }, error: null })
  const dbError = (message = 'canceling statement due to statement timeout'): RpcResult => ({ data: null, error: { message, code: '57014' } })

  /** Route every rpc by name; `settle` is a queue of results, one per settle call. */
  function stubRpc(settle: Array<RpcResult | Error>) {
    const queue = [...settle]
    db.rpc.mockImplementation((name: string) => {
      if (name === 'settle_outbound_message') {
        const next = queue.shift() ?? ok()
        return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)) as never
      }
      return Promise.resolve({ data: { enqueued: true }, error: null }) as never
    })
  }
  const rpcCalls = (name: string) => db.rpc.mock.calls.filter(([n]) => n === name).map(([, a]) => a as Record<string, unknown>)
  // `flow_runs` falls through to the default chain in this harness.
  const pauseUpdates = () =>
    (db.from('flow_runs') as unknown as { update: ReturnType<typeof vi.fn> }).update.mock.calls.filter(
      ([payload]) => (payload as { status?: string })?.status === 'paused_by_agent',
    )

  const SEND = { conversation_id: 'c1', message_type: 'text', content_text: 'hello' }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  for (const [label, cfg, wamid] of [
    ['Meta', META_CFG, 'wamid.accepted1'],
    ['uazapi', UAZAPI_CFG, 'ABCD1234'],
  ] as const) {
    describe(label, () => {
      beforeEach(() => {
        db.setResult('whatsapp_config', { data: cfg, error: null })
        mockSendTextMessage.mockResolvedValue({ messageId: wamid, externalIdentities: [{ kind: 'wamid', value: wamid }] })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
      })

      it('answers 202 "accepted, settlement pending" with the provider id — not 502 — when settle keeps failing', async () => {
        stubRpc([dbError(), dbError()])
        const { POST } = await import('./route')
        const res = await POST(request(SEND))
        expect(res.status).toBe(202)
        const body = await res.json()
        expect(body).toMatchObject({ success: true, settlement: 'pending', whatsapp_message_id: wamid })
        expect(body.message_id).toEqual(expect.any(String))
        expect(body.error).toBeUndefined()
      })

      it('does not treat the settle error as a send failure: no failure classification, no "failed" settle, provider called once', async () => {
        stubRpc([dbError(), dbError()])
        const { POST } = await import('./route')
        await POST(request(SEND))
        const classify = (mockGetProvider.mock.results[0].value as { classifySendFailure: ReturnType<typeof vi.fn> }).classifySendFailure
        expect(classify).not.toHaveBeenCalled()
        expect(rpcCalls('settle_outbound_message').every((a) => a.p_status === 'sent')).toBe(true)
        expect(mockSendTextMessage).toHaveBeenCalledTimes(1)
      })

      it('leaves a reconciliation record naming the provider id, blocked from any automatic re-send', async () => {
        stubRpc([dbError(), dbError()])
        const { POST } = await import('./route')
        await POST(request(SEND))
        const enq = rpcCalls('enqueue_outbound_retry')
        expect(enq).toHaveLength(1)
        expect(enq[0]).toMatchObject({ p_classification: 'ambiguous', p_next_attempt_at: null })
        expect(String(enq[0].p_last_error)).toContain('ACCEPTED_BY_PROVIDER')
        expect(String(enq[0].p_last_error)).toContain(wamid)
      })

      it('survives a transient settle failure: the second attempt settles the message sent (200)', async () => {
        stubRpc([dbError('fetch failed'), ok('sent')])
        const { POST } = await import('./route')
        const res = await POST(request(SEND))
        expect(res.status).toBe(200)
        expect((await res.json()).settlement).toBeUndefined()
        expect(rpcCalls('enqueue_outbound_retry')).toHaveLength(0)
      })

      it('falls back to settling sent WITHOUT identities when recording them is what fails (e.g. unique violation)', async () => {
        stubRpc([
          { data: null, error: { message: 'duplicate key value violates unique constraint "uq_meid_connection_kind_value"', code: '23505' } },
          ok('sent'),
        ])
        const { POST } = await import('./route')
        const res = await POST(request(SEND))
        expect(res.status).toBe(200)
        const calls = rpcCalls('settle_outbound_message')
        expect(calls).toHaveLength(2)
        expect(calls[0].p_identities).toHaveLength(1)
        expect(calls[1].p_identities).toEqual([])
        expect(calls[1]).toMatchObject({ p_status: 'sent', p_provider_message_id: wamid })
      })

      it('a settle call that rejects (throws) is handled the same way', async () => {
        stubRpc([new Error('socket hang up'), new Error('socket hang up')])
        const { POST } = await import('./route')
        const res = await POST(request(SEND))
        expect(res.status).toBe(202)
        expect(mockSendTextMessage).toHaveBeenCalledTimes(1)
      })

      it('still applies the confirmed-send effects (the customer did receive the message)', async () => {
        stubRpc([dbError(), dbError()])
        const { POST } = await import('./route')
        await POST(request(SEND))
        expect(pauseUpdates()).toHaveLength(1)
      })

      it('never logs the access token', async () => {
        stubRpc([dbError(), dbError()])
        const { POST } = await import('./route')
        await POST(request(SEND))
        const logged = JSON.stringify([
          ...(console.error as unknown as ReturnType<typeof vi.fn>).mock.calls,
          ...(console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls,
        ])
        expect(logged).not.toContain('decrypted-token')
      })
    })
  }

  it('Meta: a settle error that looks like "recipient not allowed" must NOT make the loop send to the next phone variant', async () => {
    db.setResult('whatsapp_config', { data: META_CFG, error: null })
    mockPhoneVariants.mockImplementation((p: string) => [p, `1${p}`])
    mockIsRecipientNotAllowedError.mockReturnValue(true)
    mockSendTextMessage.mockResolvedValue({ messageId: 'wamid.once', externalIdentities: [] })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubRpc([dbError('131030 not in allowed list'), dbError('131030 not in allowed list')])
    const { POST } = await import('./route')
    const res = await POST(request(SEND))
    expect(mockSendTextMessage).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(202)
  })

  it('a genuine provider failure is unchanged: 502 + failure handling', async () => {
    db.setResult('whatsapp_config', { data: META_CFG, error: null })
    mockSendTextMessage.mockRejectedValue(new Error('token expired'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubRpc([ok('failed')])
    const { POST } = await import('./route')
    const res = await POST(request(SEND))
    expect(res.status).toBe(502)
    expect(rpcCalls('settle_outbound_message')[0]).toMatchObject({ p_status: 'failed' })
  })
})
