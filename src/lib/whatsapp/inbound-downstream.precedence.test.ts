import { describe, it, expect } from 'vitest'
import { buildAutomationTriggers } from '@/lib/whatsapp/inbound-downstream'

describe('inbound downstream precedence (R-5)', () => {
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

  it('suppresses content triggers when agentConsumed', () => {
    const triggers = buildAutomationTriggers({
      ctx,
      flowConsumed: false,
      agentConsumed: true,
    })
    expect(triggers).not.toContain('new_message_received')
    expect(triggers).not.toContain('keyword_match')
  })

  it('suppresses content triggers when flowConsumed', () => {
    const triggers = buildAutomationTriggers({
      ctx,
      flowConsumed: true,
      agentConsumed: false,
    })
    expect(triggers).not.toContain('new_message_received')
  })

  it('fires content triggers when neither consumed', () => {
    const triggers = buildAutomationTriggers({
      ctx,
      flowConsumed: false,
      agentConsumed: false,
    })
    expect(triggers).toContain('new_message_received')
    expect(triggers).toContain('keyword_match')
  })
})
