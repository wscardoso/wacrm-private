import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UazapiProvider } from './uazapi'

// =============================================================
// What the uazapi adapter hands to settlement when the HTTP call SUCCEEDED
// (2xx) — in particular when the body carries no message id.
//
// ⚠️ The response shapes below are SYNTHETIC. No real uazapi send response has
// been captured (docs/architecture/E2.1-RC1-canonical-status-adjudication.md
// R1, ADR-MSG-STATUS-001). They pin the adapter's contract, not uazapi's.
// =============================================================

const uazapi = new UazapiProvider({ baseUrl: 'https://my.uazapi.dev', instanceId: 'inst', token: 'apikey-1' })

function respondWith(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('uazapi send — 2xx response with a message id', () => {
  it('declares the id as a provider_message_id identity', async () => {
    respondWith({ key: { id: '3EB0AAAA' } })
    const r = await uazapi.sendText({ to: '5511999887766', text: 'oi' })
    expect(r.messageId).toBe('3EB0AAAA')
    expect(r.externalIdentities).toEqual([{ kind: 'provider_message_id', value: '3EB0AAAA' }])
  })
})

describe('uazapi send — 2xx response WITHOUT a message id', () => {
  const shapes: Array<[string, unknown]> = [
    ['empty object', {}],
    ['no key', { status: 'PENDING' }],
    ['key without id', { key: { remoteJid: '5511999887766@s.whatsapp.net' } }],
    ['null body', null],
  ]

  for (const [label, body] of shapes) {
    it(`(${label}) declares NO external identity — an empty value must never reach message_external_ids`, async () => {
      respondWith(body)
      const r = await uazapi.sendText({ to: '5511999887766', text: 'oi' })
      // The unique index is (connection_ref, kind, value): the second message
      // of a connection with value '' would violate it and fail to settle.
      expect(r.externalIdentities).toEqual([])
      expect(r.messageId).toBe('')
    })
  }

  it('the same holds for media and reactions', async () => {
    respondWith({})
    const media = await uazapi.sendMedia({ to: '5511999887766', kind: 'image', link: 'https://m/x.jpg' })
    const reaction = await uazapi.sendReaction({ to: '5511999887766', targetMessageId: 'abc', emoji: '👍' })
    expect(media.externalIdentities).toEqual([])
    expect(reaction.externalIdentities).toEqual([])
  })

  it('leaves a warning so the missing id is observable (without the body, which may hold PII)', async () => {
    respondWith({ key: {}, note: 'recipient 5511999887766' })
    await uazapi.sendText({ to: '5511999887766', text: 'oi' })
    const warned = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c.join(' ')).join(' | ')
    expect(warned).toContain('[uazapi]')
    expect(warned).toContain('message id')
    expect(warned).not.toContain('5511999887766')
  })
})
