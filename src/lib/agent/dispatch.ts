import type { InboundDownstreamContext } from '@/lib/whatsapp/inbound-downstream'
import { checkAgentEligibility } from '@/lib/agent/eligibility'
import { beginAgentRun, finishAgentRun, recordAgentStep } from '@/lib/agent/runs/persist'

export interface NativeAgentDispatchResult {
  agentConsumed: boolean
  runId?: string
}

/**
 * Flows → agent → Automations (agent slice). No LLM fetch (Q3 open).
 * Q13 step limits not applied — no tool loop in this scaffold.
 */
export async function dispatchNativeAgentForInbound(args: {
  ctx: InboundDownstreamContext
  inboundMessageId: string
  flowConsumed: boolean
}): Promise<NativeAgentDispatchResult> {
  if (args.flowConsumed) {
    return { agentConsumed: false }
  }

  const eligibility = await checkAgentEligibility({
    accountId: args.ctx.accountId,
    contactId: args.ctx.contactId,
    conversationId: args.ctx.conversationId,
  })

  if (!eligibility.eligible) {
    return { agentConsumed: false }
  }

  const runId = await beginAgentRun({
    accountId: args.ctx.accountId,
    contactId: args.ctx.contactId,
    conversationId: args.ctx.conversationId,
    inboundMessageId: args.inboundMessageId,
  })

  await recordAgentStep({
    runId,
    stepIndex: 0,
    kind: 'eligibility',
    decision: { eligible: true, reason: eligibility.reason },
  })

  await recordAgentStep({
    runId,
    stepIndex: 1,
    kind: 'turn_stub',
    decision: { action: 'none', note: 'llm_not_configured' },
  })

  await finishAgentRun({
    runId,
    status: 'completed',
    agentConsumed: false,
  })

  return { agentConsumed: false, runId }
}
