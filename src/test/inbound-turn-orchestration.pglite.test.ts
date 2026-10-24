import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain, seedWorld } from '@/test/support/full-migration-chain'
import { pgliteSupabaseWithRpc } from '@/test/support/pglite-supabase-rpc'

/**
 * T4b — the TypeScript inbound-turn code over the REAL 088–091 SQL (PGlite).
 *
 * Real: substrate.ts, finish.ts, lease.ts, drain.ts, process-message-turn.ts and
 * every SQL function. Mocked: only runInboundDownstreamForMessage (the turn's
 * work). Time is moved with explicit timestamps in SQL (no sleeps, no fake
 * timers). The SQL rules themselves are covered in inbound-turn-substrate.pglite
 * .test.ts; here we check that the TS callers and the SQL agree and that the
 * finish.ts contracts hold against real job state.
 *
 * The only injected fault is a transport-level RPC error (the response never
 * arrives), applied to the named RPC; everything else reaches Postgres.
 */

type RpcFault = { message: string; code?: string }
const state = vi.hoisted(() => ({
  rpcLog: [] as Array<{ name: string; args: Record<string, unknown> }>,
  fault: null as null | ((name: string, args: Record<string, unknown>) => RpcFault | null),
}))
const { mockDownstream } = vi.hoisted(() => ({ mockDownstream: vi.fn() }))

let testDb: PGlite

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => {
    const real = pgliteSupabaseWithRpc(testDb)
    return {
      ...real,
      async rpc(name: string, args: Record<string, unknown> = {}) {
        state.rpcLog.push({ name, args })
        const fault = state.fault?.(name, args)
        if (fault) return { data: null, error: fault }
        return real.rpc(name, args)
      },
    }
  },
}))
vi.mock('@/lib/whatsapp/inbound-downstream', () => ({
  runInboundDownstreamForMessage: mockDownstream,
}))

const substrate = await import('@/lib/agent/turn/substrate')
const { drainInboundTurnJobs } = await import('@/lib/agent/turn/drain')
const { processInboundTurnForMessage } = await import('@/lib/agent/turn/process-message-turn')

type Pair = { account: string; contact: string; conv: string }
type JobRow = {
  status: string
  attempt_count: number
  claim_token: string | null
  last_error: string | null
  completed_at: Date | null
  lease_s: number | null
  delay_s: number
  downstream_context: Record<string, unknown>
}

const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999'

describe('inbound turn: TypeScript over SQL (088–091)', () => {
  let A: Pair
  let B: Pair
  let seq = 0
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  const ext = () => `wamid.t4b.${++seq}`

  function persistArgs(pair: Pair, over: Partial<Parameters<typeof substrate.persistInboundMessageWithTurn>[0]> = {}) {
    return {
      conversationId: pair.conv,
      contentType: 'text',
      contentText: 'hello',
      mediaUrl: null,
      externalMessageId: ext(),
      createdAt: '2026-10-23T12:00:00.000Z',
      replyToMessageId: null,
      interactiveReplyId: null,
      accountId: pair.account,
      contactId: pair.contact,
      downstreamContext: { marker: 'ctx' },
      ...over,
    }
  }

  /** Persists a message + job; `ageSec` fixes the FIFO position (older = larger). */
  async function persist(pair: Pair, ageSec = 0, over: Parameters<typeof persistArgs>[1] = {}) {
    const res = await substrate.persistInboundMessageWithTurn(persistArgs(pair, over))
    if (ageSec) {
      await testDb.query(
        `UPDATE inbound_turn_jobs SET created_at = NOW() - make_interval(secs => $2) WHERE message_id = $1`,
        [res.messageId, ageSec],
      )
    }
    return res.messageId
  }

  async function row(messageId: string): Promise<JobRow> {
    const { rows } = await testDb.query<JobRow>(
      `SELECT status, attempt_count, claim_token, last_error, completed_at, downstream_context,
              EXTRACT(EPOCH FROM locked_until - clock_timestamp())::float8 AS lease_s,
              EXTRACT(EPOCH FROM available_at - clock_timestamp())::float8 AS delay_s
         FROM inbound_turn_jobs WHERE message_id = $1`,
      [messageId],
    )
    return rows[0]!
  }

  const count = async (sql: string, params: unknown[]) =>
    (await testDb.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n

  const expireLease = (id: string) =>
    testDb.query(`UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() - INTERVAL '1 second' WHERE message_id = $1`, [id])
  const makeAvailable = (id: string) =>
    testDb.query(`UPDATE inbound_turn_jobs SET available_at = clock_timestamp() WHERE message_id = $1`, [id])
  const setAttempts = (id: string, n: number) =>
    testDb.query(`UPDATE inbound_turn_jobs SET attempt_count = $2 WHERE message_id = $1`, [id, n])

  const completeCalls = () => state.rpcLog.filter((c) => c.name === 'complete_inbound_turn_job')

  beforeAll(async () => {
    testDb = await bootChain(9999)
    const world = await seedWorld(testDb)
    const pair = async (account: string, conv: string): Promise<Pair> => ({
      account,
      conv,
      contact: (
        await testDb.query<{ contact_id: string }>(`SELECT contact_id FROM conversations WHERE id = $1`, [conv])
      ).rows[0]!.contact_id,
    })
    A = await pair(world.accountA, world.convA)
    B = await pair(world.accountB, world.convB)
  })

  beforeEach(async () => {
    await testDb.exec(`DELETE FROM inbound_turn_jobs`)
    state.rpcLog.length = 0
    state.fault = null
    mockDownstream.mockReset()
    mockDownstream.mockResolvedValue(undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  // ---------------------------------------------------------------- 1, 2, 9
  describe('persist (091)', () => {
    it('stores the message and a pending job together, with the context as jsonb', async () => {
      const externalMessageId = ext()
      const res = await substrate.persistInboundMessageWithTurn(
        persistArgs(A, { externalMessageId, downstreamContext: { accountId: A.account, nested: { n: 1 } } }),
      )
      expect(res).toMatchObject({ messageInserted: true, jobReady: true })

      const msg = await testDb.query(
        `SELECT conversation_id, sender_type, content_type, content_text, message_id, status FROM messages WHERE id = $1`,
        [res.messageId],
      )
      expect(msg.rows[0]).toEqual({
        conversation_id: A.conv,
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'hello',
        message_id: externalMessageId,
        status: 'delivered',
      })
      expect(await row(res.messageId)).toMatchObject({
        status: 'pending',
        attempt_count: 0,
        claim_token: null,
        downstream_context: { accountId: A.account, nested: { n: 1 } },
      })
      const ids = await testDb.query(
        `SELECT account_id, contact_id, conversation_id FROM inbound_turn_jobs WHERE message_id = $1`,
        [res.messageId],
      )
      expect(ids.rows[0]).toEqual({ account_id: A.account, contact_id: A.contact, conversation_id: A.conv })
    })

    it('sends all 13 arguments with their real types (uuid reply, timestamptz, media, interactive id)', async () => {
      const original = await persist(A)
      const res = await substrate.persistInboundMessageWithTurn(
        persistArgs(A, {
          mediaUrl: '/api/whatsapp/media/abc',
          interactiveReplyId: 'btn-1',
          replyToMessageId: original,
          createdAt: '2026-10-22T10:11:12.000Z',
          contentText: null,
        }),
      )
      const { rows } = await testDb.query<{
        media_url: string
        interactive_reply_id: string
        reply_to_message_id: string
        content_text: string | null
        created_at: Date
      }>(`SELECT media_url, interactive_reply_id, reply_to_message_id, content_text, created_at FROM messages WHERE id = $1`, [
        res.messageId,
      ])
      expect(rows[0]!.media_url).toBe('/api/whatsapp/media/abc')
      expect(rows[0]!.interactive_reply_id).toBe('btn-1')
      expect(rows[0]!.reply_to_message_id).toBe(original)
      expect(rows[0]!.content_text).toBeNull()
      expect(rows[0]!.created_at.toISOString()).toBe('2026-10-22T10:11:12.000Z')
    })

    it('deduplicates the same message: same ids, one message, one job', async () => {
      const args = persistArgs(A)
      const first = await substrate.persistInboundMessageWithTurn(args)
      const dup = await substrate.persistInboundMessageWithTurn({ ...args, downstreamContext: { marker: 'second' } })

      expect(first.messageInserted).toBe(true)
      expect(dup).toEqual({ messageId: first.messageId, messageInserted: false, jobReady: true })
      expect(await count(`FROM messages WHERE conversation_id = $1 AND message_id = $2`, [A.conv, args.externalMessageId])).toBe(1)
      expect(await count(`FROM inbound_turn_jobs WHERE message_id = $1`, [first.messageId])).toBe(1)
      // The duplicate does not rewrite the stored context.
      expect((await row(first.messageId)).downstream_context).toEqual({ marker: 'ctx' })
    })

    it('a duplicate does not reset a job that is already being processed', async () => {
      const args = persistArgs(A)
      const first = await substrate.persistInboundMessageWithTurn(args)
      const claim = await substrate.claimInboundTurnForMessage(first.messageId, 300)

      await substrate.persistInboundMessageWithTurn(args)
      expect(await row(first.messageId)).toMatchObject({ status: 'processing', attempt_count: 1, claim_token: claim!.claimToken })
    })

    it('a duplicate recreates a missing job (message durable, job lost)', async () => {
      const args = persistArgs(A)
      const first = await substrate.persistInboundMessageWithTurn(args)
      await testDb.query(`DELETE FROM inbound_turn_jobs WHERE message_id = $1`, [first.messageId])

      const dup = await substrate.persistInboundMessageWithTurn({ ...args, downstreamContext: { marker: 'recovered' } })
      expect(dup).toEqual({ messageId: first.messageId, messageInserted: false, jobReady: true })
      expect(await row(first.messageId)).toMatchObject({ status: 'pending', downstream_context: { marker: 'recovered' } })
    })

    it('the same external id in another conversation is a different message', async () => {
      const externalMessageId = ext()
      const a = await substrate.persistInboundMessageWithTurn(persistArgs(A, { externalMessageId }))
      const b = await substrate.persistInboundMessageWithTurn(persistArgs(B, { externalMessageId }))
      expect(b.messageInserted).toBe(true)
      expect(b.messageId).not.toBe(a.messageId)
    })
  })

  // ---------------------------------------------------------------- 3
  describe('register, claim and lease', () => {
    it('register is idempotent: true for a new job, false when it exists', async () => {
      const { rows } = await testDb.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
         VALUES ($1, 'customer', 'text', 'x', $2, 'delivered') RETURNING id`,
        [A.conv, ext()],
      )
      const args = { messageId: rows[0]!.id, accountId: A.account, contactId: A.contact, conversationId: A.conv }

      expect(await substrate.registerInboundTurnJob({ ...args, downstreamContext: { k: 1 } })).toBe(true)
      expect(await substrate.registerInboundTurnJob(args)).toBe(false)
      expect((await row(args.messageId)).downstream_context).toEqual({ k: 1 })
    })

    it('claim by message maps the identity, issues a token and a 300 s lease, counts the attempt', async () => {
      const id = await persist(A)
      const claim = await substrate.claimInboundTurnForMessage(id, 300)

      expect(claim).toEqual({
        messageId: id,
        accountId: A.account,
        contactId: A.contact,
        conversationId: A.conv,
        claimToken: expect.any(String),
      })
      const r = await row(id)
      expect(r).toMatchObject({ status: 'processing', attempt_count: 1, claim_token: claim!.claimToken })
      expect(r.lease_s).toBeGreaterThan(295)
      expect(r.lease_s).toBeLessThanOrEqual(300)
    })

    it('a processing job cannot be claimed again, by message or from the queue', async () => {
      const id = await persist(A)
      await substrate.claimInboundTurnForMessage(id, 300)

      expect(await substrate.claimInboundTurnForMessage(id, 300)).toBeNull()
      expect(await substrate.claimInboundTurnJob(300)).toBeNull()
    })

    it('claim from the queue returns the oldest eligible job across pairs, with its own token', async () => {
      const young = await persist(B, 10)
      const old = await persist(A, 20)

      const first = await substrate.claimInboundTurnJob(300)
      const second = await substrate.claimInboundTurnJob(300)
      expect([first?.messageId, second?.messageId]).toEqual([old, young])
      expect(first!.claimToken).not.toBe(second!.claimToken)
      expect(await substrate.claimInboundTurnJob(300)).toBeNull()
    })

    it.each([
      [5, 30],
      [99999, 3600],
    ])('the requested lease is clamped to 30..3600 s (asked %i -> %i)', async (asked, effective) => {
      const id = await persist(A)
      await substrate.claimInboundTurnForMessage(id, asked)
      const lease = (await row(id)).lease_s!
      expect(lease).toBeGreaterThan(effective - 5)
      expect(lease).toBeLessThanOrEqual(effective)
    })
  })

  // ---------------------------------------------------------------- 4
  describe('renew', () => {
    it('the holder extends a valid lease (and the new length is clamped)', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!
      await testDb.query(`UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() + INTERVAL '40 seconds' WHERE message_id = $1`, [id])

      expect(await substrate.renewInboundTurnLease({ messageId: id, claimToken: claim.claimToken, lockSeconds: 300 })).toBe(true)
      expect((await row(id)).lease_s).toBeGreaterThan(295)

      expect(await substrate.renewInboundTurnLease({ messageId: id, claimToken: claim.claimToken, lockSeconds: 5 })).toBe(true)
      const clamped = (await row(id)).lease_s!
      expect(clamped).toBeGreaterThan(25)
      expect(clamped).toBeLessThanOrEqual(30)
    })

    it('the default length is 300 s', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 60))!
      expect(await substrate.renewInboundTurnLease({ messageId: id, claimToken: claim.claimToken })).toBe(true)
      expect((await row(id)).lease_s).toBeGreaterThan(295)
    })

    it('refuses (false, not an error) a wrong token, an unknown message, a pending job and a completed job', async () => {
      const id = await persist(A)
      expect(await substrate.renewInboundTurnLease({ messageId: id, claimToken: crypto.randomUUID() })).toBe(false) // pending

      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!
      expect(await substrate.renewInboundTurnLease({ messageId: id, claimToken: crypto.randomUUID() })).toBe(false)
      expect(await substrate.renewInboundTurnLease({ messageId: UNKNOWN_ID, claimToken: claim.claimToken })).toBe(false)
      expect((await row(id)).lease_s).toBeLessThanOrEqual(300)

      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: true })).toBe(true)
      expect(await substrate.renewInboundTurnLease({ messageId: id, claimToken: claim.claimToken })).toBe(false)
    })

    it('refuses an expired lease and leaves it expired', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!
      await expireLease(id)

      expect(await substrate.renewInboundTurnLease({ messageId: id, claimToken: claim.claimToken })).toBe(false)
      const r = await row(id)
      expect(r.status).toBe('processing')
      expect(r.lease_s).toBeLessThan(0)
    })
  })

  // ---------------------------------------------------------------- 5
  describe('complete', () => {
    it('success with a valid lease completes the job and clears the claim', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!

      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: true })).toBe(true)
      const r = await row(id)
      expect(r).toMatchObject({ status: 'completed', attempt_count: 1, claim_token: null, lease_s: null })
      expect(r.completed_at).toBeInstanceOf(Date)
    })

    it('cannot complete twice, with another token, or for an unknown message', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!

      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: crypto.randomUUID(), success: true })).toBe(false)
      expect(await substrate.completeInboundTurnJob({ messageId: UNKNOWN_ID, claimToken: claim.claimToken, success: true })).toBe(false)
      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: true })).toBe(true)
      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: true })).toBe(false)
    })

    it('cannot complete without a valid lease, for success or failure; the job stays processing', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!
      await expireLease(id)

      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: true })).toBe(false)
      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: false, error: 'x' })).toBe(false)
      expect(await row(id)).toMatchObject({ status: 'processing', attempt_count: 1, claim_token: claim.claimToken })
    })

    it('a stale token cannot complete after the job was reclaimed and claimed again', async () => {
      const id = await persist(A)
      const stale = (await substrate.claimInboundTurnForMessage(id, 300))!
      await expireLease(id)
      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(1)
      await makeAvailable(id)
      const fresh = (await substrate.claimInboundTurnForMessage(id, 300))!

      expect(fresh.claimToken).not.toBe(stale.claimToken)
      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: stale.claimToken, success: true })).toBe(false)
      expect(await substrate.completeInboundTurnJob({ messageId: id, claimToken: fresh.claimToken, success: true })).toBe(true)
    })

    it('a reported failure returns the job to pending with a 30 s backoff and the error text', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!

      expect(
        await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: false, error: 'boom' }),
      ).toBe(true)
      const r = await row(id)
      expect(r).toMatchObject({ status: 'pending', attempt_count: 1, claim_token: null, last_error: 'boom', completed_at: null })
      expect(r.delay_s).toBeGreaterThan(25)
      expect(r.delay_s).toBeLessThanOrEqual(30)
    })

    it('a failure without text is recorded as failed_without_message', async () => {
      const id = await persist(A)
      const claim = (await substrate.claimInboundTurnForMessage(id, 300))!
      await substrate.completeInboundTurnJob({ messageId: id, claimToken: claim.claimToken, success: false })
      expect((await row(id)).last_error).toBe('failed_without_message')
    })
  })

  // ---------------------------------------------------------------- 6
  describe('reclaim', () => {
    async function expiredJob(pair: Pair, attempts = 1, ageSec = 0) {
      const id = await persist(pair, ageSec)
      await substrate.claimInboundTurnForMessage(id, 300)
      if (attempts !== 1) await setAttempts(id, attempts)
      await expireLease(id)
      return id
    }

    it('an expired lease goes back to pending behind a backoff and is not claimable until it passes', async () => {
      const id = await expiredJob(A)

      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(1)
      const r = await row(id)
      expect(r).toMatchObject({ status: 'pending', attempt_count: 1, claim_token: null, last_error: 'lease_expired' })
      expect(r.delay_s).toBeGreaterThan(25)
      expect(r.delay_s).toBeLessThanOrEqual(30)

      expect(await substrate.claimInboundTurnJob(300)).toBeNull()
      expect(await substrate.claimInboundTurnForMessage(id, 300)).toBeNull()
      await makeAvailable(id)
      expect(await substrate.claimInboundTurnJob(300)).toMatchObject({ messageId: id })
      expect((await row(id)).attempt_count).toBe(2)
    })

    it('leaves a valid lease alone and honours the grace period', async () => {
      const live = await persist(A)
      await substrate.claimInboundTurnForMessage(live, 300)
      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(0)
      expect((await row(live)).status).toBe('processing')

      const expired = await expiredJob(B)
      expect(await substrate.reclaimStuckInboundTurnJobs(3600)).toBe(0)
      expect((await row(expired)).status).toBe('processing')
      expect(await substrate.reclaimStuckInboundTurnJobs()).toBe(1) // default grace is 0
      expect((await row(live)).status).toBe('processing')
    })

    it.each([
      [1, 30],
      [2, 60],
      [3, 120],
      [4, 240],
    ])('after attempt %i the backoff is %i s', async (attempts, seconds) => {
      const id = await expiredJob(A, attempts)
      await substrate.reclaimStuckInboundTurnJobs(0)
      const r = await row(id)
      expect(r.status).toBe('pending')
      expect(r.delay_s).toBeGreaterThan(seconds - 5)
      expect(r.delay_s).toBeLessThanOrEqual(seconds)
    })

    it('the 5th expired attempt ends in failed, which nothing can claim or reclaim again', async () => {
      const id = await expiredJob(A, 5)

      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(1)
      const r = await row(id)
      expect(r).toMatchObject({ status: 'failed', attempt_count: 5, claim_token: null, last_error: 'lease_expired_max_attempts' })
      expect(r.completed_at).toBeInstanceOf(Date)

      expect(await substrate.claimInboundTurnJob(300)).toBeNull()
      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(0)
    })

    it('reports how many jobs were reclaimed, across pairs', async () => {
      await expiredJob(A)
      await expiredJob(B)
      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(2)
    })
  })

  // ---------------------------------------------------------------- 7
  describe('later jobs of the same contact', () => {
    it('a pending older job (in backoff) holds the younger one, for both claim paths; another contact is free', async () => {
      const older = await persist(A, 30)
      const younger = await persist(A, 20)
      const other = await persist(B, 10)
      const claim = (await substrate.claimInboundTurnForMessage(older, 300))!
      await substrate.completeInboundTurnJob({ messageId: older, claimToken: claim.claimToken, success: false, error: 'x' })
      expect((await row(older)).status).toBe('pending')

      expect(await substrate.claimInboundTurnForMessage(younger, 300)).toBeNull()
      expect((await substrate.claimInboundTurnJob(300))?.messageId).toBe(other)
      expect(await substrate.claimInboundTurnJob(300)).toBeNull()

      await makeAvailable(older)
      expect((await substrate.claimInboundTurnJob(300))?.messageId).toBe(older)
    })

    it('a processing older job holds the younger one even after its lease expired, until reclaim; then the older goes first', async () => {
      const older = await persist(A, 30)
      const younger = await persist(A, 20)
      await substrate.claimInboundTurnForMessage(older, 300)
      await expireLease(older)

      expect(await substrate.claimInboundTurnJob(300)).toBeNull()
      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(1)
      expect(await substrate.claimInboundTurnJob(300)).toBeNull() // older is pending in backoff and still first
      await makeAvailable(older)
      expect((await substrate.claimInboundTurnJob(300))?.messageId).toBe(older)
      expect((await row(younger)).status).toBe('pending')
    })

    it('a completed or failed older job releases the pair', async () => {
      const older = await persist(A, 30)
      const younger = await persist(A, 20)
      const claim = (await substrate.claimInboundTurnForMessage(older, 300))!
      await substrate.completeInboundTurnJob({ messageId: older, claimToken: claim.claimToken, success: true })
      expect((await substrate.claimInboundTurnJob(300))?.messageId).toBe(younger)

      const o2 = await persist(B, 30)
      const y2 = await persist(B, 20)
      await substrate.claimInboundTurnForMessage(o2, 300)
      await setAttempts(o2, 5)
      await expireLease(o2)
      await substrate.reclaimStuckInboundTurnJobs(0)
      expect((await row(o2)).status).toBe('failed')
      expect((await substrate.claimInboundTurnJob(300))?.messageId).toBe(y2)
    })
  })

  // ---------------------------------------------------------------- 8
  describe('refusals are values, SQL errors are exceptions', () => {
    it('refusals: null / false / 0, never a throw', async () => {
      expect(await substrate.claimInboundTurnForMessage(UNKNOWN_ID, 300)).toBeNull()
      expect(await substrate.claimInboundTurnJob(300)).toBeNull()
      expect(await substrate.renewInboundTurnLease({ messageId: UNKNOWN_ID, claimToken: UNKNOWN_ID })).toBe(false)
      expect(await substrate.completeInboundTurnJob({ messageId: UNKNOWN_ID, claimToken: UNKNOWN_ID, success: true })).toBe(false)
      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(0)
    })

    it('SQL errors reject with the wrapper name and the Postgres message', async () => {
      await expect(
        substrate.registerInboundTurnJob({ messageId: UNKNOWN_ID, accountId: A.account, contactId: A.contact, conversationId: A.conv }),
      ).rejects.toThrow(/^register_inbound_turn_job: .*foreign key/i)
      await expect(substrate.claimInboundTurnForMessage('not-a-uuid', 300)).rejects.toThrow(/^claim_inbound_turn_for_message: .*uuid/i)
      await expect(substrate.claimInboundTurnJob(Number.NaN)).rejects.toThrow(/^claim_inbound_turn_job: /)
      await expect(substrate.renewInboundTurnLease({ messageId: 'not-a-uuid', claimToken: UNKNOWN_ID })).rejects.toThrow(
        /^renew_inbound_turn_lease: .*uuid/i,
      )
      await expect(
        substrate.completeInboundTurnJob({ messageId: UNKNOWN_ID, claimToken: 'not-a-uuid', success: true }),
      ).rejects.toThrow(/^complete_inbound_turn_job: .*uuid/i)
      await expect(substrate.reclaimStuckInboundTurnJobs(Number.NaN)).rejects.toThrow(/^reclaim_stuck_inbound_turn_jobs: /)
    })

    it('persist keeps the SQLSTATE on the error it throws', async () => {
      await expect(
        substrate.persistInboundMessageWithTurn(persistArgs({ ...A, conv: UNKNOWN_ID })),
      ).rejects.toMatchObject({ code: '23503', message: expect.stringMatching(/^persist_inbound_message_with_turn: /) })
    })

    it('a failed persist leaves neither a message nor a job (one function, one transaction)', async () => {
      const externalMessageId = ext()
      await expect(
        substrate.persistInboundMessageWithTurn(persistArgs({ ...A, contact: UNKNOWN_ID }, { externalMessageId })),
      ).rejects.toMatchObject({ code: '23503' })

      expect(await count(`FROM messages WHERE message_id = $1`, [externalMessageId])).toBe(0)
      expect(await count(`FROM inbound_turn_jobs`, [])).toBe(0)
    })
  })

  // ---------------------------------------------------------------- 10 (drain)
  describe('drain over real SQL', () => {
    it('processes jobs oldest first, each under its own claim, and completes them', async () => {
      const a1 = await persist(A, 30)
      const b1 = await persist(B, 20)
      const a2 = await persist(A, 10)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 3, failed: 0, skipped: 1 })
      expect(mockDownstream.mock.calls.map((c) => c[0])).toEqual([a1, b1, a2])
      for (const id of [a1, b1, a2]) {
        expect(await row(id)).toMatchObject({ status: 'completed', attempt_count: 1, claim_token: null })
      }
    })

    it('a second drain finds nothing to do', async () => {
      await persist(A)
      await drainInboundTurnJobs()
      mockDownstream.mockClear()

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 })
      expect(mockDownstream).not.toHaveBeenCalled()
    })

    it('a failing job is retried with backoff 30/60/120/240 s and ends in failed on the 5th attempt', async () => {
      const id = await persist(A)
      mockDownstream.mockRejectedValue(new Error('boom'))

      for (const [attempt, backoff] of [[1, 30], [2, 60], [3, 120], [4, 240]] as const) {
        expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 1, skipped: 1 })
        const r = await row(id)
        expect(r).toMatchObject({ status: 'pending', attempt_count: attempt, last_error: 'boom', claim_token: null })
        expect(r.delay_s).toBeGreaterThan(backoff - 5)
        expect(r.delay_s).toBeLessThanOrEqual(backoff)

        // Still in backoff: an immediate drain does not run the downstream again.
        const calls = mockDownstream.mock.calls.length
        expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 })
        expect(mockDownstream.mock.calls.length).toBe(calls)
        await makeAvailable(id)
      }

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 1, skipped: 1 })
      const last = await row(id)
      expect(last).toMatchObject({ status: 'failed', attempt_count: 5, last_error: 'boom' })
      expect(last.completed_at).toBeInstanceOf(Date)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 })
      expect(mockDownstream).toHaveBeenCalledTimes(5)
    })

    it('a job in backoff holds its contact but not other contacts; order is kept once it is available', async () => {
      const a1 = await persist(A, 30)
      const a2 = await persist(A, 20)
      const b1 = await persist(B, 10)
      mockDownstream.mockImplementation(async (id: string) => {
        if (id === a1) throw new Error('boom')
      })

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 1, skipped: 1 })
      expect(mockDownstream.mock.calls.map((c) => c[0])).toEqual([a1, b1])
      expect((await row(a2)).status).toBe('pending')

      mockDownstream.mockClear()
      mockDownstream.mockResolvedValue(undefined)
      await makeAvailable(a1)
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 2, failed: 0, skipped: 1 })
      expect(mockDownstream.mock.calls.map((c) => c[0])).toEqual([a1, a2])
    })

    it('reclaims an abandoned job first, then runs it after the backoff', async () => {
      const id = await persist(A)
      await substrate.claimInboundTurnForMessage(id, 300) // a worker that died
      await expireLease(id)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 1, processed: 0, failed: 0, skipped: 1 })
      expect(await row(id)).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'lease_expired' })

      await makeAvailable(id)
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 0, skipped: 1 })
      expect(await row(id)).toMatchObject({ status: 'completed', attempt_count: 2 })
    })

    it('respects maxJobs against the real queue', async () => {
      const ids = [await persist(A, 40), await persist(B, 30)]
      expect(await drainInboundTurnJobs({ maxJobs: 1 })).toEqual({ reclaimed: 0, processed: 1, failed: 0, skipped: 0 })
      expect((await row(ids[0]!)).status).toBe('completed')
      expect((await row(ids[1]!)).status).toBe('pending')
    })

    it('a lease lost while the work ran: no failed report, counted failed, recovered by reclaim', async () => {
      const id = await persist(A)
      mockDownstream.mockImplementation(async (messageId: string) => {
        await expireLease(messageId)
      })

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 1, skipped: 1 })
      expect(completeCalls().map((c) => c.args.p_success)).toEqual([true]) // refused by SQL, never followed by a failure report
      expect(await row(id)).toMatchObject({ status: 'processing', attempt_count: 1 })

      mockDownstream.mockResolvedValue(undefined)
      expect(await drainInboundTurnJobs()).toMatchObject({ reclaimed: 1, processed: 0 })
      expect((await row(id)).last_error).toBe('lease_expired')
    })
  })

  // ---------------------------------------------------------------- 10 (bookkeeping, finish.ts)
  describe('completion bookkeeping failures (finish.ts) over real job state', () => {
    const failComplete = (messageId: string, success: boolean): typeof state.fault =>
      (name, args) =>
        name === 'complete_inbound_turn_job' && args.p_message_id === messageId && args.p_success === success
          ? { message: 'connection reset', code: '08006' }
          : null

    it('drain: a failing complete(true) is NOT answered with complete(false); the job keeps its lease, the batch goes on', async () => {
      const j1 = await persist(A, 20)
      const j2 = await persist(B, 10)
      state.fault = failComplete(j1, true)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 1, skipped: 1 })

      expect(completeCalls().map((c) => [c.args.p_message_id, c.args.p_success])).toEqual([
        [j1, true],
        [j2, true],
      ])
      expect(await row(j1)).toMatchObject({ status: 'processing', attempt_count: 1, last_error: null })
      expect((await row(j1)).claim_token).not.toBeNull()
      expect((await row(j2)).status).toBe('completed')
      expect(errorSpy).toHaveBeenCalledWith(
        '[inbound-turn] could not record completion:',
        j1,
        expect.objectContaining({ message: 'complete_inbound_turn_job: connection reset' }),
      )
    })

    it('drain: the abandoned job is recovered through the lease (at-least-once: its downstream runs again)', async () => {
      const j1 = await persist(A)
      state.fault = failComplete(j1, true)
      await drainInboundTurnJobs()
      state.fault = null

      // Not reclaimable while the lease is valid.
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 })

      await expireLease(j1)
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 1, processed: 0, failed: 0, skipped: 1 })
      expect(await row(j1)).toMatchObject({ status: 'pending', last_error: 'lease_expired' })

      await makeAvailable(j1)
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 0, skipped: 1 })
      expect(await row(j1)).toMatchObject({ status: 'completed', attempt_count: 2 })
      expect(mockDownstream.mock.calls.filter((c) => c[0] === j1)).toHaveLength(2)
    })

    it('drain: a failing complete(false) keeps the original cause in the log and does not abort the batch', async () => {
      const j1 = await persist(A, 20)
      const j2 = await persist(B, 10)
      mockDownstream.mockImplementation(async (id: string) => {
        if (id === j1) throw new Error('boom')
      })
      state.fault = failComplete(j1, false)

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 1, skipped: 1 })
      expect(await row(j1)).toMatchObject({ status: 'processing', attempt_count: 1 })
      expect((await row(j2)).status).toBe('completed')
      expect(errorSpy).toHaveBeenCalledWith(
        '[inbound-turn] could not record failed attempt:',
        j1,
        expect.objectContaining({ message: 'complete_inbound_turn_job: connection reset' }),
        'cause:',
        'boom',
      )
    })

    it('inline: a failing complete(true) rejects with that error and sends no failure report', async () => {
      const id = await persist(A)
      state.fault = failComplete(id, true)

      await expect(processInboundTurnForMessage(id)).rejects.toThrow('complete_inbound_turn_job: connection reset')
      expect(completeCalls().map((c) => c.args.p_success)).toEqual([true])
      expect(await row(id)).toMatchObject({ status: 'processing', attempt_count: 1 })
    })

    it('inline: a failing complete(false) does not mask the downstream error', async () => {
      const id = await persist(A)
      const failure = new Error('downstream exploded')
      mockDownstream.mockRejectedValue(failure)
      state.fault = failComplete(id, false)

      await expect(processInboundTurnForMessage(id)).rejects.toBe(failure)
      expect(await row(id)).toMatchObject({ status: 'processing', attempt_count: 1 })
    })
  })

  // ---------------------------------------------------------------- inline path
  describe('processInboundTurnForMessage over real SQL', () => {
    it('claims, runs the downstream once and completes; a repeat is a no-op (duplicate webhook)', async () => {
      const id = await persist(A)

      expect(await processInboundTurnForMessage(id)).toBe(true)
      expect(mockDownstream).toHaveBeenCalledTimes(1)
      expect(mockDownstream).toHaveBeenCalledWith(id)
      expect(await row(id)).toMatchObject({ status: 'completed', attempt_count: 1 })

      expect(await processInboundTurnForMessage(id)).toBe(false)
      expect(mockDownstream).toHaveBeenCalledTimes(1)
    })

    it('an unknown message is false, without error', async () => {
      expect(await processInboundTurnForMessage(UNKNOWN_ID)).toBe(false)
      expect(mockDownstream).not.toHaveBeenCalled()
    })

    it('behind an older pending job it does nothing (left for the drain), then both run in order', async () => {
      const older = await persist(A, 30)
      const younger = await persist(A, 20)

      expect(await processInboundTurnForMessage(younger)).toBe(false)
      expect(mockDownstream).not.toHaveBeenCalled()
      expect(await row(younger)).toMatchObject({ status: 'pending', attempt_count: 0 })

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 2, failed: 0, skipped: 1 })
      expect(mockDownstream.mock.calls.map((c) => c[0])).toEqual([older, younger])
    })

    it('a downstream error is reported (pending + backoff + text) and rethrown unchanged', async () => {
      const id = await persist(A)
      const failure = new Error('downstream exploded')
      mockDownstream.mockRejectedValue(failure)

      await expect(processInboundTurnForMessage(id)).rejects.toBe(failure)
      const r = await row(id)
      expect(r).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'downstream exploded' })
      expect(r.delay_s).toBeGreaterThan(25)

      // Within the backoff an immediate retry is refused, not re-run.
      expect(await processInboundTurnForMessage(id)).toBe(false)
      expect(mockDownstream).toHaveBeenCalledTimes(1)
    })

    it('a lease lost while the work ran returns false with no error, and leaves the job to the reclaim', async () => {
      const id = await persist(A)
      mockDownstream.mockImplementation(async (messageId: string) => {
        await expireLease(messageId)
      })

      expect(await processInboundTurnForMessage(id)).toBe(false)
      expect(completeCalls().map((c) => c.args.p_success)).toEqual([true])
      expect(await row(id)).toMatchObject({ status: 'processing', attempt_count: 1 })
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('a claim SQL error rejects and runs nothing', async () => {
      await expect(processInboundTurnForMessage('not-a-uuid')).rejects.toThrow(/^claim_inbound_turn_for_message: /)
      expect(mockDownstream).not.toHaveBeenCalled()
      expect(completeCalls()).toHaveLength(0)
    })
  })
})
