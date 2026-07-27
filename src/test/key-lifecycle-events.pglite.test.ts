import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for migration 057
// (key_lifecycle_events, IMP-E7-001 Phase 3 — T5/T6/T7 governance).
// Executes the ACTUAL SQL from 037 (platform admin foundation, whose
// platform_operators/is_platform_operator() this migration depends on
// for authorization) and 057 — not copies — so RLS/SECURITY
// DEFINER/RPC behavior is validated against a true Postgres engine.
// Same stub scaffolding as platform-admin-foundation.pglite.test.ts.

let db: PGlite

const SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

-- Real Supabase projects grant broad table-level SELECT/INSERT/UPDATE/
-- DELETE to anon/authenticated/service_role by default (project-level
-- bootstrap privileges, outside any individual migration) and rely on
-- RLS policies as the actual access boundary — which is why 037/055
-- declare RLS policies but no per-table GRANT statements. This stub
-- schema emulates that default so RLS (not an accidental grant gap in
-- this isolated test harness) is what determines pass/fail below.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated, service_role;

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
  admin: '10000000-0000-0000-0000-000000000001',
  operator: '10000000-0000-0000-0000-000000000002',
  stranger: '10000000-0000-0000-0000-000000000003',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await run(`INSERT INTO auth.users (id) VALUES ($1),($2),($3)`, [U.admin, U.operator, U.stranger])
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await db.exec(loadMigration('057_key_lifecycle_events.sql'))

  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'admin',TRUE,$1)`,
    [U.admin],
  )
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',TRUE,$1)`,
    [U.operator],
  )
})

describe('key_lifecycle_events — direct DML protection', () => {
  it('common user cannot INSERT into key_lifecycle_events directly', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run(
          `INSERT INTO key_lifecycle_events (kid, event_type, actor_user_id) VALUES ($1,'retired',$1)`,
          [U.stranger],
        ),
      ).rejects.toThrow()
    })
  })

  it('admin cannot UPDATE or DELETE existing rows directly (append-only)', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1, $2)`, ['ACTIVE_V1', 'seed'])
    })
    // With RLS enabled and no UPDATE/DELETE policy defined, Postgres's
    // USING clause defaults to false for those commands — the statement
    // does not error, it simply matches zero rows (unlike INSERT's
    // WITH CHECK, which does raise on a rejected row, per the test
    // above). The real assertion is that the row is provably untouched.
    await asUser(U.admin, async () => {
      await db.query(`UPDATE key_lifecycle_events SET reason = 'tampered' WHERE kid = $1`, ['ACTIVE_V1'])
      await db.query(`DELETE FROM key_lifecycle_events WHERE kid = $1`, ['ACTIVE_V1'])
    })
    const rows = await run<{ reason: string }>(
      `SELECT reason FROM key_lifecycle_events WHERE kid = $1`,
      ['ACTIVE_V1'],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].reason).toBe('seed')
  })
})

describe('declare_kid_retired — T6', () => {
  it('rejects an unauthenticated caller', async () => {
    await asUser(null, async () => {
      await expect(run(`SELECT declare_kid_retired($1)`, ['ACTIVE_V2'])).rejects.toThrow(/Unauthorized/i)
    })
  })

  it('rejects a non-admin operator', async () => {
    await asUser(U.operator, async () => {
      await expect(run(`SELECT declare_kid_retired($1)`, ['ACTIVE_V2'])).rejects.toThrow(/admin/i)
    })
  })

  it('rejects a stranger with no operator record at all', async () => {
    await asUser(U.stranger, async () => {
      await expect(run(`SELECT declare_kid_retired($1)`, ['ACTIVE_V2'])).rejects.toThrow(/admin/i)
    })
  })

  it('rejects an empty kid', async () => {
    await asUser(U.admin, async () => {
      await expect(run(`SELECT declare_kid_retired($1)`, [''])).rejects.toThrow(/kid/i)
    })
  })

  it('admin can declare a KID retired; event is persisted with the real actor', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1, $2)`, ['ACTIVE_V3', 'high-confidence convergence'])
    })
    const rows = await run<{ kid: string; event_type: string; actor_user_id: string; reason: string }>(
      `SELECT kid, event_type, actor_user_id, reason FROM key_lifecycle_events
       WHERE kid = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      ['ACTIVE_V3'],
    )
    expect(rows[0].event_type).toBe('retired')
    expect(rows[0].actor_user_id).toBe(U.admin)
    expect(rows[0].reason).toBe('high-confidence convergence')
  })

  it('caller cannot forge actor_user_id — it is always auth.uid(), never a caller argument', async () => {
    // The RPC signature accepts only (p_kid, p_reason) — there is no
    // actor parameter to forge in the first place. This test documents
    // that guarantee structurally: calling with extra/positional args
    // referencing another user is not even expressible.
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1)`, ['ACTOR_FORGE_TEST'])
    })
    const rows = await run<{ actor_user_id: string }>(
      `SELECT actor_user_id FROM key_lifecycle_events WHERE kid = $1`,
      ['ACTOR_FORGE_TEST'],
    )
    expect(rows[0].actor_user_id).toBe(U.admin)
  })
})

describe('revert_kid_retired — T7 (always reversible, no precondition)', () => {
  it('admin can revert a retired KID back to DecryptOnly at any time', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1)`, ['ACTIVE_V4'])
      await run(`SELECT revert_kid_retired($1, $2)`, ['ACTIVE_V4', 'found residual dependency'])
    })
    const rows = await run<{ event_type: string; reason: string }>(
      `SELECT event_type, reason FROM key_lifecycle_events
       WHERE kid = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      ['ACTIVE_V4'],
    )
    expect(rows[0].event_type).toBe('reverted_to_decrypt_only')
    expect(rows[0].reason).toBe('found residual dependency')
  })

  it('rejects a non-admin caller', async () => {
    await asUser(U.operator, async () => {
      await expect(run(`SELECT revert_kid_retired($1)`, ['ACTIVE_V4'])).rejects.toThrow(/admin/i)
    })
  })
})

describe('reactivate_kid — T5 (including late-rollback scenario)', () => {
  it('admin can reactivate a retired KID (ADR-E7-001 §12 late rollback)', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1)`, ['ACTIVE_V5'])
      await run(`SELECT reactivate_kid($1, $2)`, ['ACTIVE_V5', 'late rollback after Retired declaration'])
    })
    const rows = await run<{ event_type: string }>(
      `SELECT event_type FROM key_lifecycle_events
       WHERE kid = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      ['ACTIVE_V5'],
    )
    expect(rows[0].event_type).toBe('reactivated')
  })

  it('rejects a non-admin caller', async () => {
    await asUser(U.operator, async () => {
      await expect(run(`SELECT reactivate_kid($1)`, ['ACTIVE_V5'])).rejects.toThrow(/admin/i)
    })
  })

  it('full sequence T6 -> T7 -> T6 -> T5 is recorded faithfully, in order, nothing overwritten', async () => {
    const kid = 'ACTIVE_V6_SEQUENCE'
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1)`, [kid]) // T6
      await run(`SELECT revert_kid_retired($1)`, [kid]) // T7
      await run(`SELECT declare_kid_retired($1)`, [kid]) // T6 again
      await run(`SELECT reactivate_kid($1)`, [kid]) // T5
    })
    const rows = await run<{ event_type: string }>(
      `SELECT event_type FROM key_lifecycle_events WHERE kid = $1 ORDER BY created_at ASC, id ASC`,
      [kid],
    )
    expect(rows.map((r) => r.event_type)).toEqual([
      'retired',
      'reverted_to_decrypt_only',
      'retired',
      'reactivated',
    ])
  })
})

describe('key_lifecycle_events — read visibility', () => {
  it('an active platform operator can SELECT the log directly', async () => {
    await asUser(U.operator, async () => {
      const rows = await run(`SELECT * FROM key_lifecycle_events WHERE kid = $1`, ['ACTIVE_V3'])
      expect(rows.length).toBeGreaterThan(0)
    })
  })

  it('a stranger with no operator record sees no rows (RLS-filtered, not an error)', async () => {
    await asUser(U.stranger, async () => {
      const rows = await run(`SELECT * FROM key_lifecycle_events WHERE kid = $1`, ['ACTIVE_V3'])
      expect(rows.length).toBe(0)
    })
  })
})

describe('key_lifecycle_events — governance is inert with respect to the Key Ring', () => {
  it('this migration defines no function or trigger that references keyring/resolveKey/getWriteKey semantics', async () => {
    // Structural check standing in for "this table is never consulted by
    // resolveKey()/getWriteKey()" (ADR-E7-001 §8.0) — that guarantee is
    // actually enforced by keyring.ts simply never importing this module
    // (verified by inspection, not executable at the SQL layer), but we
    // can at least confirm no Postgres-side trigger/function in this
    // migration touches any table other than key_lifecycle_events itself.
    const fnDefs = await run<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc
       WHERE proname IN ('declare_kid_retired','revert_kid_retired','reactivate_kid')`,
    )
    for (const { prosrc } of fnDefs) {
      expect(prosrc).not.toMatch(/UPDATE\s+(?!key_lifecycle_events)/i)
      expect(prosrc).not.toMatch(/keyring|resolveKey|getWriteKey/i)
    }
  })
})
