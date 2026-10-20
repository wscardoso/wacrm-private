import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DestinationNotAllowedError,
  SafeFetchError,
  createSafeFetchClient,
} from '@/lib/http/safe-fetch'
import { UazapiProvider } from './uazapi'

// =============================================================
// How UazapiProvider uses safeFetch.
//
// Every uazapi call carries the instance token in custom headers (`apikey`,
// `token`). The provider must therefore (1) send everything through safeFetch,
// never the global fetch, (2) treat a redirect as a failure that never leaves
// the authorized server, and (3) keep delivery classification working with the
// errors safeFetch raises. The network policy itself (public addresses only,
// https/443, rebinding, limits) is tested in src/lib/http/safe-fetch.test.ts.
// =============================================================

const h = vi.hoisted(() => ({ impl: undefined as undefined | ((url: string, init?: unknown) => Promise<Response>) }))

vi.mock('@/lib/http/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/http/safe-fetch')>()),
  safeFetch: (url: string, init?: unknown) => {
    if (!h.impl) throw new Error('test did not install a safeFetch implementation')
    return h.impl(url, init)
  },
}))

const TOKEN = 'SECRET-INSTANCE-TOKEN'
const BASE = 'https://good.uazapi.dev'
const provider = (baseUrl = BASE) => new UazapiProvider({ baseUrl, instanceId: 'inst', token: TOKEN })
const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('UazapiProvider -> safeFetch', () => {
  const safeFetchMock = vi.fn<(url: string, init?: Record<string, unknown>) => Promise<Response>>()
  const globalFetch = vi.fn()

  beforeEach(() => {
    safeFetchMock.mockReset()
    globalFetch.mockReset()
    h.impl = safeFetchMock as never
    vi.stubGlobal('fetch', globalFetch) // must never be used
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    h.impl = undefined
  })

  const urls = () => safeFetchMock.mock.calls.map((c) => c[0])

  it('sends through safeFetch with method, token headers and body, and never through the global fetch', async () => {
    safeFetchMock.mockResolvedValueOnce(okJson({ key: { id: 'm1' } }))
    await provider().sendText({ to: '5511999887766', text: 'oi' })
    expect(globalFetch).not.toHaveBeenCalled()
    expect(safeFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = safeFetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/message/sendText/inst`)
    expect(init).toMatchObject({ method: 'POST', headers: { apikey: TOKEN, token: TOKEN } })
    expect(typeof init?.body).toBe('string')
    expect(init?.maxResponseBytes).toBe(2 * 1024 * 1024)
    // The provider has no say over redirects or the connection: those options do not exist for callers.
    expect(init).not.toHaveProperty('redirect')
    expect(init).not.toHaveProperty('agent')
    expect(init).not.toHaveProperty('lookup')
  })

  it('a trailing slash on the base URL does not double up', async () => {
    safeFetchMock.mockResolvedValueOnce(okJson({}))
    await provider(`${BASE}/`).getInstanceStatus()
    expect(urls()[0]).toBe(`${BASE}/instance/status`)
  })

  it('every network entry point goes through safeFetch', async () => {
    safeFetchMock.mockImplementation(async () =>
      okJson({ instance: { status: 'connected', state: 'open' }, status: { connected: true, loggedIn: true } }),
    )
    const p = provider()
    await p.checkStatus()
    await p.connectAndGetQrCode()
    await p.getInstanceStatus()
    await p.sendText({ to: '5511999887766', text: 'oi' })
    expect(safeFetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(urls().every((u) => u.startsWith(BASE))).toBe(true)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  describe('redirects', () => {
    it.each([301, 302, 303, 307, 308])(
      '%i from safeFetch becomes the "failed (<status>)" error and is classified like any other unlisted status',
      async (status) => {
        safeFetchMock.mockRejectedValue(new SafeFetchError('redirect', { status }))
        const p = provider()
        const error = await p.sendText({ to: '5511999887766', text: 'oi' }).catch((e) => e)
        expect(String(error.message)).toMatch(new RegExp(`failed \\(${status}\\)`))
        expect(String(error.message)).toMatch(/redirect refused/)
        expect(p.classifySendFailure(error)).toBe('ambiguous')
        expect(safeFetchMock).toHaveBeenCalledTimes(1) // no second request, to anywhere
      },
    )

    it('a 3xx response that safeFetch did hand back (no Location) is still a failure', async () => {
      safeFetchMock.mockResolvedValue(new Response(null, { status: 304 }))
      const error = await provider().sendText({ to: '5511999887766', text: 'oi' }).catch((e) => e)
      expect(String(error.message)).toMatch(/failed \(304\).*redirect refused/)
    })

    it('GET paths: a redirect on every endpoint means disconnected, with no request outside the base URL', async () => {
      safeFetchMock.mockRejectedValue(new SafeFetchError('redirect', { status: 302 }))
      const p = provider()
      await expect(p.getInstanceStatus()).resolves.toEqual({ status: 'disconnected', connected: false })
      await expect(p.checkStatus()).resolves.toEqual({ connected: false })
      await expect(p.connectAndGetQrCode()).resolves.toEqual({ status: 'disconnected', connected: false })
      expect(urls().every((u) => u.startsWith(BASE))).toBe(true)
    })
  })

  describe('delivery classification keeps working with safeFetch errors', () => {
    const classify = (error: unknown) => provider().classifySendFailure(error)

    it('a refused destination is deterministic-permanent: nothing was sent and it stays refused until the configuration changes', () => {
      expect(classify(new DestinationNotAllowedError('address'))).toBe('deterministic-permanent')
      expect(classify(new DestinationNotAllowedError('ip_literal'))).toBe('deterministic-permanent')
    })

    it.each([['ECONNREFUSED'], ['ENOTFOUND'], ['EAI_AGAIN']])(
      'network error with cause %s stays deterministic-transient',
      (code) => {
        const error = new SafeFetchError('network', { cause: Object.assign(new Error('x'), { code }) })
        expect(classify(error)).toBe('deterministic-transient')
      },
    )

    it.each([
      ['timeout', new SafeFetchError('timeout')],
      ['response too large', new SafeFetchError('response_too_large')],
      ['aborted', new SafeFetchError('aborted')],
      [
        'network error with another cause',
        new SafeFetchError('network', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }),
      ],
    ])('%s is ambiguous (the request may have been processed)', (_label, error) => {
      expect(classify(error)).toBe('ambiguous')
    })

    it('HTTP statuses keep their existing meaning', async () => {
      safeFetchMock.mockResolvedValue(new Response('no', { status: 401 }))
      const p = provider()
      const error = await p.sendText({ to: '5511999887766', text: 'oi' }).catch((e) => e)
      expect(p.classifySendFailure(error)).toBe('deterministic-permanent')
    })

    it('a destination refusal reaches the caller of sendText as itself', async () => {
      safeFetchMock.mockRejectedValue(new DestinationNotAllowedError('address'))
      const error = await provider().sendText({ to: '5511999887766', text: 'oi' }).catch((e) => e)
      expect(error).toBeInstanceOf(DestinationNotAllowedError)
    })

    it('GET paths swallow a destination refusal into "disconnected" and reveal nothing', async () => {
      safeFetchMock.mockRejectedValue(new DestinationNotAllowedError('address'))
      await expect(provider().getInstanceStatus()).resolves.toEqual({ status: 'disconnected', connected: false })
    })
  })
})

// -------------------------------------------------------------
// The same property end to end: the provider on top of a REAL safeFetch client
// over loopback sockets. Server A is the authorized base URL and answers 302 to
// server B on another origin. B must never see a request, let alone the token.
// -------------------------------------------------------------
describe('UazapiProvider on a real safeFetch client (loopback)', () => {
  let a: http.Server
  let b: http.Server
  let portA: number
  const seenAtB: Array<Record<string, string | string[] | undefined>> = []
  const seenAtA: string[] = []

  beforeEach(async () => {
    seenAtA.length = 0
    seenAtB.length = 0
    b = http.createServer((req, res) => {
      seenAtB.push({ apikey: req.headers['apikey'], token: req.headers['token'] })
      res.end('{}')
    })
    await new Promise<void>((r) => b.listen(0, '127.0.0.1', r))
    const portB = (b.address() as AddressInfo).port
    a = http.createServer((req, res) => {
      seenAtA.push(`${req.method} ${req.url}`)
      res.statusCode = 302
      res.setHeader('Location', `http://127.0.0.1:${portB}/stolen`)
      res.end()
    })
    await new Promise<void>((r) => a.listen(0, '127.0.0.1', r))
    portA = (a.address() as AddressInfo).port

    const client = createSafeFetchClient({
      resolve: (_host, _opts, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
      isAddressAllowed: (address) => address === '127.0.0.1', // stand-in for "public"
      transport: {
        request: (options, onResponse) => http.request(options, onResponse),
        createAgent: () => new http.Agent({ keepAlive: false }),
        connectEvent: 'connect',
      },
      checkUrl: (input) => new URL(input), // test-only: lets a loopback URL through
    })
    h.impl = (url, init) => client.safeFetch(url, init as never)
  })
  afterEach(async () => {
    h.impl = undefined
    await new Promise((r) => a.close(r))
    await new Promise((r) => b.close(r))
  })

  it('GET paths: the token reaches only the authorized origin', async () => {
    const p = provider(`http://good.test:${portA}`)
    await expect(p.getInstanceStatus()).resolves.toEqual({ status: 'disconnected', connected: false })
    expect(seenAtA.length).toBeGreaterThan(0)
    expect(seenAtB).toEqual([])
  })

  it('POST path: the token and body reach only the authorized origin', async () => {
    const p = provider(`http://good.test:${portA}`)
    await expect(p.sendText({ to: '5511999887766', text: 'oi' })).rejects.toThrow(/failed \(302\).*redirect refused/)
    expect(seenAtA).toEqual(['POST /message/sendText/inst'])
    expect(seenAtB).toEqual([])
  })
})
