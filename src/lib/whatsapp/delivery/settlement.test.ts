import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleAcceptedSend, settleMessage, settleMessageSystem } from './settlement'
import type { SupabaseClient } from '@supabase/supabase-js'

// Commit 6.1 correção #7 — cobertura obrigatória de "Settlement":
// RPC jsonb retornando objeto já desserializado (comportamento real de
// supabase-js/PostgREST desde a migration 050) e comportamento sem
// `JSON.parse` quebrado. Antes da correção #2, `JSON.parse(data as
// string)` lançava TypeError quando `data` já chegava como objeto —
// exatamente o cenário coberto abaixo.

function fakeSupabase(rpcResult: { data: unknown; error: unknown }): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue(rpcResult),
  } as unknown as SupabaseClient
}

describe('settleMessage — defensive jsonb parsing (Commit 6.1 correção #2)', () => {
  it('accepts an already-deserialized object (current PostgREST/jsonb behavior)', async () => {
    const supabase = fakeSupabase({
      data: { messageId: 'm1', outcome: 'sent' },
      error: null,
    })
    const result = await settleMessage(supabase, 'm1', 'sent', 'conn-1', [], 'wamid.1')
    expect(result).toEqual({ messageId: 'm1', outcome: 'sent' })
  })

  it('still accepts a JSON string (legacy/alternate driver behavior)', async () => {
    const supabase = fakeSupabase({
      data: JSON.stringify({ messageId: 'm2', outcome: 'failed' }),
      error: null,
    })
    const result = await settleMessage(supabase, 'm2', 'failed', 'conn-1', [])
    expect(result).toEqual({ messageId: 'm2', outcome: 'failed' })
  })

  it('propagates RPC errors instead of attempting to parse', async () => {
    const supabase = fakeSupabase({ data: null, error: new Error('not authorized') })
    await expect(settleMessage(supabase, 'm3', 'failed', 'conn-1', [])).rejects.toThrow('not authorized')
  })
})

describe('settleMessageSystem — defensive jsonb parsing (Commit 6.1 correção #2)', () => {
  it('accepts an already-deserialized object', async () => {
    const supabase = fakeSupabase({
      data: { messageId: 'm4', outcome: 'noop' },
      error: null,
    })
    const result = await settleMessageSystem(supabase, 'm4', 'sent', 'conn-1', [], 'wamid.4')
    expect(result).toEqual({ messageId: 'm4', outcome: 'noop' })
  })

  it('still accepts a JSON string', async () => {
    const supabase = fakeSupabase({
      data: JSON.stringify({ messageId: 'm5', outcome: 'sent' }),
      error: null,
    })
    const result = await settleMessageSystem(supabase, 'm5', 'sent', 'conn-1', [], 'wamid.5')
    expect(result).toEqual({ messageId: 'm5', outcome: 'sent' })
  })
})

describe('settleAcceptedSend — settlement after the provider accepted', () => {
  afterEach(() => vi.restoreAllMocks())

  const ARGS = {
    messageId: 'm6',
    connectionRef: 'conn-1',
    externalIdentities: [{ kind: 'wamid', value: 'wamid.6' }],
    providerMessageId: 'wamid.6',
  }

  function scripted(settle: Array<{ data: unknown; error: unknown }>) {
    const queue = [...settle]
    const rpc = vi.fn(async (name: string) =>
      name.startsWith('settle_outbound_message')
        ? (queue.shift() ?? { data: { messageId: 'm6', outcome: 'sent' }, error: null })
        : { data: { enqueued: true }, error: null },
    )
    return { supabase: { rpc } as unknown as SupabaseClient, rpc }
  }

  it('first attempt ok: one settle call, not pending', async () => {
    const { supabase, rpc } = scripted([{ data: { messageId: 'm6', outcome: 'sent' }, error: null }])
    const r = await settleAcceptedSend(supabase, ARGS)
    expect(r).toEqual({ settlement: { messageId: 'm6', outcome: 'sent' }, pending: false })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('system actor uses the system facades for both settle and the reconciliation record', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase, rpc } = scripted([
      { data: null, error: { message: 'boom' } },
      { data: null, error: { message: 'boom' } },
    ])
    const r = await settleAcceptedSend(supabase, { ...ARGS, actor: 'system' })
    expect(r.pending).toBe(true)
    const names = rpc.mock.calls.map((c) => c[0])
    expect(names).toEqual(['settle_outbound_message_system', 'settle_outbound_message_system', 'enqueue_outbound_retry_system'])
  })

  it('never throws, even when the reconciliation record cannot be written either', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rpc = vi.fn(async () => {
      throw new Error('database unreachable')
    })
    const r = await settleAcceptedSend({ rpc } as unknown as SupabaseClient, ARGS)
    expect(r).toEqual({ settlement: { messageId: 'm6', outcome: 'noop' }, pending: true })
    const logged = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(' ')).join(' | ')
    expect(logged).toContain('ACCEPTED_SETTLE_PENDING')
    expect(logged).toContain('wamid.6')
  })

  it('does not attempt a "failed" settle at any point', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase, rpc } = scripted([
      { data: null, error: { message: 'boom' } },
      { data: null, error: { message: 'boom' } },
    ])
    await settleAcceptedSend(supabase, ARGS)
    const statuses = rpc.mock.calls.filter((c) => String(c[0]).startsWith('settle_')).map((c) => (c as unknown as [string, { p_status: string }])[1].p_status)
    expect(statuses).toEqual(['sent', 'sent'])
  })
})
