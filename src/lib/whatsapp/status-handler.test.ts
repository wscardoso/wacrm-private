/**
 * E2.1-RC1 — B1 (direção por sender_type) e B2 (concorrência no CAS).
 *
 * Verifica `ADR-MSG-STATUS-001` I1 (idempotência por resultado), I2
 * (compare-and-set), D6 (matriz), D8 (sinais) e o invariante D de
 * `ADR-MSG-001` (direção deriva de `sender_type`, nunca do status).
 *
 * A concorrência é exercida de duas formas, deliberadamente:
 *   - por gancho, para forçar uma perda de CAS específica (T-1..T-3);
 *   - por interleaving real de dois handlers sob `Promise.all` (T-5).
 * A segunda é a que prova B2; a primeira é a que localiza a falha.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalStatus, CanonicalStatusEvent } from '@/lib/message/status'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------
// Tabela `messages` em memória, com semântica de CAS
// ---------------------------------------------------------------

type Msg = { id: string; status: CanonicalStatus | null; sender_type: string }

let messages: Msg[] = []
let updateCalls = 0
let readCalls = 0
/** Dispara imediatamente antes de cada UPDATE — simula o escritor rival. */
let beforeUpdate: ((call: number) => void) | null = null
/** Força "zero linhas afetadas" sem alterar o estado: contenção perpétua. */
let starveCas = false
let injectedWriteError: { message: string } | null = null

type Filter = { col: string; op: 'eq' | 'is'; val: any }

function makeMessagesChain() {
  const filters: Filter[] = []
  let payload: Record<string, any> | null = null
  let projection = '*'

  const match = (m: Msg) =>
    filters.every((f) => (m as any)[f.col] === f.val)

  const project = (m: Msg) => {
    if (projection === '*') return { ...m }
    const out: Record<string, any> = {}
    for (const c of projection.split(',').map((s) => s.trim())) {
      if (c in m) out[c] = (m as any)[c]
    }
    return out
  }

  const chain: any = {
    select(spec: string) {
      projection = spec
      return chain
    },
    update(p: Record<string, any>) {
      payload = p
      return chain
    },
    eq(col: string, val: any) {
      filters.push({ col, op: 'eq', val })
      return chain
    },
    is(col: string, val: any) {
      filters.push({ col, op: 'is', val })
      return chain
    },
    maybeSingle() {
      readCalls++
      const hit = messages.filter(match)
      return Promise.resolve({ data: hit[0] ? project(hit[0]) : null, error: null })
    },
    then(resolve: (v: any) => any, reject?: (e: any) => any) {
      if (!payload) {
        return Promise.resolve({ data: messages.filter(match).map(project), error: null }).then(
          resolve,
          reject,
        )
      }
      updateCalls++
      beforeUpdate?.(updateCalls)
      if (injectedWriteError) {
        return Promise.resolve({ data: null, error: injectedWriteError }).then(resolve, reject)
      }
      const hit = starveCas ? [] : messages.filter(match)
      for (const m of hit) Object.assign(m, payload)
      return Promise.resolve({ data: hit.map(project), error: null }).then(resolve, reject)
    },
  }
  return chain
}

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => {
      if (t !== 'messages') throw new Error(`unexpected table: ${t}`)
      return makeMessagesChain()
    },
  }),
}))

// A resolução tem testes próprios; aqui ela é fronteira, não objeto.
const mockResolve = vi.fn<(ref: string, value: string, kind?: string) => Promise<string | null>>()
vi.mock('@/lib/message/resolve-by-external-id', () => ({
  resolveMessageByExternalId: (ref: string, value: string, kind?: string) =>
    mockResolve(ref, value, kind),
}))

import { handleCanonicalStatusEvent, MAX_CAS_ATTEMPTS } from './status-handler'

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const CONN = 'conn-a'

function ev(status: CanonicalStatus, externalId = 'X'): CanonicalStatusEvent {
  return { externalId, status, timestamp: '1700000000000' }
}

function seed(status: CanonicalStatus | null, sender_type = 'agent'): Msg {
  const m: Msg = { id: 'msg-1', status, sender_type }
  messages = [m]
  return m
}

beforeEach(() => {
  messages = []
  updateCalls = 0
  readCalls = 0
  beforeUpdate = null
  starveCas = false
  injectedWriteError = null
  mockResolve.mockReset()
  mockResolve.mockResolvedValue('msg-1')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// ---------------------------------------------------------------
// D8 — eventos que não transicionam
// ---------------------------------------------------------------

describe('sinais D8', () => {
  it('N3 — valor de status fora do conjunto canônico', async () => {
    seed('sent')
    const bogus = { externalId: 'X', status: 'delivered_to_device', timestamp: '1' } as any
    await expect(handleCanonicalStatusEvent(bogus, CONN)).resolves.toBe('N3')
    expect(updateCalls).toBe(0)
  })

  it('N1 — valor não correlaciona com mensagem alguma', async () => {
    mockResolve.mockResolvedValue(null)
    await expect(handleCanonicalStatusEvent(ev('delivered'), CONN)).resolves.toBe('N1')
    expect(updateCalls).toBe(0)
  })

  it('N1 — id resolvido não existe mais em messages', async () => {
    messages = []
    await expect(handleCanonicalStatusEvent(ev('delivered'), CONN)).resolves.toBe('N1')
  })

  it('N2 — evento posterior a estado terminal', async () => {
    seed('failed')
    await expect(handleCanonicalStatusEvent(ev('read'), CONN)).resolves.toBe('N2')
    expect(messages[0].status).toBe('failed')
    expect(updateCalls).toBe(0)
  })
})

// ---------------------------------------------------------------
// B1 — direção por sender_type (invariante D)
// ---------------------------------------------------------------

describe('B1 — proteção de mensagens de entrada', () => {
  // Teste obrigatório 1.
  it('evento de status sobre mensagem customer não altera o status', async () => {
    seed('received', 'customer')
    const result = await handleCanonicalStatusEvent(ev('read'), CONN)
    expect(result).toBe('N2')
    expect(messages[0].status).toBe('received')
    expect(updateCalls).toBe(0)
  })

  it('a proteção vem de sender_type, não do valor do status', async () => {
    // Mensagem de entrada gravada com status do eixo de progresso: a matriz
    // sozinha aceitaria a transição. O invariante D é quem a recusa.
    seed('sent', 'customer')
    const result = await handleCanonicalStatusEvent(ev('read'), CONN)
    expect(result).toBe('N2')
    expect(messages[0].status).toBe('sent')
    expect(updateCalls).toBe(0)
  })

  it('a recusa é observável — não é descarte em silêncio', async () => {
    seed('sent', 'customer')
    await handleCanonicalStatusEvent(ev('read'), CONN)
    expect(console.warn).toHaveBeenCalled()
  })

  it('mensagem de saída enviada por bot transiciona normalmente', async () => {
    seed('sent', 'bot')
    await expect(handleCanonicalStatusEvent(ev('delivered'), CONN)).resolves.toBe('applied')
    expect(messages[0].status).toBe('delivered')
  })
})

// ---------------------------------------------------------------
// D6 sem concorrência
// ---------------------------------------------------------------

describe('matriz D6 — sem concorrência', () => {
  it('aplica avanço no eixo de progresso', async () => {
    seed('sent')
    await expect(handleCanonicalStatusEvent(ev('read'), CONN)).resolves.toBe('applied')
    expect(messages[0].status).toBe('read')
    expect(updateCalls).toBe(1)
  })

  it('aplica o primeiro estado quando não há estado anterior', async () => {
    seed(null)
    await expect(handleCanonicalStatusEvent(ev('sent'), CONN)).resolves.toBe('applied')
    expect(messages[0].status).toBe('sent')
  })

  // T-4 — redundância sem concorrência: nenhuma tentativa de escrita.
  it('T-4 — evento redundante conclui noop na primeira avaliação', async () => {
    seed('delivered')
    await expect(handleCanonicalStatusEvent(ev('delivered'), CONN)).resolves.toBe('noop')
    expect(updateCalls).toBe(0)
    expect(readCalls).toBe(1)
  })

  it('regressão é noop silencioso', async () => {
    seed('read')
    await expect(handleCanonicalStatusEvent(ev('delivered'), CONN)).resolves.toBe('noop')
    expect(messages[0].status).toBe('read')
    expect(updateCalls).toBe(0)
  })
})

// ---------------------------------------------------------------
// B2 — perda de CAS, releitura e reavaliação
// ---------------------------------------------------------------

describe('B2 — reavaliação após CAS perdido', () => {
  // T-1 / teste obrigatório 3.
  it('T-1 — CAS perdido uma vez; estado corrente ainda admite o evento', async () => {
    const m = seed('pending')
    beforeUpdate = (call) => {
      // Rival grava `sending` depois da nossa leitura e antes do nosso CAS.
      if (call === 1) m.status = 'sending'
    }
    const result = await handleCanonicalStatusEvent(ev('delivered'), CONN)
    expect(result).toBe('applied')
    expect(messages[0].status).toBe('delivered')
    expect(updateCalls).toBe(2)
    expect(readCalls).toBe(2)
  })

  // T-2.
  it('T-2 — CAS perdido para estado superior: reavaliação conclui noop', async () => {
    const m = seed('sent')
    beforeUpdate = (call) => {
      if (call === 1) m.status = 'read'
    }
    const result = await handleCanonicalStatusEvent(ev('delivered'), CONN)
    expect(result).toBe('noop')
    expect(messages[0].status).toBe('read')
    // Uma única tentativa de escrita: a segunda avaliação não escreve.
    expect(updateCalls).toBe(1)
    expect(readCalls).toBe(2)
  })

  it('reavaliação respeita a matriz: rival grava failed, evento vira N2', async () => {
    const m = seed('sent')
    beforeUpdate = (call) => {
      if (call === 1) m.status = 'failed'
    }
    await expect(handleCanonicalStatusEvent(ev('delivered'), CONN)).resolves.toBe('N2')
    expect(messages[0].status).toBe('failed')
  })

  // T-3.
  it('T-3 — contenção perpétua termina no limite, com sinal e sem laço', async () => {
    seed('sent')
    starveCas = true
    const result = await handleCanonicalStatusEvent(ev('read'), CONN)
    expect(result).toBe('unapplied')
    expect(updateCalls).toBe(MAX_CAS_ATTEMPTS)
    expect(console.warn).toHaveBeenCalled()
    expect(messages[0].status).toBe('sent')
  })

  it('erro de escrita não é convertido em noop', async () => {
    seed('sent')
    injectedWriteError = { message: 'deadlock detected' }
    await expect(handleCanonicalStatusEvent(ev('read'), CONN)).resolves.toBe('unapplied')
    expect(console.warn).toHaveBeenCalled()
    expect(messages[0].status).toBe('sent')
  })
})

// ---------------------------------------------------------------
// T-5 / teste obrigatório 2 — concorrência real
// ---------------------------------------------------------------

describe('T-5 — dois eventos concorrentes sobre a mesma mensagem', () => {
  it('sent + delivered/read concorrentes termina em read, sem evento perdido', async () => {
    seed('sent')
    const [a, b] = await Promise.all([
      handleCanonicalStatusEvent(ev('delivered'), CONN),
      handleCanonicalStatusEvent(ev('read'), CONN),
    ])
    expect(messages[0].status).toBe('read')
    // Nenhum dos dois pode ter sido descartado sem conclusão.
    expect([a, b]).not.toContain('unapplied')
    // O evento de nível superior tem de ter sido aplicado.
    expect([a, b]).toContain('applied')
    expect(a === 'applied' || a === 'noop').toBe(true)
    expect(b === 'applied' || b === 'noop').toBe(true)
  })

  it('a ordem inversa produz o mesmo estado final — I1', async () => {
    seed('sent')
    const [a, b] = await Promise.all([
      handleCanonicalStatusEvent(ev('read'), CONN),
      handleCanonicalStatusEvent(ev('delivered'), CONN),
    ])
    expect(messages[0].status).toBe('read')
    expect([a, b]).not.toContain('unapplied')
    expect([a, b]).toContain('applied')
  })

  it('o resultado independe do escalonamento — read prevalece nas duas ordens', async () => {
    seed('sent')
    await Promise.all([
      handleCanonicalStatusEvent(ev('delivered'), CONN),
      handleCanonicalStatusEvent(ev('read'), CONN),
    ])
    const forward = messages[0].status

    seed('sent')
    await Promise.all([
      handleCanonicalStatusEvent(ev('read'), CONN),
      handleCanonicalStatusEvent(ev('delivered'), CONN),
    ])
    const reverse = messages[0].status

    expect(forward).toBe(reverse)
    expect(forward).toBe('read')
  })
})
