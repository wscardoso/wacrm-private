import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------

const chainCalls: Array<{ table: string; method: string }> = []

// Controls what the messages table returns for the idempotency upsert.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let messagesUpsertResult: { data: any; error: any } = { data: [{ id: 'msg-1' }], error: null }

function makeChain() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.then = (resolve: (v: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let error: any = null
    if (chain.__table === 'conversations') {
      data = { id: 'conv-1', unread_count: 5, account_id: 'acc-1', user_id: 'user-1', contact_id: 'contact-1' }
    } else if (chain.__table === 'messages') {
      data = messagesUpsertResult.data
      error = messagesUpsertResult.error
    } else if (chain.__table === 'inbound_turn_jobs') {
      data = {
        downstream_context: {
          accountId: 'acc-1', contactId: 'contact-1', conversationId: 'conv-1',
          configOwnerUserId: 'user-1', inboundText: 'Hello!', inboundType: 'text',
          externalMessageId: 'ext-1', isFirstInboundMessage: true, contactWasCreated: false,
          lastMessagePreview: 'Hello!', unreadCountBefore: 5,
        },
      }
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
  void _params
  if (fn === 'persist_inbound_message_with_turn' || fn === 'insert_inbound_message') {
    if (messagesUpsertResult.error) return Promise.resolve({ data: null, error: messagesUpsertResult.error })
    const id = messagesUpsertResult.data?.[0]?.id ?? null
    if (!id) {
      return Promise.resolve({
        data: { message_id: 'msg-existing', message_inserted: false, job_ready: true },
        error: null,
      })
    }
    return Promise.resolve({
      data: { message_id: id, message_inserted: true, job_ready: true },
      error: null,
    })
  }
  if (fn === 'claim_inbound_turn_for_message') {
    return Promise.resolve({
      data: [{ message_id: _params.p_message_id, account_id: 'acc-1', contact_id: 'contact-1', conversation_id: 'conv-1', claim_token: 'tok' }],
      error: null,
    })
  }
  if (fn === 'complete_inbound_turn_job') return Promise.resolve({ data: true, error: null })
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findExistingContact: (a: any, b: any) => (mockFindExistingContact as any)(a, b),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isUniqueViolation: (a: any) => (mockIsUniqueViolation as any)(a),
}))

const mockRunAutomations = vi.fn()
const mockCancelPendingCadences = vi.fn(async () => 0)
vi.mock('@/lib/automations/engine', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runAutomationsForTrigger: (..._a: any[]) => (mockRunAutomations as any)(..._a),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cancelPendingCadencesForContact: (..._a: any[]) => (mockCancelPendingCadences as any)(..._a),
}))

const mockDispatchFlows = vi.fn(async () => ({ consumed: false }))
vi.mock('@/lib/flows/engine', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    expect(mockRpcImpl).toHaveBeenCalledWith('persist_inbound_message_with_turn', expect.anything())
    expect(mockDispatchFlows).toHaveBeenCalledTimes(1)
    expect(mockRunAutomations).toHaveBeenCalled()
    // The conversation effect is one atomic, once-per-message database call (093).
    expect(mockRpcImpl).toHaveBeenCalledWith(
      'apply_inbound_message_to_conversation',
      expect.objectContaining({ p_message_id: expect.any(String), p_preview: expect.any(String) }),
    )
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

  it('throws InboundPersistenceError (not a silent return) on a message-insert db error, and runs no downstream effect', async () => {
    const { processInboundMessage } = await import('./inbound-processor')
    const { InboundPersistenceError } = await import('./inbound-dlq')

    messagesUpsertResult = { data: null, error: { message: 'boom', code: 'XX000' } }
    const err = await processInboundMessage(makeInbound('ext-err'), 'acc-1', 'user-1').catch((e) => e)

    expect(err).toBeInstanceOf(InboundPersistenceError)
    expect(err.stage).toBe('message_insert')
    expect(err.dbCode).toBe('XX000')
    // The raw DB message must not travel inside the error.
    expect(String(err.message)).not.toContain('boom')
    expect(mockDispatchFlows).not.toHaveBeenCalled()
    expect(mockRunAutomations).not.toHaveBeenCalled()
    expect(mockCancelPendingCadences).not.toHaveBeenCalled()
  })

  it('a legitimate duplicate still returns normally (does not throw)', async () => {
    const { processInboundMessage } = await import('./inbound-processor')
    messagesUpsertResult = { data: [], error: null }
    await expect(processInboundMessage(makeInbound('ext-dup'), 'acc-1', 'user-1')).resolves.toBeUndefined()
  })

  it('D-C: an unknown event WITHOUT message id creates no contact/conversation/message and runs no effect', async () => {
    const { processInboundMessage } = await import('./inbound-processor')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await processInboundMessage(
      { type: 'unknown' as const, from: '15559876543', messageId: '', timestamp: '1710000000000' },
      'acc-1', 'user-1',
    )
    expect(mockFromImpl).not.toHaveBeenCalled()
    expect(mockRpcImpl).not.toHaveBeenCalled()
    expect(mockFindExistingContact).not.toHaveBeenCalled()
    expect(mockDispatchFlows).not.toHaveBeenCalled()
    expect(mockRunAutomations).not.toHaveBeenCalled()
    expect(mockCancelPendingCadences).not.toHaveBeenCalled()
  })

  it('D-C does not swallow legitimate cases: an unknown type WITH a message id is still stored, a reaction never inserts a message', async () => {
    const { processInboundMessage } = await import('./inbound-processor')
    await processInboundMessage(
      { type: 'unknown' as const, from: '15559876543', messageId: 'ext-unk-1', timestamp: '1710000000000' },
      'acc-1', 'user-1',
    )
    expect(mockRpcImpl.mock.calls.filter((c) => c[0] === 'persist_inbound_message_with_turn')).toHaveLength(1)

    mockRpcImpl.mockClear()
    await processInboundMessage(
      { type: 'reaction' as const, from: '15559876543', messageId: 'ext-react-1', timestamp: '1710000000000', reactionTargetMessageId: 't', reactionEmoji: 'x' },
      'acc-1', 'user-1',
    )
    expect(mockRpcImpl.mock.calls.filter((c) => c[0] === 'insert_inbound_message')).toHaveLength(0)
  })

  it('wraps an exception thrown AFTER the insert in InboundPostInsertError', async () => {
    const { processInboundMessage } = await import('./inbound-processor')
    const { InboundPostInsertError } = await import('./inbound-dlq')
    mockDispatchFlows.mockRejectedValueOnce(new Error('flow boom'))
    const err = await processInboundMessage(makeInbound('ext-post'), 'acc-1', 'user-1').catch((e) => e)
    expect(err).toBeInstanceOf(InboundPostInsertError)
  })
})
