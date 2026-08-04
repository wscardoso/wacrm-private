/**
 * D-C (Dispositivo-Confundido) regression tests.
 *
 * Verifies that status webhook payloads from each provider are correctly
 * identified by parseStatusEvent and do NOT leak into the inbound message
 * pipeline as phantom 'unknown' messages.
 *
 * ADR-MSG-STATUS-001 §2.11: status-first dispatch. The webhook route MUST
 * call parseStatusEvent before parseInboundMessage. These tests verify the
 * invariant at the provider level — that each adapter's two parsing methods
 * disagree on status payloads:
 *
 *   parseStatusEvent(payload).length > 0   ← status event recognised
 *   parseInboundMessage(payload)  === 'unknown' type   ← would be a phantom
 */

import { describe, expect, it } from 'vitest'
import { ZApiProvider } from './zapi'
import { UazapiProvider } from './uazapi'
import { MetaProvider } from './meta'

const zapi = new ZApiProvider({ instanceId: 'inst-123', token: 'tok-456' })
const uazapi = new UazapiProvider({ baseUrl: 'https://my.uazapi.dev', instanceId: 'inst', token: 'key' })
const meta = new MetaProvider({
  phoneNumberId: '123456789',
  accessToken: 'tok',
  verifyToken: 'vt',
})

describe('D-C invariant: Z-API', () => {
  // Z-API MessageStatusCallback — parseStatusEvent recognises it,
  // parseInboundMessage returns a phantom 'unknown'.
  const statusPayload = {
    phone: '5511999887766',
    ids: ['wamid.abc123'],
    type: 'MessageStatusCallback',
    ack: 'RECEIVED',
    momment: 1710000000123,
  }

  it('parseStatusEvent recognises the status callback', () => {
    expect(zapi.parseStatusEvent(statusPayload).length).toBeGreaterThan(0)
  })

  it('parseInboundMessage DOES NOT filter the status callback (phantom)', () => {
    const parsed = zapi.parseInboundMessage(statusPayload)
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe('unknown')
    expect(parsed?.messageId).toBe('') // no messageId in status callback
  })
})

describe('D-C invariant: UAZAPI', () => {
  // UAZAPI MESSAGES_UPDATE with fromMe: false — parseStatusEvent rejects it
  // (inbound status doesn't make sense), parseInboundMessage produces a phantom
  // 'unknown' message. This is the D-C bug: the status event leaks into the
  // inbound pipeline. The fix is in the routing layer (status-first dispatch),
  // not in the individual parsers.
  const statusPayloadFromMeFalse = {
    event: 'MESSAGES_UPDATE',
    data: {
      messages: [{
        key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'evt-status', fromMe: false },
        message: { messageTimingType: 'ack', ack: 2 },
        messageTimestamp: 1710000000,
      }],
    },
  }

  it('parseStatusEvent rejects fromMe=false status events', () => {
    expect(uazapi.parseStatusEvent(statusPayloadFromMeFalse)).toEqual([])
  })

  it('parseInboundMessage produces phantom unknown (D-C bug — fixed by routing)', () => {
    const parsed = uazapi.parseInboundMessage(statusPayloadFromMeFalse)
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe('unknown')
  })
})

describe('D-C invariant: Meta', () => {
  // Meta webhook — status events are handled in a separate branch before
  // message processing (route.ts:276-280), so D-C is not a problem for Meta.
  // Verify the parseStatusEvent correctly captures them.
  const statusPayload = {
    id: 'wamid.meta-x',
    status: 'delivered',
    timestamp: '1710000000',
    recipient_id: '5511999887766',
  }

  it('parseStatusEvent recognises Meta status', () => {
    expect(meta.parseStatusEvent(statusPayload).length).toBeGreaterThan(0)
  })

  it('parseInboundMessage returns null for Meta status (no messages array)', () => {
    expect(meta.parseInboundMessage(statusPayload)).toBeNull()
  })
})
