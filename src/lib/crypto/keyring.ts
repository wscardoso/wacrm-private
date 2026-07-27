import { hkdfSync } from 'crypto'

export type KeyCapacity = 'Active' | 'DecryptOnly'

export interface KeyMaterial {
  kid: string
  algorithm: string
  key: Buffer
  capacity: KeyCapacity
}

export class KeyRing {
  private readonly entries: Map<string, KeyMaterial>
  private readonly writeKey: KeyMaterial

  constructor(entries: KeyMaterial[]) {
    this.entries = new Map()
    let writeKey: KeyMaterial | undefined

    for (const entry of entries) {
      if (this.entries.has(entry.kid)) {
        throw new Error(`DUPLICATE_KID: ${entry.kid}`)
      }
      this.entries.set(entry.kid, entry)
      if (entry.capacity === 'Active') {
        if (writeKey !== undefined) {
          throw new Error('MULTIPLE_ACTIVE_KEYS')
        }
        writeKey = entry
      }
    }

    if (writeKey === undefined) {
      throw new Error('NO_ACTIVE_KEY')
    }
    this.writeKey = writeKey
  }

  resolve(kid: string): KeyMaterial {
    const entry = this.entries.get(kid)
    if (entry === undefined) {
      throw new Error(`UNKNOWN_KID: ${kid}`)
    }
    return entry
  }

  getWriteKey(): KeyMaterial {
    return this.writeKey
  }

  hasKID(kid: string): boolean {
    return this.entries.has(kid)
  }
}

// ─── Default factory (reads ENCRYPTION_KEY from env) ─────────────────────

/**
 * Parses the optional `KEYRING_CONFIG` environment variable — additional
 * KID entries appended to the fixed baseline below (IMP-E7-001 Phase 1;
 * name reserved for this purpose since IMP-CRYPTO-001 §4.3).
 *
 * Absent or empty → no additional entries, identical behavior to before
 * this function existed. Malformed input fails closed at module load,
 * matching the existing ENCRYPTION_KEY validation below.
 *
 * Deliberately does not special-case `capacity: 'Active'` entries: with
 * ACTIVE_V1 still hardcoded Active, the KeyRing constructor's own
 * MULTIPLE_ACTIVE_KEYS check already rejects that case correctly. Actual
 * write-key promotion is IMP-E7-001 Phase 2, not this function.
 */
function parseAdditionalKeyRingEntries(): KeyMaterial[] {
  const raw = process.env.KEYRING_CONFIG
  if (!raw || raw.trim() === '') {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('KEYRING_CONFIG must be valid JSON (an array of key entries).')
  }

  if (!Array.isArray(parsed)) {
    throw new Error('KEYRING_CONFIG must be a JSON array of key entries.')
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`KEYRING_CONFIG[${index}] must be an object.`)
    }
    const { kid, algorithm, key, capacity } = entry as Record<string, unknown>

    if (typeof kid !== 'string' || kid.length === 0) {
      throw new Error(`KEYRING_CONFIG[${index}].kid must be a non-empty string.`)
    }
    if (typeof algorithm !== 'string' || algorithm.length === 0) {
      throw new Error(`KEYRING_CONFIG[${index}].algorithm must be a non-empty string.`)
    }
    if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(
        `KEYRING_CONFIG[${index}].key must be a 64-character hex string (256-bit key).`,
      )
    }
    if (capacity !== 'Active' && capacity !== 'DecryptOnly') {
      throw new Error(
        `KEYRING_CONFIG[${index}].capacity must be 'Active' or 'DecryptOnly'.`,
      )
    }

    return {
      kid,
      algorithm,
      key: Buffer.from(key, 'hex'),
      capacity,
    }
  })
}

export function createDefaultKeyRing(): KeyRing {
  const keyHex = process.env.ENCRYPTION_KEY
  if (!keyHex) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is not set. ' +
        'Configure it as a 64-character hex string (256-bit AES key).',
    )
  }
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (256-bit AES key). ' +
        `Got ${keyHex.length} chars with invalid hex format.`,
    )
  }

  const rawKey = Buffer.from(keyHex, 'hex')

  const legacyGCM: KeyMaterial = {
    kid: 'LEGACY_GCM',
    algorithm: 'aes-256-gcm',
    key: Buffer.from(rawKey),
    capacity: 'DecryptOnly',
  }

  const legacyCBC: KeyMaterial = {
    kid: 'LEGACY_CBC',
    algorithm: 'aes-256-cbc',
    key: Buffer.from(rawKey),
    capacity: 'DecryptOnly',
  }

  // ACTIVE_V1: HKDF-derived (RFC 5869) with empty salt and KID-scoped info.
  // The empty salt produces a deterministic PRK = HMAC-SHA256(zeros_32, IKM),
  // same as RFC 5869's default when salt is omitted.
  const salt = Buffer.alloc(0)
  const info = Buffer.from('wacrm:crypto:ACTIVE_V1', 'utf8')
  const activeKey = Buffer.from(hkdfSync('sha256', rawKey, salt, info, 32))

  const activeV1: KeyMaterial = {
    kid: 'ACTIVE_V1',
    algorithm: 'aes-256-gcm',
    key: activeKey,
    capacity: 'Active',
  }

  return new KeyRing([legacyGCM, legacyCBC, activeV1, ...parseAdditionalKeyRingEntries()])
}
