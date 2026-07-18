import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for P1c Lot 1 — the
// list_platform_operator_accounts() discovery RPC (migration 039).
// Executes the ACTUAL SQL from migration 039 (not a copy) so the
// SECURITY DEFINER / auth.uid() filtering is validated against a true
// Postgres engine.

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
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_accounts_one_per_owner ON accounts(owner_user_id);

CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum
);
CREATE INDEX idx_profiles_account_role ON profiles(account_id, account_role);

-- Minimal mirror of 017's is_account_member (kept local so this test file
-- is self-contained; 037 wires can_access_account() on top of the real one
-- in Supabase).
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
`

function loadMigration(name: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const file = require('node:fs')
    .readdirSync(dir)
    .find((f: string) => f.endsWith(name))
  if (!file) throw new Error(`migration not found: ${name}`)
  return readFileSync(join(dir, file), 'utf8')
}

async function run<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(text, params)
  return r.rows as T[]
}

async function asUser(userId: string | null, fn: () => Promise<void>) {
  await run(`SET ROLE authenticated`)
  await run(`SELECT set_config('app.current_user', $1, false)`, [userId ?? ''])
  try {
    await fn()
  } finally {
    await run(`SELECT set_config('app.current_user', NULL, false)`)
    await run(`RESET ROLE`)
  }
}

const U = {
  opA: '10000000-0000-0000-0000-00000000000a',
  opB: '10000000-0000-0000-0000-00000000000b',
  inactive: '10000000-0000-0000-0000-00000000000c',
  stranger: '10000000-0000-0000-0000-00000000000d',
  ownerA: '10000000-0000-0000-0000-00000000000e',
  ownerB: '10000000-0000-0000-0000-00000000000f',
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
  clientB: '20000000-0000-0000-0000-0000000000a2',
  clientC: '20000000-0000-0000-0000-0000000000a3',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await run(
    `INSERT INTO auth.users (id) VALUES ($1),($2),($3),($4),($5),($6)`,
    [U.opA, U.opB, U.inactive, U.stranger, U.ownerA, U.ownerB],
  )
  await run(
    `INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'Alpha',$2),($3,'Bravo',$4),($5,'Charlie',$6)`,
    [A.clientA, U.ownerA, A.clientB, U.ownerB, A.clientC, U.stranger],
  )
  // Load the foundation (platform tables + can_access_account) so 039 can
  // reference platform_operator_accounts / platform_operators.
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))

  // Bootstrap operators directly (out-of-band, as 037 intends).
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES
       ($1,'operator',TRUE,$1),
       ($2,'operator',TRUE,$2),
       ($3,'operator',FALSE,$3)`,
    [U.opA, U.opB, U.inactive],
  )
  // opA assigned to Alpha + Bravo; opB assigned to Charlie only.
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES
       ($1,$2,'admin',$1),
       ($1,$3,'viewer',$1),
       ($4,$5,'agent',$4)`,
    [U.opA, A.clientA, A.clientB, U.opB, A.clientC],
  )
  // Load the RPC under test.
  await db.exec(loadMigration('039_platform_account_discovery.sql'))
})

describe('P1c Lot 1 — discovery RPC authorization', () => {
  it('active operator receives only their own assignments', async () => {
    await asUser(U.opA, async () => {
      const r = await run<{ account_id: string; name: string; access_role: string }>(
        'SELECT account_id, name, access_role FROM list_platform_operator_accounts() ORDER BY name',
      )
      expect(r.length).toBe(2)
      expect(r.map((x) => x.account_id).sort()).toEqual([A.clientA, A.clientB].sort())
    })
  })

  it('operator with multiple accounts receives all of them', async () => {
    await asUser(U.opA, async () => {
      const r = await run<{ account_id: string }>('SELECT account_id FROM list_platform_operator_accounts()')
      expect(r.length).toBe(2)
      expect(r.map((x) => x.account_id)).toContain(A.clientA)
      expect(r.map((x) => x.account_id)).toContain(A.clientB)
    })
  })

  it('another operator does not appear in the result', async () => {
    // opB is assigned to Charlie; opA's call must NOT surface Charlie.
    await asUser(U.opA, async () => {
      const r = await run<{ account_id: string }>('SELECT account_id FROM list_platform_operator_accounts()')
      expect(r.map((x) => x.account_id)).not.toContain(A.clientC)
    })
    // And opB sees only Charlie.
    await asUser(U.opB, async () => {
      const r = await run<{ account_id: string }>('SELECT account_id FROM list_platform_operator_accounts()')
      expect(r.length).toBe(1)
      expect(r[0].account_id).toBe(A.clientC)
    })
  })

  it('non-operator user receives an empty set', async () => {
    await asUser(U.stranger, async () => {
      const r = await run('SELECT account_id FROM list_platform_operator_accounts()')
      expect(r.length).toBe(0)
    })
  })

  it('inactive operator receives an empty set', async () => {
    await asUser(U.inactive, async () => {
      const r = await run('SELECT account_id FROM list_platform_operator_accounts()')
      expect(r.length).toBe(0)
    })
  })

  it('access_role is returned correctly', async () => {
    await asUser(U.opA, async () => {
      const r = await run<{ account_id: string; access_role: string }>(
        'SELECT account_id, access_role FROM list_platform_operator_accounts()',
      )
      const alpha = r.find((x) => x.account_id === A.clientA)
      const bravo = r.find((x) => x.account_id === A.clientB)
      expect(alpha?.access_role).toBe('admin')
      expect(bravo?.access_role).toBe('viewer')
    })
  })

  it('no unassigned account appears', async () => {
    // Charlie (clientC) is assigned to opB, not opA — opA must not see it.
    await asUser(U.opA, async () => {
      const r = await run<{ account_id: string }>('SELECT account_id FROM list_platform_operator_accounts()')
      const ids = r.map((x) => x.account_id)
      expect(ids).not.toContain(A.clientC)
      expect(ids.length).toBe(2)
    })
  })

  it('RPC accepts no account_id / user argument (signature is argless)', async () => {
    // Confirm calling with an argument is rejected (signature is ()).
    await asUser(U.opA, async () => {
      await expect(
        run('SELECT * FROM list_platform_operator_accounts($1)', [A.clientA]),
      ).rejects.toThrow()
    })
    // And the argless call still returns only the caller's own rows.
    await asUser(U.opA, async () => {
      const r = await run<{ account_id: string }>('SELECT account_id FROM list_platform_operator_accounts()')
      expect(r.map((x) => x.account_id).sort()).toEqual([A.clientA, A.clientB].sort())
    })
  })
})
