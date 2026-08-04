/**
 * E2.1-RC1 — B3 (determinismo da resolução) e B5 (isolamento).
 *
 * Verifica EIS-001 §4.1 (resolução), §4.3 + errata (fallback restrito),
 * §8 critério 14 (precedência da identidade registrada) e §8 critério 15
 * (duas contas portando o mesmo `messages.message_id`).
 *
 * O duplo mecanismo de resolução é verificado contra um PostgREST falso
 * que aplica os filtros de verdade sobre tabelas em memória. Um fake que
 * apenas devolvesse a resposta esperada não verificaria isolamento —
 * verificaria a expectativa do teste.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// PostgREST falso
// ---------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>

const db: Record<string, Row[]> = {
  message_external_ids: [],
  whatsapp_config: [],
  conversations: [],
  messages: [],
}

/** Erros injetáveis por tabela, para exercitar os caminhos de falha. */
const injectedError: Record<string, { message: string } | null> = {}

type Filter = { col: string; op: 'eq' | 'in'; val: any }

function readPath(row: Row, path: string): any {
  return path.split('.').reduce<any>((acc, k) => (acc == null ? acc : acc[k]), row)
}

/** Tokens de topo de um select PostgREST: `id, conversations!inner(account_id)`. */
function parseSelect(spec: string): string[] {
  const tokens: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of spec) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      tokens.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) tokens.push(buf.trim())
  return tokens
}

function makeChain(table: string) {
  const filters: Filter[] = []
  let selectSpec = '*'

  function rows(): Row[] {
    let out = (db[table] ?? []).map((r) => ({ ...r }))

    // Embed to-one + inner join: linha sem par é eliminada, como no PostgREST.
    if (selectSpec.includes('conversations!inner')) {
      out = out.flatMap((m) => {
        const conv = db.conversations.find((c) => c.id === m.conversation_id)
        return conv ? [{ ...m, conversations: { account_id: conv.account_id } }] : []
      })
    }

    for (const f of filters) {
      out = out.filter((r) => {
        const v = readPath(r, f.col)
        return f.op === 'eq' ? v === f.val : (f.val as any[]).includes(v)
      })
    }

    // Projeção: devolver coluna não pedida deixaria passar código que lê
    // um campo que o PostgREST real não teria devolvido.
    if (selectSpec === '*') return out
    const tokens = parseSelect(selectSpec)
    return out.map((r) => {
      const projected: Row = {}
      for (const t of tokens) {
        const key = t.includes('(') ? t.slice(0, t.indexOf('(')).split('!')[0] : t
        if (key in r) projected[key] = r[key]
      }
      return projected
    })
  }

  const chain: any = {
    select(spec: string) {
      selectSpec = spec
      return chain
    },
    eq(col: string, val: any) {
      filters.push({ col, op: 'eq', val })
      return chain
    },
    in(col: string, val: any[]) {
      filters.push({ col, op: 'in', val })
      return chain
    },
    maybeSingle() {
      const err = injectedError[table]
      if (err) return Promise.resolve({ data: null, error: err })
      const r = rows()
      if (r.length > 1) {
        // PGRST116 — o que o PostgREST real devolve para maybeSingle com N>1.
        return Promise.resolve({
          data: null,
          error: { message: 'JSON object requested, multiple rows returned', code: 'PGRST116' },
        })
      }
      return Promise.resolve({ data: r[0] ?? null, error: null })
    },
    then(resolve: (v: any) => any, reject?: (e: any) => any) {
      const err = injectedError[table]
      const result = err ? { data: null, error: err } : { data: rows(), error: null }
      return Promise.resolve(result).then(resolve, reject)
    },
  }
  return chain
}

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({ from: (t: string) => makeChain(t) }),
}))

import { resolveMessageByExternalId } from './resolve-by-external-id'

// ---------------------------------------------------------------
// Cenário base — duas contas, duas conexões
// ---------------------------------------------------------------

const ACC_A = 'acc-a'
const ACC_B = 'acc-b'
const CONN_A = 'conn-a'
const CONN_B = 'conn-b'

beforeEach(() => {
  for (const k of Object.keys(db)) db[k] = []
  for (const k of Object.keys(injectedError)) injectedError[k] = null

  db.whatsapp_config = [
    { id: CONN_A, account_id: ACC_A },
    { id: CONN_B, account_id: ACC_B },
  ]
  db.conversations = [
    { id: 'conv-a', account_id: ACC_A },
    { id: 'conv-b', account_id: ACC_B },
  ]
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// ---------------------------------------------------------------
// Caminho de identidade registrada — EIS-001 §4.1
// ---------------------------------------------------------------

describe('resolveMessageByExternalId — identidade registrada', () => {
  it('resolve por identidade única', async () => {
    db.message_external_ids = [
      { message_id: 'msg-1', connection_ref: CONN_A, kind: 'wamid', value: 'X' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBe('msg-1')
  })

  it('restringe por kind quando informado', async () => {
    db.message_external_ids = [
      { message_id: 'msg-1', connection_ref: CONN_A, kind: 'wamid', value: 'X' },
      { message_id: 'msg-2', connection_ref: CONN_A, kind: 'provider_message_id', value: 'X' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X', 'wamid')).resolves.toBe('msg-1')
    await expect(
      resolveMessageByExternalId(CONN_A, 'X', 'provider_message_id'),
    ).resolves.toBe('msg-2')
  })

  // B3 — o caso que o baseline tratava como erro de maybeSingle.
  it('resolve quando várias identidades apontam para a MESMA mensagem', async () => {
    db.message_external_ids = [
      { message_id: 'msg-1', connection_ref: CONN_A, kind: 'wamid', value: 'X' },
      { message_id: 'msg-1', connection_ref: CONN_A, kind: 'provider_message_id', value: 'X' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBe('msg-1')
  })

  // B3 — nunca escolher pela ordem devolvida pelo banco.
  it('NÃO resolve quando identidades apontam para mensagens diferentes', async () => {
    db.message_external_ids = [
      { message_id: 'msg-1', connection_ref: CONN_A, kind: 'wamid', value: 'X' },
      { message_id: 'msg-2', connection_ref: CONN_A, kind: 'provider_message_id', value: 'X' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBeNull()
  })

  it('não resolve ambiguidade em ordem alguma — resultado independe da ordem das linhas', async () => {
    const rows = [
      { message_id: 'msg-1', connection_ref: CONN_A, kind: 'wamid', value: 'X' },
      { message_id: 'msg-2', connection_ref: CONN_A, kind: 'provider_message_id', value: 'X' },
    ]
    db.message_external_ids = rows
    const forward = await resolveMessageByExternalId(CONN_A, 'X')
    db.message_external_ids = [...rows].reverse()
    const reverse = await resolveMessageByExternalId(CONN_A, 'X')
    expect(forward).toBeNull()
    expect(reverse).toBeNull()
    expect(forward).toBe(reverse)
  })

  it('ambiguidade não é descartada em silêncio — produz registro observável', async () => {
    db.message_external_ids = [
      { message_id: 'msg-1', connection_ref: CONN_A, kind: 'wamid', value: 'X' },
      { message_id: 'msg-2', connection_ref: CONN_A, kind: 'provider_message_id', value: 'X' },
    ]
    await resolveMessageByExternalId(CONN_A, 'X')
    expect(console.warn).toHaveBeenCalled()
  })

  // EIS-001 §8, critério 14 — precedência verificada, não presumida.
  it('identidade registrada tem precedência sobre o fallback', async () => {
    db.message_external_ids = [
      { message_id: 'msg-registered', connection_ref: CONN_A, kind: 'wamid', value: 'X' },
    ]
    db.messages = [
      { id: 'msg-legacy', conversation_id: 'conv-a', message_id: 'X', sender_type: 'agent' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBe('msg-registered')
  })

  it('falha de consulta não é tratada como ausência: não cai para o fallback', async () => {
    injectedError.message_external_ids = { message: 'connection reset' }
    db.messages = [
      { id: 'msg-legacy', conversation_id: 'conv-a', message_id: 'X', sender_type: 'agent' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBeNull()
  })
})

// ---------------------------------------------------------------
// Fallback histórico — EIS-001 §4.3 + errata
// ---------------------------------------------------------------

describe('resolveMessageByExternalId — fallback histórico', () => {
  it('resolve mensagem de saída anterior a E2.0', async () => {
    db.messages = [
      { id: 'msg-legacy', conversation_id: 'conv-a', message_id: 'X', sender_type: 'agent' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBe('msg-legacy')
  })

  it('não resolve mensagem de entrada pelo fallback', async () => {
    db.messages = [
      { id: 'msg-inbound', conversation_id: 'conv-a', message_id: 'X', sender_type: 'customer' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBeNull()
  })

  it('resolve mensagem de saída enviada por automação (sender_type bot) — Gate 2', async () => {
    db.messages = [
      { id: 'msg-bot', conversation_id: 'conv-a', message_id: 'X', sender_type: 'bot' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBe('msg-bot')
  })

  it('NÃO resolve quando o valor corresponde a duas mensagens da mesma conta', async () => {
    db.messages = [
      { id: 'msg-1', conversation_id: 'conv-a', message_id: 'X', sender_type: 'agent' },
      { id: 'msg-2', conversation_id: 'conv-a', message_id: 'X', sender_type: 'agent' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'X')).resolves.toBeNull()
  })

  it('connectionRef desconhecido não resolve', async () => {
    db.messages = [
      { id: 'msg-legacy', conversation_id: 'conv-a', message_id: 'X', sender_type: 'agent' },
    ]
    await expect(resolveMessageByExternalId('conn-inexistente', 'X')).resolves.toBeNull()
  })
})

// ---------------------------------------------------------------
// B5 / T-6 — isolamento entre contas e conexões
// ---------------------------------------------------------------

describe('resolveMessageByExternalId — isolamento', () => {
  // EIS-001 §8, critério 15.
  it('duas contas portando o mesmo messages.message_id não se cruzam', async () => {
    db.messages = [
      { id: 'msg-a', conversation_id: 'conv-a', message_id: 'SHARED', sender_type: 'agent' },
      { id: 'msg-b', conversation_id: 'conv-b', message_id: 'SHARED', sender_type: 'agent' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'SHARED')).resolves.toBe('msg-a')
    await expect(resolveMessageByExternalId(CONN_B, 'SHARED')).resolves.toBe('msg-b')
  })

  it('valor da conta B não é alcançável a partir da conexão A', async () => {
    db.messages = [
      { id: 'msg-b', conversation_id: 'conv-b', message_id: 'ONLY-B', sender_type: 'agent' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'ONLY-B')).resolves.toBeNull()
    await expect(resolveMessageByExternalId(CONN_B, 'ONLY-B')).resolves.toBe('msg-b')
  })

  it('identidade registrada de outra conexão não é alcançável', async () => {
    db.message_external_ids = [
      { message_id: 'msg-b', connection_ref: CONN_B, kind: 'wamid', value: 'SHARED' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'SHARED')).resolves.toBeNull()
    await expect(resolveMessageByExternalId(CONN_B, 'SHARED')).resolves.toBe('msg-b')
  })

  it('a mesma identidade em duas conexões resolve para a mensagem da sua própria conexão', async () => {
    db.message_external_ids = [
      { message_id: 'msg-a', connection_ref: CONN_A, kind: 'wamid', value: 'SHARED' },
      { message_id: 'msg-b', connection_ref: CONN_B, kind: 'wamid', value: 'SHARED' },
    ]
    await expect(resolveMessageByExternalId(CONN_A, 'SHARED')).resolves.toBe('msg-a')
    await expect(resolveMessageByExternalId(CONN_B, 'SHARED')).resolves.toBe('msg-b')
  })
})
