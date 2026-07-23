export const CANONICAL_VERSION = 0x01

export interface EnvelopeParams {
  version: number
  kid: string
  algorithm: string
  nonce: Buffer
  ciphertext: Buffer
  authTag: Buffer
}

export type EnvelopeFields = EnvelopeParams

export interface HeaderFields {
  version: number
  kid: string
  algorithm: string
  nonce: Buffer
}

export type FormatResult =
  | { format: 'canonical' }
  | { format: 'legacy_gcm' }
  | { format: 'legacy_cbc' }
  | { format: 'invalid' }

// ─── Base64url ────────────────────────────────────────────────────────────

export function encodeBase64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export function decodeBase64url(stored: string): Buffer {
  if (!isValidBase64url(stored)) {
    throw new Error('INVALID_BASE64URL')
  }
  return Buffer.from(stored, 'base64url')
}

function isValidBase64url(str: string): boolean {
  return str.length === 0 || /^[A-Za-z0-9\-_]+=*$/.test(str)
}

// ─── Serialization constants ─────────────────────────────────────────────

const SIZE_VERSION = 1
const SIZE_KID_LEN = 2
const SIZE_ALG_LEN = 2
const SIZE_NONCE_LEN = 1
const SIZE_CT_LEN = 4
const SIZE_TAG_LEN = 1

// ─── Canonical serialization (ADR §3.1.1) ────────────────────────────────

export function serializeCanonical(params: EnvelopeParams): Buffer {
  const kidBuf = Buffer.from(params.kid, 'utf8')
  const algBuf = Buffer.from(params.algorithm, 'utf8')

  const totalSize =
    SIZE_VERSION +
    SIZE_KID_LEN + kidBuf.length +
    SIZE_ALG_LEN + algBuf.length +
    SIZE_NONCE_LEN + params.nonce.length +
    SIZE_CT_LEN + params.ciphertext.length +
    SIZE_TAG_LEN + params.authTag.length

  const buf = Buffer.alloc(totalSize)
  let offset = 0

  buf[offset] = params.version
  offset += SIZE_VERSION

  buf.writeUInt16BE(kidBuf.length, offset)
  offset += SIZE_KID_LEN
  kidBuf.copy(buf, offset)
  offset += kidBuf.length

  buf.writeUInt16BE(algBuf.length, offset)
  offset += SIZE_ALG_LEN
  algBuf.copy(buf, offset)
  offset += algBuf.length

  buf[offset] = params.nonce.length
  offset += SIZE_NONCE_LEN
  params.nonce.copy(buf, offset)
  offset += params.nonce.length

  buf.writeUInt32BE(params.ciphertext.length, offset)
  offset += SIZE_CT_LEN
  params.ciphertext.copy(buf, offset)
  offset += params.ciphertext.length

  buf[offset] = params.authTag.length
  offset += SIZE_TAG_LEN
  params.authTag.copy(buf, offset)

  return buf
}

export function parseCanonical(buffer: Buffer): EnvelopeFields {
  let offset = 0

  function ensure(n: number, label: string): void {
    if (buffer.length - offset < n) {
      throw new Error(`INVALID_ENVELOPE: buffer too short for ${label}`)
    }
  }

  ensure(SIZE_VERSION, 'version')
  const version = buffer[offset]
  offset += SIZE_VERSION

  ensure(SIZE_KID_LEN, 'KID length')
  const kidLen = buffer.readUInt16BE(offset)
  offset += SIZE_KID_LEN
  ensure(kidLen, 'KID')
  const kid = buffer.toString('utf8', offset, offset + kidLen)
  offset += kidLen

  ensure(SIZE_ALG_LEN, 'algorithm length')
  const algLen = buffer.readUInt16BE(offset)
  offset += SIZE_ALG_LEN
  ensure(algLen, 'algorithm')
  const algorithm = buffer.toString('utf8', offset, offset + algLen)
  offset += algLen

  ensure(SIZE_NONCE_LEN, 'nonce length')
  const nonceLen = buffer[offset]
  offset += SIZE_NONCE_LEN
  ensure(nonceLen, 'nonce')
  const nonce = Buffer.from(buffer.subarray(offset, offset + nonceLen))
  offset += nonceLen

  ensure(SIZE_CT_LEN, 'ciphertext length')
  const ctLen = buffer.readUInt32BE(offset)
  offset += SIZE_CT_LEN
  ensure(ctLen, 'ciphertext')
  const ciphertext = Buffer.from(buffer.subarray(offset, offset + ctLen))
  offset += ctLen

  ensure(SIZE_TAG_LEN, 'auth tag length')
  const tagLen = buffer[offset]
  offset += SIZE_TAG_LEN
  ensure(tagLen, 'auth tag')
  const authTag = Buffer.from(buffer.subarray(offset, offset + tagLen))
  offset += tagLen

  if (offset !== buffer.length) {
    throw new Error('INVALID_ENVELOPE: trailing data after envelope')
  }

  return { version, kid, algorithm, nonce, ciphertext, authTag }
}

// ─── AAD Construction (ADR §3.1.3) ──────────────────────────────────────

export function buildAAD(header: HeaderFields, bindingContext: string): Buffer {
  const kidBuf = Buffer.from(header.kid, 'utf8')
  const algBuf = Buffer.from(header.algorithm, 'utf8')
  const bcBuf = Buffer.from(bindingContext, 'utf8')

  const totalSize =
    SIZE_VERSION +
    SIZE_KID_LEN + kidBuf.length +
    SIZE_ALG_LEN + algBuf.length +
    SIZE_NONCE_LEN + header.nonce.length +
    SIZE_KID_LEN + bcBuf.length

  const buf = Buffer.alloc(totalSize)
  let offset = 0

  buf[offset] = header.version
  offset += SIZE_VERSION

  buf.writeUInt16BE(kidBuf.length, offset)
  offset += SIZE_KID_LEN
  kidBuf.copy(buf, offset)
  offset += kidBuf.length

  buf.writeUInt16BE(algBuf.length, offset)
  offset += SIZE_ALG_LEN
  algBuf.copy(buf, offset)
  offset += algBuf.length

  buf[offset] = header.nonce.length
  offset += SIZE_NONCE_LEN
  header.nonce.copy(buf, offset)
  offset += header.nonce.length

  buf.writeUInt16BE(bcBuf.length, offset)
  offset += SIZE_KID_LEN
  bcBuf.copy(buf, offset)

  return buf
}

// ─── Recognition Tree (IMP §5.1) ────────────────────────────────────────

export function recognizeFormat(stored: string): FormatResult {
  // Level 1: Canonical attempt — decode-then-inspect
  if (isValidBase64url(stored)) {
    try {
      const decoded = Buffer.from(stored, 'base64url')
      if (decoded.length > 0 && decoded[0] === CANONICAL_VERSION) {
        return { format: 'canonical' }
      }
    } catch {
      // decode failed — not canonical
    }
  }

  // Level 2: Legacy recognition
  const normalized = stored.toLowerCase()

  if (/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(normalized)) {
    return { format: 'legacy_gcm' }
  }

  if (/^[0-9a-f]+:[0-9a-f]+$/.test(normalized)) {
    return { format: 'legacy_cbc' }
  }

  // Level 3: Fail closed
  return { format: 'invalid' }
}
