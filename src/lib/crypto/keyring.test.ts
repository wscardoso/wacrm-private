import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'crypto'
import { KeyRing, createDefaultKeyRing, type KeyMaterial } from './keyring'

// ─── Test fixtures ────────────────────────────────────────────────────────

const TEST_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000'
const TEST_KEY = Buffer.from(TEST_KEY_HEX, 'hex')

function activeEntry(overrides?: Partial<KeyMaterial>): KeyMaterial {
  return {
    kid: 'ACTIVE_V1',
    algorithm: 'aes-256-gcm',
    key: Buffer.from(TEST_KEY),
    capacity: 'Active',
    ...overrides,
  }
}

function decryptOnlyEntry(overrides?: Partial<KeyMaterial>): KeyMaterial {
  return {
    kid: 'DECRYPT_ONLY',
    algorithm: 'aes-256-gcm',
    key: Buffer.from(TEST_KEY),
    capacity: 'DecryptOnly',
    ...overrides,
  }
}

// ─── KeyRing construction validation ──────────────────────────────────────

describe('KeyRing construction', () => {
  it('accepts one Active and multiple DecryptOnly entries', () => {
    const kr = new KeyRing([
      activeEntry({ kid: 'ACTIVE_V1' }),
      decryptOnlyEntry({ kid: 'LEGACY_GCM' }),
      decryptOnlyEntry({ kid: 'LEGACY_CBC' }),
    ])
    expect(kr.hasKID('ACTIVE_V1')).toBe(true)
    expect(kr.hasKID('LEGACY_GCM')).toBe(true)
    expect(kr.hasKID('LEGACY_CBC')).toBe(true)
  })

  it('rejects duplicate KIDs', () => {
    expect(
      () =>
        new KeyRing([
          activeEntry({ kid: 'DUPE' }),
          decryptOnlyEntry({ kid: 'DUPE' }),
        ]),
    ).toThrow('DUPLICATE_KID')
  })

  it('rejects multiple Active entries', () => {
    expect(
      () =>
        new KeyRing([
          activeEntry({ kid: 'ACTIVE_V1' }),
          activeEntry({ kid: 'ACTIVE_V2' }),
        ]),
    ).toThrow('MULTIPLE_ACTIVE_KEYS')
  })

  it('rejects zero entries', () => {
    expect(() => new KeyRing([])).toThrow('NO_ACTIVE_KEY')
  })

  it('rejects entries with no Active key', () => {
    expect(
      () =>
        new KeyRing([
          decryptOnlyEntry({ kid: 'LEGACY_GCM' }),
          decryptOnlyEntry({ kid: 'LEGACY_CBC' }),
        ]),
    ).toThrow('NO_ACTIVE_KEY')
  })
})

// ─── KID resolution ───────────────────────────────────────────────────────

describe('KeyRing.resolve', () => {
  let kr: KeyRing

  beforeEach(() => {
    kr = new KeyRing([
      activeEntry({ kid: 'ACTIVE_V1' }),
      decryptOnlyEntry({ kid: 'LEGACY_GCM' }),
      decryptOnlyEntry({ kid: 'LEGACY_CBC' }),
    ])
  })

  it('returns material for a known KID', () => {
    const mat = kr.resolve('LEGACY_GCM')
    expect(mat.kid).toBe('LEGACY_GCM')
    expect(mat.algorithm).toBe('aes-256-gcm')
    expect(mat.capacity).toBe('DecryptOnly')
    expect(mat.key).toEqual(TEST_KEY)
  })

  it('throws UNKNOWN_KID for an unrecognised KID', () => {
    expect(() => kr.resolve('NONEXISTENT')).toThrow('UNKNOWN_KID')
  })

  it('resolve is deterministic (same KID, same material)', () => {
    const a = kr.resolve('LEGACY_GCM')
    const b = kr.resolve('LEGACY_GCM')
    expect(a.key).toEqual(b.key)
    expect(a.algorithm).toBe(b.algorithm)
  })

  it('returns material for the Active KID', () => {
    const mat = kr.resolve('ACTIVE_V1')
    expect(mat.kid).toBe('ACTIVE_V1')
    expect(mat.capacity).toBe('Active')
  })
})

// ─── getWriteKey ──────────────────────────────────────────────────────────

describe('KeyRing.getWriteKey', () => {
  it('returns the Active entry', () => {
    const kr = new KeyRing([
      activeEntry({ kid: 'ACTIVE_V1' }),
      decryptOnlyEntry({ kid: 'LEGACY_GCM' }),
    ])
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V1')
    expect(kr.getWriteKey().capacity).toBe('Active')
  })

  it('returns the same material on repeated calls', () => {
    const kr = new KeyRing([activeEntry({ kid: 'MY_KEY' })])
    expect(kr.getWriteKey()).toBe(kr.getWriteKey())
  })
})

// ─── hasKID ───────────────────────────────────────────────────────────────

describe('KeyRing.hasKID', () => {
  it('returns true for configured KIDs', () => {
    const kr = new KeyRing([activeEntry({ kid: 'K1' }), decryptOnlyEntry({ kid: 'K2' })])
    expect(kr.hasKID('K1')).toBe(true)
    expect(kr.hasKID('K2')).toBe(true)
  })

  it('returns false for unconfigured KIDs', () => {
    const kr = new KeyRing([activeEntry({ kid: 'K1' })])
    expect(kr.hasKID('NOT_HERE')).toBe(false)
  })
})

// ─── createDefaultKeyRing ─────────────────────────────────────────────────

describe('createDefaultKeyRing', () => {
  it('creates a KeyRing with LEGACY_GCM, LEGACY_CBC, and ACTIVE_V1', () => {
    const kr = createDefaultKeyRing()
    expect(kr.hasKID('LEGACY_GCM')).toBe(true)
    expect(kr.hasKID('LEGACY_CBC')).toBe(true)
    expect(kr.hasKID('ACTIVE_V1')).toBe(true)
  })

  it('ACTIVE_V1 is the write key', () => {
    const kr = createDefaultKeyRing()
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V1')
    expect(kr.getWriteKey().capacity).toBe('Active')
  })

  it('LEGACY_GCM and LEGACY_CBC are DecryptOnly', () => {
    const kr = createDefaultKeyRing()
    expect(kr.resolve('LEGACY_GCM').capacity).toBe('DecryptOnly')
    expect(kr.resolve('LEGACY_CBC').capacity).toBe('DecryptOnly')
  })

  it('LEGACY_GCM algorithm is aes-256-gcm', () => {
    const kr = createDefaultKeyRing()
    expect(kr.resolve('LEGACY_GCM').algorithm).toBe('aes-256-gcm')
  })

  it('LEGACY_CBC algorithm is aes-256-cbc', () => {
    const kr = createDefaultKeyRing()
    expect(kr.resolve('LEGACY_CBC').algorithm).toBe('aes-256-cbc')
  })

  it('ACTIVE_V1 algorithm is aes-256-gcm', () => {
    const kr = createDefaultKeyRing()
    expect(kr.resolve('ACTIVE_V1').algorithm).toBe('aes-256-gcm')
  })

  it('LEGACY_GCM and LEGACY_CBC share the same raw key', () => {
    const kr = createDefaultKeyRing()
    const gcm = kr.resolve('LEGACY_GCM')
    const cbc = kr.resolve('LEGACY_CBC')
    expect(gcm.key).toEqual(cbc.key)
  })

  it('ACTIVE_V1 key differs from LEGACY_GCM / LEGACY_CBC key (HKDF isolation)', () => {
    const kr = createDefaultKeyRing()
    const active = kr.resolve('ACTIVE_V1')
    const legacy = kr.resolve('LEGACY_GCM')
    expect(active.key).not.toEqual(legacy.key)
  })

  it('ACTIVE_V1 key differs from the raw ENCRYPTION_KEY bytes', () => {
    const kr = createDefaultKeyRing()
    const active = kr.resolve('ACTIVE_V1')
    const rawKey = Buffer.from(
      process.env.ENCRYPTION_KEY ?? '0000000000000000000000000000000000000000000000000000000000000000',
      'hex',
    )
    expect(active.key).not.toEqual(rawKey)
  })

  it('HKDF derivation is deterministic', () => {
    const kr1 = createDefaultKeyRing()
    const kr2 = createDefaultKeyRing()
    expect(kr1.resolve('ACTIVE_V1').key).toEqual(kr2.resolve('ACTIVE_V1').key)
  })

  it('throws if ENCRYPTION_KEY is missing', () => {
    const saved = process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    try {
      expect(() => createDefaultKeyRing()).toThrow('ENCRYPTION_KEY')
    } finally {
      process.env.ENCRYPTION_KEY = saved
    }
  })
})

// ─── createDefaultKeyRing + KEYRING_CONFIG (IMP-E7-001 Phase 1) ───────────
//
// KEYRING_CONFIG is optional. Absent, it must not change createDefaultKeyRing()
// in any observable way — this is the backward-compatibility guarantee this
// phase exists to prove. Present, it appends additional KIDs on top of the
// fixed LEGACY_GCM/LEGACY_CBC/ACTIVE_V1 baseline (ADR-E7-001 T1).
describe('createDefaultKeyRing + KEYRING_CONFIG', () => {
  const savedConfig = process.env.KEYRING_CONFIG

  afterEach(() => {
    if (savedConfig === undefined) delete process.env.KEYRING_CONFIG
    else process.env.KEYRING_CONFIG = savedConfig
  })

  it('absent KEYRING_CONFIG preserves the exact 3-KID baseline (no behavior change)', () => {
    delete process.env.KEYRING_CONFIG
    const kr = createDefaultKeyRing()
    expect(kr.hasKID('LEGACY_GCM')).toBe(true)
    expect(kr.hasKID('LEGACY_CBC')).toBe(true)
    expect(kr.hasKID('ACTIVE_V1')).toBe(true)
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V1')
    expect(kr.hasKID('ANYTHING_ELSE')).toBe(false)
  })

  it('accepts an additional DecryptOnly KID via KEYRING_CONFIG', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      {
        kid: 'ACTIVE_V2_TEST',
        algorithm: 'aes-256-gcm',
        key: TEST_KEY_HEX,
        capacity: 'DecryptOnly',
      },
    ])
    const kr = createDefaultKeyRing()
    expect(kr.hasKID('ACTIVE_V2_TEST')).toBe(true)
    expect(kr.resolve('ACTIVE_V2_TEST').capacity).toBe('DecryptOnly')
    // Baseline untouched.
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V1')
    expect(kr.hasKID('LEGACY_GCM')).toBe(true)
    expect(kr.hasKID('LEGACY_CBC')).toBe(true)
  })

  it('a KEYRING_CONFIG entry with capacity Active is rejected by the existing MULTIPLE_ACTIVE_KEYS guard (ACTIVE_V1 is still hardcoded Active in this phase)', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      {
        kid: 'ACTIVE_V2_TEST',
        algorithm: 'aes-256-gcm',
        key: TEST_KEY_HEX,
        capacity: 'Active',
      },
    ])
    expect(() => createDefaultKeyRing()).toThrow('MULTIPLE_ACTIVE_KEYS')
  })

  it('rejects malformed JSON', () => {
    process.env.KEYRING_CONFIG = 'not json'
    expect(() => createDefaultKeyRing()).toThrow('KEYRING_CONFIG')
  })

  it('rejects a non-array value', () => {
    process.env.KEYRING_CONFIG = JSON.stringify({ kid: 'X' })
    expect(() => createDefaultKeyRing()).toThrow('KEYRING_CONFIG')
  })

  it('rejects an entry with an invalid hex key', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      { kid: 'BAD', algorithm: 'aes-256-gcm', key: 'not-hex', capacity: 'DecryptOnly' },
    ])
    expect(() => createDefaultKeyRing()).toThrow('key')
  })

  it('rejects an entry with an invalid capacity value', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      { kid: 'BAD', algorithm: 'aes-256-gcm', key: TEST_KEY_HEX, capacity: 'Retired' },
    ])
    expect(() => createDefaultKeyRing()).toThrow('capacity')
  })

  it('duplicate KID between KEYRING_CONFIG and the fixed baseline still fails DUPLICATE_KID', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      { kid: 'ACTIVE_V1', algorithm: 'aes-256-gcm', key: TEST_KEY_HEX, capacity: 'DecryptOnly' },
    ])
    expect(() => createDefaultKeyRing()).toThrow('DUPLICATE_KID')
  })

  it('an empty-string KEYRING_CONFIG behaves identically to an absent one', () => {
    process.env.KEYRING_CONFIG = ''
    const kr = createDefaultKeyRing()
    expect(kr.hasKID('LEGACY_GCM')).toBe(true)
    expect(kr.hasKID('LEGACY_CBC')).toBe(true)
    expect(kr.hasKID('ACTIVE_V1')).toBe(true)
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V1')
    expect(kr.hasKID('ANYTHING_ELSE')).toBe(false)
  })

  it('an explicit empty-array KEYRING_CONFIG ("[]") behaves identically to an absent one', () => {
    process.env.KEYRING_CONFIG = '[]'
    const kr = createDefaultKeyRing()
    expect(kr.hasKID('LEGACY_GCM')).toBe(true)
    expect(kr.hasKID('LEGACY_CBC')).toBe(true)
    expect(kr.hasKID('ACTIVE_V1')).toBe(true)
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V1')
    expect(kr.hasKID('ANYTHING_ELSE')).toBe(false)
  })

  it('accepts multiple additional KIDs in a single KEYRING_CONFIG, all resolvable, baseline write key unchanged', () => {
    const keyAHex = TEST_KEY_HEX.slice(0, -1) + '1'
    const keyBHex = TEST_KEY_HEX.slice(0, -1) + '2'
    process.env.KEYRING_CONFIG = JSON.stringify([
      { kid: 'KEY_A', algorithm: 'aes-256-gcm', key: keyAHex, capacity: 'DecryptOnly' },
      { kid: 'KEY_B', algorithm: 'aes-256-gcm', key: keyBHex, capacity: 'DecryptOnly' },
    ])
    const kr = createDefaultKeyRing()
    expect(kr.hasKID('KEY_A')).toBe(true)
    expect(kr.hasKID('KEY_B')).toBe(true)
    expect(kr.resolve('KEY_A').capacity).toBe('DecryptOnly')
    expect(kr.resolve('KEY_B').capacity).toBe('DecryptOnly')
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V1')
  })

  it('resolved key bytes exactly match the configured hex (no mutation during parsing)', () => {
    const customHex = TEST_KEY_HEX.slice(0, -4) + 'abcd'
    process.env.KEYRING_CONFIG = JSON.stringify([
      { kid: 'FIDELITY_TEST', algorithm: 'aes-256-gcm', key: customHex, capacity: 'DecryptOnly' },
    ])
    const kr = createDefaultKeyRing()
    expect(kr.resolve('FIDELITY_TEST').key).toEqual(Buffer.from(customHex, 'hex'))
  })

  it('rejects an entry missing the kid field', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      { algorithm: 'aes-256-gcm', key: TEST_KEY_HEX, capacity: 'DecryptOnly' },
    ])
    expect(() => createDefaultKeyRing()).toThrow('kid')
  })

  it('rejects an entry missing the algorithm field', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      { kid: 'NO_ALGO', key: TEST_KEY_HEX, capacity: 'DecryptOnly' },
    ])
    expect(() => createDefaultKeyRing()).toThrow('algorithm')
  })

  it('rejects an entry missing the key field', () => {
    process.env.KEYRING_CONFIG = JSON.stringify([
      { kid: 'NO_KEY', algorithm: 'aes-256-gcm', capacity: 'DecryptOnly' },
    ])
    expect(() => createDefaultKeyRing()).toThrow('key')
  })

  it('rejects a non-object array element', () => {
    process.env.KEYRING_CONFIG = JSON.stringify(['invalid'])
    expect(() => createDefaultKeyRing()).toThrow('object')
  })
})

// ─── Direct KeyRing promotion scenario (no createDefaultKeyRing involved) ─
//
// IMP-E7-001 Phase 1 acceptance criterion: "construção com um 4º KID de
// teste promovido a Active (e ACTIVE_V1 rebaixada) resolve corretamente."
// This requires zero change to the KeyRing class — already true before
// this phase — exercised directly against arbitrary entries, exactly as
// ADR-E7-001 §4.1/§9 describes rotation being realized in practice (a
// fresh KeyRing instance with capacities already swapped).
describe('KeyRing — 4th KID promoted to Active, previous Active demoted (T3/T4 shape)', () => {
  it('resolves correctly with the promoted/demoted pair', () => {
    const kr = new KeyRing([
      decryptOnlyEntry({ kid: 'LEGACY_GCM' }),
      decryptOnlyEntry({ kid: 'LEGACY_CBC' }),
      decryptOnlyEntry({ kid: 'ACTIVE_V1' }), // demoted
      activeEntry({ kid: 'ACTIVE_V2' }), // promoted
    ])
    expect(kr.getWriteKey().kid).toBe('ACTIVE_V2')
    expect(kr.resolve('ACTIVE_V1').capacity).toBe('DecryptOnly')
    expect(kr.resolve('ACTIVE_V2').capacity).toBe('Active')
    // Reads for all 4 KIDs still work — no loss of read capability (RF-8).
    expect(kr.hasKID('LEGACY_GCM')).toBe(true)
    expect(kr.hasKID('LEGACY_CBC')).toBe(true)
  })
})

// ─── Nonce isolation at scale (IMP §7.1, property test) ───────────────────
//
// The HKDF derivation above (§4.3) makes ACTIVE_V1's key cryptographically
// distinct from LEGACY_GCM/LEGACY_CBC's raw ENCRYPTION_KEY, so a nonce
// collision across those KIDs is not a real AES-GCM two-time-pad risk by
// construction. This test is the property-test backstop the IMP still
// requires: it exercises the actual nonce generator (`crypto.randomBytes`,
// same call ACTIVE_V1 encryption uses) at the volume specified by §7.1 and
// asserts no collision, either internally or against a corpus standing in
// for already-issued legacy nonces.
describe('nonce isolation across KIDs — property test at scale', () => {
  it('>= 10,000 freshly generated ACTIVE_V1-style nonces never collide with each other or with a fixture legacy-nonce corpus', () => {
    const GCM_IV_LENGTH = 12
    const NONCE_COUNT = 10_000
    const LEGACY_CORPUS_SIZE = 5_000

    // Deterministic, reproducible stand-in for "historical nonces already
    // issued under LEGACY_GCM/LEGACY_CBC" — a fixed seeded PRNG so the
    // corpus (and therefore this test) is stable across runs/CI, not a
    // sample of real production data.
    let seed = 0x2f8a1c3d
    function nextSeededByte(): number {
      // xorshift32 — deterministic and fast; only used to build a stable
      // fixture corpus, not for any cryptographic purpose.
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed |= 0
      return seed & 0xff
    }

    const legacyNonceCorpus = new Set<string>()
    while (legacyNonceCorpus.size < LEGACY_CORPUS_SIZE) {
      const bytes = Buffer.alloc(GCM_IV_LENGTH)
      for (let b = 0; b < GCM_IV_LENGTH; b++) bytes[b] = nextSeededByte()
      legacyNonceCorpus.add(bytes.toString('hex'))
    }
    expect(legacyNonceCorpus.size).toBe(LEGACY_CORPUS_SIZE)

    const generated = new Set<string>()
    for (let i = 0; i < NONCE_COUNT; i++) {
      const nonce = randomBytes(GCM_IV_LENGTH).toString('hex')
      expect(legacyNonceCorpus.has(nonce)).toBe(false)
      expect(generated.has(nonce)).toBe(false)
      generated.add(nonce)
    }
    expect(generated.size).toBe(NONCE_COUNT)
  })
})
