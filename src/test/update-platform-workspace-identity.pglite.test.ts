import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (PGlite) tests for E5b — update_platform_workspace_identity
// (migration 054). Loads the ACTUAL SQL from 037 (platform foundation),
// 041 (cnpj), 053 (E5a identity columns) and 054 (the RPC under test), so
// the tenant-scoped authorization (is_platform_operator_for), the shared
// CHECK constraints, the partial-update semantics, and the audit write are
// all validated against a true Postgres engine — same style as
// create-platform-workspace.pglite.test.ts and
// accounts-commercial-identity.pglite.test.ts.

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
  target_account_id UUID, min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid() AND p.account_id = target_account_id
      AND CASE p.account_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
       >= CASE min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'agent' THEN 2 WHEN 'viewer' THEN 1 END
  );
$$;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select ON accounts FOR SELECT USING (is_account_member(id));
CREATE POLICY accounts_update ON accounts FOR UPDATE
  USING (is_account_member(id, 'admin')) WITH CHECK (is_account_member(id, 'admin'));

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
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

async function callUpdate(accountId: string, updates: Record<string, unknown>) {
  const r = await run<{ result: unknown }>(
    `SELECT update_platform_workspace_identity($1, $2::jsonb) AS result`,
    [accountId, JSON.stringify(updates)],
  )
  return r[0].result as Record<string, unknown>
}

const U = {
  // Active platform operator, admin for accountA only.
  opA: '10000000-0000-0000-0000-000000000001',
  // Active platform operator, admin for accountB only (wrong-tenant case).
  opB: '10000000-0000-0000-0000-000000000002',
  // Active platform operator, viewer for accountA (scope OK, action denied).
  opViewer: '10000000-0000-0000-0000-000000000004',
  // Common authenticated user, never granted platform_operators row.
  stranger: '10000000-0000-0000-0000-000000000003',
}

let accountA: string
let accountB: string

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await db.exec(loadMigration('041_accounts_owner_nullable_and_cnpj.sql'))
  await db.exec(loadMigration('053_accounts_commercial_identity.sql'))
  await db.exec(loadMigration('054_platform_workspace_identity_update.sql'))

  await run(
    `INSERT INTO auth.users (id, email) VALUES ($1,'opa@x'),($2,'opb@x'),($3,'stranger@x'),($4,'opviewer@x')`,
    [U.opA, U.opB, U.stranger, U.opViewer],
  )

  const a = await run<{ id: string }>(`INSERT INTO accounts (name) VALUES ('Tenant A') RETURNING id`)
  accountA = a[0].id
  const b = await run<{ id: string }>(`INSERT INTO accounts (name) VALUES ('Tenant B') RETURNING id`)
  accountB = b[0].id

  await run(
    `INSERT INTO platform_operators (user_id, role, is_active, created_by)
     VALUES ($1,'operator',TRUE,$1),($2,'operator',TRUE,$2),($3,'operator',TRUE,$3)`,
    [U.opA, U.opB, U.opViewer],
  )
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by)
     VALUES ($1,$2,'admin',$1),($3,$4,'admin',$3),($5,$2,'viewer',$5)`,
    [U.opA, accountA, U.opB, accountB, U.opViewer],
  )
})

describe('054 — authorization matrix (§8.2, §12)', () => {
  it('operator admin writes + audits', async () => {
    const row = await asUser(U.opA, () => callUpdate(accountA, { legal_name: 'Acme Ltda' }))
    expect(row.legal_name).toBe('Acme Ltda')

    const audit = await run<{ action: string; target_account_id: string; actor_user_id: string }>(
      `SELECT action, target_account_id, actor_user_id FROM platform_audit_log
       WHERE target_account_id = $1 AND action = 'update_workspace_identity'`,
      [accountA],
    )
    expect(audit.length).toBe(1)
    expect(audit[0].actor_user_id).toBe(U.opA)
  })

  it('operator viewer (scope OK, action denied) gets 42501', async () => {
    await expect(
      asUser(U.opViewer, () => callUpdate(accountA, { legal_name: 'Hacked' })),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('operator NOT authorized for this tenant (wrong tenant) gets 42501', async () => {
    await expect(
      asUser(U.opB, () => callUpdate(accountA, { legal_name: 'Hacked' })),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('authenticated user with no platform_operators row gets 42501', async () => {
    await expect(
      asUser(U.stranger, () => callUpdate(accountA, { legal_name: 'Hacked' })),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('anonymous (no auth.uid()) gets 42501', async () => {
    await expect(
      asUser(null, () => callUpdate(accountA, { legal_name: 'Hacked' })),
    ).rejects.toMatchObject({ code: '42501' })
  })
})

describe('054 — partial update semantics (§7.5) via the platform RPC', () => {
  it('omitted key leaves other columns unchanged; explicit null clears', async () => {
    await asUser(U.opA, () =>
      callUpdate(accountA, {
        legal_name: 'Baseline Co',
        commercial_phone: '+55 11 90000-0000',
        commercial_email: 'base@co.com',
      }),
    )
    // Touch only commercial_phone.
    const afterPhoneOnly = await asUser(U.opA, () =>
      callUpdate(accountA, { commercial_phone: '+55 11 99999-9999' }),
    )
    expect(afterPhoneOnly.legal_name).toBe('Baseline Co')
    expect(afterPhoneOnly.commercial_email).toBe('base@co.com')
    expect(afterPhoneOnly.commercial_phone).toBe('+55 11 99999-9999')

    // Explicit null clears commercial_email without touching the rest.
    const afterClear = await asUser(U.opA, () => callUpdate(accountA, { commercial_email: null }))
    expect(afterClear.commercial_email).toBe(null)
    expect(afterClear.legal_name).toBe('Baseline Co')
    expect(afterClear.commercial_phone).toBe('+55 11 99999-9999')
  })
})

describe('054 — validation (§7, mirrors 042/043 structural checks)', () => {
  it('rejects empty/null name with 22023', async () => {
    await expect(
      asUser(U.opA, () => callUpdate(accountA, { name: '' })),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('rejects malformed CNPJ with 22023', async () => {
    await expect(
      asUser(U.opA, () => callUpdate(accountA, { cnpj: '123' })),
    ).rejects.toMatchObject({ code: '22023' })
  })

  it('valid CNPJ persists; colliding CNPJ correction rejected by unique index', async () => {
    const row = await asUser(U.opA, () => callUpdate(accountA, { cnpj: '11222333000181' }))
    expect(row.cnpj).toBe('11222333000181')

    await asUser(U.opB, () => callUpdate(accountB, { cnpj: '99888777000199' }))
    await expect(
      asUser(U.opB, () => callUpdate(accountB, { cnpj: '11222333000181' })),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('garbage commercial_phone rejected by the shared CHECK (053) as 23514', async () => {
    await expect(
      asUser(U.opA, () => callUpdate(accountA, { commercial_phone: 'abc' })),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects an update with no recognized fields', async () => {
    await expect(
      asUser(U.opA, () => callUpdate(accountA, { unknown_field: 'x' })),
    ).rejects.toMatchObject({ code: '22023' })
  })
})
