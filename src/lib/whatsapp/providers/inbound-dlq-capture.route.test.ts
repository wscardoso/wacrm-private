import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// =============================================================
// C6.2 — inbound DLQ CAPTURE through the REAL provider route
// (uazapi) and the REAL processInboundMessage.
//
// Only I/O is mocked. Engines (flows / automations / cadences) are mocked
// ONLY to prove they are never executed by the capture path.
// =============================================================

import { hashWebhookSecret } from '@/lib/whatsapp/webhook-auth'

type InsertMode = 'ok' | 'dup' | 'error' | 'reject'
type EnqueueMode = 'ok' | 'error' | 'reject'

const S = {
  provider: 'uazapi' as const,
  contactFails: false,
  conversationFails: false,
  insertModeFor: ((): InsertMode => 'ok') as (id: string) => InsertMode,
  enqueueMode: 'ok' as EnqueueMode,
  postInsertFlowThrows: false,
  decryptFails: false,
}
const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = []

// Two tenants, to prove scope never crosses.
const CONFIGS: Record<string, { id: string; account_id: string; user_id: string; secret: string }> = {
  'conn-A': { id: 'cfg-A', account_id: 'acc-A', user_id: 'user-A', secret: 's3cr3t-A' },
  'conn-B': { id: 'cfg-B', account_id: 'acc-B', user_id: 'user-B', secret: 's3cr3t-B' },
}

function makeChain(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = { __table: table, __maybeSingle: false, __conn: undefined as string | undefined }
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'neq', 'in', 'order', 'limit', 'single', 'is', 'not', 'gte', 'lt', 'head']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.eq = vi.fn((col: string, val: string) => { if (col === 'connection_id') chain.__conn = val; return chain })
  chain.maybeSingle = vi.fn(() => { chain.__maybeSingle = true; return chain })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.then = (resolve: (v: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let error: any = null
    if (table === 'whatsapp_config') {
      const c = chain.__conn ? CONFIGS[chain.__conn] : undefined
      data = c
        ? { id: c.id, account_id: c.account_id, user_id: c.user_id, access_token: 'enc', instance_id: 'inst', base_url: 'https://x.uazapi.dev', provider: S.provider, connection_id: chain.__conn, webhook_secret_hash: hashWebhookSecret(c.secret) }
        : null
    } else if (table === 'conversations') {
      if (S.conversationFails) { error = { code: 'XX000', message: 'conv db down (Maria 5511999887766)' } }
      else data = { id: 'conv-1', unread_count: 0 }
    } else if (table === 'contacts') {
      if (S.contactFails) { error = { code: '23502', message: 'null value (5511999887766)' } }
      else data = { id: 'contact-1', name: 'Bob' }
    } else {
      data = { count: 0 }
    }
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
        if (mode === 'reject') return Promise.reject(new Error('network down for 5511999887766'))
        if (mode === 'error') return Promise.resolve({ data: null, error: { code: 'XX000', message: 'db unavailable: Key (phone)=(5511999887766)' } })
        if (mode === 'dup') return Promise.resolve({ data: { message_id: 'existing', message_inserted: false, job_ready: true }, error: null })
        return Promise.resolve({ data: { message_id: `id-${rpcCalls.length}`, message_inserted: true, job_ready: true }, error: null })
      }
      if (fn === 'enqueue_webhook_dlq') {
        if (S.enqueueMode === 'reject') return Promise.reject(new Error('enqueue network down'))
        if (S.enqueueMode === 'error') return Promise.resolve({ data: null, error: { code: '42501', message: 'ownership 5511999887766' } })
        return Promise.resolve({ data: `dlq-${rpcCalls.length}`, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => v, decrypt: (v: string) => v,
  encryptWithBindingContext: (v: string) => v,
  decryptWithBindingContext: (v: string) => {
    if (S.decryptFails) throw new Error('bad key / ciphertext 5511999887766')
    return v
  },
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({ normalizePhone: (p: string) => p.replace(/\D/g, '') }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null), isUniqueViolation: vi.fn(() => false),
}))

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
const mockStatus = vi.fn(async () => undefined)
vi.mock('@/lib/whatsapp/status-handler', () => ({ handleCanonicalStatusEvent: (...a: unknown[]) => (mockStatus as (...x: unknown[]) => unknown)(...a) }))

const { POST } = await import('@/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route')

async function post(provider: 'uazapi', conn: string, body: unknown, secret?: string, rawBody?: string) {
  S.provider = provider
  const sec = secret ?? CONFIGS[conn]?.secret ?? 'x'
  const req = new Request(`http://localhost/api/whatsapp/webhook/${provider}/${conn}/${sec}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody ?? JSON.stringify(body),
  }) as unknown as NextRequest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST(req, { params: Promise.resolve({ provider, connectionId: conn, webhookSecret: sec }) } as any)
  return { status: res.status, json: await res.json() }
}

const dlq = () => rpcCalls.filter((c) => c.fn === 'enqueue_webhook_dlq')
const inserts = () => rpcCalls.filter((c) => c.fn === 'persist_inbound_message_with_turn' || c.fn === 'insert_inbound_message')
const uazapiMsg = (id: string) => ({
  messages: [{
    key: { remoteJid: '5511999887766@s.whatsapp.net', id },
    messageTimestamp: 1710000000, message: { conversation: 'texto sensivel ' + id },
  }],
})
// One inbound event delivered the way the uazapi route consumes it (`data[]`).
const singleMsg = (id = 'w.in.1') => ({ event: 'messages', data: [uazapiMsg(id)] })
const noEnginesRan = () => {
  expect(mockFlows).not.toHaveBeenCalled()
  expect(mockAutomations).not.toHaveBeenCalled()
  expect(mockCadences).not.toHaveBeenCalled()
}

beforeEach(() => {
  rpcCalls.length = 0
  vi.clearAllMocks()
  S.provider = 'uazapi'
  S.contactFails = false
  S.conversationFails = false
  S.insertModeFor = () => 'ok'
  S.enqueueMode = 'ok'
  S.postInsertFlowThrows = false
  S.decryptFails = false
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

describe('C6.2 provider route: persistence failure is captured', () => {
  it.each([
    ['message_insert (db error)', () => { S.insertModeFor = () => 'error' }, 'message_insert', 'db_code=XX000'],
    ['contact create failure', () => { S.contactFails = true }, 'contact', 'db_code=23502'],
    ['conversation failure', () => { S.conversationFails = true }, 'conversation', 'db_code=XX000'],
  ])('%s → exactly one diagnostic enqueue for tenant A, HTTP 500, not counted as processed, no engine ran', async (_n, arrange, stage, codePart) => {
    arrange()
    const { status, json } = await post('uazapi', 'conn-A', singleMsg())
    expect(status).toBe(500)
    expect(json).toMatchObject({ processed: 0, inboundProcessed: 0, captured: 1, statusProcessed: 0 })
    expect(json.received).toBeUndefined()
    const payload = dlq()[0]?.params.p_payload as Record<string, unknown> | undefined
    expect(payload && 'message' in (payload ?? {})).toBe(false)
    expect(dlq()).toHaveLength(1)
    expect(dlq()[0].params).toMatchObject({ p_account_id: 'acc-A', p_whatsapp_config_id: 'cfg-A' })
    expect((dlq()[0].params.p_payload as { stage: string; source: string }).stage).toBe(stage)
    expect((dlq()[0].params.p_payload as { source: string }).source).toBe('uazapi')
    expect(String(dlq()[0].params.p_error_message)).toContain(`stage=${stage}`)
    expect(String(dlq()[0].params.p_error_message)).toContain(codePart)
    noEnginesRan()
  })

  it('an unexpected exception is captured with the distinct stage "unexpected"', async () => {
    S.insertModeFor = () => 'reject'
    const { status, json } = await post('uazapi', 'conn-A', singleMsg())
    expect(status).toBe(500)
    expect(json.captured).toBe(1)
    expect((dlq()[0].params.p_payload as { stage: string }).stage).toBe('message_insert')
    expect(String(dlq()[0].params.p_error_message)).toBe('source=uazapi;stage=message_insert;db_code=none')
    noEnginesRan()
  })

  it('the success response still has every pre-C6.2 key (contract preserved; "captured" is additive)', async () => {
    const { status, json } = await post('uazapi', 'conn-A', singleMsg())
    expect(status).toBe(200)
    expect(json).toMatchObject({ received: true, processed: 1, inboundProcessed: 1, statusProcessed: 0, captured: 0 })
    expect(dlq()).toHaveLength(0)
  })
})

describe('C6.2 provider route: legitimate duplicates are not captured', () => {
  it('redelivery (insert returns NULL) → normal return, no enqueue, no engine', async () => {
    S.insertModeFor = () => 'dup'
    const { status, json } = await post('uazapi', 'conn-A', singleMsg())
    expect(status).toBe(200)
    expect(json.captured).toBe(0)
    expect(dlq()).toHaveLength(0)
    noEnginesRan()
  })
})

describe('C6.2 provider route: enqueue failure → 500; UAZAPI worker retry is not assumed', () => {
  it.each(['error', 'reject'] as const)('persistence fails AND enqueue %s → 500, not a success body', async (mode) => {
    S.insertModeFor = () => 'error'
    S.enqueueMode = mode
    const { status, json } = await post('uazapi', 'conn-A', singleMsg())
    expect(status).toBe(500)
    expect(json).toMatchObject({ processed: 0, captured: 0, uncaptured: 1 })
    expect(json.received).toBeUndefined()
    noEnginesRan()
  })

  it('the log lines EMITTED BY C6.2 never echo the DB/RPC error message or the phone', async () => {
    S.insertModeFor = () => 'error'
    S.enqueueMode = 'error'
    await post('uazapi', 'conn-A', singleMsg())
    // Scope: only lines C6.2 introduced. The pre-existing
    // "[inbound-processor] Error inserting message:" line still prints the raw
    // DB error object — a known, separately-tracked limitation, not asserted here.
    const c62 = vi.mocked(console.error).mock.calls.filter(
      (c) => String(c[0]).startsWith('[inbound-dlq]') || String(c[0]).includes('persistence failure, stage='),
    )
    expect(c62.length).toBeGreaterThanOrEqual(2)
    const logged = JSON.stringify(c62)
    expect(logged).not.toContain('Key (phone)')
    expect(logged).not.toContain('5511999887766')
    expect(logged).not.toContain('ownership')
  })
})

describe('C6.2 provider route: batch (uazapi) — the INDIVIDUAL event is enqueued', () => {
  const batch = { event: 'messages', data: [uazapiMsg('evt-1'), uazapiMsg('evt-2'), uazapiMsg('evt-3')] }

  it('1 failing event of 3 → 1 enqueue (that event only); the other two are processed; HTTP 500', async () => {
    S.insertModeFor = (id) => (id === 'evt-2' ? 'error' : 'ok')
    const { status, json } = await post('uazapi', 'conn-A', batch)
    expect(status).toBe(500)
    expect(json).toMatchObject({ processed: 2, captured: 1 })
    expect(inserts()).toHaveLength(3)
    expect(dlq()).toHaveLength(1)
    const payload = dlq()[0].params.p_payload as { external_message_id: string; source: string }
    expect(payload.external_message_id).toBe('evt-2')
    expect(payload.source).toBe('uazapi')
    expect(JSON.stringify(dlq()[0].params)).not.toMatch(/evt-1|evt-3/)
  })

  it('failing event whose enqueue also fails → 500, but the OTHER events were still handled', async () => {
    S.insertModeFor = (id) => (id === 'evt-2' ? 'error' : 'ok')
    S.enqueueMode = 'error'
    const { status, json } = await post('uazapi', 'conn-A', batch)
    expect(status).toBe(500)
    expect(json).toMatchObject({ processed: 2, captured: 0, uncaptured: 1 })
    expect(inserts()).toHaveLength(3) // evt-3 was still attempted after evt-2 failed
  })

  it('redelivery of the whole batch: persisted events dedupe (no DLQ row for them)', async () => {
    S.insertModeFor = (id) => (id === 'evt-2' ? 'error' : 'dup')
    const { status, json } = await post('uazapi', 'conn-A', batch)
    expect(status).toBe(500)
    expect(dlq()).toHaveLength(1) // only the still-failing one
    expect(json.captured).toBe(1)
    noEnginesRan()
  })
})

describe('C6.2 provider route: data minimisation', () => {
  it('the DLQ call carries no phone, name, text, media or secret', async () => {
    S.insertModeFor = () => 'error'
    await post('uazapi', 'conn-A', {
      event: 'messages',
      data: [{
        messages: [{
          key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'w.in.1' },
          pushName: 'Maria Silva',
          messageTimestamp: 1710000000,
          message: { imageMessage: { url: 'https://cdn.example/secret.jpg', caption: 'meu cpf 123.456.789-00 legenda', mimetype: 'image/jpeg' } },
        }],
      }],
    })
    expect(dlq()).toHaveLength(1)
    const blob = JSON.stringify(dlq()[0].params)
    for (const leak of ['5511999887766', 'Maria', 'cpf', '123.456', 'legenda', 'cdn.example', 'secret.jpg', 's3cr3t-A', 'Key (phone)', 'db unavailable']) {
      expect(blob).not.toContain(leak)
    }
  })
})

describe('C6.2 provider route: tenant isolation', () => {
  it('tenant A failures use (acc-A,cfg-A) and tenant B failures use (acc-B,cfg-B) — never crossed', async () => {
    S.insertModeFor = () => 'error'
    await post('uazapi', 'conn-A', singleMsg('a-1'))
    await post('uazapi', 'conn-B', singleMsg('b-1'))
    const pairs = dlq().map((c) => [c.params.p_account_id, c.params.p_whatsapp_config_id])
    expect(pairs).toEqual([['acc-A', 'cfg-A'], ['acc-B', 'cfg-B']])
  })

  it('a payload that tries to name another account cannot change the scope', async () => {
    S.insertModeFor = () => 'error'
    await post('uazapi', 'conn-A', { ...singleMsg(), account_id: 'acc-B', whatsapp_config_id: 'cfg-B', accountId: 'acc-B' })
    expect(dlq()).toHaveLength(1)
    expect(dlq()[0].params).toMatchObject({ p_account_id: 'acc-A', p_whatsapp_config_id: 'cfg-A' })
  })

  it('an unauthenticated request (wrong secret) never reaches processing nor the DLQ', async () => {
    S.insertModeFor = () => 'error'
    const { status } = await post('uazapi', 'conn-A', singleMsg(), 'wrong-secret')
    expect(status).toBe(401)
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('C6.2 provider route: out-of-scope behaviour is unchanged', () => {
  it('a durable persist is counted even when a later flow would throw — downstream is deferred, not captured', async () => {
    S.postInsertFlowThrows = true
    const { status, json } = await post('uazapi', 'conn-A', singleMsg())
    expect(status).toBe(200)
    expect(json).toMatchObject({ processed: 1, captured: 0 })
    expect(dlq()).toHaveLength(0)
    expect(inserts()).toHaveLength(1)
  })

  it('invalid JSON still → 400 with no DLQ', async () => {
    const { status } = await post('uazapi', 'conn-A', undefined, undefined, '{not json')
    expect(status).toBe(400)
    expect(dlq()).toHaveLength(0)
  })

  it('a status callback still goes to the status handler: no inbound, no DLQ', async () => {
    const { status, json } = await post('uazapi', 'conn-A', {
      event: 'MESSAGES_UPDATE',
      data: { messages: [{ key: { id: 'w.out.1', fromMe: true, remoteJid: '5511999887766@s.whatsapp.net' }, message: { messageTimingType: 'ack', ack: 4 }, messageTimestamp: 1710000000 }] },
    })
    expect(status).toBe(200)
    expect(json.statusProcessed).toBe(1)
    expect(mockStatus).toHaveBeenCalledTimes(1)
    expect(inserts()).toHaveLength(0)
    expect(dlq()).toHaveLength(0)
  })

  it('a non-message callback (D-C drop) is still dropped without DLQ', async () => {
    const { status } = await post('uazapi', 'conn-A', { event: 'presence.update' })
    expect(status).toBe(200)
    expect(dlq()).toHaveLength(0)
    expect(inserts()).toHaveLength(0)
  })
})

describe('C6.2 provider route: parse failures (A2) are isolated and captured', () => {
  // uazapi's adapter dereferences `payload.data`: a null item in data[] throws.
  const batchWithBadItem = { event: 'messages', data: [uazapiMsg('evt-1'), null, uazapiMsg('evt-3')] }

  it('a throwing parse of ONE item no longer aborts the request: others processed, 1 capture (stage=parse), HTTP 500', async () => {
    const { status, json } = await post('uazapi', 'conn-A', batchWithBadItem)
    expect(status).toBe(500)
    expect(json).toMatchObject({ processed: 2, captured: 1 })
    expect(inserts()).toHaveLength(2)
    expect(dlq()).toHaveLength(1)
    expect(dlq()[0].params).toMatchObject({ p_account_id: 'acc-A', p_whatsapp_config_id: 'cfg-A' })
    expect(dlq()[0].params.p_payload).toMatchObject({ stage: 'parse', source: 'uazapi', external_message_id: null, event_type: 'unknown' })
    expect(String(dlq()[0].params.p_error_message)).toBe('source=uazapi;stage=parse;db_code=none;error_type=TypeError')
  })

  it('parse failure whose capture also fails -> 500, but the valid items were still processed', async () => {
    S.enqueueMode = 'error'
    const { status, json } = await post('uazapi', 'conn-A', batchWithBadItem)
    expect(status).toBe(500)
    expect(json).toMatchObject({ processed: 2, captured: 0, uncaptured: 1 })
    expect(inserts()).toHaveLength(2)
  })

  it('the parse capture carries no payload content and the log line has the error class only', async () => {
    await post('uazapi', 'conn-A', { event: 'messages', data: [{ key: { remoteJid: 5511999887766, id: 'x' }, message: { conversation: 'texto sensivel' } }] })
    expect(dlq()).toHaveLength(1)
    const blob = JSON.stringify(dlq()[0].params)
    expect(blob).not.toMatch(/5511999887766|texto sensivel/)
    const parseLogs = vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes('parseInboundMessage failed'))
    expect(parseLogs).toHaveLength(1)
    expect(JSON.stringify(parseLogs)).not.toMatch(/5511999887766|texto sensivel|remoteJid/)
  })
})

describe('C6.2 provider route: config resolution failures are NOT capturable (A9)', () => {
  it('unknown / unresolvable connection -> 401 and nothing is written (no config id is invented)', async () => {
    const { status } = await post('uazapi', 'conn-unknown', singleMsg(), 'whatever')
    expect(status).toBe(401)
    expect(rpcCalls).toHaveLength(0)
  })

  it('a token that cannot be decrypted fails BEFORE authentication: the request errors and nothing is enqueued', async () => {
    // Capturing here would let an UNAUTHENTICATED caller write to the DLQ.
    S.decryptFails = true
    await expect(post('uazapi', 'conn-A', singleMsg())).rejects.toThrow()
    expect(rpcCalls).toHaveLength(0)
  })
})
