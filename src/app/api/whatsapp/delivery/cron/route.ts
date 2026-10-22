import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getProvider, providerConfigFromRow, type WhatsAppProvider } from '@/lib/whatsapp/providers'
import type { SendResult } from '@/lib/whatsapp/providers/types'
import { decryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { settleMessageSystem, type SettlementResult } from '@/lib/whatsapp/delivery/settlement'
import { evaluateBinding } from '@/lib/whatsapp/delivery/connection-binding'
import { classifyFailure } from '@/lib/whatsapp/delivery/failure-classifier'
import { decideRetryOutcome, DEFAULT_BACKOFF_CONFIG, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT } from '@/lib/whatsapp/delivery/retry-policy'
import { resolveSignedMediaUrl, MEDIA_SIGNED_URL_TTL_SECONDS } from '@/lib/storage/resolve-media-url'

const BATCH_LIMIT = 50

/**
 * ARO-001 §12 — Drain due outbound retry ledger entries.
 *
 * Auth: `AUTOMATION_CRON_SECRET` + `x-cron-secret` (timingSafeEqual,
 * same pattern as flows/cron). Service-role throughout.
 *
 * Flow per entry:
 *   1. Claim-as-lock (status pending → retrying)
 *   2. Reconstruct message, contact, provider
 *   3. Call provider.send
 *   4. settleMessageSystem + update ledger (delivered / dead / re-enqueue)
 *
 * Two invariants hold for every exit of an entry:
 *
 *   - The message is only re-sent while it is STILL `sending` (its status is
 *     read with the message; the settlement compare-and-set is the final
 *     arbiter). A message that left `sending` — settled by the original
 *     sender, failed by the TTL — closes the ledger entry in agreement with
 *     the message and sends nothing.
 *   - A ledger entry is never `dead` while its message is `sending`. Nothing
 *     else resolves that pair (the orphan sweep skips messages that have a
 *     ledger row; the TTL reads only `pending` rows), so it would stay
 *     `sending` forever. `dead` is written only after the message itself was
 *     settled `failed` (system facade, compare-and-set), and that is done only
 *     with proof of non-delivery. Without proof the entry is BLOCKED
 *     (`pending`, `next_attempt_at NULL`) and the 72 h TTL settles both
 *     (ADR-E4B-002 §5 caminho D). A failed or unexpected step never turns
 *     into `dead` on its own.
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

  const limit = checkRateLimit('cron:whatsapp-delivery', RATE_LIMITS.cronDrain)
  if (!limit.success) return rateLimitResponse(limit)

  const admin = supabaseAdmin()

  const { data: due, error } = await admin
    .from('outbound_retry_ledger')
    .select('id, message_id, attempt_count, classification, created_at')
    .eq('status', 'pending')
    .not('next_attempt_at', 'is', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    console.error('[delivery-cron] select due failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!due || due.length === 0) return NextResponse.json({ processed: 0, dead: 0 })

  let processed = 0
  let dead = 0

  for (const row of due) {
    try {
      const result = await processDueEntry(admin, row)
      if (result === 'processed') processed++
      if (result === 'dead') dead++
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error('[delivery-cron] entry %s fatal:', row.id, detail)
      // Where the exception came from is unknown here (before the send, or
      // after the provider accepted it), so it proves nothing about delivery:
      // not `dead` (the message would stay `sending` for ever) and not
      // re-sendable. Blocked, the TTL resolves it. The status guard keeps this
      // from overwriting a row another worker already moved on.
      await admin
        .from('outbound_retry_ledger')
        .update({
          status: 'pending',
          next_attempt_at: null,
          last_error: `blocked (scheduler_fatal_error): ${detail.slice(0, 200)} (delivery state unknown, resolved only by TTL)`.slice(0, 500),
        })
        .eq('id', row.id)
        .eq('status', 'retrying')
    }
  }

  return NextResponse.json({ processed, dead })
}

type DrainResult = 'processed' | 'dead' | 'skipped'

type QueryError = { code?: string; message?: string }

/** PostgREST `.single()` with zero rows. The only lookup error that means "absent". */
function isNoRowsError(err: QueryError): boolean {
  return err.code === 'PGRST116'
}

/**
 * A lookup failed for a reason that says nothing about the message or the
 * connection (incompatible schema, permissions, network…). The entry was
 * claimed (`retrying`); give it back as `pending`, keeping its due
 * `next_attempt_at`, with an explicit reason. Nothing is sent, settled or
 * dead-lettered. The status guard keeps this from overwriting a row another
 * worker already moved on; if this update itself fails, the stuck-`retrying`
 * reclaim of the orphan sweep returns the entry to `pending` later.
 */
async function releaseAfterQueryError(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string },
  what: string,
  err: QueryError,
): Promise<DrainResult> {
  const detail = `${what} failed (${err.code ?? 'no code'}): ${(err.message ?? 'unknown').slice(0, 200)}`
  console.error('[delivery-cron] entry %s %s — not dead-lettered, will be retried', row.id, detail)
  const { error: releaseError } = await admin
    .from('outbound_retry_ledger')
    .update({ status: 'pending', last_error: `${detail} — not dead-lettered` })
    .eq('id', row.id)
    .eq('status', 'retrying')
  if (releaseError) {
    console.error('[delivery-cron] entry %s release failed (stuck-retrying reclaim will recover it): %s', row.id, releaseError.message)
  }
  return 'skipped'
}

/**
 * The entry cannot be re-sent safely: keep it for a human / the TTL, with the
 * reason in `last_error`. Same shape as ADR-E4B-002 §5 caminho D (`pending`,
 * `next_attempt_at NULL`, never selected again). The message is not touched
 * and nothing is sent. Never `dead`: an unprovable identity is not a verdict
 * on the message.
 */
async function blockEntry(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string },
  reason: string,
  detail: string,
): Promise<DrainResult> {
  await admin
    .from('outbound_retry_ledger')
    .update({
      status: 'pending',
      next_attempt_at: null,
      last_error: `blocked (${reason}): ${detail}`.slice(0, 500),
    })
    .eq('id', row.id)
  return 'processed'
}

/**
 * Returns the claimed entry to `pending`, due time kept, so the next run looks
 * at it again. Used when the state of the MESSAGE changed under this run or a
 * step failed for a reason that is not a verdict on it.
 */
async function releaseForRecheck(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string },
  detail: string,
): Promise<DrainResult> {
  await admin
    .from('outbound_retry_ledger')
    .update({ status: 'pending', last_error: detail.slice(0, 500) })
    .eq('id', row.id)
    .eq('status', 'retrying')
  return 'skipped'
}

/**
 * The message is no longer `sending` (the original sender settled it, the TTL
 * failed it…): the message is the source of truth (ARO-001 §10). Nothing is
 * re-sent and nothing is settled; the entry is closed in agreement with it.
 * `delivered` here means "the intent ended `sent`", not "this entry's send
 * settled it" — no send happened. Any state this module does not recognise is
 * blocked, never closed and never destroyed.
 */
async function closeForResolvedMessage(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string },
  status: string | null | undefined,
): Promise<DrainResult> {
  if (status === 'sent' || status === 'delivered' || status === 'read') {
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'delivered', last_error: `message already ${status} — nothing re-sent` })
      .eq('id', row.id)
    return 'processed'
  }
  if (status === 'failed') {
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: 'message already failed — nothing re-sent' })
      .eq('id', row.id)
    return 'dead'
  }
  return blockEntry(admin, row, 'message_not_sending', `message status is "${status ?? 'unknown'}", not "sending"`)
}

/**
 * The entry can never be sent (no recipient, content the cron cannot rebuild).
 * The ledger may only go `dead` together with the message going `failed`:
 * that is settled first (system facade, compare-and-set) and only when the
 * ledger carries proof that no earlier attempt was delivered
 * (`deterministic_transient`, emitted by the adapter). An `ambiguous` entry
 * may already have been delivered, so it is blocked for the TTL instead —
 * the same treatment as every other entry that cannot be re-sent.
 */
async function failUnsendable(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string; classification: string },
  msgId: string,
  reason: string,
): Promise<DrainResult> {
  if (row.classification !== 'deterministic_transient') {
    return blockEntry(admin, row, 'unsendable_without_proof_of_non_delivery', reason)
  }

  let settlement: SettlementResult
  try {
    settlement = await settleMessageSystem(admin, msgId, 'failed', null, [])
  } catch (err) {
    // The message is still `sending`: the entry must not die. Retried next run.
    return releaseAfterQueryError(admin, row, 'failing the unsendable message', err as QueryError)
  }
  if (settlement.outcome !== 'failed') {
    // `noop`: the message left `sending` meanwhile. Do not claim anything;
    // the next run reads its real status and closes the entry accordingly.
    return releaseForRecheck(admin, row, `${reason} — message left "sending" meanwhile, re-checked on the next run`)
  }

  await admin
    .from('outbound_retry_ledger')
    .update({ status: 'dead', last_error: reason })
    .eq('id', row.id)
  return 'dead'
}

async function processDueEntry(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string; message_id: string; attempt_count: number; classification: string; created_at: string },
): Promise<DrainResult> {
  // ── 1. Claim-as-lock ───────────────────────────────────────
  const { data: claim } = await admin
    .from('outbound_retry_ledger')
    .update({ status: 'retrying' })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (!claim) return 'skipped'

  // ── 2. Load message + conversation + contact + provider config ──
  const { data: msg, error: msgErr } = await admin
    .from('messages')
    .select('id, status, conversation_id, content_type, content_text, media_url, template_name, reply_to_message_id, connection_ref, delivery_provider, delivery_channel_fp, created_at')
    .eq('id', row.message_id)
    .single()

  // Only "the row is not there" is a reason to dead-letter. Any other failure
  // of the lookup (an incompatible schema such as a missing column, a
  // permission problem, a network error) says nothing about the message, so
  // the entry is released unchanged instead of being destroyed.
  if (msgErr && !isNoRowsError(msgErr)) {
    return releaseAfterQueryError(admin, row, 'message lookup', msgErr)
  }
  if (msgErr || !msg) {
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: `message not found: ${msgErr?.message ?? 'unknown'}` })
      .eq('id', row.id)
    return 'dead'
  }

  // The message must STILL be `sending`. The ledger row is only a record of
  // the process; the message is the fact (ARO-001 §10). Read together with the
  // message; the settlement compare-and-set remains the final arbiter if it
  // changes between this read and the settle.
  if (msg.status !== 'sending') {
    return closeForResolvedMessage(admin, row, msg.status as string | null | undefined)
  }

  const { data: conv, error: convErr } = await admin
    .from('conversations')
    .select('account_id, contact:contacts(phone)')
    .eq('id', msg.conversation_id)
    .single()

  // Same rule as the message lookup: a failed query is not "no recipient".
  if (convErr && !isNoRowsError(convErr)) {
    return releaseAfterQueryError(admin, row, 'conversation lookup', convErr)
  }

  const phone = (conv as { contact: { phone: string } | null } | null)?.contact?.phone
  if (!phone) {
    return failUnsendable(admin, row, msg.id, 'contact phone not found')
  }
  const to = sanitizePhoneForMeta(phone)

  // ── 2b. Delivery identity gate ─────────────────────────────
  // A message is re-sent only when the connection that exists NOW is provably
  // the channel it was created for (provider + WhatsApp number / uazapi
  // instance, recorded in the same INSERT that created it) and belongs to the
  // conversation's own account. `whatsapp_config` rows are edited in place, so
  // the id alone proves nothing. Anything unprovable is BLOCKED — ledger entry
  // `pending`, `next_attempt_at NULL`, explicit reason, message untouched —
  // never sent through another channel and never `dead`.
  const stored = {
    connection_ref: msg.connection_ref as string | null | undefined,
    delivery_provider: msg.delivery_provider as string | null | undefined,
    delivery_channel_fp: msg.delivery_channel_fp as string | null | undefined,
  }
  const conversationAccountId = (conv as { account_id?: string | null } | null)?.account_id ?? null

  const unrecorded = evaluateBinding({ stored, conversationAccountId, connection: null })
  if (!unrecorded.ok && (unrecorded.reason === 'binding_missing' || unrecorded.reason === 'binding_invalid')) {
    return blockEntry(admin, row, unrecorded.reason, unrecorded.detail)
  }

  const connectionRef = stored.connection_ref as string
  const { data: wc, error: wcErr } = await admin
    .from('whatsapp_config')
    .select('*')
    .eq('id', connectionRef)
    .maybeSingle()

  // A failed lookup says nothing about the connection (see releaseAfterQueryError);
  // a row that is really absent is `connection_removed`, decided below.
  if (wcErr) {
    return releaseAfterQueryError(admin, row, 'provider config lookup', wcErr)
  }

  const verdict = evaluateBinding({ stored, conversationAccountId, connection: wc ?? null })
  if (!verdict.ok) {
    return blockEntry(admin, row, verdict.reason, verdict.detail)
  }

  const bc = whatsappConfigBindingContext(wc.account_id)
  const accessToken = decryptWithBindingContext(wc.access_token, bc)
  // The verdict already proved the provider is supported and unchanged.
  const provider: WhatsAppProvider = getProvider(providerConfigFromRow(wc, accessToken))

  // Evidence that re-sending is safe. `deterministic_transient` is recorded by
  // the adapter of THE SAME provider (proved above) only when it is certain the
  // attempt was not accepted; `nativeIdempotency` would make a duplicate
  // harmless. Neither current provider declares the latter, and every
  // ambiguous outcome stays blocked (ADR-E4B-002 §5 caminho D).
  if (row.classification !== 'deterministic_transient' && !provider.capabilities.nativeIdempotency) {
    return blockEntry(
      admin,
      row,
      'no_evidence_of_non_delivery',
      `ledger classification is "${row.classification}" and ${verdict.provider} declares no native idempotency`,
    )
  }

  // ── 2c. Content the cron can rebuild ───────────────────────
  // Decided before anything is attempted, so it can never be confused with a
  // send outcome (Flows `interactive`, for one, has nothing to rebuild from).
  const contentType = msg.content_type
  if (!['text', 'image', 'video', 'document', 'audio', 'template'].includes(contentType)) {
    return failUnsendable(admin, row, msg.id, `unsupported content_type: ${contentType}`)
  }

  // ── 3. Resolve context (reply-to) ──────────────────────────
  const replyToId = msg.reply_to_message_id
  let contextMessageId: string | undefined
  if (replyToId) {
    const { data: parent } = await admin
      .from('messages')
      .select('message_id')
      .eq('id', replyToId)
      .maybeSingle()
    if (parent?.message_id) contextMessageId = parent.message_id
  }

  // ── 4. Re-execute delivery ─────────────────────────────────
  const msgId = msg.id
  let sendResult: SendResult
  try {
    if (contentType === 'text') {
      sendResult = await provider.sendText({ to, text: msg.content_text ?? '', contextMessageId })
    } else if (['image', 'video', 'document', 'audio'].includes(contentType)) {
      // S2 (plans/001-private-media-buckets-s2.md): msg.media_url is the
      // OLD permanent public bucket URL shape — chat-media / flow-media
      // are private post-migration-076. Resolve a short-lived signed URL
      // right before re-attempting the send; `admin` is service-role, so
      // it bypasses Storage RLS the same way it bypasses every other RLS
      // check in this trusted background job. Passes through unchanged
      // for a URL that isn't recognizably one of our buckets. A failure
      // here (e.g. the object no longer exists) is caught below and
      // routed through the same retry/dead-letter classification as any
      // other send failure.
      const resolvedMediaUrl = await resolveSignedMediaUrl(admin, msg.media_url ?? '', MEDIA_SIGNED_URL_TTL_SECONDS)
      sendResult = await provider.sendMedia({
        to,
        kind: contentType as 'image' | 'video' | 'document' | 'audio',
        link: resolvedMediaUrl,
        caption: msg.content_text ?? undefined,
        contextMessageId,
      })
    } else {
      // 'template' — the only type left after the 2c check
      sendResult = await provider.sendTemplate({
        to,
        templateName: msg.template_name ?? '',
        contextMessageId,
      })
    }
  } catch (sendErr) {
    return handleRetryFailure(admin, row, provider, sendErr, msgId, connectionRef)
  }

  // ── 5. Success — settle via system facade ──────────────────
  let settlement: SettlementResult
  try {
    settlement = await settleMessageSystem(
      admin, msgId, 'sent', connectionRef,
      sendResult.externalIdentities, sendResult.messageId,
    )
  } catch (settleErr) {
    // The provider ACCEPTED the send; only recording it failed. The message may
    // well have been delivered, and it is still `sending`. That is ambiguous:
    // not `dead` (limbo), not `failed` (could be a lie to the operator), not
    // re-sendable (duplicate). Blocked, with the provider id so a human can
    // reconcile; the TTL closes it (ADR-E4B-002 §5 caminho D, same accepted
    // outcome as any unconfirmed send).
    const detail = settleErr instanceof Error ? settleErr.message : String(settleErr)
    console.error('[delivery-cron] entry %s settle after accepted send failed:', row.id, detail)
    return blockEntry(
      admin,
      row,
      'settle_failed_after_send',
      `provider accepted the send (id ${sendResult.messageId}) but settlement failed: ${detail.slice(0, 200)} (delivery state unknown, never re-sent, resolved only by TTL)`,
    )
  }

  if (settlement.outcome === 'sent') {
    await admin.from('outbound_retry_ledger').update({ status: 'delivered' }).eq('id', row.id)
    return 'processed'
  }

  // `noop`: the provider accepted THIS send, but the message had already left
  // `sending` (settled by someone else after the status read). This send did
  // not settle it, so it is not `delivered` by it, and the provider id could
  // not be recorded. An accepted send that is not on the message is a possible
  // duplicate: surfaced for an operator, not hidden as a success.
  await admin
    .from('outbound_retry_ledger')
    .update({
      status: 'dead',
      last_error: `settle ${settlement.outcome}: message left "sending" before this send was settled; provider accepted it (id ${sendResult.messageId}), not recorded on the message — possible duplicate`.slice(0, 500),
    })
    .eq('id', row.id)
  return 'dead'
}

async function handleRetryFailure(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string; message_id: string; attempt_count: number; classification: string; created_at: string },
  provider: WhatsAppProvider,
  error: unknown,
  msgId: string,
  connectionRef: string,
): Promise<DrainResult> {
  const outcome = provider.classifySendFailure(error)
  const decision = classifyFailure(outcome, provider.capabilities)
  const lastError = error instanceof Error ? error.message : String(error)

  // Commit 6.1 correção #3 — a decisão completa (permanent → settle-
  // failed; ambiguous sem nenhuma capability de recuperação → bloqueado,
  // nunca reagendado às cegas; TTL/teto de tentativas → settle-failed;
  // caso contrário → reagendar) vem de `decideRetryOutcome`, a mesma
  // política reusada do caminho síncrono (sender.ts) e do orphan
  // sweeper — nenhuma regra nova, nenhuma duplicação.
  const action = decideRetryOutcome(
    decision,
    row.attempt_count,
    new Date(row.created_at),
    DEFAULT_TTL_MS,
    MAX_ATTEMPT_COUNT,
    DEFAULT_BACKOFF_CONFIG,
  )

  if (action.kind === 'settle-failed') {
    // A throw here propagates to the run's fatal handler, which blocks the
    // entry: the message is still `sending`, so the ledger must not die.
    const settlement = await settleMessageSystem(admin, msgId, 'failed', connectionRef, [])
    if (settlement.outcome !== 'failed') {
      // `noop`: the message left `sending` meanwhile — the next run reads its
      // real status and closes the entry accordingly.
      return releaseForRecheck(admin, row, `${lastError} — message left "sending" meanwhile, re-checked on the next run`)
    }
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: lastError })
      .eq('id', row.id)
    return 'dead'
  }

  if (action.kind === 'blocked') {
    // ADR-E4B-002 §5 caminho D: ambiguous + nativeIdempotency=false +
    // deliveryReconciliation=false nunca é reenviado às cegas. A
    // mensagem permanece `sending`, o ledger permanece `pending` mas
    // sem próxima tentativa agendada — só o TTL sweep (orphan-sweep
    // route) a resolve.
    await admin
      .from('outbound_retry_ledger')
      .update({
        status: 'pending',
        attempt_count: action.attemptCount,
        next_attempt_at: null,
        last_error: `${lastError} (blocked — no recovery capability)`,
      })
      .eq('id', row.id)
    return 'processed'
  }

  // action.kind === 'reschedule'
  await admin
    .from('outbound_retry_ledger')
    .update({
      status: 'pending',
      attempt_count: action.attemptCount,
      next_attempt_at: action.nextAttemptAt.toISOString(),
      last_error: lastError,
    })
    .eq('id', row.id)

  return 'processed'
}
