import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// C6.2 — unit tests for the inbound DLQ capture module: envelope minimisation,
// controlled error_message, explicit CaptureResult, failure classification and
// the architectural rule "capture never imports an engine".

let rpcImpl: (fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = []

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params })
      return rpcImpl(fn, params)
    },
  }),
}))

const {
  InboundPersistenceError,
  InboundPostInsertError,
  buildDlqEnvelope,
  buildDlqErrorMessage,
  captureInboundFailure,
  classifyInboundFailure,
  safeDbCode,
} = await import('./inbound-dlq')

const ACC = '11111111-1111-1111-1111-111111111111'
const CFG = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  rpcCalls.length = 0
  rpcImpl = async () => ({ data: 'dlq-id-1', error: null })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('buildDlqEnvelope — data minimisation', () => {
  it('keeps only identifiers and flags', () => {
    const env = buildDlqEnvelope('zapi', 'message_insert', {
      type: 'image',
      externalMessageId: 'w.in.1',
      timestamp: 1710000000123,
      hasMedia: true,
      hasContext: false,
    })
    expect(Object.keys(env).sort()).toEqual([
      'captured_at', 'event_timestamp', 'event_type', 'external_message_id',
      'has_context', 'has_media', 'source', 'stage', 'v',
    ])
    expect(env).toMatchObject({
      v: 1, source: 'zapi', stage: 'message_insert', event_type: 'image',
      external_message_id: 'w.in.1', event_timestamp: '1710000000123',
      has_media: true, has_context: false,
    })
  })

  it('does not copy phone, name, text, caption, filename, media or tokens even if the caller passes them', () => {
    const hostile = {
      type: 'text',
      externalMessageId: 'abc',
      timestamp: '1710000000',
      from: '5511999887766',
      phone: '5511999887766',
      senderName: 'Maria Silva',
      text: 'meu cpf é 123.456.789-00',
      caption: 'legenda',
      filename: 'rg.pdf',
      mediaRef: 'https://cdn.example/secret.jpg',
      accessToken: 'tok_live_123',
      webhookSecret: 's3cr3t',
    }
    const json = JSON.stringify(buildDlqEnvelope('meta', 'unexpected', hostile))
    for (const leak of ['5511999887766', 'Maria', 'cpf', '123.456', 'legenda', 'rg.pdf', 'cdn.example', 'tok_live', 's3cr3t']) {
      expect(json).not.toContain(leak)
    }
  })

  it('rejects ids/types/timestamps that do not look like identifiers (cannot smuggle free text)', () => {
    const env = buildDlqEnvelope('meta', 'contact', {
      type: 'Texto com espaço e PII 5511999887766',
      externalMessageId: 'id with spaces and 5511999887766@s.whatsapp.net  ',
      timestamp: '2024-03-09T10:00:00 Maria',
    })
    expect(env.event_type).toBe('unknown')
    expect(env.external_message_id).toBeNull()
    expect(env.event_timestamp).toBeNull()
  })
})

describe('buildDlqErrorMessage — application-controlled only', () => {
  it('never includes the raw error message', () => {
    const err = new Error('duplicate key value violates ... Key (phone)=(5511999887766) token=abc postgres://u:p@host/db')
    const msg = buildDlqErrorMessage('zapi', 'unexpected', null, err)
    expect(msg).toBe('source=zapi;stage=unexpected;db_code=none;error_type=Error')
    expect(msg).not.toMatch(/5511|postgres|token|duplicate/)
  })

  it('uses a validated db code and a generic name for non-Error throws', () => {
    expect(buildDlqErrorMessage('meta', 'message_insert', '23505')).toBe('source=meta;stage=message_insert;db_code=23505')
    expect(buildDlqErrorMessage('meta', 'unexpected', null, 'a string with 5511999887766')).toContain('error_type=NonError')
  })

  it('non-persistence stages (parse, token_decrypt) record only the error CLASS', () => {
    const e = new TypeError('Cannot read properties of null (reading "5511999887766")')
    expect(buildDlqErrorMessage('uazapi', 'parse', null, e)).toBe('source=uazapi;stage=parse;db_code=none;error_type=TypeError')
    expect(buildDlqErrorMessage('meta', 'token_decrypt', null, new Error('ciphertext xyz'))).toBe('source=meta;stage=token_decrypt;db_code=none;error_type=Error')
  })

  it('an Error whose NAME is hostile is neutralised', () => {
    const e = new Error('x')
    e.name = 'Boom 5511999887766 token'
    expect(buildDlqErrorMessage('meta', 'unexpected', null, e)).toContain('error_type=NonError')
  })

  it('safeDbCode only accepts short code-like strings', () => {
    expect(safeDbCode('23505')).toBe('23505')
    expect(safeDbCode('PGRST116')).toBe('PGRST116')
    expect(safeDbCode('has spaces')).toBeNull()
    expect(safeDbCode('5511999887766')).toBeNull()
    expect(safeDbCode(undefined)).toBeNull()
  })
})

describe('InboundPersistenceError carries no raw DB data', () => {
  it('stores stage + validated code only', () => {
    const e = new InboundPersistenceError('message_insert', 'Key (phone)=(5511999887766)')
    expect(e.stage).toBe('message_insert')
    expect(e.dbCode).toBeNull()
    expect(e.message).toBe('inbound persistence failed: message_insert')
  })
})

describe('classifyInboundFailure', () => {
  it('persistence error → capture at its stage', () => {
    expect(classifyInboundFailure(new InboundPersistenceError('contact'))).toEqual({ kind: 'capture', stage: 'contact', dbCode: null })
    expect(classifyInboundFailure(new InboundPersistenceError('message_insert', '23505'))).toEqual({ kind: 'capture', stage: 'message_insert', dbCode: '23505' })
  })
  it('post-insert error → NOT capturable', () => {
    expect(classifyInboundFailure(new InboundPostInsertError(new Error('x')))).toEqual({ kind: 'post_insert' })
  })
  it('any other exception → capture as "unexpected" (distinct stage)', () => {
    expect(classifyInboundFailure(new TypeError('x'))).toEqual({ kind: 'capture', stage: 'unexpected', dbCode: null })
    expect(classifyInboundFailure('boom')).toEqual({ kind: 'capture', stage: 'unexpected', dbCode: null })
  })
})

describe('captureInboundFailure — explicit result, never throws', () => {
  const base = {
    accountId: ACC, configId: CFG, source: 'zapi' as const, stage: 'message_insert' as const,
    error: new InboundPersistenceError('message_insert', '57P01'),
    event: { type: 'text', externalMessageId: 'w.in.1', timestamp: 1710000000123 },
  }

  it('calls the RPC once with the scoped ids and the minimised envelope', async () => {
    const r = await captureInboundFailure(base)
    expect(r).toEqual({ ok: true, dlqId: 'dlq-id-1' })
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].fn).toBe('enqueue_webhook_dlq')
    expect(rpcCalls[0].params).toMatchObject({
      p_account_id: ACC,
      p_whatsapp_config_id: CFG,
      p_error_message: 'source=zapi;stage=message_insert;db_code=57P01',
    })
    expect((rpcCalls[0].params.p_payload as { stage: string }).stage).toBe('message_insert')
  })

  it('rpc error → ok:false/rpc_error (and the RPC error message is not logged)', async () => {
    rpcImpl = async () => ({ data: null, error: { code: '42501', message: 'whatsapp_config does not belong to the account 5511999887766' } })
    const r = await captureInboundFailure(base)
    expect(r).toEqual({ ok: false, reason: 'rpc_error' })
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls)
    expect(logged).not.toContain('5511999887766')
  })

  it('rpc exception → ok:false/rpc_exception (does not throw)', async () => {
    rpcImpl = async () => { throw new Error('network down') }
    await expect(captureInboundFailure(base)).resolves.toEqual({ ok: false, reason: 'rpc_exception' })
  })

  it('rpc returning no id cannot be confirmed as captured → ok:false/no_id', async () => {
    rpcImpl = async () => ({ data: null, error: null })
    await expect(captureInboundFailure(base)).resolves.toEqual({ ok: false, reason: 'no_id' })
  })

  it('missing account/config → invalid_scope and the RPC is NOT called', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(captureInboundFailure({ ...base, configId: undefined as any })).resolves.toEqual({ ok: false, reason: 'invalid_scope' })
    await expect(captureInboundFailure({ ...base, accountId: '' })).resolves.toEqual({ ok: false, reason: 'invalid_scope' })
    expect(rpcCalls).toHaveLength(0)
  })
})

describe('architecture: capture is side-effect free', () => {
  it('inbound-dlq.ts does not import engines, flows, automations, cadences or the processor', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/whatsapp/inbound-dlq.ts'), 'utf8')
    const imports = [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    // The only runtime dependency is the DB client. Anything else (engines,
    // processor, send paths) would let capturing a failure cause an effect.
    expect(imports).toEqual(['@/lib/supabase/admin-client'])
  })
})
