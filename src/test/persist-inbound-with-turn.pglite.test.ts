import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import pg from 'pg'

/**
 * R1: persist_inbound_message_with_turn.
 * PGlite covers duplicate recovery. Atomic rollback under an injected failure
 * is asserted only when R1_PG_URL points at a real PostgreSQL server.
 */

const SCHEMA = `
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  sender_type TEXT NOT NULL,
  content_type TEXT,
  content_text TEXT,
  media_url TEXT,
  message_id TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reply_to_message_id UUID,
  interactive_reply_id TEXT
);
CREATE UNIQUE INDEX messages_inbound_identity
  ON messages (conversation_id, message_id)
  WHERE sender_type = 'customer' AND message_id IS NOT NULL AND message_id <> '';
CREATE TABLE inbound_turn_jobs (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  downstream_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION fail_job_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.fail_job_insert', true) = 'on' THEN
    RAISE EXCEPTION 'injected job failure';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_fail_job_insert
  BEFORE INSERT ON inbound_turn_jobs
  FOR EACH ROW EXECUTE FUNCTION fail_job_insert();
`

const FN = readFileSync(
  join(process.cwd(), 'supabase/migrations/091_persist_inbound_message_with_turn.sql'),
  'utf8',
)

const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACCT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function callSql(externalId: string) {
  return {
    text: `SELECT persist_inbound_message_with_turn(
      $1::uuid,'customer','text','hi',NULL,$2,'delivered',NOW(),NULL,NULL,
      $3::uuid,$4::uuid,'{"accountId":"x"}'::jsonb
    ) AS result`,
    values: [CONV, externalId, ACCT, CONTACT],
  }
}

describe('persist_inbound_message_with_turn (PGlite — not the atomicity proof)', () => {
  let db: PGlite

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(SCHEMA)
    await db.exec(FN)
  })

  afterAll(async () => {
    await db.close()
  })

  it('inserts the message and the job together, and a second call does not duplicate either', async () => {
    const first = await db.query<{ result: { message_id: string; message_inserted: boolean; job_ready: boolean } }>(
      callSql('wamid.1').text,
      callSql('wamid.1').values,
    )
    expect(first.rows[0].result.message_inserted).toBe(true)
    expect(first.rows[0].result.job_ready).toBe(true)
    const id = first.rows[0].result.message_id

    const second = await db.query<{ result: { message_id: string; message_inserted: boolean; job_ready: boolean } }>(
      callSql('wamid.1').text,
      callSql('wamid.1').values,
    )
    expect(second.rows[0].result.message_inserted).toBe(false)
    expect(second.rows[0].result.message_id).toBe(id)
    expect(second.rows[0].result.job_ready).toBe(true)

    const n = await db.query<{ messages: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM inbound_turn_jobs) AS jobs`,
    )
    expect(n.rows[0]).toEqual({ messages: 1, jobs: 1 })
  })

  it('recreates the job when the message already exists and the job does not', async () => {
    await db.exec(`DELETE FROM inbound_turn_jobs`)
    const again = await db.query<{ result: { message_inserted: boolean; job_ready: boolean } }>(
      callSql('wamid.1').text,
      callSql('wamid.1').values,
    )
    expect(again.rows[0].result.message_inserted).toBe(false)
    expect(again.rows[0].result.job_ready).toBe(true)
    const jobs = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM inbound_turn_jobs`)
    expect(jobs.rows[0].n).toBe(1)
    const messages = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages`)
    expect(messages.rows[0].n).toBe(1)
  })

  it('PGlite only: a failure while inserting the job rolls the message back (not a server proof)', async () => {
    await db.exec("SELECT set_config('app.fail_job_insert', 'on', false)")
    await expect(
      db.query(callSql('wamid.fail').text, callSql('wamid.fail').values),
    ).rejects.toThrow(/injected job failure/)
    await db.exec("SELECT set_config('app.fail_job_insert', 'off', false)")
    const left = await db.query<{ messages: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM messages WHERE message_id = 'wamid.fail') AS messages,
              (SELECT count(*)::int FROM inbound_turn_jobs j JOIN messages m ON m.id = j.message_id WHERE m.message_id = 'wamid.fail') AS jobs`,
    )
    expect(left.rows[0]).toEqual({ messages: 0, jobs: 0 })
  })
})

const pgUrl = process.env.R1_PG_URL
describe.skipIf(!pgUrl)('persist_inbound_message_with_turn (PostgreSQL server)', () => {
  const client = new pg.Client({ connectionString: pgUrl })

  beforeAll(async () => {
    await client.connect()
    await client.query('DROP TABLE IF EXISTS inbound_turn_jobs CASCADE')
    await client.query('DROP TABLE IF EXISTS messages CASCADE')
    await client.query('DROP FUNCTION IF EXISTS fail_job_insert() CASCADE')
    await client.query(SCHEMA)
    // Migration files wrap DDL in BEGIN/COMMIT after header comments; strip both
    // so CREATE FUNCTION is not left inside an open transaction that a later
    // ROLLBACK (atomicity probe) would undo.
    const body = FN.replace(/\bBEGIN\s*;/i, '').replace(/\bCOMMIT\s*;/i, '')
    await client.query(body)
  })

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS inbound_turn_jobs CASCADE')
    await client.query('DROP TABLE IF EXISTS messages CASCADE')
    await client.query('DROP FUNCTION IF EXISTS fail_job_insert() CASCADE')
    await client.query(`DROP FUNCTION IF EXISTS persist_inbound_message_with_turn(
      UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, UUID, UUID, JSONB
    )`)
    await client.end()
  })

  it('rolls back the message when the job insert fails inside the same function', async () => {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.fail_job_insert', 'on', true)")
    await expect(client.query(callSql('wamid.fail').text, callSql('wamid.fail').values)).rejects.toThrow(/injected job failure/)
    await client.query('ROLLBACK')

    const left = await client.query<{ messages: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM inbound_turn_jobs) AS jobs`,
    )
    expect(left.rows[0]).toEqual({ messages: 0, jobs: 0 })
  })

  it('keeps both rows when the injected failure is off', async () => {
    await client.query(callSql('wamid.ok').text, callSql('wamid.ok').values)
    const left = await client.query<{ messages: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM inbound_turn_jobs) AS jobs`,
    )
    expect(left.rows[0]).toEqual({ messages: 1, jobs: 1 })
  })

  it('recreates the job when the message already exists and the job does not', async () => {
    await client.query(`DELETE FROM inbound_turn_jobs`)
    const again = await client.query<{ result: { message_inserted: boolean; job_ready: boolean } }>(
      callSql('wamid.ok').text,
      callSql('wamid.ok').values,
    )
    expect(again.rows[0].result.message_inserted).toBe(false)
    expect(again.rows[0].result.job_ready).toBe(true)
    const left = await client.query<{ messages: number; jobs: number }>(
      `SELECT (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM inbound_turn_jobs) AS jobs`,
    )
    expect(left.rows[0]).toEqual({ messages: 1, jobs: 1 })
  })

  it('does not insert a second job or rewrite downstream_context on duplicate with job', async () => {
    await client.query(
      `UPDATE inbound_turn_jobs SET downstream_context = '{"kept":true}'::jsonb WHERE conversation_id = $1`,
      [CONV],
    )
    const again = await client.query<{ result: { message_inserted: boolean; job_ready: boolean } }>(
      callSql('wamid.ok').text,
      callSql('wamid.ok').values,
    )
    expect(again.rows[0].result.message_inserted).toBe(false)
    expect(again.rows[0].result.job_ready).toBe(true)
    const left = await client.query<{ messages: number; jobs: number; ctx: unknown }>(
      `SELECT
         (SELECT count(*)::int FROM messages) AS messages,
         (SELECT count(*)::int FROM inbound_turn_jobs) AS jobs,
         (SELECT downstream_context FROM inbound_turn_jobs LIMIT 1) AS ctx`,
    )
    expect(left.rows[0].messages).toBe(1)
    expect(left.rows[0].jobs).toBe(1)
    expect(left.rows[0].ctx).toEqual({ kept: true })
  })
})
