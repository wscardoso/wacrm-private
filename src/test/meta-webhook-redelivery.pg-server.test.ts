import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import type { PGlite } from '@electric-sql/pglite'
import { SUPABASE_SHELL, migrationFiles, seedWorld } from '@/test/support/full-migration-chain'
import { pgliteSupabaseWithQuery } from '@/test/support/pglite-supabase-query'
import type { SqlRunner } from '@/test/support/pglite-supabase-rpc'
import { encryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'

/**
 * Meta webhook: redelivery after HTTP 500, on a REAL PostgreSQL server.
 *
 * Why this test exists: answering 500 when a message is not durable is only a good
 * contract if the provider's redelivery of the same payload is safe and heals the
 * gap. This drives the real `POST /api/whatsapp/webhook` handler (HMAC signature,
 * whatsapp_config lookup, token decryption, the persist pass, the 200/500 decision,
 * the fire-and-forget execute pass) and the real 088-091 SQL, on the complete
 * 001..091 migration chain applied to a throwaway database of a local server.
 *
 * Runs only when R1_PG_URL points at a LOOPBACK disposable server
 * (scripts/diagnostics/r1-disposable-pg.mjs start). The suite creates its own
 * database, never touches another one, and drops it at the end. No mock stands in
 * for SQL. Mocked at their boundary: the flow engine and the automation engine
 * (other subsystems with their own suites). Secrets are synthetic: the HMAC key and
 * the encryption key come from vitest.config.ts, the access token is a literal.
 *
 * The only injected fault is a trigger, in the throwaway database only, that fails
 * the turn-job insert of ONE named external message id. The 091 function then rolls
 * its message insert back, which is what a transient database error looks like to
 * the route.
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

const LOOPBACK = ['127.0.0.1', '::1', '[::1]', 'localhost']
const PHONE_NUMBER_ID = '111111111' // seedWorld's Meta number for tenant A

type Msg = { id: string; text: string }

describe.skipIf(!adminUrl)('Meta webhook redelivery after HTTP 500 (real PostgreSQL)', () => {
  let admin: pg.Client
  let c0: pg.Client
  let dbName = ''
  let world: Awaited<ReturnType<typeof seedWorld>>
  let seq = 0
  let phone = ''
  let batch: Msg[] = []
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await c0.query(sql, params)).rows as T[]
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

  /** A Meta delivery carrying `msgs`, all from the same contact, signed like Meta signs it. */
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
                messages: msgs.map((m, i) => ({
                  from: phone,
                  id: m.id,
                  timestamp: String(1761220800 + i),
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

  const failJobFor = (extId: string) => q(`SELECT set_config('app.r1_fail_ext_id', $1, false)`, [extId])
  const clearFault = () => failJobFor('')

  const jobOf = async (extId: string) =>
    (
      await q<{ status: string; attempt_count: number; last_error: string | null }>(
        `SELECT j.status, j.attempt_count, j.last_error FROM inbound_turn_jobs j
           JOIN messages m ON m.id = j.message_id WHERE m.message_id = $1`,
        [extId],
      )
    )[0]
  const messageRows = (extId: string) => n(`FROM messages WHERE message_id = $1 AND sender_type = 'customer'`, [extId])
  const conversation = async () =>
    (
      await q<{ last_message_text: string | null; unread_count: number }>(
        `SELECT c.last_message_text, c.unread_count FROM conversations c
           JOIN contacts k ON k.id = c.contact_id WHERE k.account_id = $1 AND k.phone = $2`,
        [world.accountA, phone],
      )
    )[0]
  const flowTexts = () => mockFlows.mock.calls.map((c) => (c[0] as { message: { text: string } }).message.text)
  const dlqRows = () => n(`FROM whatsapp_webhook_dlq WHERE account_id = $1`, [world.accountA])

  /**
   * The execute pass is fire-and-forget after the response. It visits the payload's
   * messages in order, one claim attempt each, and completes the ones it claimed, so
   * it is over once every message had its claim and every successful claim its
   * completion. No sleeps.
   */
  async function executePassDone(mark: number, messages: number) {
    await vi.waitFor(
      () => {
        const since = state.log.slice(mark)
        const claims = since.filter((c) => c.name === 'claim_inbound_turn_for_message')
        const won = claims.filter((c) => Array.isArray(c.data) && c.data.length > 0)
        const completes = since.filter((c) => c.name === 'complete_inbound_turn_job')
        expect(claims.length).toBe(messages)
        expect(completes.length).toBe(won.length)
      },
      { timeout: 10_000, interval: 25 },
    )
  }

  beforeAll(async () => {
    const uri = new URL(adminUrl!)
    if (!LOOPBACK.includes(uri.hostname)) {
      throw new Error('R1_PG_URL must point to a loopback disposable server; refusing to connect')
    }
    admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    dbName = `r1_route_${process.pid}_${Date.now()}`
    // The disposable cluster may be a non-UTF8 one; the migrations contain UTF-8 text.
    await admin.query(`CREATE DATABASE ${dbName} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
    uri.pathname = `/${dbName}`
    c0 = new pg.Client({ connectionString: uri.toString() })
    await c0.connect()

    // Roles are cluster-wide and may already exist; make the shell idempotent about them.
    const shell = SUPABASE_SHELL.replace(
      /CREATE ROLE (\w+)([^;]*);/g,
      (_m, role: string, rest: string) =>
        `DO $$ BEGIN CREATE ROLE ${role}${rest}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    )
    await c0.query(shell)
    const dir = join(process.cwd(), 'supabase', 'migrations')
    for (const f of migrationFiles()) {
      try {
        await c0.query(readFileSync(join(dir, f), 'utf8'))
      } catch (e) {
        throw new Error(`migration ${f} failed on the real server: ${(e as Error).message}`)
      }
    }

    await c0.query(`
      CREATE FUNCTION r1_fail_job_for_ext() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.downstream_context->>'externalMessageId' = current_setting('app.r1_fail_ext_id', true) THEN
          RAISE EXCEPTION 'r1 injected job failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER r1_fail_job_for_ext BEFORE INSERT ON inbound_turn_jobs
        FOR EACH ROW EXECUTE FUNCTION r1_fail_job_for_ext();
    `)

    world = await seedWorld(c0 as unknown as PGlite)
    // A real token the route can decrypt with the tenant's binding context (key: the synthetic one from vitest.config.ts).
    const token = encryptWithBindingContext('test-meta-access-token', whatsappConfigBindingContext(world.accountA))
    await q(`UPDATE whatsapp_config SET access_token = $1 WHERE id = $2`, [token, world.cfgA])
    const cfg = await q<{ provider: string; phone_number_id: string }>(
      `SELECT provider, phone_number_id FROM whatsapp_config WHERE id = $1`,
      [world.cfgA],
    )
    expect(cfg[0]).toEqual({ provider: 'meta', phone_number_id: PHONE_NUMBER_ID })

    const real = pgliteSupabaseWithQuery(c0 as unknown as SqlRunner)
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
    await c0?.end().catch(() => undefined)
    if (admin && dbName) {
      await admin
        .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName])
        .catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`).catch(() => undefined)
    }
    await admin?.end().catch(() => undefined)
  })

  beforeEach(async () => {
    // Jobs are global (the drain claims any of them); the DLQ is read per tenant.
    await q(`DELETE FROM inbound_turn_jobs`)
    await q(`DELETE FROM whatsapp_webhook_dlq`)
    await clearFault()
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
    await clearFault()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('the route accepts a signed delivery of a healthy batch and runs every message once (baseline)', async () => {
    const mark = state.log.length
    const res = await post()

    expect(res).toEqual({ status: 200, body: { status: 'received' } })
    await executePassDone(mark, 3)
    expect(flowTexts()).toEqual(['one', 'two', 'three'])
    for (const m of batch) expect(await jobOf(m.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
  })

  it('a bad signature is refused before anything is written', async () => {
    const req = delivery(batch)
    const forged = new Request(req.url, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: await req.text() })
    const res = await POST(forged)

    expect(res.status).toBe(401)
    expect(await messageRows(batch[0]!.id)).toBe(0)
  })

  describe('B cannot be made durable while A and C can', () => {
    it('first delivery: 500, A and C are durable and pending, B is absent, nothing ran, one diagnostic DLQ row', async () => {
      await failJobFor(batch[1]!.id)
      const mark = state.log.length

      const res = await post()

      expect(res).toEqual({ status: 500, body: { error: 'Inbound persistence incomplete' } })
      expect([await messageRows(batch[0]!.id), await messageRows(batch[1]!.id), await messageRows(batch[2]!.id)]).toEqual([1, 0, 1])
      expect(await jobOf(batch[0]!.id)).toMatchObject({ status: 'pending', attempt_count: 0 })
      expect(await jobOf(batch[1]!.id)).toBeUndefined()
      expect(await jobOf(batch[2]!.id)).toMatchObject({ status: 'pending', attempt_count: 0 })

      // The execute pass is not started on a 500: no claim, no downstream.
      expect(state.log.slice(mark).some((c) => c.name === 'claim_inbound_turn_for_message')).toBe(false)
      expect(mockFlows).not.toHaveBeenCalled()
      expect(mockAutomations).not.toHaveBeenCalled()
      expect(await n(`FROM agent_runs`)).toBe(0)

      // Captured for diagnosis only (stage + code, no content): it does not hold the message.
      expect(await dlqRows()).toBe(1)
      const dlq = await q<{ error_message: string }>(`SELECT error_message FROM whatsapp_webhook_dlq`)
      expect(dlq[0]!.error_message).toBe('source=meta;stage=message_insert;db_code=P0001')
    })

    it('redelivery of the same payload: 200, B becomes durable, no message is duplicated, A and C each run exactly once', async () => {
      await failJobFor(batch[1]!.id)
      expect((await post()).status).toBe(500)
      await clearFault()
      const mark = state.log.length

      const res = await post()

      expect(res).toEqual({ status: 200, body: { status: 'received' } })
      await executePassDone(mark, 3)

      // Persistence healed: one message and one job per external id, B included.
      for (const m of batch) {
        expect(await messageRows(m.id)).toBe(1)
        expect(await n(`FROM inbound_turn_jobs j JOIN messages x ON x.id = j.message_id WHERE x.message_id = $1`, [m.id])).toBe(1)
      }
      // The messages that were already durable were not re-inserted: only B reported an insert.
      const inserts = state.log
        .slice(mark)
        .filter((c) => c.name === 'persist_inbound_message_with_turn')
        .map((c) => (c.data as { message_inserted: boolean }).message_inserted)
      expect(inserts).toEqual([false, true, false])

      // Effects already owed by A and C ran once each; none ran twice.
      expect(await jobOf(batch[0]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(await jobOf(batch[2]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(flowTexts().filter((t) => t === 'one')).toHaveLength(1)
      expect(flowTexts().filter((t) => t === 'three')).toHaveLength(1)
      expect(await n(`FROM agent_runs`)).toBe(0)
    })

    // Observed contract of the current code, written down so a change is noticed:
    // B's job was created AFTER C's, and the per-contact queue is FIFO by job
    // creation, so the inline execute pass cannot claim B while C is pending. B waits
    // for the drain (the cron).
    it('characterization: B, recovered last, is not executed by the redelivery itself; the drain executes it', async () => {
      await failJobFor(batch[1]!.id)
      await post()
      await clearFault()
      const mark = state.log.length
      await post()
      await executePassDone(mark, 3)

      expect(await jobOf(batch[1]!.id)).toMatchObject({ status: 'pending', attempt_count: 0 })
      expect(flowTexts()).toEqual(['one', 'three'])

      expect(await drainInboundTurnJobs()).toMatchObject({ processed: 1, failed: 0 })
      expect(await jobOf(batch[1]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(flowTexts()).toEqual(['one', 'three', 'two']) // each exactly once, in job-creation order
      expect(await drainInboundTurnJobs()).toMatchObject({ processed: 0, failed: 0 })
      expect(mockFlows).toHaveBeenCalledTimes(3)
    })

    it('a further identical redelivery after everything completed changes nothing', async () => {
      await failJobFor(batch[1]!.id)
      await post()
      await clearFault()
      let mark = state.log.length
      await post()
      await executePassDone(mark, 3)
      await drainInboundTurnJobs()
      const before = {
        flows: mockFlows.mock.calls.length,
        messages: await n(`FROM messages WHERE sender_type = 'customer' AND message_id LIKE $1`, [`wamid.r1.${seq}.%`]),
        jobs: await n(`FROM inbound_turn_jobs`),
        dlq: await dlqRows(),
      }

      mark = state.log.length
      const res = await post()
      await executePassDone(mark, 3)

      expect(res.status).toBe(200)
      expect(mockFlows.mock.calls.length).toBe(before.flows)
      expect(await n(`FROM messages WHERE sender_type = 'customer' AND message_id LIKE $1`, [`wamid.r1.${seq}.%`])).toBe(before.messages)
      expect(await n(`FROM inbound_turn_jobs`)).toBe(before.jobs)
      expect(await dlqRows()).toBe(before.dlq)
      for (const m of batch) expect(await jobOf(m.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
    })

    it('redelivery while the fault is still on: 500 again, A and C stay single and pending, the DLQ grows by one row per retry', async () => {
      await failJobFor(batch[1]!.id)
      expect((await post()).status).toBe(500)
      expect((await post()).status).toBe(500)

      expect(await messageRows(batch[0]!.id)).toBe(1)
      expect(await messageRows(batch[2]!.id)).toBe(1)
      expect(await messageRows(batch[1]!.id)).toBe(0)
      expect(await jobOf(batch[0]!.id)).toMatchObject({ status: 'pending', attempt_count: 0 })
      expect(mockFlows).not.toHaveBeenCalled()
      // The DLQ has no dedup (documented in inbound-dlq.ts): the same failure is captured again.
      expect(await dlqRows()).toBe(2)
    })
  })

  describe('a single message cannot be made durable', () => {
    it('500, then the redelivery recovers it completely: persisted, executed once, completed', async () => {
      const only: Msg[] = [batch[0]!]
      await failJobFor(only[0]!.id)
      const first = await post(only)

      expect(first.status).toBe(500)
      expect(await messageRows(only[0]!.id)).toBe(0)
      expect(await jobOf(only[0]!.id)).toBeUndefined()
      expect(mockFlows).not.toHaveBeenCalled()

      await clearFault()
      const mark = state.log.length
      const second = await post(only)

      expect(second.status).toBe(200)
      await executePassDone(mark, 1)
      expect(await messageRows(only[0]!.id)).toBe(1)
      expect(await jobOf(only[0]!.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(flowTexts()).toEqual(['one'])
      expect(await conversation()).toMatchObject({ last_message_text: 'one', unread_count: 1 })
      expect(await n(`FROM agent_runs`)).toBe(0)
    })
  })
})
