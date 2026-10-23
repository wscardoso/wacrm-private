import { supabaseAdmin } from '@/lib/supabase/admin-client'

export interface AgentEligibilityResult {
  eligible: boolean
  reason: string
}

export async function checkAgentEligibility(args: {
  accountId: string
  contactId: string
  conversationId: string
}): Promise<AgentEligibilityResult> {
  const db = supabaseAdmin()

  const { data: account, error: accountError } = await db
    .from('accounts')
    .select('native_conversational_agent_enabled')
    .eq('id', args.accountId)
    .maybeSingle()

  if (accountError) {
    throw new Error(`agent eligibility account: ${accountError.message}`)
  }
  if (!account?.native_conversational_agent_enabled) {
    return { eligible: false, reason: 'flag_off' }
  }

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('assigned_agent_id, agent_suspended_after_handoff_at')
    .eq('id', args.conversationId)
    .maybeSingle()

  if (convError) {
    throw new Error(`agent eligibility conversation: ${convError.message}`)
  }
  if (conversation?.assigned_agent_id) {
    return { eligible: false, reason: 'assigned_human' }
  }
  if (conversation?.agent_suspended_after_handoff_at) {
    return { eligible: false, reason: 'handoff_suspended' }
  }

  const { data: activeRuns, error: runError } = await db
    .from('flow_runs')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('status', 'active')
    .limit(1)

  if (runError) {
    throw new Error(`agent eligibility flow_runs: ${runError.message}`)
  }
  if (activeRuns && activeRuns.length > 0) {
    return { eligible: false, reason: 'active_flow_run' }
  }

  return { eligible: true, reason: 'ok' }
}
