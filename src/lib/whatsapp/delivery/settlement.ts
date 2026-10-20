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

export async function settleMessage(
  supabase: SupabaseClient,
  messageId: string,
  status: 'sent' | 'failed',
  connectionRef: string,
  externalIdentities: ExternalIdentity[],
  providerMessageId?: string,
): Promise<SettlementResult> {
  const identities = externalIdentities ?? []
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
  const identities = externalIdentities ?? []
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
