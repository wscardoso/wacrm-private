import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================
// sendViaMeta writes with the service-role client, which bypasses RLS. The
// conversation update that follows a send must therefore be scoped to the
// account the send belongs to, so that even a conversation id that slipped
// through can never change a conversation of another account.
// =============================================================

const h = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}))

vi.mock('./admin-client', () => {
  function builder(table: string) {
    const filters: Array<[string, unknown]> = []
    let type = 'select'
    const done = () => {
      if (type === 'update') h.updates.push({ table, filters: [...filters] })
      if (table === 'contacts') return { data: { id: 'c1', phone: '5511999887766' }, error: null }
      if (table === 'whatsapp_config')
        return {
          data: { id: 'cfg1', account_id: 'acct-1', provider: 'zapi', instance_id: 'i', access_token: 'x', waba_id: null },
          error: null,
        }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: () => ((type = 'insert'), b),
      update: () => ((type = 'update'), b),
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      single: () => Promise.resolve(done()),
      maybeSingle: () => Promise.resolve(done()),
      then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(done()).then(f, r),
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }
})

vi.mock('@/lib/whatsapp/encryption', () => ({ decryptWithBindingContext: () => 'token' }))
vi.mock('@/lib/whatsapp/config-binding', () => ({ whatsappConfigBindingContext: () => ({}) }))
vi.mock('@/lib/whatsapp/providers', () => ({
  getProvider: () => ({ sendText: async () => ({ messageId: 'wamid', externalIdentities: [] }) }),
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  sanitizePhoneForMeta: (p: string) => p,
  isValidE164: () => true,
  sendWithPhoneVariantRetry: async (phone: string, _id: string, attempt: (p: string) => Promise<string>) => ({
    result: await attempt(phone),
  }),
}))
vi.mock('@/lib/whatsapp/delivery/settlement', () => ({ settleMessageSystem: vi.fn(async () => undefined) }))
vi.mock('@/lib/whatsapp/delivery/sender', () => ({ handleSendFailure: vi.fn() }))

import { engineSendText } from './meta-send'

describe('engineSendText: conversation update is scoped to the sending account', () => {
  beforeEach(() => {
    h.updates = []
  })

  it('filters the conversations update by both id and account_id', async () => {
    await engineSendText({
      accountId: 'acct-1',
      userId: 'u1',
      conversationId: 'conv-1',
      contactId: 'c1',
      text: 'oi',
    })
    const update = h.updates.find((u) => u.table === 'conversations')
    expect(update).toBeDefined()
    expect(update!.filters).toEqual(
      expect.arrayContaining([
        ['id', 'conv-1'],
        ['account_id', 'acct-1'],
      ]),
    )
  })
})
