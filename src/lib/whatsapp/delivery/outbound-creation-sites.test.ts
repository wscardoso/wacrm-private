import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================
// The Flows and Automations senders create their outbound messages through
// `createIntent` (the single owner, DLB-001 §3), so each one carries the
// delivery binding of the connection it sends through, written in the SAME
// insert that creates the message.
//
// Real: createIntent, the binding helper, phone-utils, the engines' own code.
// Mocked: the Supabase client (an in-memory recorder), the provider adapter,
// encryption, and the post-send settlement / failure handling.
// =============================================================

type Row = Record<string, unknown>

const CFG_ID = '00000000-0000-4000-8000-0000000000c1'
const metaCfg: Row = { id: CFG_ID, account_id: 'acc-1', provider: 'meta', access_token: 'enc', phone_number_id: '123456789', instance_id: null, base_url: null }
const uaCfg: Row = { id: CFG_ID, account_id: 'acc-1', provider: 'uazapi', access_token: 'enc', phone_number_id: 'inst', instance_id: 'inst', base_url: 'https://my.uazapi.dev' }

const db = {
  config: metaCfg as Row,
  inserts: [] as Row[],
  insertError: null as null | { message: string },
  writes: [] as Array<{ table: string; op: string }>,
}

function chainFor(table: string) {
  const chain: Record<string, unknown> = {}
  const done = (result: unknown) => Promise.resolve(result)
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(() => done({ data: { id: 'contact-1', phone: '5511999887766' }, error: null }))
  chain.single = vi.fn(() => {
    if (table === 'whatsapp_config') return done({ data: db.config, error: null })
    if (table === 'messages') return done(db.insertError ? { data: null, error: db.insertError } : { data: { id: String(db.inserts.at(-1)?.id) }, error: null })
    return done({ data: null, error: null })
  })
  chain.insert = vi.fn((row: Row) => {
    db.writes.push({ table, op: 'insert' })
    if (table === 'messages') db.inserts.push(row)
    return chain
  })
  chain.update = vi.fn(() => { db.writes.push({ table, op: 'update' }); return chain })
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
  return chain
}

// Each engine re-exports the client from its own `./admin-client`.
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => chainFor(t) }) }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({ from: (t: string) => chainFor(t) }) }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decryptWithBindingContext: () => 'plaintext-token' }))
vi.mock('@/lib/whatsapp/config-binding', () => ({ whatsappConfigBindingContext: (a: string) => `whatsapp_config:${a}` }))

const send = vi.fn(async () => ({ messageId: 'wamid.1', externalIdentities: [] as unknown[] }))
const mockGetProvider = vi.fn()
vi.mock('@/lib/whatsapp/providers', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/whatsapp/providers')>()),
  getProvider: (...a: unknown[]) => mockGetProvider(...a),
}))

const mockSettle = vi.fn(async () => ({ messageId: 'x', outcome: 'sent' }))
vi.mock('@/lib/whatsapp/delivery/settlement', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/whatsapp/delivery/settlement')>()),
  settleMessageSystem: (...a: unknown[]) => (mockSettle as unknown as (...x: unknown[]) => unknown)(...a),
}))
const mockHandleFailure = vi.fn(async () => ({ messageId: 'x', outcome: 'noop' }))
vi.mock('@/lib/whatsapp/delivery/sender', () => ({ handleSendFailure: (...a: unknown[]) => (mockHandleFailure as unknown as (...x: unknown[]) => unknown)(...a) }))

import { engineSendText as flowText, engineSendMedia, engineSendInteractiveButtons, engineSendInteractiveList } from '@/lib/flows/meta-send'
import { engineSendText as autoText, engineSendTemplate } from '@/lib/automations/meta-send'

const base = { accountId: 'acc-1', userId: 'user-1', conversationId: 'conv-1', contactId: 'contact-1' }

beforeEach(() => {
  vi.clearAllMocks()
  db.config = metaCfg
  db.inserts = []
  db.insertError = null
  db.writes = []
  mockGetProvider.mockReturnValue({
    sendText: send, sendMedia: send, sendTemplate: send, sendInteractiveButtons: send, sendInteractiveList: send,
    classifySendFailure: vi.fn(), capabilities: { nativeIdempotency: false, deliveryReconciliation: false },
  })
})

const callers: Array<[string, () => Promise<unknown>, Row]> = [
  ['flows text', () => flowText({ ...base, text: 'olá' }), { sender_type: 'bot', content_type: 'text', content_text: 'olá' }],
  ['flows media', () => engineSendMedia({ ...base, kind: 'image', link: 'https://cdn.example/a.jpg', caption: 'legenda' }), { sender_type: 'bot', content_type: 'image', content_text: 'legenda', media_url: null }],
  ['flows interactive buttons', () => engineSendInteractiveButtons({ ...base, bodyText: 'Escolha', buttons: [{ id: 'a', title: 'A' }] }), { sender_type: 'bot', content_type: 'interactive', content_text: 'Escolha' }],
  ['flows interactive list', () => engineSendInteractiveList({ ...base, bodyText: 'Lista', buttonLabel: 'Ver', sections: [{ rows: [{ id: 'a', title: 'A' }] }] }), { sender_type: 'bot', content_type: 'interactive', content_text: 'Lista' }],
  ['automations text', () => autoText({ ...base, text: 'oi' }), { sender_type: 'bot', content_type: 'text', content_text: 'oi', template_name: null }],
  ['automations template', () => engineSendTemplate({ ...base, templateName: 'boas_vindas', language: 'pt_BR' }), { sender_type: 'bot', content_type: 'template', content_text: null, template_name: 'boas_vindas' }],
]

describe.each([
  ['meta', metaCfg],
  ['uazapi', uaCfg],
])('outbound creation sites — %s connection', (provider, cfg) => {
  it.each(callers)('%s: ONE insert carries the message, its idempotency key and the delivery binding', async (_name, call, expected) => {
    db.config = cfg
    await call()

    expect(db.inserts).toHaveLength(1)
    const row = db.inserts[0]
    expect(row).toMatchObject({
      ...expected,
      conversation_id: 'conv-1',
      status: 'sending',
      connection_ref: CFG_ID,
      delivery_provider: provider,
    })
    expect(row.delivery_channel_fp).toMatch(/^v1:[0-9a-f]{64}$/)
    expect(row.idempotency_key).toBe(row.id)
    // the identity is complete at creation: no later write on `messages` supplies it
    expect(db.writes.filter((w) => w.table === 'messages')).toEqual([{ table: 'messages', op: 'insert' }])
    // the same connection id is what the settlement attaches identities to
    expect(mockSettle).toHaveBeenCalledWith(expect.anything(), row.id, 'sent', CFG_ID, expect.anything(), 'wamid.1')
    // nothing secret in the stored row
    expect(JSON.stringify(row)).not.toMatch(/plaintext-token|enc"/)
  })
})

describe('a connection that cannot identify its channel', () => {
  it.each(callers)('%s: nothing is created and nothing is sent', async (_name, call) => {
    db.config = { ...metaCfg, phone_number_id: '' }
    await expect(call()).rejects.toThrow(/failed to create message row/)
    expect(db.inserts).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('a removed provider is rejected before any message is created', async () => {
    db.config = { ...metaCfg, provider: 'zapi' }
    await expect(flowText({ ...base, text: 'x' })).rejects.toThrow(/Unsupported WhatsApp provider/)
    expect(db.inserts).toHaveLength(0)
  })
})

describe('a failed insert', () => {
  it('surfaces the database message and never reaches the provider', async () => {
    db.insertError = { message: 'column "delivery_channel_fp" of relation "messages" does not exist' }
    await expect(autoText({ ...base, text: 'x' })).rejects.toThrow('failed to create message row: column "delivery_channel_fp" of relation "messages" does not exist')
    expect(send).not.toHaveBeenCalled()
  })
})
