import { supabaseAdmin } from '@/lib/supabase/admin-client'

export interface ClaimedInboundTurn {
  messageId: string
  accountId: string
  contactId: string
  conversationId: string
  claimToken: string
}

export interface PersistInboundWithTurnResult {
  messageId: string
  messageInserted: boolean
  jobReady: boolean
}

/** Message + turn job in one Postgres function (091). One transaction. */
export async function persistInboundMessageWithTurn(args: {
  conversationId: string
  contentType: string
  contentText: string | null
  mediaUrl: string | null
  externalMessageId: string
  createdAt: string
  replyToMessageId: string | null
  interactiveReplyId: string | null
  accountId: string
  contactId: string
  downstreamContext: Record<string, unknown>
}): Promise<PersistInboundWithTurnResult> {
  const { data, error } = await supabaseAdmin().rpc('persist_inbound_message_with_turn', {
    p_conversation_id: args.conversationId,
    p_sender_type: 'customer',
    p_content_type: args.contentType,
    p_content_text: args.contentText,
    p_media_url: args.mediaUrl,
    p_message_id: args.externalMessageId,
    p_status: 'delivered',
    p_created_at: args.createdAt,
    p_reply_to_message_id: args.replyToMessageId,
    p_interactive_reply_id: args.interactiveReplyId,
    p_account_id: args.accountId,
    p_contact_id: args.contactId,
    p_downstream_context: args.downstreamContext,
  })
  if (error) {
    const wrapped = new Error(`persist_inbound_message_with_turn: ${error.message}`) as Error & { code?: string }
    wrapped.code = error.code
    throw wrapped
  }
  const row = (data ?? {}) as {
    message_id?: string
    message_inserted?: boolean
    job_ready?: boolean
  }
  if (!row.message_id || row.job_ready !== true) {
    throw new Error('persist_inbound_message_with_turn: durable pair not confirmed')
  }
  return {
    messageId: row.message_id,
    messageInserted: row.message_inserted === true,
    jobReady: true,
  }
}

export async function registerInboundTurnJob(args: {
  messageId: string
  accountId: string
  contactId: string
  conversationId: string
  downstreamContext?: Record<string, unknown>
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('register_inbound_turn_job', {
    p_message_id: args.messageId,
    p_account_id: args.accountId,
    p_contact_id: args.contactId,
    p_conversation_id: args.conversationId,
    p_downstream_context: args.downstreamContext ?? {},
  })
  if (error) {
    throw new Error(`register_inbound_turn_job: ${error.message}`)
  }
  return data === true
}

function mapClaimRow(row: Record<string, unknown> | undefined): ClaimedInboundTurn | null {
  if (!row?.message_id) return null
  return {
    messageId: row.message_id as string,
    accountId: row.account_id as string,
    contactId: row.contact_id as string,
    conversationId: row.conversation_id as string,
    claimToken: row.claim_token as string,
  }
}

export async function claimInboundTurnForMessage(
  messageId: string,
  lockSeconds = 300,
): Promise<ClaimedInboundTurn | null> {
  const { data, error } = await supabaseAdmin().rpc('claim_inbound_turn_for_message', {
    p_message_id: messageId,
    p_lock_seconds: lockSeconds,
  })
  if (error) {
    throw new Error(`claim_inbound_turn_for_message: ${error.message}`)
  }
  const row = Array.isArray(data) ? data[0] : data
  return mapClaimRow(row as Record<string, unknown> | undefined)
}

export async function claimInboundTurnJob(
  lockSeconds = 300,
): Promise<ClaimedInboundTurn | null> {
  const { data, error } = await supabaseAdmin().rpc('claim_inbound_turn_job', {
    p_lock_seconds: lockSeconds,
  })
  if (error) {
    throw new Error(`claim_inbound_turn_job: ${error.message}`)
  }
  const row = Array.isArray(data) ? data[0] : data
  return mapClaimRow(row as Record<string, unknown> | undefined)
}

/** Extends the lease of the current holder. false = ownership lost (088 contract). */
export async function renewInboundTurnLease(args: {
  messageId: string
  claimToken: string
  lockSeconds?: number
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('renew_inbound_turn_lease', {
    p_message_id: args.messageId,
    p_claim_token: args.claimToken,
    p_lock_seconds: args.lockSeconds ?? 300,
  })
  if (error) {
    throw new Error(`renew_inbound_turn_lease: ${error.message}`)
  }
  return data === true
}

export async function completeInboundTurnJob(args: {
  messageId: string
  claimToken: string
  success: boolean
  error?: string | null
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('complete_inbound_turn_job', {
    p_message_id: args.messageId,
    p_claim_token: args.claimToken,
    p_success: args.success,
    p_error: args.error ?? null,
  })
  if (error) {
    throw new Error(`complete_inbound_turn_job: ${error.message}`)
  }
  return data === true
}

/** staleSeconds = grace after lease expiry before a processing job is reclaimed. */
export async function reclaimStuckInboundTurnJobs(staleSeconds = 0): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('reclaim_stuck_inbound_turn_jobs', {
    p_stale_seconds: staleSeconds,
  })
  if (error) {
    throw new Error(`reclaim_stuck_inbound_turn_jobs: ${error.message}`)
  }
  return typeof data === 'number' ? data : Number(data ?? 0)
}
