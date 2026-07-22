import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendText, sendMedia, sendTemplate, handleSendFailure } from '@/lib/whatsapp/delivery/sender'
import { createIntent, settleMessage } from '@/lib/whatsapp/delivery/settlement'
import type { SettlementResult } from '@/lib/whatsapp/delivery/settlement'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import type { MessageTemplate } from '@/types'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { getProvider, type WhatsAppProvider, type ExternalIdentity, ProviderUnsupportedError } from '@/lib/whatsapp/providers'

type MediaKind = 'image' | 'video' | 'document' | 'audio'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_config, message_templates) is account-
    // scoped post-multi-user, so the previous `user_id` filters
    // returned nothing for teammates who didn't author the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Guard against oversized requests before parsing JSON
    const contentLength = request.headers.get('content-length')
    if (contentLength) {
      const maxBytes = 5 * 1024 * 1024 // 5MB
      if (parseInt(contentLength, 10) > maxBytes) {
        return NextResponse.json(
          { error: 'Request body too large' },
          { status: 413 },
        )
      }
    }

    const body = await request.json()
    const {
      conversation_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
    } = body

    if (!conversation_id || !message_type) {
      return NextResponse.json(
        { error: 'conversation_id and message_type are required' },
        { status: 400 }
      )
    }

    // Media kinds (image/video/document/audio) are sent to Meta via a
    // public URL the composer already uploaded to the chat-media bucket.
    const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const
    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(message_type)

    // Reject anything outside the known set up front rather than letting
    // an unknown type fall through to the text path with empty content.
    const VALID_MESSAGE_TYPES = ['text', 'template', ...MEDIA_KINDS] as const
    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(message_type)) {
      return NextResponse.json(
        { error: `Unsupported message_type "${message_type}"` },
        { status: 400 }
      )
    }

    if (message_type === 'text' && !content_text) {
      return NextResponse.json(
        { error: 'content_text is required for text messages' },
        { status: 400 }
      )
    }

    if (message_type === 'template' && !template_name) {
      return NextResponse.json(
        { error: 'template_name is required for template messages' },
        { status: 400 }
      )
    }

    if (isMediaKind && !media_url) {
      return NextResponse.json(
        { error: `media_url is required for ${message_type} messages` },
        { status: 400 }
      )
    }

    // Meta caps media captions at 1024 chars; reject before the upload is
    // wasted at the Meta call. (Audio carries no caption — see meta-api.)
    if (
      isMediaKind &&
      message_type !== 'audio' &&
      typeof content_text === 'string' &&
      content_text.length > 1024
    ) {
      return NextResponse.json(
        { error: 'Caption exceeds the 1024-character limit' },
        { status: 400 }
      )
    }

    // Fetch conversation and contact
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('*, contact:contacts(*)')
      .eq('id', conversation_id)
      .eq('account_id', accountId)
      .single()

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    const contact = conversation.contact
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 }
      )
    }

    // Sanitize and validate phone
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Self-heal legacy CBC-encrypted tokens. Fire-and-forget: we
    // return from the send without waiting, so a failed upgrade just
    // means the next send tries again. The upgrade is idempotent —
    // concurrent sends both produce valid GCM ciphertexts of the same
    // plaintext, last write wins.
    if (isLegacyFormat(config.access_token)) {
      void supabase
        .from('whatsapp_config')
        .update({ access_token: encrypt(accessToken) })
        .eq('id', config.id)
        .then(({ error }) => {
          if (error) {
            console.warn(
              '[whatsapp/send] access_token GCM upgrade failed:',
              error.message,
            )
          }
        })
    }

    // Resolve the reply target (if any) to its Meta message_id, which is
    // what `context.message_id` on the outgoing Meta payload needs. The
    // parent must belong to this same conversation — otherwise a caller
    // could quote messages they can't see by guessing UUIDs.
    let contextMessageId: string | undefined
    if (reply_to_message_id) {
      const { data: parent, error: parentError } = await supabase
        .from('messages')
        .select('message_id, conversation_id')
        .eq('id', reply_to_message_id)
        .eq('conversation_id', conversation_id)
        .maybeSingle()

      if (parentError || !parent) {
        return NextResponse.json(
          { error: 'reply_to_message_id not found in this conversation' },
          { status: 400 }
        )
      }
      if (!parent.message_id) {
        // Parent never reached Meta (still in 'sending' or 'failed') — we
        // can't quote it on WhatsApp. Send without context rather than
        // dropping the message entirely.
        console.warn(
          '[whatsapp/send] reply target has no Meta message_id; sending without context'
        )
      } else {
        contextMessageId = parent.message_id
      }
    }

    // ── Provider dispatch (ADR-MSG-001/D3.b) ──────────────────────────────
    // Unified creation via getProvider — sole dispatch authority.
    let provider: WhatsAppProvider
    try {
      let clientToken: string | undefined
      if (config.provider === 'zapi' && config.waba_id) {
        try { clientToken = decrypt(config.waba_id) } catch { /* ignore */ }
      }
      provider = getProvider(
        config.provider === 'zapi'
          ? { provider: 'zapi', instanceId: config.instance_id, accessToken, clientToken }
          : config.provider === 'uazapi'
            ? { provider: 'uazapi', baseUrl: config.base_url, instanceId: config.instance_id, accessToken }
            : { provider: 'meta', phoneNumberId: config.phone_number_id, accessToken, verifyToken: '' },
      )
    } catch (err) {
      if (err instanceof ProviderUnsupportedError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    // ── Non-Meta provider path ────────────────────────────────────────────
    if (config.provider && config.provider !== 'meta') {
      if (message_type === 'template') {
        return NextResponse.json(
          { error: 'Template messages are only available with the official Meta WhatsApp Business API. Please use a text or media message instead.' },
          { status: 400 },
        )
      }

      // ── ODI-001 §4: create intent before provider call ──
      const messageId = crypto.randomUUID()
      let settlement: SettlementResult = { messageId: '', outcome: 'noop' }
      try {
        await createIntent(supabase, {
          messageId,
          conversationId: conversation_id,
          contentType: message_type,
          connectionRef: config.id,
          contentText: content_text,
          mediaUrl: media_url,
          replyToMessageId: reply_to_message_id,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error('[whatsapp/send] Error creating intent (non-Meta):', msg)
        return NextResponse.json(
          { error: `Failed to create message in database: ${msg}` },
          { status: 500 },
        )
      }

      let providerMessageId = ''
      let sendError: unknown = null
      try {
        const result = isMediaKind
          ? await sendMedia(provider, {
              to: sanitizedPhone,
              kind: message_type as MediaKind,
              link: media_url,
              caption: content_text || undefined,
              filename: filename || undefined,
              contextMessageId,
            })
          : await sendText(provider, {
              to: sanitizedPhone,
              text: content_text,
              contextMessageId,
            })
        providerMessageId = result.messageId
        settlement = await settleMessage(supabase, messageId, 'sent', config.id, result.externalIdentities, result.messageId)
      } catch (err) {
        sendError = err
      }

      if (sendError) {
        // Commit 6.1 correção #1 — ADR-E4B-001: falhas reenviáveis
        // (transient/ambiguous) permanecem `sending` e vão para o retry
        // ledger; somente uma falha `permanent` é liquidada `failed`
        // aqui. handleSendFailure decide isso — este caminho não
        // classifica erro manualmente.
        try {
          settlement = await handleSendFailure(supabase, provider, sendError, messageId, config.id)
        } catch (settleErr) {
          console.error('[whatsapp/send] Provider send + failure-handling both failed:', settleErr)
        }
        const msg = sendError instanceof Error ? sendError.message : 'Unknown WhatsApp API error'
        console.error('[whatsapp/send] provider send failed:', msg)
        return NextResponse.json(
          { error: `WhatsApp API error: ${msg}`, message_id: messageId },
          { status: 502 },
        )
      }

      // ── ODI-001 §7: gate N-3 — effects fire only on outcome === 'sent' ──
      if (settlement.outcome === 'sent') {
        await supabase
          .from('conversations')
          .update({
            last_message_text: content_text || `[${message_type}]`,
            last_message_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', conversation_id)
      }

      return NextResponse.json({
        success: true,
        message_id: messageId,
        whatsapp_message_id: providerMessageId,
      })
    }

    // ── Meta provider path (unchanged) ───────────────────────────────────
    // Send via Meta API — retry with phone-number variants if Meta rejects
    // with "recipient not in allowed list" (common in sandbox / when a
    // number was registered with/without a trunk 0). If an alternate
    // format succeeds, we persist it back to the contact row so the
    // next send goes through on the first attempt.
    let waMessageId = ''
    let workingPhone = sanitizedPhone

    // For template sends, load the row so sendTemplateMessage can
    // build header + button components from the template definition.
    // Match on (user_id, name, language) — same triple the unique
    // index enforces — so multi-language templates work correctly.
    // Missing template falls through with `templateRow = null` and
    // the legacy body-only path runs.
    // Load the template row so sendTemplateMessage can build header
    // + button components from the definition. isMessageTemplate
    // guards against a malformed row (e.g. from a partial sync)
    // crashing the send-builder later in the stack.
    let templateRow: MessageTemplate | null = null
    if (message_type === 'template' && template_name) {
      const { data } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', template_name)
        .eq('language', template_language || 'en_US')
        .maybeSingle()
      if (data && !isMessageTemplate(data)) {
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
          },
          { status: 500 },
        )
      }
      templateRow = data ?? null
    }

    // ── ODI-001 §4: create intent before provider call (Meta path) ──
    const messageId = crypto.randomUUID()
    let metaSettlement: SettlementResult = { messageId: '', outcome: 'noop' }
    try {
      await createIntent(supabase, {
        messageId,
        conversationId: conversation_id,
        contentType: message_type,
        connectionRef: config.id,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        replyToMessageId: reply_to_message_id,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      console.error('[whatsapp/send] Error creating intent (Meta):', msg)
      return NextResponse.json(
        { error: `Failed to create message in database: ${msg}` },
        { status: 500 },
      )
    }

    // ── ODI-001 §5: send then settle ──
    const attemptOne = async (phone: string): Promise<{ messageId: string; identities: ExternalIdentity[] }> => {
      if (message_type === 'template') {
        const result = await sendTemplate(provider, {
          to: phone,
          templateName: template_name,
          language: template_language || 'en_US',
          template: (templateRow ?? undefined) as Record<string, unknown> | undefined,
          messageParams: template_message_params ?? undefined,
          params: template_params || undefined,
          contextMessageId,
        })
        return { messageId: result.messageId, identities: result.externalIdentities }
      }
      if (isMediaKind) {
        const result = await sendMedia(provider, {
          to: phone,
          kind: message_type as MediaKind,
          link: media_url,
          caption: content_text || undefined,
          filename: filename || undefined,
          contextMessageId,
        })
        return { messageId: result.messageId, identities: result.externalIdentities }
      }
      const result = await sendText(provider, {
        to: phone,
        text: content_text,
        contextMessageId,
      })
      return { messageId: result.messageId, identities: result.externalIdentities }
    }

    try {
      const variants = phoneVariants(sanitizedPhone)
      let lastError: unknown = null

      for (const variant of variants) {
        try {
          const out = await attemptOne(variant)
          waMessageId = out.messageId
          workingPhone = variant
          metaSettlement = await settleMessage(supabase, messageId, 'sent', config.id, out.identities, out.messageId)
          lastError = null
          break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(message)) {
            throw err
          }
          lastError = err
          console.warn(`[whatsapp/send] variant "${variant}" rejected by Meta, trying next…`)
        }
      }

      if (lastError) throw lastError
    } catch (err) {
      // Commit 6.1 correção #1 — mesmo tratamento via handleSendFailure
      // (ADR-E4B-001/002/003): reenviável fica `sending` + ledger;
      // apenas `permanent` liquida `failed`.
      try {
        metaSettlement = await handleSendFailure(supabase, provider, err, messageId, config.id)
      } catch (settleErr) {
        console.error('[whatsapp/send] Meta send + failure-handling both failed:', settleErr)
      }
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API send failed for all variants:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}`, message_id: messageId },
        { status: 502 }
      )
    }

    // If a non-original variant succeeded, update the contact so future
    // sends go straight through.
    if (workingPhone !== sanitizedPhone) {
      console.log(
        `[whatsapp/send] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
      )
      await supabase
        .from('contacts')
        .update({ phone: workingPhone })
        .eq('id', contact.id)
    }

    // ── ODI-001 §7: gate N-3 — effects only on outcome === 'sent' ──
    if (metaSettlement.outcome === 'sent') {
      await supabase
        .from('conversations')
        .update({
          last_message_text: content_text || `[${message_type}]`,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation_id)

      try {
        const { error: pauseErr } = await supabaseAdmin()
          .from('flow_runs')
          .update({
            status: 'paused_by_agent',
            ended_at: new Date().toISOString(),
            end_reason: 'agent_replied',
          })
          .eq('account_id', accountId)
          .eq('contact_id', contact.id)
          .eq('status', 'active')
        if (pauseErr) {
          console.error('[flows] pause-on-agent-send failed:', pauseErr.message)
        }
      } catch (err) {
        console.error(
          '[flows] pause-on-agent-send threw:',
          err instanceof Error ? err.message : err,
        )
      }
    }

    return NextResponse.json({
      success: true,
      message_id: messageId,
      whatsapp_message_id: waMessageId,
    })
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}
