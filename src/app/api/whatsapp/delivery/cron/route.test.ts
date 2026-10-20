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
// Only `getProvider` is replaced: `providerConfigFromRow` and
// `ProviderUnsupportedError` stay real so provider selection is exercised.
vi.mock('@/lib/whatsapp/providers', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/whatsapp/providers')>()),
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

// The identity the retry gate verifies. The binding is built with the real
// helper (the same one createIntent uses), so a fixture can never drift from
// the writer's format; the helper itself is pinned by known-answer tests in
// connection-binding.test.ts.
import { bindingFromConnection } from '@/lib/whatsapp/delivery/connection-binding'

const CFG_ID = '00000000-0000-4000-8000-0000000000c1'
const metaCfg = { id: CFG_ID, account_id: 'acct-1', provider: 'meta', access_token: 'enc', phone_number_id: '123', instance_id: null, base_url: null }
const uaCfg = { id: CFG_ID, account_id: 'acct-1', provider: 'uazapi', access_token: 'enc', phone_number_id: 'inst', instance_id: 'inst', base_url: 'https://u.uazapi.dev' }
const bindingOf = (cfg: Parameters<typeof bindingFromConnection>[0]) => {
  const b = bindingFromConnection(cfg)
  return { connection_ref: b.connection_ref, delivery_provider: b.delivery_provider, delivery_channel_fp: b.delivery_channel_fp }
}
const BINDING_FIELDS = bindingOf(metaCfg)
const msgRow = (extra: Record<string, unknown> = BINDING_FIELDS, more: Record<string, unknown> = {}) => ({
  data: {
    id: 'msg-1', conversation_id: 'conv-1', content_type: 'text', content_text: 'hi', media_url: null,
    template_name: null, reply_to_message_id: null, ...extra, ...more, created_at: new Date().toISOString(),
  },
  error: null,
})
const convRow = (accountId: string | null = 'acct-1') => ({ data: { account_id: accountId, contact: { phone: '+5511999999999' } }, error: null })

// `deterministic_transient` is the ledger classification that is evidence of
// non-delivery; it is the happy path of every test that expects a send.
const DUE_ROW = { id: 'ledger-1', message_id: 'msg-1', attempt_count: 0, classification: 'deterministic_transient', created_at: new Date().toISOString() }

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
    message = msgRow(),
    conversation = convRow(),
    whatsappConfig = { data: metaCfg, error: null },
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

  it('blocks (does not dead-letter or re-send) a retry whose connection now uses the removed zapi provider', async () => {
    const admin = makeAdmin({
      whatsappConfig: {
        data: { ...metaCfg, provider: 'zapi', instance_id: 'inst-1', phone_number_id: 'inst-1' },
        error: null,
      },
    })
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ processed: 1, dead: 0 })
    expect(mockGetProvider).not.toHaveBeenCalled()
    expect(mockSettleMessageSystem).not.toHaveBeenCalled()
    const ledger = admin._tables.outbound_retry_ledger as unknown as { update: ReturnType<typeof vi.fn> }
    // pending + next_attempt_at NULL = ADR-E4B-002 §5 caminho D (only the TTL resolves it)
    expect(ledger.update).toHaveBeenCalledWith({
      status: 'pending',
      next_attempt_at: null,
      last_error: 'blocked (provider_unsupported): the connection now uses "zapi", which is not supported',
    })
    expect(ledger.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'dead' }))
  })

  // ─── Lookup errors are not "not found" ─────────────────────────────────
  // A failed query (e.g. `messages.connection_ref` does not exist in the
  // database) must never be read as "the message does not exist" and must not
  // dead-letter the entry. Only PGRST116 (`.single()` with no row) is absence.

  const ledgerUpdates = (admin: ReturnType<typeof makeAdmin>) =>
    (admin._tables.outbound_retry_ledger as unknown as { update: ReturnType<typeof vi.fn> }).update.mock.calls.map((c) => c[0] as Record<string, unknown>)

  it('message lookup fails with an incompatible schema (42703): entry released as pending, NOT dead-lettered, nothing sent or settled', async () => {
    const admin = makeAdmin({
      message: { data: null, error: { code: '42703', message: 'column messages.connection_ref does not exist' } },
    })
    mockSupabaseAdmin.mockReturnValue(admin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))

    expect(await res.json()).toEqual({ processed: 0, dead: 0 })
    expect(mockGetProvider).not.toHaveBeenCalled()
    expect(mockSettleMessageSystem).not.toHaveBeenCalled()
    const updates = ledgerUpdates(admin)
    expect(updates.some((u) => u.status === 'dead')).toBe(false)
    expect(updates).toContainEqual({
      status: 'pending',
      last_error: 'message lookup failed (42703): column messages.connection_ref does not exist — not dead-lettered',
    })
    // `next_attempt_at` is not rewritten: the entry stays due and is retried by the next run
    expect(updates.every((u) => !('next_attempt_at' in u))).toBe(true)
    const ledger = admin._tables.outbound_retry_ledger as unknown as { eq: ReturnType<typeof vi.fn> }
    expect(ledger.eq).toHaveBeenCalledWith('status', 'retrying') // guard against overwriting a row another worker moved
  })

  it.each([
    ['a permission error', { code: '42501', message: 'permission denied for table messages' }],
    ['a network failure (no code)', { message: 'fetch failed' }],
  ])('message lookup fails with %s: released, not dead-lettered', async (_n, error) => {
    const admin = makeAdmin({ message: { data: null, error } })
    mockSupabaseAdmin.mockReturnValue(admin)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { GET } = await import('./route')
    expect(await (await GET(req('test-secret'))).json()).toEqual({ processed: 0, dead: 0 })
    expect(ledgerUpdates(admin).some((u) => u.status === 'dead')).toBe(false)
  })

  it('conversation lookup failing is not "contact phone not found": released, not dead-lettered; a really missing recipient still is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = makeAdmin({ conversation: { data: null, error: { code: '42P01', message: 'relation "conversations" does not exist' } } })
    mockSupabaseAdmin.mockReturnValue(failing)
    const { GET } = await import('./route')
    expect(await (await GET(req('test-secret'))).json()).toEqual({ processed: 0, dead: 0 })
    expect(ledgerUpdates(failing).some((u) => u.status === 'dead')).toBe(false)
    expect(String(ledgerUpdates(failing).at(-1)?.last_error)).toContain('conversation lookup failed (42P01)')

    const noPhone = makeAdmin({ conversation: { data: { contact: null }, error: null } })
    mockSupabaseAdmin.mockReturnValue(noPhone)
    expect(await (await GET(req('test-secret'))).json()).toEqual({ processed: 0, dead: 1 })
    expect(ledgerUpdates(noPhone)).toContainEqual({ status: 'dead', last_error: 'contact phone not found' })
  })

  it('a message that is really absent (PGRST116) is still dead-lettered, as before', async () => {
    const admin = makeAdmin({
      message: { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
    })
    mockSupabaseAdmin.mockReturnValue(admin)
    const { GET } = await import('./route')
    expect(await (await GET(req('test-secret'))).json()).toEqual({ processed: 0, dead: 1 })
    expect(ledgerUpdates(admin)).toContainEqual({
      status: 'dead',
      last_error: 'message not found: JSON object requested, multiple (or no) rows returned',
    })
  })

  it('no row and no error (defensive) is treated as absent', async () => {
    const admin = makeAdmin({ message: { data: null, error: null } })
    mockSupabaseAdmin.mockReturnValue(admin)
    const { GET } = await import('./route')
    expect(await (await GET(req('test-secret'))).json()).toEqual({ processed: 0, dead: 1 })
  })


  it('provider config lookup error is released, not dead-lettered', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = makeAdmin({ whatsappConfig: { data: null, error: { code: '57P01', message: 'terminating connection' } } })
    mockSupabaseAdmin.mockReturnValue(failing)
    const { GET } = await import('./route')
    expect(await (await GET(req('test-secret'))).json()).toEqual({ processed: 0, dead: 0 })
    expect(ledgerUpdates(failing).some((u) => u.status === 'dead')).toBe(false)
    expect(ledgerUpdates(failing)).toContainEqual({
      status: 'pending',
      last_error: 'provider config lookup failed (57P01): terminating connection — not dead-lettered',
    })

  })

  it('a failure of the release itself does not throw out of the run and does not dead-letter (the stuck-retrying reclaim recovers it)', async () => {
    const admin = makeAdmin({ message: { data: null, error: { code: '42703', message: 'column does not exist' } } })
    // The claim (maybeSingle) must succeed, the release (awaited update) must fail.
    const ledgerChain = admin._tables.outbound_retry_ledger as unknown as { then: (r: (v: unknown) => void) => void; update: ReturnType<typeof vi.fn> }
    let releasing = false
    ledgerChain.update.mockImplementation(((payload: Record<string, unknown>) => {
      releasing = payload.status === 'pending'
      return ledgerChain
    }) as never)
    ledgerChain.then = (resolve) => resolve(releasing ? { data: null, error: { message: 'db down' } } : { data: [DUE_ROW], error: null })
    mockSupabaseAdmin.mockReturnValue(admin)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))

    expect(res.status).toBe(200)
    expect(JSON.stringify(spy.mock.calls)).toContain('release failed')
    expect(await res.json()).toEqual({ processed: 0, dead: 0 })
  })

  it.each([
    ['meta', metaCfg],
    ['uazapi', uaCfg],
  ])('%s happy path is unchanged: a bound message whose channel is proved is retried and settled', async (_p, cfg) => {
    const admin = makeAdmin({ message: msgRow(bindingOf(cfg)), whatsappConfig: { data: cfg, error: null } })
    mockSupabaseAdmin.mockReturnValue(admin)
    const { GET } = await import('./route')
    expect(await (await GET(req('test-secret'))).json()).toEqual({ processed: 1, dead: 0 })
    expect(mockGetProvider).toHaveBeenCalledTimes(1)
    expect(mockGetProvider.mock.calls[0][0]).toMatchObject({ provider: cfg.provider })
    expect(mockSettleMessageSystem).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'sent', CFG_ID, expect.anything(), 'wamid.1')
  })

  // ─── Delivery identity gate ─────────────────────────────────────────────
  // Nothing is sent unless the connection that exists NOW is provably the
  // channel the message was created for. Every failure is a BLOCK (pending,
  // next_attempt_at NULL, reason), never a send and never `dead`.

  const run = async (admin: ReturnType<typeof makeAdmin>) => {
    mockSupabaseAdmin.mockReturnValue(admin)
    const { GET } = await import('./route')
    return (await GET(req('test-secret'))).json()
  }
  const expectBlocked = (admin: ReturnType<typeof makeAdmin>, reason: string) => {
    expect(mockGetProvider).not.toHaveBeenCalled()
    expect(mockSettleMessageSystem).not.toHaveBeenCalled()
    const updates = ledgerUpdates(admin)
    expect(updates.some((u) => u.status === 'dead')).toBe(false)
    expect(updates).toContainEqual(expect.objectContaining({ status: 'pending', next_attempt_at: null }))
    expect(String(updates.at(-1)?.last_error)).toContain(`blocked (${reason})`)
  }

  it.each([
    ['meta → uazapi (account switched provider after the message was created)', metaCfg, uaCfg, 'provider_changed'],
    ['uazapi → meta', uaCfg, metaCfg, 'provider_changed'],
  ])('%s: blocked, nothing sent', async (_n, createdFor, now, reason) => {
    const admin = makeAdmin({ message: msgRow(bindingOf(createdFor)), whatsappConfig: { data: now, error: null } })
    expect(await run(admin)).toEqual({ processed: 1, dead: 0 })
    expectBlocked(admin, reason)
  })

  it.each([
    ['another WhatsApp number (phone_number_id) on the same Meta slot', metaCfg, { ...metaCfg, phone_number_id: '999' }],
    ['another uazapi instance', uaCfg, { ...uaCfg, instance_id: 'other', phone_number_id: 'other' }],
    ['another uazapi base_url', uaCfg, { ...uaCfg, base_url: 'https://elsewhere.uazapi.dev' }],
  ])('%s: blocked as channel_changed', async (_n, createdFor, now) => {
    const admin = makeAdmin({ message: msgRow(bindingOf(createdFor)), whatsappConfig: { data: now, error: null } })
    await run(admin)
    expectBlocked(admin, 'channel_changed')
  })

  it('a rotated token on the SAME channel does not block (the fingerprint holds no secret)', async () => {
    const admin = makeAdmin({
      message: msgRow(bindingOf(metaCfg)),
      whatsappConfig: { data: { ...metaCfg, access_token: 'enc-rotated' }, error: null },
    })
    expect(await run(admin)).toEqual({ processed: 1, dead: 0 })
    expect(mockSettleMessageSystem).toHaveBeenCalledTimes(1)
  })

  it('cosmetic changes of the uazapi URL (case, trailing slash) do not block', async () => {
    const admin = makeAdmin({
      message: msgRow(bindingOf(uaCfg)),
      whatsappConfig: { data: { ...uaCfg, base_url: 'HTTPS://U.UAZAPI.DEV/' }, error: null },
    })
    expect(await run(admin)).toEqual({ processed: 1, dead: 0 })
  })

  it('connection removed: blocked as connection_removed (not dead, not sent)', async () => {
    const admin = makeAdmin({ whatsappConfig: { data: null, error: null } })
    await run(admin)
    expectBlocked(admin, 'connection_removed')
  })

  it('conversation of ANOTHER account: blocked as account_mismatch — the connection is never used', async () => {
    const admin = makeAdmin({ conversation: convRow('acct-OTHER') })
    await run(admin)
    expectBlocked(admin, 'account_mismatch')
  })

  it('a conversation without account_id is not trusted: blocked as account_mismatch', async () => {
    const admin = makeAdmin({ conversation: convRow(null) })
    await run(admin)
    expectBlocked(admin, 'account_mismatch')
  })

  it.each([
    ['all three fields NULL (legacy message)', { connection_ref: null, delivery_provider: null, delivery_channel_fp: null }, 'binding_missing'],
    ['no fields at all (column absent from the row)', {}, 'binding_missing'],
    ['connection_ref only (the pre-binding shape)', { connection_ref: CFG_ID }, 'binding_invalid'],
    ['delivery_provider missing', { ...BINDING_FIELDS, delivery_provider: null }, 'binding_invalid'],
    ['fingerprint malformed', { ...BINDING_FIELDS, delivery_channel_fp: 'not-a-fingerprint' }, 'binding_invalid'],
    ['fingerprint of an unknown version', { ...BINDING_FIELDS, delivery_channel_fp: `v9:${'a'.repeat(64)}` }, 'binding_invalid'],
    ['recorded provider unsupported', { ...BINDING_FIELDS, delivery_provider: 'zapi' }, 'binding_invalid'],
    ['connection_ref not a uuid', { ...BINDING_FIELDS, connection_ref: 'cfg-1' }, 'binding_invalid'],
  ])('%s: blocked as %s without even looking the connection up', async (_n, fields, reason) => {
    const admin = makeAdmin({ message: msgRow(fields as Record<string, unknown>) })
    await run(admin)
    expectBlocked(admin, reason)
    expect((admin.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).not.toContain('whatsapp_config')
  })

  it('a connection whose data no longer proves the channel is blocked as channel_unprovable', async () => {
    const admin = makeAdmin({ whatsappConfig: { data: { ...metaCfg, phone_number_id: '' }, error: null } })
    await run(admin)
    expectBlocked(admin, 'channel_unprovable')
  })

  // ─── Evidence of non-delivery ───────────────────────────────────────────
  it.each(['ambiguous', 'deterministic_permanent'])('ledger classification %s without native idempotency: blocked, never re-sent', async (classification) => {
    const admin = makeAdmin({ due: [{ ...DUE_ROW, classification }] })
    await run(admin)
    // the provider adapter is built only to read its declared capabilities; it is never asked to send
    const provider = mockGetProvider.mock.results[0].value as { sendText: ReturnType<typeof vi.fn> }
    expect(provider.sendText).not.toHaveBeenCalled()
    expect(mockSettleMessageSystem).not.toHaveBeenCalled()
    const updates = ledgerUpdates(admin)
    expect(updates.some((u) => u.status === 'dead')).toBe(false)
    expect(updates).toContainEqual(expect.objectContaining({ status: 'pending', next_attempt_at: null }))
    expect(String(updates.at(-1)?.last_error)).toContain('blocked (no_evidence_of_non_delivery)')
  })

  it('an ambiguous entry IS re-sent only when the provider really declares native idempotency', async () => {
    mockGetProvider.mockReturnValue({
      sendText: vi.fn().mockResolvedValue({ messageId: 'wamid.1', externalIdentities: [] }),
      classifySendFailure: vi.fn(),
      capabilities: { nativeIdempotency: true, deliveryReconciliation: false },
    })
    const admin = makeAdmin({ due: [{ ...DUE_ROW, classification: 'ambiguous' }] })
    expect(await run(admin)).toEqual({ processed: 1, dead: 0 })
    expect(mockSettleMessageSystem).toHaveBeenCalledTimes(1)
  })

  // ─── Concurrency ────────────────────────────────────────────────────────
  it('two concurrent runs over the same due entry: the claim lets exactly one send', async () => {
    const admin = makeAdmin()
    const ledger = admin._tables.outbound_retry_ledger as unknown as { maybeSingle: ReturnType<typeof vi.fn> }
    let claims = 0
    ledger.maybeSingle.mockImplementation(() => Promise.resolve(++claims === 1 ? { data: { id: DUE_ROW.id }, error: null } : { data: null, error: null }))
    mockSupabaseAdmin.mockReturnValue(admin)
    const { GET } = await import('./route')
    const [a, b] = await Promise.all([GET(req('test-secret')), GET(req('test-secret'))])
    const results = [await a.json(), await b.json()]
    expect(results.map((r) => r.processed).sort()).toEqual([0, 1])
    expect(mockSettleMessageSystem).toHaveBeenCalledTimes(1)
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
          ...BINDING_FIELDS,
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
          ...BINDING_FIELDS,
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
