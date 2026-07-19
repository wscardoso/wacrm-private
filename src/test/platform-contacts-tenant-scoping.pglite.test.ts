import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// P2.1 Lote 0.1 — explicit tenant scope on public.filter_contacts_by_tags.
//
// Reproduces, against real Postgres via PGlite, the SQL contract of the RPC
// after migration 040: an OPTIONAL p_account_id parameter that, when supplied,
// narrows the result to that tenant on top of RLS. RLS is NOT changed (the
// security boundary stays); the test loads the real migrations 025 -> 037 ->
// 038 -> 040 so the RLS model (member via is_account_member, platform operator
// via can_access_account) is exactly what production uses.
//
// The FOUNDATION/TENANT scaffolding below mirrors the 017/038 RLS model used by
// the P1b.2 realtime test, so operator multi-tenant visibility (the UNION leak)
// and member isolation behave the same way here.
//
// Contract cases covered:
//   1. operator multi-tenant, no p_account_id  -> UNION of all tenants
//      (documented as NOT appropriate for the platform path).
//   2. operator multi-tenant, p_account_id = A -> ONLY clientA contacts.
//   3. p_account_id does not exist             -> empty result.
//   4. member, no p_account_id                 -> behavior preserved (own tenant).
//   5. caller with no access                   -> empty result.
//   6. operator authorized ONLY for B, p_account_id = A -> empty (RLS blocks;
//      the explicit filter does not substitute or bypass RLS).
//   7. member of A, p_account_id = B -> empty (same: RLS blocks regardless
//      of what the caller asks the filter to narrow to).
//
// Micro-hardening pass: p_account_id was moved from the 2nd positional slot
// to the LAST slot (after p_search/p_limit/p_offset) so a positional caller
// that predates this migration keeps the exact 025 argument order. All
// calls below that pass p_account_id therefore use Postgres' named-argument
// call syntax (`param => value`) rather than position — this is also a
// closer mirror of how the production call site (PostgREST / supabase-js
// .rpc()) actually invokes the function, since PostgREST resolves .rpc()
// JSON-object bodies by parameter name, never by position.

let db: PGlite

// ---- Foundation (auth.users, roles, is_account_member) ----
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

// ---- Tenant tables + 017 SELECT policies + RLS + grants (mirrors the P1b.2
//      realtime test, extended so contacts/tags/contact_tags support the RPC) ----
const TENANT = `
CREATE TYPE platform_access_role AS ENUM ('viewer', 'agent', 'admin');

-- parent tables (own account_id)
CREATE TABLE contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL, name TEXT, phone TEXT, email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
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
CREATE TABLE contact_tags (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE);
CREATE TABLE contact_custom_values (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL);
CREATE TABLE messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL);
CREATE TABLE pipeline_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id UUID NOT NULL);
CREATE TABLE broadcast_recipients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id UUID NOT NULL);
CREATE TABLE automation_steps (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), automation_id UUID NOT NULL);
CREATE TABLE flow_nodes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), flow_id UUID NOT NULL);
CREATE TABLE flow_run_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), flow_run_id UUID NOT NULL);
CREATE TABLE message_reactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID NOT NULL);

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
  memberA: '10000000-0000-0000-0000-000000000004',
  memberB: '10000000-0000-0000-0000-000000000005',
  operator: '10000000-0000-0000-0000-000000000002',
  stranger: '10000000-0000-0000-0000-000000000003',
  // Authorized ONLY for clientB — proves the explicit p_account_id filter
  // cannot be used to reach a tenant this caller isn't authorized for.
  operatorBOnly: '10000000-0000-0000-0000-000000000006',
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
  clientB: '20000000-0000-0000-0000-0000000000a2',
  missing: '20000000-0000-0000-0000-0000000000ff',
}

// contact ids
const C = {
  a1: '60000000-0000-0000-0000-0000000000a1',
  a2: '60000000-0000-0000-0000-0000000000a2',
  b1: '60000000-0000-0000-0000-0000000000b1',
  b2: '60000000-0000-0000-0000-0000000000b2',
}
// tag ids
const T = {
  shared: '70000000-0000-0000-0000-0000000000a3',
  onlyA: '70000000-0000-0000-0000-0000000000a4',
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await db.exec(TENANT)
  await run(
    `INSERT INTO auth.users (id) VALUES ($1),($2),($3),($4),($5)`,
    [U.operator, U.stranger, U.memberA, U.memberB, U.operatorBOnly],
  )
  await run(
    `INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'A',$2),($3,'B',$4)`,
    [A.clientA, U.memberA, A.clientB, U.memberB],
  )
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
    [U.memberA, A.clientA, U.memberB, A.clientB],
  )
  // operators + stranger have no tenant membership (operators are not members)
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,NULL,NULL),($2,NULL,NULL),($3,NULL,NULL)`,
    [U.operator, U.stranger, U.operatorBOnly],
  )

  // Tags: one tag applied to contacts in BOTH tenants (shared), one to A only.
  await db.exec(`
    INSERT INTO tags (id, account_id) VALUES
      ('${T.shared}','${A.clientA}'),
      ('${T.onlyA}','${A.clientA}');
  `)

  // 2 contacts in A (one tagged shared, one tagged onlyA), 2 contacts in B (both tagged shared).
  await db.exec(`
    INSERT INTO contacts (id, account_id, name) VALUES
      ('${C.a1}','${A.clientA}','A-one'),
      ('${C.a2}','${A.clientA}','A-two'),
      ('${C.b1}','${A.clientB}','B-one'),
      ('${C.b2}','${A.clientB}','B-two');
    INSERT INTO contact_tags (contact_id, tag_id) VALUES
      ('${C.a1}','${T.shared}'),
      ('${C.a2}','${T.onlyA}'),
      ('${C.b1}','${T.shared}'),
      ('${C.b2}','${T.shared}');
  `)

  // Load real migrations under test, in order: 025 defines the RPC; 037 adds
  // platform tables + can_access_account; 038 extends SELECT policies to
  // authorized operators; 040 adds the p_account_id scope.
  await db.exec(loadMigration('025_filter_contacts_by_tags.sql'))
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await db.exec(loadMigration('038_platform_read_context.sql'))
  await db.exec(loadMigration('040_filter_contacts_by_tags_tenant_scope.sql'))

  // Bootstrap an ACTIVE operator assigned to BOTH clientA and clientB.
  await run(`INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',TRUE,$1)`, [U.operator])
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES
       ($1,$2,'viewer',$1),($1,$3,'viewer',$1)`,
    [U.operator, A.clientA, A.clientB],
  )

  // Bootstrap a SECOND active operator, authorized ONLY for clientB. Used to
  // prove that an explicit p_account_id filter cannot reach a tenant this
  // caller isn't authorized for — RLS (can_access_account) still governs.
  await run(`INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',TRUE,$1)`, [U.operatorBOnly])
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES ($1,$2,'viewer',$1)`,
    [U.operatorBOnly, A.clientB],
  )
})

// The shared tag resolves to: A-one, B-one, B-two across both tenants.
const SHARED_IDS = [C.a1, C.b1, C.b2]

describe('P2.1 Lote 0.1 — operator multi-tenant WITHOUT p_account_id (documented union)', () => {
  it('operator sees the UNION of supervised tenants (NOT appropriate for platform path)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ total_count: string }>(
        `SELECT total_count FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared]],
      )
      // UNION: A-one + B-one + B-two = 3. Selecting total_count alone
      // still expands the SRF row-per-contact, so assert the value only.
      expect(Number(r[0].total_count)).toBe(3)
    })
  })

  it('operator union contains BOTH tenant contacts (cross-tenant leak reproduced)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared]],
      )
      const ids = r.map((x) => x.id).sort()
      expect(ids).toEqual(SHARED_IDS.slice().sort())
      expect(r.some((x) => x.account_id === A.clientB)).toBe(true)
    })
  })
})

describe('P2.1 Lote 0.1 — operator multi-tenant WITH p_account_id = A', () => {
  it('returns ONLY clientA contacts (1, A-one)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientA],
      )
      expect(r.length).toBe(1)
      expect(r[0].account_id).toBe(A.clientA)
      expect(r[0].id).toBe(C.a1)
    })
  })

  it('excludes any clientB contact even though operator is authorized for B', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientA],
      )
      const ids = r.map((x) => x.id)
      expect(ids.some((id) => id === C.b1 || id === C.b2)).toBe(false)
    })
  })

  it('total_count reflects ONLY clientA matches (1)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ total_count: string }>(
        `SELECT total_count FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientA],
      )
      expect(Number(r[0].total_count)).toBe(1)
    })
  })

  it('p_account_id = B returns ONLY clientB contacts (2)', async () => {
    await asUser(U.operator, async () => {
      const ids = (await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientB],
      )).map((x) => x.id).sort()
      expect(ids).toEqual([C.b1, C.b2].sort())
      const tc = await run<{ total_count: string }>(
        `SELECT total_count FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientB],
      )
      expect(Number(tc[0].total_count)).toBe(2)
    })
  })
})

describe('P2.1 Lote 0.1 — p_account_id does not exist', () => {
  it('returns empty result (no rows)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ contact: unknown; total_count: string }>(
        `SELECT contact, total_count FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.missing],
      )
      expect(r.length).toBe(0)
    })
  })
})

describe('P2.1 Lote 0.1 — explicit filter cannot substitute RLS (micro-hardening)', () => {
  it('operator authorized ONLY for B gets EMPTY when p_account_id = A (RLS blocks, not just the filter)', async () => {
    await asUser(U.operatorBOnly, async () => {
      const r = await run<{ contact: unknown; total_count: string }>(
        `SELECT contact, total_count FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientA],
      )
      // If RLS were bypassed, can_access_account(A) would be false for this
      // caller and the row would never surface regardless of the filter —
      // this proves the explicit p_account_id argument is additive
      // narrowing on top of RLS, never a replacement for it.
      expect(r.length).toBe(0)
    })
  })

  it('operator authorized ONLY for B still reads B correctly with p_account_id = B (sanity check for the case above)', async () => {
    await asUser(U.operatorBOnly, async () => {
      const ids = (await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientB],
      )).map((x) => x.id).sort()
      expect(ids).toEqual([C.b1, C.b2].sort())
    })
  })

  it('member of clientA gets EMPTY when p_account_id = B (RLS blocks a foreign tenant, filter cannot reach it)', async () => {
    await asUser(U.memberA, async () => {
      const r = await run<{ contact: unknown; total_count: string }>(
        `SELECT contact, total_count FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientB],
      )
      // is_account_member(B) is false for memberA — can_access_account(B)
      // is false too (memberA is not an operator at all) — RLS alone
      // already zeroes this out, independent of the p_account_id value.
      expect(r.length).toBe(0)
    })
  })
})

describe('P2.1 Lote 0.1 — member WITHOUT p_account_id (behavior preserved)', () => {
  it('owner of clientA still reads only their own tenant via shared tag (1)', async () => {
    await asUser(U.memberA, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared]],
      )
      expect(r.length).toBe(1)
      expect(r[0].account_id).toBe(A.clientA)
      expect(r[0].id).toBe(C.a1)
    })
  })

  it('member sees their full tenant set across tags (2 rows)', async () => {
    await asUser(U.memberA, async () => {
      const ids = (await run<{ id: string }>(
        `SELECT (contact).id FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared, T.onlyA]],
      )).map((x) => x.id).sort()
      expect(ids).toEqual([C.a1, C.a2].sort())
      const tc = await run<{ total_count: string }>(
        `SELECT total_count FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared, T.onlyA]],
      )
      expect(Number(tc[0].total_count)).toBe(2)
    })
  })

  it('member of clientB NEVER sees clientA contacts', async () => {
    await asUser(U.memberB, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared]],
      )
      expect(r.every((x) => x.account_id === A.clientB)).toBe(true)
      expect(r.some((x) => x.id === C.a1)).toBe(false)
    })
  })
})

describe('P2.1 Lote 0.1 — caller with no access', () => {
  it('stranger (not a member, not an operator) reads nothing', async () => {
    await asUser(U.stranger, async () => {
      const r = await run<{ contact: unknown; total_count: string }>(
        `SELECT contact, total_count FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared]],
      )
      expect(r.length).toBe(0)
    })
  })

  it('anonymous role reads nothing', async () => {
    await run(`SET ROLE authenticated`)
    await run(`SELECT set_config('app.current_user', NULL, false)`)
    const r = await run<{ contact: unknown; total_count: string }>(
      `SELECT contact, total_count FROM public.filter_contacts_by_tags($1::uuid[])`,
      [[T.shared]],
    )
    await run(`RESET ROLE`)
    expect(r.length).toBe(0)
  })
})

describe('P2.1 Lote 0.1 — function contract preserved', () => {
  it('remains SECURITY INVOKER', async () => {
    const r = await run<{ prosecdef: boolean; provolatile: string }>(
      `SELECT prosecdef, provolatile FROM pg_proc WHERE proname = 'filter_contacts_by_tags'`,
    )
    expect(r[0].prosecdef).toBe(false) // false -> INVOKER, not DEFINER
    expect(r[0].provolatile).toBe('s') // STABLE
  })

  it('sets search_path = public', async () => {
    const r = await run<{ proconfig: string[] | null }>(
      `SELECT proconfig FROM pg_proc WHERE proname = 'filter_contacts_by_tags'`,
    )
    expect(r[0].proconfig).toContain('search_path=public')
  })

  it('p_account_id is optional (call with only p_tag_ids succeeds)', async () => {
    await asUser(U.memberA, async () => {
      const r = await run<{ total_count: string }>(
        `SELECT total_count FROM public.filter_contacts_by_tags($1::uuid[])`,
        [[T.shared]],
      )
      expect(Number(r[0].total_count)).toBe(1)
    })
  })
})
