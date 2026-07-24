import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import {
  CANONICAL_VERSION,
  encodeBase64url,
  serializeCanonical,
} from '../crypto/envelope'
import { createDefaultKeyRing } from '../crypto/keyring'
import {
  encrypt,
  decrypt,
  isLegacyFormat,
  encryptWithBindingContext,
  decryptWithBindingContext,
} from './encryption'

// ─── Pre-cutover API: encrypt / decrypt roundtrip ─────────────────────────

describe('encrypt / decrypt roundtrip (pre-cutover, legacy GCM)', () => {
  it('returns the original plaintext after roundtrip', () => {
    const plaintext = 'whatsapp-token-abc123'
    expect(decrypt(encrypt(plaintext))).toBe(plaintext)
  })

  it('produces different ciphertext on every call (random IV)', () => {
    const ct1 = encrypt('same-input')
    const ct2 = encrypt('same-input')
    expect(ct1).not.toBe(ct2)
  })

  it('roundtrips an empty string', () => {
    expect(decrypt(encrypt(''))).toBe('')
  })

  it('roundtrips unicode / emoji', () => {
    const value = 'token-🦅-üñíçödé'
    expect(decrypt(encrypt(value))).toBe(value)
  })

  it('roundtrips a long token (512 chars)', () => {
    expect(decrypt(encrypt('x'.repeat(512)))).toBe('x'.repeat(512))
  })
})

describe('encrypt output format (GCM)', () => {
  it('produces iv:ciphertext:authTag format (2 colons)', () => {
    const parts = encrypt('test').split(':')
    expect(parts).toHaveLength(3)
  })

  it('is different from plaintext', () => {
    expect(encrypt('supersecret')).not.toBe('supersecret')
  })
})

describe('isLegacyFormat', () => {
  it('returns false for current GCM output (3 parts)', () => {
    expect(isLegacyFormat(encrypt('anything'))).toBe(false)
  })

  it('returns true for a legacy iv:ciphertext shape (2 parts)', () => {
    expect(isLegacyFormat('aabbcc:ddeeff')).toBe(true)
  })

  it('returns false for unrecognised shape (1 part)', () => {
    expect(isLegacyFormat('nodivider')).toBe(false)
  })

  it('returns false for a canonical envelope (base64url, no colons)', () => {
    const ct = encryptWithBindingContext('test', 'bc')
    expect(isLegacyFormat(ct)).toBe(false)
  })
})

describe('decrypt (pre-cutover) error cases', () => {
  it('throws on unrecognised format', () => {
    expect(() => decrypt('not-valid')).toThrow()
  })

  it('throws when GCM auth tag is tampered', () => {
    const ct = encrypt('original')
    const tampered = ct.slice(0, -4) + '0000'
    expect(() => decrypt(tampered)).toThrow()
  })

  it('throws when IV has wrong length for GCM', () => {
    expect(() => decrypt('aabb:ciphertext:authtag')).toThrow()
  })

  it('does not understand canonical envelopes (out of scope for the pre-cutover pair)', () => {
    const ct = encryptWithBindingContext('canonical-data', 'bc')
    expect(() => decrypt(ct)).toThrow()
  })
})

describe('legacy CBC compatibility (pre-cutover decrypt)', () => {
  it('decrypts a legacy CBC ciphertext (iv:ct)', () => {
    const keyring = createDefaultKeyRing()
    const legacyCBC = keyring.resolve('LEGACY_CBC')
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', legacyCBC.key, iv)
    let encrypted = cipher.update('cbc-legacy-data', 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const legacyToken = `${iv.toString('hex')}:${encrypted}`
    expect(decrypt(legacyToken)).toBe('cbc-legacy-data')
  })
})

// ─── Post-cutover API: encrypt canonical → decrypt canonical ─────────────

describe('encryptWithBindingContext / decryptWithBindingContext — canonical roundtrip', () => {
  it('roundtrips with matching binding context', () => {
    const plaintext = 'secret-token-123'
    const bc = 'whatsapp_config:abc-123'
    const ct = encryptWithBindingContext(plaintext, bc)
    expect(decryptWithBindingContext(ct, bc)).toBe(plaintext)
  })

  it('roundtrips empty string plaintext', () => {
    const ct = encryptWithBindingContext('', 'domain:a')
    expect(decryptWithBindingContext(ct, 'domain:a')).toBe('')
  })

  it('roundtrips unicode', () => {
    const ct = encryptWithBindingContext('🦅-üñíçödé', 'bc')
    expect(decryptWithBindingContext(ct, 'bc')).toBe('🦅-üñíçödé')
  })

  it('produces base64url output (no colons)', () => {
    const ct = encryptWithBindingContext('test', 'bc:1')
    expect(ct).not.toContain(':')
    expect(() => Buffer.from(ct, 'base64url')).not.toThrow()
  })

  it('produces different ciphertext on every call (random nonce)', () => {
    const ct1 = encryptWithBindingContext('same', 'bc')
    const ct2 = encryptWithBindingContext('same', 'bc')
    expect(ct1).not.toBe(ct2)
  })

  it('uses the canonical envelope version (first decoded byte is 0x01)', () => {
    const ct = encryptWithBindingContext('test', 'bc')
    const decoded = Buffer.from(ct, 'base64url')
    expect(decoded[0]).toBe(CANONICAL_VERSION)
  })

  it('storage representation uses base64url of the binary envelope (IMP §4.4)', () => {
    const ct = encryptWithBindingContext('storage-check', 'bc')
    // Round-tripping through base64url must reproduce a parseable canonical envelope.
    const raw = Buffer.from(ct, 'base64url')
    expect(raw[0]).toBe(CANONICAL_VERSION)
    expect(encodeBase64url(raw)).toBe(ct)
  })
})

// ─── Legacy GCM / CBC via decryptWithBindingContext ───────────────────────

describe('decryptWithBindingContext handles all formats', () => {
  it('decrypts canonical (with correct BC)', () => {
    const ct = encryptWithBindingContext('canonical-data', 'ctx:1')
    expect(decryptWithBindingContext(ct, 'ctx:1')).toBe('canonical-data')
  })

  it('decrypts legacy GCM (BC accepted but not verified, per ADR §8.7)', () => {
    const legacyCt = encrypt('legacy-gcm-data')
    expect(decryptWithBindingContext(legacyCt, 'ignored-bc')).toBe(
      'legacy-gcm-data',
    )
  })

  it('decrypts legacy CBC (BC accepted but not verified, per ADR §8.7)', () => {
    const keyring = createDefaultKeyRing()
    const legacyCBC = keyring.resolve('LEGACY_CBC')
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', legacyCBC.key, iv)
    let encrypted = cipher.update('cbc-bc-test', 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const legacyToken = `${iv.toString('hex')}:${encrypted}`
    expect(decryptWithBindingContext(legacyToken, 'any')).toBe('cbc-bc-test')
  })

  it('throws on an unrecognised/invalid token', () => {
    expect(() => decryptWithBindingContext('not-a-valid-token', 'bc')).toThrow(
      'INVALID_ENVELOPE',
    )
  })
})

// ─── Binding Context verification (correct / incorrect BC) ───────────────

describe('Binding Context verification', () => {
  it('correct BC succeeds', () => {
    const ct = encryptWithBindingContext('data', 'correct-binding')
    expect(decryptWithBindingContext(ct, 'correct-binding')).toBe('data')
  })

  it('incorrect BC throws (AAD/tag mismatch)', () => {
    const ct = encryptWithBindingContext('data', 'right-bc')
    expect(() => decryptWithBindingContext(ct, 'wrong-bc')).toThrow()
  })

  it('empty BC roundtrips (legal value per ADR §7.4)', () => {
    const ct = encryptWithBindingContext('data', '')
    expect(decryptWithBindingContext(ct, '')).toBe('data')
  })

  it('empty BC vs non-empty BC mismatch throws', () => {
    const ct = encryptWithBindingContext('data', 'non-empty')
    expect(() => decryptWithBindingContext(ct, '')).toThrow()
  })
})

// ─── BC undefined → BINDING_CONTEXT_REQUIRED ──────────────────────────────

describe('BC undefined guard (runtime, defense-in-depth beyond the type system)', () => {
  it('encryptWithBindingContext with undefined BC throws BINDING_CONTEXT_REQUIRED', () => {
    expect(() =>
      encryptWithBindingContext('data', undefined as unknown as string),
    ).toThrow('BINDING_CONTEXT_REQUIRED')
  })

  it('decryptWithBindingContext with undefined BC throws BINDING_CONTEXT_REQUIRED', () => {
    expect(() =>
      decryptWithBindingContext('some-token', undefined as unknown as string),
    ).toThrow('BINDING_CONTEXT_REQUIRED')
  })

  it('does not attempt any cryptographic operation before the guard fires', () => {
    // A malformed token would normally throw INVALID_ENVELOPE / decode errors —
    // if the guard didn't fire first, this would throw a different error.
    expect(() =>
      decryptWithBindingContext(
        'clearly-not-a-token-####',
        undefined as unknown as string,
      ),
    ).toThrow('BINDING_CONTEXT_REQUIRED')
  })
})

// ─── Unknown KID → fail closed ────────────────────────────────────────────

describe('unknown KID fails closed', () => {
  it('throws UNKNOWN_KID for an unrecognised KID in a canonical envelope', () => {
    const envelope = serializeCanonical({
      version: CANONICAL_VERSION,
      kid: 'NONEXISTENT_KID',
      algorithm: 'aes-256-gcm',
      nonce: crypto.randomBytes(12),
      ciphertext: Buffer.from('test'),
      authTag: Buffer.alloc(16),
    })
    const token = encodeBase64url(envelope)
    expect(() => decryptWithBindingContext(token, 'bc')).toThrow('UNKNOWN_KID')
  })
})

// ─── Algorithm mismatch → fail closed ─────────────────────────────────────

describe('algorithm mismatch fails closed (I9)', () => {
  it('throws ALGORITHM_MISMATCH when envelope algorithm differs from the resolved KID algorithm', () => {
    const nonce = crypto.randomBytes(12)

    const envelope = serializeCanonical({
      version: CANONICAL_VERSION,
      kid: 'ACTIVE_V1',
      algorithm: 'aes-256-cbc', // ACTIVE_V1 is registered as aes-256-gcm
      nonce,
      ciphertext: Buffer.from('test'),
      authTag: Buffer.alloc(16),
    })
    const token = encodeBase64url(envelope)
    expect(() => decryptWithBindingContext(token, 'bc')).toThrow(
      'ALGORITHM_MISMATCH',
    )
  })

  it('checks algorithm before attempting decrypt (no decipher created on mismatch)', () => {
    // A bogus/zero authTag would fail decryption anyway — but ALGORITHM_MISMATCH
    // must be the error actually thrown, proving the check runs first.
    const nonce = crypto.randomBytes(12)
    const envelope = serializeCanonical({
      version: CANONICAL_VERSION,
      kid: 'LEGACY_GCM', // registered as aes-256-gcm
      algorithm: 'aes-256-cbc', // deliberately wrong
      nonce,
      ciphertext: Buffer.from('test'),
      authTag: Buffer.alloc(16),
    })
    const token = encodeBase64url(envelope)
    expect(() => decryptWithBindingContext(token, 'bc')).toThrow(
      'ALGORITHM_MISMATCH',
    )
  })
})

// ─── Cross-format stability ───────────────────────────────────────────────

describe('cross-format stability', () => {
  it('legacy GCM encrypted (pre-cutover) → both decrypt paths produce the same plaintext', () => {
    const pt = 'stable-token'
    const ct = encrypt(pt)
    expect(decrypt(ct)).toBe(pt)
    expect(decryptWithBindingContext(ct, 'unused')).toBe(pt)
  })

  it('canonical encrypted → BC-aware decrypt produces the same plaintext', () => {
    const pt = 'stable-canonical'
    const bc = 'stable-binding'
    const ct = encryptWithBindingContext(pt, bc)
    expect(decryptWithBindingContext(ct, bc)).toBe(pt)
  })
})

// ─── Nonce / key isolation across KIDs ─────────────────────────────────────

describe('nonce isolation across KIDs', () => {
  it('ACTIVE_V1 key differs from LEGACY_GCM key (HKDF isolation, Phase 1)', () => {
    const keyring = createDefaultKeyRing()
    const active = keyring.resolve('ACTIVE_V1')
    const legacy = keyring.resolve('LEGACY_GCM')
    expect(active.key).not.toEqual(legacy.key)
  })

  it('legacy encrypt (pre-cutover) and canonical encrypt (post-cutover) produce distinct formats', () => {
    const legacyCt = encrypt('same-plaintext')
    const canonicalCt = encryptWithBindingContext('same-plaintext', 'bc')
    expect(legacyCt.split(':')).toHaveLength(3)
    expect(canonicalCt).not.toContain(':')
  })
})
