import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// Mocks — hoisted before the module import so vi.mock works.
// Modeled on src/app/api/whatsapp/config/kid-convergence-sweep/route.test.ts,
// the closest existing example of testing a cron-secret-gated GET
// handler against a mocked service-role client.
// ---------------------------------------------------------------

const mockSupabaseAdmin = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}))

const mockGetProvider = vi.fn()
vi.mock('@/lib/whatsapp/providers', () => ({
  getProvider: mockGetProvider,
}))

const mockDecrypt = vi.fn()
vi.mock('@/lib/whatsapp/encryption', () => ({
  decryptWithBindingContext: mockDecrypt,
}))

vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
}))

vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: (p: string) => p,
}))

const mockSettleMessageSystem = vi.fn()
vi.mock('@/lib/whatsapp/delivery/settlement', () => ({
  settleMessageSystem: (...args: unknown[]) => mockSettleMessageSystem(...args),
}))

const mockClassifyFailure = vi.fn()
vi.mock('@/lib/whatsapp/delivery/failure-classifier', () => ({
  classifyFailure: (...args: unknown[]) => mockClassifyFailure(...args),
}))

const mockDecideRetryOutcome = vi.fn()
vi.mock('@/lib/whatsapp/delivery/retry-policy', () => ({
  decideRetryOutcome: (...args: unknown[]) => mockDecideRetryOutcome(...args),
  DEFAULT_BACKOFF_CONFIG: {},
  DEFAULT_TTL_MS: 1000 * 60 * 60 * 24,
  MAX_ATTEMPT_COUNT: 5,
}))

// S2 (plans/001-private-media-buckets-s2.md), Step 3b — the route
// resolves a signed URL before forwarding a retried media message's
// media_url to a provider as `link`. Default: pass the input straight
// through, mirroring the real resolver's pass-through behavior;
// individual tests override this to prove the resolved value — not
// the raw media_url — is what reaches the provider.
const mockResolveSignedMediaUrl = vi.fn(async (_admin: unknown, url: string) => url)
vi.mock('@/lib/storage/resolve-media-url', () => ({
  resolveSignedMediaUrl: (...args: Parameters<typeof mockResolveSignedMediaUrl>) =>
    mockResolveSignedMediaUrl(...args),
  MEDIA_SIGNED_URL_TTL_SECONDS: 86400,
}))

// F-INT-04 (E2E validation) — cronDrain rate limit added on top of the
// existing cron-secret gate. Defaults to always-allow so every
// pre-existing test below keeps its exact prior behavior; the
// dedicated 429 test overrides this.
const mockCheckRateLimit = vi.fn()
const mockRateLimitResponse = vi.fn()
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  rateLimitResponse: (...args: unknown[]) => mockRateLimitResponse(...args),
  RATE_LIMITS: { cronDrain: { limit: 10, windowMs: 60_000 } },
}))

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/**
 * One chain per table. Every chained method returns the same chain
 * object (so any call order the route uses resolves); `.single()`
 * and `.maybeSingle()` resolve `result` directly, and awaiting the
 * chain itself (no terminal method — e.g. a trailing `.update().eq()`
 * with nothing chained after) also resolves `result` via `.then`.
 */
function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    not: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    update: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    then: (resolve: (v: unknown) => void) => resolve(result),
  }
  return chain
}

const DUE_ROW = { id: 'ledger-1', message_id: 'msg-1', attempt_count: 0, classification: 'transient', created_at: new Date().toISOString() }

function makeAdmin(overrides: {
  due?: unknown[]
  ledgerClaim?: unknown
  message?: unknown
  conversation?: unknown
  whatsappConfig?: unknown
} = {}) {
  const {
    due = [DUE_ROW],
    ledgerClaim = { data: { id: DUE_ROW.id }, error: null },
    message = {
      data: {
        id: 'msg-1',
        conversation_id: 'conv-1',
        content_type: 'text',
        content_text: 'hi',
        media_url: null,
        template_name: null,
        reply_to_message_id: null,
        connection_ref: 'cfg-1',
        created_at: new Date().toISOString(),
      },
      error: null,
    },
    conversation = { data: { contact: { phone: '+5511999999999' } }, error: null },
    whatsappConfig = {
      data: { id: 'cfg-1', account_id: 'acct-1', provider: 'meta', access_token: 'enc', phone_number_id: '123' },
      error: null,
    },
  } = overrides

  const tables: Record<string, ReturnType<typeof makeChain>> = {
    outbound_retry_ledger: makeChain(ledgerClaim),
    messages: makeChain(message),
    conversations: makeChain(conversation),
    whatsapp_config: makeChain(whatsappConfig),
  }

  // The outer GET handler's initial "select due" query is a plain
  // await on the outbound_retry_ledger chain (no .single()), so it
  // resolves via `.then` — override that resolution to the `due`
  // list while keeping .maybeSingle() (used by the claim step inside
  // processDueEntry) resolving `ledgerClaim`.
  const ledgerChain = tables.outbound_retry_ledger as unknown as { then: (resolve: (v: unknown) => void) => void }
  ledgerChain.then = (resolve) => resolve({ data: due, error: null })

  return {
    from: vi.fn((table: string) => tables[table] ?? makeChain({ data: null, error: null })),
    _tables: tables,
  }
}

function req(secret: string | null): Request {
  const headers = new Headers()
  if (secret !== null) headers.set('x-cron-secret', secret)
  return new Request('http://localhost/api/whatsapp/delivery/cron', { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  mockDecrypt.mockImplementation((token: string) => `plaintext(${token})`)
  mockResolveSignedMediaUrl.mockImplementation(async (_admin: unknown, url: string) => url)
  mockGetProvider.mockReturnValue({
    sendText: vi.fn().mockResolvedValue({ messageId: 'wamid.1', externalIdentities: [] }),
    sendMedia: vi.fn().mockResolvedValue({ messageId: 'wamid.1', externalIdentities: [] }),
    sendTemplate: vi.fn().mockResolvedValue({ messageId: 'wamid.1', externalIdentities: [] }),
    classifySendFailure: vi.fn(),
    capabilities: { nativeIdempotency: false, deliveryReconciliation: false },
  })
  mockSettleMessageSystem.mockResolvedValue({ messageId: 'msg-1', outcome: 'sent' })
  mockCheckRateLimit.mockReturnValue({ success: true, remaining: 9, reset: 0, limit: 10 })
  mockRateLimitResponse.mockReturnValue(
    new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
  )
})

describe('GET /api/whatsapp/delivery/cron', () => {
  it('returns 503 when the cron secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const { GET } = await import('./route')
    const res = await GET(req('anything'))
    expect(res.status).toBe(503)
  })

  it('returns 401 when the supplied secret does not match', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('wrong-secret'))
    expect(res.status).toBe(401)
  })

  it('returns 429 when the cron drain rate limit is exceeded — F-INT-04', async () => {
    mockCheckRateLimit.mockReturnValue({ success: false, remaining: 0, reset: 0, limit: 10 })
    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    expect(res.status).toBe(429)
    expect(mockCheckRateLimit).toHaveBeenCalledWith('cron:whatsapp-delivery', { limit: 10, windowMs: 60_000 })
  })

  it('returns 401 when no secret is supplied', async () => {
    const { GET } = await import('./route')
    const res = await GET(req(null))
    expect(res.status).toBe(401)
  })

  it('returns processed:0, dead:0 when there are no due entries', async () => {
    const admin = makeAdmin({ due: [] })
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ processed: 0, dead: 0 })
  })

  // ─── S2 (plans/001-private-media-buckets-s2.md) — signed URL at dispatch ──

  it('resolves a signed URL and forwards it (not the raw media_url) when retrying a media send', async () => {
    const rawUrl = 'https://proj.supabase.co/storage/v1/object/public/chat-media/account-1/photo.png'
    const signedUrl = 'https://proj.supabase.co/storage/v1/object/sign/chat-media/account-1/photo.png?token=abc'
    mockResolveSignedMediaUrl.mockResolvedValueOnce(signedUrl)

    const sendMedia = vi.fn().mockResolvedValue({ messageId: 'wamid.media1', externalIdentities: [] })
    mockGetProvider.mockReturnValue({
      sendText: vi.fn(),
      sendMedia,
      sendTemplate: vi.fn(),
      classifySendFailure: vi.fn(),
      capabilities: { nativeIdempotency: false, deliveryReconciliation: false },
    })

    const admin = makeAdmin({
      message: {
        data: {
          id: 'msg-1',
          conversation_id: 'conv-1',
          content_type: 'image',
          content_text: null,
          media_url: rawUrl,
          template_name: null,
          reply_to_message_id: null,
          connection_ref: 'cfg-1',
          created_at: new Date().toISOString(),
        },
        error: null,
      },
    })
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ processed: 1, dead: 0 })
    expect(mockResolveSignedMediaUrl).toHaveBeenCalledWith(admin, rawUrl, 86400)
    expect(sendMedia).toHaveBeenCalledWith(expect.objectContaining({ link: signedUrl }))
  })

  it('forwards a non-bucket media_url unchanged (resolver pass-through) when retrying a media send', async () => {
    const inboundUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc123'
    const sendMedia = vi.fn().mockResolvedValue({ messageId: 'wamid.media2', externalIdentities: [] })
    mockGetProvider.mockReturnValue({
      sendText: vi.fn(),
      sendMedia,
      sendTemplate: vi.fn(),
      classifySendFailure: vi.fn(),
      capabilities: { nativeIdempotency: false, deliveryReconciliation: false },
    })

    const admin = makeAdmin({
      message: {
        data: {
          id: 'msg-1',
          conversation_id: 'conv-1',
          content_type: 'document',
          content_text: null,
          media_url: inboundUrl,
          template_name: null,
          reply_to_message_id: null,
          connection_ref: 'cfg-1',
          created_at: new Date().toISOString(),
        },
        error: null,
      },
    })
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ processed: 1, dead: 0 })
    expect(sendMedia).toHaveBeenCalledWith(expect.objectContaining({ link: inboundUrl }))
  })

  it('re-sends a plain text retry without touching the media-URL resolver', async () => {
    const admin = makeAdmin()
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ processed: 1, dead: 0 })
    expect(mockResolveSignedMediaUrl).not.toHaveBeenCalled()
  })
})
