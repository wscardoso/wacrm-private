import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExternalIdentity } from '../providers/types'

// ── Mode-1 (E2.0) — create message already settled with identities ──

export interface CreateOutboundMessageArgs {
  conversationId: string
  contentType: string
  providerMessageId: string
  connectionRef: string
  externalIdentities: ExternalIdentity[]
  contentText?: string | null
  mediaUrl?: string | null
  templateName?: string | null
  replyToMessageId?: string | null
}

export interface CreatedMessage {
  id: string
}

export async function createOutboundMessage(
  supabase: SupabaseClient,
  args: CreateOutboundMessageArgs,
): Promise<CreatedMessage> {
  const externalIdentities = args.externalIdentities ?? []
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: args.conversationId,
      sender_type: 'agent',
      content_type: args.contentType,
      content_text: args.contentText ?? null,
      media_url: args.mediaUrl ?? null,
      template_name: args.templateName ?? null,
      message_id: args.providerMessageId,
      status: 'sent',
      reply_to_message_id: args.replyToMessageId ?? null,
    })
    .select('id')
    .single()

  if (error) throw error

  if (externalIdentities.length > 0) {
    const rows = externalIdentities.map(ei => ({
      message_id: data.id,
      connection_ref: args.connectionRef,
      kind: ei.kind,
      value: ei.value,
    }))
    const { error: idErr } = await supabase.rpc('insert_message_external_ids', {
      p_identities: rows,
    })
    if (idErr) throw idErr
  }

  return { id: data.id }
}

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
  connectionRef: string
  contentText?: string | null
  mediaUrl?: string | null
  templateName?: string | null
  replyToMessageId?: string | null
}

export async function createIntent(
  supabase: SupabaseClient,
  args: CreateIntentArgs,
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      id: args.messageId,
      conversation_id: args.conversationId,
      sender_type: 'agent',
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

  const { data, error } = await supabase.rpc('settle_outbound_message_system', {
    p_message_id: messageId,
    p_status: status,
    p_connection_ref: connectionRef,
    p_provider_message_id: providerMessageId ?? null,
    p_identities: rows,
  })

  if (error) throw error
  return parseSettlementResult(data)
}
