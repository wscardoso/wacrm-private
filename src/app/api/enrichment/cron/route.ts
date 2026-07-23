import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { runEnrichmentCycle } from '@/lib/enrichment/orchestration'

export async function GET(request: NextRequest) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)

  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = request.nextUrl.searchParams.get('account_id') ?? undefined

  try {
    const result = await runEnrichmentCycle(accountId)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[enrichment-cron] cycle error:', (err as Error).message)
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    )
  }
}
