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
  ExternalIdentity,
  ProviderCapabilities,
  SendOutcomeClass,
  CanonicalStatus,
  CanonicalStatusEvent,
} from './types'

/**
 * ADR-E4B-003 §3.4 — Z-API-specific interpretation, confined to this file.
 *
 * `post()` below throws `Error('Z-API <path> failed (<status>): <text>')`
 * when a response was received but not ok, so the status is always
 * recoverable there. A `fetch()` failure that never produced a
 * `Response` (connection refused, DNS failure) throws a different
 * shape with no such status — and, when the runtime exposes it, a
 * `cause.code` identifying a connection that never departed.
 */
function classifyZApiSendFailure(error: unknown): SendOutcomeClass {
  const message = error instanceof Error ? error.message : String(error)
  const match = /failed \((\d{3})\):/.exec(message)
  if (match) {
    const status = Number(match[1])
    // Certain, definitive rejection by the API layer before any dispatch.
    if ([400, 401, 403, 404, 422].includes(status)) {
      return 'deterministic-permanent'
    }
    // 429 and 5xx: Z-API may have accepted or processed the attempt
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

export class ZApiProvider implements WhatsAppProvider {
  readonly kind = 'zapi'

  /** ADR-E4B-003 §3.3 — undeclared capability defaults to `false`. */
  readonly capabilities: ProviderCapabilities = {
    nativeIdempotency: false,
    deliveryReconciliation: false,
  }

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

  /** ADR-E4B-003 §3.4 — see classifyZApiSendFailure above. */
  classifySendFailure(error: unknown): SendOutcomeClass {
    return classifyZApiSendFailure(error)
  }

  private sendResultFrom(data: {
    zaapId?: string
    messageId?: string
  }): SendResult {
    const primary = data.messageId ?? data.zaapId ?? ''
    const identities: ExternalIdentity[] = []
    if (data.messageId) identities.push({ kind: 'wamid', value: data.messageId })
    if (data.zaapId) identities.push({ kind: 'provider_message_id', value: data.zaapId })
    return { messageId: primary, externalIdentities: identities }
  }

  async sendText({ to, text, contextMessageId }: SendTextArgs): Promise<SendResult> {
    const body: Record<string, unknown> = { phone: to, message: text }
    if (contextMessageId) body.messageId = contextMessageId
    const data = (await this.post('/send-text', body)) as {
      zaapId?: string
      messageId?: string
    }
    return this.sendResultFrom(data)
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
    return this.sendResultFrom(data)
  }

  async sendTemplate({ to, templateName, params }: SendTemplateArgs): Promise<SendResult> {
    const body: Record<string, unknown> = {
      phone: to,
      message: params
        ? Object.entries(params).reduce((t, [k, v]) => t.replace(`{{${k}}}`, v), templateName)
        : templateName,
    }
    const data = (await this.post('/send-text', body)) as { zaapId?: string; messageId?: string }
    return this.sendResultFrom(data)
  }

  async sendReaction({ to, targetMessageId, emoji }: SendReactionArgs): Promise<SendResult> {
    const data = (await this.post('/send-reaction', {
      phone: to,
      reactionMessageId: targetMessageId,
      reaction: emoji,
    })) as { zaapId?: string; messageId?: string }
    return this.sendResultFrom(data)
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
    return this.sendResultFrom(data)
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
    return this.sendResultFrom(data)
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

  /**
   * ADR-MSG-STATUS-001 D9 — Z-API status map.
   *
   *   SENT -> sent · RECEIVED -> delivered · READ/PLAYED -> read
   *
   * ⚠️ `RECEIVED` maps to `delivered`, NEVER to `received`. Z-API's
   * "RECEIVED" means "arrived at the recipient's device"; the canonical
   * `received` is the initial state of an INBOUND message (ADR-MSG-001 D7)
   * and is unreachable from any status callback. This homonym is risk R1
   * of the ADR — the highest-severity trap in the whole map.
   *
   * ⚠️ UNVERIFIED SHAPE. No real `MessageStatusCallback` payload has ever
   * been captured (CHECKPOINT-E2.1 §8 pré-condição 1 remains unsatisfied;
   * whatsapp_webhook_dlq is empty and no webhook log exists). ADR §2.2
   * documents the value field as `status`; the first implementation of
   * this method assumed `ack`. Nobody can currently say which is right, so
   * this reads BOTH and discriminates on the `type` envelope field when it
   * is present. That tolerance is deliberate and provisional: it must be
   * narrowed to the observed shape once a real payload is captured.
   */
  parseStatusEvent(payload: unknown): CanonicalStatusEvent[] {
    const msg = payload as Record<string, unknown> | null
    if (!msg) return []

    // Envelope discriminator, when Z-API sends one. Its ABSENCE in the
    // inbound parser is defect D-C; here we use it positively.
    const envelopeType = typeof msg.type === 'string' ? msg.type : undefined
    if (envelopeType && envelopeType !== 'MessageStatusCallback') return []

    const rawValue = msg.status ?? msg.ack
    const ids = msg.ids
    if (rawValue === undefined || rawValue === null) return []
    if (!Array.isArray(ids) || ids.length === 0) return []

    const statusMap: Record<string, CanonicalStatus> = {
      SENT: 'sent',
      RECEIVED: 'delivered', // R1 — never `received`
      READ: 'read',
      PLAYED: 'read', // D4 — collapses into `read`, no new canonical state
    }

    const key = String(rawValue).toUpperCase()
    const canonicalStatus = statusMap[key]
    if (!canonicalStatus) {
      // D8/N3 — unknown provider value. Recorded, never guessed, and never
      // defaulted to `failed` (A6): ignorance is not evidence of failure.
      console.warn(
        '[zapi] N3',
        JSON.stringify({ reason: 'unmapped status value', value: rawValue }),
      )
      return []
    }

    // D5/D9 — Z-API `momment` is already milliseconds; normalise here so
    // the domain never sees a provider time unit.
    const timestamp = String(msg.momment ?? Date.now())

    // I5 — one provider event, N identifiers, N independent applications.
    return ids
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((externalId) => ({ externalId, status: canonicalStatus, timestamp }))
  }

  async verifyWebhookRequest(_req: Request, _rawBody: string): Promise<boolean> {
    void _req; void _rawBody
    // Z-API doesn't sign webhook payloads by default.
    // The webhook URL is secured by embedding the webhook secret as a path
    // segment (see /api/whatsapp/webhook/zapi/[connectionId]/[webhookSecret]/route.ts,
    // ADR-SEC-001 / C7). There is no fallback to the legacy verify_token.
    return true
  }
}
