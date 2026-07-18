import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================
// Integration: provider.parseInboundMessage → InboundMessage →
// processInboundMessage → insert_inbound_message RPC (idempotency).
//
// No real DB / network. supabaseAdmin is mocked so the RPC returns
// a row id on first insert and NULL on redelivery (the C4 gate),
// exercising the full downstream short-circuit path.
// =============================================================

const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = []
// Controls whether the RPC "inserts" (returns an id) or "redelivers" (null).
let rpcInserts = true

function makeChain() {
  const chain: any = {}
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'maybeSingle', 'single', 'is', 'not', 'gte', 'lt']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.then = (resolve: (v: any) => void) => {
    // conversations upsert (findOrCreateConversation) and contacts insert
    // both resolve to a row; count head resolves to { count: 0 }.
    let data: any = null
    if (chain.__table === 'conversations') data = { id: 'conv-1', unread_count: 0, account_id: 'acc-1', user_id: 'user-1', contact_id: 'contact-1' }
    else if (chain.__table === 'contacts') data = { id: 'contact-1', name: 'Alice' }
    else data = null
    resolve({ data, count: 0, error: null })
    return Promise.resolve({ data, count: 0, error: null })
  }
  return chain
}

const mockFromImpl = vi.fn((t: string) => {
  const c = makeChain()
  c.__table = t
  return c
})

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({ from: mockFromImpl, rpc: mockRpcImpl }),
}))

function mockRpcImpl(fn: string, params: Record<string, unknown>) {
  rpcCalls.push({ fn, params })
  if (fn === 'insert_inbound_message') {
    return Promise.resolve({ data: rpcInserts ? 'msg-new-1' : null, error: null })
  }
  return Promise.resolve({ data: null, error: null })
}

vi.mock('@/lib/whatsapp/phone-utils', () => ({
  normalizePhone: (p: string) => p.replace(/\D/g, ''),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null),
  isUniqueViolation: vi.fn(() => false),
}))

const mockDispatchFlows = vi.fn(async () => ({ consumed: false }))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: ((..._a: any[]) => (mockDispatchFlows as any)(..._a)) as any,
}))

const mockRunAutomations = vi.fn()
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: ((..._a: any[]) => (mockRunAutomations as any)(..._a)) as any,
}))

import { processInboundMessage } from '../inbound-processor'
import { ZApiProvider } from './zapi'
import { UazapiProvider } from './uazapi'

const zapi = new ZApiProvider({ instanceId: 'inst', token: 'tok' })
const uazapi = new UazapiProvider({ baseUrl: 'https://u.uazapi.dev', instanceId: 'inst', token: 'key' })

beforeEach(() => {
  vi.clearAllMocks()
  rpcCalls.length = 0
  rpcInserts = true
})

describe('non-Meta inbound pipeline → idempotency RPC', () => {
  it('Z-API text: inserts via RPC and runs downstream effects on first delivery', async () => {
    const parsed = zapi.parseInboundMessage({
      phone: '5511999887766',
      messageId: 'zaap-1',
      momment: 1710000000123,
      text: { message: 'Primeira' },
    })
    expect(parsed).not.toBeNull()

    await processInboundMessage(parsed!, 'acc-1', 'user-1')

    const rpc = rpcCalls.find((c) => c.fn === 'insert_inbound_message')
    expect(rpc).toBeDefined()
    expect(rpc!.params.p_message_id).toBe('zaap-1')
    expect(rpc!.params.p_sender_type).toBe('customer')
    // Z-API sends momment in MS (1710000000123). The costura preserves
    // the millisecond value as-is (tsNum > 1e12 → usado direto, sem
    // multiplicar por 1000), então p_created_at reflete 1710000000123 ms.
    expect(rpc!.params.p_created_at).toBe(new Date(1710000000123).toISOString())
    expect(mockDispatchFlows).toHaveBeenCalledTimes(1)
    expect(mockRunAutomations).toHaveBeenCalled()
  })

  it('Z-API text: redelivery returns NULL from RPC and short-circuits downstream', async () => {
    const parsed = zapi.parseInboundMessage({
      phone: '5511999887766',
      messageId: 'zaap-redeliver',
      momment: 1710000000000,
      text: { message: 'Duplicado' },
    })!

    rpcInserts = true
    await processInboundMessage(parsed, 'acc-1', 'user-1')
    expect(mockDispatchFlows).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    rpcCalls.length = 0
    rpcInserts = false
    await processInboundMessage(parsed, 'acc-1', 'user-1')

    const rpc = rpcCalls.find((c) => c.fn === 'insert_inbound_message')
    expect(rpc).toBeDefined()
    // Redelivery: RPC returned NULL → no flows / automations fired.
    expect(mockDispatchFlows).not.toHaveBeenCalled()
    expect(mockRunAutomations).not.toHaveBeenCalled()
  })

  it('uazapi image+caption: inserts via RPC with URL mediaRef', async () => {
    const parsed = uazapi.parseInboundMessage({
      event: 'MESSAGES_UPSERT',
      data: {
        messages: [
          {
            key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-1' },
            pushName: 'Bob',
            messageTimestamp: 1710000000,
            message: {
              imageMessage: { url: 'https://uazapi.dev/m.jpg', caption: 'olha', mimetype: 'image/jpeg' },
            },
          },
        ],
      },
    })
    expect(parsed).toMatchObject({ type: 'image', mediaRef: 'https://uazapi.dev/m.jpg' })

    await processInboundMessage(parsed!, 'acc-1', 'user-1')

    const rpc = rpcCalls.find((c) => c.fn === 'insert_inbound_message')
    expect(rpc).toBeDefined()
    expect(rpc!.params.p_message_id).toBe('evt-1')
    expect(rpc!.params.p_media_url).toBe('https://uazapi.dev/m.jpg')
    expect(rpc!.params.p_content_text).toBe('olha')
    expect(mockDispatchFlows).toHaveBeenCalledTimes(1)
  })

  it('uazapi redelivery short-circuits downstream effects', async () => {
    const make = () => {
      const parsed = uazapi.parseInboundMessage({
        event: 'MESSAGES_UPSERT',
        data: {
          messages: [
            {
              key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-red' },
              messageTimestamp: 1710000000,
              message: { conversation: 'oi' },
            },
          ],
        },
      })!
      return parsed
    }

    rpcInserts = true
    await processInboundMessage(make(), 'acc-1', 'user-1')
    expect(mockDispatchFlows).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    rpcCalls.length = 0
    rpcInserts = false
    await processInboundMessage(make(), 'acc-1', 'user-1')

    expect(mockDispatchFlows).not.toHaveBeenCalled()
    expect(mockRunAutomations).not.toHaveBeenCalled()
  })

  it('reaction messages never call insert_inbound_message (handled separately)', async () => {
    const parsed = zapi.parseInboundMessage({
      phone: '5511999887766',
      messageId: 'zaap-react',
      momment: 1710000000000,
      reaction: { messageId: 'zaap-target', reaction: '👍' },
    })!

    await processInboundMessage(parsed, 'acc-1', 'user-1')

    expect(rpcCalls.some((c) => c.fn === 'insert_inbound_message')).toBe(false)
    expect(mockDispatchFlows).not.toHaveBeenCalled()
  })
})
