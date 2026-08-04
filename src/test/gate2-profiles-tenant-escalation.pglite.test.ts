import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Gate 2 — Segurança (S1): auto-escalada de tenant via profiles.
//
// Prova, contra Postgres real (PGlite), que a migration 074 REAL
// (carregada verbatim) fecha o bypass encontrado por três auditorias
// independentes: profiles_update/profiles_insert (017:619-628) só
// verificam auth.uid() = user_id, nunca account_id/account_role — as
// mesmas duas colunas que is_account_member() (017:136-164) usa como
// fonte de verdade para TODA policy de isolamento multi-tenant.
//
// O bloco "ANTES" reproduz o PATCH exato descrito nas auditorias
// contra o schema pré-074 e confirma que ele funciona (self-promoção
// a owner de outra conta, com leitura subsequente de dados alheios).
// O bloco "DEPOIS" aplica a 074 real e prova que o mesmo UPDATE falha
// por privilégio de coluna, que os caminhos legítimos (self-update de
// nome/avatar, RPC SECURITY DEFINER) continuam funcionando, e que a
// cadeia completa do exploit permanece fechada.

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

-- Forma real de profiles (colunas relevantes ao gate; 001 + 017).
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar_url TEXT,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- is_account_member deve existir ANTES das policies que a referenciam
-- (mesma ordem de 017_account_sharing.sql: função na linha 136, uso em
-- profiles_select na linha 622).
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

-- Políticas REAIS vigentes hoje (017_account_sharing.sql:619-628) —
-- a versão pré-Gate-2, exatamente como está em produção sem a 074.
DROP POLICY IF EXISTS profiles_select ON profiles;
DROP POLICY IF EXISTS profiles_update ON profiles;
DROP POLICY IF EXISTS profiles_insert ON profiles;
CREATE POLICY profiles_select ON profiles FOR SELECT
  USING (auth.uid() = user_id OR is_account_member(account_id));
CREATE POLICY profiles_update ON profiles FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY profiles_insert ON profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Espelha o grant padrão de projeto Supabase (privilégios de tabela
-- amplos; RLS é a camada de enforcement pretendida) — sem isto o
-- teste "ANTES" não reproduziria fielmente por que o PATCH funcionava
-- em produção.
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles TO authenticated;

-- Uma tabela tenant real qualquer, dependente de is_account_member,
-- para provar a cadeia completa do exploit (não só a escrita em
-- profiles, mas o acesso subsequente a dados de outra conta).
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT 'x'
);
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY contacts_select ON contacts FOR SELECT USING (is_account_member(account_id));
GRANT SELECT ON contacts TO authenticated;

-- Stub fiel de set_member_role (018) — só o suficiente para provar
-- que o caminho privilegiado continua funcionando após a 074.
CREATE OR REPLACE FUNCTION set_member_role(p_user_id UUID, p_new_role account_role_enum)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT account_id, account_role INTO v_caller_account_id, v_caller_role
    FROM profiles WHERE user_id = auth.uid();
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'requires admin' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_target_account_id FROM profiles WHERE user_id = p_user_id;
  IF v_target_account_id IS DISTINCT FROM v_caller_account_id THEN
    RAISE EXCEPTION 'target not in caller account' USING ERRCODE = '42501';
  END IF;
  UPDATE profiles SET account_role = p_new_role WHERE user_id = p_user_id;
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
  attacker: '30000000-0000-0000-0000-000000000001',
  victimOwner: '30000000-0000-0000-0000-000000000002',
}
const ACC = {
  attacker: '40000000-0000-0000-0000-000000000001',
  victim: '40000000-0000-0000-0000-000000000002',
}

async function seed() {
  await run(`INSERT INTO accounts (id, name) VALUES ($1, 'attacker-co'), ($2, 'victim-clinic')`, [
    ACC.attacker,
    ACC.victim,
  ])
  await run(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [U.attacker, U.victimOwner])
  await run(
    `INSERT INTO profiles (user_id, full_name, email, account_id, account_role) VALUES
       ($1, 'Attacker', 'attacker@example.com', $2, 'agent'),
       ($3, 'Victim Owner', 'owner@example.com', $4, 'owner')`,
    [U.attacker, ACC.attacker, U.victimOwner, ACC.victim],
  )
  await run(`INSERT INTO contacts (account_id, full_name) VALUES ($1, 'Victim Patient')`, [ACC.victim])
}

describe('ANTES da 074 — prova de que o ataque (S1) funcionava', () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(FOUNDATION)
    await seed()
  })

  it('authenticated se autopromove a owner de outra conta via UPDATE na própria linha', async () => {
    await asUser(U.attacker, async () => {
      await run(`UPDATE profiles SET account_id = $1, account_role = 'owner' WHERE user_id = $2`, [
        ACC.victim,
        U.attacker,
      ])
    })
    const row = await run<{ account_id: string; account_role: string }>(
      `SELECT account_id, account_role FROM profiles WHERE user_id = $1`,
      [U.attacker],
    )
    expect(row).toEqual([{ account_id: ACC.victim, account_role: 'owner' }])
  })

  it('consequência: authenticated lê contatos da conta-vítima via is_account_member', async () => {
    const rows = await asUser(U.attacker, () =>
      run<{ full_name: string }>(`SELECT full_name FROM contacts WHERE account_id = $1`, [ACC.victim]),
    )
    expect(rows).toEqual([{ full_name: 'Victim Patient' }])
  })
})

describe('DEPOIS da 074', () => {
  beforeAll(async () => {
    // Banco novo e limpo — a 074 é aplicada sobre o schema real,
    // exatamente como roda em produção sobre profiles já existente.
    db = new PGlite()
    await db.exec(FOUNDATION)
    await seed()
    await db.exec(loadMigration('074_profiles_tenant_escalation_fix.sql'))
  })

  it('BLOQUEIA: authenticated não consegue alterar account_id da própria linha', async () => {
    await expect(
      asUser(U.attacker, () => run(`UPDATE profiles SET account_id = $1 WHERE user_id = $2`, [ACC.victim, U.attacker])),
    ).rejects.toThrow(/permission denied for table profiles/)

    const row = await run<{ account_id: string }>(`SELECT account_id FROM profiles WHERE user_id = $1`, [
      U.attacker,
    ])
    expect(row).toEqual([{ account_id: ACC.attacker }]) // inalterado
  })

  it('BLOQUEIA: authenticated não consegue alterar account_role da própria linha', async () => {
    await expect(
      asUser(U.attacker, () => run(`UPDATE profiles SET account_role = 'owner' WHERE user_id = $1`, [U.attacker])),
    ).rejects.toThrow(/permission denied for table profiles/)

    const row = await run<{ account_role: string }>(`SELECT account_role FROM profiles WHERE user_id = $1`, [
      U.attacker,
    ])
    expect(row).toEqual([{ account_role: 'agent' }]) // inalterado
  })

  it('BLOQUEIA: statement misto (full_name + account_id + account_role) falha por inteiro — nada é aplicado', async () => {
    await expect(
      asUser(U.attacker, () =>
        run(`UPDATE profiles SET full_name = 'Renamed', account_id = $1, account_role = 'owner' WHERE user_id = $2`, [
          ACC.victim,
          U.attacker,
        ]),
      ),
    ).rejects.toThrow(/permission denied for table profiles/)

    const row = await run<{ full_name: string }>(`SELECT full_name FROM profiles WHERE user_id = $1`, [U.attacker])
    expect(row).toEqual([{ full_name: 'Attacker' }]) // nem full_name mudou — statement inteiro rejeitado
  })

  it('BLOQUEIA: authenticated não consegue INSERT em profiles', async () => {
    const newUserId = '30000000-0000-0000-0000-000000000099'
    await run(`INSERT INTO auth.users (id) VALUES ($1)`, [newUserId])
    await expect(
      asUser(newUserId, () =>
        run(
          `INSERT INTO profiles (user_id, full_name, email, account_id, account_role) VALUES ($1, 'Ghost', 'ghost@example.com', $2, 'owner')`,
          [newUserId, ACC.victim],
        ),
      ),
    ).rejects.toThrow(/permission denied for table profiles/)
  })

  it('PERMITE: authenticated continua editando full_name (self-service)', async () => {
    await asUser(U.attacker, () => run(`UPDATE profiles SET full_name = 'New Name' WHERE user_id = $1`, [U.attacker]))
    const row = await run<{ full_name: string }>(`SELECT full_name FROM profiles WHERE user_id = $1`, [U.attacker])
    expect(row).toEqual([{ full_name: 'New Name' }])
  })

  it('PERMITE: authenticated continua editando avatar_url (self-service)', async () => {
    await asUser(U.attacker, () =>
      run(`UPDATE profiles SET avatar_url = 'https://example.com/a.png' WHERE user_id = $1`, [U.attacker]),
    )
    const row = await run<{ avatar_url: string }>(`SELECT avatar_url FROM profiles WHERE user_id = $1`, [
      U.attacker,
    ])
    expect(row).toEqual([{ avatar_url: 'https://example.com/a.png' }])
  })

  it('caminho privilegiado: set_member_role (SECURITY DEFINER, 018) promove um teammate dentro da própria conta', async () => {
    const teammate = '30000000-0000-0000-0000-000000000050'
    await run(`INSERT INTO auth.users (id) VALUES ($1)`, [teammate])
    await run(
      `INSERT INTO profiles (user_id, full_name, email, account_id, account_role) VALUES ($1, 'Teammate', 'mate@example.com', $2, 'agent')`,
      [teammate, ACC.victim],
    )

    // victimOwner (role='owner' na própria conta) promove o teammate a
    // admin — grava account_role via RPC SECURITY DEFINER, prova de
    // que o REVOKE de UPDATE/INSERT do grantee `authenticated` (074)
    // nunca é avaliado para este caminho (a função roda como owner da
    // função, não como o grantee que chamou SELECT set_member_role(...)).
    await asUser(U.victimOwner, () => run(`SELECT set_member_role($1, 'admin')`, [teammate]))

    const row = await run<{ account_role: string }>(`SELECT account_role FROM profiles WHERE user_id = $1`, [
      teammate,
    ])
    expect(row).toEqual([{ account_role: 'admin' }])
  })

  it('caminho privilegiado: sessão sem SET ROLE (equivalente a service_role/postgres) grava account_role diretamente', async () => {
    // Sem asUser() — roda como o role de conexão do teste (dono das
    // tabelas/funções), o equivalente a service_role/postgres.
    // Confirma que o REVOKE (074) atinge só o grantee `authenticated`.
    await run(`UPDATE profiles SET account_role = 'admin' WHERE user_id = $1`, [U.victimOwner])
    const row = await run<{ account_role: string }>(`SELECT account_role FROM profiles WHERE user_id = $1`, [
      U.victimOwner,
    ])
    expect(row).toEqual([{ account_role: 'admin' }])
  })

  it('cadeia fechada: authenticated NÃO lê mais contatos da conta-vítima (nunca virou membro dela)', async () => {
    const rows = await asUser(U.attacker, () =>
      run<{ full_name: string }>(`SELECT full_name FROM contacts WHERE account_id = $1`, [ACC.victim]),
    )
    expect(rows).toEqual([])
  })
})
