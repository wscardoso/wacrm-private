import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClaimedInboundTurn } from '@/lib/agent/turn/substrate'

const { mockClaimForMessage, mockComplete, mockRunWithLease, mockDownstream } = vi.hoisted(() => ({
  mockClaimForMessage: vi.fn(),
  mockComplete: vi.fn(),
  mockRunWithLease: vi.fn(),
  mockDownstream: vi.fn(),
}))

vi.mock('@/lib/agent/turn/substrate', () => ({
  claimInboundTurnForMessage: mockClaimForMessage,
  completeInboundTurnJob: mockComplete,
}))
vi.mock('@/lib/agent/turn/lease', () => ({
  INBOUND_TURN_LEASE_SECONDS: 300,
  runWithInboundTurnLease: mockRunWithLease,
}))
vi.mock('@/lib/whatsapp/inbound-downstream', () => ({
  runInboundDownstreamForMessage: mockDownstream,
}))

const { processInboundTurnForMessage } = await import('@/lib/agent/turn/process-message-turn')

const job: ClaimedInboundTurn = {
  messageId: 'm1',
  accountId: 'a1',
  contactId: 'c1',
  conversationId: 'v1',
  claimToken: 'token-1',
}

describe('processInboundTurnForMessage', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    for (const m of [mockClaimForMessage, mockComplete, mockRunWithLease, mockDownstream]) m.mockReset()
    mockClaimForMessage.mockResolvedValue(job)
    mockComplete.mockResolvedValue(true)
    mockDownstream.mockResolvedValue(undefined)
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

  it('claims with the 300 s lease', async () => {
    await processInboundTurnForMessage('m1')
    expect(mockClaimForMessage).toHaveBeenCalledWith('m1', 300)
  })

  describe('claim returns null', () => {
    it('returns false and touches nothing else (already taken, completed, in backoff or behind an older turn)', async () => {
      mockClaimForMessage.mockResolvedValue(null)

      expect(await processInboundTurnForMessage('m1')).toBe(false)
      expect(mockRunWithLease).not.toHaveBeenCalled()
      expect(mockDownstream).not.toHaveBeenCalled()
      expect(mockComplete).not.toHaveBeenCalled()
    })
  })

  describe('claim rejects', () => {
    it('rejects with the claim error and does not run, complete or report anything', async () => {
      const failure = new Error('claim_inbound_turn_for_message: down')
      mockClaimForMessage.mockRejectedValue(failure)

      await expect(processInboundTurnForMessage('m1')).rejects.toBe(failure)
      expect(mockRunWithLease).not.toHaveBeenCalled()
      expect(mockDownstream).not.toHaveBeenCalled()
      expect(mockComplete).not.toHaveBeenCalled()
    })
  })

  describe('success', () => {
    it('runs the downstream under the lease of the claimed job and completes with its token', async () => {
      expect(await processInboundTurnForMessage('m1')).toBe(true)

      expect(mockRunWithLease).toHaveBeenCalledTimes(1)
      expect(mockRunWithLease.mock.calls[0]![0]).toBe(job)
      expect(mockDownstream).toHaveBeenCalledWith('m1')
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledWith({ messageId: 'm1', claimToken: 'token-1', success: true })
    })

    it('completes only after the downstream has finished', async () => {
      const events: string[] = []
      mockDownstream.mockImplementation(async () => {
        events.push('downstream start')
        await Promise.resolve()
        events.push('downstream end')
      })
      mockComplete.mockImplementation(async () => {
        events.push('complete')
        return true
      })

      await processInboundTurnForMessage('m1')
      expect(events).toEqual(['downstream start', 'downstream end', 'complete'])
    })
  })

  describe('completion refused', () => {
    it('returns false when the completion RPC answers false (lease expired or token replaced)', async () => {
      mockComplete.mockResolvedValue(false)

      expect(await processInboundTurnForMessage('m1')).toBe(false)
      expect(mockDownstream).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledTimes(1)
    })
  })

  describe('lease lost', () => {
    it('returns false, warns and does not complete', async () => {
      mockRunWithLease.mockResolvedValue({ result: undefined, leaseHeld: false })

      expect(await processInboundTurnForMessage('m1')).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith('[inbound-turn] lease lost before completion:', 'm1')
      expect(mockComplete).not.toHaveBeenCalled()
    })
  })

  describe('downstream error', () => {
    it('reports the failure to complete(success=false) and rethrows the same Error', async () => {
      const failure = new Error('boom')
      mockDownstream.mockRejectedValue(failure)

      await expect(processInboundTurnForMessage('m1')).rejects.toBe(failure)
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledWith({
        messageId: 'm1',
        claimToken: 'token-1',
        success: false,
        error: 'boom',
      })
    })

    it('stringifies a thrown non-Error for the record and rethrows the original value', async () => {
      mockDownstream.mockRejectedValue('plain string failure')

      await expect(processInboundTurnForMessage('m1')).rejects.toBe('plain string failure')
      expect(mockComplete).toHaveBeenCalledWith({
        messageId: 'm1',
        claimToken: 'token-1',
        success: false,
        error: 'plain string failure',
      })
    })

    // The failed attempt could not be recorded: the caller still sees the
    // downstream error (not the bookkeeping one); the secondary failure is logged
    // with the cause and the job is left to its lease.
    it('a throwing complete(success=false) does not mask the downstream error and is logged with its cause', async () => {
      const failure = new Error('boom')
      const secondary = new Error('complete_inbound_turn_job: down')
      mockDownstream.mockRejectedValue(failure)
      mockComplete.mockRejectedValue(secondary)

      await expect(processInboundTurnForMessage('m1')).rejects.toBe(failure)
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith(
        '[inbound-turn] could not record failed attempt:',
        'm1',
        secondary,
        'cause:',
        'boom',
      )
    })
  })

  describe('completion of a successful turn cannot be recorded', () => {
    // The downstream SUCCEEDED, so this is not a failed attempt: no
    // complete(false). The completion error is surfaced and the job stays under
    // its lease for the 088 reclaim.
    it('rejects with the completion error and does not report a failed attempt', async () => {
      const failure = new Error('complete_inbound_turn_job: timeout')
      mockComplete.mockRejectedValue(failure)

      await expect(processInboundTurnForMessage('m1')).rejects.toBe(failure)
      expect(mockDownstream).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledWith({ messageId: 'm1', claimToken: 'token-1', success: true })
    })
  })
})
