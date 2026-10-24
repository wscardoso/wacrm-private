import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isTransientDbError, withTransientRetry, TRANSIENT_RETRY_DELAYS_MS } from '@/lib/agent/turn/transient'

const dbError = (code: string | undefined, message = 'boom') => Object.assign(new Error(message), code === undefined ? {} : { code })

describe('isTransientDbError', () => {
  it.each(['08000', '08006', '08001', '40001', '40P01', '53200', '53300', '57P01', '57P02', '57P03'])(
    'SQLSTATE %s can succeed on a second try',
    (code) => {
      expect(isTransientDbError(dbError(code))).toBe(true)
    },
  )

  it.each(['23505', '23503', '23502', '22P02', '42501', '42883', 'P0001', 'XX000', '57014', '25006', 'PGRST116'])(
    'SQLSTATE %s is deterministic and is not retried',
    (code) => {
      expect(isTransientDbError(dbError(code))).toBe(false)
    },
  )

  it('an error with no code (the call never got a database answer) is transient', () => {
    expect(isTransientDbError(dbError(undefined))).toBe(true)
    expect(isTransientDbError(dbError(''))).toBe(true)
    expect(isTransientDbError(new TypeError('fetch failed'))).toBe(true)
    expect(isTransientDbError(null)).toBe(true)
  })
})

describe('withTransientRetry', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const noWait = vi.fn(async () => undefined)

  beforeEach(() => {
    noWait.mockClear()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('retries at most twice by default, with growing waits', () => {
    expect(TRANSIENT_RETRY_DELAYS_MS).toEqual([150, 400])
  })

  it('returns the first success without waiting', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(withTransientRetry(fn, { sleep: noWait })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(noWait).not.toHaveBeenCalled()
  })

  it('recovers when a transient failure is followed by a success, waiting the configured time', async () => {
    const fn = vi.fn().mockRejectedValueOnce(dbError('40001')).mockRejectedValueOnce(dbError('08006')).mockResolvedValue('ok')

    await expect(withTransientRetry(fn, { sleep: noWait, delaysMs: [10, 20] })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(noWait.mock.calls).toEqual([[10], [20]])
  })

  it('gives up after the last retry and rethrows the LAST error unchanged', async () => {
    const last = dbError('40001', 'last')
    const fn = vi.fn().mockRejectedValueOnce(dbError('40001', 'first')).mockRejectedValueOnce(dbError('40001', 'second')).mockRejectedValue(last)

    await expect(withTransientRetry(fn, { sleep: noWait, delaysMs: [1, 1] })).rejects.toBe(last)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry a deterministic error', async () => {
    const failure = dbError('23503')
    const fn = vi.fn().mockRejectedValue(failure)

    await expect(withTransientRetry(fn, { sleep: noWait })).rejects.toBe(failure)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(noWait).not.toHaveBeenCalled()
  })

  it('an empty delay list means no retry at all', async () => {
    const fn = vi.fn().mockRejectedValue(dbError('40001'))
    await expect(withTransientRetry(fn, { sleep: noWait, delaysMs: [] })).rejects.toBeInstanceOf(Error)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('logs the SQLSTATE and the attempt, never the error message (it can carry personal data)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(dbError('40001', 'Key (phone)=(5511999887766) conflicts')).mockResolvedValue('ok')

    await withTransientRetry(fn, { sleep: noWait, delaysMs: [1], label: 'persist' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('5511999887766')
    expect(warnSpy).toHaveBeenCalledWith('[inbound] transient failure in %s (code=%s), retry %d/%d', 'persist', '40001', 1, 1)
  })

  it('logs "none" for an error without a code', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue('ok')
    await withTransientRetry(fn, { sleep: noWait, delaysMs: [1] })
    expect(warnSpy).toHaveBeenCalledWith(expect.any(String), 'db call', 'none', 1, 1)
  })

  it('uses real timers by default (a short wait actually elapses)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(dbError('40001')).mockResolvedValue('ok')
    const t0 = Date.now()
    await withTransientRetry(fn, { delaysMs: [30] })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25)
  })
})
