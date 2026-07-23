import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT current_user::TEXT
$$;

CREATE TABLE accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());

CREATE TABLE lead_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_channel TEXT NOT NULL DEFAULT 'ctwa_meta',
  ad_source_id TEXT,
  origin_message_id TEXT,
  campaign_id TEXT, campaign_name TEXT,
  adset_id TEXT, adset_name TEXT,
  ad_id TEXT, ad_name TEXT,
  placement TEXT,
  enriched_at TIMESTAMPTZ,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION is_account_member(target_account_id UUID, min_role TEXT DEFAULT 'viewer')
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM accounts WHERE id = target_account_id)
$$;

CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
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

let accountA: string
let accountB: string
let attrA1: string
let attrA2: string
let attrB1: string

beforeAll(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(loadMigration('056_enrichment_ledger.sql'))
  await db.exec('GRANT SELECT, UPDATE ON enrichment_ledger TO service_role;')

  const a = await run<{ id: string }>(`INSERT INTO accounts (name) VALUES ('Tenant A') RETURNING id`)
  accountA = a[0].id
  const b = await run<{ id: string }>(`INSERT INTO accounts (name) VALUES ('Tenant B') RETURNING id`)
  accountB = b[0].id

  // Create test attributions: A1 = eligible, A2 = eligible, B1 = eligible
  const aa1 = await run<{ id: string }>(
    `INSERT INTO lead_attributions (account_id, ad_source_id, origin_message_id) VALUES ($1,'act_123_ad_999','msg_a1') RETURNING id`,
    [accountA],
  )
  attrA1 = aa1[0].id
  const aa2 = await run<{ id: string }>(
    `INSERT INTO lead_attributions (account_id, ad_source_id, origin_message_id) VALUES ($1,'act_456_ad_888','msg_a2') RETURNING id`,
    [accountA],
  )
  attrA2 = aa2[0].id
  const ab1 = await run<{ id: string }>(
    `INSERT INTO lead_attributions (account_id, ad_source_id, origin_message_id) VALUES ($1,'act_789_ad_777','msg_b1') RETURNING id`,
    [accountB],
  )
  attrB1 = ab1[0].id
})

async function asServiceRole<T>(fn: () => Promise<T>): Promise<T> {
  await run(`SET ROLE service_role`)
  try {
    return await fn()
  } finally {
    await run(`RESET ROLE`)
  }
}

async function queryAsServiceRole<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return asServiceRole(() => run<T>(text, params))
}

describe('056 — enrichment ledger lifecycle', () => {
  it('enqueue_pending_attributions creates pending rows', async () => {
    const count = await asServiceRole(() =>
      run<{ enqueue_pending_attributions: number }>(`SELECT enqueue_pending_attributions()`),
    )
    expect(count[0].enqueue_pending_attributions).toBe(3)

    const rows = await queryAsServiceRole<{ status: string; account_id: string }>(
      `SELECT status, account_id FROM enrichment_ledger ORDER BY created_at ASC`,
    )
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
  })

  it('enqueue_pending_attributions is idempotent (second call adds none)', async () => {
    const count = await asServiceRole(() =>
      run<{ enqueue_pending_attributions: number }>(`SELECT enqueue_pending_attributions()`),
    )
    expect(count[0].enqueue_pending_attributions).toBe(0)
  })

  it('claim_enrichment_batch claims rows atomically', async () => {
    const claimed = await asServiceRole(() =>
      run<{ attribution_id: string; account_id: string; attempt_count: number }>(
        `SELECT * FROM claim_enrichment_batch(10)`,
      ),
    )
    expect(claimed.length).toBe(3)
    expect(claimed.every((r) => r.attempt_count === 0)).toBe(true)

    const rows = await queryAsServiceRole<{ status: string }>(
      `SELECT status FROM enrichment_ledger ORDER BY created_at ASC`,
    )
    expect(rows.every((r) => r.status === 'claimed')).toBe(true)
  })

  it('claim again with same batch returns nothing (already claimed)', async () => {
    const claimed = await asServiceRole(() =>
      run<{ attribution_id: string }>(
        `SELECT * FROM claim_enrichment_batch(10)`,
      ),
    )
    expect(claimed.length).toBe(0)
  })

  it('resolve_enrichment_success writes enrichment + transitions to completed', async () => {
    await asServiceRole(() =>
      run(`SELECT resolve_enrichment_success($1,'camp_1','Campaign A','adset_1','Adset A','ad_1','Ad A','feed')`,
        [attrA1],
      ),
    )

    const la = await run<{ campaign_id: string; campaign_name: string; enriched_at: string | null }>(
      `SELECT campaign_id, campaign_name, enriched_at FROM lead_attributions WHERE id = $1`,
      [attrA1],
    )
    expect(la[0].campaign_id).toBe('camp_1')
    expect(la[0].campaign_name).toBe('Campaign A')
    expect(la[0].enriched_at).not.toBeNull()

    const el = await queryAsServiceRole<{ status: string }>(
      `SELECT status FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrA1],
    )
    expect(el[0].status).toBe('completed')
  })

  it('resolve_enrichment_failure with permanent → failed_permanent', async () => {
    await asServiceRole(() =>
      run(`SELECT resolve_enrichment_failure($1,'permanent','object_not_found',1)`,
        [attrA2],
      ),
    )

    const el = await run<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrA2],
    )
    expect(el[0].status).toBe('failed_permanent')
    expect(el[0].last_error).toBe('object_not_found')

    const la = await run<{ enriched_at: string | null }>(
      `SELECT enriched_at FROM lead_attributions WHERE id = $1`,
      [attrA2],
    )
    expect(la[0].enriched_at).toBeNull()
  })

  it('resolve_enrichment_failure with transient → pending (retry eligible)', async () => {
    await asServiceRole(() =>
      run(`SELECT resolve_enrichment_failure($1,'transient','rate_limited',1)`,
        [attrB1],
      ),
    )

    const el = await queryAsServiceRole<{ status: string; attempt_count: number; last_error: string }>(
      `SELECT status, attempt_count, last_error FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrB1],
    )
    expect(el[0].status).toBe('pending')
    expect(el[0].attempt_count).toBe(1)
    expect(el[0].last_error).toBe('rate_limited')
  })

  it('reclaim_stuck_enrichment recovers stale claimed rows', async () => {
    // Force a row to 'claimed' with old locked_until
    await asServiceRole(() =>
      run(
        `UPDATE enrichment_ledger SET status = 'claimed', locked_until = NOW() - INTERVAL '10 minutes' WHERE attribution_id = $1`,
        [attrB1],
      ),
    )

    const reclaimed = await asServiceRole(() =>
      run<{ reclaim_stuck_enrichment: number }>(`SELECT reclaim_stuck_enrichment()`),
    )
    expect(reclaimed[0].reclaim_stuck_enrichment).toBe(1)

    const el = await queryAsServiceRole<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrB1],
    )
    expect(el[0].status).toBe('pending')
    expect(el[0].last_error).toBe('stale_claim')
  })

  it('expire_stale_enrichments moves past-TTL rows to expired', async () => {
    // Force a row to past TTL
    await asServiceRole(() =>
      run(
        `UPDATE enrichment_ledger SET ttl_expires_at = NOW() - INTERVAL '1 minute', status = 'pending' WHERE attribution_id = $1`,
        [attrB1],
      ),
    )

    const expired = await asServiceRole(() =>
      run<{ expire_stale_enrichments: number }>(`SELECT expire_stale_enrichments()`),
    )
    expect(expired[0].expire_stale_enrichments).toBe(1)

    const el = await queryAsServiceRole<{ status: string }>(
      `SELECT status FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrB1],
    )
    expect(el[0].status).toBe('expired')
  })
})

describe('056 — max attempts enforcement (§9.3)', () => {
  it('transient failure at attempt 10 → failed_permanent (not pending)', async () => {
    // attrB1 is currently expired from the previous test — enqueue attrA1 again
    // Use a new row that is pending
    const idResult = await run<{ id: string }>(
      `INSERT INTO lead_attributions (account_id, ad_source_id, origin_message_id) VALUES ($1,'act_999','msg_max') RETURNING id`,
      [accountA],
    )
    const attrMax = idResult[0].id

    await asServiceRole(() =>
      run(`SELECT enqueue_pending_attributions()`),
    )

    const claimed = await asServiceRole(() =>
      run<{ attribution_id: string }>(`SELECT * FROM claim_enrichment_batch(10)`),
    )
    expect(claimed.some((r) => r.attribution_id === attrMax)).toBe(true)

    // Resolve with attempt 10 — should become failed_permanent
    await asServiceRole(() =>
      run(`SELECT resolve_enrichment_failure($1,'transient','rate_limited',10)`,
        [attrMax],
      ),
    )

    const el = await queryAsServiceRole<{ status: string; last_outcome_class: string }>(
      `SELECT status, last_outcome_class FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrMax],
    )
    expect(el[0].status).toBe('failed_permanent')
    expect(el[0].last_outcome_class).toBe('permanent')
  })
})

describe('056 — CAS: resolve on non-claimed row is no-op', () => {
  it('resolve_enrichment_success on a pending row does not transition to completed', async () => {
    // attrA2 is failed_permanent — try to resolve it as success
    await asServiceRole(() =>
      run(
        `SELECT resolve_enrichment_success($1,'camp_x','Camp X',null,null,null,null,null)`,
        [attrA2],
      ),
    )

    const el = await queryAsServiceRole<{ status: string }>(
      `SELECT status FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrA2],
    )
    // Should still be failed_permanent — CAS prevented the transition
    expect(el[0].status).toBe('failed_permanent')
  })
})

describe('056 — observability (§15)', () => {
  it('ledger reflects state transitions for each row', async () => {
    // attrA1 should be completed from earlier test
    const a1 = await queryAsServiceRole<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrA1],
    )
    expect(a1[0].status).toBe('completed')

    // attrA2 should be failed_permanent
    const a2 = await queryAsServiceRole<{ status: string }>(
      `SELECT status FROM enrichment_ledger WHERE attribution_id = $1`,
      [attrA2],
    )
    expect(a2[0].status).toBe('failed_permanent')
  })

  it('get_enrichment_report returns correct counts', async () => {
    const report = await run<{ get_enrichment_report: Record<string, unknown> }>(
      `SELECT get_enrichment_report($1)`,
      [accountA],
    )
    const r = report[0].get_enrichment_report as Record<string, number>
    expect(r.total).toBe(3) // only account A rows (incl. max_attempts test row)
    expect(r.completed).toBe(1)
    expect(r.failed_permanent).toBe(2)
    expect(r.pending).toBe(0)
  })

  it('no captured columns are modified by enrichment', async () => {
    const la = await run<{ ad_source_id: string; origin_message_id: string; source_channel: string }>(
      `SELECT ad_source_id, origin_message_id, source_channel FROM lead_attributions WHERE id = $1`,
      [attrA1],
    )
    expect(la[0].ad_source_id).toBe('act_123_ad_999')
    expect(la[0].origin_message_id).toBe('msg_a1')
    expect(la[0].source_channel).toBe('ctwa_meta')
  })
})
