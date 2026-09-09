import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// F-DB-01 (E2E validation) — same bug class as 074, one table over.
//
// Proves, against real Postgres (PGlite), that migration 078 (loaded
// verbatim) closes the analogous bypass in accounts_update
// (017_account_sharing.sql:643-645): USING/WITH CHECK only verify
// is_account_member(id, 'admin') — the row belongs to an account the
// caller administers — but never restrict which columns can change.
// Any admin (not just the owner) can PATCH accounts.owner_user_id
// directly, bypassing transfer_account_ownership() (018) and its
// invariant that accounts.owner_user_id and profiles.account_role
// stay in sync.
//
// "ANTES" reproduces the exploit against the pre-078 schema and
// confirms it works. "DEPOIS" applies 078 and proves the same UPDATE
// fails by column privilege, while every legitimate direct-write path
// (name/legal_name/commercial_phone/commercial_email/cnpj/
// default_currency — the columns real call sites actually write) and
// the privileged transfer_account_ownership() RPC still work.

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

-- Forma real de accounts (colunas relevantes ao gate; 001/017/021/041/053).
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'x',
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  cnpj TEXT NULL,
  legal_name TEXT NULL,
  commercial_phone TEXT NULL,
  commercial_email TEXT NULL,
  default_currency TEXT NOT NULL DEFAULT 'BRL'
);

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum
);

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

-- Policy REAL vigente hoje (017_account_sharing.sql:641-645) — a
-- versão pré-078, exatamente como está em produção sem a correção.
DROP POLICY IF EXISTS accounts_select ON accounts;
DROP POLICY IF EXISTS accounts_update ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (is_account_member(id));
CREATE POLICY accounts_update ON accounts FOR UPDATE
  USING (is_account_member(id, 'admin'))
  WITH CHECK (is_account_member(id, 'admin'));

-- Espelha o grant padrão de projeto Supabase (privilégios de tabela
-- amplos; RLS é a camada de enforcement pretendida) — sem isto o
-- teste "ANTES" não reproduziria fielmente por que o PATCH funcionava
-- em produção.
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO authenticated;

-- Stub fiel de transfer_account_ownership (018) — só o suficiente
-- para provar que o caminho privilegiado continua funcionando após a
-- 078.
CREATE OR REPLACE FUNCTION transfer_account_ownership(p_new_owner_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
    FROM profiles WHERE user_id = auth.uid();
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_target_account_id FROM profiles WHERE user_id = p_new_owner_user_id;
  IF v_target_account_id IS DISTINCT FROM v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  UPDATE profiles SET account_role = 'admin' WHERE user_id = auth.uid();
  UPDATE profiles SET account_role = 'owner' WHERE user_id = p_new_owner_user_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id WHERE id = v_caller_account_id;
END; $$;
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
  admin: '30000000-0000-0000-0000-000000000001',
  owner: '30000000-0000-0000-0000-000000000002',
}
const ACC = {
  main: '40000000-0000-0000-0000-000000000001',
}

async function seed() {
  await run(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [U.admin, U.owner])
  await run(`INSERT INTO accounts (id, name, owner_user_id) VALUES ($1, 'clinic-co', $2)`, [ACC.main, U.owner])
  await run(
    `INSERT INTO profiles (user_id, full_name, email, account_id, account_role) VALUES
       ($1, 'Admin', 'admin@example.com', $2, 'admin'),
       ($3, 'Owner', 'owner@example.com', $4, 'owner')`,
    [U.admin, ACC.main, U.owner, ACC.main],
  )
}

describe('ANTES da 078 — prova de que o ataque (F-DB-01) funcionava', () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(FOUNDATION)
    await seed()
  })

  it('admin (não-owner) autopromove-se a owner via PATCH direto em accounts.owner_user_id', async () => {
    await asUser(U.admin, async () => {
      await run(`UPDATE accounts SET owner_user_id = $1 WHERE id = $2`, [U.admin, ACC.main])
    })
    const row = await run<{ owner_user_id: string }>(`SELECT owner_user_id FROM accounts WHERE id = $1`, [
      ACC.main,
    ])
    expect(row).toEqual([{ owner_user_id: U.admin }])
    // Nota do exploit: profiles.account_role do admin nunca virou
    // 'owner' — accounts.owner_user_id e profiles.account_role
    // ficam dessincronizados, exatamente o estado inconsistente que
    // transfer_account_ownership() existe para nunca deixar acontecer.
  })
})

describe('DEPOIS da 078', () => {
  beforeAll(async () => {
    // Banco novo e limpo — a 078 é aplicada sobre o schema real,
    // exatamente como roda em produção sobre accounts já existente.
    db = new PGlite()
    await db.exec(FOUNDATION)
    await seed()
    await db.exec(loadMigration('078_accounts_owner_escalation_fix.sql'))
  })

  it('BLOQUEIA: admin não consegue alterar owner_user_id da própria conta', async () => {
    await expect(
      asUser(U.admin, () => run(`UPDATE accounts SET owner_user_id = $1 WHERE id = $2`, [U.admin, ACC.main])),
    ).rejects.toThrow(/permission denied for table accounts/)

    const row = await run<{ owner_user_id: string }>(`SELECT owner_user_id FROM accounts WHERE id = $1`, [
      ACC.main,
    ])
    expect(row).toEqual([{ owner_user_id: U.owner }]) // inalterado
  })

  it('BLOQUEIA: statement misto (name + owner_user_id) falha por inteiro — nada é aplicado', async () => {
    await expect(
      asUser(U.admin, () =>
        run(`UPDATE accounts SET name = 'Renamed', owner_user_id = $1 WHERE id = $2`, [U.admin, ACC.main]),
      ),
    ).rejects.toThrow(/permission denied for table accounts/)

    const row = await run<{ name: string }>(`SELECT name FROM accounts WHERE id = $1`, [ACC.main])
    expect(row).toEqual([{ name: 'clinic-co' }]) // nem name mudou — statement inteiro rejeitado
  })

  it('BLOQUEIA: authenticated não consegue INSERT em accounts', async () => {
    await expect(
      asUser(U.admin, () => run(`INSERT INTO accounts (id, name) VALUES (gen_random_uuid(), 'ghost-co')`)),
    ).rejects.toThrow(/permission denied for table accounts/)
  })

  it.each(['name', 'legal_name', 'commercial_phone', 'commercial_email', 'cnpj', 'default_currency'])(
    'PERMITE: admin continua editando %s (colunas reais escritas por src/app/api/account/route.ts e deals-settings.tsx)',
    async (column) => {
      const value = column === 'default_currency' ? 'USD' : 'new-value'
      await asUser(U.admin, () => run(`UPDATE accounts SET ${column} = $1 WHERE id = $2`, [value, ACC.main]))
      const row = await run<Record<string, string>>(`SELECT ${column} FROM accounts WHERE id = $1`, [ACC.main])
      expect(row[0][column]).toBe(value)
    },
  )

  it('caminho privilegiado: transfer_account_ownership (SECURITY DEFINER, 018) continua funcionando', async () => {
    await asUser(U.owner, () => run(`SELECT transfer_account_ownership($1)`, [U.admin]))

    const account = await run<{ owner_user_id: string }>(`SELECT owner_user_id FROM accounts WHERE id = $1`, [
      ACC.main,
    ])
    expect(account).toEqual([{ owner_user_id: U.admin }])

    const roles = await run<{ user_id: string; account_role: string }>(
      `SELECT user_id, account_role FROM profiles WHERE account_id = $1 ORDER BY user_id`,
      [ACC.main],
    )
    expect(roles).toEqual([
      { user_id: U.admin, account_role: 'owner' },
      { user_id: U.owner, account_role: 'admin' },
    ])
  })

  it('caminho privilegiado: sessão sem SET ROLE (equivalente a service_role/postgres) grava owner_user_id diretamente', async () => {
    // Sem asUser() — roda como o role de conexão do teste (dono das
    // tabelas/funções), o equivalente a service_role/postgres.
    // Confirma que o REVOKE (078) atinge só o grantee `authenticated`.
    await run(`UPDATE accounts SET owner_user_id = $1 WHERE id = $2`, [U.owner, ACC.main])
    const row = await run<{ owner_user_id: string }>(`SELECT owner_user_id FROM accounts WHERE id = $1`, [
      ACC.main,
    ])
    expect(row).toEqual([{ owner_user_id: U.owner }])
  })
})
