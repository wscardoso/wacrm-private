import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZApiProvider } from './zapi'
import { UazapiProvider } from './uazapi'

// =============================================================
// Outbound: sendText + sendMedia (image / document) for Z-API and uazapi.
//
// These hit `fetch`. We mock global fetch and assert the URL, method,
// headers and JSON body each provider emits — verifying the wire format
// (Z-API flat `phone`/`message`/`send-image`; uazapi Evolution `number`/
// `mediatype`/`media` + apikey header) without real network calls.
// =============================================================

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: any
}

let captured: Captured | null = null
const fetchMock = vi.fn(async (url: string | URL | Request, init?: any) => {
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

const zapi = new ZApiProvider({ instanceId: 'inst-123', token: 'tok-456' })
const uazapi = new UazapiProvider({ baseUrl: 'https://my.uazapi.dev', instanceId: 'inst', token: 'apikey-1' })

describe('Z-API outbound', () => {
  it('sendText posts to /send-text with phone + message', async () => {
    const res = await zapi.sendText({ to: '5511999887766', text: 'Oi' })
    expect(res.messageId).toBe('id-1')
    expect(captured?.url).toBe('https://api.z-api.io/instances/inst-123/token/tok-456/send-text')
    expect(captured?.method).toBe('POST')
    expect(captured?.body).toMatchObject({ phone: '5511999887766', message: 'Oi' })
  })

  it('sendText forwards contextMessageId as messageId', async () => {
    await zapi.sendText({ to: '5511999887766', text: 'resp', contextMessageId: 'ctx-9' })
    expect(captured?.body.messageId).toBe('ctx-9')
  })

  it('sendMedia image posts to /send-image with image link + caption', async () => {
    await zapi.sendMedia({ to: '5511999887766', kind: 'image', link: 'https://img/x.jpg', caption: 'legenda' })
    expect(captured?.url).toBe('https://api.z-api.io/instances/inst-123/token/tok-456/send-image')
    expect(captured?.body).toMatchObject({ phone: '5511999887766', image: 'https://img/x.jpg', caption: 'legenda' })
    expect(captured?.body.fileName).toBeUndefined()
  })

  it('sendMedia document posts to /send-document with fileName', async () => {
    await zapi.sendMedia({ to: '5511999887766', kind: 'document', link: 'https://img/f.pdf', filename: 'f.pdf' })
    expect(captured?.url).toBe('https://api.z-api.io/instances/inst-123/token/tok-456/send-document')
    expect(captured?.body).toMatchObject({ document: 'https://img/f.pdf', fileName: 'f.pdf' })
  })

  it('sendMedia video posts to /send-video', async () => {
    await zapi.sendMedia({ to: '5511999887766', kind: 'video', link: 'https://img/v.mp4' })
    expect(captured?.url).toContain('/send-video')
  })

  it('sendMedia audio posts to /send-audio', async () => {
    await zapi.sendMedia({ to: '5511999887766', kind: 'audio', link: 'https://img/a.ogg' })
    expect(captured?.url).toContain('/send-audio')
  })
})

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
