import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { readMigration } from '@/test/support/full-migration-chain'

/**
 * 088 under real overlapping transactions (separate server connections).
 * Runs only when R1_PG_URL points at a disposable PostgreSQL server
 * (scripts/diagnostics/r1-disposable-pg.mjs start). Each suite creates and drops
 * its own database; nothing else on the server is touched.
 */

const adminUrl = process.env.R1_PG_URL

const STUB = `
CREATE TABLE public.accounts (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
`

type Claim = { message_id: string; contact_id: string; claim_token: string }

async function createDb(admin: pg.Client, tag: string) {
  const name = `r1_turn_${tag}_${process.pid}_${Date.now()}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(adminUrl!)
  url.pathname = `/${name}`
  return { name, url: url.toString() }
}

async function dropDb(admin: pg.Client, name: string) {
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [
    name,
  ])
  await admin.query(`DROP DATABASE IF EXISTS ${name}`)
}

async function connect(url: string) {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  return c
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!adminUrl)('088 under overlapping transactions (PostgreSQL server)', () => {
  let admin: pg.Client
  let db: { name: string; url: string }
  const clients: pg.Client[] = []
  let c0: pg.Client
  let w1: pg.Client
  let w2: pg.Client
  let w3: pg.Client
  let account: string
  let conv: string

  async function contact() {
    return (await c0.query<{ id: string }>(`INSERT INTO contacts DEFAULT VALUES RETURNING id`)).rows[0]!.id
  }

  async function job(client: pg.Client, contactId: string, ageSec: number) {
    const id = (await client.query<{ id: string }>(`INSERT INTO messages DEFAULT VALUES RETURNING id`)).rows[0]!.id
    await client.query(`SELECT register_inbound_turn_job($1, $2, $3, $4, '{}'::jsonb)`, [id, account, contactId, conv])
    await client.query(`UPDATE inbound_turn_jobs SET created_at = NOW() - make_interval(secs => $2) WHERE message_id = $1`, [
      id,
      ageSec,
    ])
    return id
  }

  const claimNext = async (client: pg.Client) =>
    (await client.query<Claim>(`SELECT * FROM claim_inbound_turn_job(300)`)).rows[0]

  const status = async (id: string) =>
    (await c0.query<{ status: string }>(`SELECT status FROM inbound_turn_jobs WHERE message_id = $1`, [id])).rows[0]!.status

  beforeAll(async () => {
    admin = await connect(adminUrl!)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await admin.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
    }
    db = await createDb(admin, 'cc')
    c0 = await connect(db.url)
    await c0.query(STUB)
    await c0.query(readMigration('088'))
    for (let i = 0; i < 6; i++) clients.push(await connect(db.url))
    ;[w1, w2, w3] = clients
    account = (await c0.query<{ id: string }>(`INSERT INTO accounts DEFAULT VALUES RETURNING id`)).rows[0]!.id
    conv = (await c0.query<{ id: string }>(`INSERT INTO conversations DEFAULT VALUES RETURNING id`)).rows[0]!.id
  })

  afterAll(async () => {
    for (const c of [c0, ...clients]) await c?.end().catch(() => undefined)
    if (db) await dropDb(admin, db.name)
    await admin?.end()
  })

  beforeEach(async () => {
    await c0.query(`DELETE FROM inbound_turn_jobs`)
  })

  it('a claim held open on one pair neither stalls another pair nor lets its sibling through', async () => {
    const A = await contact()
    const B = await contact()
    const a1 = await job(c0, A, 30)
    const a2 = await job(c0, A, 20)
    const b1 = await job(c0, B, 10)

    await w1.query('BEGIN')
    expect((await claimNext(w1))?.message_id).toBe(a1)

    // a1 is row-locked and uncommitted; a2 is older than b1 but behind a1.
    expect((await claimNext(w2))?.message_id).toBe(b1)
    expect(await claimNext(w3)).toBeUndefined()
    await w1.query('COMMIT')

    expect([await status(a1), await status(a2), await status(b1)]).toEqual(['processing', 'pending', 'processing'])
  })

  it('revalidation after the advisory lock rejects a pair claimed by a transaction that committed meanwhile', async () => {
    const A = await contact()
    const y = await job(c0, A, 10)

    // x is OLDER than y but its insert commits only after w1 has claimed y.
    await c0.query('BEGIN')
    const x = await job(c0, A, 3600)
    await w1.query('BEGIN')
    const yClaim = (await claimNext(w1))!
    expect(yClaim.message_id).toBe(y)
    await c0.query('COMMIT')

    // w2's snapshot sees x as the pair head and y still pending: x passes the
    // SELECT filter, so w2 must wait on the pair lock held by w1 ...
    const w2pid = (await w2.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid
    const pending = claimNext(w2)
    let waited = false
    for (let i = 0; i < 50 && !waited; i++) {
      await sleep(20)
      const { rows } = await c0.query<{ wait_event_type: string | null }>(
        `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
        [w2pid],
      )
      waited = rows[0]?.wait_event_type === 'Lock'
    }
    expect(waited).toBe(true)

    // ... and, once w1 commits y as processing, reject x instead of running it concurrently.
    await w1.query('COMMIT')
    expect(await pending).toBeUndefined()
    expect([await status(x), await status(y)]).toEqual(['pending', 'processing'])

    await c0.query(`SELECT complete_inbound_turn_job($1, $2, true, NULL)`, [y, yClaim.claim_token])
    expect((await claimNext(w3))?.message_id).toBe(x)
  })

  it('stress: concurrent workers never run two turns of one pair and finish each pair in FIFO order', async () => {
    const pairs = [await contact(), await contact(), await contact()]
    const expected = new Map<string, string[]>()
    let age = 1000
    for (let n = 0; n < 6; n++) {
      for (const p of pairs) {
        const id = await job(c0, p, age--)
        expected.set(p, [...(expected.get(p) ?? []), id])
      }
    }
    const total = pairs.length * 6

    const active = new Set<string>()
    const done = new Map<string, string[]>()
    const violations: string[] = []
    let completed = 0

    const worker = async (client: pg.Client) => {
      while (completed < total) {
        const c = await claimNext(client)
        if (!c) {
          await sleep(2)
          continue
        }
        if (active.has(c.contact_id)) violations.push(c.message_id)
        active.add(c.contact_id)
        await sleep(Math.floor(Math.random() * 8))
        active.delete(c.contact_id)
        done.set(c.contact_id, [...(done.get(c.contact_id) ?? []), c.message_id])
        const ok = (
          await client.query<{ ok: boolean }>(`SELECT complete_inbound_turn_job($1, $2, true, NULL) AS ok`, [
            c.message_id,
            c.claim_token,
          ])
        ).rows[0]!.ok
        if (!ok) violations.push(`complete refused ${c.message_id}`)
        completed++
      }
    }

    await Promise.all(clients.slice(0, 5).map(worker))

    expect(violations).toEqual([])
    for (const p of pairs) expect(done.get(p)).toEqual(expected.get(p))
    const { rows } = await c0.query<{ n: number }>(`SELECT count(*)::int AS n FROM inbound_turn_jobs WHERE status <> 'completed'`)
    expect(rows[0]!.n).toBe(0)
  })

  it('reclaim skips an expired row another transaction holds instead of waiting on it', async () => {
    const A = await contact()
    const m = await job(c0, A, 10)
    await claimNext(w1)
    await c0.query(`UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() - INTERVAL '1 second' WHERE message_id = $1`, [
      m,
    ])

    // Expired and reclaimable, but row-locked by an open transaction.
    await w1.query('BEGIN')
    await w1.query(`SELECT 1 FROM inbound_turn_jobs WHERE message_id = $1 FOR UPDATE`, [m])
    await w2.query(`SET statement_timeout = '2s'`)
    expect((await w2.query<{ n: number }>(`SELECT reclaim_stuck_inbound_turn_jobs(0) AS n`)).rows[0]!.n).toBe(0)
    await w1.query('ROLLBACK')
    expect((await w2.query<{ n: number }>(`SELECT reclaim_stuck_inbound_turn_jobs(0) AS n`)).rows[0]!.n).toBe(1)
    await w2.query(`RESET statement_timeout`)
    expect(await status(m)).toBe('pending')
  })
})

describe.skipIf(!adminUrl)('applying 088 on a real server', () => {
  let admin: pg.Client
  const made: string[] = []

  beforeAll(async () => {
    admin = await connect(adminUrl!)
  })

  afterAll(async () => {
    for (const name of made) await dropDb(admin, name)
    await admin?.end()
  })

  const objects = async (c: pg.Client) =>
    (
      await c.query(`
        SELECT to_regclass('public.inbound_turn_jobs') IS NOT NULL AS jobs,
               to_regclass('public.inbound_conversation_turn_slots') IS NOT NULL AS slots,
               to_regprocedure('public.claim_inbound_turn_job(integer)') IS NOT NULL AS claim_fn,
               to_regprocedure('public.renew_inbound_turn_lease(uuid,uuid,integer)') IS NOT NULL AS renew_fn,
               (SELECT count(*)::int FROM pg_policy
                 WHERE polname IN ('inbound_turn_jobs_service', 'inbound_turn_slots_service')) AS policies`)
    ).rows[0]

  it('a failure in the last statement rolls back the whole file', async () => {
    const db = await createDb(admin, 'rb')
    made.push(db.name)
    const c = await connect(db.url)
    try {
      await c.query(STUB)
      await c.query(`CREATE FUNCTION public.reclaim_stuck_inbound_turn_jobs(integer) RETURNS text
                       LANGUAGE sql AS $$ SELECT 'pre-existing' $$`)
      await expect(c.query(readMigration('088'))).rejects.toThrow(/return type/i)
      await c.query('ROLLBACK').catch(() => undefined)
      expect(await objects(c)).toEqual({ jobs: false, slots: false, claim_fn: false, renew_fn: false, policies: 0 })
    } finally {
      await c.end()
    }
  })

  it('lock_timeout makes the file fail fast (and roll back) behind an open write on messages', async () => {
    const db = await createDb(admin, 'lt')
    made.push(db.name)
    const holder = await connect(db.url)
    const c = await connect(db.url)
    try {
      await holder.query(STUB)
      await holder.query('BEGIN')
      await holder.query(`INSERT INTO messages DEFAULT VALUES`)

      const started = Date.now()
      await expect(c.query(readMigration('088'))).rejects.toThrow(/lock timeout/i)
      const elapsed = Date.now() - started
      await c.query('ROLLBACK').catch(() => undefined)
      await holder.query('ROLLBACK')

      expect(elapsed).toBeGreaterThanOrEqual(4_500)
      expect(elapsed).toBeLessThan(15_000)
      expect(await objects(c)).toEqual({ jobs: false, slots: false, claim_fn: false, renew_fn: false, policies: 0 })

      // With the writer gone the same file applies cleanly.
      await c.query(readMigration('088'))
      expect(await objects(c)).toEqual({ jobs: true, slots: true, claim_fn: true, renew_fn: true, policies: 2 })
    } finally {
      await holder.end()
      await c.end()
    }
  })
})
