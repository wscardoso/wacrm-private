import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UazapiProvider } from './uazapi'

// =============================================================
// uazapi never follows redirects.
//
// Every uazapi call carries the instance token in custom headers (`apikey`,
// `token`). The fetch default (`redirect: 'follow'`) re-sends custom headers
// when a redirect crosses origins, so following one would hand the token to
// whoever the Location header names. A 3xx must therefore be a failure.
// =============================================================

const TOKEN = 'SECRET-INSTANCE-TOKEN'
const BASE = 'https://good.uazapi.dev'

describe('UazapiProvider with a stubbed fetch', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const provider = () => new UazapiProvider({ baseUrl: BASE, instanceId: 'inst', token: TOKEN })
  const redirect = (status = 302) =>
    new Response(null, { status, headers: { Location: 'https://evil.example/steal' } })
  const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

  const calledUrls = () => fetchMock.mock.calls.map((c) => String(c[0]))
  const everyCallIsManual = () =>
    fetchMock.mock.calls.every((c) => (c[1] as RequestInit | undefined)?.redirect === 'manual')

  it('sendText: sends with redirect "manual"', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ key: { id: 'm1' } }))
    await provider().sendText({ to: '5511999887766', text: 'oi' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(everyCallIsManual()).toBe(true)
  })

  it.each([301, 302, 303, 307, 308])(
    'sendText: a %i response is a failure and is never followed',
    async (status) => {
      fetchMock.mockResolvedValue(redirect(status))
      const p = provider()
      const err = await p.sendText({ to: '5511999887766', text: 'oi' }).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(String((err as Error).message)).toMatch(new RegExp(`failed \\(${status}\\)`))
      // Refused explicitly (not merely "not ok"), so the cause is identifiable.
      expect(String((err as Error).message)).toMatch(/redirect refused/)
      // Exactly one request, to the authorized server; the Location target is never requested.
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(calledUrls()).toEqual([`${BASE}/message/sendText/inst`])
      expect(calledUrls().some((u) => u.includes('evil.example'))).toBe(false)
      // Delivery semantics are unchanged: a non-listed status stays "ambiguous".
      expect(p.classifySendFailure(err)).toBe('ambiguous')
    },
  )

  it('getInstanceStatus: 3xx on both endpoints -> disconnected, no request leaves the base URL', async () => {
    fetchMock.mockResolvedValue(redirect())
    const res = await provider().getInstanceStatus()
    expect(res).toEqual({ status: 'disconnected', connected: false })
    expect(calledUrls()).toEqual([`${BASE}/instance/status`, `${BASE}/instance/connectionState/inst`])
    expect(everyCallIsManual()).toBe(true)
  })

  it('checkStatus: 3xx -> not connected', async () => {
    fetchMock.mockResolvedValue(redirect())
    await expect(provider().checkStatus()).resolves.toEqual({ connected: false })
    expect(calledUrls().every((u) => u.startsWith(BASE))).toBe(true)
    expect(everyCallIsManual()).toBe(true)
  })

  it('connectAndGetQrCode: 3xx on connect falls back to status without following', async () => {
    fetchMock.mockResolvedValue(redirect())
    const res = await provider().connectAndGetQrCode()
    expect(res).toEqual({ status: 'disconnected', connected: false })
    expect(calledUrls().every((u) => u.startsWith(BASE))).toBe(true)
    expect(calledUrls().some((u) => u.includes('evil.example'))).toBe(false)
    expect(everyCallIsManual()).toBe(true)
  })

  it('a normal 200 response still works end to end', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ instance: { status: 'connected' }, status: { connected: true, loggedIn: true } }),
    )
    await expect(provider().getInstanceStatus()).resolves.toMatchObject({ connected: true })
  })
})

// -------------------------------------------------------------
// Same property against the real fetch implementation, over loopback only:
// server A (the "authorized" base URL) answers 302 -> server B (another
// origin). B must never see a request, let alone the token.
// -------------------------------------------------------------
describe('UazapiProvider over real loopback sockets', () => {
  let a: http.Server
  let b: http.Server
  let baseA: string
  const seenAtB: Array<Record<string, string | string[] | undefined>> = []
  const seenAtA: string[] = []

  beforeEach(async () => {
    seenAtB.length = 0
    seenAtA.length = 0
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
    baseA = `http://127.0.0.1:${(a.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise((r) => a.close(r))
    await new Promise((r) => b.close(r))
  })

  it('GET paths: the token reaches only the authorized origin', async () => {
    const p = new UazapiProvider({ baseUrl: baseA, instanceId: 'inst', token: TOKEN })
    await expect(p.getInstanceStatus()).resolves.toEqual({ status: 'disconnected', connected: false })
    expect(seenAtA.length).toBeGreaterThan(0)
    expect(seenAtB).toEqual([])
  })

  it('POST path: the token and body reach only the authorized origin', async () => {
    const p = new UazapiProvider({ baseUrl: baseA, instanceId: 'inst', token: TOKEN })
    await expect(p.sendText({ to: '5511999887766', text: 'oi' })).rejects.toThrow(/failed \(302\)/)
    expect(seenAtA).toEqual(['POST /message/sendText/inst'])
    expect(seenAtB).toEqual([])
  })
})
