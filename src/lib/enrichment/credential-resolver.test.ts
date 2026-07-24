import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRpc = vi.fn()

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: mockRpc,
  }),
}))

import { resolveCredential, CredentialResolutionError } from './credential-resolver'
import { encrypt, encryptWithBindingContext } from '@/lib/whatsapp/encryption'

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'

function mockCredential(row: Record<string, unknown> | null) {
  mockRpc.mockImplementation((name: string, params: Record<string, unknown>) => {
    if (name !== 'get_ad_account_credential') {
      throw new Error(`unexpected RPC in this test: ${name}`)
    }
    if (params?.p_account_id !== ACCOUNT_A && params?.p_account_id !== ACCOUNT_B) {
      return { data: null, error: null }
    }
    return { data: row, error: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── IMP-CRYPTO-001 RC1.3 Phase 3 — ad_account_credentials cutover ────────
// Domain Binding Context: `ad_account:{accountId}` (§3.4/§3.5).
// This domain is decrypt-only from app code (migration 055: "the DB never
// sees plaintext"; no app-tier encrypt call site exists yet for
// set_ad_account_credential), so only decryptWithBindingContext is
// exercised via resolveCredential — encryptWithBindingContext is used here
// purely to produce realistic canonical-envelope fixtures for the tests.

describe('resolveCredential — canonical envelope (post-cutover)', () => {
  it('decrypts a canonical envelope encrypted with the correct account-scoped BC', async () => {
    const ciphertext = encryptWithBindingContext('secret-ads-token', `ad_account:${ACCOUNT_A}`)
    mockCredential({ ciphertext, status: 'active', expires_at: null })

    const result = await resolveCredential(ACCOUNT_A)

    expect(result.token).toBe('secret-ads-token')
    expect(result.status).toBe('active')
    expect(result.expiresAt).toBeNull()
  })

  it('fails closed when the canonical envelope was encrypted for a different account (wrong BC)', async () => {
    // Simulates a ciphertext cross-wired to the wrong row — the AAD/tag
    // mismatch must fail closed, not silently return the wrong tenant's token.
    const ciphertext = encryptWithBindingContext('belongs-to-b', `ad_account:${ACCOUNT_B}`)
    mockCredential({ ciphertext, status: 'active', expires_at: null })

    await expect(resolveCredential(ACCOUNT_A)).rejects.toThrow(CredentialResolutionError)
    await expect(resolveCredential(ACCOUNT_A)).rejects.toMatchObject({
      code: 'credential_decrypt_error',
    })
  })

  it('roundtrips unicode / long tokens through the canonical envelope', async () => {
    const longToken = 'act_' + 'x'.repeat(300) + '-🦅'
    const ciphertext = encryptWithBindingContext(longToken, `ad_account:${ACCOUNT_A}`)
    mockCredential({ ciphertext, status: 'active', expires_at: null })

    const result = await resolveCredential(ACCOUNT_A)
    expect(result.token).toBe(longToken)
  })
})

describe('resolveCredential — legacy GCM ciphertext (pre-cutover data, still supported)', () => {
  it('decrypts a legacy-format ciphertext via the Recognition Tree (BC accepted but not verified, ADR §8.7)', async () => {
    const ciphertext = encrypt('legacy-ads-token')
    mockCredential({ ciphertext, status: 'active', expires_at: null })

    const result = await resolveCredential(ACCOUNT_A)
    expect(result.token).toBe('legacy-ads-token')
  })
})

describe('resolveCredential — non-crypto error paths (unchanged by this migration)', () => {
  it('throws credential_not_found when no row exists', async () => {
    mockCredential(null)
    await expect(resolveCredential(ACCOUNT_A)).rejects.toMatchObject({
      code: 'credential_not_found',
    })
  })

  it('throws credential_not_found when ciphertext is empty (revoked, per migration 055)', async () => {
    mockCredential({ ciphertext: '', status: 'revoked', expires_at: null })
    await expect(resolveCredential(ACCOUNT_A)).rejects.toMatchObject({
      code: 'credential_not_found',
    })
  })

  it('throws credential_revoked for a non-empty ciphertext marked revoked', async () => {
    const ciphertext = encryptWithBindingContext('stale', `ad_account:${ACCOUNT_A}`)
    mockCredential({ ciphertext, status: 'revoked', expires_at: null })
    await expect(resolveCredential(ACCOUNT_A)).rejects.toMatchObject({
      code: 'credential_revoked',
    })
  })

  it('throws credential_expired for status=expired', async () => {
    const ciphertext = encryptWithBindingContext('stale', `ad_account:${ACCOUNT_A}`)
    mockCredential({ ciphertext, status: 'expired', expires_at: null })
    await expect(resolveCredential(ACCOUNT_A)).rejects.toMatchObject({
      code: 'credential_expired',
    })
  })

  it('throws credential_expired when expires_at is in the past, even if status=active', async () => {
    const ciphertext = encryptWithBindingContext('stale', `ad_account:${ACCOUNT_A}`)
    mockCredential({
      ciphertext,
      status: 'active',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
    await expect(resolveCredential(ACCOUNT_A)).rejects.toMatchObject({
      code: 'credential_expired',
    })
  })

  it('throws credential_db_error when the RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    await expect(resolveCredential(ACCOUNT_A)).rejects.toMatchObject({
      code: 'credential_db_error',
    })
  })
})

describe('resolveCredential — tenant isolation of Binding Context', () => {
  it('the same ciphertext bytes cannot be replayed across two different accountId arguments', async () => {
    // account A's real envelope, but resolveCredential is called for account B —
    // the RPC mock only returns rows for their own account_id, so this models
    // a scenario where a caller passes the wrong accountId against a genuine
    // row (e.g. an application bug), not just a crafted ciphertext.
    const ciphertext = encryptWithBindingContext('a-only', `ad_account:${ACCOUNT_A}`)
    mockRpc.mockImplementation((name: string) => {
      if (name !== 'get_ad_account_credential') throw new Error('unexpected RPC')
      // Row is returned regardless of which account asked — isolates the
      // assertion to the crypto layer's BC verification, not the RPC's
      // account_id filter (already covered by D-8 isolation tests).
      return { data: { ciphertext, status: 'active', expires_at: null }, error: null }
    })

    await expect(resolveCredential(ACCOUNT_B)).rejects.toMatchObject({
      code: 'credential_decrypt_error',
    })
  })
})
