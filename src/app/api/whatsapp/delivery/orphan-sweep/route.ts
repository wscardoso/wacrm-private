import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getProvider, providerConfigFromRow } from '@/lib/whatsapp/providers'
import { decryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'
import { settleMessageSystem } from '@/lib/whatsapp/delivery/settlement'
import { evaluateBinding, type StoredBinding } from '@/lib/whatsapp/delivery/connection-binding'
import { ORPHAN_THRESHOLD_MS, DEFAULT_TTL_MS, STUCK_RETRYING_THRESHOLD_MS } from '@/lib/whatsapp/delivery/retry-policy'

const BATCH_LIMIT = 50

/**
 * ARO-001 §16 — Orphan sweeper + TTL sweep.
 *
 * Three responsibilities in one pass:
 *
 *   1. **Orphan sweep** — messages stuck in `sending` past the threshold
 *      that have no ledger entry yet. Creates one, capability-gated:
 *      providers with native idempotency get a due entry (next_attempt_at =
 *      now), providers without get a blocked entry (next_attempt_at = NULL)
 *      so the TTL will eventually resolve them (ADR-E4B-002 §5 item 2).
 *      A connection whose provider is no longer supported (e.g. the removed
 *      Z-API) takes the same blocked path with an explicit `last_error`: its
 *      delivery state is unknown, it must never be re-sent through another
 *      provider, and it must not make every sweep log the same error again.
 *   2. **TTL sweep** — pending ledger entries whose own `created_at`
 *      (`outbound_retry_ledger.created_at`, not `messages.created_at`)
 *      is beyond the TTL horizon. Settles them `failed` + ledger → dead.
 *   3. **Reclaim stuck `retrying`** (Commit 6.1 correção #4) — a row
 *      claimed by the scheduler (pending → retrying) whose drainer
 *      crashed mid-flight before reaching a terminal ledger update
 *      would otherwise stay `retrying` forever, invisible to both the
 *      scheduler's due-selection (which only looks at `pending`) and
 *      to a human until someone notices. Returns it to `pending` with
 *      `next_attempt_at = now()` so the next scheduler pass picks it
 *      back up. Does **not** create a new status (§ restriction) and
 *      does **not** increment `attempt_count` — the crash means the
 *      outcome of that attempt is unknown, not a declared retry.
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

  const limit = checkRateLimit('cron:whatsapp-orphan-sweep', RATE_LIMITS.cronDrain)
  if (!limit.success) return rateLimitResponse(limit)

  const admin = supabaseAdmin()

  const reclaimed = await reclaimStuckRetrying(admin)
  const orphans = await sweepOrphans(admin)
  const expired = await sweepExpired(admin)

  return NextResponse.json({ reclaimed, orphans_enqueued: orphans, ttl_swept: expired })
}

// ── Reclaim stuck `retrying` ──────────────────────────────

/**
 * Returns ledger rows abandoned mid-drain (`retrying` past the stuck
 * threshold, measured by `updated_at`) back to `pending`.
 *
 * Race safety: this is a single conditional `UPDATE ... WHERE status =
 * 'retrying' AND updated_at < cutoff`. Postgres executes it atomically
 * per row — if two concurrent sweeper runs race on the same row, only
 * the one that commits first actually changes `status` away from
 * `retrying`; the second run's `WHERE status = 'retrying'` no longer
 * matches that row and affects zero rows for it. No new status, no
 * separate lock table needed.
 */
async function reclaimStuckRetrying(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_RETRYING_THRESHOLD_MS).toISOString()

  const { data, error } = await admin
    .from('outbound_retry_ledger')
    .update({
      status: 'pending',
      next_attempt_at: new Date().toISOString(),
      last_error: 'reclaimed — stuck in retrying past threshold (drainer likely crashed)',
    })
    .eq('status', 'retrying')
    .lt('updated_at', cutoff)
    .select('id')

  if (error) {
    console.error('[orphan-sweep] reclaim stuck retrying failed:', error.message)
    return 0
  }
  return data?.length ?? 0
}

// ── Orphan sweep ───────────────────────────────────────────

async function sweepOrphans(admin: ReturnType<typeof supabaseAdmin>): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHAN_THRESHOLD_MS).toISOString()

  const { data: orphans, error } = await admin
    .from('messages')
    .select('id, connection_ref, delivery_provider, delivery_channel_fp, conversation_id, created_at')
    .eq('status', 'sending')
    .lt('created_at', cutoff)
    .limit(BATCH_LIMIT)

  if (error) {
    // The code distinguishes an incompatible schema (42703 undefined column,
    // 42P01 undefined table) from a transient failure.
    console.error('[orphan-sweep] select orphans failed (%s):', error.code ?? 'no code', error.message)
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
  msg: { id: string; conversation_id: string; created_at: string } & StoredBinding,
): Promise<boolean> {
  // Every lookup below can fail for reasons that say nothing about the message
  // (schema, permissions, network). A failure is thrown — logged by the caller,
  // not counted, retried on the next run — and NEVER turned into an entry that
  // misdescribes the message.

  // Skip if a ledger entry already exists (race with concurrent sweeper)
  const { data: existing, error: existingErr } = await admin
    .from('outbound_retry_ledger')
    .select('id')
    .eq('message_id', msg.id)
    .maybeSingle()
  if (existingErr) throw new Error(`ledger lookup failed (${existingErr.code ?? 'no code'}): ${existingErr.message}`)
  if (existing) return false

  // The account comes from the message's own conversation.
  const { data: conv, error: convErr } = await admin
    .from('conversations')
    .select('account_id')
    .eq('id', msg.conversation_id)
    .maybeSingle()
  if (convErr) throw new Error(`conversation lookup failed (${convErr.code ?? 'no code'}): ${convErr.message}`)
  const conversationAccountId = (conv as { account_id?: string | null } | null)?.account_id ?? null

  const stored: StoredBinding = {
    connection_ref: msg.connection_ref,
    delivery_provider: msg.delivery_provider,
    delivery_channel_fp: msg.delivery_channel_fp,
  }

  // Look the connection up only when the message records one (a legacy row has
  // nothing to look up, and `.eq('id', null)` would be a query error).
  const unrecorded = evaluateBinding({ stored, conversationAccountId, connection: null })
  const recorded = unrecorded.ok || (unrecorded.reason !== 'binding_missing' && unrecorded.reason !== 'binding_invalid')
  let wc: Record<string, string | null> | null = null
  if (recorded) {
    const { data, error: wcErr } = await admin
      .from('whatsapp_config')
      .select('id, account_id, provider, access_token, instance_id, phone_number_id, base_url')
      .eq('id', stored.connection_ref as string)
      .maybeSingle()
    if (wcErr) throw new Error(`connection lookup failed (${wcErr.code ?? 'no code'}): ${wcErr.message}`)
    wc = data as Record<string, string | null> | null
  }

  // Same identity rules as the retry cron. Anything unprovable is recorded as
  // a BLOCKED entry with the reason; the credential is read only when the
  // connection is proved to be the one the message was created for.
  const verdict = evaluateBinding({
    stored,
    conversationAccountId,
    connection: wc ? { id: wc.id as string, account_id: wc.account_id, provider: wc.provider, phone_number_id: wc.phone_number_id, instance_id: wc.instance_id, base_url: wc.base_url } : null,
  })

  let hasIdempotency = false
  let lastError = 'orphan - process crashed before settlement'
  if (!verdict.ok) {
    lastError = `orphan - blocked (${verdict.reason}): ${verdict.detail} (delivery state unknown, manual verification required; resolved only by TTL)`.slice(0, 500)
  } else {
    const bc = whatsappConfigBindingContext(wc!.account_id as string)
    const accessToken = decryptWithBindingContext(wc!.access_token as string, bc)
    const provider = getProvider(providerConfigFromRow(wc!, accessToken))
    hasIdempotency = provider.capabilities.nativeIdempotency
  }

  // message_id is UNIQUE (049): a concurrent sweeper loses with 23505, which
  // is the "already enqueued" outcome, not a failure.
  const { error: insertError } = await admin.from('outbound_retry_ledger').insert({
    message_id: msg.id,
    attempt_count: 0,
    next_attempt_at: hasIdempotency ? new Date().toISOString() : null,
    classification: 'ambiguous',
    last_error: lastError,
    status: 'pending',
  })
  if (insertError) {
    if (insertError.code === '23505') return false
    throw new Error(`ledger insert failed: ${insertError.message}`)
  }

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
      const { data: msg, error: msgErr } = await admin
        .from('messages')
        .select('status')
        .eq('id', row.message_id)
        .maybeSingle()

      // A failed lookup is not "the message does not exist": leave the entry
      // as it is for the next run instead of destroying it.
      if (msgErr) {
        console.error('[orphan-sweep] TTL lookup %s failed (%s): %s', row.id, msgErr.code ?? 'no code', msgErr.message)
        continue
      }

      if (!msg) {
        await admin
          .from('outbound_retry_ledger')
          .update({ status: 'dead', last_error: 'TTL expired — message not found' })
          .eq('id', row.id)
        swept++
        continue
      }

      if (msg.status === 'sending') {
        // Expiry marks a message that was never confirmed as `failed`. That is
        // the existing semantics of the TTL (ADR-E4B-002 §5 caminho D): after
        // 72 h without confirmation the intent is closed, although a provider
        // that never confirmed may have delivered it. It is not evidence of
        // delivery or of non-delivery.
        // No identities are attached, so no connection is passed: the RPC
        // parameter is a UUID and takes NULL — never ''.
        const settlement = await settleMessageSystem(admin, row.message_id, 'failed', null, [])
        if (settlement.outcome !== 'failed') {
          // 'noop': the message left `sending` meanwhile. Do not claim it was
          // resolved by the TTL; the next run reads its real status.
          console.error('[orphan-sweep] TTL settle %s returned %s, entry left for the next run', row.id, settlement.outcome)
          continue
        }
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
