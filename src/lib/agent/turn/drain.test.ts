import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClaimedInboundTurn } from '@/lib/agent/turn/substrate'

const { mockClaim, mockComplete, mockReclaim, mockRunWithLease, mockDownstream } = vi.hoisted(() => ({
  mockClaim: vi.fn(),
  mockComplete: vi.fn(),
  mockReclaim: vi.fn(),
  mockRunWithLease: vi.fn(),
  mockDownstream: vi.fn(),
}))

vi.mock('@/lib/agent/turn/substrate', () => ({
  claimInboundTurnJob: mockClaim,
  completeInboundTurnJob: mockComplete,
  reclaimStuckInboundTurnJobs: mockReclaim,
}))
vi.mock('@/lib/agent/turn/lease', () => ({
  INBOUND_TURN_LEASE_SECONDS: 300,
  runWithInboundTurnLease: mockRunWithLease,
}))
vi.mock('@/lib/whatsapp/inbound-downstream', () => ({
  runInboundDownstreamForMessage: mockDownstream,
}))

const { drainInboundTurnJobs } = await import('@/lib/agent/turn/drain')

const turn = (n: number): ClaimedInboundTurn => ({
  messageId: `m${n}`,
  accountId: 'a1',
  contactId: `c${n}`,
  conversationId: `v${n}`,
  claimToken: `token-${n}`,
})

/** Queue of jobs the claim RPC hands out, then an empty queue. */
function queue(...jobs: ClaimedInboundTurn[]) {
  for (const j of jobs) mockClaim.mockResolvedValueOnce(j)
  mockClaim.mockResolvedValue(null)
}

describe('drainInboundTurnJobs', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    for (const m of [mockClaim, mockComplete, mockReclaim, mockRunWithLease, mockDownstream]) m.mockReset()
    mockReclaim.mockResolvedValue(0)
    mockComplete.mockResolvedValue(true)
    mockDownstream.mockResolvedValue(undefined)
    // Default: the lease is held for the whole turn and the work runs.
    mockRunWithLease.mockImplementation(async (_job: ClaimedInboundTurn, work: (l: { isHeld(): boolean }) => unknown) => ({
      result: await work({ isHeld: () => true }),
      leaseHeld: true,
    }))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  describe('empty queue and reclaim', () => {
    it('reports the reclaimed count and one skip, and claims once with the 300 s lease', async () => {
      mockReclaim.mockResolvedValue(2)
      queue()

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 2, processed: 0, failed: 0, skipped: 1 })
      expect(mockReclaim).toHaveBeenCalledWith(0)
      expect(mockClaim).toHaveBeenCalledTimes(1)
      expect(mockClaim).toHaveBeenCalledWith(300)
      expect(mockComplete).not.toHaveBeenCalled()
      expect(mockDownstream).not.toHaveBeenCalled()
    })

    it('forwards reclaimStaleSeconds to the reclaim RPC', async () => {
      queue()
      await drainInboundTurnJobs({ reclaimStaleSeconds: 45 })
      expect(mockReclaim).toHaveBeenCalledWith(45)
    })

    it('reclaims before it claims', async () => {
      const order: string[] = []
      mockReclaim.mockImplementation(async () => {
        order.push('reclaim')
        return 0
      })
      mockClaim.mockImplementation(async () => {
        order.push('claim')
        return null
      })
      await drainInboundTurnJobs()
      expect(order).toEqual(['reclaim', 'claim'])
    })
  })

  describe('success path', () => {
    it('runs the downstream of every claimed job under its lease and completes it with its own token', async () => {
      queue(turn(1), turn(2), turn(3))

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 3, failed: 0, skipped: 1 })

      expect(mockRunWithLease.mock.calls.map((c) => c[0])).toEqual([turn(1), turn(2), turn(3)])
      expect(mockDownstream.mock.calls).toEqual([['m1'], ['m2'], ['m3']])
      expect(mockComplete.mock.calls).toEqual([
        [{ messageId: 'm1', claimToken: 'token-1', success: true }],
        [{ messageId: 'm2', claimToken: 'token-2', success: true }],
        [{ messageId: 'm3', claimToken: 'token-3', success: true }],
      ])
    })

    it('processes jobs one at a time, in claim order', async () => {
      queue(turn(1), turn(2))
      const events: string[] = []
      mockDownstream.mockImplementation(async (id: string) => {
        events.push(`start ${id}`)
        await Promise.resolve()
        events.push(`end ${id}`)
      })
      mockComplete.mockImplementation(async ({ messageId }: { messageId: string }) => {
        events.push(`complete ${messageId}`)
        return true
      })

      await drainInboundTurnJobs()
      expect(events).toEqual(['start m1', 'end m1', 'complete m1', 'start m2', 'end m2', 'complete m2'])
    })
  })

  describe('maxJobs', () => {
    it('defaults to 10 and does not report a skip when the budget ends the loop', async () => {
      mockClaim.mockImplementation(async () => turn(1))

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 10, failed: 0, skipped: 0 })
      expect(mockClaim).toHaveBeenCalledTimes(10)
    })

    it('honours a custom limit', async () => {
      mockClaim.mockImplementation(async () => turn(1))

      expect(await drainInboundTurnJobs({ maxJobs: 2 })).toMatchObject({ processed: 2, skipped: 0 })
      expect(mockClaim).toHaveBeenCalledTimes(2)
    })

    it('maxJobs 0 still reclaims but claims nothing', async () => {
      mockReclaim.mockResolvedValue(3)

      expect(await drainInboundTurnJobs({ maxJobs: 0 })).toEqual({
        reclaimed: 3,
        processed: 0,
        failed: 0,
        skipped: 0,
      })
      expect(mockClaim).not.toHaveBeenCalled()
    })
  })

  describe('downstream failure', () => {
    it('reports the Error message to complete(success=false) and keeps draining', async () => {
      queue(turn(1), turn(2))
      mockDownstream.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 1, skipped: 1 })
      expect(mockComplete.mock.calls).toEqual([
        [{ messageId: 'm1', claimToken: 'token-1', success: false, error: 'boom' }],
        [{ messageId: 'm2', claimToken: 'token-2', success: true }],
      ])
    })

    it('stringifies a thrown non-Error', async () => {
      queue(turn(1))
      mockDownstream.mockRejectedValueOnce('plain string failure')

      await drainInboundTurnJobs()
      expect(mockComplete).toHaveBeenCalledWith({
        messageId: 'm1',
        claimToken: 'token-1',
        success: false,
        error: 'plain string failure',
      })
    })

    it('a failing job does not stop later jobs from being claimed', async () => {
      queue(turn(1), turn(2), turn(3))
      mockDownstream.mockRejectedValue(new Error('always'))

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 3, skipped: 1 })
      expect(mockComplete).toHaveBeenCalledTimes(3)
    })
  })

  describe('lease and completion outcomes', () => {
    it('lease lost: no completion, counted as failed, warned, and the loop continues', async () => {
      queue(turn(1), turn(2))
      mockRunWithLease
        .mockResolvedValueOnce({ result: undefined, leaseHeld: false })
        .mockImplementationOnce(async (_job: ClaimedInboundTurn, work: (l: { isHeld(): boolean }) => unknown) => ({
          result: await work({ isHeld: () => true }),
          leaseHeld: true,
        }))

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 1, skipped: 1 })
      expect(warnSpy).toHaveBeenCalledWith('[inbound-turn] lease lost before completion:', 'm1')
      expect(mockComplete.mock.calls).toEqual([[{ messageId: 'm2', claimToken: 'token-2', success: true }]])
    })

    it('completion refused (false) after a successful turn counts as failed, not processed, and is not re-reported', async () => {
      queue(turn(1))
      mockComplete.mockResolvedValueOnce(false)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 1, skipped: 1 })
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  describe('RPC failures', () => {
    it('reclaim failure rejects before anything is claimed', async () => {
      mockReclaim.mockRejectedValue(new Error('reclaim_stuck_inbound_turn_jobs: down'))

      await expect(drainInboundTurnJobs()).rejects.toThrow('reclaim_stuck_inbound_turn_jobs: down')
      expect(mockClaim).not.toHaveBeenCalled()
    })

    it('claim failure rejects', async () => {
      mockClaim.mockRejectedValue(new Error('claim_inbound_turn_job: down'))

      await expect(drainInboundTurnJobs()).rejects.toThrow('claim_inbound_turn_job: down')
      expect(mockComplete).not.toHaveBeenCalled()
    })

    it('a claim failure after a finished job rejects, but that job was already completed', async () => {
      mockClaim.mockResolvedValueOnce(turn(1)).mockRejectedValueOnce(new Error('claim_inbound_turn_job: down'))

      await expect(drainInboundTurnJobs()).rejects.toThrow('claim_inbound_turn_job: down')
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledWith({ messageId: 'm1', claimToken: 'token-1', success: true })
    })
  })

  describe('completion bookkeeping failures', () => {
    // The downstream SUCCEEDED, so a failing success report is not a failed
    // attempt: no complete(false). The job stays `processing` under its lease and
    // the 088 reclaim recovers it; the batch carries on.
    it('a throwing complete(success=true) is not turned into a failed attempt, and the batch continues', async () => {
      queue(turn(1), turn(2))
      const failure = new Error('complete_inbound_turn_job: timeout')
      mockComplete.mockRejectedValueOnce(failure).mockResolvedValueOnce(true)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 1, skipped: 1 })
      expect(mockDownstream.mock.calls).toEqual([['m1'], ['m2']])
      expect(mockComplete.mock.calls).toEqual([
        [{ messageId: 'm1', claimToken: 'token-1', success: true }],
        [{ messageId: 'm2', claimToken: 'token-2', success: true }],
      ])
      expect(errorSpy).toHaveBeenCalledWith('[inbound-turn] could not record completion:', 'm1', failure)
    })

    // The failed attempt could not be recorded either: the original cause stays
    // visible in the log, the job is left to its lease and the drain goes on.
    it('a throwing complete(success=false) is logged with the original cause and does not abort the drain', async () => {
      queue(turn(1), turn(2))
      mockDownstream.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)
      const secondary = new Error('complete_inbound_turn_job: down')
      mockComplete.mockRejectedValueOnce(secondary).mockResolvedValueOnce(true)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 1, skipped: 1 })
      expect(mockComplete.mock.calls).toEqual([
        [{ messageId: 'm1', claimToken: 'token-1', success: false, error: 'boom' }],
        [{ messageId: 'm2', claimToken: 'token-2', success: true }],
      ])
      expect(errorSpy).toHaveBeenCalledWith(
        '[inbound-turn] could not record failed attempt:',
        'm1',
        secondary,
        'cause:',
        'boom',
      )
    })
  })
})
