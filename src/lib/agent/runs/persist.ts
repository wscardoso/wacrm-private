import { supabaseAdmin } from '@/lib/supabase/admin-client'

export async function beginAgentRun(args: {
  accountId: string
  contactId: string
  conversationId: string
  inboundMessageId: string
}): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from('agent_runs')
    .insert({
      account_id: args.accountId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      inbound_message_id: args.inboundMessageId,
      status: 'started',
      agent_consumed: false,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await supabaseAdmin()
        .from('agent_runs')
        .select('id')
        .eq('inbound_message_id', args.inboundMessageId)
        .maybeSingle()
      if (existing?.id) return existing.id as string
    }
    throw new Error(`beginAgentRun: ${error.message}`)
  }
  return data.id as string
}

export async function recordAgentStep(args: {
  runId: string
  stepIndex: number
  kind: string
  decision: Record<string, unknown>
}): Promise<void> {
  const { error } = await supabaseAdmin().from('agent_steps').insert({
    run_id: args.runId,
    step_index: args.stepIndex,
    kind: args.kind,
    decision: args.decision,
  })
  if (error) throw new Error(`recordAgentStep: ${error.message}`)
}

export async function finishAgentRun(args: {
  runId: string
  status: 'completed' | 'failed' | 'skipped'
  agentConsumed: boolean
  skipReason?: string | null
}): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('agent_runs')
    .update({
      status: args.status,
      agent_consumed: args.agentConsumed,
      skip_reason: args.skipReason ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', args.runId)

  if (error) throw new Error(`finishAgentRun: ${error.message}`)
}
