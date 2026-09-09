import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// F-DB-04 — defense-in-depth hardening, not a fix for a live bypass.
//
// flow_runs and automation_logs each carry only a SELECT policy for
// `authenticated` (038_platform_read_context.sql) — no INSERT/UPDATE/
// DELETE policy exists for either table (F-DB-03, CLOSED —
// INTENTIONAL: every real write is service-role). RLS already
// default-denies DML for `authenticated` today. What 079 removes is
// the table-wide INSERT/UPDATE/DELETE privilege `authenticated` still
// holds from the Supabase project bootstrap (`GRANT ALL ON ALL TABLES
// IN SCHEMA public TO authenticated`) — the same latent gap 074/078
// closed for profiles/accounts: without the REVOKE, a future
// permissive policy on either table would become fully writable the
// moment it landed, no additional grant required.
//
// "ANTES" reproduces the pre-079 privilege state and confirms
// `authenticated` DOES hold the table-wide DML grant (RLS blocks it
// via row policy, not privilege — proving the two layers are
// independent). "DEPOIS" applies 079 and proves: SELECT keeps
// working for account members, INSERT/UPDATE/DELETE are rejected by
// privilege (not just by RLS), and the service-role-equivalent write
// path is untouched.

let db: PGlite

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
  name TEXT NOT NULL DEFAULT 'x'
);

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum
);

-- Forma real de flow_runs relevante ao gate (010/017 — colunas de
-- estado do runner + account_id de tenant scoping).
CREATE TABLE flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active'
);

-- Forma real de automation_logs (006/017).
CREATE TABLE automation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL DEFAULT 'test',
  status TEXT NOT NULL DEFAULT 'success'
);

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
  );
$$;

-- Stub — platform-operator read access (038) is out of scope for
-- F-DB-04; always FALSE so the SELECT policy's OR degrades cleanly to
-- is_account_member() for this gate.
CREATE OR REPLACE FUNCTION can_access_account(target_account_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT FALSE; $$;

ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_logs ENABLE ROW LEVEL SECURITY;

-- Policy REAL vigente hoje (038_platform_read_context.sql:113-126) —
-- SELECT apenas, nenhuma policy de INSERT/UPDATE/DELETE para
-- authenticated em nenhuma das duas tabelas.
CREATE POLICY flow_runs_select ON flow_runs FOR SELECT
  USING (is_account_member(account_id) OR can_access_account(account_id));
CREATE POLICY automation_logs_select ON automation_logs FOR SELECT
  USING (is_account_member(account_id) OR can_access_account(account_id));

-- Espelha o grant padrão de projeto Supabase (privilégios de tabela
-- amplos; RLS é a camada de enforcement pretendida) — sem isto o
-- teste "ANTES" não reproduziria fielmente o estado real pré-079.
GRANT SELECT, INSERT, UPDATE, DELETE ON flow_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_logs TO authenticated;
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

async function asUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await run(`SET ROLE authenticated`)
  await run(`SELECT set_config('app.current_user', $1, false)`, [userId ?? ''])
  try {
    return await fn()
  } finally {
    await run(`SELECT set_config('app.current_user', NULL, false)`)
    await run(`RESET ROLE`)
  }
}

const U = {
  member: '50000000-0000-0000-0000-000000000001',
  outsider: '50000000-0000-0000-0000-000000000002',
}
const ACC = {
  main: '60000000-0000-0000-0000-000000000001',
  other: '60000000-0000-0000-0000-000000000002',
}

async function seed() {
  await run(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [U.member, U.outsider])
  await run(`INSERT INTO accounts (id, name) VALUES ($1, 'main-co'), ($2, 'other-co')`, [ACC.main, ACC.other])
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1, $2, 'admin'), ($3, $4, 'admin')`,
    [U.member, ACC.main, U.outsider, ACC.other],
  )
  await run(`INSERT INTO flow_runs (id, account_id, user_id, status) VALUES (gen_random_uuid(), $1, $2, 'active')`, [
    ACC.main,
    U.member,
  ])
  await run(
    `INSERT INTO automation_logs (id, account_id, user_id, trigger_event, status) VALUES (gen_random_uuid(), $1, $2, 'seed', 'success')`,
    [ACC.main, U.member],
  )
}

describe('ANTES da 079 — authenticated detém o GRANT de tabela amplo (bootstrap)', () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(FOUNDATION)
    await seed()
  })

  it('authenticated CONSEGUE INSERT em flow_runs/automation_logs por privilégio de tabela, apesar de não haver policy de INSERT', async () => {
    // RLS bloqueia por policy (nenhuma policy de INSERT existe → WITH
    // CHECK implícito é FALSE) seria o esperado, MAS o teste aqui
    // prova a camada de PRIVILÉGIO isoladamente: com RLS satisfeita
    // trivialmente (nenhuma policy = WITH CHECK sempre falha para
    // INSERT sob RLS), o ponto é que o GRANT de tabela em si permite a
    // tentativa passar a fase de checagem de privilégio. Provamos isso
    // desligando RLS para isolar a camada de privilégio, replicando o
    // raciocínio do 074 (linha 46-64: privilégio de coluna é aditivo
    // sobre o de tabela, nunca subtrativo).
    await run(`ALTER TABLE flow_runs DISABLE ROW LEVEL SECURITY`)
    await asUser(U.member, () =>
      run(`INSERT INTO flow_runs (id, account_id, user_id, status) VALUES (gen_random_uuid(), $1, $2, 'active')`, [
        ACC.main,
        U.member,
      ]),
    )
    await run(`ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY`)
  })

  it('authenticated é bloqueado por RLS (não por privilégio) com RLS ativa — nenhuma policy de INSERT existe', async () => {
    await expect(
      asUser(U.member, () =>
        run(`INSERT INTO flow_runs (id, account_id, user_id, status) VALUES (gen_random_uuid(), $1, $2, 'active')`, [
          ACC.main,
          U.member,
        ]),
      ),
    ).rejects.toThrow(/new row violates row-level security policy/)
  })
})

describe('DEPOIS da 079', () => {
  beforeAll(async () => {
    // Banco novo e limpo — a 079 é aplicada sobre o schema real,
    // exatamente como roda em produção sobre flow_runs/automation_logs
    // já existentes.
    db = new PGlite()
    await db.exec(FOUNDATION)
    await seed()
    await db.exec(loadMigration('079_flow_runs_automation_logs_dml_hardening.sql'))
  })

  it('PERMITE: authenticated continua com SELECT em flow_runs/automation_logs da própria conta', async () => {
    const runs = await asUser(U.member, () => run(`SELECT id FROM flow_runs WHERE account_id = $1`, [ACC.main]))
    expect(runs).toHaveLength(1)

    const logs = await asUser(U.member, () => run(`SELECT id FROM automation_logs WHERE account_id = $1`, [ACC.main]))
    expect(logs).toHaveLength(1)
  })

  it('BLOQUEIA (por privilégio, não só por RLS): authenticated não consegue INSERT em flow_runs', async () => {
    await expect(
      asUser(U.member, () =>
        run(`INSERT INTO flow_runs (id, account_id, user_id, status) VALUES (gen_random_uuid(), $1, $2, 'active')`, [
          ACC.main,
          U.member,
        ]),
      ),
    ).rejects.toThrow(/permission denied for table flow_runs/)
  })

  it('BLOQUEIA: authenticated não consegue UPDATE em flow_runs', async () => {
    const [row] = await run<{ id: string }>(`SELECT id FROM flow_runs WHERE account_id = $1`, [ACC.main])
    await expect(
      asUser(U.member, () => run(`UPDATE flow_runs SET status = 'completed' WHERE id = $1`, [row.id])),
    ).rejects.toThrow(/permission denied for table flow_runs/)
  })

  it('BLOQUEIA: authenticated não consegue DELETE em flow_runs', async () => {
    const [row] = await run<{ id: string }>(`SELECT id FROM flow_runs WHERE account_id = $1`, [ACC.main])
    await expect(
      asUser(U.member, () => run(`DELETE FROM flow_runs WHERE id = $1`, [row.id])),
    ).rejects.toThrow(/permission denied for table flow_runs/)
  })

  it('BLOQUEIA: authenticated não consegue INSERT/UPDATE/DELETE em automation_logs', async () => {
    await expect(
      asUser(U.member, () =>
        run(
          `INSERT INTO automation_logs (id, account_id, user_id, trigger_event, status) VALUES (gen_random_uuid(), $1, $2, 'x', 'success')`,
          [ACC.main, U.member],
        ),
      ),
    ).rejects.toThrow(/permission denied for table automation_logs/)

    const [row] = await run<{ id: string }>(`SELECT id FROM automation_logs WHERE account_id = $1`, [ACC.main])
    await expect(
      asUser(U.member, () => run(`UPDATE automation_logs SET status = 'failed' WHERE id = $1`, [row.id])),
    ).rejects.toThrow(/permission denied for table automation_logs/)
    await expect(
      asUser(U.member, () => run(`DELETE FROM automation_logs WHERE id = $1`, [row.id])),
    ).rejects.toThrow(/permission denied for table automation_logs/)
  })

  it('NÃO vaza: authenticated de outra conta não vê os flow_runs/automation_logs de main-co (tenant isolation intacta)', async () => {
    const runs = await asUser(U.outsider, () => run(`SELECT id FROM flow_runs WHERE account_id = $1`, [ACC.main]))
    expect(runs).toHaveLength(0)
  })

  it('caminho privilegiado: sessão sem SET ROLE (equivalente a service_role/postgres) continua escrevendo normalmente', async () => {
    // Sem asUser() — roda como o role de conexão do teste (dono das
    // tabelas), o equivalente a service_role/postgres. Confirma que o
    // REVOKE (079) atinge só o grantee `authenticated` — exatamente
    // como supabaseAdmin() (service-role) segue escrevendo em
    // src/lib/flows/engine.ts e src/lib/automations/engine.ts.
    const [row] = await run<{ id: string }>(`SELECT id FROM flow_runs WHERE account_id = $1`, [ACC.main])
    await run(`UPDATE flow_runs SET status = 'completed' WHERE id = $1`, [row.id])
    const after = await run<{ status: string }>(`SELECT status FROM flow_runs WHERE id = $1`, [row.id])
    expect(after).toEqual([{ status: 'completed' }])

    await run(
      `INSERT INTO automation_logs (id, account_id, user_id, trigger_event, status) VALUES (gen_random_uuid(), $1, $2, 'engine', 'success')`,
      [ACC.main, U.member],
    )
    const logs = await run<{ id: string }>(`SELECT id FROM automation_logs WHERE account_id = $1`, [ACC.main])
    expect(logs.length).toBeGreaterThan(1)
  })
})
