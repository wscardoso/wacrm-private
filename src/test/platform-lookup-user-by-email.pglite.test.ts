import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for E9 / Fase 2 —
// platform_lookup_user_id_by_email() (migration 061). Executes the
// ACTUAL SQL from 037 + 061 against a true Postgres engine.

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
  stranger: '10000000-0000-0000-0000-000000000003',
  candidate: '10000000-0000-0000-0000-000000000004',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await run(
    `INSERT INTO auth.users (id, email) VALUES ($1,'admin@forcecrm.test'),($2,'operator@forcecrm.test'),($3,'stranger@forcecrm.test'),($4,'candidate@forcecrm.test')`,
    [U.admin, U.operator, U.stranger, U.candidate],
  )

  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES
       ($1,'admin',TRUE,$1),
       ($2,'operator',TRUE,$1)`,
    [U.admin, U.operator],
  )

  await db.exec(loadMigration('061_platform_lookup_user_by_email.sql'))
})

describe('platform_lookup_user_id_by_email — authorization', () => {
  it('rejects an unauthenticated caller — Unauthorized / 42501 (distinct from the non-admin message)', async () => {
    await expect(
      run(`SELECT platform_lookup_user_id_by_email($1)`, ['candidate@forcecrm.test']),
    ).rejects.toThrow(/Unauthorized/i)
  })

  it('rejects an authenticated non-admin operator — "active platform admin" / 42501 (distinct from the unauthenticated message)', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`SELECT platform_lookup_user_id_by_email($1)`, ['candidate@forcecrm.test']),
      ).rejects.toThrow(/active platform admin/i)
    })
  })

  it('rejects an authenticated non-operator stranger the same way as a non-admin operator', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run(`SELECT platform_lookup_user_id_by_email($1)`, ['candidate@forcecrm.test']),
      ).rejects.toThrow(/active platform admin/i)
    })
  })
})

describe('platform_lookup_user_id_by_email — lookup outcomes (active admin)', () => {
  it('resolves an existing email to its user id', async () => {
    await asUser(U.admin, async () => {
      const rows = await run<{ platform_lookup_user_id_by_email: string }>(
        `SELECT platform_lookup_user_id_by_email($1)`,
        ['candidate@forcecrm.test'],
      )
      expect(rows[0].platform_lookup_user_id_by_email).toBe(U.candidate)
    })
  })

  it('rejects with 22023 (validation) when no user has that email — never 42501', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT platform_lookup_user_id_by_email($1)`, ['nobody@forcecrm.test']),
      ).rejects.toThrow(/No user found with email/i)
    })
  })
})
