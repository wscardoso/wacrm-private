import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UazapiProvider } from './uazapi'

// =============================================================
// Transport guarantees of the uazapi adapter:
//   - every request carries an AbortSignal timeout (a hung uazapi server must
//     not hold the /send request, the cron batch or a flow run indefinitely);
//   - a timeout is classified AMBIGUOUS (the request may have been processed);
//   - a 2xx whose body is not JSON is still an ACCEPTED send, not a failure.
//
// Nothing here touches the network: fetch is stubbed.
// =============================================================

const uazapi = new UazapiProvider({ baseUrl: 'https://my.uazapi.dev', instanceId: 'inst', token: 'apikey-1' })

let timeoutMsRequested: number[] = []

beforeEach(() => {
  timeoutMsRequested = []
  // Deterministic stand-in for AbortSignal.timeout: records the budget and
  // aborts after a few ms with the same TimeoutError the platform raises.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    timeoutMsRequested.push(ms)
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 5)
    return ctrl.signal
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A fetch that never answers on its own — it only ends when its signal aborts. */
function hangingFetch() {
  return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      if (!init?.signal) return // would hang forever: the test fails by timeout
      init.signal.addEventListener('abort', () => reject(init.signal!.reason))
    }),
  )
}

describe('uazapi — request timeouts', () => {
  it('sendText passes a signal and a hung server ends in a TimeoutError', async () => {
    const f = hangingFetch()
    vi.stubGlobal('fetch', f)
    await expect(uazapi.sendText({ to: '5511999887766', text: 'oi' })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(f.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends get a 30 s budget (same as the Meta adapter)', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    await uazapi.sendText({ to: '5511999887766', text: 'oi' }).catch(() => {})
    await uazapi.sendMedia({ to: '5511999887766', kind: 'image', link: 'https://m/x.jpg' }).catch(() => {})
    expect(timeoutMsRequested).toEqual([30_000, 30_000])
  })

  it('control-plane calls (status / connect / QR) get a shorter budget', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    await uazapi.checkStatus()
    await uazapi.getInstanceStatus()
    await uazapi.connectAndGetQrCode()
    expect(timeoutMsRequested.length).toBeGreaterThan(0)
    expect(timeoutMsRequested.every((ms) => ms > 0 && ms <= 15_000)).toBe(true)
  })

  it('a timeout is AMBIGUOUS — the request may have been processed — never permanent', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const err = await uazapi.sendText({ to: '5511999887766', text: 'oi' }).catch((e) => e)
    expect(uazapi.classifySendFailure(err)).toBe('ambiguous')
  })
})

describe('uazapi — a 2xx with an unreadable body is still an accepted send', () => {
  it('returns an empty message id instead of throwing after the message was accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>ok</html>', { status: 200 })))
    await expect(uazapi.sendText({ to: '5511999887766', text: 'oi' })).resolves.toMatchObject({ messageId: '' })
  })

  it('an empty 200 body is the same', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(uazapi.sendText({ to: '5511999887766', text: 'oi' })).resolves.toMatchObject({ messageId: '' })
  })

  it('a non-2xx is still a failure with its status (classification unchanged)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const err = await uazapi.sendText({ to: '5511999887766', text: 'oi' }).catch((e) => e)
    expect(String(err.message)).toContain('failed (500)')
    expect(uazapi.classifySendFailure(err)).toBe('ambiguous')
  })
})
