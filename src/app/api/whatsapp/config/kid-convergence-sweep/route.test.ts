import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------

const mockSupabaseAdmin = vi.fn()
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}))

const mockIsLegacyFormat = vi.fn()
const mockDecrypt = vi.fn()
const mockEncrypt = vi.fn()
vi.mock('@/lib/whatsapp/encryption', () => ({
  isLegacyFormat: mockIsLegacyFormat,
  decryptWithBindingContext: mockDecrypt,
  encryptWithBindingContext: mockEncrypt,
}))

const mockIsWhatsappConfigCanonicalWriteEnabled = vi.fn()
vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
  isWhatsappConfigCanonicalWriteEnabled: mockIsWhatsappConfigCanonicalWriteEnabled,
}))

const mockNeedsKidConvergence = vi.fn()
const mockGetCurrentWriteKid = vi.fn()
vi.mock('@/lib/crypto/kidConvergence', () => ({
  needsKidConvergence: mockNeedsKidConvergence,
  getCurrentWriteKid: mockGetCurrentWriteKid,
}))

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function makeAdmin(rows: unknown[] | null, selectError: unknown = null) {
  const updateCalls: Array<{ table: string; values: Record<string, unknown>; id: string }> = []

  // The real route paginates via .order('id').limit(N), optionally
  // .gt('id', cursor), then awaits the whole builder — i.e. the chain
  // itself must be thenable, resolving only once, at the `await`, not
  // at any individual method call (matching the real PostgrestFilterBuilder).
  const chain: {
    select: ReturnType<typeof vi.fn>
    order: ReturnType<typeof vi.fn>
    gt: ReturnType<typeof vi.fn>
    limit: ReturnType<typeof vi.fn>
    then: (resolve: (v: { data: unknown[] | null; error: unknown }) => void) => void
    update: ReturnType<typeof vi.fn>
  } = {
    select: vi.fn(() => chain),
    order: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then: (resolve) => resolve({ data: rows, error: selectError }),
    update: vi.fn((values: Record<string, unknown>) => ({
      eq: vi.fn((_col: string, id: string) => {
        updateCalls.push({ table: 'whatsapp_config', values, id })
        return Promise.resolve({ error: null })
      }),
    })),
  }

  return {
    from: vi.fn(() => chain),
    _updateCalls: updateCalls,
  }
}

function req(secret: string | null): Request {
  const headers = new Headers()
  if (secret !== null) headers.set('x-cron-secret', secret)
  return new Request('http://localhost/api/whatsapp/config/kid-convergence-sweep', { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  mockIsLegacyFormat.mockReturnValue(false)
  mockIsWhatsappConfigCanonicalWriteEnabled.mockReturnValue(true)
  mockNeedsKidConvergence.mockReturnValue(false)
  mockGetCurrentWriteKid.mockReturnValue('ACTIVE_V2')
  mockDecrypt.mockImplementation((token: string) => `plaintext-of(${token})`)
  mockEncrypt.mockImplementation((plaintext: string, bc: string) => `reencrypted(${plaintext},${bc})`)
})

describe('GET /api/whatsapp/config/kid-convergence-sweep', () => {
  it('returns 503 when the cron secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const { GET } = await import('./route')
    const res = await GET(req('anything'))
    expect(res.status).toBe(503)
  })

  it('returns 401 when the supplied secret does not match', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('wrong-secret'))
    expect(res.status).toBe(401)
  })

  it('returns 401 when no secret is supplied', async () => {
    const { GET } = await import('./route')
    const res = await GET(req(null))
    expect(res.status).toBe(401)
  })

  it('is a no-op when canonical write is disabled for the domain', async () => {
    mockIsWhatsappConfigCanonicalWriteEnabled.mockReturnValue(false)
    const admin = makeAdmin([])
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ converged: 0 })
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('returns converged:0 when there are no rows', async () => {
    const admin = makeAdmin([])
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ converged: 0, scanned: 0 })
  })

  it('reconverges a row whose access_token is canonical but under a stale KID', async () => {
    const admin = makeAdmin([
      { id: 'row-1', account_id: 'acct-1', access_token: 'canonical-old-kid', verify_token: null, waba_id: null },
    ])
    mockSupabaseAdmin.mockReturnValue(admin)
    mockNeedsKidConvergence.mockImplementation((value: string) => value === 'canonical-old-kid')

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ converged: 1, scanned: 1 })
    expect(admin._updateCalls).toEqual([
      {
        table: 'whatsapp_config',
        id: 'row-1',
        values: { access_token: 'reencrypted(plaintext-of(canonical-old-kid),whatsapp_config:acct-1)' },
      },
    ])
  })

  it('skips a row already on the current KID (nothing to converge)', async () => {
    const admin = makeAdmin([
      { id: 'row-1', account_id: 'acct-1', access_token: 'canonical-current-kid', verify_token: null, waba_id: null },
    ])
    mockSupabaseAdmin.mockReturnValue(admin)
    mockNeedsKidConvergence.mockReturnValue(false)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(body).toEqual({ converged: 0, scanned: 1 })
    expect(admin._updateCalls).toEqual([])
  })

  it('skips a legacy-format value — that is the lazy self-heal\'s job, not this sweep\'s', async () => {
    const admin = makeAdmin([
      { id: 'row-1', account_id: 'acct-1', access_token: 'iv:ct:tag', verify_token: null, waba_id: null },
    ])
    mockSupabaseAdmin.mockReturnValue(admin)
    mockIsLegacyFormat.mockImplementation((value: string) => value === 'iv:ct:tag')

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(body).toEqual({ converged: 0, scanned: 1 })
    expect(admin._updateCalls).toEqual([])
    expect(mockNeedsKidConvergence).not.toHaveBeenCalled()
  })

  it('converges multiple stale columns on the same row in a single update', async () => {
    const admin = makeAdmin([
      {
        id: 'row-1',
        account_id: 'acct-1',
        access_token: 'stale-access',
        verify_token: 'stale-verify',
        waba_id: null,
      },
    ])
    mockSupabaseAdmin.mockReturnValue(admin)
    mockNeedsKidConvergence.mockImplementation((value: string) =>
      value === 'stale-access' || value === 'stale-verify',
    )

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(body).toEqual({ converged: 1, scanned: 1 })
    expect(admin._updateCalls).toHaveLength(1)
    expect(admin._updateCalls[0].values).toEqual({
      access_token: 'reencrypted(plaintext-of(stale-access),whatsapp_config:acct-1)',
      verify_token: 'reencrypted(plaintext-of(stale-verify),whatsapp_config:acct-1)',
    })
  })

  it('never alters the Binding Context used across decrypt and re-encrypt (ADR-E7-001 §13.2)', async () => {
    const admin = makeAdmin([
      { id: 'row-1', account_id: 'acct-42', access_token: 'stale-access', verify_token: null, waba_id: null },
    ])
    mockSupabaseAdmin.mockReturnValue(admin)
    mockNeedsKidConvergence.mockReturnValue(true)

    const { GET } = await import('./route')
    await GET(req('test-secret'))

    expect(mockEncrypt).toHaveBeenCalledWith(expect.any(String), 'whatsapp_config:acct-42')
  })

  it('does not crash the row when decryption fails, and does not update it', async () => {
    const admin = makeAdmin([
      { id: 'row-1', account_id: 'acct-1', access_token: 'corrupted', verify_token: null, waba_id: null },
    ])
    mockSupabaseAdmin.mockReturnValue(admin)
    mockNeedsKidConvergence.mockReturnValue(true)
    mockDecrypt.mockImplementation(() => {
      throw new Error('AUTH_TAG_MISMATCH')
    })

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ converged: 0, scanned: 1 })
    expect(admin._updateCalls).toEqual([])
  })

  it('returns 500 when the initial select fails', async () => {
    const admin = makeAdmin(null, { message: 'boom' })
    mockSupabaseAdmin.mockReturnValue(admin)

    const { GET } = await import('./route')
    const res = await GET(req('test-secret'))
    expect(res.status).toBe(500)
  })
})
