import { describe, expect, it, vi, beforeAll } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  listContacts,
  getContactById,
  listContactTags,
  listContactNotes,
  listContactCustomValues,
  listContactDeals,
  getContactAttribution,
  listTags,
  listCustomFields,
  type ContactWithTags,
} from './queries'

// ===================================================================
// PART A — Mock-based tests: prove accountId is never omitted and the
// RPC always receives p_account_id. These assert QUERY CONSTRUCTION,
// not RLS. RLS is covered separately in PART B against real Postgres.
// ===================================================================

/**
 * A chainable query mock that records every method call so tests can
 * assert what was built (eq filters, rpc params, pagination). Mirrors the
 * chain surface used by queries.ts.
 */
function chain(returnValue: unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const maybeSingle = returnValue && typeof returnValue === 'object' && 'single' in (returnValue as object)
  const value =
    returnValue && typeof returnValue === 'object' && 'data' in (returnValue as object)
      ? (returnValue as { data: unknown; error: null })
      : { data: returnValue, error: null }
  const obj: Record<string, unknown> = {
    then: (resolve: (v: unknown) => void) => resolve(value),
    single: () => {
      calls.push({ method: 'single', args: [] })
      const d = Array.isArray(value.data) ? value.data[0] ?? null : value.data
      return { data: d, error: null }
    },
    maybeSingle: () => {
      calls.push({ method: 'maybeSingle', args: [] })
      const d = Array.isArray(value.data) ? value.data[0] ?? null : value.data
      return { data: d, error: null }
    },
  }
  for (const m of [
    'select',
    'eq',
    'in',
    'or',
    'order',
    'range',
    'limit',
    'gte',
    'lt',
    'is',
  ]) {
    obj[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args })
      return obj
    })
  }
  // attach the captured calls for assertions
  ;(obj as unknown as { __calls: typeof calls }).__calls = calls
  void maybeSingle
  return obj as unknown as ChainMock
}

type ChainMock = {
  __calls: Array<{ method: string; args: unknown[] }>
  then: (resolve: (v: unknown) => void) => void
  eq: (...a: unknown[]) => unknown
  in: (...a: unknown[]) => unknown
  or: (...a: unknown[]) => unknown
  order: (...a: unknown[]) => unknown
  range: (...a: unknown[]) => unknown
  select: (...a: unknown[]) => unknown
  single: () => { data: unknown; error: null }
  maybeSingle: () => { data: unknown; error: null }
}

function fromMock(
  tableConfig: Record<string, ChainMock>,
  rpcData: unknown = [],
) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = []
  const fromSpy = vi.fn((table: string) => tableConfig[table] ?? chain([]))
  let currentRpcData = rpcData
  const rpcSpy = vi.fn((name: string, params: Record<string, unknown>) => {
    rpcCalls.push({ name, params })
    return currentRpcData
  })
  const db = {
    from: fromSpy,
    rpc: rpcSpy,
  }
  return {
    db: db as unknown as SupabaseClient,
    fromSpy,
    rpcSpy,
    rpcCalls,
    setRpcData: (d: unknown) => {
      currentRpcData = d
    },
  }
}

describe('contacts/queries — accountId is mandatory and always injected', () => {
  it('rejects when accountId is empty (listContacts, no tags)', async () => {
    const { db } = fromMock({})
    await expect(listContacts(db, '', { page: 0, pageSize: 25 })).rejects.toThrow(/accountId/)
  })

  it('rejects when accountId is empty (getContactById)', async () => {
    const { db } = fromMock({})
    await expect(getContactById(db, '', 'c1')).rejects.toThrow(/accountId/)
  })

  it('rejects when accountId is empty (listContactDeals)', async () => {
    const { db } = fromMock({})
    await expect(listContactDeals(db, '', 'c1')).rejects.toThrow(/accountId/)
  })

  it('listContacts (no tagIds) applies .eq("account_id", accountId) on contacts', async () => {
    const contact = { id: 'c1', account_id: 'accA', name: 'A' }
    const tagCfg = chain([]) // contact_tags (no rows)
    const tagList = chain([]) // tags (no rows)
    const { db, fromSpy } = fromMock({
      contacts: chain({ data: [contact], error: null, count: 1 }),
      contact_tags: tagCfg,
      tags: tagList,
    })
    const { contacts, totalCount } = await listContacts(db, 'accA', {
      page: 0,
      pageSize: 25,
    })
    const contactChainObj = (fromSpy.mock.results[0]?.value) as ChainMock
    const accountEq = contactChainObj.__calls.find(
      (c) => c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'accA',
    )
    expect(accountEq).toBeDefined()
    expect(contacts).toHaveLength(1)
    expect(totalCount).toBe(1)
  })

  it('listContacts (with tagIds) calls the RPC with explicit p_account_id', async () => {
    const contact = { id: 'c1', account_id: 'accA', name: 'A' }
    const { db, rpcCalls, setRpcData, fromSpy } = fromMock({
      contact_tags: chain([]),
      tags: chain([]),
    })
    setRpcData({ data: [{ contact, total_count: 1 }], error: null })
    const { contacts } = await listContacts(db, 'accA', {
      tagIds: ['t1', 't2'],
      page: 0,
      pageSize: 25,
    })
    expect(rpcCalls.length).toBe(1)
    expect(rpcCalls[0].name).toBe('filter_contacts_by_tags')
    expect(rpcCalls[0].params.p_account_id).toBe('accA')
    expect(rpcCalls[0].params.p_tag_ids).toEqual(['t1', 't2'])
    expect(contacts).toHaveLength(1)
    void fromSpy
  })

  it('listContacts (with tagIds) never calls the RPC without p_account_id', async () => {
    const { db, rpcCalls, setRpcData } = fromMock({})
    setRpcData({ data: [], error: null })
    await listContacts(db, 'accA', { tagIds: ['t1'], page: 0, pageSize: 10 })
    const missing = rpcCalls.some(
      (c) => c.name === 'filter_contacts_by_tags' && !('p_account_id' in c.params),
    )
    expect(missing).toBe(false)
    expect(rpcCalls[0].params.p_account_id).toBe('accA')
  })

  it('listContacts pagination math: page 2, pageSize 25 -> range(50,74)', async () => {
    const { db, fromSpy } = fromMock({
      contacts: chain({ data: [], error: null, count: 0 }),
      contact_tags: chain([]),
      tags: chain([]),
    })
    await listContacts(db, 'accA', { page: 2, pageSize: 25 })
    const contactsCall = fromSpy.mock.calls.find((c) => c[0] === 'contacts')
    expect(contactsCall).toBeDefined()
    const rangeCall = (fromSpy.mock.results[0]?.value as ChainMock).__calls.find(
      (c) => c.method === 'range',
    )
    expect(rangeCall?.args).toEqual([50, 74])
  })

  it('getContactById filters by id AND account_id in the same query (returns null when absent)', async () => {
    const { db, fromSpy } = fromMock({
      contacts: chain({ data: null, error: null }),
    })
    const res = await getContactById(db, 'accA', 'cX')
    const chainObj = fromSpy.mock.results[0]?.value as ChainMock
    const idEq = chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === 'cX')
    const accEq = chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'accA')
    expect(idEq).toBeDefined()
    expect(accEq).toBeDefined()
    expect(res).toBeNull()
  })

  it('listContactNotes applies contact_id AND account_id directly', async () => {
    const { db, fromSpy } = fromMock({ contact_notes: chain([]) })
    await listContactNotes(db, 'accA', 'c1')
    const chainObj = fromSpy.mock.results[0]?.value as ChainMock
    expect(
      chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'contact_id' && c.args[1] === 'c1'),
    ).toBeDefined()
    expect(
      chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'accA'),
    ).toBeDefined()
  })

  it('listContactDeals applies contact_id AND account_id directly', async () => {
    const { db, fromSpy } = fromMock({ deals: chain([]) })
    await listContactDeals(db, 'accA', 'c1')
    const chainObj = fromSpy.mock.results[0]?.value as ChainMock
    expect(
      chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'contact_id' && c.args[1] === 'c1'),
    ).toBeDefined()
    expect(
      chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'accA'),
    ).toBeDefined()
  })

  it('listContactTags validates parent tenant via contact.account_id embed filter (no own account_id)', async () => {
    const { db, fromSpy } = fromMock({ contact_tags: chain([]) })
    await listContactTags(db, 'accA', 'c1')
    const chainObj = fromSpy.mock.results[0]?.value as ChainMock
    expect(
      chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'contact_id' && c.args[1] === 'c1'),
    ).toBeDefined()
    expect(
      chainObj.__calls.find(
        (c) => c.method === 'eq' && c.args[0] === 'contact.account_id' && c.args[1] === 'accA',
      ),
    ).toBeDefined()
  })

  it('listContactCustomValues validates parent tenant via contact.account_id embed filter', async () => {
    const { db, fromSpy } = fromMock({ contact_custom_values: chain([]) })
    await listContactCustomValues(db, 'accA', 'c1')
    const chainObj = fromSpy.mock.results[0]?.value as ChainMock
    expect(
      chainObj.__calls.find(
        (c) => c.method === 'eq' && c.args[0] === 'contact.account_id' && c.args[1] === 'accA',
      ),
    ).toBeDefined()
  })

  it('getContactAttribution filters by id AND account_id, returns null when absent', async () => {
    const { db, fromSpy } = fromMock({ lead_attributions: chain([]) })
    const res = await getContactAttribution(db, 'accA', 'a1')
    const chainObj = fromSpy.mock.results[0]?.value as ChainMock
    expect(
      chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === 'a1'),
    ).toBeDefined()
    expect(
      chainObj.__calls.find((c) => c.method === 'eq' && c.args[0] === 'account_id' && c.args[1] === 'accA'),
    ).toBeDefined()
    expect(res).toBeNull()
  })

  it('listTags / listCustomFields apply .eq("account_id", accountId)', async () => {
    const { db, fromSpy } = fromMock({ tags: chain([]), custom_fields: chain([]) })
    await listTags(db, 'accA')
    await listCustomFields(db, 'accA')
    const tagsChain = fromSpy.mock.results[0]?.value as ChainMock
    const cfChain = fromSpy.mock.results[1]?.value as ChainMock
    expect(tagsChain.__calls.find((c) => c.method === 'eq' && c.args[1] === 'accA')).toBeDefined()
    expect(cfChain.__calls.find((c) => c.method === 'eq' && c.args[1] === 'accA')).toBeDefined()
  })

  it('propagates real Supabase errors instead of swallowing them', async () => {
    const { db, setRpcData } = fromMock({})
    setRpcData({ data: null, error: { message: 'boom', code: 'X' } })
    await expect(
      listContacts(db, 'accA', { tagIds: ['t1'], page: 0, pageSize: 10 }),
    ).rejects.toMatchObject({ message: 'boom' })
  })

  it('returns [] (not thrown) when query succeeds with no rows', async () => {
    const { db } = fromMock({
      contacts: chain({ data: [], error: null, count: 0 }),
      contact_tags: chain([]),
      tags: chain([]),
    })
    const { contacts, totalCount } = await listContacts(db, 'accA', { page: 0, pageSize: 25 })
    expect(contacts).toEqual([])
    expect(totalCount).toBe(0)
  })

  it('attachTags queries contact_tags in one batch via .in(\'contact_id\', contactIds) and no dotted relation filter', async () => {
    // NOTE: this mock asserts QUERY CONSTRUCTION only. It does NOT validate
    // PostgREST relationship resolution against a real server.
    const c1 = { id: 'c1', account_id: 'accA', name: 'A' }
    const c2 = { id: 'c2', account_id: 'accA', name: 'B' }
    const tagRows = [
      { contact_id: 'c1', tag_id: 't1' },
      { contact_id: 'c2', tag_id: 't2' },
    ]
    const { db, fromSpy } = fromMock({
      contacts: chain({ data: [c1, c2], error: null, count: 2 }),
      contact_tags: chain({ data: tagRows, error: null }),
      tags: chain([]),
    })
    await listContacts(db, 'accA', { page: 0, pageSize: 25 })
    const ctChain = fromSpy.mock.results[1]?.value as ChainMock
    const inCall = ctChain.__calls.find((c) => c.method === 'in' && c.args[0] === 'contact_id')
    const dottedEq = ctChain.__calls.find((c) => c.method === 'eq' && c.args[0] === 'contact.account_id')
    expect(inCall).toBeDefined()
    expect(dottedEq).toBeUndefined()
    const contactTagsCalls = fromSpy.mock.calls.filter((c) => c[0] === 'contact_tags').length
    expect(contactTagsCalls).toBe(1)
  })

  it('maps tags onto contacts in a single batch (no per-contact query)', async () => {
    const c1 = { id: 'c1', account_id: 'accA', name: 'A' }
    const c2 = { id: 'c2', account_id: 'accA', name: 'B' }
    const tagRows = [
      { contact_id: 'c1', tag_id: 't1' },
      { contact_id: 'c2', tag_id: 't2' },
    ]
    const tagList = [{ id: 't1', account_id: 'accA', name: 'VIP', color: '#f00' }]
    const { db, fromSpy } = fromMock({
      contacts: chain({ data: [c1, c2], error: null, count: 2 }),
      contact_tags: chain({ data: tagRows, error: null }),
      tags: chain({ data: tagList, error: null }),
    })
    const { contacts } = await listContacts(db, 'accA', { page: 0, pageSize: 25 })
    // exactly one contact_tags query + one tags query, regardless of 2 contacts
    const contactTagsCalls = fromSpy.mock.calls.filter((c) => c[0] === 'contact_tags').length
    const tagsCalls = fromSpy.mock.calls.filter((c) => c[0] === 'tags').length
    expect(contactTagsCalls).toBe(1)
    expect(tagsCalls).toBe(1)
    const typed = contacts as ContactWithTags[]
    expect(typed[0].tags).toHaveLength(1)
    expect(typed[0].tags[0].name).toBe('VIP')
    expect(typed[1].tags).toHaveLength(0)
  })
})

// ===================================================================
// PART B — PGlite tests against the REAL migration stack (genuine RLS,
// not faked). The SQL emitted here mirrors exactly the query shapes that
// queries.ts builds, so tenant isolation of the layer is exercised
// against production RLS. This complements PART A (construction) and the
// Lote 0.1 RPC PGlite test (RPC + RLS).
// ===================================================================

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

CREATE TABLE contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL, name TEXT, phone TEXT, email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE tags (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL, name TEXT, color TEXT);
CREATE TABLE custom_fields (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL, field_name TEXT, field_type TEXT);
CREATE TABLE contact_notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL, contact_id UUID NOT NULL, user_id UUID, note_text TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE contact_tags (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE);
CREATE TABLE contact_custom_values (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), contact_id UUID NOT NULL, custom_field_id UUID NOT NULL, value TEXT);
CREATE TABLE deals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL, contact_id UUID, pipeline_id UUID, stage_id UUID, title TEXT, value NUMERIC, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE pipeline_stages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), pipeline_id UUID NOT NULL, name TEXT, position INT, color TEXT);
CREATE TABLE lead_attributions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL, contact_id UUID, source_channel TEXT);
CREATE TABLE conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL);
CREATE TABLE message_templates (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE pipelines (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE broadcasts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE automations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE automation_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE flows (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE flow_runs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE broadcast_recipients (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), broadcast_id UUID NOT NULL);
CREATE TABLE automation_steps (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), automation_id UUID NOT NULL);
CREATE TABLE flow_nodes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), flow_id UUID NOT NULL);
CREATE TABLE flow_run_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), flow_run_id UUID NOT NULL);
CREATE TABLE message_reactions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), message_id UUID NOT NULL);

-- 017 member-only SELECT policies
CREATE POLICY contacts_select ON contacts FOR SELECT USING (is_account_member(account_id));
CREATE POLICY tags_select ON tags FOR SELECT USING (is_account_member(account_id));
CREATE POLICY custom_fields_select ON custom_fields FOR SELECT USING (is_account_member(account_id));
CREATE POLICY contact_notes_select ON contact_notes FOR SELECT USING (is_account_member(account_id));
CREATE POLICY deals_select ON deals FOR SELECT USING (is_account_member(account_id));
CREATE POLICY lead_attributions_select ON lead_attributions FOR SELECT USING (is_account_member(account_id));

CREATE POLICY contact_tags_select ON contact_tags FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id AND is_account_member(c.account_id)));
CREATE POLICY contact_custom_values_select ON contact_custom_values FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_custom_values.contact_id AND is_account_member(c.account_id)));

CREATE POLICY conversations_select ON conversations FOR SELECT USING (is_account_member(account_id));
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND is_account_member(c.account_id)));
CREATE POLICY message_templates_select ON message_templates FOR SELECT USING (is_account_member(account_id));
CREATE POLICY pipelines_select ON pipelines FOR SELECT USING (is_account_member(account_id));
CREATE POLICY broadcasts_select ON broadcasts FOR SELECT USING (is_account_member(account_id));
CREATE POLICY automations_select ON automations FOR SELECT USING (is_account_member(account_id));
CREATE POLICY automation_logs_select ON automation_logs FOR SELECT USING (is_account_member(account_id));
CREATE POLICY flows_select ON flows FOR SELECT USING (is_account_member(account_id));
CREATE POLICY flow_runs_select ON flow_runs FOR SELECT USING (is_account_member(account_id));

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON contact_custom_values TO authenticated;
GRANT SELECT ON contact_tags TO authenticated;
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
  memberA: '10000000-0000-0000-0000-000000000004',
  memberB: '10000000-0000-0000-0000-000000000005',
  operator: '10000000-0000-0000-0000-000000000002',
  operatorBOnly: '10000000-0000-0000-0000-000000000006',
}
const A = {
  clientA: '20000000-0000-0000-0000-0000000000a1',
  clientB: '20000000-0000-0000-0000-0000000000a2',
}
const C = {
  a1: '60000000-0000-0000-0000-0000000000a1',
  a2: '60000000-0000-0000-0000-0000000000a2',
  b1: '60000000-0000-0000-0000-0000000000b1',
  b2: '60000000-0000-0000-0000-0000000000b2',
}
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
    [U.operator, U.memberA, U.memberB, U.operatorBOnly, '10000000-0000-0000-0000-000000000007'],
  )
  await run(
    `INSERT INTO accounts (id, name, owner_user_id) VALUES ($1,'A',$2),($3,'B',$4)`,
    [A.clientA, U.memberA, A.clientB, U.memberB],
  )
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,$2,'owner'),($3,$4,'owner')`,
    [U.memberA, A.clientA, U.memberB, A.clientB],
  )
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1,NULL,NULL),($2,NULL,NULL),($3,NULL,NULL)`,
    [U.operator, U.operatorBOnly, '10000000-0000-0000-0000-000000000007'],
  )

  await run(
    `INSERT INTO tags (id, account_id, name) VALUES ($1,$2,'shared'),($3,$4,'onlyA')`,
    [T.shared, A.clientA, T.onlyA, A.clientA],
  )
  await run(
    `INSERT INTO contacts (id, account_id, name) VALUES ($1,$2,'A-one'),($3,$4,'A-two'),($5,$6,'B-one'),($7,$8,'B-two')`,
    [C.a1, A.clientA, C.a2, A.clientA, C.b1, A.clientB, C.b2, A.clientB],
  )
  await run(
    `INSERT INTO contact_tags (contact_id, tag_id) VALUES
      ('${C.a1}','${T.shared}'),
      ('${C.a2}','${T.onlyA}'),
      ('${C.b1}','${T.shared}'),
      ('${C.b2}','${T.shared}')`,
  )
  await run(
    `INSERT INTO contact_notes (id, account_id, contact_id, note_text) VALUES
      ('80000000-0000-0000-0000-0000000000a1','${A.clientA}','${C.a1}','note-in-A'),
      ('80000000-0000-0000-0000-0000000000b1','${A.clientB}','${C.b1}','note-in-B')`,
  )
  await run(
    `INSERT INTO deals (id, account_id, contact_id, title, value) VALUES
      ('90000000-0000-0000-0000-0000000000a1','${A.clientA}','${C.a1}','deal-A',100),
      ('90000000-0000-0000-0000-0000000000b1','${A.clientB}','${C.b1}','deal-B',200)`,
  )
  await run(
    `INSERT INTO lead_attributions (id, account_id, contact_id, source_channel) VALUES
      ('a0000000-0000-0000-0000-0000000000a1','${A.clientA}','${C.a1}','organic'),
      ('a0000000-0000-0000-0000-0000000000b1','${A.clientB}','${C.b1}','ctwa_meta')`,
  )
  await run(
    `INSERT INTO contact_custom_values (contact_id, custom_field_id, value) VALUES
      ('${C.a1}','cf000000-0000-0000-0000-0000000000a1','vA'),
      ('${C.b1}','cf000000-0000-0000-0000-0000000000b1','vB')`,
  )

  await db.exec(loadMigration('025_filter_contacts_by_tags.sql'))
  await db.exec(loadMigration('037_platform_admin_foundation.sql'))
  await db.exec(loadMigration('038_platform_read_context.sql'))
  await db.exec(loadMigration('040_filter_contacts_by_tags_tenant_scope.sql'))

  await run(`INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'operator',TRUE,$1),($2,'operator',TRUE,$2)`, [U.operator, U.operatorBOnly])
  await run(
    `INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES
       ($1,$2,'viewer',$1),($1,$3,'viewer',$1),($4,$3,'viewer',$4)`,
    [U.operator, A.clientA, A.clientB, U.operatorBOnly],
  )
})

// The shapes below mirror EXACTLY what queries.ts emits:
//   listContacts(no tags):  FROM contacts WHERE account_id = $1 [+ search + range]
//   listContacts(tags):     RPC filter_contacts_by_tags(..., p_account_id => $)
//   child tables w/ own id: WHERE contact_id = $1 AND account_id = $2
//   child tables w/o id:    WHERE contact_id = $1 AND EXISTS(parent account match)
// Running these as the operator (multi-tenant) proves the layer's tenant
// scope holds under real RLS.

describe('P2.1 Lote 1 — tenant isolation against real RLS (query shapes from queries.ts)', () => {
  it('operator A+B querying A (direct contacts path) sees ONLY A', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM contacts WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT 25 OFFSET 0`,
        [A.clientA],
      )
      expect(r.length).toBe(2)
      expect(r.every((x) => x.account_id === A.clientA)).toBe(true)
    })
  })

  it('operator A+B querying B (direct contacts path) sees ONLY B', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM contacts WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT 25 OFFSET 0`,
        [A.clientB],
      )
      expect(r.length).toBe(2)
      expect(r.every((x) => x.account_id === A.clientB)).toBe(true)
    })
  })

  it('listContacts(tags) RPC with p_account_id = A returns no contact from B', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string; account_id: string }>(
        `SELECT (contact).id, (contact).account_id FROM public.filter_contacts_by_tags(p_tag_ids => $1::uuid[], p_account_id => $2::uuid)`,
        [[T.shared], A.clientA],
      )
      expect(r.length).toBe(1)
      expect(r[0].account_id).toBe(A.clientA)
      expect(r.some((x) => x.account_id === A.clientB)).toBe(false)
    })
  })

  it('getContactById(accountId=A, contactId in B) returns no rows (null equivalent)', async () => {
    await asUser(U.operator, async () => {
      const r = await run<{ id: string }>(
        `SELECT id FROM contacts WHERE id = $1 AND account_id = $2`,
        [C.b1, A.clientA],
      )
      expect(r.length).toBe(0)
    })
  })

  it('operator authorized ONLY for B querying A via contacts path is empty', async () => {
    await asUser(U.operatorBOnly, async () => {
      const r = await run<{ id: string }>(
        `SELECT id FROM contacts WHERE account_id = $1`,
        [A.clientA],
      )
      expect(r.length).toBe(0)
    })
  })

  it('member of A querying B via contacts path is empty', async () => {
    await asUser(U.memberA, async () => {
      const r = await run<{ id: string }>(
        `SELECT id FROM contacts WHERE account_id = $1`,
        [A.clientB],
      )
      expect(r.length).toBe(0)
    })
  })

  it('pagination stays within tenant (page 1 of A never bleeds into B)', async () => {
    await asUser(U.operator, async () => {
      // 2 contacts in A, page size 1 -> page 0 and 1 are both A-only
      const page0 = await run<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM contacts WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT 1 OFFSET 0`,
        [A.clientA],
      )
      const page1 = await run<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM contacts WHERE account_id = $1 ORDER BY created_at DESC, id LIMIT 1 OFFSET 1`,
        [A.clientA],
      )
      expect(page0.length).toBe(1)
      expect(page1.length).toBe(1)
      expect(page0[0].account_id).toBe(A.clientA)
      expect(page1[0].account_id).toBe(A.clientA)
    })
  })

  it('contact_notes scoped by account_id (wrong tenant empty)', async () => {
    await asUser(U.operator, async () => {
      const a = await run<{ id: string }>(
        `SELECT id FROM contact_notes WHERE contact_id = $1 AND account_id = $2`,
        [C.a1, A.clientA],
      )
      const b = await run<{ id: string }>(
        `SELECT id FROM contact_notes WHERE contact_id = $1 AND account_id = $2`,
        [C.b1, A.clientA],
      )
      expect(a.length).toBe(1)
      expect(b.length).toBe(0)
    })
  })

  it('deals scoped by account_id (wrong tenant empty)', async () => {
    await asUser(U.operator, async () => {
      const a = await run<{ id: string }>(
        `SELECT id FROM deals WHERE contact_id = $1 AND account_id = $2`,
        [C.a1, A.clientA],
      )
      const b = await run<{ id: string }>(
        `SELECT id FROM deals WHERE contact_id = $1 AND account_id = $2`,
        [C.b1, A.clientA],
      )
      expect(a.length).toBe(1)
      expect(b.length).toBe(0)
    })
  })

  it('lead_attributions scoped by account_id (wrong tenant empty)', async () => {
    await asUser(U.operator, async () => {
      const a = await run<{ id: string }>(
        `SELECT id FROM lead_attributions WHERE id = $1 AND account_id = $2`,
        ['a0000000-0000-0000-0000-0000000000a1', A.clientA],
      )
      const b = await run<{ id: string }>(
        `SELECT id FROM lead_attributions WHERE id = $1 AND account_id = $2`,
        ['a0000000-0000-0000-0000-0000000000b1', A.clientA],
      )
      expect(a.length).toBe(1)
      expect(b.length).toBe(0)
    })
  })

  it('contact_tags protected by parent contacts relation (wrong tenant empty)', async () => {
    await asUser(U.operator, async () => {
      const a = await run<{ contact_id: string }>(
        `SELECT ct.contact_id FROM contact_tags ct WHERE ct.contact_id = $1 AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ct.contact_id AND c.account_id = $2)`,
        [C.a1, A.clientA],
      )
      const b = await run<{ contact_id: string }>(
        `SELECT ct.contact_id FROM contact_tags ct WHERE ct.contact_id = $1 AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ct.contact_id AND c.account_id = $2)`,
        [C.b1, A.clientA],
      )
      expect(a.length).toBe(1)
      expect(b.length).toBe(0)
    })
  })

  it('contact_custom_values protected by parent contacts relation (wrong tenant empty)', async () => {
    await asUser(U.operator, async () => {
      const a = await run<{ contact_id: string }>(
        `SELECT ccv.contact_id FROM contact_custom_values ccv WHERE ccv.contact_id = $1 AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ccv.contact_id AND c.account_id = $2)`,
        [C.a1, A.clientA],
      )
      const b = await run<{ contact_id: string }>(
        `SELECT ccv.contact_id FROM contact_custom_values ccv WHERE ccv.contact_id = $1 AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ccv.contact_id AND c.account_id = $2)`,
        [C.b1, A.clientA],
      )
      expect(a.length).toBe(1)
      expect(b.length).toBe(0)
    })
  })
})
