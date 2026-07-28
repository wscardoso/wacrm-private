import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for E9 / Fase 1 —
// platform_lookup_account_by_cnpj() (migration 060). Executes the
// ACTUAL SQL from 037 + 060 against a true Postgres engine.

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

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  cnpj TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_accounts_cnpj_unique ON accounts(cnpj) WHERE cnpj IS NOT NULL;

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
  stranger: '10000000-0000-0000-0000-000000000003',
}
const A = {
  existing: '20000000-0000-0000-0000-0000000000a1',
}
const CNPJ_TAKEN = '11222333000181'
const CNPJ_FREE = '11222333000280'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await run(`INSERT INTO auth.users (id) VALUES ($1),($2),($3)`, [U.admin, U.operator, U.stranger])
  await run(
    `INSERT INTO accounts (id, name, owner_user_id, cnpj) VALUES ($1, 'Existing Tenant', $2, $3)`,
    [A.existing, U.stranger, CNPJ_TAKEN],
  )

  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES
       ($1,'admin',TRUE,$1),
       ($2,'operator',TRUE,$1)`,
    [U.admin, U.operator],
  )

  await db.exec(loadMigration('060_platform_lookup_account_by_cnpj.sql'))
})

describe('platform_lookup_account_by_cnpj — authorization', () => {
  it('rejects an unauthenticated caller — Unauthorized / 42501 (distinct from the non-admin message)', async () => {
    await expect(
      run(`SELECT platform_lookup_account_by_cnpj($1)`, [CNPJ_FREE]),
    ).rejects.toThrow(/Unauthorized/i)
  })

  it('rejects an authenticated non-admin operator — "active platform admin" / 42501 (distinct from the unauthenticated message)', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`SELECT platform_lookup_account_by_cnpj($1)`, [CNPJ_FREE]),
      ).rejects.toThrow(/active platform admin/i)
    })
  })

  it('rejects an authenticated non-operator stranger the same way as a non-admin operator', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run(`SELECT platform_lookup_account_by_cnpj($1)`, [CNPJ_FREE]),
      ).rejects.toThrow(/active platform admin/i)
    })
  })
})

describe('platform_lookup_account_by_cnpj — lookup outcomes (active admin)', () => {
  it('returns NULL, with no exception, when the CNPJ has no conflict', async () => {
    await asUser(U.admin, async () => {
      const rows = await run<{ platform_lookup_account_by_cnpj: unknown }>(
        `SELECT platform_lookup_account_by_cnpj($1)`,
        [CNPJ_FREE],
      )
      expect(rows[0].platform_lookup_account_by_cnpj).toBeNull()
    })
  })

  it('returns {account_id, name} when the CNPJ is already taken', async () => {
    await asUser(U.admin, async () => {
      const rows = await run<{ platform_lookup_account_by_cnpj: { account_id: string; name: string } }>(
        `SELECT platform_lookup_account_by_cnpj($1)`,
        [CNPJ_TAKEN],
      )
      expect(rows[0].platform_lookup_account_by_cnpj).toEqual({
        account_id: A.existing,
        name: 'Existing Tenant',
      })
    })
  })
})
