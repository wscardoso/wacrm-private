import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import {
  encrypt,
  isLegacyFormat,
  decryptWithBindingContext,
  encryptWithBindingContext,
} from '@/lib/whatsapp/encryption'
import {
  whatsappConfigBindingContext,
  isWhatsappConfigCanonicalWriteEnabled,
} from '@/lib/whatsapp/config-binding'
import { needsKidConvergence, getCurrentWriteKid } from '@/lib/crypto/kidConvergence'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation, type ExistingContact } from '@/lib/contacts/dedupe'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { type InboundDownstreamContext } from '@/lib/whatsapp/inbound-downstream'
import { processInboundTurnForMessage } from '@/lib/agent/turn/process-message-turn'
import { drainInboundTurnJobs } from '@/lib/agent/turn/drain'
import { persistInboundMessageWithTurn } from '@/lib/agent/turn/substrate'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { persistAttribution } from '@/lib/whatsapp/attribution'
import {
  InboundPersistenceError,
  captureInboundFailure,
  classifyInboundFailure,
  type DlqEventInfo,
} from '@/lib/whatsapp/inbound-dlq'
import type { Referral } from '@/types'

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
  /**
   * Set by Meta on the message that opened a Click-to-WhatsApp (CTWA)
   * conversation — i.e. the customer tapped a WhatsApp CTA on an ad or
   * post. Absent on ordinary replies. Drives lead attribution
   * (ADR-ATTR-001) — see `@/lib/whatsapp/attribution`.
   */
  referral?: Referral
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const rlVerify = checkRateLimit(`webhook:verify:${ip}`, RATE_LIMITS.webhookVerify)
  if (!rlVerify.success) return rateLimitResponse(rlVerify)

  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, account_id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        const bc = whatsappConfigBindingContext(config.account_id)
        if (decryptWithBindingContext(config.verify_token, bc) === verifyToken) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget upgrade. Safe to run on every subscribe since
      // it's a no-op once the column is already in the target format.
      // Canonical (BC-aware) once the domain's write-enablement flag is
      // on; GCM upgrade otherwise — preserves legacy compatibility
      // until the atomic cutover for this domain is fully live.
      //
      // Also converges a canonical envelope still under a prior write
      // KID (IMP-E7-001 Phase 4, ADR-E7-001 §13.2 — lazy convergence):
      // re-running encryptWithBindingContext with the already-decrypted
      // plaintext and the SAME Binding Context always targets the
      // Key Ring's current write KID, so no separate re-encryption path
      // is needed for this case.
      const canonicalWriteEnabled = isWhatsappConfigCanonicalWriteEnabled()
      const staleKid =
        !isLegacyFormat(matchedConfig.verify_token) &&
        canonicalWriteEnabled &&
        needsKidConvergence(matchedConfig.verify_token, getCurrentWriteKid())
      if (isLegacyFormat(matchedConfig.verify_token) || staleKid) {
        const upgraded = canonicalWriteEnabled
          ? encryptWithBindingContext(verifyToken, whatsappConfigBindingContext(matchedConfig.account_id))
          : encrypt(verifyToken)
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: upgraded })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error,
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
const MAX_WEBHOOK_BODY_BYTES = 512 * 1024 // 512 KB

export async function POST(request: Request) {
  // Reject oversized payloads before reading the body. Meta webhooks
  // are JSON event envelopes -- even batched deliveries stay well under
  // 512 KB. A larger body is almost certainly abuse or misconfiguration.
  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()

  // Belt-and-braces: also check actual body size in case Content-Length
  // was absent or spoofed (chunked transfer encoding omits the header).
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Rate-limit per phone_number_id -- the stable identifier Meta sends.
  // Applied after signature check (only signed requests consume quota)
  // and after JSON parse (so we can read the field without re-parsing).
  const phoneNumberId =
    body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id ?? 'unknown'
  const rlInbound = checkRateLimit(
    `webhook:inbound:${phoneNumberId}`,
    RATE_LIMITS.webhookInbound,
  )
  if (!rlInbound.success) {
    // Return 429 -- Meta retries with exponential back-off,
    // so no messages are permanently dropped.
    return rateLimitResponse(rlInbound)
  }

  // H6: 200 only after each inbound message has a durable message+job pair.
  // DLQ capture is diagnostic and does not by itself authorize 200.
  let incomplete = 0
  let persistThrew = false
  try {
    incomplete = await processWebhook(body, 'persist')
  } catch (error) {
    persistThrew = true
    console.error('Error persisting webhook before ack:', error)
  }

  if (persistThrew || incomplete > 0) {
    // Whatever did become durable is executed now: a stored message must not wait for
    // the provider to redeliver (some never do). Statuses and template events are left
    // for the delivery that gets acknowledged; the redelivery of this payload handles
    // them, and its persist pass finds the stored messages as duplicates.
    runInboundTurns(body, 'turns')
    return NextResponse.json({ error: 'Inbound persistence incomplete' }, { status: 500 })
  }

  runInboundTurns(body, 'execute')

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

/** Identifiers/flags of a Meta message for the DLQ envelope. Never content. */
function metaEventInfo(message: WhatsAppMessage): DlqEventInfo {
  return {
    type: message.type,
    externalMessageId: message.id,
    timestamp: message.timestamp,
    hasMedia: !!(
      message.image || message.video || message.document ||
      message.audio || message.sticker
    ),
    hasContext: !!message.context?.id,
  }
}

/**
 * persist  inbound messages only: make each one durable (message + turn job)
 * turns    inbound messages only: run the turn of every message that is durable
 * execute  everything the acknowledged delivery owes: statuses, template events, turns
 * full     persist and run inline (kept for callers that need the single-pass behaviour)
 */
type MetaWebhookPass = 'persist' | 'turns' | 'execute' | 'full'

/**
 * Fire-and-forget after the response. The turn of each message of the payload runs in
 * payload order (inline claim); jobs the per-contact queue held back (an older message
 * of the same contact was still pending), jobs of other deliveries and expired leases
 * are then taken by the drain, so nothing waits for the cron or for a redelivery.
 */
function runInboundTurns(body: { entry?: WhatsAppWebhookEntry[] }, pass: 'turns' | 'execute') {
  processWebhook(body, pass)
    .catch((error) => {
      console.error('Error executing inbound turns:', error)
    })
    .then(() => drainInboundTurnJobs())
    .catch((error) => {
      console.error('Error draining inbound turns:', error)
    })
}

async function processWebhook(
  body: { entry?: WhatsAppWebhookEntry[] },
  pass: MetaWebhookPass = 'full',
): Promise<number> {
  let incomplete = 0
  if (!body.entry) return incomplete

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplateWebhookField(change.field)) {
        if (pass === 'execute' || pass === 'full') {
          await handleTemplateWebhookChange(
            { field: change.field, value: change.value as unknown },
            supabaseAdmin(),
          )
        }
        continue
      }

      const value = change.value

      // Handle status updates (deferred to execute pass — Q10 persist is inbound-only)
      if (value.statuses && (pass === 'execute' || pass === 'full')) {
        for (const status of value.statuses) {
          // Per-item isolation (F-INT-02, E2E validation): the route
          // already returns 200 to Meta before this runs (fire-and-
          // forget below), so an uncaught throw here would silently
          // drop every status/message after it in this batch — Meta
          // considers the whole delivery acknowledged and never
          // redelivers. One bad status must not take the rest down.
          try {
            await handleStatusUpdate(status)
          } catch (err) {
            console.error('Error processing status update:', status.id, err)
          }
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        // For a uazapi row `phone_number_id` holds the instance NAME (a
        // user-chosen string sharing the column, and its UNIQUE index, with
        // Meta ids). A signed Meta event must only ever resolve a Meta row.
        .eq('provider', 'meta')

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map((r: { account_id: string; user_id: string }) => `${r.account_id} (admin ${r.user_id})`)
        )
        continue
      }

      const config = configRows[0]

      // C6.2 — a token that cannot be decrypted used to reject the whole
      // processWebhook() run, silently dropping every remaining message of the
      // delivery (already 200-acked). The config here is proven (single row,
      // resolved by phone_number_id), so each affected message is captured
      // individually; the loop then moves on to the next change/entry.
      let decryptedAccessToken: string
      try {
        decryptedAccessToken = decryptWithBindingContext(
          config.access_token,
          whatsappConfigBindingContext(config.account_id),
        )
      } catch (err) {
        // Error CLASS only: decrypt errors are not guaranteed free of key/ciphertext material.
        console.error(
          'Failed to decrypt whatsapp_config access token (config_id=%s, error_type=%s)',
          config.id,
          err instanceof Error ? err.name : 'NonError',
        )
        // Only the pass that makes messages durable reports this: the later passes
        // would count and capture the same failure a second time.
        if (pass !== 'persist' && pass !== 'full') continue
        for (const message of value.messages) {
          incomplete++
          const capture = await captureInboundFailure({
            accountId: config.account_id,
            configId: config.id,
            source: 'meta',
            stage: 'token_decrypt',
            error: err,
            event: metaEventInfo(message),
          })
          if (!capture.ok) {
            console.error(
              'Inbound failure NOT captured in DLQ (message lost), reason=%s stage=%s',
              capture.reason,
              'token_decrypt',
            )
          }
        }
        continue
      }

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        // Per-item isolation (F-INT-02, E2E validation) — same
        // rationale as the status-update loop above: this batch is
        // already 200-acked to Meta, so one message throwing must not
        // take the rest of this batch (or subsequent changes/entries
        // in the same delivery) down with it.
        const state = { persisted: false }
        try {
          await processMessage(
            message,
            contact,
            // Tenancy — drives every contact / conversation lookup
            // and the engines' active-row dispatch.
            config.account_id,
            // Audit / sender-of-record — used as the user_id on row
            // inserts that need it for NOT NULL FK compliance. Always
            // the admin who saved the WhatsApp config.
            config.user_id,
            decryptedAccessToken,
            state,
            pass === 'full' ? 'full' : pass,
          )
        } catch (err) {
          // C6.2 — failure capture (diagnostic only; no replay/retry/drain).
          // A failure AFTER the message was persisted keeps its pre-C6.2
          // behaviour: logged, not captured.
          if (state.persisted) {
            console.error('Error processing inbound message AFTER persist (not captured):', message.id, err)
            continue
          }
          incomplete++
          const failure = classifyInboundFailure(err)
          if (failure.kind === 'post_insert') continue
          if (failure.stage === 'unexpected') {
            // Original log line, unchanged (an existing test pins it).
            console.error('Error processing inbound message:', message.id, err)
          } else {
            console.error('Inbound persistence failure, stage=%s', failure.stage)
          }
          // account_id and id come from the single, uniquely-resolved
          // whatsapp_config row above (configRows.length === 1). One DLQ
          // row per message — never the whole Meta batch.
          const capture = await captureInboundFailure({
            accountId: config.account_id,
            configId: config.id,
            source: 'meta',
            stage: failure.stage,
            error: err,
            event: metaEventInfo(message),
          })
          if (!capture.ok) {
            // Meta already received its 200 — there is no redelivery lever
            // here, so the loss is surfaced loudly in the logs instead.
            console.error(
              'Inbound failure NOT captured in DLQ (message lost), reason=%s stage=%s',
              capture.reason,
              failure.stage,
            )
          }
        }
      }
    }
  }
  return incomplete
}

// The happy-path status ladder — pending → sent → delivered → read →
// replied. Webhook replays must never regress a recipient back down
// this ladder.
//
// `failed` is NOT on this ladder. It's a terminal side branch that is
// only valid from the early states (pending / sent) — once Meta has
// delivered or the user has read or replied, a later "failed" status
// event is a bug in Meta's pipeline or a spoof attempt and must be
// ignored.
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const

function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s)
  return idx < 0 ? -1 : idx
}

/**
 * Can a recipient transition from `current` to `incoming`?
 *   - Along the ladder, only forward moves are allowed.
 *   - `failed` is accepted only from `pending` or `sent`; it's refused
 *     once the recipient has reached any of the success states.
 */
function isValidStatusTransition(current: string, incoming: string): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent'
  }
  if (current === 'failed') {
    return false // failed is terminal
  }
  const ci = ladderLevel(current)
  const ii = ladderLevel(incoming)
  if (ii < 0) return false // unknown incoming status
  if (ci < 0) return true // unknown current — accept anything on the ladder
  return ii > ci
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // 1) Mirror onto messages (legacy behavior) — Meta's status values
  //    already match the CHECK constraint on messages.status. Guarded
  //    by the same forward-only ladder as broadcast_recipients below:
  //    Meta retries/reorders webhooks, and a delayed `delivered` (or a
  //    replayed `sent`/spurious `failed`) arriving after `read` must
  //    not regress the ticks shown in the inbox.
  const { data: currentMsg, error: msgFetchErr } = await supabaseAdmin()
    .from('messages')
    .select('id, status')
    .eq('message_id', status.id)
    .maybeSingle()

  if (msgFetchErr) {
    console.error('Error fetching message for status update:', msgFetchErr)
  } else if (
    currentMsg &&
    isValidStatusTransition(currentMsg.status, status.status)
  ) {
    const { error: msgErr } = await supabaseAdmin()
      .from('messages')
      .update({ status: status.status })
      .eq('id', currentMsg.id)

    if (msgErr) {
      console.error('Error updating message status:', msgErr)
    }
  }

  // 2) Mirror onto broadcast_recipients via whatsapp_message_id
  //    (added in migration 003). The aggregate trigger on
  //    broadcast_recipients re-derives the parent broadcast's
  //    sent/delivered/read/failed counts automatically.
  const tsIso = new Date(parseInt(status.timestamp) * 1000).toISOString()

  const { data: recipient, error: recFetchErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', status.id)
    .maybeSingle()

  if (recFetchErr) {
    console.error('Error fetching broadcast recipient:', recFetchErr)
    return
  }
  if (!recipient) return // message wasn't part of a broadcast — fine

  // Guard transitions — forward-only on the success ladder, and
  // `failed` only from pre-delivered states.
  if (!isValidStatusTransition(recipient.status, status.status)) return

  const update: Record<string, unknown> = { status: status.status }
  if (status.status === 'sent' && !('sent_at' in update)) update.sent_at = tsIso
  if (status.status === 'delivered') update.delivered_at = tsIso
  if (status.status === 'read') update.read_at = tsIso

  const { error: recUpdateErr } = await supabaseAdmin()
    .from('broadcast_recipients')
    .update(update)
    .eq('id', recipient.id)

  if (recUpdateErr) {
    console.error('Error updating broadcast recipient status:', recUpdateErr)
  }
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

async function resolveInternalCustomerMessageId(
  accountId: string,
  externalMessageId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', externalMessageId)
    .eq('sender_type', 'customer')
    .eq('conversations.account_id', accountId)
    .maybeSingle()

  if (error) {
    console.error('[webhook] resolveInternalCustomerMessageId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
  // Set to true once the inbound message row is persisted, so the caller can
  // tell a pre-insert failure (capturable, C6.2) from a post-insert one.
  state: { persisted: boolean },
  pass: MetaWebhookPass = 'full',
) {
  if (pass === 'execute' || pass === 'turns') {
    const internalId = await resolveInternalCustomerMessageId(accountId, message.id)
    if (internalId) {
      try {
        await processInboundTurnForMessage(internalId)
      } catch (err) {
        console.error('Error executing inbound turn:', message.id, err)
      }
    }
    return
  }
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) throw new InboundPersistenceError('contact')
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  )
  if (!conversation) throw new InboundPersistenceError('conversation')

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const inboundText = contentText ?? message.text?.body ?? ''
  const downstreamCtx: InboundDownstreamContext = {
    configOwnerUserId,
    accountId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    isFirstInboundMessage,
    contactWasCreated: contactOutcome.wasCreated,
    inboundText,
    inboundType: message.type,
    externalMessageId: message.id,
    interactiveReplyId,
    lastMessagePreview: contentText || `[${message.type}]`,
  }

  // 091: message row and turn job in one transaction. Duplicate without a job
  // recovers the job; duplicate with a job does not insert a second one.
  let durable: { messageId: string; messageInserted: boolean }
  try {
    durable = await persistInboundMessageWithTurn({
      conversationId: conversation.id,
      contentType,
      contentText,
      mediaUrl,
      externalMessageId: message.id,
      createdAt: new Date(parseInt(message.timestamp) * 1000).toISOString(),
      replyToMessageId: replyToInternalId,
      interactiveReplyId,
      accountId,
      contactId: contactRecord.id,
      downstreamContext: downstreamCtx as unknown as Record<string, unknown>,
    })
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : undefined
    console.error('Error persisting inbound message with turn:', err)
    throw new InboundPersistenceError('message_insert', code)
  }

  state.persisted = true

  if (!durable.messageInserted) {
    console.log(
      'Duplicate inbound (message_id=%s) — job ensured, skipping downstream effects',
      message.id,
    )
    return
  }

  if (message.referral) {
    try {
      await persistAttribution(supabaseAdmin(), {
        accountId,
        contactId: contactRecord.id,
        conversationId: conversation.id,
        messageId: message.id,
        referral: message.referral,
      })
    } catch (err) {
      console.error('[webhook] persistAttribution failed:', err)
    }
  }

  if (pass !== 'persist') {
    await processInboundTurnForMessage(durable.messageId)
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (
    mediaId: string
  ): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

type ContactRow = ExistingContact

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies strict
  // identity (`phonesMatchStrict`) in JS on the small candidate set —
  // a loose last-8-digit match alone would risk attaching this
  // message to an unrelated contact from a different country/area
  // code. The same helper backs the manual contact form and CSV
  // import, so all three paths agree on what "same number" means
  // (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone,
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    // SQLSTATE only (validated), never the raw DB error — see C6.2 capture.
    throw new InboundPersistenceError('contact', createError.code)
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  // Single upsert, no separate SELECT. The unique index on
  // (account_id, contact_id) handles the conflict; the DO UPDATE
  // branch fires the set_updated_at trigger (harmless — the caller
  // overwrites updated_at right after).
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .upsert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    }, {
      onConflict: 'account_id, contact_id',
    })
    .select()
    .single()

  if (error) {
    console.error('Error finding/creating conversation:', error)
    throw new InboundPersistenceError('conversation', error.code)
  }

  return data
}
