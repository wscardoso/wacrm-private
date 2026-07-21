import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for P2.2 / Lote 1 — the DB
// foundation for Superadmin Workspace provisioning. These execute the
// ACTUAL SQL from migrations 037, 041 and 042 (not copies), so the
// nullable-owner invariant, the CNPJ constraints, and the
// create_platform_workspace RPC authorization/atomicity/audit logic are
// validated against a true Postgres engine.
//
// PGlite has no Supabase `auth` schema, so we stub roles + an auth.uid()
// backed by a session GUC (flipped per test), plus the minimal tenant
// model (accounts as defined by 017 + 021 columns, profiles,
// account_role_enum, is_account_member) that 037/041/042 depend on. We
// also install a minimal handle_new_user trigger mirroring 017 so the
// "signup still creates owner = NEW.id" regression can be asserted
// against nullable owner_user_id.

let db: PGlite

const SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT, raw_user_meta_data JSONB);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::UUID
$$;

CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');

-- accounts as defined by 017 + default_currency from 021 + updated_at.
-- owner_user_id starts NOT NULL here exactly as in 017; migration 041
-- (loaded below) is what relaxes it — so this test proves 041's effect.
CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  default_currency TEXT NOT NULL DEFAULT 'USD'
    CONSTRAINT accounts_default_currency_format CHECK (default_currency ~ '^[A-Z]{3}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_accounts_one_per_owner ON accounts(owner_user_id);

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
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

-- Mirror 017: accounts has RLS enabled with member-only SELECT and
-- admin-only UPDATE, and NO client INSERT policy. This proves that
-- provisioning is only possible via the SECURITY DEFINER RPC. Created
-- after is_account_member so the policy expressions resolve.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select ON accounts FOR SELECT USING (is_account_member(id));
CREATE POLICY accounts_update ON accounts FOR UPDATE
  USING (is_account_member(id, 'admin')) WITH CHECK (is_account_member(id, 'admin'));

-- Minimal mirror of 017's signup trigger, sufficient to prove the
-- "normal signup still sets owner_user_id = NEW.id + role owner"
-- regression continues to hold under nullable owner_user_id.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  INSERT INTO accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;
  INSERT INTO profiles (user_id, account_id, account_role)
  VALUES (NEW.id, v_account_id, 'owner');
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
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

// Fixed UUIDs for deterministic tests.
const U = {
  admin: '10000000-0000-0000-0000-000000000001', // Superadmin (platform admin)
  operator: '10000000-0000-0000-0000-000000000002', // non-admin platform operator
  stranger: '10000000-0000-0000-0000-000000000003', // common user, no platform role
  signup: '10000000-0000-0000-0000-000000000004', // used for signup regression
  owner: '20000000-0000-0000-0000-000000000001', // Owner for P2.3-B — Oral Unic Contagem
  digital: '20000000-0000-0000-0000-000000000002', // Owner for P2.2 — Digitall Force
}

const CNPJ_A = '44252012000189'
const CNPJ_B = '71456288000108'
const OWNER_EMAIL = 'owner@x'
const DIGITAL_EMAIL = 'digital@x'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)

  // Seed the platform actors and owner users. The trigger fires on every
  // insert — so these get personal accounts too. That's fine; the
  // provisioning tests disown and reassign them.
  await run(
    `INSERT INTO auth.users (id, email) VALUES ($1,'admin@x'),($2,'op@x'),($3,'stranger@x'),($4,'owner@x'),($5,'digital@x')`,
    [U.admin, U.operator, U.stranger, U.owner, U.digital],
  )

  // Apply migrations under test, in order.
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await db.exec(loadMigration('041_accounts_owner_nullable_and_cnpj.sql'))
  await db.exec(loadMigration('042_create_platform_workspace_rpc.sql'))
  await db.exec(loadMigration('043_workspace_provision_with_owner.sql'))

  // Bootstrap platform roles out-of-band (as 037 documents): one active
  // admin (Superadmin) and one active non-admin operator.
  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by)
     VALUES ($1,'admin',TRUE,$1),($2,'operator',TRUE,$2)`,
    [U.admin, U.operator],
  )
})

describe('P2.2 Lote 1 — schema: owner_user_id nullable + cnpj', () => {
  it('owner_user_id is nullable after 041', async () => {
    const r = await run<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'accounts' AND column_name = 'owner_user_id'`,
    )
    expect(r[0].is_nullable).toBe('YES')
  })

  it('cnpj column exists and is nullable', async () => {
    const r = await run<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_name = 'accounts' AND column_name = 'cnpj'`,
    )
    expect(r[0].is_nullable).toBe('YES')
    expect(r[0].data_type).toBe('text')
  })

  it('idx_accounts_one_per_owner is preserved', async () => {
    const r = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_indexes
       WHERE tablename = 'accounts' AND indexname = 'idx_accounts_one_per_owner'`,
    )
    expect(r[0].c).toBe(1)
  })

  it('rejects a malformed CNPJ (not 14 digits) via CHECK', async () => {
    await expect(
      run(
        `INSERT INTO accounts (name, owner_user_id, cnpj) VALUES ('bad', NULL, $1)`,
        ['123'],
      ),
    ).rejects.toThrow(/accounts_cnpj_format/i)
  })

  it('accepts a NULL cnpj and NULL owner directly at the schema level', async () => {
    const r = await run<{ id: string }>(
      `INSERT INTO accounts (name, owner_user_id, cnpj) VALUES ('schema-null', NULL, NULL) RETURNING id`,
    )
    expect(r[0].id).toBeTruthy()
    // Clean up so it doesn't interfere with later NULL-owner counts.
    await run(`DELETE FROM accounts WHERE id = $1`, [r[0].id])
  })
})

describe('P2.2 Lote 1 — create_platform_workspace authorization', () => {
  it('common user (no platform role) is rejected', async () => {
    await asUser(U.stranger, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2)`, ['Nope Inc', null]),
      ).rejects.toThrow(/admin/i)
    })
  })

  it('non-admin platform operator is rejected', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2)`, ['Nope Inc', null]),
      ).rejects.toThrow(/admin/i)
    })
  })

  it('inactive admin is rejected', async () => {
    await run(`UPDATE platform_operators SET is_active = FALSE WHERE user_id = $1`, [U.admin])
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2)`, ['Nope Inc', null]),
      ).rejects.toThrow(/admin/i)
    })
    await run(`UPDATE platform_operators SET is_active = TRUE WHERE user_id = $1`, [U.admin])
  })
})

describe('P2.2 Lote 1 — create_platform_workspace provisioning', () => {
  it('Superadmin provisions a Workspace: Owner assigned, BRL, cnpj, supervision, audit', async () => {
    let newId = ''
    await asUser(U.admin, async () => {
      const r = await run<{ create_platform_workspace: string }>(
        `SELECT create_platform_workspace($1, $2, $3) AS create_platform_workspace`,
        ['Digitall Force', CNPJ_A, DIGITAL_EMAIL],
      )
      newId = r[0].create_platform_workspace
    })
    expect(newId).toBeTruthy()

    const acc = await run<{
      owner_user_id: string | null
      default_currency: string
      cnpj: string | null
      name: string
    }>(
      `SELECT owner_user_id, default_currency, cnpj, name FROM accounts WHERE id = $1`,
      [newId],
    )
    // Owner is set — workspaces are never born orphan
    expect(acc[0].owner_user_id).toBe(U.digital)
    expect(acc[0].default_currency).toBe('BRL')
    expect(acc[0].cnpj).toBe(CNPJ_A)
    expect(acc[0].name).toBe('Digitall Force')

    // Superadmin is NOT the Owner
    expect(acc[0].owner_user_id).not.toBe(U.admin)

    // Superadmin is a SUPERVISOR (platform_operator_accounts), never owner/member.
    const assoc = await run<{ access_role: string }>(
      `SELECT access_role FROM platform_operator_accounts
       WHERE operator_user_id = $1 AND account_id = $2`,
      [U.admin, newId],
    )
    expect(assoc[0].access_role).toBe('admin')

    // Not a member: no profiles row links the admin to this account.
    const mem = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM profiles WHERE user_id = $1 AND account_id = $2`,
      [U.admin, newId],
    )
    expect(mem[0].c).toBe(0)

    // Audit row stamped with the real actor (Superadmin), not the Owner.
    const log = await run<{ actor_user_id: string; target_account_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_user_id, target_account_id, metadata FROM platform_audit_log
       WHERE action = 'create_workspace' AND target_account_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [newId],
    )
    expect(log[0].actor_user_id).toBe(U.admin)
    expect(log[0].target_account_id).toBe(newId)
    expect(log[0].metadata.default_currency).toBe('BRL')
    expect(log[0].metadata.cnpj).toBe(CNPJ_A)
    // Owner is recorded in metadata but actor is separate
    expect(log[0].metadata.owner_user_id).toBe(U.digital)
    expect(log[0].actor_user_id).not.toBe(log[0].metadata.owner_user_id)
  })

  it('provisions a CNPJ-less Workspace (cnpj NULL allowed) with Owner', async () => {
    let newId = ''
    await asUser(U.admin, async () => {
      const r = await run<{ create_platform_workspace: string }>(
        `SELECT create_platform_workspace($1, $2, $3) AS create_platform_workspace`,
        ['No CNPJ Workspace', null, DIGITAL_EMAIL],
      )
      newId = r[0].create_platform_workspace
    })
    const acc = await run<{ owner_user_id: string | null; cnpj: string | null }>(
      `SELECT owner_user_id, cnpj FROM accounts WHERE id = $1`,
      [newId],
    )
    // Owner is set even when CNPJ is omitted
    expect(acc[0].owner_user_id).toBe(U.digital)
    expect(acc[0].cnpj).toBeNull()
  })

  it('multiple Workspaces with distinct Owners coexist (idx_accounts_one_per_owner preserved)', async () => {
    await asUser(U.admin, async () => {
      await run(`SELECT create_platform_workspace($1, $2, $3)`, ['Distinct One', null, DIGITAL_EMAIL])
      await run(`SELECT create_platform_workspace($1, $2, $3)`, ['Distinct Two', null, OWNER_EMAIL])
    })
    // Both workspaces have non-NULL owner_user_id
    const r = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM accounts WHERE owner_user_id IS NOT NULL`,
    )
    expect(r[0].c).toBeGreaterThanOrEqual(2)
    // No two workspaces share the same non-NULL owner_user_id
    // (the second provisioning with DIGITAL_EMAIL disowns the first)
    const dupes = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM (
        SELECT owner_user_id FROM accounts WHERE owner_user_id IS NOT NULL
        GROUP BY owner_user_id HAVING count(*) > 1
      ) dupes`,
    )
    expect(dupes[0].c).toBe(0)
  })

  it('rejects duplicate CNPJ (partial unique index)', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['Dup CNPJ', CNPJ_A, DIGITAL_EMAIL]),
      ).rejects.toThrow(/idx_accounts_cnpj_unique|duplicate key/i)
    })
  })

  it('rejects malformed CNPJ argument before insert', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['Bad CNPJ', '12.345', DIGITAL_EMAIL]),
      ).rejects.toThrow(/CNPJ/i)
    })
  })

  it('rejects empty name', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['   ', null, DIGITAL_EMAIL]),
      ).rejects.toThrow(/name is required/i)
    })
  })
})

describe('P2.2 Lote 1 — atomicity / rollback', () => {
  it('a failing insert (duplicate CNPJ) leaves NO account, association or audit row', async () => {
    const before = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    const beforeLog = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM platform_audit_log WHERE action = 'create_workspace'`,
    )
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['Rollback Co', CNPJ_A, DIGITAL_EMAIL]),
      ).rejects.toThrow()
    })
    const after = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    const afterLog = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM platform_audit_log WHERE action = 'create_workspace'`,
    )
    expect(after[0].c).toBe(before[0].c)
    expect(afterLog[0].c).toBe(beforeLog[0].c)
    // And no account with that failed name was persisted.
    const named = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM accounts WHERE name = 'Rollback Co'`,
    )
    expect(named[0].c).toBe(0)
  })

  it('a failing owner-required guard leaves NO partial state', async () => {
    const before = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2)`, ['Orphan Attempt', null]),
      ).rejects.toThrow(/owner is required/i)
    })
    const after = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    expect(after[0].c).toBe(before[0].c)
  })
})

describe('P2.2 Lote 1 — signup regression', () => {
  it('normal signup still creates account with owner_user_id = NEW.id and role owner', async () => {
    await run(`INSERT INTO auth.users (id, email) VALUES ($1,'newsignup@x')`, [U.signup])
    const acc = await run<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM accounts WHERE owner_user_id = $1`,
      [U.signup],
    )
    expect(acc[0].owner_user_id).toBe(U.signup)
    const prof = await run<{ account_role: string }>(
      `SELECT account_role FROM profiles WHERE user_id = $1`,
      [U.signup],
    )
    expect(prof[0].account_role).toBe('owner')
  })

  it('one-account-per-owner still enforced for non-NULL owners', async () => {
    await expect(
      run(`INSERT INTO accounts (name, owner_user_id) VALUES ('dup owner', $1)`, [U.signup]),
    ).rejects.toThrow(/idx_accounts_one_per_owner|duplicate key/i)
  })
})

describe('P2.3-B — create_platform_workspace with owner', () => {
  it('provisions a Workspace with an Owner: owner_user_id set, profile created', async () => {
    let newId = ''
    await asUser(U.admin, async () => {
      const r = await run<{ create_platform_workspace: string }>(
        `SELECT create_platform_workspace($1, $2, $3) AS create_platform_workspace`,
        ['Oral Unic Contagem', CNPJ_B, OWNER_EMAIL],
      )
      newId = r[0].create_platform_workspace
    })
    expect(newId).toBeTruthy()

    // Workspace has owner_user_id set (not NULL)
    const acc = await run<{ owner_user_id: string | null; name: string; cnpj: string | null }>(
      `SELECT owner_user_id, name, cnpj FROM accounts WHERE id = $1`,
      [newId],
    )
    expect(acc[0].owner_user_id).toBe(U.owner)
    expect(acc[0].name).toBe('Oral Unic Contagem')
    expect(acc[0].cnpj).toBe(CNPJ_B)

    // Owner has a profile row for this workspace with role 'owner'
    const prof = await run<{ account_id: string; account_role: string }>(
      `SELECT account_id, account_role FROM profiles WHERE user_id = $1`,
      [U.owner],
    )
    expect(prof[0].account_id).toBe(newId)
    expect(prof[0].account_role).toBe('owner')

    // Superadmin is SUPERVISOR (platform_operator_accounts), not owner/member
    const assoc = await run<{ access_role: string }>(
      `SELECT access_role FROM platform_operator_accounts
       WHERE operator_user_id = $1 AND account_id = $2`,
      [U.admin, newId],
    )
    expect(assoc[0].access_role).toBe('admin')

    // Superadmin is NOT a member
    const mem = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM profiles WHERE user_id = $1 AND account_id = $2`,
      [U.admin, newId],
    )
    expect(mem[0].c).toBe(0)

    // Owner's OLD personal account (created by signup trigger) was disowned
    const disowned = await run<{ owner_user_id: string | null }>(
      `SELECT owner_user_id FROM accounts WHERE name = 'owner@x'`,
    )
    expect(disowned.length).toBe(1)
    expect(disowned[0].owner_user_id).toBeNull()

    // Owner's profile has account_role='owner' + account_id pointing to new workspace
    const profData = await run<{ account_id: string; full_name: string; email: string; account_role: string }>(
      `SELECT account_id, full_name, email, account_role FROM profiles WHERE user_id = $1`,
      [U.owner],
    )
    expect(profData[0].account_id).toBe(newId)
    expect(profData[0].account_role).toBe('owner')
    // full_name/email were set by the signup trigger (empty in the test schema)
    // and are preserved by the RPC's ON CONFLICT DO UPDATE
    expect(typeof profData[0].full_name).toBe('string')
    expect(typeof profData[0].email).toBe('string')

    // Audit row includes owner info
    const log = await run<{ actor_user_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_user_id, metadata FROM platform_audit_log
       WHERE action = 'create_workspace' AND target_account_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [newId],
    )
    expect(log[0].actor_user_id).toBe(U.admin)
    expect(log[0].metadata.owner_user_id).toBe(U.owner)
    expect(log[0].metadata.owner_email).toBe(OWNER_EMAIL)
  })

  it('rejects a non-existent owner email - no workspace or profile change', async () => {
    const beforeAccs = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    const beforeProf = await run<{ c: number }>(`SELECT count(*)::int AS c FROM profiles WHERE account_id IS NOT NULL`)
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['No Email', null, 'nonexistent@x']),
      ).rejects.toThrow(/No user found/i)
    })
    // No workspace was created
    const afterAccs = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    expect(afterAccs[0].c).toBe(beforeAccs[0].c)
    // No profile was moved
    const afterProf = await run<{ c: number }>(`SELECT count(*)::int AS c FROM profiles WHERE account_id IS NOT NULL`)
    expect(afterProf[0].c).toBe(beforeProf[0].c)
  })

  it('platform operator cannot create workspace with owner (rejected by auth)', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['Nope Inc', null, OWNER_EMAIL]),
      ).rejects.toThrow(/admin/i)
    })
  })

  it('owner user is NOT a platform operator after becoming workspace owner', async () => {
    const op = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM platform_operators WHERE user_id = $1`,
      [U.owner],
    )
    expect(op[0].c).toBe(0)
  })

  it('RPC rejects NULL owner email (orphan workspace prevented)', async () => {
    const before = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2)`, ['No Owner', null]),
      ).rejects.toThrow(/owner is required/i)
    })
    const after = await run<{ c: number }>(`SELECT count(*)::int AS c FROM accounts`)
    // No workspace was created — the orphan is prevented
    expect(after[0].c).toBe(before[0].c)
  })

  it('RPC rejects empty string owner email', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['Empty Email', null, '']),
      ).rejects.toThrow(/owner is required/i)
    })
  })

  it('RPC rejects whitespace-only owner email', async () => {
    await asUser(U.admin, async () => {
      await expect(
        run(`SELECT create_platform_workspace($1, $2, $3)`, ['Whitespace Email', null, '   ']),
      ).rejects.toThrow(/owner is required/i)
    })
  })

  it('Superadmin executor is NOT the Owner', async () => {
    let newId = ''
    await asUser(U.admin, async () => {
      const r = await run<{ create_platform_workspace: string }>(
        `SELECT create_platform_workspace($1, $2, $3) AS create_platform_workspace`,
        ['Actor Not Owner', null, OWNER_EMAIL],
      )
      newId = r[0].create_platform_workspace
    })
    const acc = await run<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM accounts WHERE id = $1`,
      [newId],
    )
    expect(acc[0].owner_user_id).not.toBe(U.admin)
    expect(acc[0].owner_user_id).toBe(U.owner)
  })

  it('platform_operator_accounts and profiles are independent mechanisms', async () => {
    // Owner@x has no platform_operator_accounts
    const ownersOps = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM platform_operator_accounts
       WHERE operator_user_id = $1`,
      [U.owner],
    )
    expect(ownersOps[0].c).toBe(0)

    // Superadmin has no profile in the workspace (only platform_operator_accounts)
    let newId = ''
    await asUser(U.admin, async () => {
      const r = await run<{ create_platform_workspace: string }>(
        `SELECT create_platform_workspace($1, $2, $3) AS create_platform_workspace`,
        ['Independence', null, OWNER_EMAIL],
      )
      newId = r[0].create_platform_workspace
    })
    const adminProfile = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM profiles WHERE user_id = $1 AND account_id = $2`,
      [U.admin, newId],
    )
    expect(adminProfile[0].c).toBe(0)
  })
})

describe('P2.2 Lote 1 — no direct client DML on accounts', () => {
  it('authenticated non-superuser cannot self-create a workspace bypassing the RPC', async () => {
    // accounts has RLS enabled by 017 with no client INSERT policy, so a
    // plain authenticated INSERT must be denied — provisioning is only
    // possible through the SECURITY DEFINER RPC.
    await asUser(U.stranger, async () => {
      await expect(
        run(`INSERT INTO accounts (name, owner_user_id) VALUES ('sneaky', NULL)`),
      ).rejects.toThrow()
    })
  })
})
