import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// This file exercises the P0 attribution flow (ADR-ATTR-001 §8)
// end-to-end through the real POST handler, backed by a minimal
// in-memory Supabase double. It intentionally stays separate from
// route.test.ts (which stubs supabaseAdmin with an empty/static
// responder) so that file's existing coverage is untouched.
//
// POST hands inbound processing off fire-and-forget
// (`processWebhook(body).catch(...)`), so every test flushes the
// microtask queue after calling POST before asserting DB state. All
// "I/O" here is synchronous in-memory work, so a couple of ticks is
// enough — no real latency to wait out.
// ---------------------------------------------------------------

interface Row {
  [key: string]: unknown
}

function makeFakeSupabase() {
  const db: Record<string, Row[]> = {
    whatsapp_config: [],
    contacts: [],
    conversations: [],
    messages: [],
    lead_attributions: [],
    broadcast_recipients: [],
  }
  let counter = 0
  const genId = () => `gen-${++counter}`

  function from(table: string) {
    if (!db[table]) db[table] = []
    const eqFilters: Array<[string, unknown]> = []
    const isFilters: string[] = []
    let insertPayload: Row | null = null
    let updatePayload: Row | null = null
    let upsertPayload: { data: Row; onConflict?: string; ignoreDuplicates?: boolean } | null = null
    let countHead = false

    function applyFilters(rows: Row[]) {
      return rows.filter(
        (r) =>
          eqFilters.every(([f, v]) => r[f] === v) &&
          isFilters.every((f) => r[f] === null || r[f] === undefined),
      )
    }

    function resolve(): { data: Row | Row[] | null; count?: number; error: null } {
      if (insertPayload) {
        const row: Row = { id: genId(), created_at: new Date().toISOString(), ...insertPayload }
        db[table].push(row)
        return { data: [row], error: null }
      }
      if (upsertPayload) {
        const fields = (upsertPayload.onConflict ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const existing = fields.length
          ? db[table].find((r) => fields.every((f) => r[f] === upsertPayload!.data[f]))
          : undefined
        if (existing) {
          if (upsertPayload.ignoreDuplicates) {
            // ON CONFLICT ... DO NOTHING — mirrors Postgres: the
            // existing row is untouched and no row is returned.
            return { data: [], error: null }
          }
          Object.assign(existing, upsertPayload.data)
          return { data: [existing], error: null }
        }
        const row: Row = { id: genId(), created_at: new Date().toISOString(), ...upsertPayload.data }
        db[table].push(row)
        return { data: [row], error: null }
      }
      if (updatePayload) {
        const matched = applyFilters(db[table])
        matched.forEach((r) => Object.assign(r, updatePayload))
        return { data: matched, error: null }
      }
      const rows = applyFilters(db[table])
      if (countHead) return { data: null, count: rows.length, error: null }
      return { data: rows, error: null }
    }

    const builder = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (opts?.head) countHead = true
        return builder
      },
      eq: (f: string, v: unknown) => {
        eqFilters.push([f, v])
        return builder
      },
      is: (f: string, v: unknown) => {
        if (v === null) isFilters.push(f)
        return builder
      },
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      insert: (payload: Row) => {
        insertPayload = payload
        return builder
      },
      update: (payload: Row) => {
        updatePayload = payload
        return builder
      },
      upsert: (payload: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        upsertPayload = {
          data: payload,
          onConflict: opts?.onConflict,
          ignoreDuplicates: opts?.ignoreDuplicates,
        }
        return builder
      },
      maybeSingle: async () => {
        const { data } = resolve()
        const arr = data as Row[]
        return { data: arr[0] ?? null, error: null }
      },
      single: async () => {
        const { data } = resolve()
        const arr = data as Row[]
        return arr[0]
          ? { data: arr[0], error: null }
          : { data: null, error: { message: 'no rows' } }
      },
      // Awaited directly (no .single()/.maybeSingle()) — e.g. the
      // messages count query, plain inserts/updates.
      then: (resolveFn: (v: unknown) => void) => resolveFn(resolve()),
    }

    return builder
  }

  async function rpc(fn: string, params: Record<string, unknown>) {
    if (fn === 'insert_inbound_message') {
      const messageId = params.p_message_id as string | undefined
      if (messageId) {
        const existing = db.messages.find((r) => r.message_id === messageId)
        if (existing) return { data: null, error: null }
      }
      const row: Row = {
        id: genId(),
        created_at: new Date().toISOString(),
        conversation_id: params.p_conversation_id,
        sender_type: params.p_sender_type,
        content_type: params.p_content_type,
        content_text: params.p_content_text,
        media_url: params.p_media_url,
        message_id: messageId ?? null,
        status: params.p_status,
        reply_to_message_id: params.p_reply_to_message_id ?? null,
        interactive_reply_id: params.p_interactive_reply_id ?? null,
      }
      db.messages.push(row)
      return { data: row.id, error: null }
    }
    if (fn === 'insert_lead_attribution') {
      const row: Row = { id: genId(), created_at: new Date().toISOString() }
      for (const [k, v] of Object.entries(params)) {
        if (k.startsWith('p_')) row[k.slice(2)] = v
      }
      const existing = db.lead_attributions.find(
        (r) => r.origin_message_id === row.origin_message_id,
      )
      if (existing) return { data: null, error: null }
      db.lead_attributions.push(row)
      return { data: row.id, error: null }
    }
    return { data: null, error: null }
  }

  return { from, db, rpc }
}

let fakeSupabase: ReturnType<typeof makeFakeSupabase>

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

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'decrypted-value'),
  encrypt: vi.fn(() => 'encrypted-value'),
  isLegacyFormat: vi.fn(() => false),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  normalizePhone: (p: string) => p.replace(/\D/g, ''),
}))

const mockFindExistingContact = vi.fn()
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: (...args: unknown[]) => mockFindExistingContact(...args),
  isUniqueViolation: () => false,
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  handleTemplateWebhookChange: vi.fn(),
  isTemplateWebhookField: vi.fn(() => false),
}))

function postRequest(body: string): Request {
  return new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
}

function inboundBody(message: Record<string, unknown>) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'wa-account',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: '123' },
              contacts: [{ profile: { name: 'Alice' }, wa_id: '15559876543' }],
              messages: [message],
            },
            field: 'messages',
          },
        ],
      },
    ],
  })
}

async function flush() {
  // A couple of microtask/macrotask ticks — enough for the
  // fire-and-forget processWebhook(body).catch(...) chain (all
  // in-memory, synchronous "I/O") to settle.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckRateLimit.mockReturnValue({ success: true, remaining: 99, reset: 0, limit: 999 })
  mockRateLimitResponse.mockReturnValue(new Response(null, { status: 429 }))
  mockVerifyMetaWebhookSignature.mockReturnValue(true)
  mockFindExistingContact.mockResolvedValue(null)

  fakeSupabase = makeFakeSupabase()
  fakeSupabase.db.whatsapp_config.push({
    id: 'cfg-1',
    account_id: 'acc-1',
    user_id: 'user-1',
    access_token: 'enc-token',
    phone_number_id: '123',
  })
  mockSupabaseAdmin.mockReturnValue(fakeSupabase)
})

describe('POST /api/whatsapp/webhook — lead attribution (ADR-ATTR-001 P0)', () => {
  it('captures referral on the first CTWA message: attribution created, linked to the conversation, first-touch stamped on the contact', async () => {
    const { POST } = await import('./route')

    const res = await POST(
      postRequest(
        inboundBody({
          from: '15559876543',
          id: 'wamid.1',
          timestamp: '1710000000',
          type: 'text',
          text: { body: 'Hi, I saw your ad' },
          referral: {
            source_id: 'ad-123',
            source_type: 'ad',
            headline: '20% off',
            body: 'Book now',
            ctwa_clid: 'clid-abc',
          },
        }),
      ),
    )
    expect(res.status).toBe(200)
    await flush()

    expect(fakeSupabase.db.lead_attributions).toHaveLength(1)
    const attribution = fakeSupabase.db.lead_attributions[0]
    expect(attribution.source_channel).toBe('ctwa_meta')
    expect(attribution.ad_headline).toBe('20% off')

    expect(fakeSupabase.db.conversations).toHaveLength(1)
    expect(fakeSupabase.db.conversations[0].attribution_id).toBe(attribution.id)

    expect(fakeSupabase.db.contacts).toHaveLength(1)
    expect(fakeSupabase.db.contacts[0].first_attribution_id).toBe(attribution.id)
    expect(fakeSupabase.db.contacts[0].first_source_channel).toBe('ctwa_meta')
  })

  it('is idempotent on the wamid: the same webhook delivered twice yields a single lead_attributions row', async () => {
    const { POST } = await import('./route')
    const body = inboundBody({
      from: '15559876543',
      id: 'wamid.1',
      timestamp: '1710000000',
      type: 'text',
      text: { body: 'Hi' },
      referral: { source_id: 'ad-123', ctwa_clid: 'clid-abc' },
    })

    await POST(postRequest(body))
    await flush()
    // Same delivery, replayed by Meta after a timeout / retry.
    await POST(postRequest(body))
    await flush()

    expect(fakeSupabase.db.lead_attributions).toHaveLength(1)
  })

  it('is idempotent on the wamid even when ctwa_clid is NULL on every delivery — the reason ctwa_clid cannot be the conflict key (Postgres never treats two NULLs as colliding)', async () => {
    const { POST } = await import('./route')
    const body = inboundBody({
      from: '15559876543',
      id: 'wamid.1',
      timestamp: '1710000000',
      type: 'text',
      text: { body: 'Hi' },
      // No ctwa_clid — a real shape Meta sends for some referral types.
      referral: { source_id: 'ad-123' },
    })

    await POST(postRequest(body))
    await flush()
    await POST(postRequest(body))
    await flush()

    expect(fakeSupabase.db.lead_attributions).toHaveLength(1)
  })

  it('preserves first-touch and records a new attribution on a later distinct CTWA click', async () => {
    const { POST } = await import('./route')

    // First inbound message — opens the conversation via a CTWA ad.
    await POST(
      postRequest(
        inboundBody({
          from: '15559876543',
          id: 'wamid.1',
          timestamp: '1710000000',
          type: 'text',
          text: { body: 'Hi' },
          referral: { source_id: 'ad-1', ctwa_clid: 'clid-1' },
        }),
      ),
    )
    await flush()

    // The contact now exists — subsequent lookups must find it (this
    // is exactly what findExistingContact does in production; the
    // mock has to mirror that or the second message would create a
    // duplicate contact instead of reusing the conversation).
    const existingContact = fakeSupabase.db.contacts[0]
    mockFindExistingContact.mockResolvedValue(existingContact)

    // Second inbound message on the same thread — a later CTWA click
    // on a different ad brought the contact back.
    await POST(
      postRequest(
        inboundBody({
          from: '15559876543',
          id: 'wamid.2',
          timestamp: '1710000100',
          type: 'text',
          text: { body: 'Still interested' },
          referral: { source_id: 'ad-2', ctwa_clid: 'clid-2' },
        }),
      ),
    )
    await flush()

    expect(fakeSupabase.db.lead_attributions).toHaveLength(2)
    const [first, second] = fakeSupabase.db.lead_attributions

    // Conversation now points at the most recent touch.
    expect(fakeSupabase.db.conversations[0].attribution_id).toBe(second.id)
    // Contact's first-touch is untouched from the first message.
    expect(fakeSupabase.db.contacts[0].first_attribution_id).toBe(first.id)
  })

  it('does not create an attribution when the message carries no referral', async () => {
    const { POST } = await import('./route')
    await POST(
      postRequest(
        inboundBody({
          from: '15559876543',
          id: 'wamid.1',
          timestamp: '1710000000',
          type: 'text',
          text: { body: 'Just a regular reply' },
        }),
      ),
    )
    await flush()

    expect(fakeSupabase.db.lead_attributions).toHaveLength(0)
    expect(fakeSupabase.db.conversations[0]?.attribution_id ?? null).toBeNull()
    expect(fakeSupabase.db.contacts[0]?.first_attribution_id ?? null).toBeNull()
  })
})
