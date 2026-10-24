import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { U, seedWorld } from '@/test/support/full-migration-chain'
import { createChainDatabase, type ChainDatabase } from '@/test/support/pg-server-chain'
import { pgliteSupabaseWithQuery } from '@/test/support/pglite-supabase-query'
import type { SqlRunner } from '@/test/support/pglite-supabase-rpc'
import { buildDlqEnvelope, buildDlqErrorMessage } from '@/lib/whatsapp/inbound-dlq'

/**
 * Recovery and concurrency of the inbound turn pipeline on a REAL PostgreSQL server
 * (the complete 001..094 chain, several overlapping connections from a pool).
 *
 * Runs only when R1_PG_URL points at a LOOPBACK disposable server. Own database,
 * dropped at the end. No mock stands in for SQL; the only mocked module is the turn's
 * work itself (runInboundDownstreamForMessage), so the drain, the lease and the
 * substrate wrappers are the production code over the production functions.
 */

const adminUrl = process.env.R1_PG_URL

const state = vi.hoisted(() => ({ client: null as unknown }))
const { mockDownstream } = vi.hoisted(() => ({ mockDownstream: vi.fn() }))

vi.mock('@/lib/supabase/admin-client', () => ({ supabaseAdmin: () => state.client }))
vi.mock('@/lib/whatsapp/inbound-downstream', () => ({ runInboundDownstreamForMessage: mockDownstream }))

const { drainInboundTurnJobs } = await import('@/lib/agent/turn/drain')
const { runWithInboundTurnLease } = await import('@/lib/agent/turn/lease')
const substrate = await import('@/lib/agent/turn/substrate')

type Pair = { account: string; contact: string; conv: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe.skipIf(!adminUrl)('inbound turn recovery and concurrency (real PostgreSQL)', () => {
  let chain: ChainDatabase
  let world: Awaited<ReturnType<typeof seedWorld>>
  let seq = 0
  const BASE = Date.now() - 3_600_000
  const iso = (sec: number) => new Date(BASE + sec * 1000).toISOString()
  const ext = () => `wamid.rec.${++seq}`

  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  const pq = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await chain.pool.query(sql, params)).rows as T[]
  const n = async (sql: string, params: unknown[] = []) =>
    Number((await pq<{ n: string }>(`SELECT count(*) AS n ${sql}`, params))[0]!.n)

  async function newPair(): Promise<Pair> {
    const k = ++seq
    const contact = (
      await pq<{ id: string }>(
        `INSERT INTO contacts (user_id, account_id, name, phone) VALUES ($1, $2, 'rec', $3) RETURNING id`,
        [U.ownerA, world.accountA, `55119555${String(k).padStart(5, '0')}`],
      )
    )[0]!.id
    const conv = (
      await pq<{ id: string }>(`INSERT INTO conversations (user_id, account_id, contact_id) VALUES ($1, $2, $3) RETURNING id`, [
        U.ownerA,
        world.accountA,
        contact,
      ])
    )[0]!.id
    return { account: world.accountA, contact, conv }
  }

  async function persist(pair: Pair, externalId: string, messageSec: number): Promise<{ message_id: string; message_inserted: boolean }> {
    return (
      await pq<{ r: { message_id: string; message_inserted: boolean } }>(
        `SELECT persist_inbound_message_with_turn($1::uuid, 'customer', 'text', $2, NULL, $2, 'delivered', $3::timestamptz, NULL, NULL,
           $4::uuid, $5::uuid, '{}'::jsonb) AS r`,
        [pair.conv, externalId, iso(messageSec), pair.account, pair.contact],
      )
    )[0]!.r
  }

  const jobStatus = async (id: string) =>
    (await pq<{ status: string; attempt_count: number; last_error: string | null }>(`SELECT status, attempt_count, last_error FROM inbound_turn_jobs WHERE message_id = $1`, [id]))[0]
  const makeAvailable = (id: string) => pq(`UPDATE inbound_turn_jobs SET available_at = clock_timestamp() WHERE message_id = $1`, [id])
  const expireLease = (id: string) => pq(`UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() - INTERVAL '1 second' WHERE message_id = $1`, [id])

  beforeAll(async () => {
    chain = await createChainDatabase(adminUrl!, 'recovery', { poolMax: 8 })
    world = await seedWorld(chain.client as unknown as PGlite)
    state.client = pgliteSupabaseWithQuery(chain.pool as unknown as SqlRunner)
  })

  afterAll(async () => {
    await chain?.drop()
  })

  beforeEach(async () => {
    await pq(`DELETE FROM inbound_turn_jobs`)
    await pq(`DELETE FROM whatsapp_webhook_dlq`)
    mockDownstream.mockReset()
    mockDownstream.mockResolvedValue(undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  // ---------------------------------------------------------------- queue order, concurrent
  describe('the queue under overlapping workers', () => {
    it('six concurrent workers: one turn per contact at a time, every job once, and each contact runs in message order', async () => {
      const contacts = [await newPair(), await newPair(), await newPair(), await newPair()]
      const expected = new Map<string, string[]>() // contact -> message ids in message-time order
      const contactOf = new Map<string, string>()
      for (const pair of contacts) {
        const times = [1, 2, 3, 4, 5, 6].sort(() => Math.random() - 0.5) // arrival order unrelated to message order
        const byTime: Array<[number, string]> = []
        for (const t of times) {
          const r = await persist(pair, ext(), t)
          byTime.push([t, r.message_id])
          contactOf.set(r.message_id, pair.contact)
        }
        expected.set(pair.contact, byTime.sort((a, b) => a[0] - b[0]).map((x) => x[1]))
      }
      const total = contacts.length * 6

      const active = new Set<string>()
      const ran = new Map<string, string[]>()
      const violations: string[] = []
      let completed = 0

      const worker = async () => {
        while (completed < total) {
          const { rows } = await chain.pool.query<{ message_id: string; claim_token: string }>(`SELECT * FROM claim_inbound_turn_job(300)`)
          const claim = rows[0]
          if (!claim) {
            await sleep(2)
            continue
          }
          const contact = contactOf.get(claim.message_id)!
          if (active.has(contact)) violations.push(`overlap on ${contact}`)
          active.add(contact)
          await sleep(Math.floor(Math.random() * 8))
          active.delete(contact)
          ran.set(contact, [...(ran.get(contact) ?? []), claim.message_id])
          const ok = (
            await chain.pool.query<{ ok: boolean }>(`SELECT complete_inbound_turn_job($1, $2, true, NULL) AS ok`, [claim.message_id, claim.claim_token])
          ).rows[0]!.ok
          if (!ok) violations.push(`complete refused ${claim.message_id}`)
          completed++
        }
      }
      await Promise.all(Array.from({ length: 6 }, worker))

      expect(violations).toEqual([])
      for (const pair of contacts) expect(ran.get(pair.contact)).toEqual(expected.get(pair.contact))
      expect(await n(`FROM inbound_turn_jobs WHERE status <> 'completed'`)).toBe(0)
    })

    it('a gap filled while a newer message of the contact is processing waits for it, then runs next (late, never lost)', async () => {
      const pair = await newPair()
      const later = await persist(pair, ext(), 9)
      const w1 = await chain.connect()
      const w2 = await chain.connect()
      const running = (await w1.query<{ message_id: string; claim_token: string }>(`SELECT * FROM claim_inbound_turn_job(300)`)).rows[0]!
      expect(running.message_id).toBe(later.message_id)

      const earlier = await persist(pair, ext(), 8)
      expect((await w2.query(`SELECT * FROM claim_inbound_turn_job(300)`)).rows).toHaveLength(0)

      await w1.query(`SELECT complete_inbound_turn_job($1, $2, true, NULL)`, [later.message_id, running.claim_token])
      const next = (await w2.query<{ message_id: string }>(`SELECT * FROM claim_inbound_turn_job(300)`)).rows[0]
      expect(next?.message_id).toBe(earlier.message_id)
    })

    it('three concurrent drains (cron-like rounds) run every job exactly once, never two turns of a contact at once, in message order', async () => {
      const contacts = [await newPair(), await newPair(), await newPair(), await newPair()]
      const contactOf = new Map<string, string>()
      const expected = new Map<string, string[]>()
      for (const pair of contacts) {
        const byTime: Array<[number, string]> = []
        for (const t of [3, 1, 2]) {
          const r = await persist(pair, ext(), t)
          byTime.push([t, r.message_id])
          contactOf.set(r.message_id, pair.contact)
        }
        expected.set(pair.contact, byTime.sort((a, b) => a[0] - b[0]).map((x) => x[1]))
      }

      const active = new Set<string>()
      const ran = new Map<string, string[]>()
      const calls = new Map<string, number>()
      const violations: string[] = []
      mockDownstream.mockImplementation(async (messageId: string) => {
        const contact = contactOf.get(messageId)!
        if (active.has(contact)) violations.push(`overlap on ${contact}`)
        active.add(contact)
        calls.set(messageId, (calls.get(messageId) ?? 0) + 1)
        await sleep(5 + Math.floor(Math.random() * 10))
        ran.set(contact, [...(ran.get(contact) ?? []), messageId])
        active.delete(contact)
      })

      let processed = 0
      for (let round = 0; round < 30 && (await n(`FROM inbound_turn_jobs WHERE status <> 'completed'`)) > 0; round++) {
        const results = await Promise.all([drainInboundTurnJobs(), drainInboundTurnJobs(), drainInboundTurnJobs()])
        processed += results.reduce((sum, r) => sum + r.processed, 0)
        expect(results.every((r) => r.failed === 0)).toBe(true)
      }

      expect(violations).toEqual([])
      expect(processed).toBe(12)
      expect([...calls.values()].every((c) => c === 1)).toBe(true)
      expect(calls.size).toBe(12)
      for (const pair of contacts) expect(ran.get(pair.contact)).toEqual(expected.get(pair.contact))
      expect(await n(`FROM inbound_turn_jobs WHERE status <> 'completed'`)).toBe(0)
    })
  })

  // ---------------------------------------------------------------- durable intake, concurrent
  describe('the durable intake under concurrent deliveries', () => {
    it('eight concurrent deliveries of the same message store it once, create one job, and exactly one reports the insert', async () => {
      const pair = await newPair()
      const e = ext()

      const results = await Promise.all(Array.from({ length: 8 }, () => persist(pair, e, 1)))

      expect(results.filter((r) => r.message_inserted)).toHaveLength(1)
      expect(new Set(results.map((r) => r.message_id)).size).toBe(1)
      expect(await n(`FROM messages WHERE conversation_id = $1 AND message_id = $2`, [pair.conv, e])).toBe(1)
      expect(await n(`FROM inbound_turn_jobs WHERE message_id = $1`, [results[0]!.message_id])).toBe(1)
    })
  })

  // ---------------------------------------------------------------- conversation effect, concurrent
  describe('the conversation effect under concurrency', () => {
    it('twenty messages applied by overlapping connections move the unread counter by exactly twenty and leave the newest preview', async () => {
      const pair = await newPair()
      const ids: string[] = []
      for (let t = 1; t <= 20; t++) ids.push((await persist(pair, ext(), t)).message_id)

      const shuffled = [...ids.entries()].sort(() => Math.random() - 0.5)
      const applied = await Promise.all(
        shuffled.map(async ([i, id]) =>
          (await pq<{ ok: boolean }>(`SELECT apply_inbound_message_to_conversation($1::uuid, $2) AS ok`, [id, `message ${i + 1}`]))[0]!.ok,
        ),
      )

      expect(applied.every(Boolean)).toBe(true)
      const conv = (await pq<{ unread_count: number; last_message_text: string }>(`SELECT unread_count, last_message_text FROM conversations WHERE id = $1`, [pair.conv]))[0]!
      expect(conv).toEqual({ unread_count: 20, last_message_text: 'message 20' })
      expect(await n(`FROM inbound_turn_jobs WHERE conversation_effect_at IS NULL AND conversation_id = $1`, [pair.conv])).toBe(0)
    })

    it('the same message applied by six connections at once counts once', async () => {
      const pair = await newPair()
      const id = (await persist(pair, ext(), 1)).message_id

      const results = await Promise.all(
        Array.from({ length: 6 }, async () => (await pq<{ ok: boolean }>(`SELECT apply_inbound_message_to_conversation($1::uuid, 'x') AS ok`, [id]))[0]!.ok),
      )

      expect(results.filter(Boolean)).toHaveLength(1)
      expect((await pq<{ unread_count: number }>(`SELECT unread_count FROM conversations WHERE id = $1`, [pair.conv]))[0]!.unread_count).toBe(1)
    })
  })

  // ---------------------------------------------------------------- DLQ, concurrent
  describe('the DLQ under concurrency', () => {
    const enqueue = async (stage: string, externalId: string) =>
      (
        await pq<{ id: string }>(`SELECT enqueue_webhook_dlq($1::uuid, $2::uuid, $3::jsonb, $4) AS id`, [
          world.accountA,
          world.cfgA,
          JSON.stringify(buildDlqEnvelope('meta', stage as 'message_insert', { type: 'text', externalMessageId: externalId })),
          buildDlqErrorMessage('meta', stage as 'message_insert', 'P0001'),
        ])
      )[0]!.id

    it('twelve concurrent captures of the same failure leave one row counting twelve', async () => {
      const e = ext()
      const ids = await Promise.all(Array.from({ length: 12 }, () => enqueue('message_insert', e)))

      expect(new Set(ids).size).toBe(1)
      const rows = await pq<{ occurrences: number; status: string }>(`SELECT occurrences, status FROM whatsapp_webhook_dlq`)
      expect(rows).toEqual([{ occurrences: 12, status: 'pending' }])
    })

    it('captures racing with the message finally being stored never leave two pending rows and never lose a count', async () => {
      const pair = await newPair()
      const e = ext()
      await Promise.all([
        ...Array.from({ length: 6 }, () => enqueue('message_insert', e)),
        persist(pair, e, 1),
        ...Array.from({ length: 6 }, () => enqueue('message_insert', e)),
      ])

      const rows = await pq<{ occurrences: number; status: string }>(`SELECT occurrences, status FROM whatsapp_webhook_dlq`)
      expect(rows.filter((r) => r.status === 'pending').length).toBeLessThanOrEqual(1)
      expect(rows.length).toBeLessThanOrEqual(2)
      expect(rows.reduce((sum, r) => sum + r.occurrences, 0)).toBe(12)
    })
  })

  // ---------------------------------------------------------------- lease heartbeat, real clock
  describe('the lease heartbeat against the real renew function and a real clock', () => {
    async function claimWithShortLease(pair: Pair) {
      const id = (await persist(pair, ext(), 1)).message_id
      const claim = (await substrate.claimInboundTurnForMessage(id, 30))!
      await pq(`UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() + INTERVAL '2 seconds' WHERE message_id = $1`, [id])
      return { id, claim }
    }

    it('renews a lease that would have expired mid-work, so the turn can still be completed', async () => {
      const { id, claim } = await claimWithShortLease(await newPair())

      // lockSeconds 3 -> a renewal every second; each renewal asks for the SQL minimum (30 s).
      const out = await runWithInboundTurnLease(claim, () => sleep(2600), 3)

      expect(out.leaseHeld).toBe(true)
      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: true })).toBe(true)
      expect(await jobStatus(id)).toMatchObject({ status: 'completed', attempt_count: 1 })
    })

    it('control: without a renewal inside the window the same lease expires and the completion is refused', async () => {
      const { id, claim } = await claimWithShortLease(await newPair())

      const out = await runWithInboundTurnLease(claim, () => sleep(2600), 300) // first renewal only after 100 s

      expect(out.leaseHeld).toBe(true) // the helper cannot know yet...
      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: true })).toBe(false) // ...the database does
      expect(await jobStatus(id)).toMatchObject({ status: 'processing' })
    })

    it('a lease that is already gone is reported as lost by the first heartbeat', async () => {
      const { id, claim } = await claimWithShortLease(await newPair())
      await expireLease(id)

      const out = await runWithInboundTurnLease(claim, () => sleep(1500), 3)

      expect(out.leaseHeld).toBe(false)
    })
  })

  // ---------------------------------------------------------------- reclaim, concurrent
  describe('recovery of an abandoned turn by overlapping drains', () => {
    it('an expired lease is reclaimed once and the turn runs once, even when three drains race for it', async () => {
      const pair = await newPair()
      const id = (await persist(pair, ext(), 1)).message_id
      await substrate.claimInboundTurnForMessage(id, 300) // a worker that died
      await expireLease(id)

      const first = await Promise.all([drainInboundTurnJobs(), drainInboundTurnJobs(), drainInboundTurnJobs()])
      expect(first.reduce((sum, r) => sum + r.reclaimed, 0)).toBe(1)
      expect(await jobStatus(id)).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'lease_expired' })
      expect(mockDownstream).not.toHaveBeenCalled() // in backoff

      await makeAvailable(id)
      const second = await Promise.all([drainInboundTurnJobs(), drainInboundTurnJobs(), drainInboundTurnJobs()])
      expect(second.reduce((sum, r) => sum + r.processed, 0)).toBe(1)
      expect(mockDownstream).toHaveBeenCalledTimes(1)
      expect(mockDownstream).toHaveBeenCalledWith(id)
      expect(await jobStatus(id)).toMatchObject({ status: 'completed', attempt_count: 2 })
    })

    it('a turn that keeps failing is retried by whichever drain comes next and ends in failed after five attempts', async () => {
      const pair = await newPair()
      const id = (await persist(pair, ext(), 1)).message_id
      mockDownstream.mockRejectedValue(new Error('downstream down'))

      for (let attempt = 1; attempt <= 5; attempt++) {
        await makeAvailable(id)
        const results = await Promise.all([drainInboundTurnJobs(), drainInboundTurnJobs()])
        expect(results.reduce((sum, r) => sum + r.failed, 0)).toBe(1)
        expect((await jobStatus(id))!.attempt_count).toBe(attempt)
      }
      expect(await jobStatus(id)).toMatchObject({ status: 'failed', attempt_count: 5, last_error: 'downstream down' })
      expect(mockDownstream).toHaveBeenCalledTimes(5)
      void warnSpy
      void logSpy
    })
  })
})
