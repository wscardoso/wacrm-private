import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getProvider } from '@/lib/whatsapp/providers'
import { decrypt } from '@/lib/whatsapp/encryption'
import { settleMessageSystem } from '@/lib/whatsapp/delivery/settlement'
import { ORPHAN_THRESHOLD_MS, DEFAULT_TTL_MS } from '@/lib/whatsapp/delivery/retry-policy'

const BATCH_LIMIT = 50

/**
 * ARO-001 §16 — Orphan sweeper + TTL sweep.
 *
 * Two responsibilities in one pass:
 *
 *   1. **Orphan sweep** — messages stuck in `sending` past the threshold
 *      that have no ledger entry yet. Creates one, capability-gated:
 *      providers with native idempotency get a due entry (next_attempt_at =
 *      now), providers without get a blocked entry (next_attempt_at = NULL)
 *      so the TTL will eventually resolve them (ADR-E4B-002 §5 item 2).
 *   2. **TTL sweep** — pending ledger entries whose message `created_at`
 *      is beyond the TTL horizon. Settles them `failed` + ledger → dead.
 *
 * Auth: same `AUTOMATION_CRON_SECRET` + `x-cron-secret` pattern.
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

  const admin = supabaseAdmin()

  const orphans = await sweepOrphans(admin)
  const expired = await sweepExpired(admin)

  return NextResponse.json({ orphans_enqueued: orphans, ttl_swept: expired })
}

// ── Orphan sweep ───────────────────────────────────────────

async function sweepOrphans(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS).toISOString()

  const { data: orphans, error } = await admin
    .from('messages')
    .select('id, connection_ref, conversation_id, created_at')
    .eq('status', 'sending')
    .lt('created_at', cutoff)
    .limit(BATCH_LIMIT)

  if (error) {
    console.error('[orphan-sweep] select orphans failed:', error.message)
    return 0
  }
  if (!orphans || orphans.length === 0) return 0

  let enqueued = 0
  for (const msg of orphans) {
    try {
      const ok = await enqueueOrphan(admin, msg)
      if (ok) enqueued++
    } catch (err) {
      console.error('[orphan-sweep] orphan %s failed:', msg.id, err instanceof Error ? err.message : err)
    }
  }
  return enqueued
}

async function enqueueOrphan(
  admin: ReturnType<typeof supabaseAdmin>,
  msg: { id: string; connection_ref: string; conversation_id: string; created_at: string },
): Promise<boolean> {
  // Skip if a ledger entry already exists (race with concurrent sweeper)
  const { data: existing } = await admin
    .from('outbound_retry_ledger')
    .select('id')
    .eq('message_id', msg.id)
    .maybeSingle()
  if (existing) return false

  // Check provider capability via the connection's provider config
  const { data: wc } = await admin
    .from('whatsapp_config')
    .select('provider, access_token, instance_id, phone_number_id, base_url, waba_id')
    .eq('id', msg.connection_ref)
    .maybeSingle()

  if (!wc) {
    console.error('[orphan-sweep] whatsapp_config not found for connection_ref %s', msg.connection_ref)
    return false
  }

  const accessToken = decrypt(wc.access_token)
  let clientToken: string | undefined
  if (wc.provider === 'zapi' && wc.waba_id) {
    try { clientToken = decrypt(wc.waba_id) } catch { /* ignore */ }
  }

  const provider = getProvider(
    wc.provider === 'zapi'
      ? { provider: 'zapi', instanceId: wc.instance_id, accessToken, clientToken }
      : wc.provider === 'uazapi'
        ? { provider: 'uazapi', baseUrl: wc.base_url, instanceId: wc.instance_id, accessToken }
        : { provider: 'meta', phoneNumberId: wc.phone_number_id, accessToken, verifyToken: '' },
  )

  const hasIdempotency = provider.capabilities.nativeIdempotency

  await admin.from('outbound_retry_ledger').insert({
    message_id: msg.id,
    attempt_count: 0,
    next_attempt_at: hasIdempotency ? new Date().toISOString() : null,
    classification: 'ambiguous',
    last_error: 'orphan - process crashed before settlement',
    status: 'pending',
  })

  return true
}

// ── TTL sweep ──────────────────────────────────────────────

async function sweepExpired(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const ttlCutoff = new Date(Date.now() - DEFAULT_TTL_MS).toISOString()

  const { data: expired, error } = await admin
    .from('outbound_retry_ledger')
    .select('id, message_id')
    .eq('status', 'pending')
    .lt('created_at', ttlCutoff)

  if (error) {
    console.error('[orphan-sweep] select expired failed:', error.message)
    return 0
  }
  if (!expired || expired.length === 0) return 0

  let swept = 0
  for (const row of expired) {
    try {
      const { data: msg } = await admin
        .from('messages')
        .select('status')
        .eq('id', row.message_id)
        .maybeSingle()

      if (!msg) {
        await admin
          .from('outbound_retry_ledger')
          .update({ status: 'dead', last_error: 'TTL expired — message not found' })
          .eq('id', row.id)
        swept++
        continue
      }

      if (msg.status === 'sending') {
        await settleMessageSystem(admin, row.message_id, 'failed', '', [])
        await admin
          .from('outbound_retry_ledger')
          .update({ status: 'dead', last_error: 'TTL expired' })
          .eq('id', row.id)
      } else if (msg.status === 'sent') {
        await admin
          .from('outbound_retry_ledger')
          .update({ status: 'delivered', last_error: 'TTL sweep — message already sent' })
          .eq('id', row.id)
      } else {
        await admin
          .from('outbound_retry_ledger')
          .update({ status: 'dead', last_error: `TTL expired — message status: ${msg.status}` })
          .eq('id', row.id)
      }
      swept++
    } catch (err) {
      console.error('[orphan-sweep] TTL sweep %s failed:', row.id, err instanceof Error ? err.message : err)
    }
  }
  return swept
}
