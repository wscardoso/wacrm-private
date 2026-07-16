/**
 * Shared inbound message processor for non-Meta providers.
 *
 * The Meta webhook route (src/app/api/whatsapp/webhook/route.ts) keeps
 * its own inline implementation to preserve full backward compatibility.
 * This module serves the new multi-provider webhook route
 * (src/app/api/whatsapp/webhook/[provider]/[webhookSecret]/route.ts),
 * which handles Z-API, uazapi, and Evolution inbound events via the
 * normalized InboundMessage interface.
 *
 * When the Meta webhook is eventually unified, this is the shared base
 * both paths will use.
 */

import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation, type ExistingContact } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import type { InboundMessage } from '@/lib/whatsapp/providers/types'

// ============================================================
// Content-type mapping
// ============================================================

const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video',
  'location', 'template', 'interactive',
])

function toContentType(msgType: InboundMessage['type']): string {
  if (ALLOWED_CONTENT_TYPES.has(msgType)) return msgType
  if (msgType === 'sticker') return 'image'
  return 'text'
}

// ============================================================
// Contact / conversation helpers
// ============================================================

type ContactRow = ExistingContact

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existing = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existing) {
    if (name && name !== existing.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { contact: existing, wasCreated: false }
  }

  const { data: newContact, error } = await supabaseAdmin()
    .from('contacts')
    .insert({ account_id: accountId, user_id: configOwnerUserId, phone, name: name || phone })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound-processor] Error creating contact:', error)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .upsert(
      { account_id: accountId, user_id: configOwnerUserId, contact_id: contactId },
      { onConflict: 'account_id, contact_id' },
    )
    .select()
    .single()

  if (error) {
    console.error('[inbound-processor] Error finding/creating conversation:', error)
    return null
  }
  return data
}

async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id)
  } catch (err) {
    console.error('[inbound-processor] flagBroadcastReplyIfAny failed:', err)
  }
}

async function lookupInternalIdByMessageId(
  messageId: string,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', messageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()

  if (error) {
    console.error('[inbound-processor] lookupInternalIdByMessageId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

async function handleReaction(
  inbound: InboundMessage,
  conversationId: string,
  contactId: string,
) {
  if (!inbound.reactionTargetMessageId) return

  const targetId = await lookupInternalIdByMessageId(
    inbound.reactionTargetMessageId,
    conversationId,
  )
  if (!targetId) {
    console.warn('[inbound-processor] reaction target not found:', inbound.reactionTargetMessageId)
    return
  }

  if (!inbound.reactionEmoji) {
    await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    return
  }

  await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: inbound.reactionEmoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    )
}

async function retryOnError<T>(
  fn: () => Promise<T>,
  opts: { label: string; retries?: number; backoffMs?: number },
): Promise<void> {
  const maxRetries = opts.retries ?? 2
  const baseMs = opts.backoffMs ?? 200
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn()
      return
    } catch (err) {
      const isLast = attempt === maxRetries
      console.error(
        `[inbound-processor] ${opts.label} failed (attempt ${attempt + 1}/${maxRetries + 1})${isLast ? ' — giving up' : ', retrying…'}`,
        err instanceof Error ? err.message : err,
      )
      if (isLast) return
      await new Promise((r) => setTimeout(r, baseMs * (attempt + 1)))
    }
  }
}

// ============================================================
// Main entry point
// ============================================================

export async function processInboundMessage(
  inbound: InboundMessage,
  accountId: string,
  configOwnerUserId: string,
): Promise<void> {
  const senderPhone = normalizePhone(inbound.from)
  const senderName = inbound.senderName ?? ''

  // 1) Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // 2) Find or create conversation
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
  )
  if (!conversation) return

  // 3) Reactions short-circuit — never insert into messages
  if (inbound.type === 'reaction') {
    await handleReaction(inbound, conversation.id, contactRecord.id)
    return
  }

  // 4) Resolve reply-to context
  let replyToInternalId: string | null = null
  if (inbound.contextMessageId) {
    replyToInternalId = await lookupInternalIdByMessageId(
      inbound.contextMessageId,
      conversation.id,
    )
  }

  // 5) Determine content fields
  const contentType = toContentType(inbound.type)

  // For media:
  //   - mediaRefIsUrl=true  → direct URL (Z-API / uazapi / Evolution)
  //   - mediaRefIsUrl=false → Meta media ID → proxy URL (not used here,
  //     but guard defensively so we never accidentally store an opaque ID)
  let mediaUrl: string | null = null
  if (inbound.mediaRef) {
    mediaUrl = inbound.mediaRefIsUrl
      ? inbound.mediaRef
      : `/api/whatsapp/media/${inbound.mediaRef}` // fallback, shouldn't happen for non-Meta
  }

  // content_text: text body, or caption for media, or interactive reply title
  let contentText: string | null = null
  if (inbound.type === 'text') {
    contentText = inbound.text ?? null
  } else if (inbound.type === 'interactive') {
    contentText = inbound.interactiveReplyTitle ?? inbound.interactiveReplyId ?? null
  } else if (inbound.caption) {
    contentText = inbound.caption
  } else if (inbound.filename) {
    contentText = inbound.filename
  }

  // 6) First-inbound flag (before INSERT)
  const { count: priorCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCount ?? 0) === 0

  // 7) Parse timestamp
  // Z-API sends momment in milliseconds; Meta sends in seconds.
  // Detect by magnitude: if > 1e12 it's already ms, otherwise treat as seconds.
  const tsNum = Number(inbound.timestamp)
  const createdAt = isNaN(tsNum)
    ? new Date().toISOString()
    : new Date(tsNum > 1e12 ? tsNum : tsNum * 1000).toISOString()

  // 8) Insert message
  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: inbound.messageId,
    status: 'delivered',
    created_at: createdAt,
    reply_to_message_id: replyToInternalId,
    interactive_reply_id:
      inbound.type === 'interactive' ? (inbound.interactiveReplyId ?? null) : null,
  })

  if (msgError) {
    console.error('[inbound-processor] Error inserting message:', msgError)
    return
  }

  // 9) Update conversation
  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${inbound.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // 10) Flag broadcast reply
  await flagBroadcastReplyIfAny(accountId, contactRecord.id)

  // 11) Dispatch flows
  const inboundText = contentText ?? ''
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      inbound.type === 'interactive' && inbound.interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: inbound.interactiveReplyId,
            reply_title: inboundText,
            meta_message_id: inbound.messageId,
          }
        : {
            kind: 'text',
            text: inboundText,
            meta_message_id: inbound.messageId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // 12) Dispatch automations
  const triggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) triggers.push('new_message_received', 'keyword_match')
  if (contactOutcome.wasCreated) triggers.unshift('new_contact_created')
  if (isFirstInboundMessage) triggers.unshift('first_inbound_message')

  for (const triggerType of triggers) {
    retryOnError(
      () =>
        runAutomationsForTrigger({
          accountId,
          triggerType,
          contactId: contactRecord.id,
          context: { message_text: inboundText, conversation_id: conversation.id },
        }),
      { label: `automation:${triggerType}` },
    ).catch((err) => {
      console.error('[inbound-processor] automation trigger unhandled:', err)
    })
  }
}
