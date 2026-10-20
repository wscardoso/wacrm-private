/**
 * safeFetch: the enforcement point for outbound requests whose destination is
 * not under our control (for example a tenant-registered server).
 *
 * It is not a wrapper around `fetch`. It performs the request itself, over
 * node:https, so that the network policy is applied to the connection that is
 * actually made:
 *
 *   - https only, port 443, no credentials in the URL;
 *   - no IP literal as host in any spelling (the URL parser has already turned
 *     decimal / octal / hexadecimal forms into a dotted address by then);
 *   - EVERY address the host resolves to must be public (ip-policy), and the
 *     check runs inside the socket's `lookup`, i.e. on each new connection and
 *     on the very addresses that connection will use. Nothing is resolved
 *     twice and nothing is cached here, so a DNS answer that changes between
 *     two connections (rebinding) is validated again each time. A pooled
 *     keep-alive socket stays on the address it was validated against;
 *   - redirects are refused, never followed. A redirect would re-send custom
 *     credential headers to whatever origin the Location names;
 *   - connect timeout, total timeout, response size limit;
 *   - the caller sees generic errors: nothing says whether a refusal was a
 *     private address, a bad port or a failed lookup.
 *
 * There is no per-tenant or per-host allow-list and no way for a caller to pass
 * its own agent or lookup.
 */
import dns from 'node:dns'
import type http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { isPublicAddress } from './ip-policy'

export type DestinationRejection =
  | 'invalid_url'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'ip_literal'
  | 'host'
  | 'dns_no_address'
  | 'address'

/** The destination is not one we are willing to connect to. Nothing was sent. */
export class DestinationNotAllowedError extends Error {
  /** Internal reason, for logs and tests only. Never show it to a tenant. */
  readonly reason: DestinationRejection
  constructor(reason: DestinationRejection) {
    super('destination not allowed')
    this.name = 'DestinationNotAllowedError'
    this.reason = reason
  }
}

export type SafeFetchFailure = 'timeout' | 'response_too_large' | 'redirect' | 'aborted' | 'network'

const FAILURE_MESSAGE: Record<SafeFetchFailure, string> = {
  timeout: 'request timed out',
  response_too_large: 'response too large',
  redirect: 'redirect refused',
  aborted: 'request aborted',
  network: 'request failed',
}

/** A request to an allowed destination failed. `cause` keeps the system error (for example `cause.code`). */
export class SafeFetchError extends Error {
  readonly code: SafeFetchFailure
  /** Only for `redirect`: the status the server answered with. */
  readonly status?: number
  constructor(code: SafeFetchFailure, options?: { status?: number; cause?: unknown }) {
    super(FAILURE_MESSAGE[code], options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SafeFetchError'
    this.code = code
    this.status = options?.status
  }
}

// ---------------------------------------------------------------------------
// URL policy (pure, synchronous)
// ---------------------------------------------------------------------------

/** Validates the parts of a URL that need no DNS. Returns the parsed URL. */
export function checkDestinationUrl(input: string | URL): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new DestinationNotAllowedError('invalid_url')
  }
  if (url.protocol !== 'https:') throw new DestinationNotAllowedError('scheme')
  if (url.username || url.password) throw new DestinationNotAllowedError('credentials')
  // The parser drops the default port, so `https://h:443` arrives here as ''.
  if (url.port !== '' && url.port !== '443') throw new DestinationNotAllowedError('port')

  const bare = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (net.isIP(bare)) throw new DestinationNotAllowedError('ip_literal')

  const host = bare.endsWith('.') ? bare.slice(0, -1) : bare
  if (!host.includes('.')) throw new DestinationNotAllowedError('host') // empty or single-label
  if (host === 'localhost' || host.endsWith('.localhost')) throw new DestinationNotAllowedError('host')
  return url
}

// ---------------------------------------------------------------------------
// Connection-time validation
// ---------------------------------------------------------------------------

export type ResolveFn = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void

/**
 * A `lookup` for net.connect that resolves the name itself and refuses the
 * connection unless every returned address is allowed. The address it hands
 * back is the one the socket connects to.
 */
export function createValidatingLookup(resolve: ResolveFn, isAllowed: (address: string) => boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, '', 0)
      const found = addresses ?? []
      // ALL results are checked, including the ones the caller's family filter would drop.
      for (const entry of found) {
        if (!isAllowed(entry.address)) return callback(new DestinationNotAllowedError('address'), '', 0)
      }
      const wanted =
        options.family === 4 || options.family === 6
          ? found.filter((entry) => entry.family === options.family)
          : found
      // Covers both "the name has no records" and "none in the requested family".
      if (wanted.length === 0) return callback(new DestinationNotAllowedError('dns_no_address'), '', 0)
      if (options.all) return callback(null, wanted)
      return callback(null, wanted[0].address, wanted[0].family)
    })
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface Transport {
  request(options: https.RequestOptions, onResponse: (res: http.IncomingMessage) => void): http.ClientRequest
  createAgent(options: https.AgentOptions): http.Agent
  /** Socket event that means "connected and ready to send". */
  connectEvent: 'secureConnect' | 'connect'
}

/** Seams for tests. Production code uses the exported `safeFetch`. */
export interface SafeFetchDeps {
  resolve: ResolveFn
  isAddressAllowed: (address: string) => boolean
  transport: Transport
  checkUrl: (input: string | URL) => URL
}

export interface SafeFetchInit {
  method?: string
  headers?: HeadersInit
  body?: string | Uint8Array | null
  signal?: AbortSignal
  /** Until the connection (including TLS) is established. Default 5 s. */
  connectTimeoutMs?: number
  /** Whole operation, including reading the body. Default 15 s. */
  timeoutMs?: number
  /** Default 1 MiB. */
  maxResponseBytes?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

/** Set by us from the URL and the body; a caller cannot override them. */
const MANAGED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'expect'])
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

const productionTransport: Transport = {
  request: (options, onResponse) => https.request(options, onResponse),
  createAgent: (options) => new https.Agent(options),
  connectEvent: 'secureConnect',
}

function defaultResolve(
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
): void {
  dns.lookup(hostname, options, callback)
}

function hostOf(url: URL): string {
  return url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname
}

export function createSafeFetchClient(overrides: Partial<SafeFetchDeps> = {}) {
  const deps: SafeFetchDeps = {
    resolve: overrides.resolve ?? defaultResolve,
    isAddressAllowed: overrides.isAddressAllowed ?? isPublicAddress,
    transport: overrides.transport ?? productionTransport,
    checkUrl: overrides.checkUrl ?? checkDestinationUrl,
  }
  const lookup = createValidatingLookup(deps.resolve, deps.isAddressAllowed)
  const agent = deps.transport.createAgent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8 })

  /** Policy check without sending anything: URL rules, then every resolved address. */
  async function assertDestination(input: string | URL): Promise<void> {
    const url = deps.checkUrl(input)
    const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      deps.resolve(hostOf(url), { all: true, verbatim: true }, (error, found) => {
        if (error) reject(new SafeFetchError('network', { cause: error }))
        else resolve(found)
      })
    })
    if (addresses.length === 0) throw new DestinationNotAllowedError('dns_no_address')
    for (const entry of addresses) {
      if (!deps.isAddressAllowed(entry.address)) throw new DestinationNotAllowedError('address')
    }
  }

  function safeFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      let url: URL
      try {
        url = deps.checkUrl(input)
      } catch (error) {
        return reject(error)
      }
      if (init.signal?.aborted) return reject(new SafeFetchError('aborted'))

      const maxBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
      const body =
        init.body === undefined || init.body === null
          ? undefined
          : typeof init.body === 'string'
            ? Buffer.from(init.body, 'utf8')
            : Buffer.from(init.body)

      const headers: Record<string, string> = {}
      try {
        for (const [name, value] of new Headers(init.headers).entries()) {
          if (!MANAGED_HEADERS.has(name.toLowerCase())) headers[name] = value
        }
      } catch (error) {
        return reject(new SafeFetchError('network', { cause: error })) // malformed header: nothing was sent
      }
      if (body) headers['content-length'] = String(body.length)

      let settled = false
      let req: http.ClientRequest | undefined
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (connectTimer) clearTimeout(connectTimer)
        clearTimeout(totalTimer)
        init.signal?.removeEventListener('abort', onAbort)
      }
      const finish = (outcome: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        outcome()
      }
      const fail = (error: Error) => {
        finish(() => reject(error))
        req?.destroy()
      }
      const onAbort = () => fail(new SafeFetchError('aborted'))

      try {
        req = deps.transport.request(
          {
            host: hostOf(url),
            // checkUrl has already limited this to 443 (or none); the URL, not a constant, is the source of truth.
            port: url.port ? Number(url.port) : 443,
            method: init.method ?? 'GET',
            path: url.pathname + url.search,
            headers,
            agent,
            // The only place the connection's address is chosen. Callers cannot supply one.
            lookup,
          },
          (res) => {
            const status = res.statusCode ?? 0
            if (status >= 300 && status < 400 && res.headers.location) {
              res.resume()
              return fail(new SafeFetchError('redirect', { status }))
            }
            const declared = Number(res.headers['content-length'])
            if (Number.isFinite(declared) && declared > maxBytes) {
              res.resume()
              return fail(new SafeFetchError('response_too_large'))
            }
            const chunks: Buffer[] = []
            let received = 0
            res.on('data', (chunk: Buffer) => {
              received += chunk.length
              if (received > maxBytes) return fail(new SafeFetchError('response_too_large'))
              chunks.push(chunk)
            })
            res.on('error', (error) => fail(new SafeFetchError('network', { cause: error })))
            res.on('end', () =>
              finish(() => {
                const responseHeaders = new Headers()
                for (const [name, value] of Object.entries(res.headers)) {
                  if (value === undefined) continue
                  if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item)
                  else responseHeaders.set(name, value)
                }
                const payload = NULL_BODY_STATUS.has(status) ? null : new Uint8Array(Buffer.concat(chunks))
                resolve(new Response(payload, { status, statusText: res.statusMessage, headers: responseHeaders }))
              }),
            )
          },
        )
      } catch (error) {
        return reject(new SafeFetchError('network', { cause: error }))
      }

      req.on('error', (error) => {
        if (error instanceof DestinationNotAllowedError || error instanceof SafeFetchError) return fail(error)
        fail(new SafeFetchError('network', { cause: error }))
      })
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          if (connectTimer) clearTimeout(connectTimer) // reused keep-alive socket: already connected
          connectTimer = undefined
        } else {
          socket.once(deps.transport.connectEvent, () => {
            if (connectTimer) clearTimeout(connectTimer)
            connectTimer = undefined
          })
        }
      })

      connectTimer = setTimeout(() => fail(new SafeFetchError('timeout')), init.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
      const totalTimer = setTimeout(() => fail(new SafeFetchError('timeout')), init.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      init.signal?.addEventListener('abort', onAbort, { once: true })

      req.end(body)
    })
  }

  return { safeFetch, assertDestination }
}

const client = createSafeFetchClient()

/** Perform an outbound request under the network policy above. */
export const safeFetch = client.safeFetch
/** Check a destination (URL rules and every resolved address) without connecting. */
export const assertOutboundDestination = client.assertDestination
