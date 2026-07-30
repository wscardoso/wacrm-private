/**
 * ADR-MSG-STATUS-001 — canonical status event handler.
 *
 * Single authority for transitioning messages.status on the callback axis
 * (D11). `settle_outbound_message` (ODI-001 §5) remains the authority for
 * settling a send attempt and is not touched here.
 *
 * Pipeline per event:
 *   1. resolve externalId -> messages.id      (D10, EIS-001 §4.1/§4.3)
 *   2. read current state and direction
 *   3. evaluate against the D6 matrix
 *   4. apply under compare-and-set; on a lost CAS, re-read and re-evaluate
 *      (E2.1-RC1 §3); otherwise record a D8 signal
 */

import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { evaluateTransition, isCanonicalStatus } from '@/lib/message/status'
import { resolveMessageByExternalId } from '@/lib/message/resolve-by-external-id'
import type {
  CanonicalStatus,
  CanonicalStatusEvent,
  StatusEventSignal,
} from '@/lib/message/status'

const LOG = '[status-handler]'

/**
 * Outcomes of the handler.
 *
 * `applied` / `noop` are the two conclusions of the D6 matrix. `N1|N2|N3`
 * are the D8 signal classes.
 *
 * `unapplied` is NOT a D8 signal and does not extend D8's vocabulary: it is
 * a handler-level outcome for an event that was valid at evaluation time
 * and could not be written — contention that outlived the retry budget, or
 * a write failure. It exists because the alternative is returning `noop`,
 * which would report "nothing to do" for an event that still had something
 * to do. Every `unapplied` carries an observable record.
 */
export type StatusEventResult = 'applied' | 'noop' | 'unapplied' | StatusEventSignal

/**
 * Retry budget for a lost compare-and-set (E2.1-RC1 §3, cláusula 3).
 *
 * Three attempts. Each lost CAS means another event won the race, and each
 * win advances the message along a strictly monotonic axis of five levels
 * — so an unbounded contention loop is not a real regime, and a small
 * bound is enough to distinguish contention from pathology.
 */
export const MAX_CAS_ATTEMPTS = 3

/**
 * `messages.sender_type` values that denote an outbound message
 * (001_initial_schema.sql: CHECK IN ('customer','agent','bot')).
 *
 * ADR-MSG-001 invariante D — direction derives from `sender_type` and never
 * from status. The set is stated positively on purpose: an unexpected value
 * must fail closed, not fall through as "not customer, therefore outbound".
 */
const OUTBOUND_SENDER_TYPES: readonly string[] = ['agent', 'bot']

/**
 * D8 — record an event that did not transition.
 *
 * N1 uncorrelated · N2 inadmissible · N3 unknown provider value.
 *
 * The queryable destination is still an open decision (CHECKPOINT-E2.1
 * §8, pré-condição 5: reuse whatsapp_webhook_dlq or a dedicated surface).
 * Until that is decided, the record is a structured log line — deliberately
 * NOT a silent drop, which is what EIS-001 §8.13 forbids. Choosing the
 * table is a schema decision and is not made here.
 */
function recordSignal(
  signal: StatusEventSignal,
  detail: Record<string, unknown>,
): void {
  console.warn(`${LOG} ${signal}`, JSON.stringify(detail))
}

/**
 * Observable record for a valid event that could not be written. Same
 * destination question as `recordSignal`; same prohibition on dropping it.
 */
function recordUnapplied(reason: string, detail: Record<string, unknown>): void {
  console.warn(`${LOG} unapplied`, JSON.stringify({ reason, ...detail }))
}

/**
 * Process one canonical status event.
 *
 * I5 — callers decompose a multi-id provider event into N independent
 * calls; a failure of one must not suppress the others.
 */
export async function handleCanonicalStatusEvent(
  event: CanonicalStatusEvent,
  connectionRef: string,
): Promise<StatusEventResult> {
  const { externalId, status, timestamp } = event

  // D9/N3 — a status the adapter could not map must never reach here as a
  // guess. Defensive: if it does, record it rather than write it.
  if (!isCanonicalStatus(status)) {
    recordSignal('N3', { externalId, status, connectionRef, timestamp })
    return 'N3'
  }

  // D10 — correlation is by identity resolution, never by a direct read of
  // messages.message_id. Resolution is stable across retries: a lost CAS
  // changes the state of the message, never which message it is.
  const messageId = await resolveMessageByExternalId(connectionRef, externalId)
  if (!messageId) {
    recordSignal('N1', { externalId, status, connectionRef, timestamp })
    return 'N1'
  }

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    // 1) Current state and direction. Re-read on every attempt: after a
    //    lost CAS the previously read state is known to be stale, and
    //    concluding anything from it is exactly the B2 defect.
    const { data: current, error: readError } = await supabaseAdmin()
      .from('messages')
      .select('id, status, sender_type')
      .eq('id', messageId)
      .maybeSingle()

    if (readError || !current) {
      recordSignal('N1', {
        externalId,
        status,
        connectionRef,
        messageId,
        reason: 'resolved id no longer present',
        error: readError?.message,
      })
      return 'N1'
    }

    // 2) B1 — direction gate. Kept here, out of evaluateTransition: the
    //    matrix is a function of two status values and stays that way.
    //    Direction is a property of the row, not of the transition.
    const senderType = (current as { sender_type?: string }).sender_type
    if (!senderType || !OUTBOUND_SENDER_TYPES.includes(senderType)) {
      recordSignal('N2', {
        externalId,
        messageId,
        connectionRef,
        timestamp,
        to: status,
        senderType: senderType ?? null,
        reason: 'status event targets a non-outbound message',
      })
      return 'N2'
    }

    const currentStatus = (current.status ?? null) as CanonicalStatus | null

    // 3) D6 matrix, against the state read in THIS attempt.
    const outcome = evaluateTransition(currentStatus, status)

    if (outcome === 'noop') {
      // ⭕ expected redelivery / regression. D8 is explicit that this is NOT
      // a signal and must not be recorded.
      return 'noop'
    }

    if (outcome === 'inadmissible') {
      recordSignal('N2', {
        externalId,
        messageId,
        from: currentStatus,
        to: status,
        connectionRef,
        timestamp,
        attempt,
      })
      return 'N2'
    }

    // 4) I2 — compare-and-set. The guard on the status read a moment ago is
    //    what makes concurrent events safe: without it two events read the
    //    same state, both pass the matrix, and the slower write wins —
    //    which can regress `read` back to `delivered` and break the
    //    monotonicity the whole contract rests on.
    //
    //    NOTE: messages has no updated_at column (verified against
    //    001/009/010/048 and against the live schema); writing one fails the
    //    whole statement with PGRST204. Reintroducing it was considered and
    //    rejected — E2.1-RC1 §4.
    let update = supabaseAdmin().from('messages').update({ status }).eq('id', messageId)
    update = currentStatus === null
      ? update.is('status', null)
      : update.eq('status', currentStatus)

    const { data: updated, error: writeError } = await update.select('id')

    if (writeError) {
      recordUnapplied('write-error', {
        externalId,
        messageId,
        from: currentStatus,
        to: status,
        connectionRef,
        timestamp,
        attempt,
        error: writeError.message,
      })
      return 'unapplied'
    }

    if (updated && updated.length > 0) {
      return 'applied'
    }

    // 5) CAS lost. Another event transitioned this message between our read
    //    and our write. That says nothing about whether OUR event is still
    //    applicable — the winner may have written a level below ours. The
    //    loop re-reads and re-evaluates; concluding `noop` here is the
    //    defect B2 describes, and it loses a real `read` behind a
    //    `delivered` that merely arrived first.
  }

  // 6) Retry budget exhausted without a conclusion. I1 is not satisfied for
  //    this event, and saying so is the point: the event is never dropped
  //    in silence (E2.1-RC1 §3, cláusula 3).
  recordUnapplied('cas-exhausted', {
    externalId,
    messageId,
    to: status,
    connectionRef,
    timestamp,
    attempts: MAX_CAS_ATTEMPTS,
  })
  return 'unapplied'
}
