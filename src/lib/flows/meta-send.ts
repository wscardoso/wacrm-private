import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  sendWithPhoneVariantRetry,
} from '@/lib/whatsapp/phone-utils'
import { getProvider, type ExternalIdentity } from '@/lib/whatsapp/providers'
import { settleMessage } from '@/lib/whatsapp/delivery/settlement'
import { supabaseAdmin } from './admin-client'

// Type aliases for the flow engine interfaces. Mirrors the
// meta-api definitions so this file carries no direct import
// from the concrete provider module (ADR-MSG-001/D6).
interface InteractiveButton { id: string; title: string }
interface InteractiveListSection { title?: string; rows: Array<{ id: string; title: string; description?: string }> }
type MediaKind = 'image' | 'video' | 'document' | 'audio'

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // ── Provider dispatch (ADR-MSG-001/D3.b) ──
  let clientToken: string | undefined
  if (config.provider === 'zapi' && config.waba_id) {
    try { clientToken = decrypt(config.waba_id) } catch { /* ignore */ }
  }
  const provider = getProvider(
    config.provider === 'zapi'
      ? { provider: 'zapi', instanceId: config.instance_id, accessToken, clientToken }
      : config.provider === 'uazapi'
        ? { provider: 'uazapi', baseUrl: config.base_url, instanceId: config.instance_id, accessToken }
        : { provider: 'meta', phoneNumberId: config.phone_number_id, accessToken, verifyToken: '' },
  )

  // ── ODI-001 §4: create intent before provider call ──
  const messageId = crypto.randomUUID()
  const { error: intentErr } = await db
    .from('messages')
    .insert({
      id: messageId,
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: 'text',
      content_text: args.text,
      status: 'sending',
      idempotency_key: messageId,
    })

  if (intentErr) {
    throw new Error(`failed to create message row: ${intentErr.message}`)
  }

  // ── ODI-001 §5: send then settle ──
  let identities: ExternalIdentity[] = []

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendText({
      to: phone,
      text: args.text,
    })
    identities = r.externalIdentities
    return r.messageId
  }

  let waMessageId = ''
  try {
    const { result } = await sendWithPhoneVariantRetry(
      sanitized,
      contact.id,
      attempt,
      db,
    )
    waMessageId = result

    await settleMessage(db, messageId, 'sent', config.id, identities, waMessageId)
  } catch (err) {
    try {
      await settleMessage(db, messageId, 'failed', config.id, [])
    } catch (settleErr) {
      console.error('[flows] send + settlement both failed:', settleErr)
    }
    throw err
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // ── Provider dispatch (ADR-MSG-001/D3.b) ──
  let clientToken: string | undefined
  if (config.provider === 'zapi' && config.waba_id) {
    try { clientToken = decrypt(config.waba_id) } catch { /* ignore */ }
  }
  const provider = getProvider(
    config.provider === 'zapi'
      ? { provider: 'zapi', instanceId: config.instance_id, accessToken, clientToken }
      : config.provider === 'uazapi'
        ? { provider: 'uazapi', baseUrl: config.base_url, instanceId: config.instance_id, accessToken }
        : { provider: 'meta', phoneNumberId: config.phone_number_id, accessToken, verifyToken: '' },
  )

  // ── ODI-001 §4: create intent before provider call ──
  const messageId = crypto.randomUUID()
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: intentErr } = await db
    .from('messages')
    .insert({
      id: messageId,
      conversation_id: args.conversationId,
      sender_type: 'bot',
      content_type: args.kind,
      content_text: args.caption ?? null,
      status: 'sending',
      idempotency_key: messageId,
    })

  if (intentErr) {
    throw new Error(`failed to create message row: ${intentErr.message}`)
  }

  // ── ODI-001 §5: send then settle ──
  let identities: ExternalIdentity[] = []

  const attempt = async (phone: string): Promise<string> => {
    const r = await provider.sendMedia({
      to: phone,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
    })
    identities = r.externalIdentities
    return r.messageId
  }

  let waMessageId = ''
  try {
    const { result } = await sendWithPhoneVariantRetry(
      sanitized,
      contact.id,
      attempt,
      db,
    )
    waMessageId = result

    await settleMessage(db, messageId, 'sent', config.id, identities, waMessageId)
  } catch (err) {
    try {
      await settleMessage(db, messageId, 'failed', config.id, [])
    } catch (settleErr) {
      console.error('[flows] send + settlement both failed:', settleErr)
    }
    throw err
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // ── Provider dispatch (ADR-MSG-001/D3.b) ──
  let clientToken: string | undefined
  if (config.provider === 'zapi' && config.waba_id) {
    try { clientToken = decrypt(config.waba_id) } catch { /* ignore */ }
  }
  const provider = getProvider(
    config.provider === 'zapi'
      ? { provider: 'zapi', instanceId: config.instance_id, accessToken, clientToken }
      : config.provider === 'uazapi'
        ? { provider: 'uazapi', baseUrl: config.base_url, instanceId: config.instance_id, accessToken }
        : { provider: 'meta', phoneNumberId: config.phone_number_id, accessToken, verifyToken: '' },
  )

  // ── ODI-001 §4: create intent before provider call ──
  const messageId = crypto.randomUUID()
  const { error: intentErr } = await db
    .from('messages')
    .insert({
      id: messageId,
      conversation_id: input.conversationId,
      sender_type: 'bot',
      content_type: 'interactive',
      content_text: input.bodyText,
      status: 'sending',
      idempotency_key: messageId,
    })

  if (intentErr) {
    throw new Error(`failed to create message row: ${intentErr.message}`)
  }

  // ── ODI-001 §5: send then settle ──
  let identities: ExternalIdentity[] = []

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'buttons') {
      const r = await provider.sendInteractiveButtons({
        to: phone,
        bodyText: input.bodyText,
        buttons: input.buttons,
        headerText: input.headerText,
        footerText: input.footerText,
      })
      identities = r.externalIdentities
      return r.messageId
    }
    const r = await provider.sendInteractiveList({
      to: phone,
      bodyText: input.bodyText,
      buttonLabel: input.buttonLabel,
      sections: input.sections as Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>,
      headerText: input.headerText,
      footerText: input.footerText,
    })
    identities = r.externalIdentities
    return r.messageId
  }

  let waMessageId = ''
  try {
    const { result } = await sendWithPhoneVariantRetry(
      sanitized,
      contact.id,
      attempt,
      db,
    )
    waMessageId = result

    await settleMessage(db, messageId, 'sent', config.id, identities, waMessageId)
  } catch (err) {
    try {
      await settleMessage(db, messageId, 'failed', config.id, [])
    } catch (settleErr) {
      console.error('[flows] send + settlement both failed:', settleErr)
    }
    throw err
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
