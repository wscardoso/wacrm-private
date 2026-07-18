import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for the P0 platform_admin
// foundation (migration 037). These execute the ACTUAL SQL from the
// migration — not copies — so the RLS/SECURITY DEFINER/RPC authorization
// logic is validated against a true Postgres engine.
//
// PGlite has no Supabase `auth` schema, so we stub:
//   * roles anon/authenticated/service_role (so GRANT/REVOKE succeed)
//   * an `auth` schema with a `users` table and a `uid()` function backed
//     by a session GUC we flip per test (set_current_user / clear_user).
// We also stub the minimal tenant model (accounts, profiles,
// account_role_enum, is_account_member) that 037 depends on.

let db: PGlite

const SCHEMA = `
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
-- is self-contained; the migration wires can_access_account() on top of
-- the real one in Supabase).
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

// Flip the "current user" seen by auth.uid() for the duration of a block.
// We also SET ROLE authenticated so Row Level Security actually applies
// (PGlite connects as superuser, which bypasses RLS — so direct-DML
// protection can only be observed as a non-superuser role).
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

// Fixed UUIDs for deterministic tests.
const U = {
  admin: '10000000-0000-0000-0000-000000000001',
  operator: '10000000-0000-0000-0000-000000000002',
  stranger: '10000000-0000-0000-0000-000000000003',
  member: '10000000-0000-0000-0000-000000000004',
  otherMember: '10000000-0000-0000-0000-000000000005',
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
  clientB: '20000000-0000-0000-0000-0000000000a2',
  clientC: '20000000-0000-0000-0000-0000000000a3',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  // Seed auth.users for the actors we reference.
  await run(
    `INSERT INTO auth.users (id) VALUES ($1),($2),($3),($4),($5)`,
    [U.admin, U.operator, U.stranger, U.member, U.otherMember],
  )
  // Tenant accounts (each owned by a distinct user, preserving the
  // one-account-per-owner invariant).
  await run(
    `INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'A',$2),($3,'B',$4),($5,'C',$6)`,
    [A.clientA, U.member, A.clientB, U.otherMember, A.clientC, U.stranger],
  )
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
    [U.member, A.clientA, U.otherMember, A.clientB],
  )
  // Load the real migration under test.
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
})

describe('P0 foundation — bootstrap & direct DML protection', () => {
  it('no platform_operators rows exist after migration (no self-bootstrap)', async () => {
    const rows = await run('SELECT count(*)::int AS c FROM platform_operators')
    expect(rows[0].c).toBe(0)
  })

  it('common user cannot INSERT into platform_operators directly', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run(
          `INSERT INTO platform_operators (user_id, role, is_active, created_by)
           VALUES ($1,'admin',TRUE,$1)`,
          [U.stranger],
        ),
      ).rejects.toThrow()
    })
  })

  it('common user cannot INSERT into platform_audit_log directly', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run(
          `INSERT INTO platform_audit_log (actor_user_id, action)
           VALUES ($1,'forged')`,
          [U.stranger],
        ),
      ).rejects.toThrow()
    })
  })
})

describe('P0 foundation — helper functions', () => {
  it('is_platform_operator(): active operator recognized, stranger not', async () => {
    // Seed an active operator directly (simulating out-of-band bootstrap).
    await run(
      `INSERT INTO platform_operators (user_id, role, is_active, created_by)
       VALUES ($1,'operator',TRUE,$1)`,
      [U.operator],
    )
    await asUser(U.operator, async () => {
      const r = await run<{ is_platform_operator: boolean }>(
        'SELECT is_platform_operator() AS is_platform_operator',
      )
      expect(r[0].is_platform_operator).toBe(true)
    })
    await asUser(U.stranger, async () => {
      const r = await run<{ is_platform_operator: boolean }>(
        'SELECT is_platform_operator() AS is_platform_operator',
      )
      expect(r[0].is_platform_operator).toBe(false)
    })
  })

  it('is_platform_operator_for(): only explicitly assigned tenants', async () => {
    await run(
      `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by)
       VALUES ($1,$2,'viewer',$1)`,
      [U.operator, A.clientA],
    )
    await asUser(U.operator, async () => {
      const yes = await run<{ v: boolean }>(
        'SELECT is_platform_operator_for($1) AS v',
        [A.clientA],
      )
      const no = await run<{ v: boolean }>(
        'SELECT is_platform_operator_for($1) AS v',
        [A.clientB],
      )
      expect(yes[0].v).toBe(true)
      expect(no[0].v).toBe(false)
    })
  })

  it('can_access_account(): member, operator-assigned, stranger', async () => {
    // Owner of clientA reaches their own account.
    await asUser(U.member, async () => {
      const r = await run<{ v: boolean }>('SELECT can_access_account($1) AS v', [A.clientA])
      expect(r[0].v).toBe(true)
    })
    // Operator assigned to clientA reaches it via platform path.
    await asUser(U.operator, async () => {
      const r = await run<{ v: boolean }>('SELECT can_access_account($1) AS v', [A.clientA])
      expect(r[0].v).toBe(true)
    })
    // Operator NOT assigned to clientB cannot reach it.
    await asUser(U.operator, async () => {
      const r = await run<{ v: boolean }>('SELECT can_access_account($1) AS v', [A.clientB])
      expect(r[0].v).toBe(false)
    })
    // Stranger reaches neither.
    await asUser(U.stranger, async () => {
      const r = await run<{ v: boolean }>('SELECT can_access_account($1) AS v', [A.clientA])
      expect(r[0].v).toBe(false)
    })
  })
})

describe('P0 foundation — revoked/disabled operator', () => {
  it('deactivating operator immediately loses access', async () => {
    await run('UPDATE platform_operators SET is_active = FALSE WHERE user_id = $1', [U.operator])
    await asUser(U.operator, async () => {
      const op = await run<{ v: boolean }>('SELECT is_platform_operator() AS v')
      const acc = await run<{ v: boolean }>(
        'SELECT is_platform_operator_for($1) AS v',
        [A.clientA],
      )
      expect(op[0].v).toBe(false)
      expect(acc[0].v).toBe(false)
    })
  })
})

describe('P0 foundation — RPCs authorization', () => {
  beforeAll(async () => {
    // Reset operator to active and seed a real admin via the bootstrap
    // stub so RPC tests exercise the admin-gated paths.
    await run('UPDATE platform_operators SET is_active = TRUE WHERE user_id = $1', [U.operator])
    await run(
      `INSERT INTO platform_operators (user_id, role, is_active, created_by)
       VALUES ($1,'admin',TRUE,$1)`,
      [U.admin],
    )
  })

  it('common user cannot call grant_platform_operator', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run('SELECT grant_platform_operator($1)', [U.stranger]),
      ).rejects.toThrow(/admin/i)
    })
  })

  it('admin cannot self-promote', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run('SELECT grant_platform_operator($1)', [U.admin]),
      ).rejects.toThrow(/yourself/i)
    })
  })

  it('admin can grant operator to another user (audit logged)', async () => {
    await asUser(U.admin, async () => {
      await run('SELECT grant_platform_operator($1, $2)', [U.stranger, 'operator'])
    })
    const ops = await run<{ role: string; is_active: boolean }>(
      'SELECT role, is_active FROM platform_operators WHERE user_id = $1',
      [U.stranger],
    )
    expect(ops[0].role).toBe('operator')
    expect(ops[0].is_active).toBe(true)
    const log = await run<{ actor_user_id: string; target_user_id: string; action: string }>(
      `SELECT actor_user_id, target_user_id, action FROM platform_audit_log
       WHERE action = 'grant_operator' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(log[0].actor_user_id).toBe(U.admin)
    expect(log[0].target_user_id).toBe(U.stranger)
  })

  it('operator cannot grant admin access role (hierarchy enforced)', async () => {
    // Promote stranger to operator, then try assigning admin access as operator.
    await run('UPDATE platform_operators SET role = $1 WHERE user_id = $2', ['operator', U.stranger])
    await asUser(U.stranger, async () => {
      await expect(
        run('SELECT assign_platform_operator_account($1,$2,$3)', [
          U.operator,
          A.clientA,
          'admin',
        ]),
      ).rejects.toThrow(/admin/i)
    })
  })

  it('admin can assign operator to a tenant (audit logged)', async () => {
    await asUser(U.admin, async () => {
      await run('SELECT assign_platform_operator_account($1,$2,$3)', [
        U.operator,
        A.clientA,
        'viewer',
      ])
    })
    const assign = await run<{ account_id: string }>(
      'SELECT account_id FROM platform_operator_accounts WHERE operator_user_id = $1',
      [U.operator],
    )
    expect(assign[0].account_id).toBe(A.clientA)
    const log = await run<{ action: string; target_account_id: string }>(
      `SELECT action, target_account_id FROM platform_audit_log
       WHERE action = 'assign_operator_account' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(log[0].target_account_id).toBe(A.clientA)
  })

  it('operator cannot unassign/assign (admin-only RPCs reject operator)', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run('SELECT unassign_platform_operator_account($1,$2)', [U.stranger, A.clientA]),
      ).rejects.toThrow(/admin/i)
    })
  })

  it('audit log cannot be forged by caller (no client INSERT policy)', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run(
          `INSERT INTO platform_audit_log (actor_user_id, action) VALUES ($1,'forged')`,
          [U.stranger],
        ),
      ).rejects.toThrow()
    })
  })
})
