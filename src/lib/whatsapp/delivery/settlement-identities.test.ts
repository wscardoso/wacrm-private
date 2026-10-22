import { describe, expect, it, vi } from 'vitest'
import { settleMessage, settleMessageSystem } from './settlement'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeSupabase(rpcResult: { data: unknown; error: unknown }): SupabaseClient {
  return { rpc: vi.fn().mockResolvedValue(rpcResult) } as unknown as SupabaseClient
}

describe('settle* — blank external identities are never sent to the database', () => {
  const identities = [
    { kind: 'provider_message_id', value: '' },
    { kind: 'wamid', value: 'wamid.ok' },
  ]

  it('settleMessage drops identities whose value is empty (unique index would break the next message)', async () => {
    const supabase = fakeSupabase({ data: { messageId: 'm7', outcome: 'sent' }, error: null })
    await settleMessage(supabase, 'm7', 'sent', 'conn-1', identities, 'wamid.ok')
    const args = (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { p_identities: Array<{ value: string }> }
    expect(args.p_identities.map((i) => i.value)).toEqual(['wamid.ok'])
  })

  it('settleMessageSystem does the same', async () => {
    const supabase = fakeSupabase({ data: { messageId: 'm8', outcome: 'sent' }, error: null })
    await settleMessageSystem(supabase, 'm8', 'sent', 'conn-1', identities, 'wamid.ok')
    const args = (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as { p_identities: Array<{ value: string }> }
    expect(args.p_identities.map((i) => i.value)).toEqual(['wamid.ok'])
  })
})
