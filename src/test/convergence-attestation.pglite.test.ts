import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for migration 058
// (convergence_attestations / inventory_versions / T8, IMP-E7-001
// Phase 5 — the ONE irreversible transition in the whole contract).
// Executes the ACTUAL SQL from 037, 057 and 058 — not copies — so the
// structural safeguard of ADR-E7-001 §13.3 is validated against a true
// Postgres engine, not just asserted in prose or in a mocked unit test.
//
// This file exists specifically to prove the bug found and fixed during
// this Sprint's audit does not regress: validate_kid_destroyable() must
// check the KID's MOST RECENT lifecycle event, not merely "a retired
// event exists somewhere in history" — a KID retired then reverted (T7)
// must NOT be destroyable, even though a 'retired' row still exists.

let db: PGlite

const SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
  await db.exec(loadMigration('058_convergence_attestation.sql'))

  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'admin',TRUE,$1)`,
    [U.admin],
  )
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',TRUE,$1)`,
    [U.operator],
  )
})

// ─── Direct DML protection (immutability, §13.3 property 4) ──────────────

describe('convergence_attestations / inventory_versions — direct DML protection', () => {
  it('common user cannot INSERT into convergence_attestations directly', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run(
          `INSERT INTO convergence_attestations (kid, inventory_version, issued_by) VALUES ('X', 1, $1)`,
          [U.stranger],
        ),
      ).rejects.toThrow()
    })
  })

  it('admin cannot UPDATE or DELETE an existing attestation directly (immutability)', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT issue_convergence_attestation($1, $2)`, ['DML_TEST_KID', 1])
    })
    await asUser(U.admin, async () => {
      await db.query(`UPDATE convergence_attestations SET inventory_version = 999 WHERE kid = $1`, ['DML_TEST_KID'])
      await db.query(`DELETE FROM convergence_attestations WHERE kid = $1`, ['DML_TEST_KID'])
    })
    const rows = await run<{ inventory_version: number }>(
      `SELECT inventory_version FROM convergence_attestations WHERE kid = $1`,
      ['DML_TEST_KID'],
    )
    expect(rows.length).toBe(1)
    expect(rows[0].inventory_version).toBe(1)
  })

  it('common user cannot UPDATE inventory_versions directly (no raw UPDATE policy — Achado 3 fix)', async () => {
    await asUser(U.operator, async () => {
      await db.query(`UPDATE inventory_versions SET version = 999 WHERE id = 1`)
    })
    const rows = await run<{ version: number }>(`SELECT version FROM inventory_versions WHERE id = 1`)
    expect(rows[0].version).toBe(1)
  })
})

// ─── issue_convergence_attestation — §13.3 property 2 (vínculo a KID + versão) ──

describe('issue_convergence_attestation', () => {
  it('rejects a non-admin caller', async () => {
    await asUser(U.operator, async () => {
      await expect(run(`SELECT issue_convergence_attestation($1, $2)`, ['KID_A', 1])).rejects.toThrow(/admin/i)
    })
  })

  it('rejects an inventory_version below 1 — "sem vínculo a versão do Inventário" is structurally impossible', async () => {
    await asUser(U.admin, async () => {
      await expect(run(`SELECT issue_convergence_attestation($1, $2)`, ['KID_B', 0])).rejects.toThrow(/inventory_version/i)
    })
  })

  it('rejects a NULL inventory_version', async () => {
    await asUser(U.admin, async () => {
      await expect(run(`SELECT issue_convergence_attestation($1, NULL)`, ['KID_C'])).rejects.toThrow(/inventory_version/i)
    })
  })

  it('admin can issue an attestation linked to the current inventory version', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT issue_convergence_attestation($1, $2)`, ['KID_ISSUE_OK', 1])
    })
    const rows = await run<{ kid: string; inventory_version: number; issued_by: string }>(
      `SELECT kid, inventory_version, issued_by FROM convergence_attestations WHERE kid = $1`,
      ['KID_ISSUE_OK'],
    )
    expect(rows[0].inventory_version).toBe(1)
    expect(rows[0].issued_by).toBe(U.admin)
  })

  it('rejects issuing a second attestation for the same KID (immutability — UNIQUE(kid))', async () => {
    await asUser(U.admin, async () => {
      await expect(run(`SELECT issue_convergence_attestation($1, $2)`, ['KID_ISSUE_OK', 1])).rejects.toThrow(/already exists/i)
    })
  })
})

// ─── bump_inventory_version — closes Achado 3 (privilege gap) ────────────

describe('bump_inventory_version', () => {
  it('rejects a non-admin caller', async () => {
    await asUser(U.operator, async () => {
      await expect(run(`SELECT bump_inventory_version($1)`, [2])).rejects.toThrow(/admin/i)
    })
  })

  it('rejects a version that is not exactly current + 1', async () => {
    await asUser(U.admin, async () => {
      await expect(run(`SELECT bump_inventory_version($1)`, [5])).rejects.toThrow(/exactly 1/i)
    })
  })

  it('admin can bump the version by exactly 1, and updated_by is auth.uid(), never forgeable', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT bump_inventory_version($1)`, [2])
    })
    const rows = await run<{ version: number; updated_by: string }>(`SELECT version, updated_by FROM inventory_versions WHERE id = 1`)
    expect(rows[0].version).toBe(2)
    expect(rows[0].updated_by).toBe(U.admin)
  })
})

// ─── validate_kid_destroyable — authorization gate (Gate finding, closed) ─
//
// This function only reads state (it changes nothing), so its bar is
// "active platform operator" — the same bar as the SELECT policies on
// convergence_attestations and key_lifecycle_events, not the higher
// "admin" bar used by issue_convergence_attestation/destroy_kid, which
// actually mutate state.

describe('validate_kid_destroyable — authorization', () => {
  it('rejects a caller with no platform_operators row at all', async () => {
    await asUser(U.stranger, async () => {
      await expect(run(`SELECT validate_kid_destroyable($1)`, ['ANY_KID'])).rejects.toThrow(/42501|operator/i)
    })
  })

  it('rejects a caller whose platform_operators row is inactive', async () => {
    const inactiveUser = '10000000-0000-0000-0000-000000000004'
    await run(`INSERT INTO auth.users (id) VALUES ($1)`, [inactiveUser])
    await run(
      `INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',FALSE,$2)`,
      [inactiveUser, U.admin],
    )
    await asUser(inactiveUser, async () => {
      await expect(run(`SELECT validate_kid_destroyable($1)`, ['ANY_KID'])).rejects.toThrow(/42501|operator/i)
    })
  })

  it('allows an active (non-admin) operator to call it — this is a read-only pre-flight check', async () => {
    await asUser(U.operator, async () => {
      const rows = await run<{ validate_kid_destroyable: { valid: boolean } }>(
        `SELECT validate_kid_destroyable($1)`,
        ['NEVER_ATTESTED_OPERATOR_CHECK'],
      )
      expect(rows[0].validate_kid_destroyable.valid).toBe(false)
    })
  })
})

// ─── THE CRITICAL SCENARIOS — user-mandated, no exceptions ───────────────

describe('validate_kid_destroyable / destroy_kid — CRITICAL SCENARIO 1: destroy attempt without Attestation is refused', () => {
  it('validate_kid_destroyable reports invalid with the real reason when no attestation exists', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1)`, ['NEVER_ATTESTED'])
    })
    let rows: Array<{ validate_kid_destroyable: { valid: boolean; reason: string } }> = []
    await asUser(U.admin, async () => {
      rows = await run(`SELECT validate_kid_destroyable($1)`, ['NEVER_ATTESTED'])
    })
    const result = rows[0].validate_kid_destroyable
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/No convergence attestation found/i)
  })

  it('destroy_kid is refused, structurally, when no attestation exists — not merely discouraged', async () => {
    await asUser(U.admin, async () => {
      await expect(run(`SELECT destroy_kid($1)`, ['NEVER_ATTESTED'])).rejects.toThrow(/No convergence attestation found/i)
    })
    // Confirm no 'destroyed' event was recorded despite the attempt.
    const events = await run<{ event_type: string }>(
      `SELECT event_type FROM key_lifecycle_events WHERE kid = $1 AND event_type = 'destroyed'`,
      ['NEVER_ATTESTED'],
    )
    expect(events.length).toBe(0)
  })
})

describe('validate_kid_destroyable / destroy_kid — CRITICAL SCENARIO 2: Attestation without a valid Inventory-version link is rejected', () => {
  it('an attestation whose inventory_version no longer matches the current one is rejected as invalid (stale)', async () => {
    const kid = 'STALE_VERSION_KID'
    await asUser(U.admin, async () => {
      // Attestation issued against version 2 (current at the time).
      await run(`SELECT issue_convergence_attestation($1, $2)`, [kid, 2])
      await run(`SELECT declare_kid_retired($1)`, [kid])
      // Inventory grows afterward (new épico declares a new surface, §13.1).
      await run(`SELECT bump_inventory_version($1)`, [3])
    })

    let rows: Array<{ validate_kid_destroyable: { valid: boolean; reason: string } }> = []
    await asUser(U.admin, async () => {
      rows = await run(`SELECT validate_kid_destroyable($1)`, [kid])
    })
    const result = rows[0].validate_kid_destroyable
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/inventory version 2.*current inventory version is 3/i)

    await asUser(U.admin, async () => {
      await expect(run(`SELECT destroy_kid($1)`, [kid])).rejects.toThrow(/Re-issue the attestation/i)
    })
  })

  it('re-issuing against the now-current version makes the KID destroyable again', async () => {
    // continues from the previous test — version is now 3

    // The old attestation is immutable and cannot be overwritten in place —
    // re-issuing for a truly stale KID in production would require the
    // Fase-5-external governance process to remove/replace the row via a
    // deliberate administrative action, not this RPC (immutability is by
    // design, §13.3 property 4). This test simulates that by using a fresh
    // KID whose attestation is issued directly against the current version,
    // proving the "current version" path succeeds end-to-end.
    const freshKid = 'CURRENT_VERSION_KID'
    await asUser(U.admin, async () => {
      await run(`SELECT issue_convergence_attestation($1, $2)`, [freshKid, 3])
      await run(`SELECT declare_kid_retired($1)`, [freshKid])
    })
    let rows: Array<{ validate_kid_destroyable: { valid: boolean } }> = []
    await asUser(U.admin, async () => {
      rows = await run(`SELECT validate_kid_destroyable($1)`, [freshKid])
    })
    expect(rows[0].validate_kid_destroyable.valid).toBe(true)
  })
})

describe('validate_kid_destroyable — regression test for the audit fix: retired-then-reverted (T7) must NOT be destroyable', () => {
  it('a KID retired (T6) and then reverted to DecryptOnly (T7) is correctly reported as not destroyable, even though a retired row exists in its history', async () => {
    const kid = 'RETIRED_THEN_REVERTED'
    await asUser(U.admin, async () => {
      await run(`SELECT issue_convergence_attestation($1, $2)`, [kid, 3])
      await run(`SELECT declare_kid_retired($1)`, [kid]) // T6
      await run(`SELECT revert_kid_retired($1)`, [kid]) // T7 — un-retires it
    })

    let rows: Array<{ validate_kid_destroyable: { valid: boolean; reason: string } }> = []
    await asUser(U.admin, async () => {
      rows = await run(`SELECT validate_kid_destroyable($1)`, [kid])
    })
    const result = rows[0].validate_kid_destroyable
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/most recent lifecycle event is not Retired/i)

    await asUser(U.admin, async () => {
      await expect(run(`SELECT destroy_kid($1)`, [kid])).rejects.toThrow(/most recent lifecycle event is not Retired/i)
    })
  })

  it('re-declaring Retired after the reversal makes it destroyable again (T6 -> T7 -> T6)', async () => {
    const kid = 'RETIRED_THEN_REVERTED' // continues from the previous test
    await asUser(U.admin, async () => {
      await run(`SELECT declare_kid_retired($1)`, [kid]) // T6 again
    })
    let rows: Array<{ validate_kid_destroyable: { valid: boolean } }> = []
    await asUser(U.admin, async () => {
      rows = await run(`SELECT validate_kid_destroyable($1)`, [kid])
    })
    expect(rows[0].validate_kid_destroyable.valid).toBe(true)
  })

  it('a KID retired (T6) and then reactivated to Active (T5) is also correctly reported as not destroyable', async () => {
    const kid = 'RETIRED_THEN_REACTIVATED'
    await asUser(U.admin, async () => {
      await run(`SELECT issue_convergence_attestation($1, $2)`, [kid, 3])
      await run(`SELECT declare_kid_retired($1)`, [kid]) // T6
      await run(`SELECT reactivate_kid($1)`, [kid]) // T5 — back to Active
    })
    let rows: Array<{ validate_kid_destroyable: { valid: boolean; reason: string } }> = []
    await asUser(U.admin, async () => {
      rows = await run(`SELECT validate_kid_destroyable($1)`, [kid])
    })
    expect(rows[0].validate_kid_destroyable.valid).toBe(false)
    expect(rows[0].validate_kid_destroyable.reason).toMatch(/most recent lifecycle event is not Retired/i)
  })
})

describe('destroy_kid — CRITICAL SCENARIO 3: destroying one KID does not affect any other', () => {
  it('destroying KID A leaves KID B\'s attestation, retired state, and validation result completely untouched', async () => {
    const kidA = 'ISOLATION_KID_A'
    const kidB = 'ISOLATION_KID_B'

    await asUser(U.admin, async () => {
      await run(`SELECT issue_convergence_attestation($1, $2)`, [kidA, 3])
      await run(`SELECT declare_kid_retired($1)`, [kidA])
      await run(`SELECT issue_convergence_attestation($1, $2)`, [kidB, 3])
      await run(`SELECT declare_kid_retired($1)`, [kidB])
    })

    let beforeB: Array<{ validate_kid_destroyable: { valid: boolean } }> = []
    await asUser(U.admin, async () => {
      beforeB = await run(`SELECT validate_kid_destroyable($1)`, [kidB])
    })
    expect(beforeB[0].validate_kid_destroyable.valid).toBe(true)

    await asUser(U.admin, async () => {
      await run(`SELECT destroy_kid($1, $2)`, [kidA, 'test destruction'])
    })

    // KID A: destroyed event recorded, attestation still present (immutable audit trail).
    const aEvents = await run<{ event_type: string }>(
      `SELECT event_type FROM key_lifecycle_events WHERE kid = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [kidA],
    )
    expect(aEvents[0].event_type).toBe('destroyed')
    const aAttestation = await run<{ kid: string }>(`SELECT kid FROM convergence_attestations WHERE kid = $1`, [kidA])
    expect(aAttestation.length).toBe(1)

    // KID B: completely unaffected — same attestation, same retired state,
    // same validation result, no destroyed event.
    const bAttestation = await run<{ inventory_version: number }>(
      `SELECT inventory_version FROM convergence_attestations WHERE kid = $1`,
      [kidB],
    )
    expect(bAttestation[0].inventory_version).toBe(3)

    const bEvents = await run<{ event_type: string }>(
      `SELECT event_type FROM key_lifecycle_events WHERE kid = $1 AND event_type = 'destroyed'`,
      [kidB],
    )
    expect(bEvents.length).toBe(0)

    let afterB: Array<{ validate_kid_destroyable: { valid: boolean } }> = []
    await asUser(U.admin, async () => {
      afterB = await run(`SELECT validate_kid_destroyable($1)`, [kidB])
    })
    expect(afterB[0].validate_kid_destroyable.valid).toBe(true)
  })

  it('rejects a non-admin caller attempting destroy_kid', async () => {
    await asUser(U.operator, async () => {
      await expect(run(`SELECT destroy_kid($1)`, ['ISOLATION_KID_B'])).rejects.toThrow(/admin/i)
    })
  })

  it('T11 remains structurally impossible: DecryptOnly -> Destroyed with no attestation and no Retired declaration is refused', async () => {
    await asUser(U.admin, async () => {
      await expect(run(`SELECT destroy_kid($1)`, ['NEVER_RETIRED_NEVER_ATTESTED'])).rejects.toThrow(
        /No convergence attestation found/i,
      )
    })
  })
})
