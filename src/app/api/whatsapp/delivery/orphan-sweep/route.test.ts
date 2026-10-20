import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindingFromConnection } from '@/lib/whatsapp/delivery/connection-binding'

// =============================================================
// ARO-001 §16 orphan sweep.
//
// An orphan is a message stuck in `sending` with no ledger entry: the process
// died before settlement, so whether the provider accepted it is UNKNOWN. The
// sweeper never sends and never settles; it only records the entry. For every
// case where the channel the message was created for cannot be proved (legacy
// message, removed / switched provider, changed number or instance, another
// account's connection) the entry is BLOCKED with an explicit reason, the
// credential is not decrypted, and nothing is marked sent, failed or dead.
//
// The TTL sweep is the only thing that closes a blocked entry. It must pass a
// NULL connection to the RPC (a UUID parameter — '' is rejected by PostgreSQL),
// and may only call the ledger entry resolved when the database confirmed the
// settlement.
//
// The Supabase client is an in-memory fake that emulates the one constraint
// the route relies on: outbound_retry_ledger.message_id is UNIQUE (049).
// =============================================================

type Row = Record<string, unknown>

const state = {
  messages: [] as Row[],
  conversations: {} as Record<string, Row>,
  ledger: [] as Row[],
  configs: {} as Record<string, Row>,
  insertError: null as null | { code?: string; message: string },
  insertCalls: [] as Row[],
  updateCalls: [] as Array<{ table: string; payload: Row }>,
  yieldBeforeInsert: false,
  fail: {} as Record<string, { code?: string; message: string }>,
}

interface Query {
  table: string
  action: 'select' | 'update' | 'insert'
  payload?: Row
  filters: Array<[string, string, unknown]>
}

function exec(q: Query): { data: unknown; error: unknown } {
  const eq = (col: string) => q.filters.find((f) => f[0] === 'eq' && f[1] === col)?.[2]

  if (q.action === 'insert') {
    state.insertCalls.push(q.payload as Row)
    if (state.insertError) return { data: null, error: state.insertError }
    if (q.table === 'outbound_retry_ledger') {
      if (state.ledger.some((r) => r.message_id === q.payload!.message_id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
      }
      state.ledger.push({ id: `L${state.ledger.length + 1}`, ...q.payload })
    }
    return { data: null, error: null }
  }

  if (q.action === 'update') {
    state.updateCalls.push({ table: q.table, payload: q.payload as Row })
    return { data: [], error: null }
  }

  const failing = state.fail[q.table + (eq('id') !== undefined ? ':by-id' : '')]
  if (failing) return { data: null, error: failing }

  if (q.table === 'messages') {
    if (eq('id') !== undefined) {
      const m = state.messages.find((x) => x.id === eq('id'))
      return { data: m ? { status: m.status } : null, error: null }
    }
    return { data: state.messages.filter((m) => m.status === eq('status')), error: null }
  }
  if (q.table === 'conversations') return { data: state.conversations[eq('id') as string] ?? null, error: null }
  if (q.table === 'whatsapp_config') return { data: state.configs[eq('id') as string] ?? null, error: null }
  if (q.table === 'outbound_retry_ledger') {
    if (eq('message_id') !== undefined) {
      return { data: state.ledger.find((r) => r.message_id === eq('message_id')) ?? null, error: null }
    }
    if (eq('status') === 'pending') {
      return { data: state.ledger.filter((r) => r.status === 'pending' && r.__expired === true), error: null }
    }
  }
  return { data: [], error: null }
}

function makeQuery(table: string) {
  const q: Query = { table, action: 'select', filters: [] }
  const chain: Record<string, unknown> = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn((col: string, val: unknown) => { q.filters.push(['eq', col, val]); return chain })
  chain.lt = vi.fn((col: string, val: unknown) => { q.filters.push(['lt', col, val]); return chain })
  chain.limit = vi.fn(() => chain)
  chain.update = vi.fn((payload: Row) => { q.action = 'update'; q.payload = payload; return chain })
  chain.insert = vi.fn(async (payload: Row) => {
    q.action = 'insert'; q.payload = payload
    // Let a concurrent sweeper run between its "already enqueued?" check and the insert.
    if (state.yieldBeforeInsert) await new Promise((r) => setTimeout(r, 0))
    return exec(q)
  })
  chain.maybeSingle = vi.fn(async () => exec(q))
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
    try { resolve(exec(q)) } catch (e) { reject?.(e) }
  }
  return chain
}

const mockSupabaseAdmin = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: mockSupabaseAdmin }))

const mockDecrypt = vi.fn((token: string, context: string) => `plaintext(${token}@${context})`)
vi.mock('@/lib/whatsapp/encryption', () => ({
  decryptWithBindingContext: (...a: [string, string]) => mockDecrypt(a[0], a[1]) as string,
}))
vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
}))

const mockSettleMessageSystem = vi.fn()
vi.mock('@/lib/whatsapp/delivery/settlement', () => ({
  settleMessageSystem: (...a: unknown[]) => mockSettleMessageSystem(...a),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true, remaining: 9, reset: 0, limit: 10 }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { cronDrain: { limit: 10, windowMs: 60_000 } },
}))

const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const CFG_A = '00000000-0000-4000-8000-00000000000a'
const CFG_B = '00000000-0000-4000-8000-00000000000b'
const metaCfg = (id = CFG_A, accountId = 'acc-A'): Row => ({ id, account_id: accountId, provider: 'meta', access_token: `enc-${id}`, phone_number_id: '123', instance_id: null, base_url: null })
const uaCfg = (id = CFG_A, accountId = 'acc-A'): Row => ({ id, account_id: accountId, provider: 'uazapi', access_token: `enc-${id}`, phone_number_id: 'inst', instance_id: 'inst', base_url: 'https://u.uazapi.dev' })
const bindingOf = (cfg: Row) => {
  const b = bindingFromConnection(cfg as never)
  return { connection_ref: b.connection_ref, delivery_provider: b.delivery_provider, delivery_channel_fp: b.delivery_channel_fp }
}
const orphan = (id: string, binding: Row = {}, convAccount = 'acc-A'): Row => {
  state.conversations[`conv-${id}`] = { account_id: convAccount }
  return { id, conversation_id: `conv-${id}`, created_at: OLD, status: 'sending', connection_ref: null, delivery_provider: null, delivery_channel_fp: null, ...binding }
}

function req(): Request {
  return new Request('http://localhost/api/whatsapp/delivery/orphan-sweep', { headers: { 'x-cron-secret': 'test-secret' } })
}

async function sweep() {
  const { GET } = await import('./route')
  const res = await GET(req())
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  state.messages = []
  state.conversations = {}
  state.ledger = []
  state.configs = {}
  state.insertError = null
  state.insertCalls = []
  state.updateCalls = []
  state.yieldBeforeInsert = false
  state.fail = {}
  mockSupabaseAdmin.mockReturnValue({ from: (t: string) => makeQuery(t) })
  mockSettleMessageSystem.mockResolvedValue({ messageId: 'x', outcome: 'failed' })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

const messagesUntouched = () => state.updateCalls.filter((u) => u.table === 'messages')
const GENERIC = 'orphan - process crashed before settlement'
const blockedWith = (reason: string) => expect.stringContaining(`orphan - blocked (${reason})`)

describe('orphan sweep — identity proved: supported providers keep the generic entry', () => {
  it.each([
    ['meta', metaCfg()],
    ['uazapi', uaCfg()],
  ])('%s orphan with a proved channel: blocked entry (no native idempotency), generic reason, credential decrypted with its own account context', async (_p, cfg) => {
    state.messages = [orphan('m1', bindingOf(cfg))]
    state.configs[CFG_A] = cfg

    const { body } = await sweep()

    expect(body).toMatchObject({ orphans_enqueued: 1 })
    expect(state.ledger[0]).toMatchObject({ message_id: 'm1', classification: 'ambiguous', next_attempt_at: null, status: 'pending', last_error: GENERIC })
    expect(mockDecrypt).toHaveBeenCalledWith(`enc-${CFG_A}`, 'whatsapp_config:acc-A')
    expect(messagesUntouched()).toHaveLength(0)
  })
})

describe('orphan sweep — identity NOT proved: blocked with a reason, no credential read, nothing touched', () => {
  const cases: Array<[string, () => void, string]> = [
    ['legacy message without any binding', () => { state.messages = [orphan('m1')] }, 'binding_missing'],
    ['legacy message of a removed Z-API connection (no binding, config now zapi)', () => {
      state.messages = [orphan('m1')]
      state.configs[CFG_A] = { ...metaCfg(), provider: 'zapi', instance_id: 'inst', phone_number_id: 'inst' }
    }, 'binding_missing'],
    ['incomplete binding', () => { state.messages = [orphan('m1', { connection_ref: CFG_A })] }, 'binding_invalid'],
    ['connection removed', () => { state.messages = [orphan('m1', bindingOf(metaCfg()))] }, 'connection_removed'],
    ['provider switched meta → uazapi in place', () => {
      state.messages = [orphan('m1', bindingOf(metaCfg()))]
      state.configs[CFG_A] = uaCfg()
    }, 'provider_changed'],
    ['provider switched uazapi → meta', () => {
      state.messages = [orphan('m1', bindingOf(uaCfg()))]
      state.configs[CFG_A] = metaCfg()
    }, 'provider_changed'],
    ['bound message whose connection is now the removed zapi provider', () => {
      state.messages = [orphan('m1', bindingOf(metaCfg()))]
      state.configs[CFG_A] = { ...metaCfg(), provider: 'zapi' }
    }, 'provider_unsupported'],
    ['another WhatsApp number on the same slot', () => {
      state.messages = [orphan('m1', bindingOf(metaCfg()))]
      state.configs[CFG_A] = { ...metaCfg(), phone_number_id: '999' }
    }, 'channel_changed'],
    ['another uazapi instance', () => {
      state.messages = [orphan('m1', bindingOf(uaCfg()))]
      state.configs[CFG_A] = { ...uaCfg(), instance_id: 'other' }
    }, 'channel_changed'],
    ['the connection belongs to ANOTHER account than the conversation', () => {
      state.messages = [orphan('m1', bindingOf(metaCfg(CFG_A, 'acc-B')), 'acc-A')]
      state.configs[CFG_A] = metaCfg(CFG_A, 'acc-B')
    }, 'account_mismatch'],
  ]
  it.each(cases)('%s → %s', async (_name, arrange, reason) => {
    arrange()

    const { status, body } = await sweep()

    expect(status).toBe(200)
    expect(body).toMatchObject({ orphans_enqueued: 1 })
    expect(state.ledger).toHaveLength(1)
    expect(state.ledger[0]).toMatchObject({ message_id: 'm1', status: 'pending', classification: 'ambiguous', next_attempt_at: null })
    expect(state.ledger[0].last_error).toEqual(blockedWith(reason))
    expect(state.ledger[0].last_error).toContain('manual verification required')
    expect(mockDecrypt).not.toHaveBeenCalled()          // the credential is read only for a proved channel
    expect(messagesUntouched()).toHaveLength(0)         // not sent, not failed, not dead
    expect(mockSettleMessageSystem).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()        // no error loop
  })

  it('a legacy message does not even look a connection up', async () => {
    state.messages = [orphan('m1')]
    const from = vi.fn((t: string) => makeQuery(t))
    mockSupabaseAdmin.mockReturnValue({ from })
    await sweep()
    expect(from.mock.calls.map((c) => c[0])).not.toContain('whatsapp_config')
  })

  it('repeating the sweep is idempotent: one entry, one insert, no errors', async () => {
    state.messages = [orphan('m1')]
    const runs = [await sweep(), await sweep(), await sweep()]
    expect(runs.map((r) => r.body.orphans_enqueued)).toEqual([1, 0, 0])
    expect(state.ledger).toHaveLength(1)
    expect(state.insertCalls).toHaveLength(1)
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('orphan sweep — isolation, concurrency and failure handling', () => {
  it('two accounts in the same batch: each orphan is judged against its OWN connection', async () => {
    state.messages = [
      orphan('m-a', bindingOf(metaCfg(CFG_A, 'acc-A')), 'acc-A'),
      orphan('m-b', bindingOf(uaCfg(CFG_B, 'acc-B')), 'acc-B'),
      orphan('m-x', bindingOf(metaCfg(CFG_A, 'acc-A')), 'acc-B'), // acc-B's conversation pointing at acc-A's connection
    ]
    state.configs[CFG_A] = metaCfg(CFG_A, 'acc-A')
    state.configs[CFG_B] = uaCfg(CFG_B, 'acc-B')

    await sweep()

    const byMsg = Object.fromEntries(state.ledger.map((r) => [r.message_id as string, r]))
    expect(byMsg['m-a'].last_error).toBe(GENERIC)
    expect(byMsg['m-b'].last_error).toBe(GENERIC)
    expect(byMsg['m-x'].last_error).toEqual(blockedWith('account_mismatch'))
    // the cross-account orphan never reached decryption: only the two valid ones did
    expect(mockDecrypt.mock.calls.map((c) => c[1]).sort()).toEqual(['whatsapp_config:acc-A', 'whatsapp_config:acc-B'])
  })

  it.each([
    ['ledger lookup', 'outbound_retry_ledger:by-id', 'ledger lookup failed'],
  ])('a failed %s does not create a misleading entry', async () => {
    // outbound_retry_ledger is looked up by message_id, not id; use the generic table key
    state.messages = [orphan('m1', bindingOf(metaCfg()))]
    state.configs[CFG_A] = metaCfg()
    state.fail['outbound_retry_ledger'] = { code: '57P01', message: 'db down' }
    const { status, body } = await sweep()
    expect(status).toBe(200)
    expect(body).toMatchObject({ orphans_enqueued: 0 })
    expect(state.ledger).toHaveLength(0)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('ledger lookup failed (57P01)')
  })

  it('a failed conversation lookup is not turned into "account mismatch": nothing is recorded, the run goes on', async () => {
    state.messages = [orphan('m1', bindingOf(metaCfg()))]
    state.configs[CFG_A] = metaCfg()
    state.fail['conversations:by-id'] = { code: '42501', message: 'permission denied' }
    const { status, body } = await sweep()
    expect(status).toBe(200)
    expect(body).toMatchObject({ orphans_enqueued: 0 })
    expect(state.ledger).toHaveLength(0)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('conversation lookup failed (42501)')
  })

  it('a failed connection lookup is not turned into "connection removed"', async () => {
    state.messages = [orphan('m1', bindingOf(metaCfg()))]
    state.fail['whatsapp_config:by-id'] = { code: '57P01', message: 'terminating connection' }
    const { body } = await sweep()
    expect(body).toMatchObject({ orphans_enqueued: 0 })
    expect(state.ledger).toHaveLength(0)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('connection lookup failed (57P01)')
  })

  it('a failed ledger insert is NOT counted as enqueued, does not abort the run, and is logged', async () => {
    state.messages = [orphan('m-1', bindingOf(metaCfg())), orphan('m-2', bindingOf(metaCfg()))]
    state.configs[CFG_A] = metaCfg()
    state.insertError = { code: '57P01', message: 'db down' }
    const { status, body } = await sweep()
    expect(status).toBe(200)
    expect(body).toMatchObject({ orphans_enqueued: 0 })
    expect(state.ledger).toHaveLength(0)
    expect(console.error).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('ledger insert failed')
  })

  it('a failed orphan select (e.g. an incompatible schema) processes nothing, writes nothing, and names the error code', async () => {
    state.messages = [orphan('m1')]
    state.fail['messages'] = { code: '42703', message: 'column messages.connection_ref does not exist' }
    const { status, body } = await sweep()
    expect(status).toBe(200)
    expect(body).toMatchObject({ orphans_enqueued: 0 })
    expect(state.ledger).toHaveLength(0)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('42703')
  })

  it('two sweepers racing on the same orphan: exactly one ledger row, the loser (23505) is a quiet no-op', async () => {
    state.messages = [orphan('m-r')]
    state.yieldBeforeInsert = true
    const [a, b] = await Promise.all([sweep(), sweep()])
    expect(state.ledger).toHaveLength(1)
    expect(a.body.orphans_enqueued + b.body.orphans_enqueued).toBe(1)
    expect(state.insertCalls.length).toBe(2) // both passed the existence check and tried to insert
    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('orphan sweep — TTL closes a blocked entry only when the database confirms it', () => {
  // The reclaim of stuck `retrying` rows also updates the ledger on every run; it is not a TTL write.
  const ttlWrites = () => state.updateCalls.filter((u) => u.table === 'outbound_retry_ledger' && !String(u.payload.last_error).startsWith('reclaimed'))
  const expired = (messageId: string) => { state.ledger = [{ id: 'L1', message_id: messageId, status: 'pending', next_attempt_at: null, __expired: true }] }

  it('settles the still-`sending` message `failed` with a NULL connection (never \'\'), then marks the entry dead', async () => {
    state.messages = [{ id: 'm-z', status: 'sending' }]
    expired('m-z')

    const { body } = await sweep()

    expect(body).toMatchObject({ ttl_swept: 1 })
    expect(mockSettleMessageSystem).toHaveBeenCalledWith(expect.anything(), 'm-z', 'failed', null, [])
    expect(mockSettleMessageSystem.mock.calls[0][3]).toBeNull()
    expect(ttlWrites().some((u) => u.payload.status === 'dead')).toBe(true)
  })

  it('a settlement that FAILS (the RPC throws) leaves the entry untouched — not dead, not resolved', async () => {
    state.messages = [{ id: 'm-z', status: 'sending' }]
    expired('m-z')
    mockSettleMessageSystem.mockRejectedValue(new Error('rpc failed'))

    const { body } = await sweep()

    expect(body).toMatchObject({ ttl_swept: 0 })
    expect(ttlWrites()).toHaveLength(0)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('rpc failed')
  })

  it('a settlement that returns noop (the message left `sending` meanwhile) is NOT claimed as resolved', async () => {
    state.messages = [{ id: 'm-z', status: 'sending' }]
    expired('m-z')
    mockSettleMessageSystem.mockResolvedValue({ messageId: 'm-z', outcome: 'noop' })

    const { body } = await sweep()

    expect(body).toMatchObject({ ttl_swept: 0 })
    expect(ttlWrites()).toHaveLength(0)
  })

  it('a failed message lookup is not "message not found": the entry is left for the next run', async () => {
    state.messages = [{ id: 'm-z', status: 'sending' }]
    expired('m-z')
    state.fail['messages:by-id'] = { code: '57P01', message: 'db down' }

    const { body } = await sweep()

    expect(body).toMatchObject({ ttl_swept: 0 })
    expect(ttlWrites()).toHaveLength(0)
    expect(mockSettleMessageSystem).not.toHaveBeenCalled()
  })

  it('a message that is really gone closes the entry; one already sent marks it delivered; no settlement is attempted', async () => {
    state.messages = [{ id: 'm-sent', status: 'sent' }]
    state.ledger = [
      { id: 'L1', message_id: 'm-gone', status: 'pending', next_attempt_at: null, __expired: true },
      { id: 'L2', message_id: 'm-sent', status: 'pending', next_attempt_at: null, __expired: true },
    ]
    await sweep()
    const payloads = ttlWrites().map((u) => u.payload.status)
    expect(payloads.sort()).toEqual(['dead', 'delivered'])
    expect(mockSettleMessageSystem).not.toHaveBeenCalled()
  })
})
