import { supabaseAdmin } from '@/lib/supabase/admin-client'

export async function suspendAgentAfterHandoff(conversationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('suspend_conversational_agent_after_handoff', {
    p_conversation_id: conversationId,
  })
  if (error) throw new Error(error.message)
  return data === true
}

export async function resumeConversationalAgent(conversationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('resume_conversational_agent', {
    p_conversation_id: conversationId,
  })
  if (error) throw new Error(error.message)
  return data === true
}

export async function isAgentSuspendedAfterHandoff(conversationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('agent_suspended_after_handoff_at')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.agent_suspended_after_handoff_at != null
}
