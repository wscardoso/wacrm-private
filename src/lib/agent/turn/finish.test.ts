import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ClaimedInboundTurn } from '@/lib/agent/turn/substrate'

const { mockComplete } = vi.hoisted(() => ({ mockComplete: vi.fn() }))

vi.mock('@/lib/agent/turn/substrate', () => ({
  completeInboundTurnJob: mockComplete,
}))

const { recordInboundTurnSuccess, recordInboundTurnFailure } = await import('@/lib/agent/turn/finish')

const job: ClaimedInboundTurn = {
  messageId: 'm1',
  accountId: 'a1',
  contactId: 'c1',
  conversationId: 'v1',
  claimToken: 'token-1',
}

describe('inbound turn reports (finish.ts)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockComplete.mockReset()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  describe('recordInboundTurnSuccess', () => {
    it('reports success with the job identity and no error text', async () => {
      mockComplete.mockResolvedValue(true)

      expect(await recordInboundTurnSuccess(job)).toEqual({ status: 'recorded' })
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(mockComplete).toHaveBeenCalledWith({
        messageId: 'm1',
        claimToken: 'token-1',
        success: true,
        error: undefined,
      })
    })

    it('maps a false answer to refused', async () => {
      mockComplete.mockResolvedValue(false)
      expect(await recordInboundTurnSuccess(job)).toEqual({ status: 'refused' })
    })

    it('returns the RPC error instead of throwing, never reports a failure, and does not log', async () => {
      const failure = new Error('complete_inbound_turn_job: timeout')
      mockComplete.mockRejectedValue(failure)

      expect(await recordInboundTurnSuccess(job)).toEqual({ status: 'error', error: failure })
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  describe('recordInboundTurnFailure', () => {
    it('reports the Error message as the failed attempt', async () => {
      mockComplete.mockResolvedValue(true)

      expect(await recordInboundTurnFailure(job, new Error('boom'))).toEqual({ status: 'recorded' })
      expect(mockComplete).toHaveBeenCalledWith({
        messageId: 'm1',
        claimToken: 'token-1',
        success: false,
        error: 'boom',
      })
    })

    it('stringifies a non-Error cause', async () => {
      mockComplete.mockResolvedValue(true)

      await recordInboundTurnFailure(job, 'plain string failure')
      expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'plain string failure' }))
    })

    it('maps a false answer to refused without logging', async () => {
      mockComplete.mockResolvedValue(false)

      expect(await recordInboundTurnFailure(job, new Error('boom'))).toEqual({ status: 'refused' })
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('never throws: a failing report is returned and logged together with the original cause', async () => {
      const secondary = new Error('complete_inbound_turn_job: down')
      mockComplete.mockRejectedValue(secondary)

      expect(await recordInboundTurnFailure(job, new Error('boom'))).toEqual({ status: 'error', error: secondary })
      expect(mockComplete).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith('[inbound-turn] could not record failed attempt:', 'm1', secondary, 'cause:', 'boom')
    })
  })
})
