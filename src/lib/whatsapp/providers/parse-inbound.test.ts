import { describe, expect, it } from 'vitest'
import { UazapiProvider } from './uazapi'

// =============================================================
// Fixtures — faithful to the provider's documented webhook shape.
// uazapi (Evolution-compatible): `{ event, data: { messages: [{ key, message }] } }`.
// =============================================================

const uazapiBase = () =>
  new UazapiProvider({ baseUrl: 'https://my.uazapi.dev', instanceId: 'inst', token: 'key' })

describe('parseInboundMessage — uazapi (Evolution-compatible)', () => {
  const p = uazapiBase()

  // Helper: wrap a single message in the standard uazapi envelope.
  const envelope = (msg: Record<string, unknown>) => ({
    event: 'MESSAGES_UPSERT',
    data: { messages: [msg] },
  })

  it('parses a plain conversation text message', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-1', fromMe: false },
        pushName: 'Alice',
        messageTimestamp: 1710000000,
        message: { conversation: 'Oi' },
      }),
    )
    expect(msg).toMatchObject({
      messageId: 'evt-1',
      from: '5511999887766',
      senderName: 'Alice',
      timestamp: '1710000000',
      type: 'text',
      text: 'Oi',
      mediaRefIsUrl: true,
    })
  })

  it('parses an image with caption (url field)', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-img' },
        messageTimestamp: 1710000000,
        message: {
          imageMessage: {
            url: 'https://uazapi.dev/media/img.jpg',
            caption: 'foto',
            mimetype: 'image/jpeg',
          },
        },
      }),
    )
    expect(msg).toMatchObject({
      type: 'image',
      mediaRef: 'https://uazapi.dev/media/img.jpg',
      caption: 'foto',
      mimeType: 'image/jpeg',
    })
  })

  it('parses a document (url + fileName)', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-doc' },
        messageTimestamp: 1710000000,
        message: {
          documentMessage: {
            url: 'https://uazapi.dev/media/file.pdf',
            fileName: 'doc.pdf',
            mimetype: 'application/pdf',
          },
        },
      }),
    )
    expect(msg).toMatchObject({
      type: 'document',
      mediaRef: 'https://uazapi.dev/media/file.pdf',
      filename: 'doc.pdf',
    })
  })

  it('parses a video with caption', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-vid' },
        messageTimestamp: 1710000000,
        message: {
          videoMessage: {
            url: 'https://uazapi.dev/media/v.mp4',
            caption: 'vídeo',
            mimetype: 'video/mp4',
          },
        },
      }),
    )
    expect(msg).toMatchObject({ type: 'video', mediaRef: 'https://uazapi.dev/media/v.mp4', caption: 'vídeo' })
  })

  it('parses an audio message', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-aud' },
        messageTimestamp: 1710000000,
        message: { audioMessage: { url: 'https://uazapi.dev/media/a.ogg', mimetype: 'audio/ogg' } },
      }),
    )
    expect(msg).toMatchObject({ type: 'audio', mediaRef: 'https://uazapi.dev/media/a.ogg', mimeType: 'audio/ogg' })
  })

  it('parses a reaction (target id + text)', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-react' },
        messageTimestamp: 1710000000,
        message: {
          reactionMessage: {
            key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-target' },
            text: '❤️',
          },
        },
      }),
    )
    expect(msg).toMatchObject({
      type: 'reaction',
      reactionTargetMessageId: 'evt-target',
      reactionEmoji: '❤️',
    })
  })

  it('parses a buttons response', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-btn' },
        messageTimestamp: 1710000000,
        message: {
          buttonsResponseMessage: { selectedButtonId: 'yes', selectedDisplayText: 'Sim' },
        },
      }),
    )
    expect(msg).toMatchObject({
      type: 'interactive',
      interactiveReplyType: 'button_reply',
      interactiveReplyId: 'yes',
      interactiveReplyTitle: 'Sim',
    })
  })

  it('parses a list response', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-list' },
        messageTimestamp: 1710000000,
        message: {
          listResponseMessage: { selectedRowId: 'row-2', title: 'Segunda opção' },
        },
      }),
    )
    expect(msg).toMatchObject({
      type: 'interactive',
      interactiveReplyType: 'list_reply',
      interactiveReplyId: 'row-2',
      interactiveReplyTitle: 'Segunda opção',
    })
  })

  it('captures contextMessageId from contextInfo.stanzaId', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-q' },
        messageTimestamp: 1710000000,
        contextInfo: { stanzaId: 'evt-quoted' },
        message: { conversation: 'respondendo' },
      }),
    )
    expect(msg?.contextMessageId).toBe('evt-quoted')
  })

  it('returns null for a message sent by Me (fromMe)', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-me', fromMe: true },
        message: { conversation: 'eu' },
      }),
    )
    expect(msg).toBeNull()
  })

  it('returns null when key is absent', () => {
    const msg = p.parseInboundMessage(envelope({ message: { conversation: 'hi' } }))
    expect(msg).toBeNull()
  })

  it('strips the @g.us suffix for group JIDs', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '120363040157862268@g.us', id: 'evt-g' },
        messageTimestamp: 1710000000,
        message: { conversation: 'hi' },
      }),
    )
    expect(msg?.from).toBe('120363040157862268')
  })

  it('parses an extendedTextMessage (quoted/extended text)', () => {
    const msg = p.parseInboundMessage(
      envelope({
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-ext' },
        messageTimestamp: 1710000000,
        message: {
          extendedTextMessage: { text: 'texto estendido' },
        },
      }),
    )
    expect(msg).toMatchObject({ type: 'text', text: 'texto estendido' })
  })
})
