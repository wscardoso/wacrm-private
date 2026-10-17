import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { notifyDealCreated, notifyDealStageChanged } from '@/lib/deals/events'

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
    const { event, dealId, stageId, oldStageId } = body

    if (!event || !dealId) {
      return NextResponse.json({ error: 'Missing event or dealId' }, { status: 400 })
    }

    const admin = supabaseAdmin()
    const { data: deal } = await admin
      .from('deals')
      .select('*')
      .eq('id', dealId)
      .eq('account_id', profile.account_id)
      .single()

    if (!deal) {
      return NextResponse.json({ error: 'Deal not found in account' }, { status: 404 })
    }

    if (event === 'deal_created') {
      await notifyDealCreated({
        accountId: profile.account_id,
        dealId: deal.id,
        contactId: deal.contact_id,
        pipelineId: deal.pipeline_id,
        stageId: deal.stage_id,
        title: deal.title,
        value: deal.value,
      })
    } else if (event === 'deal_stage_changed') {
      await notifyDealStageChanged({
        accountId: profile.account_id,
        dealId: deal.id,
        contactId: deal.contact_id,
        pipelineId: deal.pipeline_id,
        oldStageId,
        newStageId: stageId || deal.stage_id,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[deals/events] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    )
  }
}
