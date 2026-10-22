import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================
// GET /api/whatsapp/uazapi/status (role: agent) and
// POST /api/whatsapp/uazapi/qr (role: admin)
//
// The stored uazapi token must only ever be paired with the stored base_url.
// A request that names another server must not make the route decrypt the
// stored token, build a provider with it, or contact the named server with it.
// =============================================================

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  decrypt: vi.fn(),
  config: { current: null as Record<string, unknown> | null },
  providerCtor: vi.fn(),
  getInstanceStatus: vi.fn(),
  connectAndGetQrCode: vi.fn(),
  updateEq: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (err: unknown) =>
    NextResponse.json({ error: (err as Error).message ?? 'Auth error' }, { status: 403 }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({ decryptWithBindingContext: h.decrypt }))
vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
}))

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: h.config.current }),
        }
        return chain
      },
      update: () => ({ eq: h.updateEq }),
    }),
  }),
}))

vi.mock('@/lib/whatsapp/providers/uazapi', () => ({
  UazapiProvider: class {
    constructor(args: unknown) {
      h.providerCtor(args)
    }
    getInstanceStatus = h.getInstanceStatus
    connectAndGetQrCode = h.connectAndGetQrCode
  },
}))

import { GET as statusGET } from './status/route'
import { POST as qrPOST } from './qr/route'

const STORED = {
  id: 'cfg-1',
  provider: 'uazapi',
  status: 'connected',
  base_url: 'https://good.uazapi.dev',
  instance_id: 'inst-1',
  access_token: 'CIPHERTEXT',
}

type Query = { baseUrl?: string; instanceId?: string; token?: string }

const callStatus = (q: Query = {}) => {
  const url = new URL('https://crm.test/api/whatsapp/uazapi/status')
  for (const [k, v] of Object.entries(q)) if (v !== undefined) url.searchParams.set(k, v)
  return statusGET(new Request(url))
}
const callQr = (q: Query = {}) =>
  qrPOST(
    new Request('https://crm.test/api/whatsapp/uazapi/qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(q),
    }),
  )

const routes: Array<[string, (q?: Query) => Promise<Response>, 'agent' | 'admin']> = [
  ['status (GET, agent)', callStatus, 'agent'],
  ['qr (POST, admin)', callQr, 'admin'],
]

beforeEach(() => {
  vi.clearAllMocks()
  h.requireRole.mockResolvedValue({ accountId: 'acc-1' })
  h.decrypt.mockReturnValue('STORED-TOKEN')
  h.config.current = { ...STORED }
  h.getInstanceStatus.mockResolvedValue({ status: 'connected', connected: true })
  h.connectAndGetQrCode.mockResolvedValue({ status: 'connecting', connected: false })
  h.updateEq.mockResolvedValue({ error: null })
})

describe.each(routes)('%s', (_name, call, role) => {
  it(`requires the ${role} role`, async () => {
    await call()
    expect(h.requireRole).toHaveBeenCalledWith(role)
  })

  describe('divergent target: the stored token is neither decrypted nor used', () => {
    const attacks: Array<[string, string, number]> = [
      ['another host', 'https://evil.example', 400],
      ['suffix attack', 'https://good.uazapi.dev.evil.example', 400],
      ['another port', 'https://good.uazapi.dev:8443', 400],
      ['scheme downgrade', 'http://good.uazapi.dev', 400],
      ['userinfo trick', 'https://good.uazapi.dev@evil.example', 400],
      ['fragment trick', 'https://evil.example#@good.uazapi.dev', 400],
      ['query trick', 'https://evil.example/?x=good.uazapi.dev', 400],
      ['backslash trick', 'https://evil.example\\@good.uazapi.dev', 400],
      ['loopback', 'https://127.0.0.1', 400],
    ]

    it.each(attacks)('%s -> %i, no decrypt, no provider', async (_label, baseUrl, expected) => {
      const res = await call({ baseUrl })
      expect(res.status).toBe(expected)
      expect(h.decrypt).not.toHaveBeenCalled()
      expect(h.providerCtor).not.toHaveBeenCalled()
      expect(h.getInstanceStatus).not.toHaveBeenCalled()
      expect(h.connectAndGetQrCode).not.toHaveBeenCalled()
    })

    it('says that a token is needed for another server', async () => {
      const res = await call({ baseUrl: 'https://evil.example' })
      const body = await res.json()
      expect(body.error).toMatch(/token/i)
    })
  })

  describe('authorized target', () => {
    it('no baseUrl: uses the stored server and the stored token', async () => {
      const res = await call()
      expect(res.status).toBe(200)
      expect(h.decrypt).toHaveBeenCalledTimes(1)
      expect(h.decrypt).toHaveBeenCalledWith('CIPHERTEXT', 'whatsapp_config:acc-1')
      expect(h.providerCtor).toHaveBeenCalledWith({
        baseUrl: 'https://good.uazapi.dev',
        instanceId: 'inst-1',
        token: 'STORED-TOKEN',
      })
    })

    it('same server spelled differently: the stored spelling is what the provider receives', async () => {
      await call({ baseUrl: 'https://GOOD.uazapi.dev/' })
      expect(h.providerCtor).toHaveBeenCalledWith({
        baseUrl: 'https://good.uazapi.dev',
        instanceId: 'inst-1',
        token: 'STORED-TOKEN',
      })
    })
  })

  describe('caller-supplied token is the caller\'s own credential', () => {
    it('is sent to the server the caller names; the stored token is not decrypted', async () => {
      const res = await call({ baseUrl: 'https://my.own.server', token: 'CALLER-TOKEN' })
      expect(res.status).toBe(200)
      expect(h.decrypt).not.toHaveBeenCalled()
      expect(h.providerCtor).toHaveBeenCalledWith({
        baseUrl: 'https://my.own.server',
        instanceId: 'inst-1',
        token: 'CALLER-TOKEN',
      })
    })

    it('never mixes the stored token into a request that has its own token', async () => {
      await call({ baseUrl: 'https://my.own.server', instanceId: 'x', token: 'CALLER-TOKEN' })
      const args = h.providerCtor.mock.calls[0][0] as { token: string }
      expect(args.token).toBe('CALLER-TOKEN')
      expect(h.decrypt).not.toHaveBeenCalled()
    })
  })

  describe('no configuration', () => {
    it('nothing stored and nothing supplied -> incomplete, no provider', async () => {
      h.config.current = null
      const res = await call()
      expect([200, 400]).toContain(res.status)
      expect(h.providerCtor).not.toHaveBeenCalled()
      expect(h.decrypt).not.toHaveBeenCalled()
    })

    it('a decrypt failure is reported as incomplete, never as a crash', async () => {
      h.decrypt.mockImplementation(() => {
        throw new Error('bad key')
      })
      const res = await call()
      expect(res.status).not.toBe(500)
      expect(h.providerCtor).not.toHaveBeenCalled()
    })
  })

  it('an authorization failure stops everything', async () => {
    h.requireRole.mockRejectedValue(new Error('forbidden'))
    const res = await call({ baseUrl: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(h.decrypt).not.toHaveBeenCalled()
    expect(h.providerCtor).not.toHaveBeenCalled()
  })
})

describe('status route: response shape is preserved', () => {
  it('incomplete configuration stays a 200 "disconnected"', async () => {
    h.config.current = null
    const res = await callStatus()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ connected: false, status: 'disconnected' })
  })
})

describe('qr route: response shape is preserved', () => {
  it('incomplete configuration stays a 400 with the original message', async () => {
    h.config.current = null
    const res = await callQr()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Configuração incompleta/)
  })
})
