import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Commit 6.1 correção #7 — cobertura obrigatória de "Scheduler" (claim
// concorrente; retrying abandonado recuperado) e "Orphan Sweeper"
// (ledger existente não duplicar enqueue), contra Postgres real via
// PGlite — mesmo padrão de outbound-delivery-integrity.pglite.test.ts.

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

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

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

function parseResult(r: unknown): { messageId: string; enqueued?: boolean } {
  return typeof r === 'string' ? JSON.parse(r) : (r as { messageId: string; enqueued?: boolean })
}

async function makeMessage(accountId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO conversations (id, account_id) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [accountId],
  )
  const c = rows[0].id
  const { rows: mr } = await db.query<{ id: string }>(
    `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, idempotency_key)
     VALUES (gen_random_uuid(), $1, 'agent', 'text', 'hi', 'sending', gen_random_uuid()) RETURNING id`,
    [c],
  )
  return mr[0].id
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(loadMigration('049_outbound_retry_ledger.sql'))
  await db.exec(loadMigration('051_outbound_retry_enqueue.sql'))
  // Commit 6.1 correção #5 — factors enqueue_outbound_retry into
  // core/authenticated/system facades; loaded so the suite exercises
  // the refactored functions, not the pre-052 body.
  await db.exec(loadMigration('052_outbound_retry_enqueue_system.sql'))

  const USER_ID = '00000000-0000-0000-0000-000000000001'
  const ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  await db.exec(`SELECT set_config('request.jwt.claims', '{"sub": "${USER_ID}"}', false)`)
  await db.query(`INSERT INTO profiles (user_id, account_id) VALUES ($1, $2)`, [USER_ID, ACCOUNT_ID])
})

describe('enqueue_outbound_retry_system — dedup (Commit 6.1 correção #5/#7)', () => {
  const ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

  it('does not enforce auth.uid() (service_role trust boundary)', async () => {
    await db.exec(`SELECT set_config('request.jwt.claims', '{}', false)`)
    const msgId = await makeMessage(ACCOUNT_ID)
    const { rows } = await db.query<{ r: unknown }>(
      `SELECT enqueue_outbound_retry_system($1, $2, $3, $4) AS r`,
      [msgId, 'ambiguous', new Date().toISOString(), 'timeout'],
    )
    const result = parseResult(rows[0].r)
    expect(result.messageId).toBe(msgId)
    expect(result.enqueued).toBe(true)

    const { rows: ledgerRows } = await db.query<{ status: string }>(
      `SELECT status FROM outbound_retry_ledger WHERE message_id = $1`,
      [msgId],
    )
    expect(ledgerRows).toHaveLength(1)
  })

  it('a second enqueue for the same message_id does not create a duplicate row (ON CONFLICT DO NOTHING)', async () => {
    const msgId = await makeMessage(ACCOUNT_ID)
    await db.query(
      `SELECT enqueue_outbound_retry_system($1, $2, $3, $4)`,
      [msgId, 'ambiguous', new Date().toISOString(), 'first failure'],
    )
    // Simulate the orphan sweeper racing with an already-tracked message —
    // it must not duplicate the ledger row.
    await db.query(
      `SELECT enqueue_outbound_retry_system($1, $2, $3, $4)`,
      [msgId, 'deterministic_transient', new Date().toISOString(), 'second failure'],
    )
    const { rows } = await db.query<{ id: string; last_error: string }>(
      `SELECT id, last_error FROM outbound_retry_ledger WHERE message_id = $1`,
      [msgId],
    )
    expect(rows).toHaveLength(1)
    // ON CONFLICT DO NOTHING — the row keeps the FIRST enqueue's data.
    expect(rows[0].last_error).toBe('first failure')
  })

  it('rejects an invalid classification (same hardening as the authenticated facade)', async () => {
    const msgId = await makeMessage(ACCOUNT_ID)
    await expect(
      db.query(`SELECT enqueue_outbound_retry_system($1, $2, $3, $4)`,
        [msgId, 'not-a-real-classification', new Date().toISOString(), 'x']),
    ).rejects.toThrow(/invalid classification/i)
  })
})

describe('outbound_retry_ledger — claim-as-lock concurrency (Commit 6.1 correção #7, Scheduler)', () => {
  const ACCOUNT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  it('only one of two concurrent claim attempts on the same pending row succeeds', async () => {
    const msgId = await makeMessage(ACCOUNT_ID)
    await db.query(
      `SELECT enqueue_outbound_retry_system($1, $2, $3, $4)`,
      [msgId, 'deterministic_transient', new Date().toISOString(), 'due for retry'],
    )
    const { rows: ledgerRows } = await db.query<{ id: string }>(
      `SELECT id FROM outbound_retry_ledger WHERE message_id = $1`,
      [msgId],
    )
    const ledgerId = ledgerRows[0].id

    // Mirrors cron/route.ts's claim: UPDATE ... WHERE status = 'pending'
    // RETURNING id. Two "concurrent" attempts modeled as two sequential
    // calls against the same starting state — the CAS `WHERE` clause is
    // what makes this safe under true concurrency (only the first
    // statement to commit can match `status = 'pending'`).
    const claim1 = await db.query<{ id: string }>(
      `UPDATE outbound_retry_ledger SET status = 'retrying' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [ledgerId],
    )
    const claim2 = await db.query<{ id: string }>(
      `UPDATE outbound_retry_ledger SET status = 'retrying' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [ledgerId],
    )

    expect(claim1.rows).toHaveLength(1)
    expect(claim2.rows).toHaveLength(0)
  })

  it('reclaims a row stuck in retrying past the threshold, but leaves a freshly-claimed row alone', async () => {
    const stuckMsg = await makeMessage(ACCOUNT_ID)
    const freshMsg = await makeMessage(ACCOUNT_ID)

    await db.query(
      `SELECT enqueue_outbound_retry_system($1, $2, $3, $4)`,
      [stuckMsg, 'deterministic_transient', new Date().toISOString(), 'due'],
    )
    await db.query(
      `SELECT enqueue_outbound_retry_system($1, $2, $3, $4)`,
      [freshMsg, 'deterministic_transient', new Date().toISOString(), 'due'],
    )

    // Claim both (pending -> retrying), then backdate the "stuck" row's
    // updated_at to simulate a drainer that crashed 20 minutes ago.
    // The trigger recomputes updated_at on every UPDATE, so it must be
    // disabled for the one backdating statement.
    await db.query(
      `UPDATE outbound_retry_ledger SET status = 'retrying' WHERE message_id = $1`,
      [stuckMsg],
    )
    await db.query(
      `UPDATE outbound_retry_ledger SET status = 'retrying' WHERE message_id = $1`,
      [freshMsg],
    )
    await db.exec(`ALTER TABLE outbound_retry_ledger DISABLE TRIGGER set_updated_at`)
    await db.query(
      `UPDATE outbound_retry_ledger SET updated_at = NOW() - INTERVAL '20 minutes' WHERE message_id = $1`,
      [stuckMsg],
    )
    await db.exec(`ALTER TABLE outbound_retry_ledger ENABLE TRIGGER set_updated_at`)

    // Same reclaim query as orphan-sweep/route.ts's reclaimStuckRetrying,
    // with a 10-minute threshold (STUCK_RETRYING_THRESHOLD_MS).
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { rows: reclaimed } = await db.query<{ message_id: string }>(
      `UPDATE outbound_retry_ledger
         SET status = 'pending', next_attempt_at = NOW()
       WHERE status = 'retrying' AND updated_at < $1
       RETURNING message_id`,
      [cutoff],
    )

    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].message_id).toBe(stuckMsg)

    const { rows: freshRow } = await db.query<{ status: string }>(
      `SELECT status FROM outbound_retry_ledger WHERE message_id = $1`,
      [freshMsg],
    )
    expect(freshRow[0].status).toBe('retrying')
  })
})
