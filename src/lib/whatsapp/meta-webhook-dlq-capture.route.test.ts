import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================
// C6.2 — inbound DLQ CAPTURE through the REAL Meta webhook route.
//
// H6: the Meta route returns 200 only after a durable message+job pair.
// A persistence failure is still captured in the DLQ (diagnostic, not replay)
// and the HTTP status is 500 so the provider can redeliver. Only I/O is mocked;
// engines are mocked solely to prove they are never executed by the capture
// path.
// =============================================================

type InsertMode = 'ok' | 'dup' | 'error' | 'reject'

const S = {
  configRows: [] as Array<Record<string, unknown>>,
  contactFails: false,
  conversationFails: false,
  insertModeFor: ((): InsertMode => 'ok') as (id: string) => InsertMode,
  enqueueMode: 'ok' as 'ok' | 'error' | 'reject',
  lastMessageId: null as string | null,
  lastInserted: false,
  lastContext: null as Record<string, unknown> | null,
  postInsertFlowThrows: false,
  decryptFails: false,
  configError: false,
}
const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = []

const CFG = { id: 'cfg-1', account_id: 'acc-1', user_id: 'user-1', phone_number_id: 'pn-1', access_token: 'enc' }

function makeChain(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = { __table: table }
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'single', 'is', 'not', 'gte', 'lt', 'head', 'maybeSingle']) {
    chain[m] = vi.fn(() => chain)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.then = (resolve: (v: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let error: any = null
    if (table === 'whatsapp_config') {
      if (S.configError) error = { code: '57P01', message: 'config lookup failed 5511999887766' }
      else data = S.configRows
    }
    else if (table === 'conversations') {
      if (S.conversationFails) error = { code: '57P01', message: 'conv db down 5511999887766' }
      else data = { id: 'conv-1', unread_count: 0 }
    }     else if (table === 'contacts') {
      if (S.contactFails) error = { code: '23502', message: 'null value 5511999887766' }
      else data = { id: 'contact-1', name: 'Bob' }
    } else if (table === 'messages') {
      data = S.lastMessageId ? { id: S.lastMessageId, count: 0 } : { count: 0 }
    } else if (table === 'inbound_turn_jobs') {
      data = S.lastContext ? { downstream_context: S.lastContext } : null
    } else data = { count: 0 }
    resolve({ data, error })
    return Promise.resolve({ data, error })
  }
  return chain
}

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => makeChain(t),
    rpc: (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params })
      if (fn === 'persist_inbound_message_with_turn' || fn === 'insert_inbound_message') {
        const mode = S.insertModeFor(String(params.p_message_id))
        if (mode === 'reject') return Promise.reject(new Error('network down 5511999887766'))
        if (mode === 'error') return Promise.resolve({ data: null, error: { code: '57P01', message: 'db unavailable Key (phone)=(5511999887766)' } })
        if (mode === 'dup') {
          S.lastInserted = false
          S.lastMessageId = 'existing-dup'
          return Promise.resolve({ data: { message_id: 'existing-dup', message_inserted: false, job_ready: true }, error: null })
        }
        const id = `id-${rpcCalls.length}`
        S.lastMessageId = id
        S.lastInserted = true
        S.lastContext = (params.p_downstream_context as Record<string, unknown>) ?? {
          accountId: 'acc-1', contactId: 'contact-1', conversationId: 'conv-1',
          configOwnerUserId: 'user-1', inboundText: 'x', inboundType: 'text',
          externalMessageId: String(params.p_message_id), isFirstInboundMessage: false,
          contactWasCreated: false, lastMessagePreview: 'x', unreadCountBefore: 0,
        }
        return Promise.resolve({ data: { message_id: id, message_inserted: true, job_ready: true }, error: null })
      }
      if (fn === 'claim_inbound_turn_for_message') {
        if (!S.lastInserted || !S.lastMessageId) return Promise.resolve({ data: [], error: null })
        return Promise.resolve({
          data: [{ message_id: S.lastMessageId, account_id: 'acc-1', contact_id: 'contact-1', conversation_id: 'conv-1', claim_token: 'tok' }],
          error: null,
        })
      }
      if (fn === 'complete_inbound_turn_job') return Promise.resolve({ data: true, error: null })
      if (fn === 'enqueue_webhook_dlq') {
        if (S.enqueueMode === 'reject') return Promise.reject(new Error('enqueue down'))
        if (S.enqueueMode === 'error') return Promise.resolve({ data: null, error: { code: '42501', message: 'ownership' } })
        return Promise.resolve({ data: `dlq-${rpcCalls.length}`, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => v,
  decryptWithBindingContext: (v: string) => {
    if (S.decryptFails) throw new Error('bad key / ciphertext 5511999887766')
    return v
  },
  encryptWithBindingContext: (v: string) => v, isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: () => ({}), isWhatsappConfigCanonicalWriteEnabled: () => false,
}))
vi.mock('@/lib/crypto/kidConvergence', () => ({ needsKidConvergence: () => false, getCurrentWriteKid: () => 'k1' }))
vi.mock('@/lib/whatsapp/meta-api', () => ({ getMediaUrl: vi.fn(async () => ({})) }))
vi.mock('@/lib/whatsapp/phone-utils', () => ({ normalizePhone: (p: string) => p.replace(/\D/g, '') }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null), isUniqueViolation: vi.fn(() => false),
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: vi.fn(() => true) }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }), rateLimitResponse: () => new Response('rl', { status: 429 }),
  RATE_LIMITS: { webhookVerify: {}, webhookInbound: {} },
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  handleTemplateWebhookChange: vi.fn(), isTemplateWebhookField: () => false,
}))
vi.mock('@/lib/whatsapp/attribution', () => ({ persistAttribution: vi.fn(async () => undefined) }))

const mockFlows = vi.fn(async () => {
  if (S.postInsertFlowThrows) throw new Error('flow boom after insert')
  return { consumed: false }
})
const mockAutomations = vi.fn()
const mockCadences = vi.fn(async () => 0)
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: (...a: unknown[]) => (mockFlows as (...x: unknown[]) => unknown)(...a) }))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: (...a: unknown[]) => (mockAutomations as (...x: unknown[]) => unknown)(...a),
  cancelPendingCadencesForContact: (...a: unknown[]) => (mockCadences as (...x: unknown[]) => unknown)(...a),
}))

const { POST } = await import('@/app/api/whatsapp/webhook/route')
const { verifyMetaWebhookSignature } = await import('@/lib/whatsapp/webhook-signature')

const metaMsg = (id: string, extra: Record<string, unknown> = {}) => ({
  id, from: '5511999887766', timestamp: '1710000000', type: 'text',
  text: { body: 'meu cpf 123.456.789-00' }, ...extra,
})
function body(messages: unknown[], contacts: unknown[] = [{ profile: { name: 'Maria Silva' }, wa_id: '5511999887766' }]) {
  return {
    entry: [{ id: 'e1', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: 'pn-1' },
      contacts, messages,
    } }] }],
  }
}
async function post(b: unknown) {
  const res = await POST(new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }))
  // processWebhook runs after the 200 ack — let it drain (no real timers inside).
  await new Promise((r) => setTimeout(r, 40))
  return { status: res.status, json: await res.json() }
}
const dlq = () => rpcCalls.filter((c) => c.fn === 'enqueue_webhook_dlq')
const inserts = () => rpcCalls.filter((c) => c.fn === 'persist_inbound_message_with_turn' || c.fn === 'insert_inbound_message')
const noEnginesRan = () => {
  expect(mockFlows).not.toHaveBeenCalled()
  expect(mockAutomations).not.toHaveBeenCalled()
  expect(mockCadences).not.toHaveBeenCalled()
}

beforeEach(() => {
  rpcCalls.length = 0
  vi.clearAllMocks()
  vi.mocked(verifyMetaWebhookSignature).mockReturnValue(true)
  S.configRows = [CFG]
  S.contactFails = false
  S.conversationFails = false
  S.insertModeFor = () => 'ok'
  S.enqueueMode = 'ok'
  S.postInsertFlowThrows = false
  S.lastMessageId = null
  S.lastInserted = false
  S.lastContext = null
  S.decryptFails = false
  S.configError = false
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('C6.2 Meta route: persistence failure is captured per message', () => {
  it.each([
    ['message_insert', () => { S.insertModeFor = () => 'error' }, 'message_insert', 'db_code=57P01'],
    ['contact', () => { S.contactFails = true }, 'contact', 'db_code=23502'],
    ['conversation', () => { S.conversationFails = true }, 'conversation', 'db_code=57P01'],
  ])('%s failure → one enqueue scoped to the resolved config; HTTP 500; no engine ran', async (_n, arrange, stage, codePart) => {
    arrange()
    const { status, json } = await post(body([metaMsg('wamid.A1')]))
    expect(status).toBe(500)
    expect(json).toEqual({ error: 'Inbound persistence incomplete' })
    expect(dlq()).toHaveLength(1)
    expect(dlq()[0].params).toMatchObject({ p_account_id: 'acc-1', p_whatsapp_config_id: 'cfg-1' })
    const payload = dlq()[0].params.p_payload as { stage: string; source: string; external_message_id: string }
    expect(payload).toMatchObject({ stage, source: 'meta', external_message_id: 'wamid.A1' })
    expect(String(dlq()[0].params.p_error_message)).toContain(codePart)
    noEnginesRan()
  })

  it('an unexpected exception (no contacts entry) is captured as stage "unexpected"', async () => {
    await post(body([metaMsg('wamid.U1')], []))
    expect(dlq()).toHaveLength(1)
    expect((dlq()[0].params.p_payload as { stage: string }).stage).toBe('unexpected')
    expect(String(dlq()[0].params.p_error_message)).toBe('source=meta;stage=unexpected;db_code=none;error_type=TypeError')
    noEnginesRan()
  })

  it('batch: ONE failing message of 3 → ONE enqueue (that message), the others still inserted', async () => {
    S.insertModeFor = (id) => (id === 'wamid.2' ? 'error' : 'ok')
    await post(body([metaMsg('wamid.1'), metaMsg('wamid.2'), metaMsg('wamid.3')]))
    expect(inserts()).toHaveLength(3)
    expect(dlq()).toHaveLength(1)
    expect((dlq()[0].params.p_payload as { external_message_id: string }).external_message_id).toBe('wamid.2')
    expect(JSON.stringify(dlq()[0].params)).not.toMatch(/wamid\.1|wamid\.3/)
  })
})

describe('C6.2 Meta route: duplicates are not captured', () => {
  it('redelivery (insert returns NULL) → no enqueue, no engine', async () => {
    S.insertModeFor = () => 'dup'
    await post(body([metaMsg('wamid.D1')]))
    expect(dlq()).toHaveLength(0)
    noEnginesRan()
  })
})

describe('C6.2 Meta route: enqueue failure', () => {
  it.each(['error', 'reject'] as const)('enqueue %s → HTTP 500 and the rest of the batch is still processed', async (mode) => {
    S.insertModeFor = (id) => (id === 'wamid.1' ? 'error' : 'ok')
    S.enqueueMode = mode
    const { status, json } = await post(body([metaMsg('wamid.1'), metaMsg('wamid.2')]))
    expect(status).toBe(500)
    expect(json).toEqual({ error: 'Inbound persistence incomplete' })
    expect(inserts()).toHaveLength(2)
    // loss is surfaced loudly, with no PII
    const lost = vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes('NOT captured in DLQ'))
    expect(lost).toHaveLength(1)
    expect(JSON.stringify(lost)).not.toContain('5511999887766')
  })
})

describe('C6.2 Meta route: configuration must be unique and valid', () => {
  it('multiple configs for one phone_number_id → dropped as before, NO enqueue (no config id is invented)', async () => {
    S.configRows = [CFG, { ...CFG, id: 'cfg-2', account_id: 'acc-2' }]
    await post(body([metaMsg('wamid.M1')]))
    expect(inserts()).toHaveLength(0)
    expect(dlq()).toHaveLength(0)
  })

  it('no config → dropped as before, NO enqueue', async () => {
    S.configRows = []
    await post(body([metaMsg('wamid.N1')]))
    expect(inserts()).toHaveLength(0)
    expect(dlq()).toHaveLength(0)
  })

  it('scope always comes from the single resolved row (acc/config of the SAME row)', async () => {
    S.configRows = [{ ...CFG, id: 'cfg-X', account_id: 'acc-X' }]
    S.insertModeFor = () => 'error'
    await post(body([metaMsg('wamid.S1')]))
    expect(dlq()[0].params).toMatchObject({ p_account_id: 'acc-X', p_whatsapp_config_id: 'cfg-X' })
  })
})

describe('C6.2 Meta route: data minimisation', () => {
  it('the DLQ call carries no phone, name, text, media or token', async () => {
    S.insertModeFor = () => 'error'
    await post(body([metaMsg('wamid.P1', { image: { id: 'media-123', mime_type: 'image/jpeg', caption: 'legenda' }, type: 'image' })]))
    expect(dlq()).toHaveLength(1)
    const blob = JSON.stringify(dlq()[0].params)
    for (const leak of ['5511999887766', 'Maria', 'cpf', '123.456', 'legenda', 'media-123', 'Key (phone)', 'db unavailable', 'enc']) {
      // 'enc' is the mocked access_token: it must never travel to the DLQ
      if (leak === 'enc') { expect(blob).not.toMatch(/"enc"/); continue }
      expect(blob).not.toContain(leak)
    }
    expect((dlq()[0].params.p_payload as { has_media: boolean }).has_media).toBe(true)
  })
})

describe('C6.2 Meta route: out-of-scope behaviour is unchanged', () => {
  it('a failure AFTER the insert is NOT captured (as before C6.2)', async () => {
    S.postInsertFlowThrows = true
    await post(body([metaMsg('wamid.PI1')]))
    expect(inserts()).toHaveLength(1)
    expect(dlq()).toHaveLength(0)
  })

  it('invalid signature → 401, nothing processed, no DLQ', async () => {
    vi.mocked(verifyMetaWebhookSignature).mockReturnValue(false)
    S.insertModeFor = () => 'error'
    const { status } = await post(body([metaMsg('wamid.X1')]))
    expect(status).toBe(401)
    expect(rpcCalls).toHaveLength(0)
  })

  it('a healthy message is persisted and, as before, triggers the engines (capture did not change the happy path)', async () => {
    await post(body([metaMsg('wamid.OK1')]))
    expect(inserts()).toHaveLength(1)
    expect(dlq()).toHaveLength(0)
    expect(mockFlows).toHaveBeenCalledTimes(1)
    expect(mockCadences).toHaveBeenCalledTimes(1)
  })
})

describe('C6.2 Meta route: token decryption failure (A9)', () => {
  it('each message of the delivery is captured (stage=token_decrypt), nothing is persisted, HTTP 500, no engine ran', async () => {
    S.decryptFails = true
    const { status, json } = await post(body([metaMsg('wamid.T1'), metaMsg('wamid.T2')]))
    expect(status).toBe(500)
    expect(json).toEqual({ error: 'Inbound persistence incomplete' })
    expect(inserts()).toHaveLength(0)
    expect(dlq()).toHaveLength(2)
    expect(dlq().map((c) => (c.params.p_payload as { external_message_id: string }).external_message_id)).toEqual(['wamid.T1', 'wamid.T2'])
    for (const c of dlq()) {
      expect(c.params).toMatchObject({ p_account_id: 'acc-1', p_whatsapp_config_id: 'cfg-1' })
      expect(c.params.p_payload).toMatchObject({ stage: 'token_decrypt', source: 'meta' })
      expect(c.params.p_error_message).toBe('source=meta;stage=token_decrypt;db_code=none;error_type=Error')
    }
    noEnginesRan()
  })

  it('a decrypt failure in one change no longer drops the next change/entry of the same delivery', async () => {
    S.decryptFails = true
    const two = {
      entry: [
        body([metaMsg('wamid.E1')]).entry[0],
        { ...body([metaMsg('wamid.E2')]).entry[0], id: 'e2' },
      ],
    }
    await post(two)
    expect(dlq()).toHaveLength(2)
  })

  it('neither the DLQ call nor the C6.2 logs carry the decrypt error text or the phone', async () => {
    S.decryptFails = true
    await post(body([metaMsg('wamid.T3')]))
    expect(JSON.stringify(dlq()[0].params)).not.toMatch(/bad key|ciphertext|5511999887766|Maria|cpf/)
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(logged).not.toMatch(/bad key|ciphertext|5511999887766/)
  })

  it('decrypt failure AND capture failure -> HTTP 500, loss surfaced in the logs', async () => {
    S.decryptFails = true
    S.enqueueMode = 'error'
    const { status } = await post(body([metaMsg('wamid.T4')]))
    expect(status).toBe(500)
    const lost = vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes('NOT captured in DLQ'))
    expect(lost).toHaveLength(1)
  })
})

describe('C6.2 Meta route: config lookup failures are NOT capturable (A9)', () => {
  it('a DB error while resolving the config -> dropped as before, nothing enqueued (no proven config)', async () => {
    S.configError = true
    const { status } = await post(body([metaMsg('wamid.C1')]))
    expect(status).toBe(200)
    expect(inserts()).toHaveLength(0)
    expect(dlq()).toHaveLength(0)
  })

  it('CHARACTERIZATION (known gap): messages delivered without a contacts[] are skipped silently before config resolution', async () => {
    const b = body([metaMsg('wamid.NC1')])
    delete (b.entry[0].changes[0].value as { contacts?: unknown }).contacts
    await post(b)
    expect(inserts()).toHaveLength(0)
    expect(dlq()).toHaveLength(0)
  })
})
