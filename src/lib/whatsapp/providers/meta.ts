/**
 * Meta (official WhatsApp Business Cloud API) provider adapter.
 *
 * Wraps the existing meta-api.ts helpers so the rest of the codebase
 * can switch providers by swapping getProvider(config) without touching
 * any sending logic. The Meta adapter is a thin pass-through — it adds
 * no new network calls and preserves all existing behaviour exactly.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
} from '@/lib/whatsapp/meta-api'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import type { MessageTemplate } from '@/types'
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

interface MetaProviderConfig {
  phoneNumberId: string
  /** Already decrypted access token. */
  accessToken: string
  /** Webhook verify token (for GET verification). */
  verifyToken: string
}

export class MetaProvider implements WhatsAppProvider {
  readonly kind = 'meta' as const

  private readonly phoneNumberId: string
  private readonly accessToken: string
  private readonly verifyToken: string

  constructor(cfg: MetaProviderConfig) {
    this.phoneNumberId = cfg.phoneNumberId
    this.accessToken = cfg.accessToken
    this.verifyToken = cfg.verifyToken
  }

  async sendText(args: SendTextArgs): Promise<SendResult> {
    return sendTextMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      text: args.text,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendMedia(args: SendMediaArgs): Promise<SendResult> {
    return sendMediaMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      kind: args.kind,
      link: args.link,
      caption: args.caption,
      filename: args.filename,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendTemplate(args: SendTemplateArgs): Promise<SendResult> {
    return sendTemplateMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      templateName: args.templateName,
      language: args.language,
      params: args.params ? Object.values(args.params) : undefined,
      template: args.template as MessageTemplate | undefined,
      messageParams: args.messageParams,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendReaction(args: SendReactionArgs): Promise<SendResult> {
    return sendReactionMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      targetMessageId: args.targetMessageId,
      emoji: args.emoji,
    })
  }

  async sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<SendResult> {
    return metaSendInteractiveButtons({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      buttons: args.buttons,
      headerText: args.headerText,
      footerText: args.footerText,
      contextMessageId: args.contextMessageId,
    })
  }

  async sendInteractiveList(args: SendInteractiveListArgs): Promise<SendResult> {
    return metaSendInteractiveList({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: args.to,
      bodyText: args.bodyText,
      buttonLabel: args.buttonLabel,
      sections: args.sections,
      headerText: args.headerText,
      footerText: args.footerText,
      contextMessageId: args.contextMessageId,
    })
  }

  // ------------------------------------------------------------------
  // Inbound parsing — Meta webhook format
  // ------------------------------------------------------------------

  parseInboundMessage(payload: unknown): InboundMessage | null {
    // Meta webhook payloads are handled by the existing webhook route
    // (route.ts) which has more context (whatsapp_config lookup, media
    // proxy, template status events). This method is provided for
    // symmetry with other adapters but the Meta webhook route does NOT
    // call it — it uses the existing inline parsing for full backward
    // compatibility.
    //
    // If you need to unit-test Meta webhook parsing, call parseMetaPayload
    // below directly.
    return parseMetaPayload(payload)
  }

  async verifyWebhookRequest(req: Request, rawBody: string): Promise<boolean> {
    const sig = req.headers.get('x-hub-signature-256') ?? ''
    return verifyMetaWebhookSignature(rawBody, sig)
  }
}

// ------------------------------------------------------------------
// Parsing helpers (exported for tests)
// ------------------------------------------------------------------

interface MetaPayload {
  object?: string
  entry?: Array<{
    id: string
    changes?: Array<{
      value?: {
        messaging_product?: string
        contacts?: Array<{ profile: { name: string }; wa_id: string }>
        messages?: Array<{
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
          reaction?: { message_id: string; emoji: string }
          interactive?: {
            type: 'button_reply' | 'list_reply'
            button_reply?: { id: string; title: string }
            list_reply?: { id: string; title: string }
          }
          context?: { id: string }
        }>
      }
    }>
  }>
}

export function parseMetaPayload(raw: unknown): InboundMessage | null {
  const payload = raw as MetaPayload
  const entry = payload?.entry?.[0]
  const change = entry?.changes?.[0]
  const value = change?.value
  const msg = value?.messages?.[0]
  if (!msg) return null

  const senderName = value?.contacts?.[0]?.profile?.name
  const type = msg.type as InboundMessage['type']

  const base: InboundMessage = {
    messageId: msg.id,
    from: msg.from,
    senderName,
    timestamp: msg.timestamp,
    type: (
      ['text','image','video','document','audio','sticker','location','reaction','interactive'].includes(type)
        ? type
        : 'unknown'
    ) as InboundMessage['type'],
    contextMessageId: msg.context?.id,
  }

  if (msg.text) base.text = msg.text.body
  if (msg.image) {
    base.mediaRef = msg.image.id
    base.mediaRefIsUrl = false
    base.mimeType = msg.image.mime_type
    base.caption = msg.image.caption
  }
  if (msg.video) {
    base.mediaRef = msg.video.id
    base.mediaRefIsUrl = false
    base.mimeType = msg.video.mime_type
    base.caption = msg.video.caption
  }
  if (msg.document) {
    base.mediaRef = msg.document.id
    base.mediaRefIsUrl = false
    base.mimeType = msg.document.mime_type
    base.filename = msg.document.filename
    base.caption = msg.document.caption
  }
  if (msg.audio) {
    base.mediaRef = msg.audio.id
    base.mediaRefIsUrl = false
    base.mimeType = msg.audio.mime_type
  }
  if (msg.sticker) {
    base.mediaRef = msg.sticker.id
    base.mediaRefIsUrl = false
    base.mimeType = msg.sticker.mime_type
  }
  if (msg.reaction) {
    base.reactionTargetMessageId = msg.reaction.message_id
    base.reactionEmoji = msg.reaction.emoji
  }
  if (msg.interactive) {
    base.interactiveReplyType = msg.interactive.type
    if (msg.interactive.type === 'button_reply' && msg.interactive.button_reply) {
      base.interactiveReplyId = msg.interactive.button_reply.id
      base.interactiveReplyTitle = msg.interactive.button_reply.title
    } else if (msg.interactive.type === 'list_reply' && msg.interactive.list_reply) {
      base.interactiveReplyId = msg.interactive.list_reply.id
      base.interactiveReplyTitle = msg.interactive.list_reply.title
    }
  }

  return base
}
