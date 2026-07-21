import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let db: PGlite

const SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  account_id UUID NOT NULL
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','agent','bot')),
  content_type TEXT,
  content_text TEXT,
  message_id TEXT,
  status TEXT,
  idempotency_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE message_external_ids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  connection_ref UUID NOT NULL,
  kind TEXT,
  value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION is_account_member(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_claims TEXT;
BEGIN
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN FALSE;
  END IF;
  v_user_id := NULLIF(v_claims::jsonb ->> 'sub', '')::UUID;
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = v_user_id AND account_id = p_account_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION can_access_account(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN is_account_member(p_account_id);
END;
$$;
`

function loadMigration(name: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  return readFileSync(join(dir, name), 'utf8')
}

function setAuth(userId: string | null) {
  if (userId) {
    return db.exec(
      `SELECT set_config('request.jwt.claims', '{"sub": "${userId}"}', false)`,
    )
  }
  return db.exec(
    `SELECT set_config('request.jwt.claims', '{}', false)`,
  )
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(loadMigration('048_outbound_delivery_integrity.sql'))
})

describe('settle_outbound_message (real Postgres)', () => {
  const ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const USER_ID = '00000000-0000-0000-0000-000000000001'
  const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  let convId: string
  let msgId: string

  beforeAll(async () => {
    await setAuth(USER_ID)
    await db.query(
      `INSERT INTO profiles (user_id, account_id) VALUES ($1, $2)`,
      [USER_ID, ACCOUNT_ID],
    )
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [ACCOUNT_ID],
    )
    convId = rows[0].id
    const { rows: mr } = await db.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'agent', 'text', 'hello', 'sending', gen_random_uuid()) RETURNING id`,
      [convId],
    )
    msgId = mr[0].id
  })

  it('transitions sending → sent', async () => {
    const { rows } = await db.query<{ r: string }>(
      `SELECT settle_outbound_message($1, $2, $3, $4, $5) AS r`,
      [msgId, 'sent', '00000000-0000-0000-0000-0000000000c1', 'wamid.sent-1', '[]'],
    )
    const result = JSON.parse(rows[0].r) as { messageId: string; outcome: string }
    expect(result.messageId).toBe(msgId)
    expect(result.outcome).toBe('sent')

    const { rows: statusRows } = await db.query<{ status: string; message_id: string }>(
      `SELECT status, message_id FROM messages WHERE id = $1`,
      [msgId],
    )
    expect(statusRows[0].status).toBe('sent')
    expect(statusRows[0].message_id).toBe('wamid.sent-1')
  })

  it('second settle returns noop when already sent', async () => {
    const { rows } = await db.query<{ r: string }>(
      `SELECT settle_outbound_message($1, $2, $3, $4, $5) AS r`,
      [msgId, 'sent', '00000000-0000-0000-0000-0000000000c1', 'wamid.noop', '[]'],
    )
    const result = JSON.parse(rows[0].r) as { messageId: string; outcome: string }
    expect(result.outcome).toBe('noop')

    const { rows: statusRows } = await db.query<{ status: string }>(
      `SELECT status FROM messages WHERE id = $1`,
      [msgId],
    )
    expect(statusRows[0].status).toBe('sent')
  })

  it('rejects cross-tenant access', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [OTHER_ACCOUNT],
    )
    const otherConv = rows[0].id
    const { rows: mr } = await db.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'agent', 'text', 'other', 'sending', gen_random_uuid()) RETURNING id`,
      [otherConv],
    )
    const otherMsg = mr[0].id
    await expect(
      db.query(`SELECT settle_outbound_message($1, $2, $3, $4, $5)`,
        [otherMsg, 'sent', null, 'wamid.other', '[]']),
    ).rejects.toThrow(/not authorized/i)
  })

  it('rejects invalid status', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [ACCOUNT_ID],
    )
    const c = rows[0].id
    const { rows: mr } = await db.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'agent', 'text', 'bad-status', 'sending', gen_random_uuid()) RETURNING id`,
      [c],
    )
    const m = mr[0].id
    await expect(
      db.query(`SELECT settle_outbound_message($1, $2, $3, $4, $5)`,
        [m, 'delivered', null, null, '[]']),
    ).rejects.toThrow(/invalid status/i)
  })

  it('rejects sent without provider_message_id', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [ACCOUNT_ID],
    )
    const c = rows[0].id
    const { rows: mr } = await db.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'agent', 'text', 'null-pm', 'sending', gen_random_uuid()) RETURNING id`,
      [c],
    )
    const m = mr[0].id
    await expect(
      db.query(`SELECT settle_outbound_message($1, $2, $3, $4, $5)`,
        [m, 'sent', null, null, '[]']),
    ).rejects.toThrow(/provider_message_id is required/i)
  })

  it('transitions sending → failed', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [ACCOUNT_ID],
    )
    const c = rows[0].id
    const { rows: mr } = await db.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'agent', 'text', 'will-fail', 'sending', gen_random_uuid()) RETURNING id`,
      [c],
    )
    const m = mr[0].id
    const { rows: resultRows } = await db.query<{ r: string }>(
      `SELECT settle_outbound_message($1, $2, $3, $4, $5) AS r`,
      [m, 'failed', null, null, '[]'],
    )
    const result = JSON.parse(resultRows[0].r) as { messageId: string; outcome: string }
    expect(result.outcome).toBe('failed')

    const { rows: statusRows } = await db.query<{ status: string }>(
      `SELECT status FROM messages WHERE id = $1`,
      [m],
    )
    expect(statusRows[0].status).toBe('failed')
  })

  it('noop when already failed', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [ACCOUNT_ID],
    )
    const c = rows[0].id
    const { rows: mr } = await db.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'agent', 'text', 'already-failed', 'failed', gen_random_uuid()) RETURNING id`,
      [c],
    )
    const m = mr[0].id
    const { rows: resultRows } = await db.query<{ r: string }>(
      `SELECT settle_outbound_message($1, $2, $3, $4, $5) AS r`,
      [m, 'failed', null, null, '[]'],
    )
    const result = JSON.parse(resultRows[0].r) as { messageId: string; outcome: string }
    expect(result.outcome).toBe('noop')
  })

  it('rejects when auth.uid() is not set', async () => {
    await setAuth(null)
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [ACCOUNT_ID],
    )
    const c = rows[0].id
    const { rows: mr } = await db.query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'agent', 'text', 'no-auth', 'sending', gen_random_uuid()) RETURNING id`,
      [c],
    )
    const m = mr[0].id
    await expect(
      db.query(`SELECT settle_outbound_message($1, $2, $3, $4, $5)`,
        [m, 'failed', null, null, '[]']),
    ).rejects.toThrow(/not authorized/i)
    await setAuth(USER_ID)
  })

  it('rejects when message does not exist', async () => {
    await expect(
      db.query(`SELECT settle_outbound_message($1, $2, $3, $4, $5)`,
        ['ffffffff-ffff-ffff-ffff-ffffffffffff', 'failed', null, null, '[]']),
    ).rejects.toThrow(/message not found/i)
  })
})
