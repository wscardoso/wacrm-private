import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type dns from 'node:dns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DestinationNotAllowedError,
  SafeFetchError,
  checkDestinationUrl,
  createSafeFetchClient,
  createValidatingLookup,
  safeFetch,
  type ResolveFn,
  type Transport,
} from './safe-fetch'

// =============================================================
// safeFetch: the enforcement point for outbound requests.
//
// Layers, from cheapest to most realistic:
//   1. URL policy (pure).
//   2. The validating lookup (pure, stub resolver).
//   3. The whole client over REAL loopback sockets (plain http through a test
//      transport, because a TLS server would need a certificate). The socket
//      layer, the lookup and the request logic are the production code; only
//      the transport (http instead of https), the URL check (so a loopback
//      port is reachable) and the notion of "public" (127.0.0.1) are stand-ins.
//   4. The production client (https transport, production policy) for every
//      path that must refuse WITHOUT touching the network.
//
// Not exercised locally: a TLS handshake against a real server.
// =============================================================

const addr = (address: string, family: 4 | 6 = 4): dns.LookupAddress => ({ address, family })

// -------------------------------------------------------------
// 1. URL policy
// -------------------------------------------------------------
describe('checkDestinationUrl: accepted', () => {
  it.each([
    'https://api.example.com',
    'https://API.Example.COM:443/x?y=1',
    'https://example.com./',
    'https://bücher.example/',
    'https://sub.domain.example.co.uk/path',
  ])('%s', (url) => {
    expect(checkDestinationUrl(url)).toBeInstanceOf(URL)
  })

  it('accepts a URL object', () => {
    expect(checkDestinationUrl(new URL('https://api.example.com/x')).hostname).toBe('api.example.com')
  })

  it('the parser, not a regex, decides the host: backslash and fragment tricks name example.com', () => {
    expect(checkDestinationUrl('https://example.com\\@127.0.0.1').hostname).toBe('example.com')
    expect(checkDestinationUrl('https://example.com#@127.0.0.1').hostname).toBe('example.com')
  })
})

describe('checkDestinationUrl: refused', () => {
  const refused: Array<[string, string, string]> = [
    // [reason, label, url]
    ['scheme', 'plain http', 'http://example.com'],
    ['scheme', 'ftp', 'ftp://example.com'],
    ['scheme', 'file', 'file:///etc/passwd'],
    ['scheme', 'javascript', 'javascript:alert(1)'],
    ['scheme', 'wss', 'wss://example.com'],
    ['invalid_url', 'empty', ''],
    ['invalid_url', 'not a URL', 'not a url'],
    ['invalid_url', 'scheme-relative', '//example.com'],
    ['invalid_url', 'no host', 'https://'],
    ['invalid_url', 'space in host', 'https://exa mple.com'],
    ['credentials', 'user and password', 'https://user:pw@example.com'],
    ['credentials', 'user only', 'https://user@example.com'],
    ['credentials', 'userinfo that spells a host', 'https://good.example@evil.example'],
    ['port', '8443', 'https://example.com:8443'],
    ['port', '80', 'https://example.com:80'],
    ['port', '444', 'https://example.com:444'],
    ['port', '0', 'https://example.com:0'],
    ['port', '65535', 'https://example.com:65535'],
    ['ip_literal', 'IPv4 loopback', 'https://127.0.0.1'],
    ['ip_literal', 'IPv4 public literal', 'https://8.8.8.8'],
    ['ip_literal', 'IPv4 with 443', 'https://1.1.1.1:443'],
    ['ip_literal', 'IPv6 loopback', 'https://[::1]'],
    ['ip_literal', 'IPv6 public literal', 'https://[2606:4700:4700::1111]'],
    ['ip_literal', 'IPv4-mapped IPv6', 'https://[::ffff:7f00:1]'],
    ['ip_literal', 'IPv4-mapped, dotted', 'https://[::ffff:127.0.0.1]'],
    ['ip_literal', 'decimal', 'https://2130706433'],
    ['ip_literal', 'hexadecimal', 'https://0x7f000001'],
    ['ip_literal', 'octal', 'https://0177.0.0.1'],
    ['ip_literal', 'short form', 'https://127.1'],
    ['ip_literal', 'mixed radix', 'https://0x7f.1'],
    ['ip_literal', 'trailing dot', 'https://127.0.0.1.'],
    ['ip_literal', 'metadata address', 'https://169.254.169.254'],
    ['ip_literal', 'backslash makes the IP the host', 'https://127.0.0.1\\@example.com'],
    ['host', 'localhost', 'https://localhost'],
    ['host', 'localhost with trailing dot', 'https://localhost.'],
    ['host', '*.localhost', 'https://foo.localhost'],
    ['host', 'single label', 'https://intranet'],
    ['host', 'docker-style service name', 'https://n8n:443'],
  ]

  it.each(refused)('%s: %s', (reason, _label, url) => {
    let thrown: unknown
    try {
      checkDestinationUrl(url)
    } catch (error) {
      thrown = error
    }
    expect(thrown, url).toBeInstanceOf(DestinationNotAllowedError)
    expect((thrown as DestinationNotAllowedError).reason, url).toBe(reason)
  })
})

// -------------------------------------------------------------
// 2. The validating lookup
// -------------------------------------------------------------
describe('createValidatingLookup', () => {
  const allowPublic = (a: string) => !a.startsWith('10.') && !a.startsWith('127.') && a !== '::1'

  function run(
    answers: dns.LookupAddress[] | Error,
    options: dns.LookupOptions,
    isAllowed = allowPublic,
  ) {
    const resolve = vi.fn<ResolveFn>((_host, _opts, cb) => {
      if (answers instanceof Error) cb(answers as NodeJS.ErrnoException, [])
      else cb(null, answers)
    })
    const lookup = createValidatingLookup(resolve, isAllowed)
    return new Promise<{ error: unknown; address?: unknown; family?: number; resolve: typeof resolve }>((done) => {
      lookup('api.example.com', options, (error, address, family) => done({ error, address, family, resolve }))
    })
  }

  it('hands back every address when all are allowed (all: true)', async () => {
    const r = await run([addr('93.184.216.34'), addr('2606:4700::1111', 6)], { all: true })
    expect(r.error).toBeNull()
    expect(r.address).toEqual([addr('93.184.216.34'), addr('2606:4700::1111', 6)])
  })

  it('hands back the first address and family when all is not requested', async () => {
    const r = await run([addr('93.184.216.34'), addr('2606:4700::1111', 6)], {})
    expect(r.error).toBeNull()
    expect(r.address).toBe('93.184.216.34')
    expect(r.family).toBe(4)
  })

  it('resolves the name it was asked for, with all and verbatim', async () => {
    const r = await run([addr('93.184.216.34')], { all: true })
    expect(r.resolve).toHaveBeenCalledTimes(1)
    expect(r.resolve.mock.calls[0][0]).toBe('api.example.com')
    expect(r.resolve.mock.calls[0][1]).toEqual({ all: true, verbatim: true })
  })

  it.each([
    ['private address first', [addr('10.0.0.5'), addr('93.184.216.34')]],
    ['private address last', [addr('93.184.216.34'), addr('10.0.0.5')]],
    ['only private', [addr('127.0.0.1')]],
    ['private IPv6 among several', [addr('93.184.216.34'), addr('::1', 6)]],
  ])('refuses the whole set when one address is not allowed: %s', async (_label, answers) => {
    const r = await run(answers, { all: true })
    expect(r.error).toBeInstanceOf(DestinationNotAllowedError)
    expect((r.error as DestinationNotAllowedError).reason).toBe('address')
    expect(r.address === '' || r.address === undefined).toBe(true)
  })

  it('checks the addresses a family filter would drop (a private IPv6 record while IPv4 was requested)', async () => {
    const r = await run([addr('93.184.216.34'), addr('::1', 6)], { all: true, family: 4 })
    expect(r.error).toBeInstanceOf(DestinationNotAllowedError)
  })

  it('applies the family filter after validation', async () => {
    const r = await run([addr('93.184.216.34'), addr('2606:4700::1111', 6)], { all: true, family: 6 })
    expect(r.address).toEqual([addr('2606:4700::1111', 6)])
  })

  it('an empty answer is refused', async () => {
    const r = await run([], { all: true })
    expect((r.error as DestinationNotAllowedError).reason).toBe('dns_no_address')
  })

  it('no record in the requested family is refused', async () => {
    const r = await run([addr('93.184.216.34')], { all: true, family: 6 })
    expect((r.error as DestinationNotAllowedError).reason).toBe('dns_no_address')
  })

  it('a resolver failure is passed through untouched (it is not a policy decision)', async () => {
    const failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    const r = await run(failure, { all: true })
    expect(r.error).toBe(failure)
    expect(r.error).not.toBeInstanceOf(DestinationNotAllowedError)
  })

  it('asks the policy about every address it was given', async () => {
    const seen: string[] = []
    await run([addr('93.184.216.34'), addr('1.1.1.1'), addr('8.8.8.8')], { all: true }, (a) => {
      seen.push(a)
      return true
    })
    expect(seen).toEqual(['93.184.216.34', '1.1.1.1', '8.8.8.8'])
  })
})

// -------------------------------------------------------------
// 3. The client over real loopback sockets
// -------------------------------------------------------------
describe('safeFetch client over loopback sockets', () => {
  interface Hit {
    method?: string
    url?: string
    headers: http.IncomingHttpHeaders
    body: string
  }

  let server: http.Server
  let port: number
  let hits: Hit[]
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void
  let extra: http.Server[]

  beforeEach(async () => {
    hits = []
    extra = []
    respond = (_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    }
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
        respond(req, res)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterEach(async () => {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
    for (const s of extra) {
      s.closeAllConnections?.()
      await new Promise((r) => s.close(r))
    }
  })

  const STAND_IN_PUBLIC = '127.0.0.1' // in these tests, "public" means "the address the test server listens on"

  function plainHttpTransport(keepAlive: boolean): Transport {
    return {
      request: (options, onResponse) => http.request(options, onResponse),
      createAgent: () => new http.Agent({ keepAlive }),
      connectEvent: 'connect',
    }
  }

  function makeClient(
    answer: (host: string, call: number) => dns.LookupAddress[] | Error | 'hang',
    options: { keepAlive?: boolean; productionPolicy?: boolean } = {},
  ) {
    const calls: string[] = []
    const resolve: ResolveFn = (host, _opts, cb) => {
      calls.push(host)
      const a = answer(host, calls.length)
      if (a === 'hang') return
      if (a instanceof Error) cb(a as NodeJS.ErrnoException, [])
      else cb(null, a)
    }
    const client = createSafeFetchClient({
      resolve,
      transport: plainHttpTransport(options.keepAlive ?? false),
      // Test-only: let a loopback URL (http, ephemeral port) through the URL check. The URL policy itself is tested in section 1.
      checkUrl: (input) => new URL(input),
      ...(options.productionPolicy ? {} : { isAddressAllowed: (a: string) => a === STAND_IN_PUBLIC }),
    })
    return { calls, ...client }
  }

  const url = (host = 'good.test', path = '/instance/status') => `http://${host}:${port}${path}`

  describe('the validated address is the address that is used', () => {
    it('reaches the server only through the address the lookup returned (the name does not resolve anywhere else)', async () => {
      const { safeFetch, calls } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const res = await safeFetch(url())
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(hits).toHaveLength(1)
      expect(hits[0].headers.host).toBe(`good.test:${port}`) // the original name is kept in Host
      expect(calls).toEqual(['good.test']) // one resolution, by the validating lookup, nothing else
    })

    it('a name answered with a disallowed address is refused before any socket exists', async () => {
      const { safeFetch, calls } = makeClient(() => [addr('127.0.0.2')])
      const error = await safeFetch(url()).catch((e) => e)
      expect(error).toBeInstanceOf(DestinationNotAllowedError)
      expect(error.reason).toBe('address')
      expect(hits).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })

    it('with several records, one disallowed refuses the whole request (either order)', async () => {
      for (const records of [
        [addr(STAND_IN_PUBLIC), addr('127.0.0.2')],
        [addr('127.0.0.2'), addr(STAND_IN_PUBLIC)],
      ]) {
        const { safeFetch } = makeClient(() => records)
        await expect(safeFetch(url())).rejects.toBeInstanceOf(DestinationNotAllowedError)
      }
      expect(hits).toHaveLength(0)
    })
  })

  describe('every new connection is validated again (DNS rebinding)', () => {
    it('answer changes between two connections: the second is refused and never reaches the server', async () => {
      const { safeFetch, calls } = makeClient((_host, call) =>
        call === 1 ? [addr(STAND_IN_PUBLIC)] : [addr('127.0.0.2')],
      )
      const first = await safeFetch(url())
      expect(first.status).toBe(200)
      expect(hits).toHaveLength(1)

      const second = await safeFetch(url()).catch((e) => e)
      expect(second).toBeInstanceOf(DestinationNotAllowedError)
      expect(calls).toEqual(['good.test', 'good.test']) // validated twice, once per connection
      expect(hits).toHaveLength(1) // the rebinding answer never produced a request
    })

    it('flipping back and forth keeps being validated each time', async () => {
      const answers = [STAND_IN_PUBLIC, '127.0.0.2', STAND_IN_PUBLIC, '127.0.0.2']
      const { safeFetch, calls } = makeClient((_h, call) => [addr(answers[call - 1])])
      const outcomes: string[] = []
      for (let i = 0; i < answers.length; i++) {
        outcomes.push(await safeFetch(url()).then(() => 'ok', () => 'refused'))
      }
      expect(outcomes).toEqual(['ok', 'refused', 'ok', 'refused'])
      expect(calls).toHaveLength(4)
      expect(hits).toHaveLength(2)
    })

    it('with keep-alive, a pooled connection stays on the address it was validated against and is not re-resolved', async () => {
      const { safeFetch, calls } = makeClient(() => [addr(STAND_IN_PUBLIC)], { keepAlive: true })
      await safeFetch(url())
      await safeFetch(url())
      expect(hits).toHaveLength(2)
      expect(calls).toHaveLength(1) // same socket
    })

    it('with keep-alive, once the pooled connection is gone the next connection is validated again', async () => {
      let allowed = true
      const { safeFetch, calls } = makeClient(() => [addr(allowed ? STAND_IN_PUBLIC : '127.0.0.2')], { keepAlive: true })
      await safeFetch(url())
      server.closeAllConnections() // drop the pooled socket on the server side
      await new Promise((r) => setTimeout(r, 50)) // let the agent notice
      allowed = false // the name now points somewhere else
      const error = await safeFetch(url()).catch((e) => e)
      expect(error).toBeInstanceOf(DestinationNotAllowedError)
      expect(calls).toHaveLength(2)
      expect(hits).toHaveLength(1)
    })
  })

  describe('production address policy, same transport', () => {
    it.each([
      ['loopback', '127.0.0.1'],
      ['private', '10.0.0.5'],
      ['link-local metadata', '169.254.169.254'],
      ['carrier-grade NAT', '100.64.0.1'],
      ['IPv4-mapped IPv6 loopback', '::ffff:127.0.0.1'],
      ['IPv6 loopback', '::1'],
      ['unique local IPv6', 'fd12:3456::1'],
      ['NAT64 wrapping loopback', '64:ff9b::7f00:1'],
    ])('a name that resolves to %s (%s) is refused, though a server is listening on 127.0.0.1', async (_label, address) => {
      const family = address.includes(':') ? 6 : 4
      const { safeFetch } = makeClient(() => [addr(address, family)], { productionPolicy: true })
      const error = await safeFetch(url()).catch((e) => e)
      expect(error).toBeInstanceOf(DestinationNotAllowedError)
      expect(hits).toHaveLength(0)
    })
  })

  describe('resolution failures', () => {
    it('a DNS failure is a network error that keeps the system code (delivery classification relies on it)', async () => {
      const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND good.test'), { code: 'ENOTFOUND' })
      const { safeFetch } = makeClient(() => notFound)
      const error = await safeFetch(url()).catch((e) => e)
      expect(error).toBeInstanceOf(SafeFetchError)
      expect(error.code).toBe('network')
      expect(error.cause?.code).toBe('ENOTFOUND')
      expect(error).not.toBeInstanceOf(DestinationNotAllowedError)
    })

    it('an empty answer is refused', async () => {
      const { safeFetch } = makeClient(() => [])
      const error = await safeFetch(url()).catch((e) => e)
      expect(error).toBeInstanceOf(DestinationNotAllowedError)
      expect(error.reason).toBe('dns_no_address')
    })
  })

  describe('redirects are refused, never followed', () => {
    it.each([301, 302, 303, 307, 308])('%i: refused, and the Location target receives nothing', async (status) => {
      const target = http.createServer((req, res) => {
        targetHits.push({ headers: req.headers })
        res.end('stolen')
      })
      const targetHits: Array<{ headers: http.IncomingHttpHeaders }> = []
      await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
      extra.push(target)
      const targetPort = (target.address() as AddressInfo).port
      respond = (_req, res) => {
        res.statusCode = status
        res.setHeader('Location', `http://127.0.0.1:${targetPort}/stolen`)
        res.end()
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url(), {
        method: 'POST',
        headers: { apikey: 'SECRET', token: 'SECRET', 'content-type': 'application/json' },
        body: '{"x":1}',
      }).catch((e) => e)
      expect(error).toBeInstanceOf(SafeFetchError)
      expect(error.code).toBe('redirect')
      expect(error.status).toBe(status)
      expect(targetHits).toHaveLength(0)
      expect(hits).toHaveLength(1)
    })

    it.each([
      ['a private address', 'https://10.0.0.5/x'],
      ['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
      ['an IPv6 loopback literal', 'https://[::1]/x'],
      ['a different scheme', 'ftp://example.com/x'],
      ['a public host', 'https://example.org/x'],
    ])('a redirect to %s is refused like any other', async (_label, location) => {
      respond = (_req, res) => {
        res.statusCode = 302
        res.setHeader('Location', location)
        res.end()
      }
      const { safeFetch, calls } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url()).catch((e) => e)
      expect(error.code).toBe('redirect')
      expect(calls).toHaveLength(1) // the Location was never resolved
    })

    it('a 3xx that is not a redirect (no Location) is handed back as a response', async () => {
      respond = (_req, res) => {
        res.statusCode = 304
        res.end()
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const res = await safeFetch(url())
      expect(res.status).toBe(304)
      expect(res.body).toBeNull()
    })
  })

  describe('limits', () => {
    it('refuses a declared body larger than the limit as soon as the headers arrive, without waiting for it', async () => {
      respond = (_req, res) => {
        res.setHeader('content-length', '5000')
        res.write('x'.repeat(10)) // far below the limit, and the rest never comes
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const started = Date.now()
      const error = await safeFetch(url(), { maxResponseBytes: 1000, timeoutMs: 5000 }).catch((e) => e)
      expect(error).toBeInstanceOf(SafeFetchError)
      expect(error.code).toBe('response_too_large')
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it('refuses an undeclared (chunked) body once it exceeds the limit', async () => {
      respond = (_req, res) => {
        res.write('x'.repeat(600))
        setTimeout(() => res.end('y'.repeat(600)), 10)
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url(), { maxResponseBytes: 1000 }).catch((e) => e)
      expect(error.code).toBe('response_too_large')
    })

    it('a body of exactly the limit is accepted', async () => {
      respond = (_req, res) => res.end('x'.repeat(1000))
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const res = await safeFetch(url(), { maxResponseBytes: 1000 })
      expect((await res.text()).length).toBe(1000)
    })

    it('times out a server that never answers (total timeout)', async () => {
      respond = () => {
        /* never respond */
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const started = Date.now()
      const error = await safeFetch(url(), { timeoutMs: 150 }).catch((e) => e)
      expect(error.code).toBe('timeout')
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it('times out a server that sends headers and then stalls on the body', async () => {
      respond = (_req, res) => {
        res.write('partial')
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url(), { timeoutMs: 150 }).catch((e) => e)
      expect(error.code).toBe('timeout')
    })

    it('times out while the connection is still being established (connect timeout)', async () => {
      const { safeFetch } = makeClient(() => 'hang') // the resolver never answers
      const started = Date.now()
      const error = await safeFetch(url(), { connectTimeoutMs: 100, timeoutMs: 10_000 }).catch((e) => e)
      expect(error.code).toBe('timeout')
      expect(Date.now() - started).toBeLessThan(2000)
    })

    it('the connect timeout stops applying once the connection is up (a slow answer is not a connect timeout)', async () => {
      respond = (_req, res) => {
        setTimeout(() => res.end('{"slow":true}'), 300)
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const res = await safeFetch(url(), { connectTimeoutMs: 100, timeoutMs: 5000 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ slow: true })
    })

    it('a connection dropped mid-body is a network error', async () => {
      respond = (req, res) => {
        res.setHeader('content-length', '100')
        res.write('abc')
        setTimeout(() => req.socket.destroy(), 20)
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url()).catch((e) => e)
      expect(error).toBeInstanceOf(SafeFetchError)
      expect(error.code).toBe('network')
    })

    it('an AbortSignal cancels the request', async () => {
      respond = () => {
        /* never respond */
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)
      const error = await safeFetch(url(), { signal: controller.signal, timeoutMs: 10_000 }).catch((e) => e)
      expect(error.code).toBe('aborted')
    })

    it('an already-aborted signal fails before any resolution', async () => {
      const { safeFetch, calls } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url(), { signal: AbortSignal.abort() }).catch((e) => e)
      expect(error.code).toBe('aborted')
      expect(calls).toHaveLength(0)
    })
  })

  describe('the request that goes out', () => {
    it('sends method, path, query, headers and body, with a correct content-length', async () => {
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const body = JSON.stringify({ text: 'olá ✓' })
      await safeFetch(url('good.test', '/message/sendText/inst?x=1'), {
        method: 'POST',
        headers: { apikey: 'K', 'Content-Type': 'application/json' },
        body,
      })
      expect(hits[0]).toMatchObject({ method: 'POST', url: '/message/sendText/inst?x=1', body })
      expect(hits[0].headers.apikey).toBe('K')
      expect(hits[0].headers['content-type']).toBe('application/json')
      expect(hits[0].headers['content-length']).toBe(String(Buffer.byteLength(body)))
    })

    it('a caller cannot override Host, Content-Length, Connection or Transfer-Encoding', async () => {
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      await safeFetch(url(), {
        method: 'POST',
        body: 'abc',
        headers: { Host: 'evil.example', 'Content-Length': '99999', Connection: 'upgrade', 'Transfer-Encoding': 'chunked' },
      })
      expect(hits[0].headers.host).toBe(`good.test:${port}`)
      expect(hits[0].headers['content-length']).toBe('3')
      expect(hits[0].headers['transfer-encoding']).toBeUndefined()
      expect(hits[0].body).toBe('abc')
    })

    it('a header value with a line break is refused as a failed request, not a crash', async () => {
      const { safeFetch, calls } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url(), { headers: { 'x-test': 'a\r\nInjected: 1' } }).catch((e) => e)
      expect(error).toBeInstanceOf(SafeFetchError)
      expect(error.code).toBe('network')
      expect(hits).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })

    it('a caller cannot choose the lookup or the agent', async () => {
      const permissiveLookup = vi.fn((_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) => cb(null, '127.0.0.1', 4))
      const { safeFetch } = makeClient(() => [addr('127.0.0.2')])
      const error = await safeFetch(url(), { lookup: permissiveLookup, agent: false } as never).catch((e) => e)
      expect(error).toBeInstanceOf(DestinationNotAllowedError)
      expect(permissiveLookup).not.toHaveBeenCalled()
      expect(hits).toHaveLength(0)
    })
  })

  describe('the response that comes back', () => {
    it('maps status, status text, headers (including repeated ones) and body', async () => {
      respond = (_req, res) => {
        res.statusCode = 201
        res.statusMessage = 'Made'
        res.setHeader('set-cookie', ['a=1', 'b=2'])
        res.setHeader('x-extra', 'v')
        res.end('hello')
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const res = await safeFetch(url())
      expect(res.status).toBe(201)
      expect(res.statusText).toBe('Made')
      expect(res.ok).toBe(true)
      expect(res.headers.get('x-extra')).toBe('v')
      expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
      expect(await res.text()).toBe('hello')
    })

    it('a 204 has no body', async () => {
      respond = (_req, res) => {
        res.statusCode = 204
        res.end()
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const res = await safeFetch(url())
      expect(res.status).toBe(204)
      expect(res.body).toBeNull()
    })

    it('an error status is returned as a response, not thrown', async () => {
      respond = (_req, res) => {
        res.statusCode = 404
        res.end('nope')
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const res = await safeFetch(url())
      expect(res.ok).toBe(false)
      expect(res.status).toBe(404)
    })
  })

  describe('errors tell the caller nothing about why', () => {
    it('every policy refusal carries the same generic message and no host or address', async () => {
      const messages = new Set<string>()
      const cases: Array<() => Promise<unknown>> = [
        () => makeClient(() => [addr('127.0.0.2')]).safeFetch(url('secret-internal-name.test')),
        () => makeClient(() => []).safeFetch(url('secret-internal-name.test')),
        () => makeClient(() => [addr('127.0.0.2')]).assertDestination(url('secret-internal-name.test')),
      ]
      for (const run of cases) {
        const error = (await run().catch((e) => e)) as DestinationNotAllowedError
        expect(error).toBeInstanceOf(DestinationNotAllowedError)
        messages.add(error.message)
        expect(JSON.stringify([error.message, error.stack?.split('\n')[0]])).not.toMatch(/secret-internal-name|127\.0\.0/)
      }
      expect([...messages]).toEqual(['destination not allowed'])
    })

    it('transport failures use fixed messages too', async () => {
      respond = () => {
        /* never */
      }
      const { safeFetch } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      const error = await safeFetch(url('secret-internal-name.test'), { timeoutMs: 80 }).catch((e) => e)
      expect(error.message).toBe('request timed out')
      expect(error.message).not.toMatch(/secret-internal-name/)
    })
  })

  describe('assertDestination (checks without connecting)', () => {
    it('passes when every address is allowed', async () => {
      const { assertDestination, calls } = makeClient(() => [addr(STAND_IN_PUBLIC)])
      await expect(assertDestination(url())).resolves.toBeUndefined()
      expect(calls).toHaveLength(1)
      expect(hits).toHaveLength(0) // nothing was sent
    })

    it('fails when one address is not allowed', async () => {
      const { assertDestination } = makeClient(() => [addr(STAND_IN_PUBLIC), addr('127.0.0.2')])
      await expect(assertDestination(url())).rejects.toBeInstanceOf(DestinationNotAllowedError)
    })

    it('applies the URL rules before resolving anything', async () => {
      const calls: string[] = []
      const client = createSafeFetchClient({ resolve: (h, _o, cb) => { calls.push(h); cb(null, [addr('93.184.216.34')]) } })
      await expect(client.assertDestination('http://example.com')).rejects.toMatchObject({ reason: 'scheme' })
      await expect(client.assertDestination('https://127.0.0.1')).rejects.toMatchObject({ reason: 'ip_literal' })
      await expect(client.assertDestination('https://example.com:8443')).rejects.toMatchObject({ reason: 'port' })
      expect(calls).toHaveLength(0)
    })

    it('a DNS failure is a network error', async () => {
      const failure = Object.assign(new Error('x'), { code: 'ENOTFOUND' })
      const { assertDestination } = makeClient(() => failure)
      const error = await assertDestination(url()).catch((e) => e)
      expect(error).toBeInstanceOf(SafeFetchError)
      expect(error.code).toBe('network')
    })
  })
})

// -------------------------------------------------------------
// 4. The production client: everything here must refuse WITHOUT any network
// -------------------------------------------------------------
describe('production safeFetch (https transport, production policy)', () => {
  it.each([
    ['plain http', 'http://example.com/'],
    ['IP literal', 'https://8.8.8.8/'],
    ['loopback literal', 'https://127.0.0.1/'],
    ['metadata literal', 'https://169.254.169.254/latest/meta-data/'],
    ['IPv6 literal', 'https://[::1]/'],
    ['decimal IP', 'https://2130706433/'],
    ['other port', 'https://example.com:8443/'],
    ['credentials', 'https://u:p@example.com/'],
    ['localhost', 'https://localhost/'],
    ['single-label host', 'https://intranet/'],
  ])('%s is refused before any DNS or socket activity', async (_label, target) => {
    await expect(safeFetch(target)).rejects.toBeInstanceOf(DestinationNotAllowedError)
  })

  it('a name that resolves to a private address is refused on the real https transport (no socket is opened)', async () => {
    const resolve = vi.fn<ResolveFn>((_h, _o, cb) => cb(null, [addr('10.0.0.5')]))
    const client = createSafeFetchClient({ resolve }) // production transport and production policy
    const error = await client.safeFetch('https://tenant-server.example/instance/status').catch((e) => e)
    expect(error).toBeInstanceOf(DestinationNotAllowedError)
    expect(error.reason).toBe('address')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('same for IPv4-mapped IPv6 and for a mixed public/private answer', async () => {
    for (const answers of [[addr('::ffff:10.0.0.5', 6)], [addr('93.184.216.34'), addr('192.168.1.1')]]) {
      const client = createSafeFetchClient({ resolve: (_h, _o, cb) => cb(null, answers) })
      await expect(client.safeFetch('https://tenant-server.example/')).rejects.toBeInstanceOf(DestinationNotAllowedError)
    }
  })
})
