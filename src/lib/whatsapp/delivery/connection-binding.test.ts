import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  bindingFromConnection,
  computeChannelFingerprint,
  deliveryProviderOf,
  evaluateBinding,
  DeliveryBindingError,
  type ConnectionIdentityRow,
  type StoredBinding,
} from './connection-binding'

const ID = '00000000-0000-4000-8000-0000000000c1'
const ACC = 'acc-1'
const meta = (over: Partial<ConnectionIdentityRow> = {}): ConnectionIdentityRow => ({
  id: ID, account_id: ACC, provider: 'meta', phone_number_id: '123456789', instance_id: null, base_url: null, ...over,
})
const uaz = (over: Partial<ConnectionIdentityRow> = {}): ConnectionIdentityRow => ({
  id: ID, account_id: ACC, provider: 'uazapi', phone_number_id: 'inst', instance_id: 'inst', base_url: 'https://my.uazapi.dev', ...over,
})
const sha = (payload: unknown[]) => 'v1:' + createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')

describe('computeChannelFingerprint — format contract v1 (known answers)', () => {
  it('meta: sha256 over the JSON array ["v1","meta",phone_number_id]', () => {
    expect(computeChannelFingerprint(meta())).toBe(sha(['v1', 'meta', '123456789']))
    // frozen literal: changing the serialisation silently would unbind every existing message
    expect(computeChannelFingerprint(meta())).toBe('v1:' + createHash('sha256').update('["v1","meta","123456789"]').digest('hex'))
  })

  it('uazapi: sha256 over ["v1","uazapi",instance_id,normalised base_url]', () => {
    expect(computeChannelFingerprint(uaz())).toBe(sha(['v1', 'uazapi', 'inst', 'https://my.uazapi.dev']))
  })

  it('the provider defaults to meta, like the column', () => {
    expect(computeChannelFingerprint(meta({ provider: null }))).toBe(computeChannelFingerprint(meta()))
    expect(deliveryProviderOf({})).toBe('meta')
  })

  it('has the shape `v1:` + 64 lower-case hex', () => {
    expect(computeChannelFingerprint(meta())).toMatch(/^v1:[0-9a-f]{64}$/)
  })
})

describe('computeChannelFingerprint — what must and must not change it', () => {
  it('is stable under token rotation: tokens, verify tokens and waba_id are not inputs', () => {
    const base = computeChannelFingerprint(meta())
    const withSecrets = { ...meta(), access_token: 'rotated', verify_token: 'x', waba_id: 'other-waba' } as ConnectionIdentityRow
    expect(computeChannelFingerprint(withSecrets)).toBe(base)
  })

  it('changes with provider, number, instance or endpoint', () => {
    const m = computeChannelFingerprint(meta())
    expect(computeChannelFingerprint(meta({ phone_number_id: '999' }))).not.toBe(m)
    expect(computeChannelFingerprint(uaz())).not.toBe(m)
    const u = computeChannelFingerprint(uaz())
    expect(computeChannelFingerprint(uaz({ instance_id: 'other' }))).not.toBe(u)
    expect(computeChannelFingerprint(uaz({ base_url: 'https://other.uazapi.dev' }))).not.toBe(u)
    expect(computeChannelFingerprint(uaz({ base_url: 'http://my.uazapi.dev' }))).not.toBe(u)
    expect(computeChannelFingerprint(uaz({ base_url: 'https://my.uazapi.dev:8443' }))).not.toBe(u)
    expect(computeChannelFingerprint(uaz({ base_url: 'https://my.uazapi.dev/v2' }))).not.toBe(u)
  })

  it('ignores the columns of the OTHER provider (stale values left by an earlier provider)', () => {
    expect(computeChannelFingerprint(meta({ instance_id: 'stale', base_url: 'https://stale.example' }))).toBe(computeChannelFingerprint(meta()))
    expect(computeChannelFingerprint(uaz({ phone_number_id: 'whatever' }))).toBe(computeChannelFingerprint(uaz()))
  })

  it('normalises cosmetic differences: surrounding whitespace, URL case, trailing slash, default port, userinfo, query and hash', () => {
    const u = computeChannelFingerprint(uaz())
    expect(computeChannelFingerprint(uaz({ base_url: '  HTTPS://My.UAZAPI.dev/  ' }))).toBe(u)
    expect(computeChannelFingerprint(uaz({ base_url: 'https://my.uazapi.dev:443' }))).toBe(u)
    expect(computeChannelFingerprint(uaz({ base_url: 'https://user:pw@my.uazapi.dev/?a=1#h' }))).toBe(u)
    expect(computeChannelFingerprint(uaz({ instance_id: ' inst ' }))).toBe(u)
    expect(computeChannelFingerprint(meta({ phone_number_id: ' 123456789 ' }))).toBe(computeChannelFingerprint(meta()))
  })

  it('a credential embedded in the URL never reaches the hash input', () => {
    const a = computeChannelFingerprint(uaz({ base_url: 'https://user:SECRET@my.uazapi.dev' }))
    const b = computeChannelFingerprint(uaz({ base_url: 'https://other:DIFFERENT@my.uazapi.dev' }))
    expect(a).toBe(b)
  })

  it('field boundaries are unambiguous (no concatenation collisions)', () => {
    expect(computeChannelFingerprint(uaz({ instance_id: 'a', base_url: 'https://b.example' })))
      .not.toBe(computeChannelFingerprint(uaz({ instance_id: 'a,"https://b', base_url: 'https://example' })))
  })

  it('NFC-normalises text so equivalent unicode forms agree', () => {
    expect(computeChannelFingerprint(uaz({ instance_id: 'café' }))).toBe(computeChannelFingerprint(uaz({ instance_id: 'café' })))
  })
})

describe('computeChannelFingerprint — fails safe on missing or invalid data (no placeholders)', () => {
  it.each([
    ['meta without phone_number_id', meta({ phone_number_id: null })],
    ['meta with a blank phone_number_id', meta({ phone_number_id: '   ' })],
    ['uazapi without instance_id', uaz({ instance_id: null })],
    ['uazapi without base_url', uaz({ base_url: null })],
    ['uazapi with a blank instance_id', uaz({ instance_id: '' })],
    ['uazapi with an invalid URL', uaz({ base_url: 'not a url' })],
    ['uazapi with a non-http(s) URL', uaz({ base_url: 'ftp://my.uazapi.dev' })],
    ['an unsupported provider', meta({ provider: 'zapi' })],
    ['an unknown provider', meta({ provider: 'evolution' })],
    ['an empty provider string', meta({ provider: '' })],
  ])('%s → DeliveryBindingError', (_n, row) => {
    expect(() => computeChannelFingerprint(row)).toThrow(DeliveryBindingError)
  })

  it('absent data cannot collide with a legitimate value', () => {
    expect(() => computeChannelFingerprint(meta({ phone_number_id: null }))).toThrow()
    expect(computeChannelFingerprint(meta({ phone_number_id: 'null' }))).toMatch(/^v1:/)
  })
})

describe('bindingFromConnection', () => {
  it('returns the three persisted fields', () => {
    expect(bindingFromConnection(meta())).toEqual({
      connection_ref: ID,
      delivery_provider: 'meta',
      delivery_channel_fp: computeChannelFingerprint(meta()),
    })
    expect(bindingFromConnection(uaz()).delivery_provider).toBe('uazapi')
  })

  it.each(['', 'cfg-1', 'not-a-uuid'])('rejects a connection id that is not a uuid (%j)', (id) => {
    expect(() => bindingFromConnection(meta({ id }))).toThrow(DeliveryBindingError)
  })
})

describe('evaluateBinding — the retry gate', () => {
  const stored = (row: ConnectionIdentityRow) => {
    const b = bindingFromConnection(row)
    return { connection_ref: b.connection_ref, delivery_provider: b.delivery_provider, delivery_channel_fp: b.delivery_channel_fp }
  }
  const ok = (s: StoredBinding, conn: ConnectionIdentityRow | null, account: string | null = ACC) =>
    evaluateBinding({ stored: s, conversationAccountId: account, connection: conn })

  it('proves the same channel in the same account', () => {
    expect(ok(stored(meta()), meta())).toEqual({ ok: true, provider: 'meta' })
    expect(ok(stored(uaz()), uaz())).toEqual({ ok: true, provider: 'uazapi' })
  })

  it('survives a token rotation and cosmetic URL changes', () => {
    expect(ok(stored(uaz()), uaz({ base_url: 'HTTPS://my.uazapi.dev/' })).ok).toBe(true)
  })

  it.each([
    ['all NULL', {}, 'binding_missing'],
    ['all explicit NULL', { connection_ref: null, delivery_provider: null, delivery_channel_fp: null }, 'binding_missing'],
    ['only connection_ref', { connection_ref: ID }, 'binding_invalid'],
    ['only the provider', { delivery_provider: 'meta' }, 'binding_invalid'],
    ['connection_ref not a uuid', { ...stored(meta()), connection_ref: 'cfg-1' }, 'binding_invalid'],
    ['recorded provider unsupported', { ...stored(meta()), delivery_provider: 'zapi' }, 'binding_invalid'],
    ['fingerprint without version', { ...stored(meta()), delivery_channel_fp: 'a'.repeat(64) }, 'binding_invalid'],
    ['fingerprint of an unknown version', { ...stored(meta()), delivery_channel_fp: 'v2:' + 'a'.repeat(64) }, 'binding_invalid'],
    ['fingerprint with upper-case hex', { ...stored(meta()), delivery_channel_fp: 'v1:' + 'A'.repeat(64) }, 'binding_invalid'],
    ['fingerprint truncated', { ...stored(meta()), delivery_channel_fp: 'v1:abcd' }, 'binding_invalid'],
  ])('stored binding: %s → %s', (_n, s, reason) => {
    const v = ok(s, meta())
    expect(v).toMatchObject({ ok: false, reason })
  })

  it('connection gone → connection_removed', () => {
    expect(ok(stored(meta()), null)).toMatchObject({ ok: false, reason: 'connection_removed' })
  })

  it('a different config row than the recorded one → connection_mismatch', () => {
    expect(ok(stored(meta()), meta({ id: '00000000-0000-4000-8000-0000000000c2' }))).toMatchObject({ ok: false, reason: 'connection_mismatch' })
  })

  it.each([
    ['another account', 'acc-OTHER'],
    ['no account on the conversation', null],
    ['an empty account', ''],
  ])('conversation account: %s → account_mismatch', (_n, account) => {
    expect(ok(stored(meta()), meta(), account)).toMatchObject({ ok: false, reason: 'account_mismatch' })
  })

  it('a connection without account_id is not trusted', () => {
    expect(ok(stored(meta()), meta({ account_id: null }))).toMatchObject({ ok: false, reason: 'account_mismatch' })
  })

  it('account is checked before provider: a cross-account connection is never described further', () => {
    expect(ok(stored(meta()), uaz(), 'acc-OTHER')).toMatchObject({ reason: 'account_mismatch' })
  })

  it('removed provider now → provider_unsupported; switched provider → provider_changed', () => {
    expect(ok(stored(meta()), meta({ provider: 'zapi' }))).toMatchObject({ reason: 'provider_unsupported' })
    expect(ok(stored(meta()), uaz())).toMatchObject({ reason: 'provider_changed' })
    expect(ok(stored(uaz()), meta())).toMatchObject({ reason: 'provider_changed' })
  })

  it('same provider, different number / instance / endpoint → channel_changed', () => {
    expect(ok(stored(meta()), meta({ phone_number_id: '999' }))).toMatchObject({ reason: 'channel_changed' })
    expect(ok(stored(uaz()), uaz({ instance_id: 'other' }))).toMatchObject({ reason: 'channel_changed' })
    expect(ok(stored(uaz()), uaz({ base_url: 'https://other.uazapi.dev' }))).toMatchObject({ reason: 'channel_changed' })
  })

  it('a connection that can no longer be fingerprinted → channel_unprovable (never "probably the same")', () => {
    expect(ok(stored(meta()), meta({ phone_number_id: null }))).toMatchObject({ reason: 'channel_unprovable' })
    expect(ok(stored(uaz()), uaz({ base_url: 'garbage' }))).toMatchObject({ reason: 'channel_unprovable' })
  })

  it('never puts a secret or a raw fingerprint in the verdict detail', () => {
    const v = ok(stored(meta()), meta({ phone_number_id: '999' }))
    if (v.ok) throw new Error('expected a block')
    expect(v.detail).not.toMatch(/v1:|[0-9a-f]{64}|999|123456789/)
  })
})
