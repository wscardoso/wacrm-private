import { describe, expect, it } from 'vitest'
import { ZApiProvider } from './zapi'
import { UazapiProvider } from './uazapi'
import { MetaProvider } from './meta'

// =============================================================
// PROVENANCE OF THESE FIXTURES — read before trusting them.
//
// Meta:   VERIFIED. This is the `statuses[]` object the production
//         webhook has consumed since day one (webhook/route.ts:276).
//
// Z-API:  *** INFERRED, NOT OBSERVED. *** No real MessageStatusCallback
//         has ever been captured. CHECKPOINT-E2.1-STATUS-CANONICAL §8
//         pré-condição 1 ("capturar payload real ... antes de escrever
//         código") is UNSATISFIED: whatsapp_webhook_dlq is empty (0 rows,
//         measured 2026-07-29), no webhook log exists, and only the
//         "Ao receber" webhook was ever pointed at our endpoint.
//         ADR §2.2 documents the value field as `status`; the first
//         implementation assumed `ack`. The adapter reads BOTH until a
//         real payload settles it — so these fixtures exercise both
//         shapes deliberately.
//
// uazapi: *** INFERRED, NOT OBSERVED. *** No uazapi tenant currently has
//         a connected number. Shape taken from the Evolution/Baileys
//         contract.
//
// Green tests here prove internal consistency, NOT wire correctness for
// Z-API and uazapi. They must be re-run against captured payloads before
// the D-C fix can be called verified.
// =============================================================

const zapi = new ZApiProvider({ instanceId: 'inst-123', token: 'tok-456' })
const uazapi = new UazapiProvider({
  baseUrl: 'https://my.uazapi.dev',
  instanceId: 'inst',
  token: 'key',
})
const meta = new MetaProvider({
  phoneNumberId: '123456789',
  accessToken: 'tok',
  verifyToken: 'vt',
})

describe('ZApiProvider.parseStatusEvent (D9 map)', () => {
  const base = { phone: '5511999887766', momment: 1710000000123 }

  it('maps SENT -> sent', () => {
    expect(zapi.parseStatusEvent({ ...base, ids: ['w.1'], status: 'SENT' })).toEqual([
      { externalId: 'w.1', status: 'sent', timestamp: '1710000000123' },
    ])
  })

  // R1 — the highest-severity trap in the whole map.
  it('maps RECEIVED -> delivered, NEVER received', () => {
    const [event] = zapi.parseStatusEvent({ ...base, ids: ['w.1'], status: 'RECEIVED' })
    expect(event.status).toBe('delivered')
    expect(event.status).not.toBe('received')
  })

  it('maps READ -> read', () => {
    const [event] = zapi.parseStatusEvent({ ...base, ids: ['w.1'], status: 'READ' })
    expect(event.status).toBe('read')
  })

  // D4 — lower-granularity collapse: PLAYED adds no canonical state.
  it('collapses PLAYED into read', () => {
    const [event] = zapi.parseStatusEvent({ ...base, ids: ['w.1'], status: 'PLAYED' })
    expect(event.status).toBe('read')
  })

  it('reads the legacy `ack` field too, while the wire shape is unverified', () => {
    const [event] = zapi.parseStatusEvent({ ...base, ids: ['w.1'], ack: 'RECEIVED' })
    expect(event.status).toBe('delivered')
  })

  // I5 — N identifiers become N independent applications.
  it('emits one event per id in ids[]', () => {
    const events = zapi.parseStatusEvent({
      ...base,
      ids: ['w.1', 'w.2', 'w.3'],
      status: 'READ',
    })
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.externalId)).toEqual(['w.1', 'w.2', 'w.3'])
    expect(events.every((e) => e.status === 'read')).toBe(true)
  })

  it('discriminates on the envelope type when present', () => {
    expect(
      zapi.parseStatusEvent({
        ...base,
        type: 'ReceivedCallback',
        ids: ['w.1'],
        status: 'READ',
      }),
    ).toEqual([])
  })

  // D9/N3 + A6 — unknown never becomes failed.
  it('drops an unmapped status value without guessing failed', () => {
    expect(zapi.parseStatusEvent({ ...base, ids: ['w.1'], status: 'WAT' })).toEqual([])
  })

  it('returns empty for an inbound message payload', () => {
    expect(
      zapi.parseStatusEvent({ phone: '55119', messageId: 'w.9', text: { message: 'oi' } }),
    ).toEqual([])
  })

  it('returns empty for an empty ids array', () => {
    expect(zapi.parseStatusEvent({ ...base, ids: [], status: 'READ' })).toEqual([])
  })
})

describe('UazapiProvider.parseStatusEvent (D9 map)', () => {
  const envelope = (messages: unknown[]) => ({
    event: 'MESSAGES_UPDATE',
    data: { messages },
  })
  const ackMsg = (id: string, ack: number) => ({
    key: { id, fromMe: true, remoteJid: '55119@s.whatsapp.net' },
    message: { messageTimingType: 'ack', ack },
    messageTimestamp: 1710000000,
  })

  it('maps ack 2 -> sent, 3 -> delivered, 4 -> read', () => {
    expect(uazapi.parseStatusEvent(envelope([ackMsg('a', 2)]))[0].status).toBe('sent')
    expect(uazapi.parseStatusEvent(envelope([ackMsg('a', 3)]))[0].status).toBe('delivered')
    expect(uazapi.parseStatusEvent(envelope([ackMsg('a', 4)]))[0].status).toBe('read')
  })

  it('collapses ack 5 (played) into read (D4)', () => {
    expect(uazapi.parseStatusEvent(envelope([ackMsg('a', 5)]))[0].status).toBe('read')
  })

  it('maps ack 0 -> failed', () => {
    expect(uazapi.parseStatusEvent(envelope([ackMsg('a', 0)]))[0].status).toBe('failed')
  })

  // D9 normative map: 1 is declared NON-APPLICABLE, not a transition.
  it('does not transition on ack 1 (pending, pre-acceptance)', () => {
    expect(uazapi.parseStatusEvent(envelope([ackMsg('a', 1)]))).toEqual([])
  })

  // D5/D9 — the domain must never receive a provider time unit.
  it('normalises Baileys seconds to milliseconds', () => {
    const [event] = uazapi.parseStatusEvent(envelope([ackMsg('a', 3)]))
    expect(event.timestamp).toBe('1710000000000')
  })

  // I5 — batch of N updates becomes N applications.
  it('emits one event per message in the batch', () => {
    const events = uazapi.parseStatusEvent(
      envelope([ackMsg('a', 3), ackMsg('b', 4), ackMsg('c', 2)]),
    )
    expect(events.map((e) => [e.externalId, e.status])).toEqual([
      ['a', 'delivered'],
      ['b', 'read'],
      ['c', 'sent'],
    ])
  })

  it('one unmapped entry does not suppress the others', () => {
    const events = uazapi.parseStatusEvent(
      envelope([ackMsg('a', 3), ackMsg('b', 99), ackMsg('c', 4)]),
    )
    expect(events.map((e) => e.externalId)).toEqual(['a', 'c'])
  })

  it('ignores inbound (fromMe false) — status only exists for outbound', () => {
    const inboundAck = {
      key: { id: 'x', fromMe: false },
      message: { messageTimingType: 'ack', ack: 3 },
      messageTimestamp: 1710000000,
    }
    expect(uazapi.parseStatusEvent(envelope([inboundAck]))).toEqual([])
  })

  it('returns empty for a non-MESSAGES_UPDATE event', () => {
    expect(
      uazapi.parseStatusEvent({ event: 'MESSAGES_UPSERT', data: { messages: [] } }),
    ).toEqual([])
  })
})

describe('MetaProvider.parseStatusEvent (D9 map, verified shape)', () => {
  const status = (s: string) => ({
    id: 'wamid.HBg',
    status: s,
    timestamp: '1710000000',
    recipient_id: '55119',
  })

  it('maps the four values Meta actually emits', () => {
    expect(meta.parseStatusEvent(status('sent'))[0].status).toBe('sent')
    expect(meta.parseStatusEvent(status('delivered'))[0].status).toBe('delivered')
    expect(meta.parseStatusEvent(status('read'))[0].status).toBe('read')
    expect(meta.parseStatusEvent(status('failed'))[0].status).toBe('failed')
  })

  // ADR §2.2 — Meta emits no `pending`; a map entry for it would describe
  // a vocabulary that does not exist.
  it('has no mapping for a Meta `pending` — it is not part of the wire vocabulary', () => {
    expect(meta.parseStatusEvent(status('pending'))).toEqual([])
  })

  it('normalises Meta seconds to milliseconds', () => {
    expect(meta.parseStatusEvent(status('read'))[0].timestamp).toBe('1710000000000')
  })

  it('drops unmapped values (e.g. deleted) without guessing failed', () => {
    expect(meta.parseStatusEvent(status('deleted'))).toEqual([])
  })

  it('returns empty for a payload with no status', () => {
    expect(meta.parseStatusEvent({ id: 'wamid.x' })).toEqual([])
  })
})
