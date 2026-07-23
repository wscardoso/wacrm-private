import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { EnrichmentReport } from '@/lib/enrichment/types'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')

    const { data, error } = await ctx.supabase.rpc('get_enrichment_report', {
      p_account_id: ctx.accountId,
    })

    if (error) {
      console.error('[enrichment-report] rpc error:', error.message)
      return NextResponse.json({ error: 'Failed to load report' }, { status: 500 })
    }

    return NextResponse.json(data as EnrichmentReport)
  } catch (err) {
    return toErrorResponse(err)
  }
}
