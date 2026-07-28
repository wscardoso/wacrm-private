import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for E9 / Fase 1 —
// list_platform_tenant_whatsapp_status() (migration 059). Executes the
// ACTUAL SQL from 037 + 059 (not a copy) so the SECURITY DEFINER /
// auth.uid() filtering is validated against a true Postgres engine.
//
// Authorization pattern under test: this RPC deliberately does NOT
// raise 42501 for unauthenticated / non-operator / inactive-operator
// callers — same as its sibling list_platform_operator_accounts()
// (039). It returns an EMPTY SET in those cases (see 059's own doc
// comment for the rationale). This was a deliberate decision, not an
// oversight — confirmed with the requester before implementation.

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Minimal mirror of 017's is_account_member — 037's can_access_account()
-- calls it, so it must exist even though this RPC's own logic never
-- calls can_access_account() (it joins platform_operator_accounts
-- directly, mirroring 039).
CREATE OR REPLACE FUNCTION is_account_member(target_account_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT FALSE;
$$;

-- Minimal stub — only the columns list_platform_tenant_whatsapp_status()
-- reads. Real whatsapp_config also carries access_token/verify_token/
-- phone_number_id/waba_id, deliberately omitted here since the RPC must
-- never touch them; their absence in this stub is itself a guard: the
-- migration's SQL would fail to compile if it referenced a column that
-- doesn't exist here.
CREATE TABLE whatsapp_config (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'disconnected',
  provider   TEXT NOT NULL DEFAULT 'meta'
);
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
  opA: '10000000-0000-0000-0000-00000000000a',
  inactive: '10000000-0000-0000-0000-00000000000c',
  stranger: '10000000-0000-0000-0000-00000000000d',
  ownerA: '10000000-0000-0000-0000-00000000000e',
  ownerB: '10000000-0000-0000-0000-00000000000f',
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
  clientB: '20000000-0000-0000-0000-0000000000a2',
  unassigned: '20000000-0000-0000-0000-0000000000a3',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await run(
    `INSERT INTO auth.users (id) VALUES ($1),($2),($3),($4),($5)`,
    [U.opA, U.inactive, U.stranger, U.ownerA, U.ownerB],
  )
  await run(
    `INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'Alpha',$2),($3,'Bravo',$4),($5,'Unassigned',$2)`,
    [A.clientA, U.ownerA, A.clientB, U.ownerB, A.unassigned],
  )
  // Alpha is connected via meta; Bravo has a row but never finished
  // connecting; Unassigned has no whatsapp_config row at all.
  await run(
    `INSERT INTO whatsapp_config (account_id, status, provider) VALUES ($1,'connected','meta'),($2,'disconnected','zapi')`,
    [A.clientA, A.clientB],
  )

  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES
       ($1,'operator',TRUE,$1),
       ($2,'operator',FALSE,$2)`,
    [U.opA, U.inactive],
  )
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES
       ($1,$2,'admin',$1),
       ($1,$3,'viewer',$1)`,
    [U.opA, A.clientA, A.clientB],
  )
  // Note: A.unassigned is intentionally NOT in platform_operator_accounts.

  await db.exec(loadMigration('059_platform_tenant_whatsapp_status.sql'))
})

describe('list_platform_tenant_whatsapp_status — authorization', () => {
  it('unauthenticated caller receives an empty set (no exception)', async () => {
    const r = await run('SELECT * FROM list_platform_tenant_whatsapp_status()')
    expect(r.length).toBe(0)
  })

  it('authenticated non-operator user receives an empty set', async () => {
    await asUser(U.stranger, async () => {
      const r = await run('SELECT * FROM list_platform_tenant_whatsapp_status()')
      expect(r.length).toBe(0)
    })
  })

  it('inactive operator receives an empty set', async () => {
    await asUser(U.inactive, async () => {
      const r = await run('SELECT * FROM list_platform_tenant_whatsapp_status()')
      expect(r.length).toBe(0)
    })
  })

  it('active operator receives status rows only for tenants they supervise', async () => {
    await asUser(U.opA, async () => {
      const r = await run<{ account_id: string; status: string; provider: string }>(
        'SELECT account_id, status, provider FROM list_platform_tenant_whatsapp_status() ORDER BY account_id',
      )
      expect(r.length).toBe(2)
      const alpha = r.find((x) => x.account_id === A.clientA)
      const bravo = r.find((x) => x.account_id === A.clientB)
      expect(alpha).toEqual({ account_id: A.clientA, status: 'connected', provider: 'meta' })
      expect(bravo).toEqual({ account_id: A.clientB, status: 'disconnected', provider: 'zapi' })
    })
  })
})

describe('list_platform_tenant_whatsapp_status — secrets audit', () => {
  it('the returned row shape never includes a sensitive column', async () => {
    await asUser(U.opA, async () => {
      const r = await run<Record<string, unknown>>(
        'SELECT * FROM list_platform_tenant_whatsapp_status() LIMIT 1',
      )
      const keys = Object.keys(r[0])
      expect(keys.sort()).toEqual(['account_id', 'provider', 'status'])
      for (const forbidden of ['access_token', 'verify_token', 'phone_number_id', 'waba_id']) {
        expect(keys).not.toContain(forbidden)
      }
    })
  })
})
