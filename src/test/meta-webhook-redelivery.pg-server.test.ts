import { createHmac } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { seedWorld } from '@/test/support/full-migration-chain'
import { JOB_INSERT_FAULT_SQL, createChainDatabase, faults, type ChainDatabase } from '@/test/support/pg-server-chain'
import { pgliteSupabaseWithQuery } from '@/test/support/pglite-supabase-query'
import type { SqlRunner } from '@/test/support/pglite-supabase-rpc'
import { encryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'

/**
 * Meta webhook: durable intake, redelivery and recovery, on a REAL PostgreSQL server.
 *
 * Drives the real `POST /api/whatsapp/webhook` handler (HMAC signature, whatsapp_config
 * lookup, token decryption, the persist pass, the 200/500 decision, the turn passes and
 * the follow-up drain) over the complete 001..094 migration chain applied to a
 * throwaway database of a local server. No mock stands in for SQL. Mocked at their
 * boundary: the flow engine and the automation engine (other subsystems, own suites).
 *
 * Runs only when R1_PG_URL points at a LOOPBACK disposable server
 * (scripts/diagnostics/r1-disposable-pg.mjs start). The suite creates its own database
 * and drops it. Secrets are synthetic (the HMAC and encryption keys come from
 * vitest.config.ts; the access token is a literal).
 *
 * Faults are injected only in the throwaway database, by one trigger on the turn-job
 * insert: a PERMANENT failure (SQLSTATE P0001) for one external message id, and a
 * FLAKY one (SQLSTATE 40001) for one external id that fails its first N attempts. The
 * 091 function rolls the message insert back with the job insert, which is what a
 * database error looks like to the route.
 *
 * Contract asserted (the R1 intake guarantees):
 *   - 200 only when every message of the delivery is durable; otherwise 500;
 *   - whatever IS durable is executed immediately, whether or not the delivery is
 *     acknowledged, and a stored message never waits for the provider to redeliver;
 *   - a redelivery stores what is missing, never duplicates a message, a job or an effect;
 *   - the queue of a contact runs the oldest MESSAGE first; a message that runs after a
 *     newer one is counted but cannot regress the conversation preview;
 *   - the DLQ holds one row per persistent failure (occurrences counted) and resolves it
 *     when the message is finally stored;
 *   - a transient database error on the persist call is retried inside the request.
 */

const adminUrl = process.env.R1_PG_URL

const state = vi.hoisted(() => ({
  client: null as unknown,
  log: [] as Array<{ name: string; args: Record<string, unknown>; data: unknown }>,
}))
const { mockFlows, mockAutomations, mockCancel } = vi.hoisted(() => ({
  mockFlows: vi.fn(),
  mockAutomations: vi.fn(),
  mockCancel: vi.fn(),
}))

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => state.client,
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: mockFlows }))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mockAutomations,
  cancelPendingCadencesForContact: mockCancel,
}))

const { POST } = await import('@/app/api/whatsapp/webhook/route')
const { drainInboundTurnJobs } = await import('@/lib/agent/turn/drain')

const PHONE_NUMBER_ID = '111111111' // seedWorld's Meta number for tenant A

type Msg = { id: string; text: string }

describe.skipIf(!adminUrl)('Meta webhook intake, redelivery and recovery (real PostgreSQL)', () => {
  let chain: ChainDatabase
  let world: Awaited<ReturnType<typeof seedWorld>>
  let seq = 0
  let phone = ''
  let batch: Msg[] = []
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await chain.client.query(sql, params)).rows as T[]
  const n = async (sql: string, params: unknown[] = []) =>
    Number((await q<{ n: string }>(`SELECT count(*) AS n ${sql}`, params))[0]!.n)

  function newBatch() {
    const k = ++seq
    phone = `55119666${String(k).padStart(5, '0')}`
    batch = [
      { id: `wamid.r1.${k}.A`, text: 'one' },
      { id: `wamid.r1.${k}.B`, text: 'two' },
      { id: `wamid.r1.${k}.C`, text: 'three' },
    ]
  }

  /** A Meta delivery carrying `msgs` (message time = payload position), all from one contact, signed like Meta signs it. */
  function delivery(msgs: Msg[]) {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-r1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '5511900000000', phone_number_id: PHONE_NUMBER_ID },
                contacts: msgs.map(() => ({ profile: { name: 'Cliente R1' }, wa_id: phone })),
                messages: msgs.map((m) => ({
                  from: phone,
                  id: m.id,
                  // Message time follows the A, B, C labels whatever subset a delivery carries.
                  timestamp: String(1761220800 + (m.id.endsWith('.A') ? 0 : m.id.endsWith('.B') ? 1 : 2)),
                  type: 'text',
                  text: { body: m.text },
                })),
              },
            },
          ],
        },
      ],
    }
    const raw = JSON.stringify(body)
    const signature = 'sha256=' + createHmac('sha256', process.env.META_APP_SECRET!).update(raw).digest('hex')
    return new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
      body: raw,
    })
  }

  async function post(msgs: Msg[] = batch) {
    const res = await POST(delivery(msgs))
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  // --- fault injection (throwaway database only; see JOB_INSERT_FAULT_SQL)
  const failPermanently = (extId: string) => faults.permanent(chain.client, extId)
  const failTransiently = (extId: string, times: number) => faults.transient(chain.client, extId, times)
  const clearFaults = () => faults.clear(chain.client)

  const jobOf = async (extId: string) =>
    (
      await q<{ status: string; attempt_count: number; last_error: string | null }>(
        `SELECT j.status, j.attempt_count, j.last_error FROM inbound_turn_jobs j
           JOIN messages m ON m.id = j.message_id WHERE m.message_id = $1`,
        [extId],
      )
    )[0]
  const messageRows = (extId: string) => n(`FROM messages WHERE message_id = $1 AND sender_type = 'customer'`, [extId])
  const jobRows = (extId: string) =>
    n(`FROM inbound_turn_jobs j JOIN messages x ON x.id = j.message_id WHERE x.message_id = $1`, [extId])
  const conversation = async () =>
    (
      await q<{ last_message_text: string | null; unread_count: number }>(
        `SELECT c.last_message_text, c.unread_count FROM conversations c
           JOIN contacts k ON k.id = c.contact_id WHERE k.account_id = $1 AND k.phone = $2`,
        [world.accountA, phone],
      )
    )[0]
  const flowTexts = () => mockFlows.mock.calls.map((c) => (c[0] as { message: { text: string } }).message.text)
  const dlq = () =>
    q<{ status: string; occurrences: number; error_message: string; last_error_message: string }>(
      `SELECT status, occurrences, error_message, last_error_message FROM whatsapp_webhook_dlq
        WHERE account_id = $1 ORDER BY created_at`,
      [world.accountA],
    )
  const persistCalls = (mark: number) => state.log.slice(mark).filter((c) => c.name === 'persist_inbound_message_with_turn')
  const makeAvailable = (extId: string) =>
    q(`UPDATE inbound_turn_jobs SET available_at = clock_timestamp()
        WHERE message_id IN (SELECT id FROM messages WHERE message_id = $1)`, [extId])

  /**
   * Everything a delivery starts after its response is fire-and-forget: the turn of each
   * durable message of the payload (one inline claim each, in payload order, each claim
   * that wins is completed) and then the drain, which ends with an empty claim. The
   * delivery is settled when all of that has happened. No sleeps.
   */
  async function settled(mark: number, durableInPayload: number) {
    await vi.waitFor(
      () => {
        const since = state.log.slice(mark)
        const claims = since.filter((c) => c.name === 'claim_inbound_turn_for_message')
        const won = claims.filter((c) => Array.isArray(c.data) && c.data.length > 0)
        const completes = since.filter((c) => c.name === 'complete_inbound_turn_job')
        expect(claims.length).toBe(durableInPayload)
        expect(completes.length).toBeGreaterThanOrEqual(won.length)
        const lastDrainClaim = since.filter((c) => c.name === 'claim_inbound_turn_job').at(-1)
        expect(lastDrainClaim).toBeDefined()
        expect(Array.isArray(lastDrainClaim!.data) ? lastDrainClaim!.data.length : 0).toBe(0)
      },
      { timeout: 10_000, interval: 25 },
    )
  }

  beforeAll(async () => {
    chain = await createChainDatabase(adminUrl!, 'route', { extraSql: JOB_INSERT_FAULT_SQL })
    world = await seedWorld(chain.client as unknown as PGlite)
    // A real token the route can decrypt with the tenant's binding context (key: the synthetic one from vitest.config.ts).
    const token = encryptWithBindingContext('test-meta-access-token', whatsappConfigBindingContext(world.accountA))
    await q(`UPDATE whatsapp_config SET access_token = $1 WHERE id = $2`, [token, world.cfgA])
    const cfg = await q<{ provider: string; phone_number_id: string }>(
      `SELECT provider, phone_number_id FROM whatsapp_config WHERE id = $1`,
      [world.cfgA],
    )
    expect(cfg[0]).toEqual({ provider: 'meta', phone_number_id: PHONE_NUMBER_ID })

    const real = pgliteSupabaseWithQuery(chain.client as unknown as SqlRunner)
    state.client = {
      ...real,
      async rpc(name: string, args: Record<string, unknown> = {}) {
        const res = await real.rpc(name, args)
        state.log.push({ name, args, data: res.data })
        return res
      },
    }
  })

  afterAll(async () => {
    await chain?.drop()
  })

  beforeEach(async () => {
    // Jobs are global (the drain claims any of them); the DLQ is read per tenant.
    await q(`DELETE FROM inbound_turn_jobs`)
    await q(`DELETE FROM whatsapp_webhook_dlq`)
    await clearFaults()
    state.log.length = 0
    mockFlows.mockReset()
    mockFlows.mockResolvedValue({ consumed: false })
    mockAutomations.mockReset()
    mockAutomations.mockResolvedValue(undefined)
    mockCancel.mockReset()
    mockCancel.mockResolvedValue(0)
    newBatch()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await clearFaults()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('a healthy batch is acknowledged and every message runs once, in message order (baseline)', async () => {
    const mark = state.log.length
    const res = await post()

    expect(res).toEqual({ status: 200, body: { status: 'received' } })
    await settled(mark, 3)
    expect(flowTexts()).toEqual(['one', 'two', 'three'])
    for (const m of batch) expect(await jobOf(m.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
    expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 3 })
    expect(await dlq()).toEqual([])
  })

  it('a bad signature is refused before anything is written', async () => {
    const req = delivery(batch)
    const forged = new Request(req.url, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: await req.text() })
    const res = await POST(forged)

    expect(res.status).toBe(401)
    expect(await messageRows(batch[0]!.id)).toBe(0)
  })

  describe('B cannot be made durable while A and C can', () => {
    it('first delivery: 500, but A and C are stored AND executed at once, without waiting for a redelivery or the cron', async () => {
      await failPermanently(batch[1]!.id)
      const mark = state.log.length

      const res = await post()

      expect(res).toEqual({ status: 500, body: { error: 'Inbound persistence incomplete' } })
      await settled(mark, 2) // the turns pass visits only what is durable: A and C
      expect([await messageRows(batch[0]!.id), await messageRows(batch[1]!.id), await messageRows(batch[2]!.id)]).toEqual([1, 0, 1])
      expect(await jobOf(batch[0]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(await jobOf(batch[1]!.id)).toBeUndefined()
      expect(await jobOf(batch[2]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(flowTexts()).toEqual(['one', 'three'])
      expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 2 })
      expect(await n(`FROM agent_runs`)).toBe(0)

      // One diagnostic row (stage + code, no content): it does not hold the message.
      const rows = await dlq()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ status: 'pending', occurrences: 1, error_message: 'source=meta;stage=message_insert;db_code=P0001' })
    })

    it('redelivery: 200, B is stored and executed once (late), nothing else is duplicated, and the preview does not regress', async () => {
      await failPermanently(batch[1]!.id)
      let mark = state.log.length
      expect((await post()).status).toBe(500)
      await settled(mark, 2)
      await clearFaults()

      mark = state.log.length
      const res = await post()

      expect(res).toEqual({ status: 200, body: { status: 'received' } })
      await settled(mark, 3)
      for (const m of batch) {
        expect(await messageRows(m.id)).toBe(1)
        expect(await jobRows(m.id)).toBe(1)
        expect(await jobOf(m.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      }
      // Only B reported an insert; A and C were found as duplicates.
      expect(persistCalls(mark).map((c) => (c.data as { message_inserted: boolean }).message_inserted)).toEqual([false, true, false])
      // Each effect exactly once. B ran after C (a turn already finished cannot be undone)...
      expect(flowTexts()).toEqual(['one', 'three', 'two'])
      // ...but the conversation shows the newest message and counts all three.
      expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 3 })
      // The failure is no longer "not stored".
      expect(await dlq()).toMatchObject([{ status: 'resolved', occurrences: 1 }])
    })

    it('a further identical redelivery after everything completed changes nothing', async () => {
      await failPermanently(batch[1]!.id)
      let mark = state.log.length
      await post()
      await settled(mark, 2)
      await clearFaults()
      mark = state.log.length
      await post()
      await settled(mark, 3)
      const before = { flows: mockFlows.mock.calls.length, conversation: await conversation(), jobs: await n(`FROM inbound_turn_jobs`), dlq: await dlq() }

      mark = state.log.length
      const res = await post()
      await settled(mark, 3)

      expect(res.status).toBe(200)
      expect(mockFlows.mock.calls.length).toBe(before.flows)
      expect(await conversation()).toEqual(before.conversation)
      expect(await n(`FROM inbound_turn_jobs`)).toBe(before.jobs)
      expect(await dlq()).toEqual(before.dlq)
      for (const m of batch) expect(await jobOf(m.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
    })

    it('while the fault lasts every retry answers 500, stores nothing twice, and the DLQ keeps ONE row whose occurrences grow', async () => {
      await failPermanently(batch[1]!.id)
      let mark = state.log.length
      expect((await post()).status).toBe(500)
      await settled(mark, 2)
      mark = state.log.length
      expect((await post()).status).toBe(500)
      await settled(mark, 2)
      mark = state.log.length
      expect((await post()).status).toBe(500)
      await settled(mark, 2)

      expect(await messageRows(batch[0]!.id)).toBe(1)
      expect(await messageRows(batch[2]!.id)).toBe(1)
      expect(await messageRows(batch[1]!.id)).toBe(0)
      expect(flowTexts()).toEqual(['one', 'three']) // not executed again by the retries
      expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 2 })
      expect(await dlq()).toMatchObject([{ status: 'pending', occurrences: 3, error_message: 'source=meta;stage=message_insert;db_code=P0001' }])
    })
  })

  describe('queue order and recovery of a message that was held back', () => {
    // C's turn fails once; B (older message) is stored by the redelivery while C waits in
    // backoff. Message-time order: B runs BEFORE C's retry, and C's conversation effect was
    // already applied by its first attempt, so the retry does not count it twice.
    it('an older message stored while a newer one waits in backoff runs first; the retry of the newer one counts once', async () => {
      let failThree = true
      mockFlows.mockImplementation(async (input: { message: { text: string } }) => {
        if (input.message.text === 'three' && failThree) {
          failThree = false
          throw new Error('flows temporarily down')
        }
        return { consumed: false }
      })
      await failPermanently(batch[1]!.id)
      let mark = state.log.length
      expect((await post()).status).toBe(500)
      await settled(mark, 2)
      expect(await jobOf(batch[2]!.id)).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'flows temporarily down' })

      await clearFaults()
      mark = state.log.length
      expect((await post()).status).toBe(200)
      await settled(mark, 3)

      expect(await jobOf(batch[1]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 }) // not held behind C
      expect(await jobOf(batch[2]!.id)).toMatchObject({ status: 'pending', attempt_count: 1 }) // still in backoff

      await makeAvailable(batch[2]!.id)
      expect(await drainInboundTurnJobs()).toMatchObject({ processed: 1, failed: 0 })
      expect(await jobOf(batch[2]!.id)).toMatchObject({ status: 'completed', attempt_count: 2 })
      expect(flowTexts()).toEqual(['one', 'three', 'two', 'three']) // 'three' ran twice: its first attempt threw
      expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 3 })
    })
  })

  describe('a transient database error on the persist call', () => {
    it('is retried inside the request: the delivery is acknowledged, stored once, executed once, and leaves no DLQ row', async () => {
      const only: Msg[] = [batch[0]!]
      await failTransiently(only[0]!.id, 2) // fails twice, succeeds on the third (= last) attempt
      const mark = state.log.length

      const res = await post(only)

      expect(res).toEqual({ status: 200, body: { status: 'received' } })
      await settled(mark, 1)
      expect(persistCalls(mark)).toHaveLength(3)
      expect(await messageRows(only[0]!.id)).toBe(1)
      expect(await jobRows(only[0]!.id)).toBe(1)
      expect(await jobOf(only[0]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(flowTexts()).toEqual(['one'])
      expect(await dlq()).toEqual([])
    })

    it('that outlasts the retries answers 500 with one DLQ row (code 40001) and stores nothing; the redelivery recovers it', async () => {
      const only: Msg[] = [batch[0]!]
      await failTransiently(only[0]!.id, 3)
      let mark = state.log.length

      const first = await post(only)

      expect(first.status).toBe(500)
      expect(persistCalls(mark)).toHaveLength(3) // the first attempt plus two retries
      expect(await messageRows(only[0]!.id)).toBe(0)
      expect(await dlq()).toMatchObject([{ status: 'pending', occurrences: 1, error_message: 'source=meta;stage=message_insert;db_code=40001' }])

      await clearFaults()
      mark = state.log.length
      const second = await post(only)
      expect(second.status).toBe(200)
      await settled(mark, 1)
      expect(await jobOf(only[0]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(flowTexts()).toEqual(['one'])
      expect(await dlq()).toMatchObject([{ status: 'resolved' }])
    })

    it('a permanent error is NOT retried: one attempt, 500, one DLQ row', async () => {
      const only: Msg[] = [batch[0]!]
      await failPermanently(only[0]!.id)
      const mark = state.log.length

      const res = await post(only)

      expect(res.status).toBe(500)
      expect(persistCalls(mark)).toHaveLength(1)
      expect(await dlq()).toMatchObject([{ occurrences: 1, error_message: 'source=meta;stage=message_insert;db_code=P0001' }])
    })
  })

  describe('a single message cannot be made durable', () => {
    it('500, then the redelivery recovers it completely: stored, executed once, conversation updated once', async () => {
      const only: Msg[] = [batch[0]!]
      await failPermanently(only[0]!.id)
      let mark = state.log.length

      const first = await post(only)

      expect(first.status).toBe(500)
      await settled(mark, 0)
      expect(await messageRows(only[0]!.id)).toBe(0)
      expect(await jobOf(only[0]!.id)).toBeUndefined()
      expect(mockFlows).not.toHaveBeenCalled()

      await clearFaults()
      mark = state.log.length
      const second = await post(only)

      expect(second.status).toBe(200)
      await settled(mark, 1)
      expect(await messageRows(only[0]!.id)).toBe(1)
      expect(await jobOf(only[0]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(flowTexts()).toEqual(['one'])
      expect(await conversation()).toEqual({ last_message_text: 'one', unread_count: 1 })
      expect(await n(`FROM agent_runs`)).toBe(0)
    })
  })
})
