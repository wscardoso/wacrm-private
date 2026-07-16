/**
 * Z-API provider (z-api.io)
 *
 * Credentials required:
 *   instanceId : the 24-char hex instance ID shown in the Z-API dashboard
 *   token      : the instance token (Access Token)
 *
 * Docs: https://developer.z-api.io
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
} from './types'

export class ZApiProvider implements WhatsAppProvider {
  readonly kind = 'zapi'

  private readonly base: string
  private readonly clientToken?: string

  constructor({
    instanceId,
    token,
    clientToken,
  }: {
    instanceId: string
    token: string
    clientToken?: string
  }) {
    this.base = `https://api.z-api.io/instances/${instanceId}/token/${token}`
    this.clientToken = clientToken
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.clientToken) h['client-token'] = this.clientToken
    return h
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Z-API ${path} failed (${res.status}): ${text}`)
    }
    return res.json()
  }

  async checkStatus(): Promise<{ connected: boolean }> {
    const res = await fetch(`${this.base}/status`, { headers: this.headers() })
    if (!res.ok) return { connected: false }
    const data = (await res.json()) as {
      connected?: boolean
      smartphoneConnected?: boolean
      value?: string      // Z-API sometimes returns { value: "CONNECTED" }
      error?: boolean
    }
    // Accept any truthy indicator of a live instance
    const connected =
      data.value === 'CONNECTED' ||
      data.connected === true ||
      data.smartphoneConnected === true ||
      data.error === false
    return { connected }
  }

  async sendText({ to, text, contextMessageId }: SendTextArgs): Promise<SendResult> {
    const body: Record<string, unknown> = { phone: to, message: text }
    if (contextMessageId) body.messageId = contextMessageId
    const data = (await this.post('/send-text', body)) as {
      zaapId?: string
      messageId?: string
    }
    return { messageId: data.zaapId ?? data.messageId ?? '' }
  }

  async sendMedia({ to, kind, link, caption, filename, contextMessageId }: SendMediaArgs): Promise<SendResult> {
    const pathMap: Record<string, string> = {
      image: '/send-image',
      video: '/send-video',
      document: '/send-document',
      audio: '/send-audio',
    }
    const body: Record<string, unknown> = { phone: to, [kind]: link }
    if (caption) body.caption = caption
    if (filename) body.fileName = filename
    if (contextMessageId) body.messageId = contextMessageId
    const data = (await this.post(pathMap[kind] ?? '/send-image', body)) as {
      zaapId?: string
      messageId?: string
    }
    return { messageId: data.zaapId ?? data.messageId ?? '' }
  }

  async sendTemplate({ to, templateName, params }: SendTemplateArgs): Promise<SendResult> {
    // Z-API uses HSM / template messages differently — send as text fallback
    const body: Record<string, unknown> = {
      phone: to,
      message: params
        ? Object.entries(params).reduce((t, [k, v]) => t.replace(`{{${k}}}`, v), templateName)
        : templateName,
    }
    const data = (await this.post('/send-text', body)) as { zaapId?: string; messageId?: string }
    return { messageId: data.zaapId ?? data.messageId ?? '' }
  }

  async sendReaction({ to, targetMessageId, emoji }: SendReactionArgs): Promise<SendResult> {
    const data = (await this.post('/send-reaction', {
      phone: to,
      reactionMessageId: targetMessageId,
      reaction: emoji,
    })) as { zaapId?: string; messageId?: string }
    return { messageId: data.zaapId ?? data.messageId ?? '' }
  }

  async sendInteractiveButtons({
    to,
    bodyText,
    buttons,
    headerText,
    footerText,
  }: SendInteractiveButtonsArgs): Promise<SendResult> {
    const data = (await this.post('/send-button-list', {
      phone: to,
      message: bodyText,
      buttonList: {
        buttons: buttons.map((b) => ({ id: b.id, label: b.title })),
      },
      title: headerText,
      footer: footerText,
    })) as { zaapId?: string; messageId?: string }
    return { messageId: data.zaapId ?? data.messageId ?? '' }
  }

  async sendInteractiveList({
    to,
    bodyText,
    buttonLabel,
    sections,
    headerText,
    footerText,
  }: SendInteractiveListArgs): Promise<SendResult> {
    const data = (await this.post('/send-option-list', {
      phone: to,
      message: bodyText,
      title: headerText,
      footer: footerText,
      buttonLabel,
      sections: sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })),
      })),
    })) as { zaapId?: string; messageId?: string }
    return { messageId: data.zaapId ?? data.messageId ?? '' }
  }

  parseInboundMessage(payload: unknown): InboundMessage | null {
    // Z-API webhook shape (ReceivedCallback / MessageStatusCallback)
    const msg = payload as Record<string, unknown>
    if (!msg || msg.fromMe === true) return null

    const phone = (msg.phone as string) ?? ''
    if (!phone) return null

    const messageId = (msg.messageId as string) ?? ''
    const timestamp = String(msg.momment ?? Date.now())
    const senderName = (msg.senderName as string) ?? undefined

    // Detect type
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
    const contextMessageId: string | undefined = (msg.referencedMessage as Record<string, unknown>)?.messageId as string | undefined

    if (msg.text) {
      type = 'text'
      text = ((msg.text as Record<string, unknown>).message as string) ?? ''
    } else if (msg.image) {
      type = 'image'
      const img = msg.image as Record<string, unknown>
      mediaRef = img.imageUrl as string
      caption = img.caption as string
      mimeType = img.mimeType as string
    } else if (msg.video) {
      type = 'video'
      const vid = msg.video as Record<string, unknown>
      mediaRef = vid.videoUrl as string
      caption = vid.caption as string
      mimeType = vid.mimeType as string
    } else if (msg.document) {
      type = 'document'
      const doc = msg.document as Record<string, unknown>
      mediaRef = doc.documentUrl as string
      filename = doc.fileName as string
      mimeType = doc.mimeType as string
    } else if (msg.audio) {
      type = 'audio'
      const aud = msg.audio as Record<string, unknown>
      mediaRef = aud.audioUrl as string
      mimeType = aud.mimeType as string
    } else if (msg.reaction) {
      type = 'reaction'
      const r = msg.reaction as Record<string, unknown>
      reactionTargetMessageId = r.messageId as string
      reactionEmoji = r.reaction as string
    } else if (msg.buttonReply) {
      type = 'interactive'
      const br = msg.buttonReply as Record<string, unknown>
      interactiveReplyType = 'button_reply'
      interactiveReplyId = br.selectedButtonId as string
      interactiveReplyTitle = br.selectedButtonDisplayText as string
    } else if (msg.listReply) {
      type = 'interactive'
      const lr = msg.listReply as Record<string, unknown>
      interactiveReplyType = 'list_reply'
      interactiveReplyId = lr.selectedRowId as string
      interactiveReplyTitle = lr.selectedDisplayText as string
    }

    return {
      messageId,
      from: phone,
      senderName,
      timestamp,
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
    // Z-API doesn't sign webhook payloads by default.
    // The webhook URL is secured by embedding the verify_token as a path segment
    // (see /api/whatsapp/webhook/zapi/[webhookSecret]/route.ts).
    return true
  }
}
