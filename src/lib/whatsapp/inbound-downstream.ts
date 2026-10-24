import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { runAutomationsForTrigger, cancelPendingCadencesForContact } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchNativeAgentForInbound } from '@/lib/agent/dispatch'
import { registerInboundTurnJob } from '@/lib/agent/turn/substrate'

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
    console.error('[inbound-downstream] flagBroadcastReplyIfAny failed:', err)
  }
}

export interface InboundDownstreamContext {
  configOwnerUserId: string
  accountId: string
  contactId: string
  conversationId: string
  isFirstInboundMessage: boolean
  contactWasCreated: boolean
  inboundText: string
  inboundType: string
  externalMessageId: string
  interactiveReplyId?: string | null
  lastMessagePreview: string
  /**
   * @deprecated No longer read. The unread counter is incremented atomically in the
   * database (apply_inbound_message_to_conversation, 093) instead of being derived
   * from a snapshot taken at persist time. Kept optional so jobs queued before 093
   * and test fixtures that still carry it keep working.
   */
  unreadCountBefore?: number
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
        `[inbound-downstream] ${opts.label} failed (attempt ${attempt + 1}/${maxRetries + 1})${isLast ? ' — giving up' : ', retrying…'}`,
        err instanceof Error ? err.message : err,
      )
      if (isLast) return
      await new Promise((r) => setTimeout(r, baseMs * (attempt + 1)))
    }
  }
}

export async function registerTurnAfterPersist(
  messageId: string,
  ctx: InboundDownstreamContext,
): Promise<void> {
  await registerInboundTurnJob({
    messageId,
    accountId: ctx.accountId,
    contactId: ctx.contactId,
    conversationId: ctx.conversationId,
    downstreamContext: ctx as unknown as Record<string, unknown>,
  })
}

export type AutomationTriggerType =
  | 'new_contact_created'
  | 'first_inbound_message'
  | 'new_message_received'
  | 'keyword_match'

export function buildAutomationTriggers(args: {
  ctx: InboundDownstreamContext
  flowConsumed: boolean
  agentConsumed: boolean
}): AutomationTriggerType[] {
  const triggers: AutomationTriggerType[] = []
  const suppressContent = args.flowConsumed || args.agentConsumed
  if (!suppressContent) triggers.push('new_message_received', 'keyword_match')
  if (args.ctx.contactWasCreated) triggers.unshift('new_contact_created')
  if (args.ctx.isFirstInboundMessage) triggers.unshift('first_inbound_message')
  return triggers
}

export async function runInboundDownstreamFromContext(
  ctx: InboundDownstreamContext,
  inboundMessageId: string,
): Promise<void> {
  await flagBroadcastReplyIfAny(ctx.accountId, ctx.contactId)

  // Exactly once per message, atomic, and order-safe (093): a retried turn does not
  // count the message twice and a message that runs after a newer one leaves the
  // preview alone. A failure throws, so the job is retried.
  const { error: conversationError } = await supabaseAdmin().rpc('apply_inbound_message_to_conversation', {
    p_message_id: inboundMessageId,
    p_preview: ctx.lastMessagePreview,
  })
  if (conversationError) {
    throw new Error(`apply_inbound_message_to_conversation: ${conversationError.message}`)
  }

  const flowResult = await dispatchInboundToFlows({
    accountId: ctx.accountId,
    userId: ctx.configOwnerUserId,
    contactId: ctx.contactId,
    conversationId: ctx.conversationId,
    message:
      ctx.inboundType === 'interactive' && ctx.interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: ctx.interactiveReplyId,
            reply_title: ctx.inboundText,
            meta_message_id: ctx.externalMessageId,
          }
        : {
            kind: 'text',
            text: ctx.inboundText,
            meta_message_id: ctx.externalMessageId,
          },
    isFirstInboundMessage: ctx.isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const agentResult = await dispatchNativeAgentForInbound({
    ctx,
    inboundMessageId,
    flowConsumed,
  })

  const triggers = buildAutomationTriggers({
    ctx,
    flowConsumed,
    agentConsumed: agentResult.agentConsumed,
  })

  try {
    await cancelPendingCadencesForContact(ctx.accountId, ctx.contactId)
  } catch (err) {
    console.error('[inbound-downstream] cancelPendingCadencesForContact error:', err)
  }

  for (const triggerType of triggers) {
    retryOnError(
      () =>
        runAutomationsForTrigger({
          accountId: ctx.accountId,
          triggerType,
          contactId: ctx.contactId,
          context: { message_text: ctx.inboundText, conversation_id: ctx.conversationId },
        }),
      { label: `automation:${triggerType}` },
    ).catch((err) => {
      console.error('[inbound-downstream] automation trigger unhandled:', err)
    })
  }
}

export async function runInboundDownstreamForMessage(messageId: string): Promise<void> {
  const { data: job, error } = await supabaseAdmin()
    .from('inbound_turn_jobs')
    .select('downstream_context')
    .eq('message_id', messageId)
    .maybeSingle()

  if (error) {
    throw new Error(`load inbound_turn_jobs: ${error.message}`)
  }
  if (!job?.downstream_context) {
    throw new Error(`missing downstream_context for message ${messageId}`)
  }

  const ctx = job.downstream_context as InboundDownstreamContext
  await runInboundDownstreamFromContext(ctx, messageId)
}
