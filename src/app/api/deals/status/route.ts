import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { resolveStatusUpdate } from '@/lib/deals/status'

/**
 * Sets a deal's status (open / won / lost) together with its loss reason in
 * one write, so the two columns can never disagree. Used by both the board
 * and the deal form.
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
      .select('account_id, account_role')
      .eq('user_id', user.id)
      .maybeSingle()
    if (!profile?.account_id) {
      return NextResponse.json({ error: 'No account linked' }, { status: 400 })
    }
    // Viewers are read-only everywhere else in the CRM.
    if (profile.account_role === 'viewer') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    let body: { dealId?: unknown; status?: unknown; lossReason?: unknown }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (typeof body.dealId !== 'string' || !body.dealId) {
      return NextResponse.json({ error: 'Missing dealId' }, { status: 400 })
    }

    const resolved = resolveStatusUpdate(body.status, body.lossReason)
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 400 })
    }

    const { data: deal, error } = await supabaseAdmin()
      .from('deals')
      .update({ ...resolved.update, updated_at: new Date().toISOString() })
      .eq('id', body.dealId)
      .eq('account_id', profile.account_id)
      .select('id, status, loss_reason')
      .maybeSingle()

    if (error) {
      console.error('[deals/status] update failed:', error)
      return NextResponse.json({ error: 'Failed to update deal' }, { status: 500 })
    }
    if (!deal) {
      return NextResponse.json({ error: 'Deal not found in account' }, { status: 404 })
    }

    return NextResponse.json({ ok: true, deal })
  } catch (err) {
    console.error('[deals/status] error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
