/**
 * Shared inbound message processor for non-Meta providers.
 *
 * The Meta webhook route (src/app/api/whatsapp/webhook/route.ts) keeps
 * its own inline implementation to preserve full backward compatibility.
 * This module serves the new multi-provider webhook route
 * (src/app/api/whatsapp/webhook/[provider]/[webhookSecret]/route.ts),
 * which handles uazapi and Evolution inbound events via the
 * normalized InboundMessage interface.
 *
 * When the Meta webhook is eventually unified, this is the shared base
 * both paths will use.
 */

import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation, type ExistingContact } from '@/lib/contacts/dedupe'
import { type InboundDownstreamContext } from '@/lib/whatsapp/inbound-downstream'
import { processInboundTurnForMessage } from '@/lib/agent/turn/process-message-turn'
import { persistInboundMessageWithTurn } from '@/lib/agent/turn/substrate'
import type { InboundMessage } from '@/lib/whatsapp/providers/types'
import { InboundPersistenceError, InboundPostInsertError } from '@/lib/whatsapp/inbound-dlq'

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
    // Keep only the SQLSTATE (validated in InboundPersistenceError), never the
    // raw DB error, so the capture can record a safe code (C6.2).
    throw new InboundPersistenceError('contact', error.code)
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
    throw new InboundPersistenceError('conversation', error.code)
  }
  return data
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

// ============================================================
// Main entry point
// ============================================================

type InboundCoreState = {
  persisted: boolean
  insertedMessageId?: string
  skipped?: boolean
  duplicate?: boolean
}

async function processInboundMessageCore(
  inbound: InboundMessage,
  accountId: string,
  configOwnerUserId: string,
  state: InboundCoreState,
  phase: InboundPersistPhase,
): Promise<void> {
  // D-C (ADR-MSG-STATUS-001 §2.6): a provider callback that is not a
  // customer message (an unrecognised status callback, a presence event…)
  // still reaches this point carrying a phone. With no recognisable content
  // AND no external id it cannot be deduplicated or correlated, and would
  // otherwise create a contact, a conversation and a phantom customer
  // message with message_id ''. Dropped before any write; the payload is
  // deliberately not logged (it carries a phone number).
  if (inbound.type === 'unknown' && !inbound.messageId) {
    console.warn('[inbound-processor] D-C: dropped non-message callback (type=unknown, no messageId)')
    state.skipped = true
    return
  }

  const senderPhone = normalizePhone(inbound.from)
  const senderName = inbound.senderName ?? ''

  // 1) Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName,
  )
  if (!contactOutcome) throw new InboundPersistenceError('contact')
  const contactRecord = contactOutcome.contact

  // 2) Find or create conversation
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
  )
  if (!conversation) throw new InboundPersistenceError('conversation')

  // 3) Reactions short-circuit — never insert into messages
  if (inbound.type === 'reaction') {
    await handleReaction(inbound, conversation.id, contactRecord.id)
    state.skipped = true
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
  //   - mediaRefIsUrl=true  → direct URL (uazapi / Evolution)
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
  // Some non-Meta providers send milliseconds; Meta sends seconds.
  // Detect by magnitude: if > 1e12 it's already ms, otherwise treat as seconds.
  const tsNum = Number(inbound.timestamp)
  const createdAt = isNaN(tsNum)
    ? new Date().toISOString()
    : new Date(tsNum > 1e12 ? tsNum : tsNum * 1000).toISOString()

  // Message + turn job commit in one function (091). A duplicate with no job
  // recovers the job here; a duplicate that already has a job does not insert
  // another row and does not re-run downstream.
  const inboundText = contentText ?? ''
  const downstreamCtx: InboundDownstreamContext = {
    configOwnerUserId,
    accountId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    isFirstInboundMessage,
    contactWasCreated: contactOutcome.wasCreated,
    inboundText,
    inboundType: inbound.type,
    externalMessageId: inbound.messageId,
    interactiveReplyId:
      inbound.type === 'interactive' ? (inbound.interactiveReplyId ?? null) : null,
    lastMessagePreview: contentText || `[${inbound.type}]`,
  }

  let durable: { messageId: string; messageInserted: boolean }
  try {
    durable = await persistInboundMessageWithTurn({
      conversationId: conversation.id,
      contentType,
      contentText,
      mediaUrl,
      externalMessageId: inbound.messageId,
      createdAt,
      replyToMessageId: replyToInternalId,
      interactiveReplyId:
        inbound.type === 'interactive' ? (inbound.interactiveReplyId ?? null) : null,
      accountId,
      contactId: contactRecord.id,
      downstreamContext: downstreamCtx as unknown as Record<string, unknown>,
    })
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : undefined
    console.error('[inbound-processor] Error persisting message with turn:', err)
    throw new InboundPersistenceError('message_insert', code)
  }

  state.persisted = true
  state.insertedMessageId = durable.messageId

  if (!durable.messageInserted) {
    state.duplicate = true
    console.log(
      '[inbound-processor] Duplicate inbound (message_id=%s) — job ensured, skipping downstream effects',
      inbound.messageId,
    )
    return
  }

  if (phase === 'full') {
    await processInboundTurnForMessage(state.insertedMessageId)
  }
}

export type InboundPersistPhase = 'full' | 'persist_only'

/**
 * Throws InboundPersistenceError when contact, conversation or the message
 * insert FAILS (C6.2). Post-persist failures wrap InboundPostInsertError.
 */

/**
 * Persist inbound + durable turn registration (Q10 minimum before ACK).
 * When `phase` is persist_only, downstream is deferred to the turn worker.
 */
export async function persistInboundMessage(
  inbound: InboundMessage,
  accountId: string,
  configOwnerUserId: string,
  phase: InboundPersistPhase = 'full',
): Promise<{ messageId: string } | 'duplicate' | 'skipped'> {
  const state: InboundCoreState = { persisted: false }
  await processInboundMessageCore(inbound, accountId, configOwnerUserId, state, phase)
  if (state.skipped) return 'skipped'
  if (!state.persisted || !state.insertedMessageId) return 'duplicate'
  if (state.duplicate) return 'duplicate'
  return { messageId: state.insertedMessageId }
}

export async function processInboundMessage(
  inbound: InboundMessage,
  accountId: string,
  configOwnerUserId: string,
  opts?: { deferDownstream?: boolean },
): Promise<void> {
  const state: InboundCoreState = { persisted: false }
  try {
    await processInboundMessageCore(
      inbound,
      accountId,
      configOwnerUserId,
      state,
      opts?.deferDownstream ? 'persist_only' : 'full',
    )
  } catch (err) {
    if (state.persisted) throw new InboundPostInsertError(err)
    throw err
  }
}
