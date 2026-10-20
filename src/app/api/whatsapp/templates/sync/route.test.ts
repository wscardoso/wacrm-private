import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================
// POST /api/whatsapp/templates/sync
//
// The route pages through Meta's templates endpoint with the account's Bearer
// token and follows `paging.next` from the response body. That URL is data from
// a third party, so the token must only ever go to the same Graph endpoint.
// =============================================================

const h = vi.hoisted(() => ({
  messageTemplatesTouched: vi.fn(),
  decrypt: vi.fn((t: string) => t.replace(/^enc:/, '')),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decryptWithBindingContext: h.decrypt }))
vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'message_templates') h.messageTemplatesTouched(table)
      const result =
        table === 'profiles'
          ? { data: { account_id: 'acc-1' }, error: null }
          : table === 'whatsapp_config'
            ? { data: { waba_id: 'waba-1', access_token: 'enc:THE-TOKEN' }, error: null }
            : { data: null, error: null }
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'update', 'insert', 'order', 'limit']) chain[m] = () => chain
      chain.maybeSingle = async () => result
      chain.single = async () => result
      chain.then = (resolve: (v: unknown) => void) => resolve(result)
      return chain
    },
  }),
}))

import { POST } from './route'

const FIRST = 'https://graph.facebook.com/v21.0/waba-1/message_templates'

describe('POST /api/whatsapp/templates/sync: pagination', () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

  beforeEach(() => {
    fetchMock.mockReset()
    h.messageTemplatesTouched.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const page = (next?: string) =>
    new Response(JSON.stringify({ data: [], ...(next ? { paging: { next } } : {}) }), { status: 200 })
  const authorizationOf = (call: unknown[]) => (call[1] as RequestInit | undefined)?.headers

  it('follows a cursor on the same endpoint, sending the token only to Graph', async () => {
    fetchMock.mockImplementationOnce(async (url) => page(`${url}&after=CURSOR`)).mockImplementationOnce(async () => page())
    const res = await POST()
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(new URL(String(call[0])).origin).toBe('https://graph.facebook.com')
      expect(new URL(String(call[0])).pathname).toBe('/v21.0/waba-1/message_templates')
      expect(authorizationOf(call)).toEqual({ Authorization: 'Bearer THE-TOKEN' })
    }
    expect(String(fetchMock.mock.calls[1][0])).toContain('after=CURSOR')
  })

  it.each([
    ['another host', 'https://evil.example/v21.0/waba-1/message_templates?after=x'],
    ['a look-alike host', 'https://graph.facebook.com.evil.example/v21.0/waba-1/message_templates'],
    ['userinfo that spells Graph', 'https://graph.facebook.com@evil.example/v21.0/waba-1/message_templates'],
    ['plain http', 'http://graph.facebook.com/v21.0/waba-1/message_templates?after=x'],
    ['another port', 'https://graph.facebook.com:8443/v21.0/waba-1/message_templates?after=x'],
    ['another Graph node', 'https://graph.facebook.com/v21.0/me/accounts'],
    ['an IP literal', 'https://157.240.1.1/v21.0/waba-1/message_templates'],
    ['not a URL', 'not a url'],
  ])('%s in paging.next: the token is never sent there, the sync stops with a generic 502', async (_label, hostile) => {
    fetchMock.mockImplementation(async () => page(hostile))
    const res = await POST()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Unexpected pagination response from Meta.' })
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the legitimate first page
    expect(String(fetchMock.mock.calls[0][0]).startsWith(FIRST)).toBe(true)
    expect(h.messageTemplatesTouched).not.toHaveBeenCalled() // nothing was written
  })

  it('a hostile URL on a later page also stops the sync', async () => {
    fetchMock
      .mockImplementationOnce(async (url) => page(`${url}&after=C1`))
      .mockImplementationOnce(async () => page('https://evil.example/steal'))
    const res = await POST()
    expect(res.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((c) => new URL(String(c[0])).hostname === 'graph.facebook.com')).toBe(true)
  })
})
