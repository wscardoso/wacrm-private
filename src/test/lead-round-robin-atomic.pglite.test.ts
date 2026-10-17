import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Feature A — round-robin de atribuição de leads: condição de corrida.
//
// Prova, contra Postgres real (PGlite), que a migration 081 REAL
// (carregada verbatim) substitui o read-then-upsert do engine por uma
// rotação atômica, e qualifica o que isso garante:
//
//   1. distribuição determinística entre os membros elegíveis
//      (profiles.account_role ∈ owner/admin/agent, ordem user_id ASC);
//   2. isolamento por conta (cursor é por account_id; contas não se
//      contaminam);
//   3. ausência de agentes elegíveis → NULL, sem criar/avançar cursor;
//   4. cursor obsoleto/cross-account → recomeça no primeiro membro;
//   5. a corrida: o padrão antigo (ler → calcular no app → upsert)
//      COLIDE sob interleaving, e a função NÃO colide;
//   6. privilégio: SECURITY DEFINER, service-role apenas.
//
// LIMITAÇÃO DECLARADA — PGlite é single-connection; não há paralelismo
// real de transações. Assim como em outbound-retry-ledger.pglite.test.ts,
// o caso concorrente é MODELADO por interleaving explícito das leituras
// e escritas. O que o teste estabelece é o CONTRATO SQL: a rotação lê e
// regrava o cursor DENTRO da função, sob SELECT ... FOR UPDATE, então
// nenhuma leitura obsoleta é possível (o lock serializa). A serialização
// real do lock é garantida pelo Postgres, não medida aqui.
//
// O schema de fundação replica a forma real exigida pela 081:
//   - accounts / profiles / account_role_enum (001 + 017)
//   - account_lead_routing com PK/FK/RLS/REVOKEs exatamente como a 080

let db: PGlite

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111'
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222'
const ACCOUNT_C = '33333333-3333-3333-3333-333333333333' // sem agente elegível

const A1 = '00000000-0000-0000-0000-0000000000a1' // owner
const A2 = '00000000-0000-0000-0000-0000000000a2' // agent
const A3 = '00000000-0000-0000-0000-0000000000a3' // admin
const A_VIEWER = '00000000-0000-0000-0000-0000000000a4' // viewer → inelegível
const A_LEGACY = '00000000-0000-0000-0000-0000000000a5' // account_role NULL

const B1 = '00000000-0000-0000-0000-0000000000b1'
const B2 = '00000000-0000-0000-0000-0000000000b2'
const C_VIEWER = '00000000-0000-0000-0000-0000000000c1'
const FOREIGN = '00000000-0000-0000-0000-0000000000ff' // user válido, sem membership

const FOUNDATION = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::UUID
$$;

CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum
);
CREATE INDEX idx_profiles_account_role ON profiles(account_id, account_role);

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
  )
$$;

-- account_lead_routing — forma EXATA da 080 (linhas 31-51).
CREATE TABLE account_lead_routing (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_assigned_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE account_lead_routing ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_lead_routing_select ON account_lead_routing
  FOR SELECT USING (is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON account_lead_routing FROM authenticated;
`

const SEED = `
INSERT INTO accounts (id, name) VALUES
  ('${ACCOUNT_A}', 'Tenant A'),
  ('${ACCOUNT_B}', 'Tenant B'),
  ('${ACCOUNT_C}', 'Tenant C');

INSERT INTO auth.users (id) VALUES
  ('${A1}'), ('${A2}'), ('${A3}'), ('${A_VIEWER}'), ('${A_LEGACY}'),
  ('${B1}'), ('${B2}'), ('${C_VIEWER}'), ('${FOREIGN}');

INSERT INTO profiles (user_id, account_id, account_role) VALUES
  ('${A1}', '${ACCOUNT_A}', 'owner'),
  ('${A2}', '${ACCOUNT_A}', 'agent'),
  ('${A3}', '${ACCOUNT_A}', 'admin'),
  ('${A_VIEWER}', '${ACCOUNT_A}', 'viewer'),   -- inelegível
  ('${A_LEGACY}', '${ACCOUNT_A}', NULL),       -- legado, inelegível
  ('${B1}', '${ACCOUNT_B}', 'owner'),
  ('${B2}', '${ACCOUNT_B}', 'agent'),
  ('${C_VIEWER}', '${ACCOUNT_C}', 'viewer');   -- conta sem elegível
`

function loadMigration(name: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const file = readdirSync(dir).find((f) => f.endsWith(name))
  if (!file) throw new Error(`migration not found: ${name}`)
  return readFileSync(join(dir, file), 'utf8')
}

async function run<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(text, params)
  return r.rows as T[]
}

/** Chama a função atômica sob teste. */
async function assignNext(accountId: string): Promise<string | null> {
  const rows = await run<{ agent: string | null }>(
    `SELECT public.assign_next_lead_agent($1::uuid) AS agent`,
    [accountId],
  )
  return rows[0].agent
}

/** Estado atual do cursor de uma conta. */
async function cursor(accountId: string): Promise<string | null> {
  const rows = await run<{ last_assigned_user_id: string | null }>(
    `SELECT last_assigned_user_id FROM account_lead_routing WHERE account_id = $1`,
    [accountId],
  )
  return rows[0]?.last_assigned_user_id ?? null
}

/** Membros elegíveis na ordem usada pela rotação. */
async function membersOf(accountId: string): Promise<string[]> {
  const rows = await run<{ user_id: string }>(
    `SELECT user_id FROM profiles
      WHERE account_id = $1 AND account_role IN ('owner', 'admin', 'agent')
      ORDER BY user_id ASC`,
    [accountId],
  )
  return rows.map((r) => r.user_id)
}

/**
 * Padrão ANTIGO do engine, reproduzido fielmente para o teste da corrida:
 * lê o cursor, calcula `(findIndex(last) + 1) % len` no app, e grava com
 * upsert — em duas idas separadas ao banco. É exatamente o que a 081
 * removeu do engine.ts.
 */
async function legacyNextAgent(accountId: string): Promise<string> {
  const members = await membersOf(accountId)
  const lastId = await cursor(accountId)
  const lastIdx = members.findIndex((m) => m === lastId)
  return members[(lastIdx + 1) % members.length]
}

async function legacyWriteCursor(accountId: string, agentId: string): Promise<void> {
  await run(
    `INSERT INTO account_lead_routing (account_id, last_assigned_user_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (account_id) DO UPDATE
       SET last_assigned_user_id = EXCLUDED.last_assigned_user_id,
           updated_at = EXCLUDED.updated_at`,
    [accountId, agentId],
  )
}

async function resetCursor(accountId: string, userId: string | null): Promise<void> {
  await run(
    `INSERT INTO account_lead_routing (account_id, last_assigned_user_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (account_id) DO UPDATE
       SET last_assigned_user_id = EXCLUDED.last_assigned_user_id,
           updated_at = NOW()`,
    [accountId, userId],
  )
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await db.exec(SEED)
  // A migration sob teste, verbatim.
  await db.exec(loadMigration('081_lead_round_robin_atomic.sql'))
})

describe('081_lead_round_robin_atomic — distribuição e cursor', () => {
  it('rotaciona deterministicamente entre os membros elegíveis (ordem user_id ASC)', async () => {
    await resetCursor(ACCOUNT_A, null)

    const got: (string | null)[] = []
    for (let i = 0; i < 7; i++) got.push(await assignNext(ACCOUNT_A))

    expect(got).toEqual([A1, A2, A3, A1, A2, A3, A1])
    // O cursor reflete a última atribuição.
    expect(await cursor(ACCOUNT_A)).toBe(A1)
  })

  it('ignora viewer e profile legado (account_role NULL) na elegibilidade', async () => {
    await resetCursor(ACCOUNT_A, null)
    const got = new Set<string | null>()
    for (let i = 0; i < 6; i++) got.add(await assignNext(ACCOUNT_A))

    expect(got).toEqual(new Set([A1, A2, A3]))
    expect(got.has(A_VIEWER)).toBe(false)
    expect(got.has(A_LEGACY)).toBe(false)
    // Regressão: o filtro não pode keyar a coluna legada `role`.
    const members = await membersOf(ACCOUNT_A)
    expect(members).toEqual([A1, A2, A3])
  })

  it('começa no primeiro membro quando ainda não há estado de cursor', async () => {
    await run(`DELETE FROM account_lead_routing WHERE account_id = $1`, [ACCOUNT_A])
    expect(await assignNext(ACCOUNT_A)).toBe(A1)
    expect(await cursor(ACCOUNT_A)).toBe(A1)
  })

  it('isola contas: o cursor de uma conta não é afetado pela outra', async () => {
    await resetCursor(ACCOUNT_A, null)
    await resetCursor(ACCOUNT_B, null)

    // Alterna A e B; cada conta mantém sua própria rotação.
    expect(await assignNext(ACCOUNT_A)).toBe(A1)
    expect(await assignNext(ACCOUNT_B)).toBe(B1)
    expect(await assignNext(ACCOUNT_A)).toBe(A2)
    expect(await assignNext(ACCOUNT_B)).toBe(B2)
    expect(await assignNext(ACCOUNT_A)).toBe(A3)
    expect(await assignNext(ACCOUNT_B)).toBe(B1)

    expect(await cursor(ACCOUNT_A)).toBe(A3)
    expect(await cursor(ACCOUNT_B)).toBe(B1)

    // Nenhum membro de A jamais é devolvido para B, e vice-versa.
    const aMembers = new Set(await membersOf(ACCOUNT_A))
    const bMembers = new Set(await membersOf(ACCOUNT_B))
    for (const m of aMembers) expect(bMembers.has(m)).toBe(false)
  })

  it('recomeça no primeiro membro quando o cursor aponta para fora do conjunto elegível', async () => {
    // Cursor cross-account: aponta para um membro de B estando em A.
    await resetCursor(ACCOUNT_A, B1)
    expect(await assignNext(ACCOUNT_A)).toBe(A1)
    expect(await cursor(ACCOUNT_A)).toBe(A1)
  })

  it('ausência de agente elegível → NULL e nenhum cursor criado/avançado', async () => {
    await run(`DELETE FROM account_lead_routing WHERE account_id = $1`, [ACCOUNT_C])

    expect(await assignNext(ACCOUNT_C)).toBeNull()

    const rows = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM account_lead_routing WHERE account_id = $1`,
      [ACCOUNT_C],
    )
    // A função NÃO cria linha de cursor quando não há elegível — não
    // "avança" um estado inexistente.
    expect(rows[0].c).toBe(0)
  })

  it('account_id NULL é defensivo → NULL, sem tocar em nada', async () => {
    const rows = await run<{ agent: string | null }>(
      `SELECT public.assign_next_lead_agent(NULL::uuid) AS agent`,
    )
    expect(rows[0].agent).toBeNull()
  })
})

describe('081_lead_round_robin_atomic — a corrida', () => {
  it('o padrão antigo (read-then-upsert) COLIDE: dois leads, um só agente', async () => {
    await resetCursor(ACCOUNT_A, A1)

    // Dois "clientes" concorrentes leem o MESMO cursor antes de qualquer
    // escrita — o interleaving que o padrão antigo não protegia.
    const read1 = await cursor(ACCOUNT_A)
    const read2 = await cursor(ACCOUNT_A)
    expect(read1).toBe(A1)
    expect(read2).toBe(A1)

    // Cada um calcula no app o próximo após a SUA leitura…
    expect(await legacyNextAgent(ACCOUNT_A)).toBe(A2)
    // (o segundo cliente calcula o mesmo, pois leu o mesmo valor)
    const members = await membersOf(ACCOUNT_A)
    const lastIdx = members.findIndex((m) => m === read2)
    expect(members[(lastIdx + 1) % members.length]).toBe(A2)

    // …e cada um grava. O segundo upsert só reescreve o valor do primeiro.
    await legacyWriteCursor(ACCOUNT_A, A2)
    await legacyWriteCursor(ACCOUNT_A, A2)

    // Resultado: o cursor avançou UMA posição para duas atribuições —
    // A3 nunca recebeu, A2 recebeu os dois leads.
    expect(await cursor(ACCOUNT_A)).toBe(A2)
  })

  it('a função atômica NÃO colide: duas atribuições consecutivas caem em agentes distintos', async () => {
    await resetCursor(ACCOUNT_A, A1)

    const first = await assignNext(ACCOUNT_A)
    const second = await assignNext(ACCOUNT_A)

    expect(first).toBe(A2)
    expect(second).toBe(A3)
    expect(first).not.toBe(second)
    // O cursor avançou DUAS posições (uma por atribuição).
    expect(await cursor(ACCOUNT_A)).toBe(A3)
  })

  it('a rotação roda sob lock de linha (SELECT ... FOR UPDATE no cursor)', async () => {
    // Regression lock estrutural: sem o FOR UPDATE, a leitura do cursor
    // poderia ser obsoleta e o interleaving acima voltaria a colidir.
    // A serialização real do lock é do Postgres; aqui garantimos que a
    // fonte da função sob teste contém o lock e a leitura/escrita única.
    const rows = await run<{ src: string }>(
      `SELECT pg_get_functiondef('public.assign_next_lead_agent(uuid)'::regprocedure) AS src`,
    )
    const src = rows[0].src
    expect(src).toMatch(/FOR UPDATE/)
    expect(src).toMatch(/INSERT INTO account_lead_routing/)
    expect(src).toMatch(/UPDATE account_lead_routing/)
    // A elegibilidade é decidida no SQL por `account_role` (enum escopado
    // pela conta), nunca pela coluna legada global `role`. O lock de
    // comportamento é o teste funcional acima (viewer e legado ficam de
    // fora); aqui travamos o predicado.
    expect(src).toMatch(/account_role IN \('owner', 'admin', 'agent'\)/)
    // Nenhum predicado sobre a coluna legada `role` (ex.: `p.role IN (...)`).
    expect(src).not.toMatch(/\bp\.role\b/)
  })

  it('uma sequência interleaved longa distribui de forma equitativa', async () => {
    await resetCursor(ACCOUNT_A, null)
    const results: (string | null)[] = []
    for (let i = 0; i < 9; i++) results.push(await assignNext(ACCOUNT_A))

    const counts = results.reduce<Record<string, number>>((acc, id) => {
      acc[id as string] = (acc[id as string] ?? 0) + 1
      return acc
    }, {})
    // 9 atribuições / 3 agentes = 3 cada, sem starvation.
    expect(counts).toEqual({ [A1]: 3, [A2]: 3, [A3]: 3 })
  })
})

describe('081_lead_round_robin_atomic — privilégio (service-role apenas)', () => {
  it('é SECURITY DEFINER e não é executável por anon/authenticated', async () => {
    const def = await run<{ prosecdef: boolean; src: string }>(
      `SELECT prosecdef, pg_get_functiondef('public.assign_next_lead_agent(uuid)'::regprocedure) AS src
         FROM pg_proc WHERE proname = 'assign_next_lead_agent'`,
    )
    expect(def).toHaveLength(1)
    expect(def[0].prosecdef).toBe(true)
    expect(def[0].src).toMatch(/SECURITY DEFINER/)
    expect(def[0].src).toMatch(/search_path TO '?public'?/)

    const priv = await run<{ svc: boolean; auth: boolean; anon: boolean }>(
      `SELECT
         has_function_privilege('service_role', 'public.assign_next_lead_agent(uuid)', 'EXECUTE') AS svc,
         has_function_privilege('authenticated', 'public.assign_next_lead_agent(uuid)', 'EXECUTE') AS auth,
         has_function_privilege('anon', 'public.assign_next_lead_agent(uuid)', 'EXECUTE') AS anon`,
    )
    expect(priv[0].svc).toBe(true)
    expect(priv[0].auth).toBe(false)
    expect(priv[0].anon).toBe(false)
  })

  it('authenticated não consegue executar a rotação', async () => {
    await run(`SET ROLE authenticated`)
    try {
      await expect(assignNext(ACCOUNT_A)).rejects.toThrow(/permission denied/i)
    } finally {
      await run(`RESET ROLE`)
    }
  })

  it('authenticated não tem DML direto em account_lead_routing (080)', async () => {
    const priv = await run<{ ins: boolean; upd: boolean; del: boolean }>(
      `SELECT
         has_table_privilege('authenticated', 'public.account_lead_routing', 'INSERT') AS ins,
         has_table_privilege('authenticated', 'public.account_lead_routing', 'UPDATE') AS upd,
         has_table_privilege('authenticated', 'public.account_lead_routing', 'DELETE') AS del`,
    )
    expect(priv[0]).toEqual({ ins: false, upd: false, del: false })
  })
})
