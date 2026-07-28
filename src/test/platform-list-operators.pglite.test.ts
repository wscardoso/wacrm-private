import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for E9 / Fase 2 —
// list_platform_operators() (migration 062). Executes the ACTUAL SQL
// from 037 + 062 against a true Postgres engine.
//
// This RPC is admin-gated, not merely operator-gated — an active
// non-admin operator must be rejected exactly like an unauthenticated
// caller (both 42501), per 037's "the operator directory is not
// public" framing. That distinction is the main thing under test here.

let db: PGlite

const FOUNDATION = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::UUID
$$;

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Minimal mirror of 017's is_account_member — 037's can_access_account()
-- calls it, so it must exist even though this migration's own RPC never
-- calls can_access_account().
CREATE OR REPLACE FUNCTION is_account_member(target_account_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT FALSE;
$$;
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
  admin: '10000000-0000-0000-0000-000000000001',
  operator: '10000000-0000-0000-0000-000000000002',
  inactiveOperator: '10000000-0000-0000-0000-000000000003',
  ownerA: '10000000-0000-0000-0000-000000000004',
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await run(
    `INSERT INTO auth.users (id, email) VALUES ($1,'admin@forcecrm.test'),($2,'operator@forcecrm.test'),($3,'inactive@forcecrm.test'),($4,'ownera@forcecrm.test')`,
    [U.admin, U.operator, U.inactiveOperator, U.ownerA],
  )
  await run(`INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'Alpha',$2)`, [A.clientA, U.ownerA])

  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES
       ($1,'admin',TRUE,$1),
       ($2,'operator',TRUE,$1),
       ($3,'operator',FALSE,$1)`,
    [U.admin, U.operator, U.inactiveOperator],
  )
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES ($1,$2,'viewer',$1)`,
    [U.operator, A.clientA],
  )

  await db.exec(loadMigration('062_list_platform_operators.sql'))
})

describe('list_platform_operators — authorization', () => {
  it('rejects an unauthenticated caller — 42501', async () => {
    await expect(run(`SELECT * FROM list_platform_operators()`)).rejects.toThrow(/Unauthorized/i)
  })

  it('rejects an active NON-ADMIN operator — same 42501 as unauthenticated, directory stays admin-only', async () => {
    await asUser(U.operator, async () => {
      await expect(run(`SELECT * FROM list_platform_operators()`)).rejects.toThrow(/active platform admin/i)
    })
  })
})

describe('list_platform_operators — active admin', () => {
  it('returns every operator, including inactive ones, with assigned tenants aggregated', async () => {
    await asUser(U.admin, async () => {
      const rows = await run<{
        user_id: string
        email: string
        role: string
        is_active: boolean
        assigned_accounts: { account_id: string; name: string; access_role: string }[]
      }>(`SELECT user_id, email, role, is_active, assigned_accounts FROM list_platform_operators() ORDER BY email`)

      expect(rows.length).toBe(3)

      const operatorRow = rows.find((r) => r.user_id === U.operator)
      expect(operatorRow?.assigned_accounts).toEqual([
        { account_id: A.clientA, name: 'Alpha', access_role: 'viewer' },
      ])

      const inactiveRow = rows.find((r) => r.user_id === U.inactiveOperator)
      expect(inactiveRow?.is_active).toBe(false)
      expect(inactiveRow?.assigned_accounts).toEqual([])

      const adminRow = rows.find((r) => r.user_id === U.admin)
      expect(adminRow?.role).toBe('admin')
    })
  })
})
