import { describe, it, expect } from 'vitest'
import { evaluateToolCall } from '@/lib/agent/auth/evaluate'

describe('evaluateToolCall (D11 fail-closed)', () => {
  it('denies cross-account tool invocation', () => {
    const d = evaluateToolCall({
      toolName: 'handoff_to_human',
      accountId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      contextAccountId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    })
    expect(d).toEqual({ outcome: 'deny', reason_code: 'cross_account_tool_denied' })
  })

  it('allows handoff_to_human for matching account', () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    expect(
      evaluateToolCall({
        toolName: 'handoff_to_human',
        accountId: id,
        contextAccountId: id,
      }),
    ).toEqual({ outcome: 'allow', reason_code: 'handoff_to_human_v1' })
  })

  it('evaluation_failure on empty tool name', () => {
    expect(
      evaluateToolCall({
        toolName: '  ',
        accountId: 'a',
        contextAccountId: 'a',
      }).outcome,
    ).toBe('evaluation_failure')
  })

  it('denies unknown tools (fail-closed)', () => {
    expect(
      evaluateToolCall({
        toolName: 'update_deal',
        accountId: 'a',
        contextAccountId: 'a',
      }),
    ).toEqual({ outcome: 'deny', reason_code: 'no_ratified_policy_for_tool' })
  })
})
