import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  sendWithPhoneVariantRetry,
} from '@/lib/whatsapp/phone-utils'
import { getProvider, type ExternalIdentity } from '@/lib/whatsapp/providers'
import { settleMessage } from '@/lib/whatsapp/delivery/settlement'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
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
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? input.text : null
  const template_name = input.kind === 'template' ? input.templateName : null

  const { error: intentErr } = await db
    .from('messages')
    .insert({
      id: messageId,
      conversation_id: input.conversationId,
      sender_type: 'bot',
      content_type,
      content_text,
      template_name,
      status: 'sending',
      idempotency_key: messageId,
    })

  if (intentErr) {
    throw new Error(`failed to create message row: ${intentErr.message}`)
  }

  // ── ODI-001 §5: send then settle ──
  let identities: ExternalIdentity[] = []

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await provider.sendTemplate({
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params
          ? Object.fromEntries(input.params.map((v, i) => [String(i), v]))
          : undefined,
      })
      identities = r.externalIdentities
      return r.messageId
    }
    const r = await provider.sendText({
      to: phone,
      text: input.text,
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
      console.error('[automations] send + settlement both failed:', settleErr)
    }
    throw err
  }

  // ── ODI-001 §7: conversation update (not gated — automation always
  //     updates last_message_text even on 'failed' to surface the state) ──
  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
