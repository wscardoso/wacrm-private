import crypto from 'crypto'
import { createDefaultKeyRing } from '../crypto/keyring'
import {
  CANONICAL_VERSION,
  encodeBase64url,
  decodeBase64url,
  serializeCanonical,
  parseCanonical,
  buildAAD,
  recognizeFormat,
} from '../crypto/envelope'
import type { KeyMaterial } from '../crypto/keyring'

/**
 * WhatsApp token encryption.
 *
 * Two permanently distinct API pairs (IMP-CRYPTO-001 RC1.2 §3.3/§4.1):
 *
 * Pre-cutover — `encrypt` / `decrypt` / `isLegacyFormat`:
 *   Untouched copy of the original pre-ADR implementation. No
 *   `bindingContext` parameter exists on these functions at all, and
 *   they never import from `lib/crypto/`. They produce and read ONLY
 *   the legacy formats below. Used exclusively by call sites that
 *   have not yet completed their domain's Phase 2 cutover. No call
 *   site is migrated by this change (Phase 2 of the IMP adds the new
 *   API only; call-site migration is Phase 3+, out of scope here).
 *
 *   Format — GCM (current):
 *     `<iv-hex>:<ciphertext-hex>:<authTag-hex>`      (three colons)
 *   Format — CBC (legacy, decrypt-only):
 *     `<iv-hex>:<ciphertext-hex>`                    (one colon)
 *
 * Post-cutover — `encryptWithBindingContext` / `decryptWithBindingContext`:
 *   `bindingContext: string` is required — no optional/undefined
 *   variant exists. The only API capable of producing or reading
 *   canonical envelopes (ADR-CRYPTO-001 §3.1). `decryptWithBindingContext`
 *   also reads legacy GCM/CBC ciphertexts via the Recognition Tree
 *   (IMP §5.1), since historical data remains legacy even after a
 *   domain's own cutover; Binding Context is accepted but not
 *   cryptographically verified for legacy, per ADR §8.7.
 *
 *   Canonical: `base64url(canonical binary envelope)` — the
 *   base64url encoding is a storage/transport representation only
 *   (IMP §4.4); the cryptographic representation remains the binary
 *   envelope defined by the ADR.
 */

// ─── Pre-cutover API (unchanged original implementation) ─────────────────

const ENCRYPTION_KEY = (() => {
  const key = process.env.ENCRYPTION_KEY
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is not set. ' +
      'Configure it as a 64-character hex string (256-bit AES key).',
    )
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (256-bit AES key). ' +
      `Got ${key.length} chars with invalid hex format.`,
    )
  }
  return key
})()

// 12 bytes is the NIST-recommended IV length for GCM — keeps the
// counter block well below 2^32 and matches the default web-crypto
// behaviour, so any future port is straightforward.
const GCM_IV_LENGTH = 12
const CBC_IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16

/** @deprecated pre-cutover API — removed in Phase 3 once every domain has cut over. */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(GCM_IV_LENGTH)
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv,
  )
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${encrypted}:${authTag.toString('hex')}`
}

/** @deprecated pre-cutover API — removed in Phase 3 once every domain has cut over. */
export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':')

  if (parts.length === 3) {
    // GCM — current format.
    const [ivHex, ctHex, tagHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    if (iv.length !== GCM_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM IV length ${iv.length}`,
      )
    }
    const authTag = Buffer.from(tagHex, 'hex')
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM auth-tag length ${authTag.length}`,
      )
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(ENCRYPTION_KEY, 'hex'),
      iv,
    )
    decipher.setAuthTag(authTag)
    let decrypted = decipher.update(ctHex, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  if (parts.length === 2) {
    // CBC — legacy. Read-only; `encrypt()` never produces this shape.
    const [ivHex, ctHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    if (iv.length !== CBC_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected CBC IV length ${iv.length}`,
      )
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(ENCRYPTION_KEY, 'hex'),
      iv,
    )
    let decrypted = decipher.update(ctHex, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  throw new Error(
    `Encrypted token has unrecognised format (expected 1 or 2 colons, got ${
      parts.length - 1
    })`,
  )
}

/**
 * Cheap format detector — call sites use this to decide whether to
 * write a refreshed GCM ciphertext back to the database after a
 * successful legacy decrypt. Does not attempt decryption; purely a
 * structural check.
 *
 * @deprecated pre-cutover API — removed in Phase 3 once every domain has cut over.
 */
export function isLegacyFormat(encryptedText: string): boolean {
  return encryptedText.split(':').length === 2
}

// ─── Post-cutover API (Binding-Context-aware, canonical envelope) ────────

const keyring = createDefaultKeyRing()

/**
 * Encrypts `data` into a canonical envelope (ADR-CRYPTO-001 §3.1),
 * authenticated with `bindingContext` in the AAD, and returns it as
 * base64url text (IMP §4.4 — storage representation only).
 *
 * `bindingContext` is required. There is no default and no optional
 * variant of this function — a caller that has not decided its
 * Binding Context formula must not call this function. The runtime
 * guard below is defense-in-depth for callers that bypass static
 * typing (e.g. an `any`-typed or dynamically constructed call).
 */
export function encryptWithBindingContext(
  data: string,
  bindingContext: string,
): string {
  if (typeof bindingContext !== 'string') {
    throw new Error('BINDING_CONTEXT_REQUIRED')
  }

  const keyMaterial = keyring.getWriteKey()
  const nonce = crypto.randomBytes(GCM_IV_LENGTH)

  // 1. Define header
  const header = {
    version: CANONICAL_VERSION,
    kid: keyMaterial.kid,
    algorithm: keyMaterial.algorithm,
    nonce,
  }

  // 2. Build AAD
  const aad = buildAAD(header, bindingContext)

  // 3. Create cipher
  // ACTIVE_V1 (the only write key) is always AES-GCM; keyMaterial.algorithm is
  // a runtime string (Key Ring config), so the AEAD overload must be asserted.
  const cipher = crypto.createCipheriv(
    keyMaterial.algorithm,
    keyMaterial.key,
    nonce,
  ) as crypto.CipherGCM

  // 4. setAAD() — before any encrypt call
  cipher.setAAD(aad)

  // 5. Encrypt
  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])

  // 6. Obtain authentication tag
  const authTag = cipher.getAuthTag()

  // 7. Serialize envelope (Cryptographic Representation)
  const envelope = serializeCanonical({
    version: header.version,
    kid: header.kid,
    algorithm: header.algorithm,
    nonce,
    ciphertext,
    authTag,
  })

  // Persistence Representation applied only here, at the storage boundary (§4.4)
  return encodeBase64url(envelope)
}

/**
 * Decrypts `token`, which may be a canonical envelope or a legacy
 * GCM/CBC ciphertext (Recognition Tree, IMP §5.1). `bindingContext`
 * is required and is cryptographically verified via AAD for
 * canonical envelopes; it is accepted but not verified for legacy
 * ciphertexts, per ADR §8.7.
 */
export function decryptWithBindingContext(
  token: string,
  bindingContext: string,
): string {
  if (typeof bindingContext !== 'string') {
    throw new Error('BINDING_CONTEXT_REQUIRED')
  }

  const result = recognizeFormat(token)

  switch (result.format) {
    case 'canonical': {
      const raw = decodeBase64url(token) // Persistence → Cryptographic Representation
      const envelope = parseCanonical(raw)

      const keyMaterial = keyring.resolve(envelope.kid)

      // Explicit I9 check — before any decrypt attempt
      if (envelope.algorithm !== keyMaterial.algorithm) {
        throw new Error('ALGORITHM_MISMATCH')
      }

      // 1. Header available from parsed envelope
      const header = {
        version: envelope.version,
        kid: envelope.kid,
        algorithm: envelope.algorithm,
        nonce: envelope.nonce,
      }

      // 2. Build AAD
      const aad = buildAAD(header, bindingContext)

      // 3. Create decipher
      // Canonical envelopes are always AEAD (GCM) — the I9 check above
      // already guarantees envelope.algorithm === keyMaterial.algorithm.
      const decipher = crypto.createDecipheriv(
        keyMaterial.algorithm,
        keyMaterial.key,
        envelope.nonce,
      ) as crypto.DecipherGCM

      // 4. setAAD() — before setAuthTag / update
      decipher.setAAD(aad)
      decipher.setAuthTag(envelope.authTag)

      // 5. Decrypt — throws on tag mismatch (wrong BC, tampering, or wrong key)
      return Buffer.concat([
        decipher.update(envelope.ciphertext),
        decipher.final(),
      ]).toString('utf8')
    }

    case 'legacy_gcm': {
      return legacyGCMDecrypt(token, keyring.resolve('LEGACY_GCM'))
    }

    case 'legacy_cbc': {
      return legacyCBCDecrypt(token, keyring.resolve('LEGACY_CBC'))
    }

    case 'invalid': {
      throw new Error('INVALID_ENVELOPE: token has unrecognised format')
    }
  }
}

// ─── Legacy decrypt helpers (used only by decryptWithBindingContext) ─────

function legacyGCMDecrypt(token: string, keyMaterial: KeyMaterial): string {
  const [ivHex, ctHex, tagHex] = token.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  if (iv.length !== GCM_IV_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected GCM IV length ${iv.length}`,
    )
  }
  const authTag = Buffer.from(tagHex, 'hex')
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected GCM auth-tag length ${authTag.length}`,
    )
  }
  const decipher = crypto.createDecipheriv(
    keyMaterial.algorithm,
    keyMaterial.key,
    iv,
  ) as crypto.DecipherGCM
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(ctHex, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}

function legacyCBCDecrypt(token: string, keyMaterial: KeyMaterial): string {
  const [ivHex, ctHex] = token.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  if (iv.length !== CBC_IV_LENGTH) {
    throw new Error(
      `Encrypted token has unexpected CBC IV length ${iv.length}`,
    )
  }
  const decipher = crypto.createDecipheriv(keyMaterial.algorithm, keyMaterial.key, iv)
  let decrypted = decipher.update(ctHex, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}
