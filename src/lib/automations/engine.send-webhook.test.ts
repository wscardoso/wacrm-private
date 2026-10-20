import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeHttpsNetwork, type FakeResponse } from '@/test/fake-https-network'

// =============================================================
// send_webhook runs with the server's network position and a tenant-authored
// URL and headers. These tests drive the real engine step through the real
// safeFetch, with only node:dns / node:https replaced by a fake that writes
// request bytes only once the connection's lookup has accepted the address
// (src/test/fake-https-network.ts). The assertion that matters for a refused
// destination is `network.sent` being empty: neither the payload nor the
// tenant's headers left.
// =============================================================

const h = vi.hoisted(() => ({
  net: null as null | {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dnsLookup: (...a: any[]) => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: (...a: any[]) => unknown
  },
  steps: [] as Record<string, unknown>[],
  logUpdates: [] as Record<string, unknown>[],
}))

vi.mock('node:dns', () => ({ default: { lookup: (...a: unknown[]) => h.net!.dnsLookup(...a) } }))
vi.mock('node:https', () => ({
  default: { request: (...a: unknown[]) => h.net!.request(...a), Agent: class {} },
}))

vi.mock('./admin-client', () => {
  function builder(table: string) {
    let type = 'select'
    let payload: unknown
    const resolve = () => {
      if (table === 'automations')
        return {
          data: [
            {
              id: 'a1',
              account_id: 'acct-1',
              user_id: 'u1',
              name: 'wh',
              trigger_type: 'new_message_received',
              trigger_config: {},
              is_active: true,
            },
          ],
          error: null,
        }
      if (table === 'contacts') return { data: { id: 'c1' }, error: null }
      if (table === 'automation_steps') return { data: h.steps, error: null }
      if (table === 'automation_logs') {
        if (type === 'insert') return { data: { id: 'log1' }, error: null }
        if (type === 'update') {
          h.logUpdates.push(payload as Record<string, unknown>)
          return { data: null, error: null }
        }
        return { data: { steps_executed: [], status: 'success' }, error: null }
      }
      return { data: null, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((type = 'insert'), (payload = p), b),
      update: (p: unknown) => ((type = 'update'), (payload = p), b),
      upsert: () => b,
      delete: () => b,
      eq: () => b,
      gte: () => b,
      gt: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve()),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(f, r),
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (t: string) => builder(t), rpc: () => Promise.resolve({ error: null }) }) }
})

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(),
  engineSendTemplate: vi.fn(),
}))

import { runAutomationsForTrigger } from './engine'

const SECRET_HEADER = 'Bearer TENANT-WEBHOOK-SECRET'
const PAYLOAD = '{"lead":"Maria","phone":"5511999990000"}'

function webhookStep(url: string, extra: Record<string, unknown> = {}) {
  return {
    id: 's1',
    automation_id: 'a1',
    parent_step_id: null,
    branch: null,
    position: 0,
    step_type: 'send_webhook',
    step_config: { url, headers: { authorization: SECRET_HEADER }, body_template: PAYLOAD, ...extra },
  }
}

type LogUpdate = {
  status?: string
  error_message?: string
  steps_executed: Array<{ detail: string; status: string }>
}

async function run(url: string, extra?: Record<string, unknown>, context: Record<string, unknown> = {}) {
  h.steps = [webhookStep(url, extra)]
  await runAutomationsForTrigger({
    accountId: 'acct-1',
    triggerType: 'new_message_received',
    contactId: 'c1',
    context,
  })
  const last = h.logUpdates.at(-1) as LogUpdate
  return { status: last.status, error: last.error_message, detail: last.steps_executed[0]?.detail }
}

let network: ReturnType<typeof createFakeHttpsNetwork>
const globalFetch = vi.fn()

function install(dnsTable: Parameters<typeof createFakeHttpsNetwork>[0], respond?: (host: string) => FakeResponse) {
  network = createFakeHttpsNetwork(dnsTable, respond)
  h.net = network
}

beforeEach(() => {
  h.logUpdates = []
  h.steps = []
  globalFetch.mockReset()
  vi.stubGlobal('fetch', globalFetch) // the engine must never reach for the global fetch
  install({ 'hooks.example.com': ['93.184.216.34'] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  h.net = null
})

describe('send_webhook: an allowed destination keeps its contract', () => {
  it('POSTs the interpolated body with content-type and the tenant headers, and reports the status', async () => {
    const r = await run('https://hooks.example.com/in?x=1')
    expect(r).toMatchObject({ status: 'success', detail: 'webhook 200' })
    expect(network.sent).toHaveLength(1)
    const req = network.sent[0]
    expect(req).toMatchObject({ host: 'hooks.example.com', address: '93.184.216.34', method: 'POST', path: '/in?x=1' })
    expect(req.body).toBe(PAYLOAD)
    expect(req.headers).toMatchObject({ 'content-type': 'application/json', authorization: SECRET_HEADER })
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('without body_template it sends the JSON of the trigger context, as before', async () => {
    await run('https://hooks.example.com/in', { body_template: undefined }, { message_text: 'oi' })
    expect(JSON.parse(network.sent[0].body)).toMatchObject({ message_text: 'oi' })
  })

  it('a custom content-type from the tenant still wins over the default', async () => {
    await run('https://hooks.example.com/in', { headers: { 'content-type': 'text/plain' } })
    expect(network.sent[0].headers['content-type']).toBe('text/plain')
  })

  it('a non-2xx answer keeps the existing "webhook returned <status>" failure', async () => {
    install({ 'hooks.example.com': ['93.184.216.34'] }, () => ({ status: 500, body: 'boom' }))
    const r = await run('https://hooks.example.com/in')
    expect(r).toMatchObject({ status: 'failed', error: 'webhook returned 500' })
    expect(network.sent).toHaveLength(1)
  })

  it('a missing url keeps the existing error and opens no connection', async () => {
    const r = await run('')
    expect(r.error).toBe('send_webhook needs url')
    expect(network.attempts).toHaveLength(0)
  })
})

describe('send_webhook: refused destinations, nothing leaves', () => {
  const refusedByUrlPolicy: Array<[string, string]> = [
    ['plain http', 'http://hooks.example.com/in'],
    ['non-443 port', 'https://hooks.example.com:8443/in'],
    ['loopback literal', 'https://127.0.0.1/in'],
    ['link-local metadata literal', 'https://169.254.169.254/latest/meta-data/'],
    ['private literal', 'https://10.0.0.5/in'],
    ['decimal-encoded loopback', 'https://2130706433/in'],
    ['IPv6 loopback', 'https://[::1]/in'],
    ['IPv4-mapped IPv6 private', 'https://[::ffff:10.0.0.5]/in'],
    ['localhost', 'https://localhost/in'],
    ['single-label internal host', 'https://supabase-kong/in'],
    ['userinfo', 'https://user:pw@hooks.example.com/in'],
    ['file scheme', 'file:///etc/passwd'],
    ['not a URL', 'not a url'],
  ]
  it.each(refusedByUrlPolicy)('%s', async (_label, url) => {
    const r = await run(url)
    expect(r).toMatchObject({ status: 'failed', error: 'webhook destination not allowed' })
    expect(network.attempts).toHaveLength(0) // no connection was even attempted
    expect(network.sent).toHaveLength(0)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['private IPv4', ['10.0.0.5']],
    ['loopback', ['127.0.0.1']],
    ['link-local (cloud metadata)', ['169.254.169.254']],
    ['carrier-grade NAT', ['100.64.0.1']],
    ['IPv6 loopback', ['::1']],
    ['IPv6 unique-local', ['fd00::1']],
    ['IPv4-mapped private', ['::ffff:192.168.1.10']],
    ['one public and one private record', ['93.184.216.34', '10.0.0.5']],
  ])('a public-looking name resolving to %s is refused at the socket: no byte sent', async (_label, addresses) => {
    install({ 'evil.example.com': addresses })
    const r = await run('https://evil.example.com/in')
    expect(r).toMatchObject({ status: 'failed', error: 'webhook destination not allowed' })
    expect(network.attempts).toHaveLength(1) // the transport was asked to connect...
    expect(network.sent).toHaveLength(0) // ...but the lookup refused, so payload and headers never left
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it('the refusal does not say why (no address or policy reason in the tenant-visible log)', async () => {
    install({ 'evil.example.com': ['10.0.0.5'] })
    const r = await run('https://evil.example.com/in')
    expect(JSON.stringify(r)).not.toMatch(/10\.0\.0\.5|private|loopback|link-local|address/i)
  })

  it('DNS rebinding: public on the first connection, private on the next, is validated again', async () => {
    let answers = 0
    install({ 'rebind.example.com': () => (answers++ === 0 ? ['93.184.216.34'] : ['169.254.169.254']) })
    const first = await run('https://rebind.example.com/in')
    const second = await run('https://rebind.example.com/in')
    expect(first.status).toBe('success')
    expect(second).toMatchObject({ status: 'failed', error: 'webhook destination not allowed' })
    expect(network.sent).toHaveLength(1) // only the request that resolved public ever left
  })

  it('a redirect is refused: the Location is never resolved or contacted, the headers are not replayed', async () => {
    install({ 'hooks.example.com': ['93.184.216.34'], 'internal.example.com': ['10.0.0.5'] }, (host) =>
      host === 'hooks.example.com'
        ? { status: 302, headers: { location: 'https://internal.example.com/admin' } }
        : { status: 200, body: 'secret' },
    )
    const r = await run('https://hooks.example.com/in')
    expect(r).toMatchObject({ status: 'failed', error: 'webhook request failed: redirect refused' })
    expect(network.attempts).toEqual(['hooks.example.com']) // one request, to the authorized host
    expect(network.sent.map((s) => s.host)).toEqual(['hooks.example.com'])
    expect(network.resolved).not.toContain('internal.example.com')
  })

  it.each([301, 302, 303, 307, 308])('a %i redirect is refused too', async (status) => {
    install({ 'hooks.example.com': ['93.184.216.34'] }, () => ({ status, headers: { location: 'https://127.0.0.1/' } }))
    const r = await run('https://hooks.example.com/in')
    expect(r.error).toBe('webhook request failed: redirect refused')
    expect(network.sent).toHaveLength(1)
  })

  it('tenant-authored step_config cannot supply a lookup, agent or redirect policy', async () => {
    install({ 'evil.example.com': ['10.0.0.5'] })
    const r = await run('https://evil.example.com/in', {
      lookup: 'noop',
      agent: 'noop',
      redirect: 'follow',
      rejectUnauthorized: false,
    })
    expect(r.error).toBe('webhook destination not allowed')
    expect(network.sent).toHaveLength(0)
  })
})

describe('send_webhook: failures on an allowed destination', () => {
  it('a name that does not resolve fails without sending anything', async () => {
    const r = await run('https://nowhere.example.com/in')
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/^webhook request failed/)
    expect(network.sent).toHaveLength(0)
  })

  it('an oversized response is a failure, not unbounded memory', async () => {
    install({ 'hooks.example.com': ['93.184.216.34'] }, () => ({
      status: 200,
      headers: { 'content-length': String(50 * 1024 * 1024) },
    }))
    const r = await run('https://hooks.example.com/in')
    expect(r.error).toBe('webhook request failed: response too large')
  })
})
