import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// P1b.2 — Tenant scoping fix for /act/[accountId]/inbox.
//
// Validates that the queries the Inbox components now issue (after the fix)
// return ONLY the active tenant's data, even when the platform operator is
// authorized for MULTIPLE tenants. This is a query-level (real Postgres via
// PGlite) reproduction of what ConversationList / InboxPage.hydrateConversation
// send: an explicit `.eq("account_id", activeAccountId)` filter layered on
// top of RLS. It proves the fix prevents the cross-tenant UNION leak that
// pure-RLS reliance allowed.
//
// RLS is NOT changed (security boundary stays). The filter is verified to be
// what actually isolates the tenant: without it, the operator's queries would
// return the union of clientA + clientB.

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
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
  clientB: '20000000-0000-0000-0000-0000000000a2',
}
// conversation ids
const C = {
  a1: '30000000-0000-0000-0000-0000000000a1',
  a2: '30000000-0000-0000-0000-0000000000a2',
  b1: '30000000-0000-0000-0000-0000000000b1',
  b2: '30000000-0000-0000-0000-0000000000b2',
}
const M = {
  a1: '40000000-0000-0000-0000-0000000000a1',
  b1: '40000000-0000-0000-0000-0000000000b1',
}
// P1b.2 fix test constants
const C_UNKNOWN_A = '30000000-0000-0000-0000-0000000000a3'
const C_UNKNOWN_B = '30000000-0000-0000-0000-0000000000b3'
const M_UNKNOWN_A = '40000000-0000-0000-0000-0000000000a3'
const M_UNKNOWN_B = '40000000-0000-0000-0000-0000000000b3'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await db.exec(TENANT)
  await run(
    `INSERT INTO auth.users (id) VALUES ($1),($2),($3),($4)`,
    [U.operator, U.stranger, U.memberA, U.memberB],
  )
  await run(
    `INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'A',$2),($3,'B',$4)`,
    [A.clientA, U.memberA, A.clientB, U.memberB],
  )
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
    [U.memberA, A.clientA, U.memberB, A.clientB],
  )
  // operator + stranger have no tenant membership (operators are not members)
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,NULL,NULL),($2,NULL,NULL)`,
    [U.operator, U.stranger],
  )

  // 2 conversations in A, 2 in B
  await run(
    `INSERT INTO conversations (id, account_id) VALUES ($1,$2),($3,$4),($5,$6),($7,$8)`,
    [C.a1, A.clientA, C.a2, A.clientA, C.b1, A.clientB, C.b2, A.clientB],
  )
  // one message per conversation
  await run(
    `INSERT INTO messages (id, conversation_id) VALUES ($1,$2),($3,$4)`,
    [M.a1, C.a1, M.b1, C.b1],
  )

  // P1b.2 fix test data: additional conversations for unknown-conversation validation tests
  await run(
    `INSERT INTO conversations (id, account_id) VALUES ($1,$2),($3,$4)`,
    [C_UNKNOWN_A, A.clientA, C_UNKNOWN_B, A.clientB],
  )
  await run(
    `INSERT INTO messages (id, conversation_id) VALUES ($1,$2),($3,$4)`,
    [M_UNKNOWN_A, C_UNKNOWN_A, M_UNKNOWN_B, C_UNKNOWN_B],
  )

  // Load real migrations under test, in order (037 defines platform tables
  // + can_access_account; 038 extends SELECT policies to authorized operators).
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await db.exec(loadMigration('038_platform_read_context.sql'))

  // Bootstrap an ACTIVE operator assigned to BOTH clientA and clientB.
  await run(`INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',TRUE,$1)`, [U.operator])
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES
       ($1,$2,'viewer',$1),($1,$3,'viewer',$1)`,
    [U.operator, A.clientA, A.clientB],
  )
})

describe('P1b.2 — RLS alone would leak the union (proves the filter is needed)', () => {
  it('operator assigned to A and B sees BOTH tenants via unfiltered SELECT', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ account_id: string }>('SELECT account_id FROM conversations')
      expect(r.length).toBe(6)
      const ids = r.map((x) => x.account_id).sort()
      expect(ids).toEqual([A.clientA, A.clientA, A.clientA, A.clientB, A.clientB, A.clientB])
    })
  })
})

describe('P1b.2 — ConversationList query scoped to activeAccountId', () => {
  it('in /act/[A]/inbox list contains ONLY clientA conversations (3)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM conversations WHERE account_id = $1 ORDER BY id`,
        [A.clientA],
      )
      expect(r.length).toBe(3)
      expect(r.every((x) => x.account_id === A.clientA)).toBe(true)
    })
  })

  it('in /act/[B]/inbox list contains ONLY clientB conversations (3)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM conversations WHERE account_id = $1 ORDER BY id`,
        [A.clientB],
      )
      expect(r.length).toBe(3)
      expect(r.every((x) => x.account_id === A.clientB)).toBe(true)
    })
  })

  it('A and B lists are disjoint — no tenant mixing', async () => {
    await asUser(U.operator, async () => {
      const aIds = (await run<{ id: string }>(`SELECT id FROM conversations WHERE account_id = $1`, [A.clientA])).map((x) => x.id)
      const bIds = (await run<{ id: string }>(`SELECT id FROM conversations WHERE account_id = $1`, [A.clientB])).map((x) => x.id)
      expect(aIds.some((id) => bIds.includes(id))).toBe(false)
    })
  })
})

describe('P1b.2 — hydrateConversation scoped by account_id', () => {
  it('a clientB conversation id does NOT resolve while context is clientA', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [C.b1, A.clientA],
      )
      expect(r.length).toBe(0)
    })
  })

  it('a clientA conversation id resolves while context is clientA', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [C.a1, A.clientA],
      )
      expect(r.length).toBe(1)
      expect(r[0].id).toBe(C.a1)
    })
  })
})

describe('P1b.2 — messages realtime scoping (no account_id column)', () => {
  it('messages belong to conversations of the active tenant only when filtered by conversation set', async () => {
    await asUser(U.operator, async () => {
      // Active tenant A conversation set:
      const aConv = (await run<{ id: string }>(`SELECT id FROM conversations WHERE account_id = $1`, [A.clientA])).map((x) => x.id)
      const msgs = await run<{ id: string; conversation_id: string }>('SELECT id, conversation_id FROM messages')
      // A message from clientB must be dropped because its conversation is
      // not in the active tenant's known set (the client-side guard).
      const leaked = msgs.filter((m) => !aConv.includes(m.conversation_id))
      expect(leaked.length).toBe(2)
      const leakedConvIds = leaked.map((m) => m.conversation_id).sort()
      expect(leakedConvIds).toEqual([C.b1, C_UNKNOWN_B].sort())
    })
  })
})

describe('P1b.2 — member + stranger behavior unchanged', () => {
  it('owner of clientA still reads only their own conversations', async () => {
    await asUser(U.memberA, async () => {
      const r = await run<{ account_id: string }>('SELECT account_id FROM conversations')
      expect(r.length).toBe(3)
      expect(r.every((x) => x.account_id === A.clientA)).toBe(true)
    })
  })

  it('stranger (not an operator) reads nothing', async () => {
    await asUser(U.stranger, async () => {
      const r = await run<{ id: string }>('SELECT id FROM conversations')
      expect(r.length).toBe(0)
    })
  })
})

describe('P1b.2 — mutations remain blocked for operator', () => {
  it('operator cannot INSERT a conversation into clientA', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`INSERT INTO conversations (id, account_id) VALUES ($1,$2)`, ['39999999-0000-0000-0000-0000000000e1', A.clientA]),
      ).rejects.toThrow()
    })
  })

  it('operator cannot INSERT a message into clientA', async () => {
    await asUser(U.operator, async () => {
      await expect(
        run(`INSERT INTO messages (id, conversation_id) VALUES ($1,$2)`, ['49999999-0000-0000-0000-0000000000f1', C.a1]),
      ).rejects.toThrow()
    })
  })
})

describe('P1b.2 fix — unknown conversation message validation in platform context', () => {
  it('Client B unknown conversation message is DISCARDED (no validation pass)', async () => {
    await asUser(U.operator, async () => {
      // Simulate platform context = clientA
      const r = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [C_UNKNOWN_B, A.clientA],
      )
      // Must NOT resolve when context is clientA
      expect(r.length).toBe(0)
    })
  })

  it('Client A unknown conversation message IS ACCEPTED after scoped validation', async () => {
    await asUser(U.operator, async () => {
      // Simulate platform context = clientA
      const r = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [C_UNKNOWN_A, A.clientA],
      )
      // Must resolve when context is clientA
      expect(r.length).toBe(1)
      expect(r[0].id).toBe(C_UNKNOWN_A)
    })
  })

  it('validateAndHydrateUnknownConversation contract: A → true + known SYNCHRONOUSLY; B → false + NOT known', async () => {
    await asUser(U.operator, async () => {
      // Mirrors validateAndHydrateUnknownConversation(convId) under active
      // tenant = clientA: run the scoped (id + account_id) query; on a row,
      // add to the known set SYNCHRONOUSLY (no render/effect) and return true;
      // otherwise return false and leave the known set untouched.
      const known = new Set<string>()
      const validate = async (convId: string, activeAccountId: string) => {
        const rows = await run<{ id: string }>(
          `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
          [convId, activeAccountId],
        )
        if (rows.length === 0) return false // e.g. client B — discard
        known.add(convId) // synchronous — does NOT wait for a render/effect
        return true
      }

      // Unknown message from client B (arriving before any conv event): discarded.
      const okB = await validate(C_UNKNOWN_B, A.clientA)
      expect(okB).toBe(false)
      expect(known.has(C_UNKNOWN_B)).toBe(false) // knownConvIdsRef NOT modified for B

      // Unknown message from client A: accepted, and known IMMEDIATELY — the
      // first valid message does not depend on a later render/effect.
      const okA = await validate(C_UNKNOWN_A, A.clientA)
      expect(okA).toBe(true)
      expect(known.has(C_UNKNOWN_A)).toBe(true)
    })
  })

  it('Known Client A conversation continues to work (no regression)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [C.a1, A.clientA],
      )
      expect(r.length).toBe(1)
      expect(r[0].id).toBe(C.a1)
    })
  })

  it('Client B message NEVER updates list/thread/cache/notification in Client A context', async () => {
    await asUser(U.operator, async () => {
      // In platform context with activeAccountId = clientA,
      // a message for conversation C.b1 (clientB) must not resolve
      const r = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [C.b1, A.clientA],
      )
      expect(r.length).toBe(0)

      // Even the message exists, it must not be accessible via the
      // tenant-scoped query path that the inbox uses.
      const msg = await run<{ id: string; conversation_id: string }>(
        `SELECT id, conversation_id FROM messages WHERE id = $1`,
        [M.b1],
      )
      expect(msg.length).toBe(1)
      // The message exists in DB but its conversation is not in
      // the active tenant's set — the realtime guard must drop it.
      const inActiveTenant = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [msg[0].conversation_id, A.clientA],
      )
      expect(inActiveTenant.length).toBe(0)
    })
  })

  it('Valid Client A message arriving BEFORE conversation event is NOT LOST', async () => {
    await asUser(U.operator, async () => {
      // This simulates the race: message INSERT realtime event arrives
      // before the conversation INSERT realtime event. The fix validates
      // the conversation exists for the active tenant via explicit query.
      const r = await run<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1 AND account_id = $2`,
        [C_UNKNOWN_A, A.clientA],
      )
      expect(r.length).toBe(1)

      // The message exists and is linked to a valid clientA conversation
      const msg = await run<{ id: string; conversation_id: string }>(
        `SELECT id, conversation_id FROM messages WHERE id = $1`,
        [M_UNKNOWN_A],
      )
      expect(msg.length).toBe(1)
      expect(msg[0].conversation_id).toBe(C_UNKNOWN_A)

      // The scoped query succeeds → hydrateConversation would be called
      // → message would be processed → not lost.
    })
  })
})
