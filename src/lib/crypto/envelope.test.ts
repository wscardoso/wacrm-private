import { describe, it, expect } from 'vitest'
import {
  CANONICAL_VERSION,
  encodeBase64url,
  decodeBase64url,
  serializeCanonical,
  parseCanonical,
  buildAAD,
  recognizeFormat,
  type EnvelopeParams,
} from './envelope'
import crypto from 'crypto'

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeEnvelope(overrides?: Partial<EnvelopeParams>): EnvelopeParams {
  return {
    version: CANONICAL_VERSION,
    kid: 'ACTIVE_V1',
    algorithm: 'aes-256-gcm',
    nonce: crypto.randomBytes(12),
    ciphertext: Buffer.from('ciphertext', 'utf8'),
    authTag: crypto.randomBytes(16),
    ...overrides,
  }
}

// ─── Base64url ────────────────────────────────────────────────────────────

describe('encodeBase64url / decodeBase64url', () => {
  it('roundtrips any buffer', () => {
    const buf = crypto.randomBytes(64)
    expect(decodeBase64url(encodeBase64url(buf))).toEqual(buf)
  })

  it('roundtrips an empty buffer', () => {
    const buf = Buffer.alloc(0)
    expect(decodeBase64url(encodeBase64url(buf))).toEqual(buf)
  })

  it('rejects non-base64url characters (colons, spaces, +, /)', () => {
    expect(() => decodeBase64url('abc:def')).toThrow('INVALID_BASE64URL')
    expect(() => decodeBase64url('abc def')).toThrow('INVALID_BASE64URL')
    expect(() => decodeBase64url('ab+c')).toThrow('INVALID_BASE64URL')
    expect(() => decodeBase64url('ab/c')).toThrow('INVALID_BASE64URL')
  })

  it('accepts base64url with optional padding', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03])
    const encoded = encodeBase64url(buf)
    expect(encoded).not.toContain('=')
    expect(decodeBase64url(encoded)).toEqual(buf)
    expect(decodeBase64url(encoded + '==')).toEqual(buf)
  })

  it('accepts base64url without padding', () => {
    const buf = Buffer.from([0x01])
    const encoded = encodeBase64url(buf)
    expect(decodeBase64url(encoded)).toEqual(buf)
  })
})

// ─── Canonical Serialization ──────────────────────────────────────────────

describe('serializeCanonical / parseCanonical', () => {
  it('roundtrips a typical envelope', () => {
    const env = makeEnvelope()
    const parsed = parseCanonical(serializeCanonical(env))
    expect(parsed).toEqual(env)
  })

  it('produces the same bytes for the same logical fields', () => {
    const env = makeEnvelope()
    const a = serializeCanonical(env)
    const b = serializeCanonical(env)
    expect(a).toEqual(b)
  })

  it('different envelopes produce different bytes', () => {
    const a = serializeCanonical(makeEnvelope({ kid: 'KID_A' }))
    const b = serializeCanonical(makeEnvelope({ kid: 'KID_B' }))
    expect(a).not.toEqual(b)
  })

  it('rejects empty buffer', () => {
    expect(() => parseCanonical(Buffer.alloc(0))).toThrow('INVALID_ENVELOPE')
  })

  it('rejects truncated buffer (partial KID length)', () => {
    const buf = Buffer.alloc(1)
    buf[0] = CANONICAL_VERSION
    expect(() => parseCanonical(buf)).toThrow('INVALID_ENVELOPE')
  })

  it('rejects buffer with incomplete KID value', () => {
    const buf = serializeCanonical(makeEnvelope())
    expect(() => parseCanonical(buf.subarray(0, buf.length - 1))).toThrow(
      'INVALID_ENVELOPE',
    )
  })

  it('supports long KIDs and algorithms', () => {
    const env = makeEnvelope({
      kid: 'A'.repeat(200),
      algorithm: 'B'.repeat(100),
    })
    const parsed = parseCanonical(serializeCanonical(env))
    expect(parsed.kid).toBe(env.kid)
    expect(parsed.algorithm).toBe(env.algorithm)
  })

  it('preserves binary ciphertext and authTag exactly', () => {
    const env = makeEnvelope({
      ciphertext: crypto.randomBytes(256),
      authTag: crypto.randomBytes(16),
    })
    const parsed = parseCanonical(serializeCanonical(env))
    expect(parsed.ciphertext).toEqual(env.ciphertext)
    expect(parsed.authTag).toEqual(env.authTag)
  })

  it('supports empty ciphertext', () => {
    const env = makeEnvelope({ ciphertext: Buffer.alloc(0) })
    const parsed = parseCanonical(serializeCanonical(env))
    expect(parsed.ciphertext.length).toBe(0)
  })

  it('rejects buffer with trailing garbage', () => {
    const serialized = serializeCanonical(makeEnvelope())
    const padded = Buffer.concat([serialized, Buffer.from([0xff, 0xff])])
    expect(() => parseCanonical(padded)).toThrow('INVALID_ENVELOPE')
  })
})

// ─── AAD Construction ─────────────────────────────────────────────────────

describe('buildAAD', () => {
  it('produces the same bytes for the same inputs', () => {
    const header = {
      version: CANONICAL_VERSION,
      kid: 'ACTIVE_V1',
      algorithm: 'aes-256-gcm',
      nonce: crypto.randomBytes(12),
    }
    const bc = 'whatsapp_config:abc-123'
    const a = buildAAD(header, bc)
    const b = buildAAD(header, bc)
    expect(a).toEqual(b)
  })

  it('changing any header field changes the AAD', () => {
    const base = {
      version: CANONICAL_VERSION,
      kid: 'ACTIVE_V1',
      algorithm: 'aes-256-gcm',
      nonce: crypto.randomBytes(12),
    }
    const bc = 'test-binding'

    const aad = buildAAD(base, bc)
    expect(buildAAD({ ...base, version: 0x02 }, bc)).not.toEqual(aad)
    expect(buildAAD({ ...base, kid: 'OTHER_KID' }, bc)).not.toEqual(aad)
    expect(buildAAD({ ...base, algorithm: 'aes-256-cbc' }, bc)).not.toEqual(aad)

    const otherNonce = crypto.randomBytes(12)
    expect(buildAAD({ ...base, nonce: otherNonce }, bc)).not.toEqual(aad)
  })

  it('changing binding context changes the AAD', () => {
    const header = {
      version: CANONICAL_VERSION,
      kid: 'ACTIVE_V1',
      algorithm: 'aes-256-gcm',
      nonce: crypto.randomBytes(12),
    }
    const aadA = buildAAD(header, 'domain:a')
    const aadB = buildAAD(header, 'domain:b')
    expect(aadA).not.toEqual(aadB)
  })

  it('empty binding context produces AAD with [0x00, 0x00] suffix', () => {
    const header = {
      version: CANONICAL_VERSION,
      kid: 'ACTIVE_V1',
      algorithm: 'aes-256-gcm',
      nonce: crypto.randomBytes(12),
    }
    const aad = buildAAD(header, '')
    const suffix = aad.subarray(aad.length - 2)
    expect(suffix).toEqual(Buffer.from([0x00, 0x00]))
  })

  it('AAD structure: version byte, then length-prefixed fields', () => {
    const header = {
      version: CANONICAL_VERSION,
      kid: 'AB',
      algorithm: 'CD',
      nonce: Buffer.from([0x01, 0x02]),
    }
    const aad = buildAAD(header, 'EF')

    // version byte: 0x01
    expect(aad[0]).toBe(CANONICAL_VERSION)

    // kid: [0x00, 0x02, 0x41, 0x42] = len 2 + "AB"
    expect(aad[1]).toBe(0x00)
    expect(aad[2]).toBe(0x02)
    expect(aad[3]).toBe(0x41)
    expect(aad[4]).toBe(0x42)

    // algorithm: [0x00, 0x02, 0x43, 0x44] = len 2 + "CD"
    expect(aad[5]).toBe(0x00)
    expect(aad[6]).toBe(0x02)
    expect(aad[7]).toBe(0x43)
    expect(aad[8]).toBe(0x44)

    // nonce: [0x02, 0x01, 0x02] = len 2 + bytes
    expect(aad[9]).toBe(0x02)
    expect(aad[10]).toBe(0x01)
    expect(aad[11]).toBe(0x02)

    // binding context: [0x00, 0x02, 0x45, 0x46] = len 2 + "EF"
    expect(aad[12]).toBe(0x00)
    expect(aad[13]).toBe(0x02)
    expect(aad[14]).toBe(0x45)
    expect(aad[15]).toBe(0x46)

    expect(aad.length).toBe(16)
  })
})

// ─── Recognition Tree ─────────────────────────────────────────────────────

describe('recognizeFormat', () => {
  // ── Canonical ───────────────────────────────────────────────────────────
  describe('canonical detection', () => {
    it('classifies a valid base64url canonical envelope', () => {
      const env = makeEnvelope()
      const stored = encodeBase64url(serializeCanonical(env))
      expect(recognizeFormat(stored).format).toBe('canonical')
    })

    it('rejects canonical envelope with wrong version byte', () => {
      const env = makeEnvelope({ version: 0x02 })
      const stored = encodeBase64url(serializeCanonical(env))
      expect(recognizeFormat(stored).format).not.toBe('canonical')
    })

    it('canonical without padding is still canonical', () => {
      const env = makeEnvelope({ nonce: Buffer.from([0x01]) })
      const stored = encodeBase64url(serializeCanonical(env))
      expect(stored).not.toContain('=')
      expect(recognizeFormat(stored).format).toBe('canonical')
    })
  })

  // ── Legacy GCM ──────────────────────────────────────────────────────────
  describe('legacy GCM detection', () => {
    it('classifies iv:ct:tag as legacy_gcm', () => {
      expect(
        recognizeFormat('abcdef123456:abcdef1234567890:abcdef01').format,
      ).toBe('legacy_gcm')
    })

    it('accepts uppercase hex (normalized before matching)', () => {
      expect(recognizeFormat('ABCDEF:1234567890ABCDEF:ABCDEF01').format).toBe(
        'legacy_gcm',
      )
    })

    it('rejects legacy GCM with non-hex characters', () => {
      expect(recognizeFormat('abc:def:ghi').format).toBe('invalid')
    })

    it('rejects legacy GCM with too few colons', () => {
      expect(recognizeFormat('abc:def').format).toBe('legacy_cbc')
    })
  })

  // ── Legacy CBC ──────────────────────────────────────────────────────────
  describe('legacy CBC detection', () => {
    it('classifies iv:ct as legacy_cbc', () => {
      expect(recognizeFormat('aabbccdd:ddeeff001122').format).toBe('legacy_cbc')
    })

    it('rejects legacy CBC with non-hex characters', () => {
      expect(recognizeFormat('aabb:zzzz').format).toBe('invalid')
    })
  })

  // ── Invalid ─────────────────────────────────────────────────────────────
  describe('invalid detection', () => {
    it('empty string is invalid', () => {
      expect(recognizeFormat('').format).toBe('invalid')
    })

    it('random text with no colon is invalid', () => {
      expect(recognizeFormat('justrandomtext').format).toBe('invalid')
    })

    it('random text with colon is invalid (no hex match)', () => {
      expect(recognizeFormat('hello:world').format).toBe('invalid')
    })

    it('base64url that does not start with 0x01 is invalid', () => {
      const buf = Buffer.from([0xff, 0x02, 0x03])
      const stored = encodeBase64url(buf)
      expect(recognizeFormat(stored).format).toBe('invalid')
    })
  })

  // ── Precedence ──────────────────────────────────────────────────────────
  describe('precedence (canonical before legacy)', () => {
    it('adversarial input that could be both is canonical when first byte is 0x01', () => {
      const env = makeEnvelope({
        nonce: Buffer.from([0x01]),
        ciphertext: Buffer.from([0x02]),
        authTag: Buffer.from([0x03, 0x04, 0x05, 0x06]),
        kid: 'A',
        algorithm: 'B',
      })
      const stored = encodeBase64url(serializeCanonical(env))
      expect(stored).not.toContain(':')
      expect(recognizeFormat(stored).format).toBe('canonical')
    })

    it('legacy string that is also valid base64url but first byte not 0x01 falls through to legacy', () => {
      const buf = Buffer.from([0x02, 0x03])
      const stored = encodeBase64url(buf)
      expect(stored).not.toContain(':')
      expect(recognizeFormat(stored).format).toBe('invalid')
    })
  })
})
