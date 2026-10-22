import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExternalIdentity } from '../providers/types'
import { bindingFromConnection, type ConnectionIdentityRow } from './connection-binding'

// ── Mode-2 (E4a / ODI-001) — create intent → send → settle ──

export type SettlementOutcome = 'sent' | 'failed' | 'noop'

export interface SettlementResult {
  messageId: string
  outcome: SettlementOutcome
}

/**
 * Commit 6.1 correção #2 — settle_outbound_message* (migration 050)
 * retorna `jsonb`, não `TEXT`. supabase-js/PostgREST desserializa jsonb
 * automaticamente em objeto JS antes de chegar aqui; `JSON.parse` sobre
 * um objeto já desserializado lança `TypeError`. Este helper aceita
 * ambos os formatos — string (contrato antigo/alguns drivers) ou
 * objeto já desserializado (contrato atual) — para que a camada de
 * aplicação não fique acoplada a um comportamento de driver específico.
 */
function parseSettlementResult(data: unknown): SettlementResult {
  if (typeof data === 'string') {
    return JSON.parse(data) as SettlementResult
  }
  return data as SettlementResult
}

export interface CreateIntentArgs {
  messageId: string
  conversationId: string
  contentType: string
  /**
   * The `whatsapp_config` row the message will be sent through. The delivery
   * binding (connection_ref, delivery_provider, delivery_channel_fp) is derived
   * from it HERE, so that it is written in the same INSERT as the message and
   * no caller composes it by hand. Throws `DeliveryBindingError` — before
   * anything is inserted — when the row cannot identify a channel.
   */
  connection: ConnectionIdentityRow
  /** `agent` (a person, via the inbox) or `bot` (Flows / Automations). */
  senderType?: 'agent' | 'bot'
  contentText?: string | null
  mediaUrl?: string | null
  templateName?: string | null
  replyToMessageId?: string | null
}

/**
 * THE one place that creates an outbound message (DLB-001 §3, ODI-001 §4):
 * the intent exists, with its idempotency key and its delivery binding, before
 * any provider call. `src/test/outbound-message-creation.arch.test.ts` fails
 * the build if another direct INSERT into `messages` appears.
 */
export async function createIntent(
  supabase: SupabaseClient,
  args: CreateIntentArgs,
): Promise<{ id: string }> {
  const binding = bindingFromConnection(args.connection)
  const { data, error } = await supabase
    .from('messages')
    .insert({
      id: args.messageId,
      conversation_id: args.conversationId,
      sender_type: args.senderType ?? 'agent',
      connection_ref: binding.connection_ref,
      delivery_provider: binding.delivery_provider,
      delivery_channel_fp: binding.delivery_channel_fp,
      content_type: args.contentType,
      content_text: args.contentText ?? null,
      media_url: args.mediaUrl ?? null,
      template_name: args.templateName ?? null,
      status: 'sending',
      idempotency_key: args.messageId,
      reply_to_message_id: args.replyToMessageId ?? null,
    })
    .select('id')
    .single()

  if (error) throw error
  return { id: data.id }
}

/**
 * An identity with an empty value identifies nothing and, worse, would occupy
 * the unique slot (connection_ref, kind, '') so that the next message of the
 * connection fails to settle. Never hand one to the database.
 */
function nonBlankIdentities(externalIdentities: ExternalIdentity[] | undefined): ExternalIdentity[] {
  return (externalIdentities ?? []).filter(ei => typeof ei.value === 'string' && ei.value.trim() !== '')
}

export async function settleMessage(
  supabase: SupabaseClient,
  messageId: string,
  status: 'sent' | 'failed',
  connectionRef: string,
  externalIdentities: ExternalIdentity[],
  providerMessageId?: string,
): Promise<SettlementResult> {
  const identities = nonBlankIdentities(externalIdentities)
  const rows = identities.map(ei => ({
    message_id: messageId,
    connection_ref: connectionRef,
    kind: ei.kind,
    value: ei.value,
  }))

  const { data, error } = await supabase.rpc('settle_outbound_message', {
    p_message_id: messageId,
    p_status: status,
    p_connection_ref: connectionRef,
    p_provider_message_id: providerMessageId ?? null,
    p_identities: rows,
  })

  if (error) throw error
  return parseSettlementResult(data)
}

export interface AcceptedSendSettlement {
  settlement: SettlementResult
  /**
   * true when the provider accepted the message but the database settlement
   * could not be completed. The message row is still `sending`; the provider
   * id is in the reconciliation record (outbound_retry_ledger.last_error and
   * the structured `ACCEPTED_SETTLE_PENDING` log line).
   */
  pending: boolean
}

export interface SettleAcceptedSendArgs {
  messageId: string
  connectionRef: string
  externalIdentities: ExternalIdentity[]
  providerMessageId: string
  /** Facade to use: `authenticated` (user session) or `system` (service role). */
  actor?: 'authenticated' | 'system'
}

/**
 * Settle a message the provider has ALREADY ACCEPTED (it returned an id).
 *
 * From that moment a database error is not a send failure: the message is
 * out of our hands, so it must never be routed through `handleSendFailure`
 * (which would classify it, enqueue it as a retryable/ambiguous send and let
 * the caller answer 502 — inviting a resend of a message that was probably
 * delivered). This helper instead:
 *
 *   1. settles `sent`;
 *   2. on failure tries once more — without the external identities when
 *      there are any (a transient error is retried as is by the CAS inside the
 *      RPC; a failure caused by recording the identities, e.g. a unique
 *      violation, still leaves the message `sent` with its `message_id`);
 *   3. if that fails too, writes a reconciliation record that names the
 *      provider id (blocked ledger entry: `next_attempt_at NULL`, never
 *      picked by the retry cron) plus a structured log line, and returns
 *      `pending: true` so the caller can answer "accepted, settlement
 *      pending" instead of an error.
 *
 * Never throws.
 */
export async function settleAcceptedSend(
  supabase: SupabaseClient,
  args: SettleAcceptedSendArgs,
): Promise<AcceptedSendSettlement> {
  const settle = args.actor === 'system' ? settleMessageSystem : settleMessage
  const identities = args.externalIdentities ?? []

  let firstError: unknown
  try {
    const settlement = await settle(
      supabase, args.messageId, 'sent', args.connectionRef, identities, args.providerMessageId,
    )
    return { settlement, pending: false }
  } catch (err) {
    firstError = err
  }

  let lastError: unknown = firstError
  try {
    const settlement = await settle(
      supabase, args.messageId, 'sent', args.connectionRef, [], args.providerMessageId,
    )
    console.warn(
      '[whatsapp/settle] settled sent on the second attempt',
      JSON.stringify({
        messageId: args.messageId,
        providerMessageId: args.providerMessageId,
        withoutIdentities: identities.length > 0,
        firstError: describeError(firstError),
      }),
    )
    return { settlement, pending: false }
  } catch (err) {
    lastError = err
  }

  const detail = {
    messageId: args.messageId,
    connectionRef: args.connectionRef,
    providerMessageId: args.providerMessageId,
    error: describeError(lastError),
  }
  console.error('[whatsapp/settle] ACCEPTED_SETTLE_PENDING', JSON.stringify(detail))

  try {
    const enqueueRpc = args.actor === 'system' ? 'enqueue_outbound_retry_system' : 'enqueue_outbound_retry'
    const enqueued = await supabase.rpc(enqueueRpc, {
      p_message_id: args.messageId,
      p_classification: 'ambiguous',
      // NULL: the retry cron selects only entries with a due next_attempt_at,
      // so this record can never trigger a re-send of an accepted message.
      p_next_attempt_at: null,
      p_last_error: `ACCEPTED_BY_PROVIDER provider_message_id=${args.providerMessageId}; settlement failed: ${detail.error}`.slice(0, 500),
    })
    if (enqueued?.error) {
      console.error('[whatsapp/settle] could not write the reconciliation record:', describeError(enqueued.error))
    }
  } catch (err) {
    console.error('[whatsapp/settle] could not write the reconciliation record:', describeError(err))
  }

  return { settlement: { messageId: args.messageId, outcome: 'noop' }, pending: true }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return String(err)
}

/**
 * Settle via `settle_outbound_message_system` (service-role facade).
 *
 * Same contract as `settleMessage` but calls the system facade
 * (ADR-SYS-001) that skips the auth‑check — intended for background
 * workers (scheduler, orphan sweeper) that run as service_role.
 */
export async function settleMessageSystem(
  supabase: SupabaseClient,
  messageId: string,
  status: 'sent' | 'failed',
  /**
   * The connection the identities belong to, or `null` when there is none
   * (e.g. the TTL sweep settling `failed` has no identities to attach).
   * `p_connection_ref` is a UUID: it must never receive `''` — PostgreSQL
   * rejects it, which used to make every TTL settlement fail.
   */
  connectionRef: string | null,
  externalIdentities: ExternalIdentity[],
  providerMessageId?: string,
): Promise<SettlementResult> {
  const identities = nonBlankIdentities(externalIdentities)
  if (identities.length > 0 && !connectionRef) {
    throw new Error('settleMessageSystem: identities require a connectionRef')
  }
  const rows = identities.map(ei => ({
    message_id: messageId,
    connection_ref: connectionRef,
    kind: ei.kind,
    value: ei.value,
  }))

  const { data, error } = await supabase.rpc('settle_outbound_message_system', {
    p_message_id: messageId,
    p_status: status,
    p_connection_ref: connectionRef || null,
    p_provider_message_id: providerMessageId ?? null,
    p_identities: rows,
  })

  if (error) throw error
  return parseSettlementResult(data)
}
