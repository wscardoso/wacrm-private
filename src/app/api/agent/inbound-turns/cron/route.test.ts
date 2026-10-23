import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * GET /api/agent/inbound-turns/cron.
 * Only a synthetic secret is ever set (vi.stubEnv); the real
 * AUTOMATION_CRON_SECRET is never read, and the drain is mocked.
 */

const { mockDrain } = vi.hoisted(() => ({ mockDrain: vi.fn() }))

vi.mock('@/lib/agent/turn/drain', () => ({
  drainInboundTurnJobs: mockDrain,
}))

const route = await import('./route')
const { GET } = route

const SECRET = 'test-cron-secret-not-real'
const URL_ = 'http://localhost/api/agent/inbound-turns/cron'

function req(headers: Record<string, string> = {}, url = URL_) {
  return new NextRequest(url, { headers })
}

const DRAIN_RESULT = { reclaimed: 1, processed: 2, failed: 0, skipped: 1 }

describe('GET /api/agent/inbound-turns/cron', () => {
  let spies: Record<'error' | 'warn' | 'log' | 'info' | 'debug', ReturnType<typeof vi.spyOn>>
  /** Every value a request supplied, so we can prove none of them is echoed or logged. */
  const supplied: string[] = []
  const bodies: string[] = []

  async function call(headers: Record<string, string> = {}, url?: string) {
    supplied.push(...Object.values(headers))
    const res = await GET(req(headers, url))
    bodies.push(JSON.stringify(await res.clone().json()))
    return res
  }

  beforeEach(() => {
    mockDrain.mockReset()
    mockDrain.mockResolvedValue(DRAIN_RESULT)
    vi.stubEnv('AUTOMATION_CRON_SECRET', SECRET)
    supplied.length = 0
    bodies.length = 0
    spies = {
      error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
      info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
      debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    }
  })

  afterEach(() => {
    // No response body or log line may contain the configured secret, and an
    // untrusted supplied value must not be echoed either.
    const logged = JSON.stringify(Object.values(spies).flatMap((s) => s.mock.calls))
    for (const needle of [SECRET, ...supplied.filter((v) => v.length > 3)]) {
      expect(logged).not.toContain(needle)
      for (const body of bodies) expect(body).not.toContain(needle)
    }
    for (const s of Object.values(spies)) s.mockRestore()
    vi.unstubAllEnvs()
  })

  it('exports GET only', () => {
    expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(['GET'])
  })

  describe('not configured', () => {
    it('503 when AUTOMATION_CRON_SECRET is unset, even for a request that supplies a header', async () => {
      vi.stubEnv('AUTOMATION_CRON_SECRET', undefined)

      const res = await call({ 'x-cron-secret': SECRET })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'cron not configured' })
      expect(mockDrain).not.toHaveBeenCalled()
    })

    it('503 when AUTOMATION_CRON_SECRET is empty (an empty header must not match an empty secret)', async () => {
      vi.stubEnv('AUTOMATION_CRON_SECRET', '')

      const res = await call({ 'x-cron-secret': '' })
      expect(res.status).toBe(503)
      expect(mockDrain).not.toHaveBeenCalled()
    })
  })

  describe('authentication', () => {
    const wrong: Array<[string, Record<string, string>]> = [
      ['no header', {}],
      ['empty header', { 'x-cron-secret': '' }],
      ['same length, different value', { 'x-cron-secret': SECRET.replace(/.$/, 'X') }],
      ['a prefix of the secret', { 'x-cron-secret': SECRET.slice(0, -1) }],
      ['the secret plus a suffix', { 'x-cron-secret': `${SECRET}x` }],
      ['same character count, different byte length', { 'x-cron-secret': SECRET.replace(/.$/, 'é') }],
      ['the secret as a Bearer token', { authorization: `Bearer ${SECRET}` }],
      ['the secret in the wrong header', { 'x-api-key': SECRET }],
    ]

    it.each(wrong)('401 for %s', async (_label, headers) => {
      const res = await call(headers)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
      expect(mockDrain).not.toHaveBeenCalled()
    })

    it('401 when the secret is only in the query string', async () => {
      const res = await call({}, `${URL_}?x-cron-secret=${SECRET}`)
      expect(res.status).toBe(401)
      expect(mockDrain).not.toHaveBeenCalled()
    })
  })

  describe('authorized', () => {
    it('200 with the drain result, calling the drain once with no options', async () => {
      const res = await call({ 'x-cron-secret': SECRET })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(DRAIN_RESULT)
      expect(mockDrain).toHaveBeenCalledTimes(1)
      expect(mockDrain).toHaveBeenCalledWith()
    })

    it('the header name is case-insensitive', async () => {
      const res = await call({ 'X-Cron-Secret': SECRET })
      expect(res.status).toBe(200)
    })

    it('an idle queue is still a 200', async () => {
      mockDrain.mockResolvedValue({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 })

      const res = await call({ 'x-cron-secret': SECRET })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 })
    })
  })

  describe('drain failure', () => {
    it('500 with the error message, logged once without the secret', async () => {
      mockDrain.mockRejectedValue(new Error('claim_inbound_turn_job: down'))

      const res = await call({ 'x-cron-secret': SECRET })
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'claim_inbound_turn_job: down' })
      expect(spies.error).toHaveBeenCalledTimes(1)
      expect(spies.error).toHaveBeenCalledWith('[inbound-turn-cron] drain error:', 'claim_inbound_turn_job: down')
    })
  })
})
