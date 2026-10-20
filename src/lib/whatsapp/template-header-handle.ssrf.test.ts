import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeHttpsNetwork, type FakeResponse } from '@/test/fake-https-network'

// =============================================================
// The template header URL is typed by a tenant member and downloaded by this
// server. Here the real safeFetch runs against a fake dns/https pair that
// writes request bytes only after the connection's lookup accepted the
// address, so `network.sent` is exactly "what left the server". For a refused
// destination it must be empty, and nothing may be uploaded to Meta.
// =============================================================

const h = vi.hoisted(() => ({
  net: null as null | {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dnsLookup: (...a: any[]) => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (...a: any[]) => unknown
  },
  upload: vi.fn(async () => ({ handle: 'HANDLE123' })),
}))

vi.mock('node:dns', () => ({ default: { lookup: (...a: unknown[]) => h.net!.dnsLookup(...a) } }))
vi.mock('node:https', () => ({
  default: { request: (...a: unknown[]) => h.net!.request(...a), Agent: class {} },
}))
vi.mock('./meta-api', () => ({ uploadResumableMedia: h.upload }))

import { ensureImageHeaderHandle } from './template-header-handle'
import type { TemplatePayload } from './template-validators'

const GENERIC = 'Could not fetch the header image URL. Make sure it is publicly reachable.'
const noStorage = {
  storage: {
    from: () => {
      throw new Error('storage must not be used for a pasted external URL')
    },
  },
} as unknown as SupabaseClient

const payload = (url: string): TemplatePayload => ({
  name: 't',
  category: 'Utility',
  language: 'en_US',
  body_text: 'hi',
  header_type: 'image',
  header_media_url: url,
})

let network: ReturnType<typeof createFakeHttpsNetwork>
const globalFetch = vi.fn()

function install(dnsTable: Parameters<typeof createFakeHttpsNetwork>[0], respond?: (host: string) => FakeResponse) {
  network = createFakeHttpsNetwork(dnsTable, respond)
  h.net = network
}

beforeEach(() => {
  vi.stubEnv('META_APP_ID', 'app-1')
  h.upload.mockClear()
  globalFetch.mockReset()
  vi.stubGlobal('fetch', globalFetch)
  install({ 'cdn.example.com': ['93.184.216.34'] }, () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: 'PNGDATA',
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  h.net = null
})

describe('template header URL: a public https image still works', () => {
  it('is downloaded over the policy-checked connection and uploaded to Meta', async () => {
    const p = payload('https://cdn.example.com/a/b.png?v=2')
    await ensureImageHeaderHandle(p, 'tok', noStorage)
    expect(network.sent).toHaveLength(1)
    expect(network.sent[0]).toMatchObject({ host: 'cdn.example.com', address: '93.184.216.34', method: 'GET', path: '/a/b.png?v=2' })
    expect(h.upload).toHaveBeenCalledOnce()
    expect(p.header_handle).toBe('HANDLE123')
    expect(globalFetch).not.toHaveBeenCalled()
  })
})

describe('template header URL: refused destinations', () => {
  const byUrlPolicy: Array<[string, string]> = [
    ['plain http', 'http://cdn.example.com/a.png'],
    ['non-443 port', 'https://cdn.example.com:8443/a.png'],
    ['cloud metadata literal', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback literal', 'https://127.0.0.1/a.png'],
    ['private literal', 'https://192.168.0.10/a.png'],
    ['internal single-label host', 'https://supabase-kong/a.png'],
    ['localhost', 'https://localhost/a.png'],
  ]
  it.each(byUrlPolicy)('%s: no connection, no upload, generic message', async (_label, url) => {
    const error = await ensureImageHeaderHandle(payload(url), 'tok', noStorage).catch((e) => e)
    expect(error.message).toBe(GENERIC)
    expect(network.attempts).toHaveLength(0)
    expect(network.sent).toHaveLength(0)
    expect(h.upload).not.toHaveBeenCalled()
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['private', ['10.0.0.5']],
    ['loopback', ['127.0.0.1']],
    ['link-local', ['169.254.169.254']],
    ['IPv6 unique-local', ['fd00::1']],
    ['mixed public + private', ['93.184.216.34', '10.0.0.5']],
  ])('a name resolving to a %s address: nothing is sent, nothing uploaded, same message as any failure', async (_label, addresses) => {
    install({ 'evil.example.com': addresses })
    const error = await ensureImageHeaderHandle(payload('https://evil.example.com/a.png'), 'tok', noStorage).catch((e) => e)
    expect(error.message).toBe(GENERIC)
    expect(network.sent).toHaveLength(0)
    expect(h.upload).not.toHaveBeenCalled()
  })

  it('an unresolvable name gives the same message as a refused one (no probing oracle between the two)', async () => {
    const refused = await ensureImageHeaderHandle(payload('https://127.0.0.1/a.png'), 'tok', noStorage).catch((e) => e)
    const unresolved = await ensureImageHeaderHandle(payload('https://nowhere.example.com/a.png'), 'tok', noStorage).catch((e) => e)
    expect(unresolved.message).toBe(refused.message)
  })

  it('DNS rebinding: a name that turns private on the connection is refused', async () => {
    install({ 'rebind.example.com': () => ['169.254.169.254'] })
    const error = await ensureImageHeaderHandle(payload('https://rebind.example.com/a.png'), 'tok', noStorage).catch((e) => e)
    expect(error.message).toBe(GENERIC)
    expect(network.sent).toHaveLength(0)
  })

  it('a redirect to an internal address is not followed: the target is never resolved or contacted', async () => {
    install({ 'cdn.example.com': ['93.184.216.34'], 'internal.example.com': ['10.0.0.5'] }, (host) =>
      host === 'cdn.example.com'
        ? { status: 302, headers: { location: 'https://internal.example.com/admin.png' } }
        : { status: 200, headers: { 'content-type': 'image/png' }, body: 'INTERNAL' },
    )
    await expect(ensureImageHeaderHandle(payload('https://cdn.example.com/a.png'), 'tok', noStorage)).rejects.toThrow(/redirects/)
    expect(network.attempts).toEqual(['cdn.example.com'])
    expect(network.resolved).not.toContain('internal.example.com')
    expect(h.upload).not.toHaveBeenCalled()
  })

  it('an image larger than 5 MB is rejected from the declared length, before the body is read', async () => {
    install({ 'cdn.example.com': ['93.184.216.34'] }, () => ({
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(40 * 1024 * 1024) },
    }))
    await expect(ensureImageHeaderHandle(payload('https://cdn.example.com/big.png'), 'tok', noStorage)).rejects.toThrow(/5 MB/)
    expect(h.upload).not.toHaveBeenCalled()
  })
})
