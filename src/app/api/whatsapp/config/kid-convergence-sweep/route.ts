import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  isLegacyFormat,
  decryptWithBindingContext,
  encryptWithBindingContext,
} from '@/lib/whatsapp/encryption'
import {
  whatsappConfigBindingContext,
  isWhatsappConfigCanonicalWriteEnabled,
} from '@/lib/whatsapp/config-binding'
import { needsKidConvergence, getCurrentWriteKid } from '@/lib/crypto/kidConvergence'

const BATCH_LIMIT = 50
const MAX_ROWS = 2500

/**
 * IMP-E7-001 Phase 4 — administrative KID convergence sweep for
 * `whatsapp_config` (ADR-E7-001 §13.2, "convergência administrativa").
 *
 * Complements the lazy (read-path) self-heal already extended in
 * webhook/route.ts and send/route.ts: those only reconverge a row when
 * it happens to be read organically through those specific paths. This
 * sweep reaches every row regardless of read traffic — required to
 * eventually produce the convergence proof ADR-E7-001 §13.1/§13.3 will
 * need before a KID can be declared `Retired`/`Destroyed` (Phase 3/5) —
 * never a precondition for this sweep to run, and never a blocking
 * dependency for any read (RNF-2: always best-effort, always async).
 *
 * Never alters Binding Context (§13.2, mandatory) — every re-encryption
 * uses the exact same `whatsappConfigBindingContext(account_id)` the
 * column was already bound to; only the KID under it changes.
 *
 * No-op while the domain's canonical-write flag is off — there is
 * nothing canonical to converge to yet, and this sweep never produces
 * a canonical envelope on its own (it only re-targets existing
 * canonical envelopes at the current write KID).
 *
 * Paginates through the table via ORDER BY id ASC + cursor (.gt('id'))
 * so that repeated cron invocations cover every row, not just the
 * first batch. Safety-capped at MAX_ROWS per invocation to prevent
 * runaway execution (orphan-sweep has a similar internal cap).
 *
 * Deployment model assumption: the cursor tracking between batches
 * relies on a single long-lived process (same as admin-client.ts's
 * "Single-instance VPS: one shared client per process" assumption).
 * Under pure serverless (process per invocation) the cursor resets
 * each call — the sweep still converges the table across N cron
 * runs, just each run restarts from the first row (redundant but
 * never incorrect; the safety cap prevents infinite repeat).
 *
 * Auth: same AUTOMATION_CRON_SECRET + x-cron-secret pattern as
 * delivery/orphan-sweep/route.ts.
 */
export async function GET(request: Request) {
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

  if (!isWhatsappConfigCanonicalWriteEnabled()) {
    return NextResponse.json({ converged: 0, scanned: 0, skipped: 'canonical write disabled' })
  }

  const admin = supabaseAdmin()
  const currentKid = getCurrentWriteKid()

  let cursor: string | undefined
  let converged = 0
  let scanned = 0

  for (let scannedThisRun = 0; scannedThisRun < MAX_ROWS; ) {
    const query = admin
      .from('whatsapp_config')
      .select('id, account_id, access_token, verify_token, waba_id')
      .order('id', { ascending: true })
      .limit(BATCH_LIMIT)

    if (cursor) {
      query.gt('id', cursor)
    }

    const { data: rows, error } = await query

    if (error) {
      console.error('[kid-convergence-sweep] select failed:', error.message)
      return NextResponse.json({ error: 'select failed' }, { status: 500 })
    }
    if (!rows || rows.length === 0) break

    for (const row of rows) {
      try {
        const didConverge = await convergeRow(admin, row, currentKid)
        if (didConverge) converged++
      } catch (err) {
        console.error(
          '[kid-convergence-sweep] row %s failed:',
          row.id,
          err instanceof Error ? err.message : err,
        )
      }
    }

    scanned += rows.length
    scannedThisRun += rows.length
    cursor = rows[rows.length - 1].id

    if (rows.length < BATCH_LIMIT) break
  }

  return NextResponse.json({ converged, scanned })
}

type ConfigRow = {
  id: string
  account_id: string
  access_token: string | null
  verify_token: string | null
  waba_id: string | null
}

const CONVERGIBLE_COLUMNS = ['access_token', 'verify_token', 'waba_id'] as const

async function convergeRow(
  admin: ReturnType<typeof supabaseAdmin>,
  row: ConfigRow,
  currentKid: string,
): Promise<boolean> {
  const bc = whatsappConfigBindingContext(row.account_id)
  const updates: Partial<Record<(typeof CONVERGIBLE_COLUMNS)[number], string>> = {}

  for (const column of CONVERGIBLE_COLUMNS) {
    const value = row[column]
    if (!value) continue
    // Legacy format is the lazy/administrative self-heal's job in the
    // pre-existing sense (legacy -> canonical) — out of scope here,
    // which only handles canonical-but-stale-KID -> canonical-current-KID.
    if (isLegacyFormat(value)) continue
    if (!needsKidConvergence(value, currentKid)) continue

    try {
      const plaintext = decryptWithBindingContext(value, bc)
      updates[column] = encryptWithBindingContext(plaintext, bc)
    } catch (err) {
      console.error(
        '[kid-convergence-sweep] decrypt failed for %s.%s:',
        row.id,
        column,
        err instanceof Error ? err.message : err,
      )
    }
  }

  if (Object.keys(updates).length === 0) return false

  const { error } = await admin.from('whatsapp_config').update(updates).eq('id', row.id)
  if (error) {
    console.error('[kid-convergence-sweep] update failed for %s:', row.id, error.message)
    return false
  }
  return true
}
