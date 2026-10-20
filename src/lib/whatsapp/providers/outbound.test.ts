import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UazapiProvider } from './uazapi'

// =============================================================
// Outbound: sendText + sendMedia (image / document) for uazapi.
//
// These hit `fetch`. We mock global fetch and assert the URL, method,
// headers and JSON body the provider emits — verifying the wire format
// (uazapi Evolution `number`/`mediatype`/`media` + apikey header) without
// real network calls.
// =============================================================

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

let captured: Captured | null = null
const fetchMock = vi.fn(async (url: string | URL | Request, // eslint-disable-next-line @typescript-eslint/no-explicit-any
init?: any) => {
  captured = {
    url: url.toString(),
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: init?.body ? JSON.parse(init.body) : undefined,
  }
  return new Response(
    JSON.stringify({ zaapId: 'id-1', messageId: 'id-1', key: { id: 'id-1' } }),
    { status: 200 },
  )
})

beforeEach(() => {
  captured = null
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

const uazapi = new UazapiProvider({ baseUrl: 'https://my.uazapi.dev', instanceId: 'inst', token: 'apikey-1' })

describe('uazapi outbound', () => {
  it('sendText posts to /message/sendText with number@s.whatsapp.net + textMessage', async () => {
    const res = await uazapi.sendText({ to: '5511999887766', text: 'Oi' })
    expect(res.messageId).toBe('id-1')
    expect(captured?.url).toBe('https://my.uazapi.dev/message/sendText/inst')
    expect(captured?.method).toBe('POST')
    expect(captured?.headers.apikey).toBe('apikey-1')
    expect(captured?.body).toMatchObject({
      number: '5511999887766@s.whatsapp.net',
      textMessage: { text: 'Oi' },
    })
  })

  it('sendText forwards contextMessageId as quoted key', async () => {
    await uazapi.sendText({ to: '5511999887766', text: 'resp', contextMessageId: 'ctx-9' })
    expect(captured?.body.quoted).toEqual({ key: { id: 'ctx-9' } })
  })

  it('sendMedia image posts to /message/sendMedia with mediatype IMAGE + media link', async () => {
    await uazapi.sendMedia({ to: '5511999887766', kind: 'image', link: 'https://m/x.jpg', caption: 'c' })
    expect(captured?.url).toBe('https://my.uazapi.dev/message/sendMedia/inst')
    expect(captured?.body).toMatchObject({
      number: '5511999887766@s.whatsapp.net',
      mediatype: 'IMAGE',
      media: 'https://m/x.jpg',
      caption: 'c',
    })
  })

  it('sendMedia document posts to /message/sendMedia with mediatype DOCUMENT + fileName', async () => {
    await uazapi.sendMedia({ to: '5511999887766', kind: 'document', link: 'https://m/f.pdf', filename: 'f.pdf' })
    expect(captured?.url).toBe('https://my.uazapi.dev/message/sendMedia/inst')
    expect(captured?.body).toMatchObject({ mediatype: 'DOCUMENT', media: 'https://m/f.pdf', fileName: 'f.pdf' })
  })

  it('sendMedia video posts to /message/sendMedia with mediatype VIDEO', async () => {
    await uazapi.sendMedia({ to: '5511999887766', kind: 'video', link: 'https://m/v.mp4' })
    expect(captured?.body.mediatype).toBe('VIDEO')
  })

  it('sendMedia audio posts to /message/sendWhatsAppAudio with mediatype AUDIO', async () => {
    await uazapi.sendMedia({ to: '5511999887766', kind: 'audio', link: 'https://m/a.ogg' })
    expect(captured?.url).toBe('https://my.uazapi.dev/message/sendWhatsAppAudio/inst')
    expect(captured?.body.mediatype).toBe('AUDIO')
  })
})
