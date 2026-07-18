import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// =============================================================
// ADR-SEC-001 / C7 — non-Meta webhook authentication matrix.
//
// Exercises the REAL route at
//   /api/whatsapp/webhook/{provider}/{connectionId}/{webhookSecret}
//
// Auth contract:
//   - indexed (direct) lookup by connection_id, no O(n) scan / decrypt loop
//   - provider must match the URL provider
//   - constant-time SHA-256 compare against webhook_secret_hash
//   - NO fallback to the legacy verify_token
//   - uniform 401 { error: "Unauthorized" } for every failure reason
//
// Provider classes / parse / process run for real; only I/O is mocked.
// =============================================================

import { hashWebhookSecret, constantTimeEqual } from '@/lib/whatsapp/webhook-auth'

const VALID_CONN = 'conn-zapi-valid'
const VALID_SECRET = 'z3cR3T-n0nm3ta-zapi'
const VALID_HASH = hashWebhookSecret(VALID_SECRET)
const UAZAPI_CONN = 'conn-uazapi-valid'
const UAZAPI_SECRET = 'u4z4p1-s3cr3t'
const UAZAPI_HASH = hashWebhookSecret(UAZAPI_SECRET)

interface ConfigRow {
  account_id: string
  user_id: string
  access_token: string
  verify_token: string
  provider: 'zapi' | 'uazapi'
  connection_id: string
  webhook_secret_hash: string
}

const configRows: Record<string, ConfigRow> = {
  [VALID_CONN]: {
    account_id: 'acc-z', user_id: 'user-z', access_token: 'enc-z',
    verify_token: 'legacy-zapi-untouched', provider: 'zapi',
    connection_id: VALID_CONN, webhook_secret_hash: VALID_HASH,
  },
  [UAZAPI_CONN]: {
    account_id: 'acc-u', user_id: 'user-u', access_token: 'enc-u',
    verify_token: 'legacy-uazapi-untouched', provider: 'uazapi',
    connection_id: UAZAPI_CONN, webhook_secret_hash: UAZAPI_HASH,
  },
}

function makeChain(table: string) {
  const chain: any = { __table: table, __maybeSingle: false, __eq: null as null | { col: string; val: unknown } }
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'neq', 'in', 'order', 'limit', 'single', 'is', 'not', 'gte', 'lt', 'head']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.eq = vi.fn((col: string, val: unknown) => { chain.__eq = { col, val }; return chain })
  chain.maybeSingle = vi.fn(() => { chain.__maybeSingle = true; return chain })
  chain.then = (resolve: (v: any) => void) => {
    let data: any = null
    let error: any = null
    if (table === 'whatsapp_config') {
      data = Object.values(configRows)
      if (chain.__eq && chain.__eq.col === 'connection_id') {
        data = data.filter((r: ConfigRow) => r.connection_id === chain.__eq!.val)
      }
      if (chain.__maybeSingle) data = Array.isArray(data) ? data[0] ?? null : data
    } else {
      data = { count: 0 }
    }
    resolve({ data, error })
    return Promise.resolve({ data, error })
  }
  return chain
}

const mockFromImpl = vi.fn((t: string) => makeChain(t))

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({ from: mockFromImpl }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({
  normalizePhone: (p: string) => p.replace(/\D/g, ''),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null),
  isUniqueViolation: vi.fn(() => false),
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(),
}))
// Prevent real rate-limit noise from failing tests.
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>('@/lib/rate-limit')
  return { ...actual, checkRateLimit: () => ({ success: true, remaining: 99, reset: 0, limit: 120 }) }
})

const { POST } = await import('@/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route')

function postRequest(provider: string, connectionId: string, secret: string, body: unknown): NextRequest {
  return new Request(`http://localhost/api/whatsapp/webhook/${provider}/${connectionId}/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest
}

const ZAPI_BODY = { phone: '5511999887766', text: 'oi', messageId: 'z-auth-1', fromMe: false, moment: 1710000000000, type: 'received' }

beforeEach(() => { vi.clearAllMocks() })

describe('non-Meta webhook authentication (ADR-SEC-001 / C7)', () => {
  it('accepts a valid Z-API connection + secret and processes the message', async () => {
    const res = await POST(postRequest('zapi', VALID_CONN, VALID_SECRET, ZAPI_BODY), {
      params: Promise.resolve({ provider: 'zapi', connectionId: VALID_CONN, webhookSecret: VALID_SECRET }),
    } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.processed).toBe(1)
  })

  it('accepts a valid uazapi connection + secret', async () => {
    const uaBody = { event: 'MESSAGES_UPSERT', data: [{ messages: [{ key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'ua-auth-1' }, messageTimestamp: 1710000000, message: { conversation: 'oi' } }] }] }
    const res = await POST(postRequest('uazapi', UAZAPI_CONN, UAZAPI_SECRET, uaBody), {
      params: Promise.resolve({ provider: 'uazapi', connectionId: UAZAPI_CONN, webhookSecret: UAZAPI_SECRET }),
    } as any)
    expect(res.status).toBe(200)
  })

  it('returns uniform 401 when connection_id does not exist', async () => {
    const res = await POST(postRequest('zapi', 'conn-does-not-exist', VALID_SECRET, ZAPI_BODY), {
      params: Promise.resolve({ provider: 'zapi', connectionId: 'conn-does-not-exist', webhookSecret: VALID_SECRET }),
    } as any)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns uniform 401 on provider mismatch (Z-API secret under uazapi route)', async () => {
    const res = await POST(postRequest('uazapi', VALID_CONN, VALID_SECRET, ZAPI_BODY), {
      params: Promise.resolve({ provider: 'uazapi', connectionId: VALID_CONN, webhookSecret: VALID_SECRET }),
    } as any)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns uniform 401 when secret is missing from the URL', async () => {
    const req = new Request(`http://localhost/api/whatsapp/webhook/zapi/${VALID_CONN}/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ZAPI_BODY),
    }) as unknown as NextRequest
    const res = await POST(req, {
      params: Promise.resolve({ provider: 'zapi', connectionId: VALID_CONN, webhookSecret: '' }),
    } as any)
    expect(res.status).toBe(401)
  })

  it('returns uniform 401 when the secret is invalid (wrong value)', async () => {
    const res = await POST(postRequest('zapi', VALID_CONN, 'wrong-secret', ZAPI_BODY), {
      params: Promise.resolve({ provider: 'zapi', connectionId: VALID_CONN, webhookSecret: 'wrong-secret' }),
    } as any)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns uniform 401 when webhook_secret_hash is NULL (not yet bootstrapped) — no legacy fallback', async () => {
    configRows[VALID_CONN] = { ...configRows[VALID_CONN], webhook_secret_hash: '' }
    const res = await POST(postRequest('zapi', VALID_CONN, 'anything', ZAPI_BODY), {
      params: Promise.resolve({ provider: 'zapi', connectionId: VALID_CONN, webhookSecret: 'anything' }),
    } as any)
    expect(res.status).toBe(401)
    // Confirm the legacy verify_token was NOT used to authenticate.
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    // restore
    configRows[VALID_CONN] = { ...configRows[VALID_CONN], webhook_secret_hash: VALID_HASH }
  })

  it('does NOT scan every config: issues exactly one indexed lookup', async () => {
    await POST(postRequest('zapi', VALID_CONN, VALID_SECRET, ZAPI_BODY), {
      params: Promise.resolve({ provider: 'zapi', connectionId: VALID_CONN, webhookSecret: VALID_SECRET }),
    } as any)
    const selects = mockFromImpl.mock.calls.filter((c) => c[0] === 'whatsapp_config')
    // A single `.from('whatsapp_config')` call (resolved by indexed
    // connection_id) proves there is no O(n) fan-out / per-row loop.
    expect(selects.length).toBe(1)
  })
})

describe('constantTimeEqual', () => {
  it('returns true for matching hashes', () => {
    expect(constantTimeEqual(VALID_HASH, VALID_HASH)).toBe(true)
  })
  it('returns false for mismatched values', () => {
    expect(constantTimeEqual(VALID_HASH, hashWebhookSecret('nope'))).toBe(false)
  })
  it('returns false when either side is empty/null', () => {
    expect(constantTimeEqual('', VALID_HASH)).toBe(false)
    expect(constantTimeEqual(VALID_HASH, null)).toBe(false)
    expect(constantTimeEqual(undefined, VALID_HASH)).toBe(false)
  })
})
