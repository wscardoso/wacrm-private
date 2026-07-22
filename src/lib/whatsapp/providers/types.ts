export interface ExternalIdentity {
  kind: string
  value: string
}

export interface SendResult {
  messageId: string
  externalIdentities: ExternalIdentity[]
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: 'image' | 'document' | 'audio' | 'video'
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  params?: Record<string, string>
  template?: Record<string, unknown>
  messageParams?: Record<string, string>
  contextMessageId?: string
}

export interface SendReactionArgs {
  to: string
  targetMessageId: string
  emoji: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  bodyText: string
  buttons: Array<{ id: string; title: string }>
  headerText?: string
  footerText?: string
  contextMessageId?: string
}

export interface SendInteractiveListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  sections: Array<{
    title: string
    rows: Array<{ id: string; title: string; description?: string }>
  }>
  headerText?: string
  footerText?: string
  contextMessageId?: string
}

export interface InboundMessage {
  messageId: string
  from: string
  senderName?: string
  timestamp: string
  type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'sticker' | 'location' | 'reaction' | 'interactive' | 'unknown'
  contextMessageId?: string
  text?: string
  mediaRef?: string
  mediaRefIsUrl?: boolean
  mimeType?: string
  caption?: string
  filename?: string
  reactionTargetMessageId?: string
  reactionEmoji?: string
  interactiveReplyType?: 'button_reply' | 'list_reply'
  interactiveReplyId?: string
  interactiveReplyTitle?: string
}

export interface WhatsAppProvider {
  readonly kind: string
  sendText(args: SendTextArgs): Promise<SendResult>
  sendMedia(args: SendMediaArgs): Promise<SendResult>
  sendTemplate(args: SendTemplateArgs): Promise<SendResult>
  sendReaction(args: SendReactionArgs): Promise<SendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<SendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<SendResult>
  parseInboundMessage(payload: unknown): InboundMessage | null
  verifyWebhookRequest(req: Request, rawBody: string): Promise<boolean>
}

export class ProviderUnsupportedError extends Error {
  constructor(provider: string) {
    super(`Unsupported WhatsApp provider: ${provider}`)
    this.name = 'ProviderUnsupportedError'
  }
}
