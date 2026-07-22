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
 *   `failed`. The intent stays exactly as `createIntent` left it:
 *   `sending`. No RPC call happens here — `settle_outbound_message`
 *   (048) is not invoked, so no transition occurs at all, which is why
 *   `outcome: 'noop'` (ODI-001 §5.1: no transition took place) is the
 *   honest description below, not a new state and not an invented
 *   queue mechanism.
 *
 * Enqueueing into the retry ledger, capability-gated reconciliation
 * (ADR-E4B-002 §5), and the blocked-until-TTL path for
 * `ambiguous-without-recovery-capability` are ARO-001 §11/§12/§16 —
 * a later commit, not this one. This function only reaches the
 * decision and stops; it is the "prepared point" the plan calls for.
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

  // retryable | ambiguous-with-native-idempotency |
  // ambiguous-with-reconciliation | ambiguous-without-recovery-capability
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
