import { EventEmitter } from 'node:events'

/**
 * A stand-in for `node:dns` + `node:https` that follows the one rule a real
 * socket follows: bytes are written only AFTER the connection's `lookup`
 * accepted the address. Tests that mock those two modules with this helper run
 * the production safeFetch (URL policy, validating lookup, redirect and size
 * handling) and can then ask the only question that matters for a blocked
 * destination: did any request byte leave? (`sent`).
 *
 * It does not test TLS or real DNS; src/lib/http/safe-fetch.test.ts covers the
 * socket layer over real loopback connections.
 */
export interface FakeResponse {
  status: number
  headers?: Partial<Record<string, string>>
  body?: string
}

export interface SentRequest {
  host: string
  address: string
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

export function createFakeHttpsNetwork(
  dnsTable: Record<string, string[] | (() => string[])>,
  respond: (host: string, sent: SentRequest) => FakeResponse = () => ({ status: 200, body: 'ok' }),
) {
  /** Requests that reached a connected socket: these are the bytes that left. */
  const sent: SentRequest[] = []
  /** Every request the transport was asked to open, connected or not. */
  const attempts: string[] = []
  /** Names handed to the resolver. */
  const resolved: string[] = []

  function dnsLookup(
    hostname: string,
    _options: unknown,
    callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void,
  ) {
    resolved.push(hostname)
    const entry = dnsTable[hostname]
    const addresses = typeof entry === 'function' ? entry() : entry
    if (!addresses) {
      const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
      return queueMicrotask(() => callback(error, []))
    }
    queueMicrotask(() => callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function request(options: any, onResponse: (res: any) => void) {
    const req = new EventEmitter() as EventEmitter & { end: (body?: Buffer) => void; destroy: () => void }
    attempts.push(String(options.host))
    req.destroy = () => {}
    req.end = (body?: Buffer) => {
      // The socket's connect step: the lookup decides whether we ever get to write.
      options.lookup(
        options.host,
        {},
        (error: Error | null, address: string | Array<{ address: string }>) => {
          if (error) return queueMicrotask(() => req.emit('error', error))
          const chosen = typeof address === 'string' ? address : address[0].address
          const record: SentRequest = {
            host: String(options.host),
            address: chosen,
            method: options.method,
            path: options.path,
            headers: { ...options.headers },
            body: body ? body.toString('utf8') : '',
          }
          sent.push(record)
          const out = respond(record.host, record)
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number
            statusMessage: string
            headers: Record<string, string>
            resume: () => void
          }
          res.statusCode = out.status
          res.statusMessage = ''
          res.headers = Object.fromEntries(
            Object.entries(out.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
          )
          res.resume = () => {}
          queueMicrotask(() => {
            onResponse(res)
            if (out.body) res.emit('data', Buffer.from(out.body))
            res.emit('end')
          })
        },
      )
    }
    return req
  }

  return { dnsLookup, request, sent, attempts, resolved }
}
