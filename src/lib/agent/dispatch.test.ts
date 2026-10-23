import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/agent/eligibility', () => ({
  checkAgentEligibility: vi.fn(),
}))
vi.mock('@/lib/agent/runs/persist', () => ({
  beginAgentRun: vi.fn(),
  recordAgentStep: vi.fn(),
  finishAgentRun: vi.fn(),
}))

const { checkAgentEligibility } = await import('@/lib/agent/eligibility')
const { beginAgentRun } = await import('@/lib/agent/runs/persist')
const { dispatchNativeAgentForInbound } = await import('@/lib/agent/dispatch')

const ctx = {
  configOwnerUserId: 'u',
  accountId: 'a',
  contactId: 'c',
  conversationId: 'v',
  isFirstInboundMessage: false,
  contactWasCreated: false,
  inboundText: 'x',
  inboundType: 'text',
  externalMessageId: 'e',
  lastMessagePreview: 'x',
  unreadCountBefore: 0,
}

describe('dispatchNativeAgentForInbound', () => {
  beforeEach(() => {
    vi.mocked(checkAgentEligibility).mockReset()
    vi.mocked(beginAgentRun).mockReset()
  })

  it('does not run when flowConsumed', async () => {
    const result = await dispatchNativeAgentForInbound({
      ctx,
      inboundMessageId: 'm',
      flowConsumed: true,
    })
    expect(result.agentConsumed).toBe(false)
    expect(checkAgentEligibility).not.toHaveBeenCalled()
  })
})
