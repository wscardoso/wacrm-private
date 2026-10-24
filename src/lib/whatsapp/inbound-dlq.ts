/**
 * C6.2 — capture of inbound persistence failures into whatsapp_webhook_dlq.
 *
 * CAPTURE ONLY. There is no drain, retry or replay here, and the envelope
 * stored is deliberately NOT replayable on its own (data minimisation): the
 * DLQ row is a diagnostic record, not a recovery payload. A captured failure
 * therefore does NOT recover the message — for a provider that never
 * redelivers, its permanent loss remains a risk that is accepted until a
 * future, separately authorised front (a replayable store needs a privacy
 * decision). C6.3/C6.4 own recovery.
 *
 * Since migration 094 a persistent failure is ONE pending row per
 * (account, config, source, stage, external message id): repeats raise
 * `occurrences` and `last_seen_at` instead of adding rows, and the row turns
 * 'resolved' when the message is finally stored. Failures without an external
 * id cannot be correlated and still get one row per call.
 *
 * Hard rules for this module:
 *   - it must NOT import the automations, flows or cadence engines, nor the
 *     inbound processor (enforced by inbound-dlq.test.ts) — capturing a
 *     failure can never execute a side effect;
 *   - it never stores phone, name, text, caption, filename, media refs/URLs,
 *     tokens, secrets or the raw provider payload;
 *   - it never stores a raw error message. `error_message` is built only from
 *     application-controlled tokens (source, stage, a validated SQLSTATE-like
 *     code, a validated error class name);
 *   - it never throws: the outcome is an explicit CaptureResult so each route
 *     can apply its own HTTP contract.
 */

import { supabaseAdmin } from '@/lib/supabase/admin-client'

// 'zapi' is kept deliberately: Z-API support was removed, but whatsapp_webhook_dlq
// rows captured while it existed carry that source, and the envelope/error-message
// builders must still be able to represent them. Nothing new is written with it.
export type InboundDlqSource = 'meta' | 'zapi' | 'uazapi'

/** Stages at which a real persistence step failed (processor-defined). */
export type InboundPersistenceStage = 'contact' | 'conversation' | 'message_insert'

/**
 * Failures captured BEFORE a persistence step ran, always with a proven
 * (authenticated / uniquely resolved) whatsapp_config:
 *   - `parse`          the provider adapter threw while parsing one event;
 *   - `token_decrypt`  the Meta access token could not be decrypted;
 *   - `unexpected`     any other exception thrown before the message insert.
 */
export type InboundNonPersistenceStage = 'parse' | 'token_decrypt' | 'unexpected'

export type InboundFailureStage = InboundPersistenceStage | InboundNonPersistenceStage

const DB_CODE_RE = /^[A-Z0-9_]{3,10}$/

/** Keeps only a short SQLSTATE / PostgREST-style code; anything else → null. */
export function safeDbCode(code: unknown): string | null {
  return typeof code === 'string' && DB_CODE_RE.test(code) ? code : null
}

/**
 * A real persistence step (contact, conversation or message insert) failed.
 * Carries ONLY the stage and a validated DB code — never the raw DB error,
 * whose message/details can echo user data.
 */
export class InboundPersistenceError extends Error {
  readonly stage: InboundPersistenceStage
  readonly dbCode: string | null
  constructor(stage: InboundPersistenceStage, dbCode?: unknown) {
    super(`inbound persistence failed: ${stage}`)
    this.name = 'InboundPersistenceError'
    this.stage = stage
    this.dbCode = safeDbCode(dbCode)
  }
}

/**
 * An exception thrown AFTER the message was persisted (conversation update,
 * flows, automations, cadences…). Out of C6.2 scope: it is never captured and
 * keeps the pre-C6.2 route behaviour. Wrapping it (instead of rethrowing the
 * raw error) lets the routes tell it apart from a pre-insert failure.
 */
export class InboundPostInsertError extends Error {
  readonly original: unknown
  constructor(original: unknown) {
    super('inbound post-insert failure')
    this.name = 'InboundPostInsertError'
    this.original = original
  }
}

export type InboundFailureClass =
  | { kind: 'post_insert' }
  | { kind: 'capture'; stage: InboundFailureStage; dbCode: string | null }

/** Decide whether (and at which stage) a processing error is capturable. */
export function classifyInboundFailure(err: unknown): InboundFailureClass {
  if (err instanceof InboundPostInsertError) return { kind: 'post_insert' }
  if (err instanceof InboundPersistenceError) {
    return { kind: 'capture', stage: err.stage, dbCode: err.dbCode }
  }
  return { kind: 'capture', stage: 'unexpected', dbCode: null }
}

/** Identifiers/flags of the failed event. Never content. */
export interface DlqEventInfo {
  type?: unknown
  externalMessageId?: unknown
  timestamp?: unknown
  hasMedia?: boolean
  hasContext?: boolean
}

export interface DlqEnvelope {
  v: 1
  source: InboundDlqSource
  stage: InboundFailureStage
  event_type: string
  external_message_id: string | null
  event_timestamp: string | null
  has_media: boolean
  has_context: boolean
  captured_at: string
}

const EVENT_TYPE_RE = /^[a-z_]{1,32}$/
// Provider message ids only: letters, digits and a few separators, bounded.
const MESSAGE_ID_RE = /^[A-Za-z0-9._\-=+/:]{1,200}$/
const TIMESTAMP_RE = /^\d{1,16}$/

export function buildDlqEnvelope(
  source: InboundDlqSource,
  stage: InboundFailureStage,
  event: DlqEventInfo,
  now: Date = new Date(),
): DlqEnvelope {
  const type = typeof event.type === 'string' && EVENT_TYPE_RE.test(event.type) ? event.type : 'unknown'
  const id =
    typeof event.externalMessageId === 'string' && MESSAGE_ID_RE.test(event.externalMessageId)
      ? event.externalMessageId
      : null
  const tsRaw =
    typeof event.timestamp === 'number' || typeof event.timestamp === 'string'
      ? String(event.timestamp)
      : ''
  return {
    v: 1,
    source,
    stage,
    event_type: type,
    external_message_id: id,
    event_timestamp: TIMESTAMP_RE.test(tsRaw) ? tsRaw : null,
    has_media: event.hasMedia === true,
    has_context: event.hasContext === true,
    captured_at: now.toISOString(),
  }
}

const ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/

/**
 * Application-controlled diagnostic string. The raw `err.message` is NEVER
 * used: it can contain phones, payload fragments, tokens or connection data.
 */
export function buildDlqErrorMessage(
  source: InboundDlqSource,
  stage: InboundFailureStage,
  dbCode: string | null,
  err?: unknown,
): string {
  const parts = [`source=${source}`, `stage=${stage}`, `db_code=${dbCode ?? 'none'}`]
  if (stage === 'unexpected' || stage === 'parse' || stage === 'token_decrypt') {
    const name = err instanceof Error && ERROR_NAME_RE.test(err.name) ? err.name : 'NonError'
    parts.push(`error_type=${name}`)
  }
  return parts.join(';')
}

export type CaptureResult =
  | { ok: true; dlqId: string }
  | { ok: false; reason: 'invalid_scope' | 'rpc_error' | 'rpc_exception' | 'no_id' }

export interface CaptureInput {
  /** Both ids MUST come from one validated whatsapp_config row. */
  accountId: string
  configId: string
  source: InboundDlqSource
  stage: InboundFailureStage
  error: unknown
  event: DlqEventInfo
}

/**
 * Enqueue ONE failed event (never a batch). Returns an explicit result and
 * never throws. Ownership (config belongs to account) is enforced again in
 * the database by enqueue_webhook_dlq (migration 082).
 */
export async function captureInboundFailure(input: CaptureInput): Promise<CaptureResult> {
  const { accountId, configId, source, stage, error, event } = input
  if (!accountId || !configId || typeof accountId !== 'string' || typeof configId !== 'string') {
    return { ok: false, reason: 'invalid_scope' }
  }

  const dbCode = error instanceof InboundPersistenceError ? error.dbCode : null

  try {
    const { data, error: rpcError } = await supabaseAdmin().rpc('enqueue_webhook_dlq', {
      p_account_id: accountId,
      p_whatsapp_config_id: configId,
      p_payload: buildDlqEnvelope(source, stage, event),
      p_error_message: buildDlqErrorMessage(source, stage, dbCode, error),
    })
    if (rpcError) {
      // Code only: the message of an RPC error is not guaranteed PII-free.
      console.error('[inbound-dlq] enqueue failed, rpc_code=%s', safeDbCode(rpcError.code) ?? 'none')
      return { ok: false, reason: 'rpc_error' }
    }
    if (typeof data !== 'string' || !data) {
      console.error('[inbound-dlq] enqueue returned no id')
      return { ok: false, reason: 'no_id' }
    }
    return { ok: true, dlqId: data }
  } catch {
    console.error('[inbound-dlq] enqueue threw (network/runtime)')
    return { ok: false, reason: 'rpc_exception' }
  }
}
