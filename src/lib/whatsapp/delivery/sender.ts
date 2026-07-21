import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  WhatsAppProvider, SendResult,
} from '../providers/types'
import type {
  SendTextArgs, SendMediaArgs, SendTemplateArgs,
  SendReactionArgs, SendInteractiveButtonsArgs, SendInteractiveListArgs,
} from '../providers/types'
import { createIntent, settleMessage, type SettlementResult } from './settlement'

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
  } catch {
    return settleMessage(supabase, intent.id, 'failed', meta.connectionRef, [])
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
  } catch {
    return settleMessage(supabase, intent.id, 'failed', meta.connectionRef, [])
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
  } catch {
    return settleMessage(supabase, intent.id, 'failed', meta.connectionRef, [])
  }
}
