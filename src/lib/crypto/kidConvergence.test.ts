import { describe, it, expect } from 'vitest'
import { needsKidConvergence, getCurrentWriteKid } from './kidConvergence'
import { encryptWithBindingContext } from '@/lib/whatsapp/encryption'

describe('getCurrentWriteKid', () => {
  it('returns the KID of the default Key Ring write key (ACTIVE_V1)', () => {
    expect(getCurrentWriteKid()).toBe('ACTIVE_V1')
  })
})

describe('needsKidConvergence', () => {
  it('returns false when the canonical envelope is already under the current write KID', () => {
    const token = encryptWithBindingContext('secret', 'whatsapp_config:acct-1')
    expect(needsKidConvergence(token, 'ACTIVE_V1')).toBe(false)
  })

  it('returns true when the canonical envelope is under a KID other than the current write KID', () => {
    const token = encryptWithBindingContext('secret', 'whatsapp_config:acct-1')
    // The envelope was produced under ACTIVE_V1 (the only write KID this
    // test environment has); simulate a rotation having since promoted a
    // different KID to Active.
    expect(needsKidConvergence(token, 'ACTIVE_V2')).toBe(true)
  })

  it('returns false for a legacy GCM ciphertext (iv:ct:tag) — not this helper\'s job', () => {
    expect(needsKidConvergence('aabbcc:ddeeff:112233', 'ACTIVE_V1')).toBe(false)
  })

  it('returns false for a legacy CBC ciphertext (iv:ct) — not this helper\'s job', () => {
    expect(needsKidConvergence('aabbcc:ddeeff', 'ACTIVE_V1')).toBe(false)
  })

  it('returns false for an invalid/garbage value — never throws', () => {
    expect(() => needsKidConvergence('not-a-valid-envelope!!', 'ACTIVE_V1')).not.toThrow()
    expect(needsKidConvergence('not-a-valid-envelope!!', 'ACTIVE_V1')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(needsKidConvergence('', 'ACTIVE_V1')).toBe(false)
  })

  it('returns false for a truncated/corrupted canonical envelope rather than throwing', () => {
    const token = encryptWithBindingContext('secret', 'whatsapp_config:acct-1')
    const truncated = token.slice(0, Math.floor(token.length / 2))
    expect(() => needsKidConvergence(truncated, 'ACTIVE_V1')).not.toThrow()
    expect(needsKidConvergence(truncated, 'ACTIVE_V1')).toBe(false)
  })
})
