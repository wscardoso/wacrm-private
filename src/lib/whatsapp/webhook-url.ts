/**
 * ADR-SEC-001 (C7) — non-Meta webhook URL contract.
 *
 *   /api/whatsapp/webhook/{provider}/{connectionId}/{webhookSecret}
 *
 * Pure builder extracted from the settings UI so the exact string the
 * operator is told to paste into Z-API/uazapi can be unit-tested against
 * the real route path (src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts)
 * without rendering the component.
 */

export interface WebhookUrlArgs {
  origin: string
  provider: 'meta' | 'zapi' | 'uazapi'
  /** whatsapp_config.connection_id, once the connection has been saved. */
  connectionId: string | null | undefined
  /** Plaintext secret from bootstrapConnection(), revealed exactly once. */
  webhookSecret: string | null | undefined
}

export function buildWebhookUrl({ origin, provider, connectionId, webhookSecret }: WebhookUrlArgs): string {
  if (provider === 'meta') {
    return `${origin}/api/whatsapp/webhook`
  }
  if (!connectionId) {
    return `${origin}/api/whatsapp/webhook/${provider}/{connectionId}/{webhookSecret}`
  }
  return `${origin}/api/whatsapp/webhook/${provider}/${connectionId}/${webhookSecret ?? '{webhook-secret}'}`
}
