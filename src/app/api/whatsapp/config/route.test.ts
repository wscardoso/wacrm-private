import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================
// Gate 4 — UAZAPI INBOUND RECOVERY (Z-API was removed; its rejection is covered
// at the end of this file).
//
// Proves, against the REAL bootstrapConnection()/generateConnectionId()/
// hashWebhookSecret() (src/lib/whatsapp/webhook-auth.ts, NOT mocked),
// that POST /api/whatsapp/config:
//   1. Never inserts a whatsapp_config row without connection_id (the
//      NOT NULL column from 036_webhook_nonmeta_security.sql that had no
//      DB default — the root cause of the "connect a number" impeditivo).
//   2. Calls bootstrapConnection() for uazapi after every save, and
//      it is idempotent-safe: an already-initialized connection is never
//      silently re-rotated by a routine credential re-save.
//   3. Returns connection_id + the one-time plaintext webhook_secret in
//      the JSON response, and the persisted hash is EXACTLY
//      hashWebhookSecret(returned secret) — i.e. the secret the UI shows
//      the operator is the one the real webhook route
//      ([provider]/[connectionId]/[webhookSecret]) will actually accept.
//   4. Meta rows also get a connection_id (needed only to satisfy the
//      shared NOT NULL column — Meta's own webhook route never uses it)
//      and never call bootstrapConnection.
// =============================================================

const { mockRequireRole, mockUazapiCheckStatus, mockServerClient } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockUazapiCheckStatus: vi.fn(),
  mockServerClient: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mockRequireRole,
  toErrorResponse: (err: unknown) =>
    NextResponse.json({ error: (err as Error).message ?? 'Auth error' }, { status: 401 }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  registerPhoneNumber: vi.fn().mockResolvedValue({}),
  subscribeWabaToApp: vi.fn().mockResolvedValue({}),
  verifyPhoneNumber: vi.fn().mockResolvedValue({ verified_name: 'Test Clinic' }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (t: string) => `enc:${t}`,
  encryptWithBindingContext: (t: string) => `enc:${t}`,
  decryptWithBindingContext: (t: string) => t.replace(/^enc:/, ''),
}))

vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
  isWhatsappConfigCanonicalWriteEnabled: () => false,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: mockServerClient,
}))

vi.mock('@/lib/whatsapp/providers/uazapi', () => ({
  UazapiProvider: class {
    checkStatus() { return mockUazapiCheckStatus() }
  },
}))

// admin-client is shared by config/route.ts (Meta "claimed number" check)
// AND, transitively, by bootstrapConnection() inside webhook-auth.ts —
// mocking the module once covers both call sites. webhook-auth.ts itself
// is NOT mocked: generateConnectionId/hashWebhookSecret/bootstrapConnection
// run for real.
function mockSupabase(defaultResult: unknown = { data: null, error: null }) {
  const tables = new Map<string, unknown>()
  const makeChain = (result: unknown) => {
    const c: Record<string, unknown> = { then: (resolve: (v: unknown) => void) => resolve(result) }
    for (const m of ['select', 'eq', 'neq', 'single', 'maybeSingle', 'order', 'limit', 'update', 'insert']) {
      c[m] = vi.fn(() => c)
    }
    return c
  }
  return {
    from: vi.fn((table: string) => tables.get(table) ?? makeChain(defaultResult)),
    setResult(table: string, result: unknown) {
      tables.set(table, makeChain(result))
    },
  }
}

const { mockSupabaseAdmin } = vi.hoisted(() => ({ mockSupabaseAdmin: vi.fn() }))
vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: mockSupabaseAdmin,
}))

import { hashWebhookSecret } from '@/lib/whatsapp/webhook-auth'
import { GET, POST } from './route'

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/whatsapp/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let sessionDb: ReturnType<typeof mockSupabase>
let adminDb: ReturnType<typeof mockSupabase>

beforeEach(() => {
  vi.clearAllMocks()

  sessionDb = mockSupabase({ data: null, error: null }) // "existing" lookups -> no row (fresh account) by default
  adminDb = mockSupabase({ data: null, error: null })   // "claimed number" check -> nobody else has it

  mockSupabaseAdmin.mockReturnValue(adminDb)
  mockRequireRole.mockResolvedValue({ supabase: sessionDb, userId: 'user-1', accountId: 'acc-1' })
  mockUazapiCheckStatus.mockResolvedValue({ connected: true })
})

describe('POST /api/whatsapp/config — criação de conexão (uazapi)', () => {
  it('primeira conexão: insere connection_id (NOT NULL sem default), bootstrap gera segredo, resposta traz connection_id + webhook_secret coerentes com o hash persistido', async () => {
    // "existing" select -> no row (fresh insert path)
    sessionDb.setResult('whatsapp_config', { data: null, error: null })

    // bootstrapConnection's internal supabaseAdmin() lookup: after the
    // route inserts a row with a freshly generated connection_id, the
    // bootstrap SELECT must find it with webhook_secret_hash still NULL.
    let insertedConnectionId = ''
    const insertSpy = vi.fn((row: Record<string, unknown>) => {
      insertedConnectionId = row.connection_id as string
      return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
    })
    ;(sessionDb.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'whatsapp_config') return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })), // no existing row
        insert: insertSpy,
      }
      return chain
    })

    const updateSpy = vi.fn((_row: Record<string, unknown>) => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) }))
    ;(adminDb.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'whatsapp_config') return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(() =>
          Promise.resolve({
            data: { id: 'cfg-1', connection_id: insertedConnectionId, webhook_secret_hash: null },
            error: null,
          }),
        ),
        update: updateSpy,
      }
      return chain
    })

    const res = await POST(request({ provider: 'uazapi', instance_id: 'inst-1', base_url: 'https://my-server.com', access_token: 'tok' }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(insertSpy).toHaveBeenCalled()
    // Root-cause regression guard: the insert MUST carry a non-empty connection_id.
    expect(insertedConnectionId).toBeTruthy()

    expect(data.connection_id).toBe(insertedConnectionId)
    expect(typeof data.webhook_secret).toBe('string')
    expect(data.webhook_secret.length).toBeGreaterThan(20)

    // What bootstrapConnection persisted as the hash must match the secret
    // handed back to the UI — this is exactly what the webhook route will
    // hash-and-compare on the next inbound request.
    const persistedRow = updateSpy.mock.calls[0]?.[0] as { webhook_secret_hash: string; connection_id: string } | undefined
    expect(persistedRow?.webhook_secret_hash).toBe(hashWebhookSecret(data.webhook_secret))
    expect(persistedRow?.connection_id).toBe(insertedConnectionId)
  })

  it('conexão já inicializada: bootstrap não sobrescreve o segredo existente e a resposta não revela nenhum segredo', async () => {
    const EXISTING_CONN = 'conn-already-there'
    const sessionUpdateSpy = vi.fn((...args: [Record<string, unknown>]) => { void args; return { eq: vi.fn(() => Promise.resolve({ data: null, error: null })) } })

    ;(sessionDb.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'whatsapp_config') return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(() =>
          Promise.resolve({ data: { id: 'cfg-1', connection_id: EXISTING_CONN }, error: null }),
        ),
        update: sessionUpdateSpy,
      }
      return chain
    })

    const adminUpdateSpy = vi.fn()
    ;(adminDb.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'whatsapp_config') return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(() =>
          Promise.resolve({
            data: { id: 'cfg-1', connection_id: EXISTING_CONN, webhook_secret_hash: 'already-set-hash' },
            error: null,
          }),
        ),
        update: adminUpdateSpy,
      }
      return chain
    })

    const res = await POST(request({ provider: 'uazapi', instance_id: 'inst-1', base_url: 'https://my-server.com', access_token: 'tok' }))
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.connection_id).toBe(EXISTING_CONN) // unchanged — a live webhook URL must keep working
    expect(data.webhook_secret).toBeNull() // never re-revealed
    expect(adminUpdateSpy).not.toHaveBeenCalled() // bootstrapConnection refused to overwrite
    // Re-saving an existing row (e.g. one migrated from Z-API) clears the Meta-only waba_id
    // column, so the legacy encrypted Security Token is not kept in a uazapi connection.
    expect(sessionUpdateSpy).toHaveBeenCalledTimes(1)
    expect(sessionUpdateSpy.mock.calls[0][0]).toMatchObject({ provider: 'uazapi', waba_id: null })
  })

  it('uazapi: nova conexão grava waba_id = null (coluna Meta-only, antes usada pelo Security Token da Z-API) e ignora client_token', async () => {
    let insertedConnectionId = ''
    let insertedRow: Record<string, unknown> | null = null
    ;(sessionDb.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'whatsapp_config') return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        insert: vi.fn((row: Record<string, unknown>) => {
          insertedRow = row
          insertedConnectionId = row.connection_id as string
          return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
        }),
      }
      return chain
    })
    ;(adminDb.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'whatsapp_config') return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(() =>
          Promise.resolve({ data: { id: 'cfg-2', connection_id: insertedConnectionId, webhook_secret_hash: null }, error: null }),
        ),
        update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) })),
      }
      return chain
    })

    const res = await POST(
      request({ provider: 'uazapi', instance_id: 'inst-2', base_url: 'https://my-server.com', access_token: 'tok', client_token: 'legacy-security-token' }),
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(insertedConnectionId).toBeTruthy()
    expect(data.connection_id).toBe(insertedConnectionId)
    expect(typeof data.webhook_secret).toBe('string')
    expect(insertedRow).toMatchObject({ provider: 'uazapi', instance_id: 'inst-2', base_url: 'https://my-server.com' })
    expect((insertedRow as unknown as Record<string, unknown>).waba_id).toBeNull()
    expect(JSON.stringify(insertedRow)).not.toContain('legacy-security-token')
  })
})

// =============================================================
// Z-API removal — a discontinued provider is rejected explicitly. It must
// never fall through to the Meta flow (which would persist a Z-API
// credential as a Meta config) and no row may be written.
// =============================================================
describe('Z-API removed', () => {
  it('POST provider=zapi → 400, nothing is read, verified, written or bootstrapped', async () => {
    const res = await POST(request({ provider: 'zapi', instance_id: 'inst-1', access_token: 'tok' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Z-API is no longer supported/)
    expect(sessionDb.from).not.toHaveBeenCalled()
    expect(adminDb.from).not.toHaveBeenCalled()
    expect(mockUazapiCheckStatus).not.toHaveBeenCalled()
  })

  it('POST provider=zapi is rejected even when the account already has a zapi row (no more grandfathering)', async () => {
    sessionDb.setResult('whatsapp_config', { data: { provider: 'zapi', id: 'cfg-legacy' }, error: null })
    const res = await POST(request({ provider: 'zapi', instance_id: 'inst-1', access_token: 'tok' }))
    expect(res.status).toBe(400)
  })

  it('GET on a legacy zapi row reports it as unsupported (200, connected:false) without calling any provider', async () => {
    const legacyRow = { data: { provider: 'zapi', access_token: 'enc:tok', instance_id: 'inst-1', base_url: null, waba_id: 'enc:sec', phone_number_id: 'inst-1', status: 'connected' }, error: null }
    mockServerClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
      from: (table: string) => {
        const chain: Record<string, unknown> = {}
        const result = table === 'profiles' ? { data: { account_id: 'acc-1' }, error: null } : legacyRow
        for (const m of ['select', 'eq']) chain[m] = vi.fn(() => chain)
        chain.maybeSingle = vi.fn(() => Promise.resolve(result))
        return chain
      },
    })

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ connected: false, reason: 'provider_unsupported' })
    expect(mockUazapiCheckStatus).not.toHaveBeenCalled()
  })
})

describe('POST /api/whatsapp/config — Meta: connection_id satisfaz a coluna NOT NULL sem acionar bootstrap', () => {
  it('insere connection_id em uma conexão Meta nova e nunca chama bootstrapConnection (sem webhook_secret na resposta)', async () => {
    let insertedRow: Record<string, unknown> | null = null

    ;(sessionDb.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table !== 'whatsapp_config') return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })), // fresh account
        insert: vi.fn((row: Record<string, unknown>) => {
          insertedRow = row
          return { then: (r: (v: unknown) => void) => r({ data: null, error: null }) }
        }),
      }
      return chain
    })

    const res = await POST(
      request({ provider: 'meta', phone_number_id: '1234567890', access_token: 'tok' }),
    )
    const data = await res.json()

    expect(res.status).toBe(200)
    expect(data.success).toBe(true)
    expect(insertedRow).not.toBeNull()
    // Root-cause regression guard, Meta side: connection_id must be present
    // even though Meta's own webhook route never reads it.
    expect((insertedRow as unknown as Record<string, unknown>).connection_id).toBeTruthy()
    expect(data.webhook_secret).toBeUndefined()
  })
})
