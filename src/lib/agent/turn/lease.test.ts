import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { mockRenew } = vi.hoisted(() => ({ mockRenew: vi.fn() }))

vi.mock('@/lib/agent/turn/substrate', () => ({
  renewInboundTurnLease: mockRenew,
}))

const { runWithInboundTurnLease, INBOUND_TURN_LEASE_SECONDS } = await import('@/lib/agent/turn/lease')
type Lease = Parameters<Parameters<typeof runWithInboundTurnLease>[1]>[0]

const job = {
  messageId: 'm1',
  accountId: 'a1',
  contactId: 'c1',
  conversationId: 'v1',
  claimToken: 'token-1',
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runWithInboundTurnLease', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockRenew.mockReset()
    vi.useFakeTimers()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    errorSpy.mockRestore()
  })

  it('requests a 300 s lease by default', () => {
    expect(INBOUND_TURN_LEASE_SECONDS).toBe(300)
  })

  it('does not renew when the work ends before the first tick', async () => {
    const out = await runWithInboundTurnLease(job, async () => 'done')
    expect(out).toEqual({ result: 'done', leaseHeld: true })
    expect(mockRenew).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('renews every third of the lease with the job identity and the lease length', async () => {
    mockRenew.mockResolvedValue(true)
    const work = deferred<string>()
    const run = runWithInboundTurnLease(job, () => work.promise)

    await vi.advanceTimersByTimeAsync(99_999)
    expect(mockRenew).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mockRenew).toHaveBeenCalledTimes(1)
    expect(mockRenew).toHaveBeenLastCalledWith({ messageId: 'm1', claimToken: 'token-1', lockSeconds: 300 })

    await vi.advanceTimersByTimeAsync(100_000)
    expect(mockRenew).toHaveBeenCalledTimes(2)

    work.resolve('ok')
    await expect(run).resolves.toEqual({ result: 'ok', leaseHeld: true })
  })

  it('uses the lockSeconds argument for both the interval and the renewal request', async () => {
    mockRenew.mockResolvedValue(true)
    const work = deferred<void>()
    const run = runWithInboundTurnLease(job, () => work.promise, 90)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(mockRenew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockRenew).toHaveBeenCalledWith({ messageId: 'm1', claimToken: 'token-1', lockSeconds: 90 })

    work.resolve()
    await run
  })

  it.each([0, 2])('never ticks faster than once a second (lockSeconds=%i)', async (lockSeconds) => {
    mockRenew.mockResolvedValue(true)
    const work = deferred<void>()
    const run = runWithInboundTurnLease(job, () => work.promise, lockSeconds)

    await vi.advanceTimersByTimeAsync(999)
    expect(mockRenew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockRenew).toHaveBeenCalledTimes(1)

    work.resolve()
    await run
  })

  it('a refused renewal marks the lease lost and stops renewing', async () => {
    mockRenew.mockResolvedValue(false)
    const work = deferred<string>()
    let lease!: Lease
    const run = runWithInboundTurnLease(job, (l) => {
      lease = l
      return work.promise
    })
    expect(lease.isHeld()).toBe(true)

    await vi.advanceTimersByTimeAsync(100_000)
    expect(mockRenew).toHaveBeenCalledTimes(1)
    expect(lease.isHeld()).toBe(false)

    await vi.advanceTimersByTimeAsync(300_000)
    expect(mockRenew).toHaveBeenCalledTimes(1)

    work.resolve('late')
    await expect(run).resolves.toEqual({ result: 'late', leaseHeld: false })
  })

  it('a failed renewal marks the lease lost, is logged with the message id, and stops renewing', async () => {
    const boom = new Error('network down')
    mockRenew.mockRejectedValue(boom)
    const work = deferred<string>()
    let lease!: Lease
    const run = runWithInboundTurnLease(job, (l) => {
      lease = l
      return work.promise
    })

    await vi.advanceTimersByTimeAsync(100_000)
    expect(lease.isHeld()).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith('[inbound-turn] lease renewal failed:', 'm1', boom)

    await vi.advanceTimersByTimeAsync(300_000)
    expect(mockRenew).toHaveBeenCalledTimes(1)

    work.resolve('x')
    await expect(run).resolves.toEqual({ result: 'x', leaseHeld: false })
  })

  it('does not start a renewal while the previous one is still in flight', async () => {
    const inFlight = deferred<boolean>()
    mockRenew.mockReturnValueOnce(inFlight.promise).mockResolvedValue(true)
    const work = deferred<void>()
    const run = runWithInboundTurnLease(job, () => work.promise)

    await vi.advanceTimersByTimeAsync(300_000) // three ticks, first renewal never answers
    expect(mockRenew).toHaveBeenCalledTimes(1)

    inFlight.resolve(true)
    await vi.advanceTimersByTimeAsync(100_000) // flag cleared: next tick renews again
    expect(mockRenew).toHaveBeenCalledTimes(2)

    work.resolve()
    await run
  })

  it('clears the timer when the work succeeds', async () => {
    mockRenew.mockResolvedValue(true)
    const work = deferred<void>()
    const run = runWithInboundTurnLease(job, () => work.promise)
    expect(vi.getTimerCount()).toBe(1)

    work.resolve()
    await run
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(mockRenew).not.toHaveBeenCalled()
  })

  it('propagates the work error unchanged and still clears the timer', async () => {
    mockRenew.mockResolvedValue(true)
    const failure = new Error('downstream exploded')
    const work = deferred<void>()
    const run = runWithInboundTurnLease(job, () => work.promise)
    const settled = run.then(
      () => 'resolved',
      (e: unknown) => e,
    )

    await vi.advanceTimersByTimeAsync(100_000)
    expect(mockRenew).toHaveBeenCalledTimes(1)

    work.reject(failure)
    expect(await settled).toBe(failure)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(600_000)
    expect(mockRenew).toHaveBeenCalledTimes(1)
  })

  it('propagates a synchronous throw from the work function and clears the timer', async () => {
    const failure = new Error('sync failure')
    await expect(
      runWithInboundTurnLease(job, () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(vi.getTimerCount()).toBe(0)
  })
})
