import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  WhatsAppProvider, SendResult,
} from '../providers/types'
import type {
  SendTextArgs, SendMediaArgs, SendTemplateArgs,
  SendReactionArgs, SendInteractiveButtonsArgs, SendInteractiveListArgs,
} from '../providers/types'
import { createIntent, settleMessage, type SettlementResult } from './settlement'
import { classifyFailure } from './failure-classifier'
import { computeBackoff, DEFAULT_BACKOFF_CONFIG } from './retry-policy'

// ── Low-level pass-through (broadcast/flow consumers) ──

export function sendText(
  provider: WhatsAppProvider,
  args: SendTextArgs,
): Promise<SendResult> {
  return provider.sendText(args)
}

export function sendMedia(
  provider: WhatsAppProvider,
  args: SendMediaArgs,
): Promise<SendResult> {
  return provider.sendMedia(args)
}

export function sendTemplate(
  provider: WhatsAppProvider,
  args: SendTemplateArgs,
): Promise<SendResult> {
  return provider.sendTemplate(args)
}

export function sendReaction(
  provider: WhatsAppProvider,
  args: SendReactionArgs,
): Promise<SendResult> {
  return provider.sendReaction(args)
}

export function sendInteractiveButtons(
  provider: WhatsAppProvider,
  args: SendInteractiveButtonsArgs,
): Promise<SendResult> {
  return provider.sendInteractiveButtons(args)
}

export function sendInteractiveList(
  provider: WhatsAppProvider,
  args: SendInteractiveListArgs,
): Promise<SendResult> {
  return provider.sendInteractiveList(args)
}

// ── Orchestration (ODI-001 §4, §5) ──
// Create intent → call provider → settle → return SettlementResult.

export interface DeliveryMeta {
  conversationId: string
  connectionRef: string
  messageId: string
}

/**
 * ADR-E4B-001 Opção A + ADR-E4B-002 (via the Failure Classifier) —
 * shared failure handling for the three orchestration functions below.
 *
 * Replaces the old "any exception settles `failed`" behavior: the
 * adapter first translates the raw error into a `SendOutcomeClass`
 * (ADR-E4B-003 §3.4), which — together with the provider's declared
 * `capabilities` (§3.1–§3.3) — the domain Failure Classifier (ARO-001
 * §7, ADR-E4B-002 §5 item 3) turns into an abstract decision. Only
 * `provider.classifySendFailure` and `provider.capabilities` are
 * consulted — never provider identity, never the raw error past this
 * point.
 *
 * - `permanent` → the one case that settles `failed`, preserving the
 *   pre-E4b behavior for a genuinely terminal outcome.
 * - `retryable` and every `ambiguous-*` decision → does **not** settle
 *   `failed`. Instead, enqueues the intent into the retry ledger
 *   (ARO-001 §7/§8.2) via `enqueue_outbound_retry`, computing the
 *   initial backoff from `retry-policy` and honouring the blocked-
 *   until-TTL path for providers without recovery capability
 *   (ADR-E4B-002 §5 item 2 / ADR-E4B-003 §3.1–§3.3).
 */
async function handleSendFailure(
  supabase: SupabaseClient,
  provider: WhatsAppProvider,
  error: unknown,
  intentId: string,
  connectionRef: string,
): Promise<SettlementResult> {
  const outcome = provider.classifySendFailure(error)
  const decision = classifyFailure(outcome, provider.capabilities)

  if (decision === 'permanent') {
    return settleMessage(supabase, intentId, 'failed', connectionRef, [])
  }

  const ledgerClassification = outcome === 'deterministic-transient'
    ? 'deterministic_transient'
    : 'ambiguous'

  const lastError = error instanceof Error ? error.message : String(error)

  const nextAttemptAt: string | null =
    decision === 'ambiguous-without-recovery-capability'
      ? null
      : new Date(Date.now() + computeBackoff(0, DEFAULT_BACKOFF_CONFIG)).toISOString()

  await supabase.rpc('enqueue_outbound_retry', {
    p_message_id: intentId,
    p_classification: ledgerClassification,
    p_next_attempt_at: nextAttemptAt,
    p_last_error: lastError,
  })

  return { messageId: intentId, outcome: 'noop' }
}

export async function deliverText(
  supabase: SupabaseClient,
  provider: WhatsAppProvider,
  sendArgs: SendTextArgs,
  meta: DeliveryMeta,
  intentOverrides?: { contentType?: string; contentText?: string | null; replyToMessageId?: string | null },
): Promise<SettlementResult> {
  const intent = await createIntent(supabase, {
    messageId: meta.messageId,
    conversationId: meta.conversationId,
    contentType: intentOverrides?.contentType ?? 'text',
    connectionRef: meta.connectionRef,
    contentText: intentOverrides?.contentText ?? null,
    replyToMessageId: intentOverrides?.replyToMessageId ?? null,
  })

  try {
    const result = await provider.sendText(sendArgs)
    return settleMessage(supabase, intent.id, 'sent', meta.connectionRef, result.externalIdentities, result.messageId)
  } catch (error) {
    return handleSendFailure(supabase, provider, error, intent.id, meta.connectionRef)
  }
}

export async function deliverMedia(
  supabase: SupabaseClient,
  provider: WhatsAppProvider,
  sendArgs: SendMediaArgs,
  meta: DeliveryMeta,
  intentOverrides?: { contentType?: string; contentText?: string | null; mediaUrl?: string | null; replyToMessageId?: string | null },
): Promise<SettlementResult> {
  const intent = await createIntent(supabase, {
    messageId: meta.messageId,
    conversationId: meta.conversationId,
    contentType: intentOverrides?.contentType ?? sendArgs.kind,
    connectionRef: meta.connectionRef,
    contentText: intentOverrides?.contentText ?? null,
    mediaUrl: intentOverrides?.mediaUrl ?? null,
    replyToMessageId: intentOverrides?.replyToMessageId ?? null,
  })

  try {
    const result = await provider.sendMedia(sendArgs)
    return settleMessage(supabase, intent.id, 'sent', meta.connectionRef, result.externalIdentities, result.messageId)
  } catch (error) {
    return handleSendFailure(supabase, provider, error, intent.id, meta.connectionRef)
  }
}

export async function deliverTemplate(
  supabase: SupabaseClient,
  provider: WhatsAppProvider,
  sendArgs: SendTemplateArgs,
  meta: DeliveryMeta,
  intentOverrides?: { contentType?: string; contentText?: string | null; replyToMessageId?: string | null },
): Promise<SettlementResult> {
  const intent = await createIntent(supabase, {
    messageId: meta.messageId,
    conversationId: meta.conversationId,
    contentType: 'template',
    connectionRef: meta.connectionRef,
    contentText: intentOverrides?.contentText ?? null,
    replyToMessageId: intentOverrides?.replyToMessageId ?? null,
  })

  try {
    const result = await provider.sendTemplate(sendArgs)
    return settleMessage(supabase, intent.id, 'sent', meta.connectionRef, result.externalIdentities, result.messageId)
  } catch (error) {
    return handleSendFailure(supabase, provider, error, intent.id, meta.connectionRef)
  }
}
