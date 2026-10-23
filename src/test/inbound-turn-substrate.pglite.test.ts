import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { bootChain, readMigration, seedWorld } from '@/test/support/full-migration-chain'
import type { PGlite } from '@electric-sql/pglite'

/**
 * 088 turn contract on PGlite (single connection: semantics, not true overlap).
 * Overlapping transactions are covered by inbound-turn-substrate.pg-server.test.ts.
 */

type Claim = { message_id: string; account_id: string; contact_id: string; claim_token: string }

function turnApi(db: PGlite) {
  return {
    async message(conversationId: string, externalId: string) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
         VALUES ($1, 'customer', 'text', 'hello', $2, 'delivered') RETURNING id`,
        [conversationId, externalId],
      )
      return rows[0]!.id
    },
    async job(world: { account: string; contact: string; conv: string }, externalId: string, ageSec: number) {
      const id = await this.message(world.conv, externalId)
      await db.query(
        `SELECT register_inbound_turn_job($1::uuid, $2::uuid, $3::uuid, $4::uuid, '{}'::jsonb)`,
        [id, world.account, world.contact, world.conv],
      )
      // Deterministic FIFO position.
      await db.query(
        `UPDATE inbound_turn_jobs SET created_at = NOW() - make_interval(secs => $2) WHERE message_id = $1`,
        [id, ageSec],
      )
      return id
    },
    async claimNext(): Promise<Claim | undefined> {
      const { rows } = await db.query<Claim>(`SELECT * FROM claim_inbound_turn_job(300)`)
      return rows[0]
    },
    async claimFor(messageId: string): Promise<Claim | undefined> {
      const { rows } = await db.query<Claim>(`SELECT * FROM claim_inbound_turn_for_message($1::uuid, 300)`, [
        messageId,
      ])
      return rows[0]
    },
    async complete(messageId: string, token: string, success: boolean, error: string | null = null) {
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT complete_inbound_turn_job($1::uuid, $2::uuid, $3, $4) AS ok`,
        [messageId, token, success, error],
      )
      return rows[0]!.ok
    },
    async renew(messageId: string, token: string, secs = 300) {
      const { rows } = await db.query<{ ok: boolean }>(
        `SELECT renew_inbound_turn_lease($1::uuid, $2::uuid, $3) AS ok`,
        [messageId, token, secs],
      )
      return rows[0]!.ok
    },
    async reclaim(grace = 0) {
      const { rows } = await db.query<{ n: number }>(`SELECT reclaim_stuck_inbound_turn_jobs($1) AS n`, [grace])
      return rows[0]!.n
    },
    async expireLease(messageId: string) {
      await db.query(
        `UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() - INTERVAL '1 second' WHERE message_id = $1`,
        [messageId],
      )
    },
    async makeAvailable(messageId: string) {
      await db.query(`UPDATE inbound_turn_jobs SET available_at = clock_timestamp() WHERE message_id = $1`, [
        messageId,
      ])
    },
    async row(messageId: string) {
      const { rows } = await db.query<{
        status: string
        attempt_count: number
        claim_token: string | null
        locked_until: string | null
        last_error: string | null
        completed_at: string | null
        delay_s: number
        lease_s: number | null
      }>(
        `SELECT status, attempt_count, claim_token, locked_until, last_error, completed_at,
                EXTRACT(EPOCH FROM available_at - clock_timestamp())::float8 AS delay_s,
                EXTRACT(EPOCH FROM locked_until - clock_timestamp())::float8 AS lease_s
           FROM inbound_turn_jobs WHERE message_id = $1`,
        [messageId],
      )
      return rows[0]!
    },
  }
}

describe('inbound turn substrate (088 / Q10)', () => {
  let db: PGlite
  let api: ReturnType<typeof turnApi>
  let A: { account: string; contact: string; conv: string }
  let B: { account: string; contact: string; conv: string }

  beforeAll(async () => {
    db = await bootChain(88)
    const world = await seedWorld(db)
    const pair = async (account: string, conv: string) => {
      const { rows } = await db.query<{ contact_id: string }>(`SELECT contact_id FROM conversations WHERE id = $1`, [
        conv,
      ])
      return { account, contact: rows[0]!.contact_id, conv }
    }
    A = await pair(world.accountA, world.convA)
    B = await pair(world.accountB, world.convB)
    api = turnApi(db)
  })

  beforeEach(async () => {
    await db.exec(`DELETE FROM inbound_turn_jobs`)
  })

  it('register is idempotent on message_id', async () => {
    const msgId = await api.message(A.conv, 'ext-reg-1')
    const reg = async () => {
      const { rows } = await db.query<{ register_inbound_turn_job: boolean }>(
        `SELECT register_inbound_turn_job($1::uuid, $2::uuid, $3::uuid, $4::uuid, '{}'::jsonb)`,
        [msgId, A.account, A.contact, A.conv],
      )
      return rows[0]!.register_inbound_turn_job
    }
    expect(await reg()).toBe(true)
    expect(await reg()).toBe(false)
  })

  it('a second claim on the same message gets nothing', async () => {
    const m = await api.job(A, 'ext-claim-1', 10)
    const [a, b] = await Promise.all([api.claimFor(m), api.claimFor(m)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect((await api.row(m)).status).toBe('processing')
  })

  it('a busy pair does not block the global queue; its own jobs stay FIFO', async () => {
    const a1 = await api.job(A, 'ext-fifo-a1', 30)
    const a2 = await api.job(A, 'ext-fifo-a2', 20)
    const b1 = await api.job(B, 'ext-fifo-b1', 10)

    const first = await api.claimNext()
    expect(first?.message_id).toBe(a1)

    // a2 is older than b1 but its pair is busy: skipped, not a global stall.
    const second = await api.claimNext()
    expect(second?.message_id).toBe(b1)
    expect(await api.claimNext()).toBeUndefined()
    expect(await api.claimFor(a2)).toBeUndefined()

    expect(await api.complete(a1, first!.claim_token, true)).toBe(true)
    const third = await api.claimNext()
    expect(third?.message_id).toBe(a2)
  })

  it('a newer job cannot be claimed before an older pending job of the same pair', async () => {
    const a1 = await api.job(A, 'ext-order-a1', 20)
    const a2 = await api.job(A, 'ext-order-a2', 10)
    expect(await api.claimFor(a2)).toBeUndefined()
    expect((await api.claimFor(a1))?.message_id).toBe(a1)
  })

  it('renewal: valid holder extends; wrong token, expired lease and finished job are refused', async () => {
    const m = await api.job(A, 'ext-renew-1', 10)
    const c = (await api.claimFor(m))!
    await db.query(
      `UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() + INTERVAL '40 seconds' WHERE message_id = $1`,
      [m],
    )
    expect(await api.renew(m, c.claim_token, 300)).toBe(true)
    expect((await api.row(m)).lease_s).toBeGreaterThan(290)

    expect(await api.renew(m, '00000000-0000-4000-8000-000000000000', 300)).toBe(false)

    await api.expireLease(m)
    expect(await api.renew(m, c.claim_token, 300)).toBe(false)

    const m2 = await api.job(B, 'ext-renew-2', 5)
    const c2 = (await api.claimFor(m2))!
    expect(await api.complete(m2, c2.claim_token, true)).toBe(true)
    expect(await api.renew(m2, c2.claim_token, 300)).toBe(false)
  })

  it('lease bounds are clamped to 30..3600 s', async () => {
    const m = await api.job(A, 'ext-clamp-1', 10)
    const { rows } = await db.query<{ claim_token: string }>(
      `SELECT * FROM claim_inbound_turn_for_message($1::uuid, 1)`,
      [m],
    )
    const lease = (await api.row(m)).lease_s!
    expect(lease).toBeGreaterThan(25)
    expect(lease).toBeLessThanOrEqual(30)
    expect(await api.renew(m, rows[0]!.claim_token, 999_999)).toBe(true)
    expect((await api.row(m)).lease_s!).toBeLessThanOrEqual(3600)
  })

  it('an old worker cannot complete or renew after losing the lease, before or after a new claim', async () => {
    const m = await api.job(A, 'ext-stale-1', 10)
    const old = (await api.claimFor(m))!
    await api.expireLease(m)

    // Expired but not yet reclaimed: still refused.
    expect(await api.complete(m, old.claim_token, true)).toBe(false)
    expect(await api.renew(m, old.claim_token)).toBe(false)

    expect(await api.reclaim()).toBe(1)
    const reclaimed = await api.row(m)
    expect(reclaimed).toMatchObject({ status: 'pending', claim_token: null, locked_until: null, last_error: 'lease_expired' })

    await api.makeAvailable(m)
    const fresh = (await api.claimFor(m))!
    expect(fresh.claim_token).not.toBe(old.claim_token)
    expect(await api.complete(m, old.claim_token, true)).toBe(false)
    expect(await api.complete(m, old.claim_token, false, 'late')).toBe(false)
    expect((await api.row(m)).status).toBe('processing')
    expect(await api.complete(m, fresh.claim_token, true)).toBe(true)
    expect((await api.row(m)).status).toBe('completed')
  })

  it('an expired job blocks its pair until reclaimed, then resumes first', async () => {
    const a1 = await api.job(A, 'ext-exp-a1', 20)
    const a2 = await api.job(A, 'ext-exp-a2', 10)
    await api.claimFor(a1)
    await api.expireLease(a1)
    expect(await api.claimNext()).toBeUndefined()
    expect(await api.claimFor(a2)).toBeUndefined()

    await api.reclaim()
    await api.makeAvailable(a1)
    expect((await api.claimNext())?.message_id).toBe(a1)
  })

  it('reclaim leaves valid leases alone and honours the grace period', async () => {
    const m = await api.job(A, 'ext-grace-1', 10)
    await api.claimFor(m)
    expect(await api.reclaim()).toBe(0)
    await db.query(
      `UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() - INTERVAL '30 seconds' WHERE message_id = $1`,
      [m],
    )
    expect(await api.reclaim(120)).toBe(0)
    expect(await api.reclaim(10)).toBe(1)
  })

  it('complete(false) retries with backoff and fails terminally on the 5th attempt', async () => {
    const m = await api.job(A, 'ext-retry-1', 10)
    const expectedDelay = [30, 60, 120, 240]
    for (let attempt = 1; attempt <= 4; attempt++) {
      await api.makeAvailable(m)
      const c = (await api.claimFor(m))!
      expect(await api.complete(m, c.claim_token, false, `boom ${attempt}`)).toBe(true)
      const r = await api.row(m)
      expect(r).toMatchObject({ status: 'pending', attempt_count: attempt, claim_token: null, last_error: `boom ${attempt}` })
      expect(r.delay_s).toBeGreaterThan(expectedDelay[attempt - 1]! - 5)
      expect(r.delay_s).toBeLessThanOrEqual(expectedDelay[attempt - 1]!)
      // Backoff is honoured.
      expect(await api.claimFor(m)).toBeUndefined()
    }
    await api.makeAvailable(m)
    const last = (await api.claimFor(m))!
    expect(await api.complete(m, last.claim_token, false, 'boom 5')).toBe(true)
    const r = await api.row(m)
    expect(r).toMatchObject({ status: 'failed', attempt_count: 5, claim_token: null, last_error: 'boom 5' })
    expect(r.completed_at).not.toBeNull()

    await api.makeAvailable(m)
    expect(await api.claimFor(m)).toBeUndefined()
    expect(await api.claimNext()).toBeUndefined()
  })

  it('expired leases follow the same cap: crash loop ends in failed', async () => {
    const m = await api.job(A, 'ext-crash-1', 10)
    for (let attempt = 1; attempt <= 5; attempt++) {
      await api.makeAvailable(m)
      expect(await api.claimFor(m)).toBeDefined()
      await api.expireLease(m)
      expect(await api.reclaim()).toBe(1)
      const r = await api.row(m)
      expect(r.attempt_count).toBe(attempt)
      expect(r.status).toBe(attempt < 5 ? 'pending' : 'failed')
    }
    expect((await api.row(m)).last_error).toBe('lease_expired_max_attempts')
    await api.makeAvailable(m)
    expect(await api.claimFor(m)).toBeUndefined()
  })

  it('failed and completed jobs release their pair; a job in backoff holds it', async () => {
    const a1 = await api.job(A, 'ext-rel-a1', 30)
    const a2 = await api.job(A, 'ext-rel-a2', 20)
    const b1 = await api.job(B, 'ext-rel-b1', 10)

    const c1 = (await api.claimFor(a1))!
    await api.complete(a1, c1.claim_token, false, 'transient')
    // a1 waits 30 s: a2 must not overtake it, B is unaffected.
    expect(await api.claimFor(a2)).toBeUndefined()
    expect((await api.claimNext())?.message_id).toBe(b1)

    await db.query(`UPDATE inbound_turn_jobs SET status = 'failed', completed_at = NOW() WHERE message_id = $1`, [a1])
    expect((await api.claimNext())?.message_id).toBe(a2)
  })

  it('every 088 function is SECURITY DEFINER, pinned search_path, service_role only', async () => {
    const { rows } = await db.query<{
      proname: string
      prosecdef: boolean
      proconfig: string[] | null
      owner: string
      anon: boolean
      authn: boolean
      svc: boolean
      public_exec: boolean
    }>(`
      SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('register_inbound_turn_job', 'claim_inbound_turn_job', 'claim_inbound_turn_for_message',
                           'renew_inbound_turn_lease', 'complete_inbound_turn_job', 'reclaim_stuck_inbound_turn_jobs')
       ORDER BY p.proname`)
    expect(rows).toHaveLength(6)
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({
        prosecdef: true,
        proconfig: ['search_path=public'],
        owner: 'postgres',
        anon: false,
        authn: false,
        svc: true,
        public_exec: false,
      })
    }
  })

  it('tables: RLS on, one service_role policy each, no API-role table grants', async () => {
    const { rows } = await db.query<{ relname: string; rls: boolean; policies: number; anon: boolean; authn: boolean }>(`
      SELECT c.relname, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
             has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS anon,
             has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS authn
        FROM pg_class c
       WHERE c.oid IN ('public.inbound_turn_jobs'::regclass, 'public.inbound_conversation_turn_slots'::regclass)
       ORDER BY c.relname`)
    expect(rows).toEqual([
      { relname: 'inbound_conversation_turn_slots', rls: true, policies: 1, anon: false, authn: false },
      { relname: 'inbound_turn_jobs', rls: true, policies: 1, anon: false, authn: false },
    ])
  })

  it('the processing invariant is enforced by a CHECK constraint', async () => {
    const m = await api.job(A, 'ext-check-1', 10)
    await expect(db.query(`UPDATE inbound_turn_jobs SET status = 'processing' WHERE message_id = $1`, [m])).rejects.toThrow(
      /inbound_turn_jobs_processing_has_lease/,
    )
  })
})

describe('088 applies atomically', () => {
  it('a failure late in the file leaves none of 088 behind', async () => {
    const db = await bootChain(87)
    // Same identity, different return type: the last CREATE OR REPLACE in 088 fails.
    await db.exec(`CREATE FUNCTION public.reclaim_stuck_inbound_turn_jobs(integer) RETURNS text
                     LANGUAGE sql AS $$ SELECT 'pre-existing' $$`)
    await expect(db.exec(readMigration('088'))).rejects.toThrow(/return type/i)
    await db.exec('ROLLBACK').catch(() => undefined)

    const { rows } = await db.query<Record<string, unknown>>(`
      SELECT to_regclass('public.inbound_turn_jobs') AS jobs,
             to_regclass('public.inbound_conversation_turn_slots') AS slots,
             to_regprocedure('public.claim_inbound_turn_job(integer)') AS claim_fn,
             to_regprocedure('public.renew_inbound_turn_lease(uuid,uuid,integer)') AS renew_fn,
             (SELECT count(*)::int FROM pg_policy WHERE polname IN ('inbound_turn_jobs_service', 'inbound_turn_slots_service')) AS policies,
             (SELECT public.reclaim_stuck_inbound_turn_jobs(1)) AS untouched`)
    expect(rows[0]).toEqual({
      jobs: null,
      slots: null,
      claim_fn: null,
      renew_fn: null,
      policies: 0,
      untouched: 'pre-existing',
    })
  })
})

describe('088 with the local 089–091 chain and the TypeScript callers', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await bootChain(91)
  })

  it('091 persists a job that the 088 claim/complete cycle accepts', async () => {
    const world = await seedWorld(db)
    const { rows: conv } = await db.query<{ contact_id: string }>(`SELECT contact_id FROM conversations WHERE id = $1`, [
      world.convA,
    ])
    const { rows } = await db.query<{ r: { message_id: string; job_ready: boolean } }>(
      `SELECT persist_inbound_message_with_turn(
         $1::uuid, 'customer', 'text', 'hi', NULL, 'wamid.compat', 'delivered', NOW(), NULL, NULL,
         $2::uuid, $3::uuid, '{}'::jsonb) AS r`,
      [world.convA, world.accountA, conv[0]!.contact_id],
    )
    expect(rows[0]!.r.job_ready).toBe(true)
    const id = rows[0]!.r.message_id

    const job = await db.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count FROM inbound_turn_jobs WHERE message_id = $1`,
      [id],
    )
    expect(job.rows[0]).toEqual({ status: 'pending', attempt_count: 0 })

    const claim = await db.query<{ claim_token: string }>(`SELECT * FROM claim_inbound_turn_job(300)`)
    expect(claim.rows).toHaveLength(1)
    const done = await db.query<{ ok: boolean }>(`SELECT complete_inbound_turn_job($1::uuid, $2::uuid, true, NULL) AS ok`, [
      id,
      claim.rows[0]!.claim_token,
    ])
    expect(done.rows[0]!.ok).toBe(true)
  })

  it('native agent flag stays off by default after the chain', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM accounts WHERE native_conversational_agent_enabled`,
    )
    expect(rows[0]!.n).toBe(0)
  })

  it('every rpc() in substrate.ts matches exactly one function and its named parameters', async () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/agent/turn/substrate.ts'), 'utf8')
    const calls = [...src.matchAll(/\.rpc\('(\w+)',\s*\{([\s\S]*?)\}\)/g)].map((m) => ({
      fn: m[1]!,
      params: [...m[2]!.matchAll(/(p_\w+)\s*:/g)].map((p) => p[1]!).sort(),
    }))
    expect(calls.map((c) => c.fn).sort()).toEqual(
      [
        'claim_inbound_turn_for_message',
        'claim_inbound_turn_job',
        'complete_inbound_turn_job',
        'persist_inbound_message_with_turn',
        'reclaim_stuck_inbound_turn_jobs',
        'register_inbound_turn_job',
        'renew_inbound_turn_lease',
      ].sort(),
    )
    for (const call of calls) {
      const { rows } = await db.query<{ names: string[] }>(
        `SELECT p.proargnames[1:p.pronargs] AS names
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [call.fn],
      )
      expect(rows, call.fn).toHaveLength(1)
      expect([...rows[0]!.names].sort(), call.fn).toEqual(call.params)
    }
  })
})
