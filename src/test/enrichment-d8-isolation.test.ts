import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRpc = vi.fn()

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: mockRpc,
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(),
}))

import { runEnrichmentCycle } from '@/lib/enrichment/orchestration'
import { decrypt } from '@/lib/whatsapp/encryption'

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
const ATTR_A = '00000000-0000-4a00-0000-0000000000a1'
const ATTR_B = '00000000-0000-4b00-0000-0000000000b1'
const TOKEN_A = 'token-tenant-a'
const TOKEN_B = 'token-tenant-b'
const CIPHER_A = 'cipher-a'
const CIPHER_B = 'cipher-b'

describe('D-8: tenant isolation in enrichment cycle', () => {
  const fetchTokens: string[] = []

  function buildCycleMocks(overrides?: {
    claimRows?: Array<Record<string, unknown>>
    credentialA?: Record<string, unknown> | null
    credentialB?: Record<string, unknown> | null
  }) {
    const hasOverride = overrides !== undefined
    const credA = hasOverride && 'credentialA' in overrides! ? overrides!.credentialA : { ciphertext: CIPHER_A, status: 'active', expires_at: null }
    const credB = hasOverride && 'credentialB' in overrides! ? overrides!.credentialB : { ciphertext: CIPHER_B, status: 'active', expires_at: null }
    const claimRows = overrides?.claimRows ?? [
      { attribution_id: ATTR_A, account_id: ACCOUNT_A, attempt_count: 0, last_error: null, ad_source_id: 'act_999' },
      { attribution_id: ATTR_B, account_id: ACCOUNT_B, attempt_count: 0, last_error: null, ad_source_id: 'act_888' },
    ]

    mockRpc.mockImplementation((name: string, params: Record<string, unknown>) => {
      switch (name) {
        case 'reclaim_stuck_enrichment':
        case 'expire_stale_enrichments':
          return { data: 0, error: null }
        case 'enqueue_pending_attributions':
          return { data: 2, error: null }
        case 'claim_enrichment_batch':
          return { data: claimRows, error: null }
        case 'get_ad_account_credential':
          if (params?.p_account_id === ACCOUNT_A && credA) return { data: credA, error: null }
          if (params?.p_account_id === ACCOUNT_B && credB) return { data: credB, error: null }
          return { data: null, error: null }
        case 'resolve_enrichment_success':
          return { data: {}, error: null }
        case 'resolve_enrichment_failure':
          return { data: {}, error: null }
        default:
          return { data: null, error: null }
      }
    })

    ;(decrypt as unknown as ReturnType<typeof vi.fn>).mockImplementation((ciphertext: string) => {
      if (ciphertext === CIPHER_A) return TOKEN_A
      if (ciphertext === CIPHER_B) return TOKEN_B
      throw new Error('decrypt failed')
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    fetchTokens.length = 0

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = new URL(url)
      const token = u.searchParams.get('access_token')
      fetchTokens.push(token!)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          campaign_id: 'camp_1',
          campaign: { name: 'Campaign' },
          adset_id: 'adset_1',
          adset: { name: 'Adset' },
          id: 'ad_1',
          name: 'Ad Name',
        }),
      })
    }))
  })

  it('each row uses its own tenant credential exclusively in a single cycle', async () => {
    buildCycleMocks()
    const result = await runEnrichmentCycle()

    expect(result.succeeded).toBe(2)
    expect(result.claimed).toBe(2)
    expect(fetchTokens).toHaveLength(2)
    expect(fetchTokens[0]).toBe(TOKEN_A)
    expect(fetchTokens[1]).toBe(TOKEN_B)
    expect(fetchTokens[0]).not.toBe(TOKEN_B)
    expect(fetchTokens[1]).not.toBe(TOKEN_A)
  })

  it('credential failure in one tenant does not affect the other', async () => {
    buildCycleMocks({ credentialB: null })
    const result = await runEnrichmentCycle()

    expect(result.succeeded).toBe(1)
    expect(result.failedPermanent).toBe(1)
    expect(result.failedTransient).toBe(0)
    expect(fetchTokens).toHaveLength(1)
    expect(fetchTokens[0]).toBe(TOKEN_A)
  })

  it('decrypt failure in one tenant does not leak credential to the other', async () => {
    buildCycleMocks()
    ;(decrypt as unknown as ReturnType<typeof vi.fn>).mockImplementation((ciphertext: string) => {
      if (ciphertext === CIPHER_A) return TOKEN_A
      throw new Error('decrypt failed')
    })

    const result = await runEnrichmentCycle()

    expect(result.succeeded).toBe(1)
    expect(result.failedPermanent).toBe(1)
    expect(fetchTokens).toHaveLength(1)
    expect(fetchTokens[0]).toBe(TOKEN_A)
  })

  it('missing ad_source_id in one row does not affect the other', async () => {
    buildCycleMocks({
      claimRows: [
        { attribution_id: ATTR_A, account_id: ACCOUNT_A, attempt_count: 0, last_error: null, ad_source_id: 'act_999' },
        { attribution_id: ATTR_B, account_id: ACCOUNT_B, attempt_count: 0, last_error: null, ad_source_id: null },
      ],
    })

    const result = await runEnrichmentCycle()

    expect(result.succeeded).toBe(1)
    expect(result.failedPermanent).toBe(1)
    expect(fetchTokens).toHaveLength(1)
    expect(fetchTokens[0]).toBe(TOKEN_A)
  })
})
