import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

/**
 * Fires `conversation_assigned` automations after a manual (re)assignment
 * from the inbox. The client only says *which* conversation changed; the
 * assignee is read back from the database so a caller cannot claim an
 * assignment that never happened.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!profile?.account_id) {
      return NextResponse.json({ error: 'No account linked' }, { status: 400 })
    }

    const body = await req.json()
    const { event, conversationId } = body
    if (event !== 'conversation_assigned' || !conversationId) {
      return NextResponse.json({ error: 'Missing or unsupported event' }, { status: 400 })
    }

    const { data: conversation } = await supabaseAdmin()
      .from('conversations')
      .select('id, contact_id, assigned_agent_id')
      .eq('id', conversationId)
      .eq('account_id', profile.account_id)
      .maybeSingle()
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found in account' }, { status: 404 })
    }

    // Unassignment is not an assignment: nothing to dispatch.
    if (!conversation.assigned_agent_id) {
      return NextResponse.json({ ok: true, dispatched: false })
    }

    await runAutomationsForTrigger({
      accountId: profile.account_id,
      triggerType: 'conversation_assigned',
      contactId: conversation.contact_id ?? null,
      context: {
        conversation_id: conversation.id,
        agent_id: conversation.assigned_agent_id,
      },
    })

    return NextResponse.json({ ok: true, dispatched: true })
  } catch (err) {
    console.error('[conversations/events] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    )
  }
}
