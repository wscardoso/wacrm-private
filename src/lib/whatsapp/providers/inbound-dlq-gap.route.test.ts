import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================
// C6.2 — inbound DLQ capture (whatsapp_webhook_dlq, migrations 031/082).
//
// Originally gap-characterization tests (C6.1). C6.2 wired the capture, so the
// characterization assertions were INVERTED deliberately and the two
// `it.fails` cases became ordinary tests. Richer cases live in
// inbound-dlq-capture.route.test.ts.
//
// Real uazapi provider route and real processInboundMessage; only I/O is
// mocked.
// =============================================================

import { hashWebhookSecret } from '@/lib/whatsapp/webhook-auth'

const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = []
let insertMode: 'ok' | 'error' | 'reject' = 'ok'

const CONN = 'conn-test-uazapi-dlq'
const SECRET = 's3cr3t-uazapi-dlq-gap'
const HASH = hashWebhookSecret(SECRET)

function makeChain(table: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = { __table: table, __maybeSingle: false }
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'order', 'limit', 'single', 'is', 'not', 'gte', 'lt', 'head']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.maybeSingle = vi.fn(() => { chain.__maybeSingle = true; return chain })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain.then = (resolve: (v: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = null
    if (table === 'whatsapp_config') {
      data = [{
        id: 'cfg-1', account_id: 'acc-1', user_id: 'user-1', access_token: 'enc-token',
        verify_token: 'x', instance_id: 'inst-1', base_url: 'https://x.uazapi.dev', provider: 'uazapi',
        connection_id: CONN, webhook_secret_hash: HASH,
      }]
      if (chain.__maybeSingle) data = data[0]
    } else if (table === 'conversations') {
      data = { id: 'conv-1', unread_count: 0, account_id: 'acc-1', user_id: 'user-1', contact_id: 'contact-1' }
    } else if (table === 'contacts') {
      data = { id: 'contact-1', name: 'Bob' }
    } else {
      data = { count: 0 }
    }
    resolve({ data, error: null })
    return Promise.resolve({ data, error: null })
  }
  return chain
}

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => makeChain(t),
    rpc: (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params })
      if (fn === 'persist_inbound_message_with_turn' || fn === 'insert_inbound_message') {
        if (insertMode === 'reject') return Promise.reject(new Error('network down'))
        if (insertMode === 'error') return Promise.resolve({ data: null, error: { message: 'db unavailable' } })
        return Promise.resolve({ data: { message_id: 'id-1', message_inserted: true, job_ready: true }, error: null })
      }
      // The real RPC returns the new row's uuid; without an id a capture cannot be confirmed.
      if (fn === 'enqueue_webhook_dlq') return Promise.resolve({ data: 'dlq-1', error: null })
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => v, decrypt: (v: string) => v,
  encryptWithBindingContext: (v: string) => v, decryptWithBindingContext: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/phone-utils', () => ({ normalizePhone: (p: string) => p.replace(/\D/g, '') }))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => null), isUniqueViolation: vi.fn(() => false),
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })) }))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(), cancelPendingCadencesForContact: vi.fn(async () => 0),
}))
vi.mock('@/lib/whatsapp/status-handler', () => ({ handleCanonicalStatusEvent: vi.fn(async () => undefined) }))

const { POST } = await import('@/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route')

async function post(body: unknown) {
  const req = new Request(`http://localhost/api/whatsapp/webhook/uazapi/${CONN}/${SECRET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await POST(req, { params: Promise.resolve({ provider: 'uazapi', connectionId: CONN, webhookSecret: SECRET }) } as any)
  return { status: res.status, json: await res.json() }
}
const dlqCalls = () => rpcCalls.filter((c) => c.fn === 'enqueue_webhook_dlq')
const textMsg = {
  event: 'messages',
  data: [{ messages: [{ key: { remoteJid: '5511999887766@s.whatsapp.net', id: 'w.in.1' }, messageTimestamp: 1710000000, message: { conversation: 'oi' } }] }],
}

beforeEach(() => {
  rpcCalls.length = 0
  insertMode = 'ok'
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('C6.2 wiring: the only production reference to enqueue_webhook_dlq is the capture module', () => {
  it('no non-test source file under src/ other than inbound-dlq.ts references enqueue_webhook_dlq', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p); continue }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.|\.arch\./.test(name)) continue
        if (readFileSync(p, 'utf8').includes('enqueue_webhook_dlq')) hits.push(p.replaceAll('\\', '/').split('/src/')[1])
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(hits).toEqual(['lib/whatsapp/inbound-dlq.ts'])
  })
})

describe('C6.2: failures on the provider inbound route are captured, not invisible', () => {
  it('a thrown processing error is recorded via enqueue_webhook_dlq with account/config scope', async () => {
    insertMode = 'reject'
    const { status, json } = await post(textMsg)
    expect(status).toBe(500)
    expect(json.processed).toBe(0)
    expect(json.captured).toBe(1)
    expect(dlqCalls()).toHaveLength(1)
    expect(dlqCalls()[0].params).toMatchObject({ p_account_id: 'acc-1', p_whatsapp_config_id: 'cfg-1' })
  })

  it('a DB error inside processInboundMessage is surfaced (not counted as processed) and captured', async () => {
    insertMode = 'error'
    const { status, json } = await post(textMsg)
    expect(status).toBe(500)
    expect(json.processed).toBe(0)
    expect(json.captured).toBe(1)
    expect(dlqCalls()).toHaveLength(1)
  })
})
