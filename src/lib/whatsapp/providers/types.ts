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

/**
 * ADR-E4B-003 §3.1–§3.3 — Provider capability contract.
 *
 * Static declaration of what the provider guarantees, not how it does it
 * (§3.1). Two independent, orthogonal axes (§3.2) — neither derives the
 * other, and there is no combined/aggregate field. Consumed later, and
 * agnostically, by the domain (§3.5); this contract only declares the
 * vocabulary. No decision logic based on these fields belongs here.
 *
 * Default is the conservative one for any provider that has not declared
 * and verified a capability (§3.3, DLB-001 §10.1): `false`.
 */
export interface ProviderCapabilities {
  /**
   * The provider guarantees that a resend carrying the same idempotency
   * key (ODI-001 §6.1, = messages.id) does not produce a second real
   * send (ADR-E4B-003 §3.2).
   */
  readonly nativeIdempotency: boolean
  /**
   * The provider guarantees that delivery state of an attempt can be
   * queried by an identifier possessed before the send (client
   * correlation, = idempotency_key, ODI-001 §6.1) — the utility
   * requirement of ADR-E4B-003 §3.2. A capability only satisfiable by a
   * post-send provider identifier does not count as this axis.
   */
  readonly deliveryReconciliation: boolean
}

/**
 * ADR-E4B-003 §3.4 — domain classification of a send outcome, emitted
 * exclusively by the Provider Adapter. Vocabulary fixed by
 * `ADR-E4B-002` §2 / §5 item 3:
 *
 * - `'ambiguous'` — no certainty of non-delivery; the provider may have
 *   accepted or processed the attempt before the failure surfaced
 *   (timeout during/after dispatch, lost response, 5xx, "accepted then
 *   errored"). This is the default under any doubt.
 * - `'deterministic-transient'` — certainty of non-delivery, and the
 *   condition is expected to clear (e.g. connection refused before the
 *   request ever departed).
 * - `'deterministic-permanent'` — certainty of non-delivery, and the
 *   condition will not clear on retry (e.g. a rejection the provider
 *   issued before any dispatch was attempted).
 *
 * This is the only vocabulary. No provider-specific classification and
 * no additional class belong here — the taxonomy of *which* concrete
 * errors map to which class is interpretation confined to each adapter
 * (ADR-E4B-003 §3.4), not a property of this type.
 */
export type SendOutcomeClass =
  | 'ambiguous'
  | 'deterministic-transient'
  | 'deterministic-permanent'

export interface WhatsAppProvider {
  readonly kind: string
  /** ADR-E4B-003 §3.1 — capability contract, declared statically by the provider. */
  readonly capabilities: ProviderCapabilities
  sendText(args: SendTextArgs): Promise<SendResult>
  sendMedia(args: SendMediaArgs): Promise<SendResult>
  sendTemplate(args: SendTemplateArgs): Promise<SendResult>
  sendReaction(args: SendReactionArgs): Promise<SendResult>
  sendInteractiveButtons(args: SendInteractiveButtonsArgs): Promise<SendResult>
  sendInteractiveList(args: SendInteractiveListArgs): Promise<SendResult>
  parseInboundMessage(payload: unknown): InboundMessage | null
  verifyWebhookRequest(req: Request, rawBody: string): Promise<boolean>
  /**
   * ADR-E4B-003 §3.4 — translates a caught send failure (whatever this
   * adapter's own send methods threw) into the domain classification
   * above. All interpretation of the raw error/response — status
   * codes, error bodies, connection-level failures — is confined to
   * this method, inside the adapter; it never leaks past this
   * boundary. Emits the class only. Does not decide whether, when, or
   * how to retry — that is ADR-E4B-002 / ARO-001, not this method.
   */
  classifySendFailure(error: unknown): SendOutcomeClass
}

export class ProviderUnsupportedError extends Error {
  constructor(provider: string) {
    super(`Unsupported WhatsApp provider: ${provider}`)
    this.name = 'ProviderUnsupportedError'
  }
}
