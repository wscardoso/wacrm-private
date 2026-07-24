import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encryptWithBindingContext, decryptWithBindingContext } from './encryption'
import {
  whatsappConfigBindingContext,
  isWhatsappConfigCanonicalWriteEnabled,
} from './config-binding'

// ─── IMP-CRYPTO-001 RC1.3 Phase 3.2 — whatsapp_config cutover ─────────────
// Domain Binding Context: `whatsapp_config:{account_id}` (§3.4/§3.5).
// Route-level tests mock the encryption module entirely (mocks updated in
// this same change); this file exercises the real crypto stack for the
// domain's BC formula and write-enablement gate, mirroring the approach
// used for ad_account_credentials in Phase 3.1.

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'

describe('whatsappConfigBindingContext', () => {
  it('produces the documented formula', () => {
    expect(whatsappConfigBindingContext(ACCOUNT_A)).toBe(`whatsapp_config:${ACCOUNT_A}`)
  })

  it('is stable across calls (deterministic, required for I14 AAD reproducibility)', () => {
    expect(whatsappConfigBindingContext(ACCOUNT_A)).toBe(whatsappConfigBindingContext(ACCOUNT_A))
  })

  it('differs between accounts', () => {
    expect(whatsappConfigBindingContext(ACCOUNT_A)).not.toBe(whatsappConfigBindingContext(ACCOUNT_B))
  })
})

describe('isWhatsappConfigCanonicalWriteEnabled', () => {
  const original = process.env.WHATSAPP_CONFIG_CANONICAL_WRITE

  afterEach(() => {
    if (original === undefined) delete process.env.WHATSAPP_CONFIG_CANONICAL_WRITE
    else process.env.WHATSAPP_CONFIG_CANONICAL_WRITE = original
  })

  it('defaults to disabled when unset (preserves legacy compatibility)', () => {
    delete process.env.WHATSAPP_CONFIG_CANONICAL_WRITE
    expect(isWhatsappConfigCanonicalWriteEnabled()).toBe(false)
  })

  it('is disabled for any value other than the literal string "true"', () => {
    process.env.WHATSAPP_CONFIG_CANONICAL_WRITE = '1'
    expect(isWhatsappConfigCanonicalWriteEnabled()).toBe(false)
  })

  it('is enabled only when explicitly set to "true"', () => {
    process.env.WHATSAPP_CONFIG_CANONICAL_WRITE = 'true'
    expect(isWhatsappConfigCanonicalWriteEnabled()).toBe(true)
  })
})

describe('whatsapp_config domain — real canonical envelope roundtrip', () => {
  it('decrypts a canonical envelope encrypted with the correct account-scoped BC', () => {
    const ciphertext = encryptWithBindingContext('meta-access-token', whatsappConfigBindingContext(ACCOUNT_A))
    const plaintext = decryptWithBindingContext(ciphertext, whatsappConfigBindingContext(ACCOUNT_A))
    expect(plaintext).toBe('meta-access-token')
  })

  it('fails closed when decrypted against a different account (BC/AAD mismatch)', () => {
    const ciphertext = encryptWithBindingContext('belongs-to-a', whatsappConfigBindingContext(ACCOUNT_A))
    expect(() =>
      decryptWithBindingContext(ciphertext, whatsappConfigBindingContext(ACCOUNT_B)),
    ).toThrow()
  })

  it('roundtrips independently for the three encrypted columns sharing one row (access_token, verify_token, waba_id client-token)', () => {
    const bc = whatsappConfigBindingContext(ACCOUNT_A)
    const accessToken = encryptWithBindingContext('access-token-value', bc)
    const verifyToken = encryptWithBindingContext('verify-token-value', bc)
    const clientToken = encryptWithBindingContext('client-token-value', bc)

    expect(decryptWithBindingContext(accessToken, bc)).toBe('access-token-value')
    expect(decryptWithBindingContext(verifyToken, bc)).toBe('verify-token-value')
    expect(decryptWithBindingContext(clientToken, bc)).toBe('client-token-value')
  })
})
