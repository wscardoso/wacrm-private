import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Real PostgreSQL (in-memory PGlite) tests for the C4 idempotency RPCs and
// the deterministic dedupe cleanup. These execute the ACTUAL SQL from
// migrations 034 / 035 — not copies — so the partial-index ON CONFLICT
// behaviour (the 42P10 trap) and group-aware reaction consolidation are
// validated against a true Postgres engine.

let db: PGlite

// Minimal schema mirroring the columns the RPCs / cleanup touch, plus the
// partial unique indexes. PGlite supports gen_random_uuid() natively.
const SCHEMA = `
-- PGlite lacks the Supabase roles; create stubs so the migrations'
-- REVOKE/GRANT statements succeed verbatim.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','agent','bot')),
  content_type TEXT,
  content_text TEXT,
  media_url TEXT,
  message_id TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  interactive_reply_id TEXT
);

CREATE TABLE message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('customer','agent')),
  actor_id UUID,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, actor_type, actor_id)
);

CREATE TABLE lead_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  contact_id UUID,
  conversation_id UUID,
  source_channel TEXT NOT NULL,
  origin_message_id TEXT,
  ad_source_id TEXT,
  ad_source_type TEXT,
  ad_source_url TEXT,
  ad_headline TEXT,
  ad_body TEXT,
  ad_media_type TEXT,
  ad_media_url TEXT,
  ctwa_clid TEXT,
  fbclid TEXT,
  gclid TEXT,
  utm JSONB,
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  ad_id TEXT,
  ad_name TEXT,
  placement TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_lead_attr_origin_message_unique
  ON lead_attributions(origin_message_id)
  WHERE origin_message_id IS NOT NULL;
`

function loadMigration(name: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const file = require('node:fs')
    .readdirSync(dir)
    .find((f: string) => f.endsWith(name))
  if (!file) throw new Error(`migration not found: ${name}`)
  return readFileSync(join(dir, file), 'utf8')
}

// Typed query helper — PGlite's db.query returns rows as unknown[].
async function run<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(text, params)
  return r.rows as T[]
}

async function insertInbound(convId: string, msgId: string, createdAt = '2024-01-01T00:00:00Z') {
  const rows = await run<{ insert_inbound_message: string }>(
    `SELECT insert_inbound_message($1,'customer','text','hi',NULL,$2,'delivered',$3::timestamptz,NULL,NULL) AS insert_inbound_message`,
    [convId, msgId, createdAt],
  )
  return rows[0]?.insert_inbound_message ?? null
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  // Execute the real migrations (they create the partial index, the
  // dedupe function, and the insert RPCs). 034 also calls
  // dedupe_inbound_messages() at the end (no-op on empty tables).
  await db.exec(loadMigration('034_messages_inbound_idempotency.sql'))
  await db.exec(loadMigration('035_inbound_idempotency_rpcs.sql'))
})

describe('insert_inbound_message (real Postgres)', () => {
  it('first insert → one row and a UUID returned', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id) VALUES ('11111111-1111-1111-1111-111111111111') RETURNING id`,
    )
    const convId = rows[0].id
    const id = await insertInbound(convId, 'wamid.A')
    expect(id).toBeTruthy()
    const msgs = await run('SELECT count(*)::int AS c FROM messages')
    expect(msgs[0].c).toBe(1)
  })

  it('redelivery → no new row and no UUID returned', async () => {
    const convId = '22222222-2222-2222-2222-222222222222'
    await run(`INSERT INTO conversations (id) VALUES ($1)`, [convId])
    const first = await insertInbound(convId, 'wamid.B')
    const second = await insertInbound(convId, 'wamid.B')
    expect(first).toBeTruthy()
    expect(second).toBeNull()
    const rows = await run('SELECT count(*)::int AS c FROM messages WHERE message_id=$1', ['wamid.B'])
    expect(rows[0].c).toBe(1)
  })

  it('two distinct legitimate messages → both persisted', async () => {
    const convId = '33333333-3333-3333-3333-333333333333'
    await run(`INSERT INTO conversations (id) VALUES ($1)`, [convId])
    const a = await insertInbound(convId, 'wamid.C1')
    const b = await insertInbound(convId, 'wamid.C2')
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    const rows = await run('SELECT count(*)::int AS c FROM messages WHERE conversation_id=$1', [convId])
    expect(rows[0].c).toBe(2)
  })

  it('same message_id in different conversations → both persisted', async () => {
    const c1 = '44444444-4444-4444-4444-444444444401'
    const c2 = '44444444-4444-4444-4444-444444444402'
    await run(`INSERT INTO conversations (id) VALUES ($1),($2)`, [c1, c2])
    const a = await insertInbound(c1, 'wamid.D')
    const b = await insertInbound(c2, 'wamid.D')
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    const rows = await run('SELECT count(*)::int AS c FROM messages WHERE message_id=$1', ['wamid.D'])
    expect(rows[0].c).toBe(2)
  })

  it("NULL and '' message_id → not deduplicated", async () => {
    const convId = '55555555-5555-5555-5555-555555555555'
    await run(`INSERT INTO conversations (id) VALUES ($1)`, [convId])
    const n1 = await db.query<{ insert_inbound_message: string }>(
      `SELECT insert_inbound_message($1,'customer','text','x',NULL,NULL,'delivered',NOW(),NULL,NULL) AS insert_inbound_message`,
      [convId],
    )
    const n2 = await db.query<{ insert_inbound_message: string }>(
      `SELECT insert_inbound_message($1,'customer','text','x',NULL,NULL,'delivered',NOW(),NULL,NULL) AS insert_inbound_message`,
      [convId],
    )
    const e1 = await db.query<{ insert_inbound_message: string }>(
      `SELECT insert_inbound_message($1,'customer','text','x',NULL,'','delivered',NOW(),NULL,NULL) AS insert_inbound_message`,
      [convId],
    )
    const e2 = await db.query<{ insert_inbound_message: string }>(
      `SELECT insert_inbound_message($1,'customer','text','x',NULL,'','delivered',NOW(),NULL,NULL) AS insert_inbound_message`,
      [convId],
    )
    expect(n1.rows[0].insert_inbound_message).toBeTruthy()
    expect(n2.rows[0].insert_inbound_message).toBeTruthy()
    expect(e1.rows[0].insert_inbound_message).toBeTruthy()
    expect(e2.rows[0].insert_inbound_message).toBeTruthy()
    const rows = await run('SELECT count(*)::int AS c FROM messages WHERE conversation_id=$1 AND (message_id IS NULL OR message_id=$2)', [convId, ''])
    expect(rows[0].c).toBe(4)
  })

  it('concurrent repeat of same identifier → a single row', async () => {
    const convId = '66666666-6666-6666-6666-666666666666'
    await run(`INSERT INTO conversations (id) VALUES ($1)`, [convId])
    const ids = await Promise.all([
      insertInbound(convId, 'wamid.E'),
      insertInbound(convId, 'wamid.E'),
      insertInbound(convId, 'wamid.E'),
    ])
    const nonNull = ids.filter(Boolean)
    expect(nonNull.length).toBe(1)
    const rows = await run('SELECT count(*)::int AS c FROM messages WHERE message_id=$1', ['wamid.E'])
    expect(rows[0].c).toBe(1)
  })
})

describe('insert_lead_attribution (real Postgres)', () => {
  it('idempotent on origin_message_id', async () => {
    const acc = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const conv = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const ins = async () =>
      db.query<{ insert_lead_attribution: string }>(
        `SELECT insert_lead_attribution(
            $1::uuid, NULL::uuid, $2::uuid,
            'ctwa_meta'::text, 'wamid.ref1'::text,
            NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
            NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
            NULL::jsonb, NULL::text, NULL::text, NULL::text, NULL::text,
            NULL::text, NULL::text, NULL::text, '{}'::jsonb
          ) AS insert_lead_attribution`,
        [acc, conv],
      )
    const r1 = await ins()
    const r2 = await ins()
    expect(r1.rows[0].insert_lead_attribution).toBeTruthy()
    expect(r2.rows[0].insert_lead_attribution).toBeNull()
    const rows = await run('SELECT count(*)::int AS c FROM lead_attributions WHERE origin_message_id=$1', ['wamid.ref1'])
    expect(rows[0].c).toBe(1)
  })
})

describe('dedupe_inbound_messages — group-aware reaction consolidation', () => {
  const IDX =
    'idx_messages_conv_msgid_customer'
  const dropIdx = () =>
    db.exec(`DROP INDEX IF EXISTS ${IDX}`)
  const createIdx = () =>
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${IDX} ON messages (conversation_id, message_id)
       WHERE sender_type = 'customer' AND message_id IS NOT NULL AND message_id <> ''`,
    )

  async function seedDupes() {
    // Fresh conversation + 3 duplicate inbound rows (keeper = oldest).
    // Inserted DIRECTLY (bypassing the idempotent RPC) to simulate the
    // pre-migration dirty state the dedupe function must clean up. The
    // partial unique index is dropped first so the dirty inserts are
    // allowed, mirroring a DB that accumulated duplicates before 034 ran.
    await dropIdx()
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id) VALUES (gen_random_uuid()) RETURNING id`,
    )
    const convId = rows[0].id
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const { rows: mr } = await db.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at)
         VALUES ($1,'customer','text','hi','wamid.group','delivered',
           ($2::timestamptz + ($3 || ' seconds')::interval))
         RETURNING id`,
        [convId, '2024-01-01T00:00:00Z', String(i * 10)],
      )
      ids.push(mr[0].id)
    }
    return { convId, ids }
  }

  it('collapses duplicates, keeps keeper, repoints replies', async () => {
    const { convId, ids } = await seedDupes()
    const keeperId = ids[0]
    const dupId = ids[1]
    // a message that quotes a duplicate
    await run(
      `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status, created_at, reply_to_message_id)
       VALUES ($1,'customer','text','reply',NULL,'delivered',NOW(),$2)`,
      [convId, dupId],
    )
    const removed = await db.query<{ dedupe_inbound_messages: number }>(
      `SELECT dedupe_inbound_messages() AS dedupe_inbound_messages`,
    )
    expect(removed.rows[0].dedupe_inbound_messages).toBe(2)

    // Recreating the partial unique index must now succeed (no dupes left).
    await createIdx()

    const msgs = await run('SELECT count(*)::int AS c FROM messages WHERE conversation_id=$1 AND message_id=$2', [convId, 'wamid.group'])
    expect(msgs[0].c).toBe(1)

    // reply now points at keeper
    const reply = await run<{ reply_to_message_id: string | null }>(
      'SELECT reply_to_message_id FROM messages WHERE conversation_id=$1 AND message_id IS NULL',
      [convId],
    )
    expect(reply[0]?.reply_to_message_id).toBe(keeperId)
  })

  it('3+ duplicates with reaction collisions → one reaction per (actor) on keeper', async () => {
    const { convId, ids } = await seedDupes()
    const keeperId = ids[0]
    // keeper has reaction from actor A; dup1 and dup2 also have A (different times)
    await run(
      `INSERT INTO message_reactions (message_id, conversation_id, actor_type, actor_id, emoji, created_at)
       VALUES ($1,$2,'customer','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','👍', NOW()),
              ($3,$2,'customer','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','👍', NOW() - interval '1 minute'),
              ($4,$2,'customer','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','👍', NOW() - interval '2 minute')`,
      [keeperId, convId, ids[1], ids[2]],
    )
    // also a distinct actor B only on a duplicate
    await run(
      `INSERT INTO message_reactions (message_id, conversation_id, actor_type, actor_id, emoji, created_at)
       VALUES ($1,$2,'customer','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','❤️', NOW() - interval '5 minute')`,
      [ids[1], convId],
    )

    await run(`SELECT dedupe_inbound_messages()`)
    await createIdx()

    // only 2 reactions remain (actor A once, actor B once), both on keeper
    const rows = await run(
      `SELECT message_id, actor_id FROM message_reactions WHERE conversation_id=$1 ORDER BY actor_id`,
      [convId],
    )
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.message_id === keeperId)).toBe(true)

    // actor A's keeper is the oldest duplicate's reaction (ids[2], created -2min)
    const aReact = rows.find((r) => r.actor_id === 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(aReact?.message_id).toBe(keeperId)
  })
})
