import { afterEach, describe, expect, it, vi } from 'vitest'
import { MetaProvider } from './meta'
import { classifyFailure } from '../delivery/failure-classifier'

// ADR-E4B-002 §2 / ADR-E4B-003 §3.4 — the HTTP status of a Meta rejection
// must survive from meta-api.ts (where the Response is read) to the adapter's
// classifier, ALSO when Meta answered with a JSON error body. Before the fix
// meta-api.ts threw `new Error(data.error.message)` and only the unparseable-
// body fallback ("Meta API error: <status>") carried the status, so every
// real 400/401/403/404/422 was classified 'ambiguous' and the message stayed
// 'sending' until the 72 h TTL.
//
// This file drives the REAL meta-api.ts through a stubbed fetch, so it
// exercises the actual throw site rather than a hand-built Error.

const provider = new MetaProvider({
  phoneNumberId: 'pn-1',
  accessToken: 'token',
  verifyToken: 'verify',
})

function jsonError(status: number, message = 'Meta says no', code = 100): Response {
  return new Response(JSON.stringify({ error: { message, code, type: 'OAuthException' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function sendAndCatch(): Promise<unknown> {
  try {
    await provider.sendText({ to: '5511999999999', text: 'oi' })
  } catch (err) {
    return err
  }
  throw new Error('sendText unexpectedly resolved')
}

function classify(error: unknown) {
  const outcome = provider.classifySendFailure(error)
  return { outcome, decision: classifyFailure(outcome, provider.capabilities) }
}

describe('Meta send failure with a JSON error body keeps its HTTP status to the classifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([400, 401, 403, 404, 422])(
    'HTTP %i with a JSON body -> deterministic-permanent -> permanent',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonError(status, 'Invalid parameter')))
      const err = await sendAndCatch()
      // Contract for current callers: the message is still Meta's own text.
      expect((err as Error).message).toBe('Invalid parameter')
      const { outcome, decision } = classify(err)
      expect(outcome).toBe('deterministic-permanent')
      expect(decision).toBe('permanent')
    },
  )

  it.each([500, 502])('HTTP %i with a JSON body stays ambiguous (provider may have processed it)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonError(status, 'Internal error', 2)))
    const err = await sendAndCatch()
    expect((err as Error).message).toBe('Internal error')
    expect(classify(err).outcome).toBe('ambiguous')
  })

  it.each([429, 503, 504])('HTTP %i with a JSON body stays ambiguous (throttled/unavailable: may have been processed)', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonError(status, 'Slow down', 4)))
    const err = await sendAndCatch()
    expect((err as Error).message).toBe('Slow down')
    expect(classify(err).outcome).toBe('ambiguous')
  })

  it('HTTP 400 with an unparseable body still classifies as permanent (legacy fallback message)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>bad</html>', { status: 400 })))
    const err = await sendAndCatch()
    expect((err as Error).message).toBe('Meta API error: 400')
    expect(classify(err).outcome).toBe('deterministic-permanent')
  })

  it('a JSON error message that merely mentions a status does not decide the class on its own', async () => {
    // The HTTP status is authoritative; free text from the provider is not.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonError(500, 'Meta API error: 400')))
    const err = await sendAndCatch()
    expect(classify(err).outcome).toBe('ambiguous')
  })

  it('a 200 response without a message id stays ambiguous (accepted, id unknown)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 })))
    const err = await sendAndCatch()
    expect(classify(err).outcome).toBe('ambiguous')
  })

  it('a network-level failure stays ambiguous', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const err = await sendAndCatch()
    expect(classify(err).outcome).toBe('ambiguous')
  })
})
