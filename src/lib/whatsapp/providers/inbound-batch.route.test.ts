import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// =============================================================
// Batch processing via the REAL provider webhook route.
//
// The identified risk is the `for (const event of events)` loop in
// src/app/api/whatsapp/webhook/[provider]/[webhookSecret]/route.ts:
// uazapi may deliver an array of messages inside `payload.data`, and
// each element must be parsed + dispatched to processInboundMessage
// independently. A single-event test would not exercise that loop, so
// we POST a real batch payload through the actual route handler.
//
// Provider classes, parseInboundMessage and processInboundMessage run
// for real; only I/O (DB, decrypt) is mocked.
// =============================================================

const rpcCalls: string[] = []
let rpcInserts = true

function makeChain(table: string) {
  const chain: any = { __table: table }
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'maybeSingle', 'single', 'is', 'not', 'gte', 'lt', 'head']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.then = (resolve: (v: any) => void) => {
    let data: any = null
    let error: any = null
    if (table === 'whatsapp_config') {
      data = [
        {
          account_id: 'acc-1',
          user_id: 'user-1',
          access_token: 'enc-token',
          verify_token: 'secret-123',
          instance_id: 'inst-1',
          base_url: 'https://my.uazapi.dev',
          provider: 'uazapi',
        },
      ]
    } else if (table === 'conversations') {
      data = { id: 'conv-1', unread_count: 0, account_id: 'acc-1', user_id: 'user-1', contact_id: 'contact-1' }
    } else if (table === 'contacts') {
      data = { id: 'contact-1', name: 'Bob' }
    } else {
      data = { count: 0 }
    }
    resolve({ data, error })
    return Promise.resolve({ data, error })
  }
  return chain
}

const mockFromImpl = vi.fn((t: string) => makeChain(t))

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({
    from: mockFromImpl,
    rpc: (fn: string) => {
      rpcCalls.push(fn)
      if (fn === 'insert_inbound_message') {
        return Promise.resolve({ data: rpcInserts ? `id-${rpcCalls.length}` : null, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))

vi.mock('@/lib/whatsapp/phone-utils', () => ({
  normalizePhone: (p: string) => p.replace(/\D/g, ''),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null),
  isUniqueViolation: vi.fn(() => false),
}))

vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}))

// Spy on the real processInboundMessage so we can count how many times
// the route's loop dispatches it.
const { processInboundMessage } = await import('@/lib/whatsapp/inbound-processor')
const spy = vi.spyOn(await import('@/lib/whatsapp/inbound-processor'), 'processInboundMessage')

const { POST } = await import('@/app/api/whatsapp/webhook/[provider]/[webhookSecret]/route')

function postRequest(body: unknown): NextRequest {
  return new Request('http://localhost/api/whatsapp/webhook/uazapi/secret-123', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  rpcCalls.length = 0
  rpcInserts = true
  // restore spy (clearAllMocks clears call history but keeps implementation)
  spy.mockImplementation(processInboundMessage as any)
})

describe('uazapi batch data[] via real provider route', () => {
  it('dispatches processInboundMessage once per event in payload.data', async () => {
    const payload = {
      event: 'MESSAGES_UPSERT',
      data: [
        {
          messages: [
            {
              key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-batch-1' },
              pushName: 'Bob',
              messageTimestamp: 1710000000,
              message: { conversation: 'primeira' },
            },
          ],
        },
        {
          messages: [
            {
              key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-batch-2' },
              pushName: 'Bob',
              messageTimestamp: 1710000001,
              message: { conversation: 'segunda' },
            },
          ],
        },
        {
          messages: [
            {
              key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-batch-3' },
              messageTimestamp: 1710000002,
              message: { conversation: 'terceira' },
            },
          ],
        },
      ],
    }

    const res = await POST(postRequest(payload), {
      params: Promise.resolve({ provider: 'uazapi', webhookSecret: 'secret-123' }),
    } as any)

    expect(res.status).toBe(200)
    // The route iterates payload.data and calls processInboundMessage for
    // each parsed event (3 events → 3 dispatches).
    expect(spy).toHaveBeenCalledTimes(3)
    // One idempotency RPC per genuinely-inserted message.
    expect(rpcCalls.filter((f) => f === 'insert_inbound_message').length).toBe(3)
    const firstArg = spy.mock.calls[0][0] as any
    expect(firstArg.messageId).toBe('evt-batch-1')
    const thirdArg = spy.mock.calls[2][0] as any
    expect(thirdArg.messageId).toBe('evt-batch-3')
  })

  it('isolates a failing event — remaining events still processed', async () => {
    const payload = {
      event: 'MESSAGES_UPSERT',
      data: [
        {
          messages: [
            {
              key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-ok-1' },
              messageTimestamp: 1710000000,
              message: { conversation: 'ok' },
            },
          ],
        },
        {
          // Malformed event (no messages array) → parseInboundMessage returns
          // null → route skips it without throwing, loop continues.
          data: { notMessages: true },
        },
        {
          messages: [
            {
              key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-ok-2' },
              messageTimestamp: 1710000001,
              message: { conversation: 'ok2' },
            },
          ],
        },
      ],
    }

    const res = await POST(postRequest(payload), {
      params: Promise.resolve({ provider: 'uazapi', webhookSecret: 'secret-123' }),
    } as any)

    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
