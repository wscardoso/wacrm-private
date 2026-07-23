import { describe, it, expect, beforeEach } from 'vitest'
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
