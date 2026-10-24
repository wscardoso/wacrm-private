import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { PGlite } from '@electric-sql/pglite'
import { seedWorld } from '@/test/support/full-migration-chain'
import { JOB_INSERT_FAULT_SQL, createChainDatabase, faults, type ChainDatabase } from '@/test/support/pg-server-chain'
import { pgliteSupabaseWithQuery } from '@/test/support/pglite-supabase-query'
import type { SqlRunner } from '@/test/support/pglite-supabase-rpc'
import { encryptWithBindingContext } from '@/lib/whatsapp/encryption'
import { whatsappConfigBindingContext } from '@/lib/whatsapp/config-binding'
import { hashWebhookSecret } from '@/lib/whatsapp/webhook-auth'

/**
 * Provider (UAZAPI) webhook: durable intake and recovery WITHOUT any redelivery, on a
 * REAL PostgreSQL server.
 *
 * The UAZAPI FREE worker was observed not to retry a delivery the receiver refused
 * (one 500, attempts: 1, nothing more within two minutes; r1-uazapi-etapa3-result,
 * produced by the operational test, not by this suite). So nothing here relies on the
 * provider coming back: what the route stored is executed at once, a transient database
 * error is absorbed inside the request, and anything left over is recovered by the cron
 * route. Drives the real POST of /api/whatsapp/webhook/[provider]/[connectionId]/
 * [webhookSecret] (rate limit, config lookup, token decryption, secret hash check,
 * adapter parsing, DLQ capture, persist, drain) and the real cron GET, over the complete
 * migration chain of a throwaway database of a LOOPBACK server (R1_PG_URL).
 *
 * Mocked at their boundary: the flow engine and the automation engine. Synthetic secrets
 * only (the webhook secret and the cron secret are literals; the encryption key comes
 * from vitest.config.ts).
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

vi.mock('@/lib/supabase/admin-client', () => ({ supabaseAdmin: () => state.client }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: mockFlows }))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mockAutomations,
  cancelPendingCadencesForContact: mockCancel,
}))

const { POST } = await import('@/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route')
const { GET: cronGET } = await import('@/app/api/agent/inbound-turns/cron/route')

const CONNECTION_ID = 'conn-r1-uazapi'
const WEBHOOK_SECRET = 'r1-test-webhook-secret'
const CRON_SECRET = 'test-cron-secret-not-real'

type Msg = { id: string; text: string; ts: number }

describe.skipIf(!adminUrl)('provider webhook intake and recovery without redelivery (real PostgreSQL)', () => {
  let chain: ChainDatabase
  let world: Awaited<ReturnType<typeof seedWorld>>
  let seq = 0
  let jid = ''
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
    phone = `55119444${String(k).padStart(5, '0')}`
    jid = `${phone}@s.whatsapp.net`
    batch = [
      { id: `r1.u.${k}.A`, text: 'one', ts: 1_761_220_800 },
      { id: `r1.u.${k}.B`, text: 'two', ts: 1_761_220_801 },
      { id: `r1.u.${k}.C`, text: 'three', ts: 1_761_220_802 },
    ]
  }

  const payload = (msgs: Msg[]) => ({
    event: 'messages',
    data: msgs.map((m) => ({
      messages: [{ key: { remoteJid: jid, id: m.id }, messageTimestamp: m.ts, message: { conversation: m.text } }],
    })),
  })

  async function post(msgs: Msg[] = batch, secret = WEBHOOK_SECRET) {
    const req = new Request(`http://localhost/api/whatsapp/webhook/uazapi/${CONNECTION_ID}/${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload(msgs)),
    })
    const res = await POST(req, {
      params: Promise.resolve({ provider: 'uazapi', connectionId: CONNECTION_ID, webhookSecret: secret }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

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
        [world.accountB, phone],
      )
    )[0]
  const flowTexts = () => mockFlows.mock.calls.map((c) => (c[0] as { message: { text: string } }).message.text)
  const dlq = () =>
    q<{ status: string; occurrences: number; error_message: string }>(
      `SELECT status, occurrences, error_message FROM whatsapp_webhook_dlq WHERE account_id = $1 ORDER BY created_at`,
      [world.accountB],
    )
  const persistCalls = (mark: number) => state.log.slice(mark).filter((c) => c.name === 'persist_inbound_message_with_turn')
  const makeAvailable = (extId: string) =>
    q(`UPDATE inbound_turn_jobs SET available_at = clock_timestamp()
        WHERE message_id IN (SELECT id FROM messages WHERE message_id = $1)`, [extId])

  /** The route's drain is fire-and-forget after the response: wait for the jobs, not for a timer. */
  const untilCompleted = (ids: string[]) =>
    vi.waitFor(
      async () => {
        for (const id of ids) expect(await jobOf(id)).toMatchObject({ status: 'completed' })
      },
      { timeout: 10_000, interval: 25 },
    )
  /** Same, for "the drain has been over": the last drain scan came back empty. */
  const drainIdle = (mark: number) =>
    vi.waitFor(
      () => {
        const last = state.log.slice(mark).filter((c) => c.name === 'claim_inbound_turn_job').at(-1)
        expect(last).toBeDefined()
        expect(Array.isArray(last!.data) ? last!.data.length : 0).toBe(0)
      },
      { timeout: 10_000, interval: 25 },
    )

  beforeAll(async () => {
    chain = await createChainDatabase(adminUrl!, 'provider', { extraSql: JOB_INSERT_FAULT_SQL })
    world = await seedWorld(chain.client as unknown as PGlite)
    // Tenant B's config becomes a UAZAPI connection (the route authenticates by connection id + secret hash).
    const token = encryptWithBindingContext('test-uazapi-token', whatsappConfigBindingContext(world.accountB))
    await q(
      `UPDATE whatsapp_config
          SET provider = 'uazapi', connection_id = $1, webhook_secret_hash = $2,
              base_url = 'https://uazapi.invalid', instance_id = 'r1-instance', access_token = $3
        WHERE id = $4`,
      [CONNECTION_ID, hashWebhookSecret(WEBHOOK_SECRET), token, world.cfgB],
    )
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
    await q(`DELETE FROM inbound_turn_jobs`)
    await q(`DELETE FROM whatsapp_webhook_dlq`)
    await faults.clear(chain.client)
    state.log.length = 0
    mockFlows.mockReset()
    mockFlows.mockResolvedValue({ consumed: false })
    mockAutomations.mockReset()
    mockAutomations.mockResolvedValue(undefined)
    mockCancel.mockReset()
    mockCancel.mockResolvedValue(0)
    vi.stubEnv('AUTOMATION_CRON_SECRET', CRON_SECRET)
    newBatch()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    await faults.clear(chain.client)
    vi.unstubAllEnvs()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('a wrong webhook secret is refused (401) before anything is written', async () => {
    const res = await post(batch, 'not-the-secret')
    expect(res.status).toBe(401)
    expect(await messageRows(batch[0]!.id)).toBe(0)
  })

  it('a healthy batch is acknowledged and every message runs once, in message order', async () => {
    const mark = state.log.length
    const res = await post()

    expect(res).toEqual({ status: 200, body: { received: true, processed: 3, inboundProcessed: 3, captured: 0, statusProcessed: 0 } })
    await untilCompleted(batch.map((m) => m.id))
    await drainIdle(mark)
    expect(flowTexts()).toEqual(['one', 'two', 'three'])
    expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 3 })
    expect(await dlq()).toEqual([])
  })

  describe('B cannot be made durable while A and C can (the provider never comes back)', () => {
    it('500, but what was stored runs at once with NO redelivery; one diagnostic DLQ row; B is the only loss', async () => {
      await faults.permanent(chain.client, batch[1]!.id)
      const mark = state.log.length

      const res = await post()

      expect(res.status).toBe(500)
      expect(res.body).toMatchObject({ error: 'Inbound event was not durably persisted', processed: 2, inboundProcessed: 2, captured: 1, uncaptured: 0 })
      await untilCompleted([batch[0]!.id, batch[2]!.id])
      await drainIdle(mark)
      expect(flowTexts()).toEqual(['one', 'three'])
      expect([await messageRows(batch[0]!.id), await messageRows(batch[1]!.id), await messageRows(batch[2]!.id)]).toEqual([1, 0, 1])
      expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 2 })
      expect(await dlq()).toMatchObject([{ status: 'pending', occurrences: 1, error_message: 'source=uazapi;stage=message_insert;db_code=P0001' }])
    })

    it('if the same payload does come again (operator replay), B is stored and run once, nothing else repeats, the DLQ row resolves', async () => {
      await faults.permanent(chain.client, batch[1]!.id)
      let mark = state.log.length
      await post()
      await untilCompleted([batch[0]!.id, batch[2]!.id])
      await drainIdle(mark)
      await faults.clear(chain.client)

      mark = state.log.length
      const res = await post()

      expect(res.status).toBe(200)
      await untilCompleted(batch.map((m) => m.id))
      await drainIdle(mark)
      expect(flowTexts()).toEqual(['one', 'three', 'two']) // each exactly once
      for (const m of batch) expect(await jobOf(m.id)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 3 }) // late B does not regress the preview
      expect(await dlq()).toMatchObject([{ status: 'resolved', occurrences: 1 }])
    })

    it('a persistent fault with a repeating sender keeps ONE DLQ row (occurrences counted) instead of one per delivery', async () => {
      await faults.permanent(chain.client, batch[1]!.id)
      for (let i = 0; i < 3; i++) {
        const mark = state.log.length
        expect((await post()).status).toBe(500)
        await drainIdle(mark)
      }
      expect(await dlq()).toMatchObject([{ status: 'pending', occurrences: 3 }])
      expect(flowTexts()).toEqual(['one', 'three']) // the repeats executed nothing twice
    })
  })

  describe('a transient database error on the persist call', () => {
    it('is absorbed inside the request: no 500, nothing for the provider to retry, no DLQ row', async () => {
      const only = [batch[0]!]
      await faults.transient(chain.client, only[0]!.id, 2)
      const mark = state.log.length

      const res = await post(only)

      expect(res.status).toBe(200)
      await untilCompleted([only[0]!.id])
      expect(persistCalls(mark)).toHaveLength(3)
      expect(flowTexts()).toEqual(['one'])
      expect(await dlq()).toEqual([])
    })

    it('that outlasts the retries is a 500 with one DLQ row and nothing stored', async () => {
      const only = [batch[0]!]
      await faults.transient(chain.client, only[0]!.id, 3)
      const mark = state.log.length

      const res = await post(only)

      expect(res.status).toBe(500)
      // Nothing was stored, so the route starts no drain and there is nothing to wait for.
      expect(persistCalls(mark)).toHaveLength(3)
      expect(await messageRows(only[0]!.id)).toBe(0)
      expect(await dlq()).toMatchObject([{ status: 'pending', occurrences: 1, error_message: 'source=uazapi;stage=message_insert;db_code=40001' }])
    })
  })

  describe('what the response left behind is recovered by the cron, not by the provider', () => {
    const cron = (secret: string | null = CRON_SECRET) =>
      cronGET(new NextRequest('http://localhost/api/agent/inbound-turns/cron', { headers: secret ? { 'x-cron-secret': secret } : {} }))

    it('a turn that failed after the acknowledgement waits in backoff and the cron completes it exactly once', async () => {
      let failTwo = true
      mockFlows.mockImplementation(async (input: { message: { text: string } }) => {
        if (input.message.text === 'two' && failTwo) {
          failTwo = false
          throw new Error('flows temporarily down')
        }
        return { consumed: false }
      })
      const mark = state.log.length

      expect((await post()).status).toBe(200) // the message IS stored; its turn failed afterwards
      await untilCompleted([batch[0]!.id])
      await drainIdle(mark)
      expect(await jobOf(batch[1]!.id)).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'flows temporarily down' })
      expect(await jobOf(batch[2]!.id)).toMatchObject({ status: 'pending', attempt_count: 0 }) // behind B (older message, in backoff)

      expect((await cron(null)).status).toBe(401) // the cron is closed without its secret
      expect(await jobOf(batch[1]!.id)).toMatchObject({ status: 'pending' })

      await makeAvailable(batch[1]!.id)
      const res = await cron()
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ processed: 2, failed: 0 })
      for (const m of batch) expect(await jobOf(m.id)).toMatchObject({ status: 'completed' })
      expect(flowTexts()).toEqual(['one', 'two', 'two', 'three']) // 'two' ran twice because its first attempt threw
      expect(await conversation()).toEqual({ last_message_text: 'three', unread_count: 3 }) // counted once each
      expect(await (await cron()).json()).toMatchObject({ processed: 0, failed: 0 })
    })
  })
})
