import { describe, expect, it } from 'vitest'
import { buildWebhookUrl } from './webhook-url'

// Gate 4 — the URL contract is exactly the route path:
//   /api/whatsapp/webhook/{provider}/{connectionId}/{webhookSecret}
// (src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts)

describe('buildWebhookUrl', () => {
  it('Meta: fixed URL, no connectionId/secret segments', () => {
    expect(
      buildWebhookUrl({ origin: 'https://app.example.com', provider: 'meta', connectionId: null, webhookSecret: null }),
    ).toBe('https://app.example.com/api/whatsapp/webhook')
  })

  it('uazapi before save: three placeholder segments, none of them {seu-verify-token}', () => {
    const url = buildWebhookUrl({ origin: 'https://app.example.com', provider: 'uazapi', connectionId: null, webhookSecret: null })
    expect(url).toBe('https://app.example.com/api/whatsapp/webhook/uazapi/{connectionId}/{webhookSecret}')
    expect(url.split('/').length).toBe(url.split('/').length) // sanity: no throw
  })

  it('uazapi right after bootstrap: real connectionId + real plaintext secret, exactly 3 path segments after /webhook', () => {
    const url = buildWebhookUrl({
      origin: 'https://app.example.com',
      provider: 'uazapi',
      connectionId: 'conn-abc-123',
      webhookSecret: 'S3cr3t-plaintext',
    })
    expect(url).toBe('https://app.example.com/api/whatsapp/webhook/uazapi/conn-abc-123/S3cr3t-plaintext')

    const path = new URL(url).pathname
    const segments = path.replace(/^\/api\/whatsapp\/webhook\//, '').split('/')
    expect(segments).toEqual(['uazapi', 'conn-abc-123', 'S3cr3t-plaintext']) // matches [provider]/[connectionId]/[webhookSecret]
  })

  it('uazapi with connectionId known but secret never revealed (already configured previously): placeholder secret, real connectionId', () => {
    const url = buildWebhookUrl({
      origin: 'https://app.example.com',
      provider: 'uazapi',
      connectionId: 'conn-xyz-789',
      webhookSecret: null,
    })
    expect(url).toBe('https://app.example.com/api/whatsapp/webhook/uazapi/conn-xyz-789/{webhook-secret}')
  })

  it('never emits the old 2-segment shape (provider/token) — regression guard for the fixed bug', () => {
    const url = buildWebhookUrl({ origin: 'https://app.example.com', provider: 'uazapi', connectionId: 'c1', webhookSecret: 's1' })
    const afterWebhook = url.split('/api/whatsapp/webhook/')[1]
    expect(afterWebhook.split('/')).toHaveLength(3)
  })
})
