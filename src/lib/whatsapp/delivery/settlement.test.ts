import { describe, expect, it, vi } from 'vitest'
import { settleMessage, settleMessageSystem } from './settlement'
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
