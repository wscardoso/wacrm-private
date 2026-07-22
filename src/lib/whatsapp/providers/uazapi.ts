/**
 * uazapi provider (uazapi.dev — Evolution API compatible)
 *
 * Credentials required:
 *   baseUrl    : your uazapi server URL, e.g. https://my.uazapi.dev
 *   instanceId : the instance name created in your uazapi dashboard
 *   token      : the API key (apikey)
 *
 * Docs: https://uazapi.dev/docs
 */

import type {
  WhatsAppProvider,
  SendResult,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendReactionArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  InboundMessage,
  ExternalIdentity,
  ProviderCapabilities,
  SendOutcomeClass,
} from './types'

/**
 * ADR-E4B-003 §3.4 — uazapi-specific interpretation, confined to this file.
 *
 * Same shape as Z-API: `post()` throws `Error('uazapi <path> failed
 * (<status>): <text>')` whenever a response was received but not ok,
 * so the status is always recoverable there. A `fetch()` failure that
 * never produced a `Response` throws a different shape with no status.
 */
function classifyUazapiSendFailure(error: unknown): SendOutcomeClass {
  const message = error instanceof Error ? error.message : String(error)
  const match = /failed \((\d{3})\):/.exec(message)
  if (match) {
    const status = Number(match[1])
    // Certain, definitive rejection by the API layer before any dispatch.
    if ([400, 401, 403, 404, 422].includes(status)) {
      return 'deterministic-permanent'
    }
    // 429 and 5xx: uazapi may have accepted or processed the attempt
    // before responding (ADR-E4B-002 §2) — ambiguous, not permanent.
    return 'ambiguous'
  }

  // No HTTP response was ever obtained. Only a connection that
  // certainly never departed (ADR-E4B-002 §2 example) counts as
  // deterministic; anything else under doubt is ambiguous.
  const code = (error as { cause?: { code?: string } } | undefined)?.cause?.code
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'deterministic-transient'
  }
  return 'ambiguous'
}

export class UazapiProvider implements WhatsAppProvider {
  readonly kind = 'uazapi'

  /** ADR-E4B-003 §3.3 — undeclared capability defaults to `false`. */
  readonly capabilities: ProviderCapabilities = {
    nativeIdempotency: false,
    deliveryReconciliation: false,
  }

  private readonly baseUrl: string
  private readonly instanceId: string
  private readonly token: string

  constructor({
    baseUrl,
    instanceId,
    token,
  }: {
    baseUrl: string
    instanceId: string
    token: string
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.instanceId = instanceId
    this.token = token
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      apikey: this.token,
    }
  }

  private toJid(phone: string): string {
    // Evolution API expects phone@s.whatsapp.net
    const digits = phone.replace(/\D/g, '')
    return digits.endsWith('@s.whatsapp.net') ? digits : `${digits}@s.whatsapp.net`
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`uazapi ${path} failed (${res.status}): ${text}`)
    }
    return res.json()
  }

  async checkStatus(): Promise<{ connected: boolean }> {
    const url = `${this.baseUrl}/instance/connectionState/${this.instanceId}`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) return { connected: false }
    const data = (await res.json()) as { instance?: { state?: string } }
    return { connected: data.instance?.state === 'open' }
  }

  /** ADR-E4B-003 §3.4 — see classifyUazapiSendFailure above. */
  classifySendFailure(error: unknown): SendOutcomeClass {
    return classifyUazapiSendFailure(error)
  }

  private extractMessageId(data: unknown): string {
    const d = data as Record<string, unknown>
    const key = d?.key as Record<string, unknown> | undefined
    return (key?.id as string) ?? ''
  }

  private withIdentities(messageId: string): SendResult {
    const identities: ExternalIdentity[] = [{ kind: 'provider_message_id', value: messageId }]
    return { messageId, externalIdentities: identities }
  }

  async sendText({ to, text, contextMessageId }: SendTextArgs): Promise<SendResult> {
    const body: Record<string, unknown> = {
      number: this.toJid(to),
      textMessage: { text },
    }
    if (contextMessageId) {
      body.quoted = { key: { id: contextMessageId } }
    }
    const data = await this.post(`/message/sendText/${this.instanceId}`, body)
    return this.withIdentities(this.extractMessageId(data))
  }

  async sendMedia({ to, kind, link, caption, filename, contextMessageId }: SendMediaArgs): Promise<SendResult> {
    const pathMap: Record<string, string> = {
      image: 'sendMedia',
      video: 'sendMedia',
      document: 'sendMedia',
      audio: 'sendWhatsAppAudio',
    }
    const mediaTypeMap: Record<string, string> = {
      image: 'IMAGE',
      video: 'VIDEO',
      document: 'DOCUMENT',
      audio: 'AUDIO',
    }
    const body: Record<string, unknown> = {
      number: this.toJid(to),
      mediatype: mediaTypeMap[kind] ?? 'IMAGE',
      media: link,
      caption,
      fileName: filename,
    }
    if (contextMessageId) {
      body.quoted = { key: { id: contextMessageId } }
    }
    const data = await this.post(`/message/${pathMap[kind] ?? 'sendMedia'}/${this.instanceId}`, body)
    return this.withIdentities(this.extractMessageId(data))
  }

  async sendTemplate({ to, templateName, params }: SendTemplateArgs): Promise<SendResult> {
    const text = params
      ? Object.entries(params).reduce((t, [k, v]) => t.replace(`{{${k}}}`, v), templateName)
      : templateName
    return this.sendText({ to, text })
  }

  async sendReaction({ to, targetMessageId, emoji }: SendReactionArgs): Promise<SendResult> {
    const data = await this.post(`/message/sendReaction/${this.instanceId}`, {
      key: { remoteJid: this.toJid(to), id: targetMessageId },
      reaction: emoji,
    })
    return this.withIdentities(this.extractMessageId(data))
  }

  async sendInteractiveButtons({
    to,
    bodyText,
    buttons,
    headerText,
    footerText,
  }: SendInteractiveButtonsArgs): Promise<SendResult> {
    const data = await this.post(`/message/sendButtons/${this.instanceId}`, {
      number: this.toJid(to),
      title: headerText,
      description: bodyText,
      footer: footerText,
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    })
    return this.withIdentities(this.extractMessageId(data))
  }

  async sendInteractiveList({
    to,
    bodyText,
    buttonLabel,
    sections,
    headerText,
    footerText,
  }: SendInteractiveListArgs): Promise<SendResult> {
    const data = await this.post(`/message/sendList/${this.instanceId}`, {
      number: this.toJid(to),
      title: headerText,
      description: bodyText,
      footer: footerText,
      buttonText: buttonLabel,
      sections: sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })),
      })),
    })
    return this.withIdentities(this.extractMessageId(data))
  }

  parseInboundMessage(payload: unknown): InboundMessage | null {
    // Evolution API / uazapi webhook shape
    const event = payload as Record<string, unknown>

    // uazapi wraps in { event: 'MESSAGES_UPSERT', data: {...} }
    // or delivers the data directly
    const rawData = (event.data ?? event) as Record<string, unknown>
    const messages = rawData.messages as unknown[] | undefined
    const msgRaw = messages?.[0] ?? rawData

    const msg = msgRaw as Record<string, unknown>
    const key = msg.key as Record<string, unknown> | undefined
    if (!key) return null
    if (key.fromMe === true) return null

    const remoteJid = (key.remoteJid as string) ?? ''
    const from = remoteJid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '')
    const messageId = (key.id as string) ?? ''
    const pushName = (msg.pushName as string) ?? undefined
    const messageTimestamp = String(msg.messageTimestamp ?? Date.now())

    const message = msg.message as Record<string, unknown> | undefined
    if (!message) return null

    let type: InboundMessage['type'] = 'unknown'
    let text: string | undefined
    let mediaRef: string | undefined
    let mimeType: string | undefined
    let caption: string | undefined
    let filename: string | undefined
    let reactionTargetMessageId: string | undefined
    let reactionEmoji: string | undefined
    let interactiveReplyType: InboundMessage['interactiveReplyType']
    let interactiveReplyId: string | undefined
    let interactiveReplyTitle: string | undefined
    const contextMessageId = (msg.contextInfo as Record<string, unknown>)?.stanzaId as string | undefined

    if (message.conversation) {
      type = 'text'
      text = message.conversation as string
    } else if (message.extendedTextMessage) {
      type = 'text'
      text = ((message.extendedTextMessage as Record<string, unknown>).text as string) ?? ''
    } else if (message.imageMessage) {
      type = 'image'
      const img = message.imageMessage as Record<string, unknown>
      mediaRef = (img.url ?? img.jpegThumbnail) as string
      caption = img.caption as string
      mimeType = img.mimetype as string
    } else if (message.videoMessage) {
      type = 'video'
      const vid = message.videoMessage as Record<string, unknown>
      mediaRef = vid.url as string
      caption = vid.caption as string
      mimeType = vid.mimetype as string
    } else if (message.documentMessage) {
      type = 'document'
      const doc = message.documentMessage as Record<string, unknown>
      mediaRef = doc.url as string
      filename = doc.fileName as string
      mimeType = doc.mimetype as string
    } else if (message.audioMessage) {
      type = 'audio'
      const aud = message.audioMessage as Record<string, unknown>
      mediaRef = aud.url as string
      mimeType = aud.mimetype as string
    } else if (message.reactionMessage) {
      type = 'reaction'
      const r = message.reactionMessage as Record<string, unknown>
      const rKey = r.key as Record<string, unknown>
      reactionTargetMessageId = rKey?.id as string
      reactionEmoji = r.text as string
    } else if (message.buttonsResponseMessage) {
      type = 'interactive'
      const br = message.buttonsResponseMessage as Record<string, unknown>
      interactiveReplyType = 'button_reply'
      interactiveReplyId = br.selectedButtonId as string
      interactiveReplyTitle = br.selectedDisplayText as string
    } else if (message.listResponseMessage) {
      type = 'interactive'
      const lr = message.listResponseMessage as Record<string, unknown>
      interactiveReplyType = 'list_reply'
      interactiveReplyId = lr.selectedRowId as string
      interactiveReplyTitle = (lr.title as string) ?? ''
    }

    return {
      messageId,
      from,
      senderName: pushName,
      timestamp: messageTimestamp,
      type,
      contextMessageId,
      text,
      mediaRef,
      mediaRefIsUrl: true,
      mimeType,
      caption,
      filename,
      reactionTargetMessageId,
      reactionEmoji,
      interactiveReplyType,
      interactiveReplyId,
      interactiveReplyTitle,
    }
  }

  async verifyWebhookRequest(_req: Request, _rawBody: string): Promise<boolean> {
    // uazapi doesn't sign payloads. Security comes from the secret
    // embedded in the webhook URL path (see /api/whatsapp/webhook/uazapi/[secret]).
    return true
  }
}
