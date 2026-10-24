import { evaluateToolCall } from '@/lib/agent/auth/evaluate'
import { suspendAgentAfterHandoff } from '@/lib/agent/handoff/suspend'

export async function executeHandoffToHuman(args: {
  accountId: string
  conversationId: string
}): Promise<{ agentConsumed: true }> {
  const decision = evaluateToolCall({
    toolName: 'handoff_to_human',
    accountId: args.accountId,
    contextAccountId: args.accountId,
  })
  if (decision.outcome !== 'allow') {
    throw new Error(`handoff denied: ${decision.reason_code}`)
  }
  await suspendAgentAfterHandoff(args.conversationId)
  return { agentConsumed: true }
}
