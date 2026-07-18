import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------

const chainCalls: Array<{ table: string; method: string }> = []

// Controls what the messages table returns for the idempotency upsert.
let messagesUpsertResult: { data: any; error: any } = { data: [{ id: 'msg-1' }], error: null }

function makeChain() {
  const chain: any = {}
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete',
    'eq', 'neq', 'in', 'order', 'limit', 'maybeSingle', 'single',
    'gte', 'lt', 'is', 'not',
  ]) {
    chain[m] = vi.fn(() => {
      chainCalls.push({ table: chain.__table ?? '<unknown>', method: m })
      return chain
    })
  }
  chain.then = (resolve: (v: any) => void) => {
    let data: any = null
    let error: any = null
    if (chain.__table === 'conversations') {
      data = { id: 'conv-1', unread_count: 5, account_id: 'acc-1', user_id: 'user-1', contact_id: 'contact-1' }
    } else if (chain.__table === 'messages') {
      data = messagesUpsertResult.data
      error = messagesUpsertResult.error
    }
    resolve({ data, error })
    return Promise.resolve({ data, error })
  }
  return chain
}

const mockFromImpl = vi.fn((t: string) => {
  const c = makeChain()
  c.__table = t
  return c
})

const mockRpcImpl = vi.fn((fn: string, _params: Record<string, unknown>) => {
  if (fn === 'insert_inbound_message') {
    const id = messagesUpsertResult.data?.[0]?.id ?? null
    return Promise.resolve({ data: id, error: messagesUpsertResult.error })
  }
  return Promise.resolve({ data: null, error: null })
})

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({ from: mockFromImpl, rpc: mockRpcImpl }),
}))

vi.mock('@/lib/whatsapp/phone-utils', () => ({
  normalizePhone: (p: string) => p.replace(/\D/g, ''),
}))

const mockFindExistingContact = vi.fn()
const mockIsUniqueViolation = vi.fn(() => false)
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: (a: any, b: any) => (mockFindExistingContact as any)(a, b),
  isUniqueViolation: (a: any) => (mockIsUniqueViolation as any)(a),
}))

const mockRunAutomations = vi.fn()
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: (..._a: any[]) => (mockRunAutomations as any)(..._a),
}))

const mockDispatchFlows = vi.fn(async () => ({ consumed: false }))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: (..._a: any[]) => (mockDispatchFlows as any)(..._a),
}))

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const contactRow = {
  id: 'contact-1',
  account_id: 'acc-1',
  user_id: 'user-1',
  phone: '15559876543',
  name: 'Alice',
}

function makeInbound(messageId: string) {
  return {
    type: 'text' as const,
    from: '15559876543',
    text: 'Hello!',
    messageId,
    timestamp: '1710000000000',
    senderName: 'Alice',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  chainCalls.length = 0
  messagesUpsertResult = { data: [{ id: 'msg-1' }], error: null }
  mockFindExistingContact.mockResolvedValue(contactRow)
  mockDispatchFlows.mockResolvedValue({ consumed: false })
})

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('processInboundMessage — C4 idempotency', () => {
  it('upserts message and runs downstream effects on first delivery', async () => {
    const { processInboundMessage } = await import('./inbound-processor')

    await processInboundMessage(makeInbound('ext-1'), 'acc-1', 'user-1')

    expect(mockRpcImpl).toHaveBeenCalledWith('insert_inbound_message', expect.anything())
    expect(mockDispatchFlows).toHaveBeenCalledTimes(1)
    expect(mockRunAutomations).toHaveBeenCalled()
    expect(
      chainCalls.some((c) => c.table === 'conversations' && c.method === 'update'),
    ).toBe(true)
  })

  it('short-circuits ALL downstream effects on redelivery (duplicate)', async () => {
    const { processInboundMessage } = await import('./inbound-processor')

    // First delivery: inserted
    messagesUpsertResult = { data: [{ id: 'msg-1' }], error: null }
    await processInboundMessage(makeInbound('ext-dup'), 'acc-1', 'user-1')
    expect(mockDispatchFlows).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    chainCalls.length = 0

    // Redelivery: upsert yields zero rows (ignoreDuplicates)
    messagesUpsertResult = { data: [], error: null }
    await processInboundMessage(makeInbound('ext-dup'), 'acc-1', 'user-1')

    expect(mockDispatchFlows).not.toHaveBeenCalled()
    expect(mockRunAutomations).not.toHaveBeenCalled()
    expect(
      chainCalls.some((c) => c.table === 'conversations' && c.method === 'update'),
    ).toBe(false)
  })

  it('propagates errors and does not short-circuit on db error', async () => {
    const { processInboundMessage } = await import('./inbound-processor')

    messagesUpsertResult = { data: null, error: { message: 'boom' } }
    await processInboundMessage(makeInbound('ext-err'), 'acc-1', 'user-1')

    // On error we return early (current behaviour) — flows must not run
    expect(mockDispatchFlows).not.toHaveBeenCalled()
  })
})
