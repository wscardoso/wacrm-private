import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real Postgres (in-memory PGlite) tests for the P1b platform read context
// (migration 038). These execute the ACTUAL SQL from migration 038 — not
// copies — so the RLS SELECT extensions and the audit RPCs are validated
// against a true Postgres engine.
//
// PGlite has no Supabase `auth` schema, so we stub:
//   * roles anon/authenticated/service_role (so GRANT/REVOKE succeed)
//   * an `auth` schema with a `users` table and a `uid()` function backed
//     by a session GUC we flip per test (set_current_user / clear_user).
//   * a minimal tenant model (accounts, profiles, is_account_member) that
//     037/038 depend on.
//   * the tenant-domain tables referenced by 038's SELECT policies, each
//     with the ORIGINAL 017 member-only policies, so 038's DROP+CREATE
//     finds them and extends only the SELECT grant.

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

// Tenant-domain tables + the ORIGINAL 017 member-only policies. 038 then
// extends only the SELECT policies. Keeping these minimal (just the
// columns the policies reference) is enough to validate RLS behavior.
const TENANT = `
CREATE TYPE platform_access_role AS ENUM ('viewer', 'agent', 'admin');

-- parent tables (own account_id)
CREATE TABLE contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE tags (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE custom_fields (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE contact_notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE message_templates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE pipelines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE deals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE broadcasts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE automations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE automation_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE flows (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE flow_runs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE lead_attributions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);

-- child tables (FK to a parent)
CREATE TABLE contact_tags (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL);
CREATE TABLE contact_custom_values (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL);
CREATE TABLE messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL);
CREATE TABLE pipeline_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id UUID NOT NULL);
CREATE TABLE broadcast_recipients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id UUID NOT NULL);
CREATE TABLE automation_steps (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), automation_id UUID NOT NULL);
CREATE TABLE flow_nodes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), flow_id UUID NOT NULL);
CREATE TABLE flow_run_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), flow_run_id UUID NOT NULL);
CREATE TABLE message_reactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID NOT NULL);

-- whatsapp_config (SECRETS): deliberately excluded from 038's read grant.
CREATE TABLE whatsapp_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  access_token TEXT,
  phone_number_id TEXT
);

-- original 017 member-only SELECT policies (so 038 can extend them)
CREATE POLICY accounts_select ON accounts FOR SELECT USING (is_account_member(id));
CREATE POLICY contacts_select ON contacts FOR SELECT USING (is_account_member(account_id));
CREATE POLICY tags_select ON tags FOR SELECT USING (is_account_member(account_id));
CREATE POLICY custom_fields_select ON custom_fields FOR SELECT USING (is_account_member(account_id));
CREATE POLICY contact_notes_select ON contact_notes FOR SELECT USING (is_account_member(account_id));
CREATE POLICY conversations_select ON conversations FOR SELECT USING (is_account_member(account_id));
CREATE POLICY message_templates_select ON message_templates FOR SELECT USING (is_account_member(account_id));
CREATE POLICY pipelines_select ON pipelines FOR SELECT USING (is_account_member(account_id));
CREATE POLICY deals_select ON deals FOR SELECT USING (is_account_member(account_id));
CREATE POLICY broadcasts_select ON broadcasts FOR SELECT USING (is_account_member(account_id));
CREATE POLICY automations_select ON automations FOR SELECT USING (is_account_member(account_id));
CREATE POLICY automation_logs_select ON automation_logs FOR SELECT USING (is_account_member(account_id));
CREATE POLICY flows_select ON flows FOR SELECT USING (is_account_member(account_id));
CREATE POLICY flow_runs_select ON flow_runs FOR SELECT USING (is_account_member(account_id));
CREATE POLICY lead_attributions_select ON lead_attributions FOR SELECT USING (is_account_member(account_id));
CREATE POLICY whatsapp_config_select ON whatsapp_config FOR SELECT USING (is_account_member(account_id));

CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id)));
CREATE POLICY contact_custom_values_select ON contact_custom_values FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_custom_values.contact_id AND is_account_member(c.account_id)));
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_account_member(c.account_id)));
CREATE POLICY pipeline_stages_select ON pipeline_stages FOR SELECT USING (
  EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id AND is_account_member(p.account_id)));
CREATE POLICY broadcast_recipients_select ON broadcast_recipients FOR SELECT USING (
  EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND is_account_member(b.account_id)));
CREATE POLICY automation_steps_select ON automation_steps FOR SELECT USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id)));
CREATE POLICY flow_nodes_select ON flow_nodes FOR SELECT USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id)));
CREATE POLICY flow_run_events_select ON flow_run_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = flow_run_events.flow_run_id AND is_account_member(r.account_id)));
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = message_reactions.message_id AND is_account_member(c.account_id)));

-- write policies (member-only) — 038 must NOT touch these
CREATE POLICY conversations_insert ON conversations FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY conversations_update ON conversations FOR UPDATE USING (is_account_member(account_id, 'agent'));
CREATE POLICY conversations_delete ON conversations FOR DELETE USING (is_account_member(account_id, 'agent'));
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_account_member(c.account_id, 'agent')));

-- enable RLS on everything
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_config ENABLE ROW LEVEL SECURITY;

-- Supabase auto-grants SELECT to authenticated/anon on new tables; PGlite
-- does not, so grant here. This covers only the tenant tables created
-- above (037's platform tables are created later and stay ungranted, as
-- intended). RLS still gates every row.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
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
  memberA: '10000000-0000-0000-0000-000000000004',
  memberB: '10000000-0000-0000-0000-000000000005',
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
  clientB: '20000000-0000-0000-0000-0000000000a2',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await db.exec(TENANT)
  await run(
    `INSERT INTO auth.users (id) VALUES ($1),($2),($3),($4),($5)`,
    [U.admin, U.operator, U.stranger, U.memberA, U.memberB],
  )
  await run(
    `INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'A',$2),($3,'B',$4)`,
    [A.clientA, U.memberA, A.clientB, U.memberB],
  )
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
    [U.memberA, A.clientA, U.memberB, A.clientB],
  )
  // operator + stranger have no tenant membership (profiles without account)
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,NULL,NULL),($2,NULL,NULL)`,
    [U.operator, U.stranger],
  )
  await run(
    `INSERT INTO conversations (id, account_id) VALUES ($1,$2),($3,$4)`,
    ['30000000-0000-0000-0000-0000000000b1', A.clientA, '30000000-0000-0000-0000-0000000000b2', A.clientB],
  )
  await run(
    `INSERT INTO messages (id, conversation_id) VALUES ($1,$2)`,
    ['40000000-0000-0000-0000-0000000000c1', '30000000-0000-0000-0000-0000000000b1'],
  )
  await run(
    `INSERT INTO whatsapp_config (id, account_id, access_token) VALUES ($1,$2,'SECRET')`,
    ['50000000-0000-0000-0000-0000000000d1', A.clientA],
  )

  // Load real migrations under test, in order.
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await db.exec(loadMigration('038_platform_read_context.sql'))

  // Bootstrap an active operator assigned to clientA only.
  await run(`INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',TRUE,$1)`, [U.operator])
  await run(`INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES ($1,$2,'viewer',$1)`, [U.operator, A.clientA])
})

describe('P1b — SELECT extended for authorized operator', () => {
  it('operator assigned to clientA can SELECT conversations of clientA', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations WHERE account_id = $1', [A.clientA])
      expect(r.length).toBe(1)
      expect(r[0].id).toBe('30000000-0000-0000-0000-0000000000b1')
    })
  })

  it('operator can SELECT messages of clientA (child-table join policy)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>('SELECT id FROM messages')
      expect(r.length).toBe(1)
      expect(r[0].id).toBe('40000000-0000-0000-0000-0000000000c1')
    })
  })

  it('operator assigned to clientA CANNOT SELECT conversations of clientB', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations WHERE account_id = $1', [A.clientB])
      expect(r.length).toBe(0)
    })
  })
})

describe('P1b — URL selector is not authorization', () => {
  it('stranger (not an operator) reads nothing from any tenant', async () => {
    await asUser(U.stranger, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations')
      expect(r.length).toBe(0)
    })
  })

  it('operator NOT assigned to clientB reads nothing there (forged URL = empty)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations WHERE account_id = $1', [A.clientB])
      expect(r.length).toBe(0)
      const aOnly = await run<{ id: string }>('SELECT id FROM conversations')
      expect(aOnly.length).toBe(1)
    })
  })
})

describe('P1b — WRITE remains member-only (no cross-tenant mutation)', () => {
  it('operator cannot INSERT into conversations of clientA', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`INSERT INTO conversations (id, account_id) VALUES ($1,$2)`, ['39999999-0000-0000-0000-0000000000e1', A.clientA]),
      ).rejects.toThrow()
    })
  })

  it('operator cannot UPDATE conversations of clientA', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`UPDATE conversations SET account_id = $1 WHERE id = $2`, [A.clientA, '30000000-0000-0000-0000-0000000000b1']),
      ).rejects.toThrow()
    })
  })

  it('operator cannot DELETE conversations of clientA', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`DELETE FROM conversations WHERE id = $1`, ['30000000-0000-0000-0000-0000000000b1']),
      ).rejects.toThrow()
    })
  })
})

describe('P1b — member behavior unchanged (regression)', () => {
  it('owner of clientA still reads their own conversations', async () => {
    await asUser(U.memberA, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations WHERE account_id = $1', [A.clientA])
      expect(r.length).toBe(1)
    })
  })

  it('owner of clientA cannot read clientB (no leakage)', async () => {
    await asUser(U.memberA, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations WHERE account_id = $1', [A.clientB])
      expect(r.length).toBe(0)
    })
  })
})

describe('P1b — SECRETS: whatsapp_config excluded from operator read', () => {
  it('operator assigned to clientA CANNOT read whatsapp_config (holds secrets)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>('SELECT id FROM whatsapp_config')
      expect(r.length).toBe(0)
    })
  })
})

describe('P1b — revocation blocks access on next request', () => {
  it('deactivating operator loses SELECT access immediately', async () => {
    await run('UPDATE platform_operators SET is_active = FALSE WHERE user_id = $1', [U.operator])
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations')
      expect(r.length).toBe(0)
    })
    // restore for subsequent tests
    await run('UPDATE platform_operators SET is_active = TRUE WHERE user_id = $1', [U.operator])
  })

  it('unassigning operator from clientA blocks access on next request', async () => {
    await run('DELETE FROM platform_operator_accounts WHERE operator_user_id = $1 AND account_id = $2', [U.operator, A.clientA])
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations')
      expect(r.length).toBe(0)
    })
    // restore
    await run(`INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES ($1,$2,'viewer',$1)`, [U.operator, A.clientA])
  })
})

describe('P1b — audit RPCs (actor always = auth.uid())', () => {
  it('context_entered logs the REAL actor, not a forged one', async () => {
    await asUser(U.operator, async () => {
      await run('SELECT log_platform_context_entered($1)', [A.clientA])
    })
    const log = await run<{ actor_user_id: string; target_account_id: string; action: string }>(
      `SELECT actor_user_id, target_account_id, action FROM platform_audit_log
       WHERE action = 'context_entered' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(log[0].actor_user_id).toBe(U.operator)
    expect(log[0].target_account_id).toBe(A.clientA)
  })

  it('context_access_denied logs for an unauthorized operator attempt', async () => {
    // U.stranger is not an operator at all; simulate a denied URL hit.
    await asUser(U.stranger, async () => {
      await run('SELECT log_platform_context_denied($1)', [A.clientA])
    })
    const log = await run<{ actor_user_id: string; action: string }>(
      `SELECT actor_user_id, action FROM platform_audit_log
       WHERE action = 'context_access_denied' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(log[0].actor_user_id).toBe(U.stranger)
  })

  it('audit log cannot be forged with an arbitrary actor by a caller', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`INSERT INTO platform_audit_log (actor_user_id, target_account_id, action) VALUES ($1,$2,'forged')`, [U.stranger, A.clientA]),
      ).rejects.toThrow()
    })
  })
})
