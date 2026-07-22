import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// E5a — Account Identity Data (docs/architecture/E5-workspace-commercial-identity.md).
// Real Postgres (PGlite) tests for migration 053: the three new nullable
// identity columns + their CHECK constraints, plus the member-side RLS
// path (`accounts_update = is_account_member(id,'admin')`, from 017)
// that /api/account PATCH relies on. Mirrors the fixture style of
// create-platform-workspace.pglite.test.ts (auth.uid() via session GUC,
// asUser helper, SET ROLE authenticated).
//
// This suite validates the AUTHORITATIVE layer per contract §5: "a
// validação vive em CHECK constraints na própria accounts... os dois
// escritores são fachadas de autorização distintas sobre as mesmas
// colunas com a mesma validação de banco — impossível divergirem."
// The route-level input validation in src/app/api/account/route.ts
// exists only to produce clean 400s before ever reaching these
// constraints; the constraints themselves are what this file proves.

let db: PGlite

const SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::UUID
$$;

CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');

-- accounts as of 017 (+ updated_at) — 041 and 053 (loaded below) add
-- cnpj and the three E5a columns respectively, exactly like production.
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum,
  UNIQUE(user_id)
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
          END >= CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

-- Table-level GRANTs — real Supabase projects grant broad table access
-- to \`authenticated\` by default (RLS is what actually narrows row
-- visibility/writability on top of this). PGlite starts every custom
-- role with none, so this fixture must set it up explicitly or every
-- query under SET ROLE authenticated fails with "permission denied"
-- before RLS is ever evaluated.
GRANT SELECT, UPDATE ON accounts TO authenticated;
GRANT SELECT ON profiles TO authenticated;

-- Mirror 017 exactly: member-read, admin-only update, no client insert.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select ON accounts FOR SELECT USING (is_account_member(id));
CREATE POLICY accounts_update ON accounts FOR UPDATE
  USING (is_account_member(id, 'admin')) WITH CHECK (is_account_member(id, 'admin'));

-- update_updated_at_column trigger (001) that 017 attaches to accounts.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`

function loadMigration(name: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const file = readdirSync(dir).find((f: string) => f.endsWith(name))
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
  adminA: '10000000-0000-0000-0000-000000000001', // admin of account A
  agentA: '10000000-0000-0000-0000-000000000002', // agent (non-admin) of account A
  adminB: '10000000-0000-0000-0000-000000000003', // admin of a DIFFERENT account B
  stranger: '10000000-0000-0000-0000-000000000004', // not a member anywhere
}

let accountA: string
let accountB: string

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(loadMigration('041_accounts_owner_nullable_and_cnpj.sql'))
  await db.exec(loadMigration('053_accounts_commercial_identity.sql'))

  await run(
    `INSERT INTO auth.users (id, email) VALUES ($1,'admina@x'),($2,'agenta@x'),($3,'adminb@x'),($4,'stranger@x')`,
    [U.adminA, U.agentA, U.adminB, U.stranger],
  )

  const accA = await run<{ id: string }>(
    `INSERT INTO accounts (name, owner_user_id) VALUES ('Account A', $1) RETURNING id`,
    [U.adminA],
  )
  accountA = accA[0].id
  const accB = await run<{ id: string }>(
    `INSERT INTO accounts (name, owner_user_id) VALUES ('Account B', $1) RETURNING id`,
    [U.adminB],
  )
  accountB = accB[0].id

  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES
       ($1, $2, 'admin'), ($3, $2, 'agent'), ($4, $5, 'admin')`,
    [U.adminA, accountA, U.agentA, U.adminB, accountB],
  )
})

describe('053 — schema: three nullable identity columns exist', () => {
  it('legal_name / commercial_phone / commercial_email are nullable text columns', async () => {
    const cols = await run<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_name = 'accounts'
         AND column_name IN ('legal_name', 'commercial_phone', 'commercial_email')
       ORDER BY column_name`,
    )
    expect(cols).toHaveLength(3)
    for (const c of cols) {
      expect(c.is_nullable).toBe('YES')
      expect(c.data_type).toBe('text')
    }
  })

  it('CNPJ constraint from 041 is not redefined (still exactly 14 digits or NULL)', async () => {
    await expect(
      run(`UPDATE accounts SET cnpj = $1 WHERE id = $2`, ['123', accountA]),
    ).rejects.toThrow(/accounts_cnpj_format/i)
  })
})

describe('053 — CHECK constraints (§7)', () => {
  it('rejects legal_name that is blank after trim', async () => {
    await expect(
      run(`UPDATE accounts SET legal_name = $1 WHERE id = $2`, ['   ', accountA]),
    ).rejects.toThrow(/accounts_legal_name_format/i)
  })

  it('rejects legal_name over the length cap', async () => {
    await expect(
      run(`UPDATE accounts SET legal_name = $1 WHERE id = $2`, ['x'.repeat(161), accountA]),
    ).rejects.toThrow(/accounts_legal_name_format/i)
  })

  it('accepts a valid legal_name and NULL clears it back', async () => {
    await run(`UPDATE accounts SET legal_name = $1 WHERE id = $2`, ['Acme Ltda', accountA])
    let r = await run<{ legal_name: string | null }>(`SELECT legal_name FROM accounts WHERE id = $1`, [accountA])
    expect(r[0].legal_name).toBe('Acme Ltda')

    await run(`UPDATE accounts SET legal_name = NULL WHERE id = $1`, [accountA])
    r = await run<{ legal_name: string | null }>(`SELECT legal_name FROM accounts WHERE id = $1`, [accountA])
    expect(r[0].legal_name).toBeNull()
  })

  it('rejects a commercial_phone that is obvious garbage (letters, too short)', async () => {
    await expect(
      run(`UPDATE accounts SET commercial_phone = $1 WHERE id = $2`, ['abc', accountA]),
    ).rejects.toThrow(/accounts_commercial_phone_format/i)
  })

  it('accepts common legitimate phone formats (never blocks a real-looking number, §7.2 normative)', async () => {
    const legit = ['+55 11 91234-5678', '(11) 91234-5678', '5511912345678', '+1-415-555-0132']
    for (const phone of legit) {
      await run(`UPDATE accounts SET commercial_phone = $1 WHERE id = $2`, [phone, accountA])
      const r = await run<{ commercial_phone: string }>(
        `SELECT commercial_phone FROM accounts WHERE id = $1`,
        [accountA],
      )
      expect(r[0].commercial_phone).toBe(phone)
    }
  })

  it('rejects a commercial_email missing @ or domain dot', async () => {
    await expect(
      run(`UPDATE accounts SET commercial_email = $1 WHERE id = $2`, ['not-an-email', accountA]),
    ).rejects.toThrow(/accounts_commercial_email_format/i)
  })

  it('accepts a well-formed commercial_email', async () => {
    await run(`UPDATE accounts SET commercial_email = $1 WHERE id = $2`, ['contato@empresa.com.br', accountA])
    const r = await run<{ commercial_email: string }>(
      `SELECT commercial_email FROM accounts WHERE id = $1`,
      [accountA],
    )
    expect(r[0].commercial_email).toBe('contato@empresa.com.br')
  })
})

describe('053/017 — member-side authorization matrix (§8.1, §12)', () => {
  it('admin member edits own account — succeeds', async () => {
    await asUser(U.adminA, () =>
      run(`UPDATE accounts SET legal_name = $1 WHERE id = $2`, ['Own Co', accountA]),
    )
    const r = await run<{ legal_name: string }>(`SELECT legal_name FROM accounts WHERE id = $1`, [accountA])
    expect(r[0].legal_name).toBe('Own Co')
  })

  it('agent (non-admin) member is blocked by RLS — zero rows affected', async () => {
    const before = await run<{ legal_name: string | null }>(
      `SELECT legal_name FROM accounts WHERE id = $1`,
      [accountA],
    )
    const affected = await asUser(U.agentA, () =>
      run(`UPDATE accounts SET legal_name = $1 WHERE id = $2 RETURNING id`, ['Hacked', accountA]),
    )
    expect(affected).toHaveLength(0) // RLS silently filters — no rows match
    const after = await run<{ legal_name: string | null }>(
      `SELECT legal_name FROM accounts WHERE id = $1`,
      [accountA],
    )
    expect(after[0].legal_name).toBe(before[0].legal_name)
  })

  it('admin of a DIFFERENT account (B) cannot edit account A — RLS blocks cross-tenant', async () => {
    const affected = await asUser(U.adminB, () =>
      run(`UPDATE accounts SET legal_name = $1 WHERE id = $2 RETURNING id`, ['Cross Tenant', accountA]),
    )
    expect(affected).toHaveLength(0)
  })

  it('a stranger (no membership anywhere) cannot edit any account', async () => {
    const affected = await asUser(U.stranger, () =>
      run(`UPDATE accounts SET legal_name = $1 WHERE id = $2 RETURNING id`, ['Stranger Danger', accountA]),
    )
    expect(affected).toHaveLength(0)
  })
})

describe('053 — partial update semantics (§7.5, normative, tested at the SQL layer the route relies on)', () => {
  it('omitted columns are unaffected by an UPDATE that only sets the touched ones', async () => {
    await run(
      `UPDATE accounts SET legal_name = $1, commercial_phone = $2, commercial_email = $3 WHERE id = $4`,
      ['Baseline Co', '+55 11 90000-0000', 'base@co.com', accountB],
    )
    // Only touch commercial_phone — mirrors what /api/account PATCH does:
    // it builds an `update` object from ONLY the keys present in the body.
    await run(`UPDATE accounts SET commercial_phone = $1 WHERE id = $2`, ['+55 11 99999-9999', accountB])

    const r = await run<{ legal_name: string; commercial_phone: string; commercial_email: string }>(
      `SELECT legal_name, commercial_phone, commercial_email FROM accounts WHERE id = $1`,
      [accountB],
    )
    expect(r[0].legal_name).toBe('Baseline Co') // untouched
    expect(r[0].commercial_email).toBe('base@co.com') // untouched
    expect(r[0].commercial_phone).toBe('+55 11 99999-9999') // the only field changed
  })

  it('an explicit NULL clears a field without touching the others', async () => {
    await run(`UPDATE accounts SET commercial_email = NULL WHERE id = $1`, [accountB])
    const r = await run<{ legal_name: string; commercial_phone: string; commercial_email: string | null }>(
      `SELECT legal_name, commercial_phone, commercial_email FROM accounts WHERE id = $1`,
      [accountB],
    )
    expect(r[0].commercial_email).toBeNull()
    expect(r[0].legal_name).toBe('Baseline Co')
    expect(r[0].commercial_phone).toBe('+55 11 99999-9999')
  })
})

describe('053 — CNPJ correction path (§3 item 3, §7.4, §11 criterion 4)', () => {
  it('a valid new CNPJ persists', async () => {
    await run(`UPDATE accounts SET cnpj = $1 WHERE id = $2`, ['11222333000181', accountA])
    const r = await run<{ cnpj: string }>(`SELECT cnpj FROM accounts WHERE id = $1`, [accountA])
    expect(r[0].cnpj).toBe('11222333000181')
  })

  it('correcting to a CNPJ already used by another tenant is rejected by the partial unique index', async () => {
    await run(`UPDATE accounts SET cnpj = $1 WHERE id = $2`, ['99888777000199', accountB])
    await expect(
      run(`UPDATE accounts SET cnpj = $1 WHERE id = $2`, ['99888777000199', accountA]),
    ).rejects.toThrow(/idx_accounts_cnpj_unique|duplicate key/i)
  })

  it('clearing a CNPJ (explicit NULL) is allowed', async () => {
    await run(`UPDATE accounts SET cnpj = NULL WHERE id = $1`, [accountA])
    const r = await run<{ cnpj: string | null }>(`SELECT cnpj FROM accounts WHERE id = $1`, [accountA])
    expect(r[0].cnpj).toBeNull()
  })
})

describe('053 — updated_at advances on identity mutation (§11 criterion 7)', () => {
  it('updated_at changes after an identity UPDATE', async () => {
    const before = await run<{ updated_at: string }>(`SELECT updated_at FROM accounts WHERE id = $1`, [accountA])
    await new Promise((resolve) => setTimeout(resolve, 5))
    await run(`UPDATE accounts SET legal_name = $1 WHERE id = $2`, ['Timestamp Check', accountA])
    const after = await run<{ updated_at: string }>(`SELECT updated_at FROM accounts WHERE id = $1`, [accountA])
    expect(new Date(after[0].updated_at).getTime()).toBeGreaterThan(new Date(before[0].updated_at).getTime())
  })
})
