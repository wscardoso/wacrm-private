import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain, seedWorld, U } from '@/test/support/full-migration-chain'
import { pgliteSupabaseWithQuery } from '@/test/support/pglite-supabase-query'
import type { InboundMessage } from '@/lib/whatsapp/providers/types'

/**
 * T5 — inbound with the native agent OFF, through the real code.
 *
 * Entry point: processInboundMessage (src/lib/whatsapp/inbound-processor.ts), the
 * shared processor the multi-provider webhook route calls, in both of its modes:
 * inline (`full`) and deferred (`deferDownstream` + drainInboundTurnJobs, as the
 * route does). From there everything is the production code: contact and
 * conversation upsert, persist_inbound_message_with_turn (091), claim / lease /
 * complete (088), runInboundDownstreamFromContext, dispatchNativeAgentForInbound,
 * checkAgentEligibility and the agent_runs writers, on the real 001–091 schema.
 *
 * Mocked at their boundary, because they are other subsystems with their own
 * suites: the flow engine (dispatchInboundToFlows) and the automation engine.
 * Stubbed with an empty result: the broadcast-reply flag (an embedded join the
 * test client does not model); this step is therefore NOT verified here.
 *
 * Flag evidence has two independent sources: the rows in agent_runs/agent_steps,
 * and a log of every table the app code touched (an access to agent_runs,
 * agent_steps or flow_runs means the eligibility check did not stop at the flag).
 * A positive control with the flag ON (PGlite only, reset after each test) proves
 * that both detectors can see an agent run.
 *
 * Local PGlite only: no R1_PG_URL, no network, no real flag or secret.
 */

type Fault = { message: string; code?: string }
const state = vi.hoisted(() => ({
  tables: [] as string[],
  tableFault: {} as Record<string, Fault | undefined>,
}))
const { mockFlows, mockAutomations, mockCancel } = vi.hoisted(() => ({
  mockFlows: vi.fn(),
  mockAutomations: vi.fn(),
  mockCancel: vi.fn(),
}))

let testDb: PGlite

/** A chain whose every method returns itself and which resolves to `result`. */
function constantChain(result: { data: unknown; error: Fault | null }) {
  const chain: unknown = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR)
          : () => chain,
    },
  )
  return chain
}

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => {
    const real = pgliteSupabaseWithQuery(testDb)
    return {
      ...real,
      from(table: string) {
        state.tables.push(table)
        // Stub (see header): the embedded join of flagBroadcastReplyIfAny is not modelled.
        if (table === 'broadcast_recipients') return constantChain({ data: [], error: null })
        const fault = state.tableFault[table]
        if (fault) return constantChain({ data: null, error: fault })
        return real.from(table)
      },
    }
  },
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: mockFlows }))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: mockAutomations,
  cancelPendingCadencesForContact: mockCancel,
}))

const { processInboundMessage } = await import('@/lib/whatsapp/inbound-processor')
const { drainInboundTurnJobs } = await import('@/lib/agent/turn/drain')
const { InboundPersistenceError, InboundPostInsertError } = await import('@/lib/whatsapp/inbound-dlq')

const AGENT_TABLES = ['agent_runs', 'agent_steps']

describe('inbound with the native agent OFF (T5)', () => {
  let world: Awaited<ReturnType<typeof seedWorld>>
  let seq = 0
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => {
    const n = ++seq
    return {
      messageId: `wamid.t5.${n}`,
      from: `55119770${String(n).padStart(5, '0')}`,
      senderName: 'Cliente T5',
      timestamp: '1761220800',
      type: 'text',
      text: 'hello',
      ...over,
    }
  }

  const run = (msg: InboundMessage, opts?: { deferDownstream?: boolean }, account = world.accountA) =>
    processInboundMessage(msg, account, U.ownerA, opts)

  const n = async (sql: string, params: unknown[] = []) =>
    (await testDb.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n

  const agentRuns = () => n('FROM agent_runs')
  const agentSteps = () => n('FROM agent_steps')

  async function job(externalId: string) {
    return (
      await testDb.query<{ status: string; attempt_count: number; last_error: string | null; completed_at: Date | null }>(
        `SELECT j.status, j.attempt_count, j.last_error, j.completed_at
           FROM inbound_turn_jobs j JOIN messages m ON m.id = j.message_id WHERE m.message_id = $1`,
        [externalId],
      )
    ).rows[0]
  }
  const makeAvailable = (externalId: string) =>
    testDb.query(
      `UPDATE inbound_turn_jobs SET available_at = clock_timestamp()
        WHERE message_id IN (SELECT id FROM messages WHERE message_id = $1)`,
      [externalId],
    )
  async function conversationOf(msg: InboundMessage) {
    return (
      await testDb.query<{ id: string; contact_id: string; last_message_text: string | null; unread_count: number; last_message_at: Date | null }>(
        `SELECT c.id, c.contact_id, c.last_message_text, c.unread_count, c.last_message_at
           FROM conversations c JOIN contacts k ON k.id = c.contact_id
          WHERE k.account_id = $1 AND k.phone = $2`,
        [world.accountA, msg.from],
      )
    ).rows[0]
  }
  const messageCount = (externalId: string) => n(`FROM messages WHERE message_id = $1`, [externalId])
  const jobCount = () => n('FROM inbound_turn_jobs')

  const triggers = () => mockAutomations.mock.calls.map((c) => (c[0] as { triggerType: string }).triggerType)
  const touchedAgentTables = () => state.tables.filter((t) => AGENT_TABLES.includes(t))

  beforeAll(async () => {
    testDb = await bootChain(9999)
    world = await seedWorld(testDb)
    // Test-only fault injector on the DISPOSABLE db (not a migration): fails the job
    // insert inside persist_inbound_message_with_turn while the GUC is on.
    await testDb.exec(`
      CREATE FUNCTION t5_fail_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('app.t5_fail_job_insert', true) = 'on' THEN
          RAISE EXCEPTION 't5 injected job failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER t5_fail_job_insert BEFORE INSERT ON inbound_turn_jobs
        FOR EACH ROW EXECUTE FUNCTION t5_fail_job_insert();
    `)
  })

  beforeEach(async () => {
    // Jobs are global (the drain claims any of them): start every test with an empty queue.
    await testDb.exec(`DELETE FROM inbound_turn_jobs`)
    state.tables.length = 0
    state.tableFault = {}
    mockFlows.mockReset()
    mockFlows.mockResolvedValue({ consumed: false })
    mockAutomations.mockReset()
    mockAutomations.mockResolvedValue(undefined)
    mockCancel.mockReset()
    mockCancel.mockResolvedValue(0)
    // The invariant under test must start true, not be inherited.
    expect(await agentRuns()).toBe(0)
    expect(await agentSteps()).toBe(0)
    expect(
      await n(`FROM accounts WHERE native_conversational_agent_enabled`),
    ).toBe(0)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    // Restore the disposable db whatever the test did.
    await testDb.query(`SELECT set_config('app.t5_fail_job_insert', 'off', false)`)
    await testDb.exec(`UPDATE accounts SET native_conversational_agent_enabled = FALSE; DELETE FROM agent_runs;`)
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  // ------------------------------------------------------------------ 1, 2, 3
  describe('flag OFF: the existing inbound flow works and starts no agent', () => {
    it('inline: persists the contact, conversation, message and job, runs the downstream and completes the job', async () => {
      const msg = inbound()
      await run(msg)

      expect(await testDb.query(`SELECT 1 FROM contacts WHERE account_id = $1 AND phone = $2`, [world.accountA, msg.from])).toHaveProperty('rows.length', 1)
      const message = await testDb.query(
        `SELECT sender_type, content_type, content_text, status FROM messages WHERE message_id = $1`,
        [msg.messageId],
      )
      expect(message.rows).toEqual([{ sender_type: 'customer', content_type: 'text', content_text: 'hello', status: 'delivered' }])

      // The job went pending -> processing -> completed in one attempt, context kept.
      const j = await job(msg.messageId)
      expect(j).toMatchObject({ status: 'completed', attempt_count: 1, last_error: null })
      expect(j!.completed_at).toBeInstanceOf(Date)
      const ctx = (
        await testDb.query<{ downstream_context: Record<string, unknown> }>(
          `SELECT j.downstream_context FROM inbound_turn_jobs j JOIN messages m ON m.id = j.message_id WHERE m.message_id = $1`,
          [msg.messageId],
        )
      ).rows[0]!.downstream_context
      expect(ctx).toMatchObject({
        accountId: world.accountA,
        isFirstInboundMessage: true,
        contactWasCreated: true,
        inboundText: 'hello',
        externalMessageId: msg.messageId,
      })

      // Downstream effects.
      const conv = await conversationOf(msg)
      expect(conv).toMatchObject({ last_message_text: 'hello', unread_count: 1 })
      expect(conv!.last_message_at).toBeInstanceOf(Date)
      expect(mockFlows).toHaveBeenCalledTimes(1)
      expect(mockFlows).toHaveBeenCalledWith({
        accountId: world.accountA,
        userId: U.ownerA,
        contactId: conv!.contact_id,
        conversationId: conv!.id,
        message: { kind: 'text', text: 'hello', meta_message_id: msg.messageId },
        isFirstInboundMessage: true,
      })
      expect(triggers()).toEqual(['first_inbound_message', 'new_contact_created', 'new_message_received', 'keyword_match'])
      expect(mockAutomations).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: world.accountA,
          contactId: conv!.contact_id,
          context: { message_text: 'hello', conversation_id: conv!.id },
        }),
      )
      expect(mockCancel).toHaveBeenCalledWith(world.accountA, conv!.contact_id)
    })

    it('inline: creates no agent_runs and no agent_steps, and the flag was actually consulted', async () => {
      await run(inbound())

      expect(await agentRuns()).toBe(0)
      expect(await agentSteps()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
      expect(state.tables).toContain('accounts') // checkAgentEligibility read the flag...
      expect(state.tables).not.toContain('flow_runs') // ...and stopped there (flag_off)
    })

    it('a second message of the same contact is not "first", counts unread cumulatively, and still starts no agent', async () => {
      const first = inbound()
      await run(first)
      await run(inbound({ from: first.from }))

      const conv = await conversationOf(first)
      expect(conv!.unread_count).toBe(2)
      expect(mockFlows).toHaveBeenLastCalledWith(expect.objectContaining({ isFirstInboundMessage: false }))
      expect(triggers().slice(4)).toEqual(['new_message_received', 'keyword_match'])
      expect(await agentRuns()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
    })

    it('a flow that consumes the message still suppresses the content triggers and does not reach the agent at all', async () => {
      mockFlows.mockResolvedValue({ consumed: true })
      const msg = inbound()
      await run(msg)

      expect(triggers()).toEqual(['first_inbound_message', 'new_contact_created'])
      expect((await job(msg.messageId))!.status).toBe('completed')
      expect(state.tables).not.toContain('accounts') // dispatch returned before the eligibility check
      expect(await agentRuns()).toBe(0)
    })

    it('deferred (the webhook route mode): persists only; the drain runs the downstream; no agent', async () => {
      const msg = inbound()
      await run(msg, { deferDownstream: true })

      // Persisted and queued, nothing downstream yet.
      expect(await job(msg.messageId)).toMatchObject({ status: 'pending', attempt_count: 0 })
      expect(await conversationOf(msg)).toMatchObject({ last_message_text: null, unread_count: 0 })
      expect(mockFlows).not.toHaveBeenCalled()
      expect(state.tables).not.toContain('accounts')

      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 0, skipped: 1 })
      expect(await job(msg.messageId)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(await conversationOf(msg)).toMatchObject({ last_message_text: 'hello', unread_count: 1 })
      expect(mockFlows).toHaveBeenCalledTimes(1)
      expect(triggers()).toHaveLength(4)
      expect(await agentRuns()).toBe(0)
      expect(await agentSteps()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
      expect(state.tables).toContain('accounts')
    })
  })

  // ------------------------------------------------------------------ 4
  describe('duplicates', () => {
    it('the same message delivered twice inline: one message, one job, one downstream run', async () => {
      const msg = inbound()
      await run(msg)
      const before = { flows: mockFlows.mock.calls.length, autos: mockAutomations.mock.calls.length }

      await run(msg)
      expect(await messageCount(msg.messageId)).toBe(1)
      expect(await jobCount()).toBe(1)
      expect(mockFlows.mock.calls.length).toBe(before.flows)
      expect(mockAutomations.mock.calls.length).toBe(before.autos)
      expect((await conversationOf(msg))!.unread_count).toBe(1)
      expect(await job(msg.messageId)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(await agentRuns()).toBe(0)
    })

    it('a duplicate that arrives while the job is still pending adds nothing; the drain runs the downstream once', async () => {
      const msg = inbound()
      await run(msg, { deferDownstream: true })
      await run(msg, { deferDownstream: true })
      await run(msg) // a duplicate with the inline mode does not process the pending job either

      expect(await messageCount(msg.messageId)).toBe(1)
      expect(await jobCount()).toBe(1)
      expect(await job(msg.messageId)).toMatchObject({ status: 'pending', attempt_count: 0 })
      expect(mockFlows).not.toHaveBeenCalled()

      await drainInboundTurnJobs()
      expect(mockFlows).toHaveBeenCalledTimes(1)
      expect(await job(msg.messageId)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(await agentRuns()).toBe(0)
    })
  })

  // ------------------------------------------------------------------ 5
  describe('failures and retries never start an agent while the flag is OFF', () => {
    it('a downstream failure leaves the message and a retryable job; the retry completes it once and still starts no agent', async () => {
      mockFlows.mockRejectedValueOnce(new Error('flows down'))
      const msg = inbound()

      const failure = await run(msg).catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(InboundPostInsertError)

      // Message durable, job pending with backoff and the cause recorded.
      expect(await messageCount(msg.messageId)).toBe(1)
      expect(await job(msg.messageId)).toMatchObject({ status: 'pending', attempt_count: 1, last_error: 'flows down' })
      expect(mockAutomations).not.toHaveBeenCalled()
      expect(await agentRuns()).toBe(0)
      expect(touchedAgentTables()).toEqual([])

      // A redelivery during the backoff changes nothing and does not run the downstream.
      const flowsCalls = mockFlows.mock.calls.length
      await run(msg)
      expect(mockFlows.mock.calls.length).toBe(flowsCalls)
      expect(await job(msg.messageId)).toMatchObject({ status: 'pending', attempt_count: 1 })

      // Retry after the backoff.
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 }) // still in backoff
      await makeAvailable(msg.messageId)
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 1, failed: 0, skipped: 1 })
      expect(await job(msg.messageId)).toMatchObject({ status: 'completed', attempt_count: 2 })
      expect(triggers()).toHaveLength(4) // automations fired once: the failed attempt never reached them
      expect((await conversationOf(msg))!.unread_count).toBe(1) // the absolute update is idempotent across attempts
      expect(await agentRuns()).toBe(0)
      expect(await agentSteps()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
    })

    it('an error while reading the flag fails closed: the job is retried, no agent run is created', async () => {
      state.tableFault.accounts = { message: 'accounts down', code: '57P01' }
      const msg = inbound()

      await expect(run(msg)).rejects.toBeInstanceOf(InboundPostInsertError)
      expect(await job(msg.messageId)).toMatchObject({
        status: 'pending',
        attempt_count: 1,
        last_error: 'agent eligibility account: accounts down',
      })
      expect(await agentRuns()).toBe(0)
      expect(touchedAgentTables()).toEqual([])

      delete state.tableFault.accounts
      await makeAvailable(msg.messageId)
      await drainInboundTurnJobs()
      expect(await job(msg.messageId)).toMatchObject({ status: 'completed', attempt_count: 2 })
      // Characterization: the flow step ran in both attempts (its own idempotency guards that).
      expect(mockFlows).toHaveBeenCalledTimes(2)
      expect(await agentRuns()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
    })

    it('a job that keeps failing ends in failed after 5 attempts, with no agent run along the way', async () => {
      mockFlows.mockRejectedValue(new Error('flows down'))
      const msg = inbound()
      await run(msg).catch(() => undefined) // attempt 1

      for (let attempt = 2; attempt <= 5; attempt++) {
        await makeAvailable(msg.messageId)
        expect(await drainInboundTurnJobs()).toMatchObject({ processed: 0, failed: 1 })
        expect((await job(msg.messageId))!.attempt_count).toBe(attempt)
      }
      expect(await job(msg.messageId)).toMatchObject({ status: 'failed', attempt_count: 5, last_error: 'flows down' })
      expect(await drainInboundTurnJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0, skipped: 1 })
      expect(mockFlows).toHaveBeenCalledTimes(5)
      expect(await messageCount(msg.messageId)).toBe(1)
      expect(await agentRuns()).toBe(0)
      expect(await agentSteps()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
    })
  })

  // ------------------------------------------------------------------ 6
  describe('error paths leave no partial message or job', () => {
    it('a failure inserting the job rolls back the message; redelivery then succeeds', async () => {
      const msg = inbound()
      await testDb.query(`SELECT set_config('app.t5_fail_job_insert', 'on', false)`)

      const failure = await run(msg).catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(InboundPersistenceError)
      expect(failure).toMatchObject({ stage: 'message_insert', dbCode: 'P0001' })

      // Neither half of the durable pair exists; nothing downstream or agent ran.
      expect(await messageCount(msg.messageId)).toBe(0)
      expect(await jobCount()).toBe(0)
      expect(mockFlows).not.toHaveBeenCalled()
      expect(mockAutomations).not.toHaveBeenCalled()
      expect(await agentRuns()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
      // Contact and conversation are created before the pair (existing behaviour); the conversation is untouched.
      expect(await conversationOf(msg)).toMatchObject({ last_message_text: null, unread_count: 0 })

      await testDb.query(`SELECT set_config('app.t5_fail_job_insert', 'off', false)`)
      await run(msg)
      expect(await messageCount(msg.messageId)).toBe(1)
      expect(await job(msg.messageId)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(mockFlows).toHaveBeenCalledTimes(1)
      expect(await agentRuns()).toBe(0)
    })

    it('an unknown account fails at the contact stage and writes nothing', async () => {
      const msg = inbound()
      const failure = await run(msg, undefined, '99999999-9999-4999-8999-999999999999').catch((e: unknown) => e)

      expect(failure).toBeInstanceOf(InboundPersistenceError)
      expect(failure).toMatchObject({ stage: 'contact', dbCode: '23503' })
      expect(await n(`FROM contacts WHERE phone = $1`, [msg.from])).toBe(0)
      expect(await messageCount(msg.messageId)).toBe(0)
      expect(await jobCount()).toBe(0)
      expect(mockFlows).not.toHaveBeenCalled()
      expect(await agentRuns()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
    })

    it('a callback that is not a message (type unknown, no id) is dropped before any write', async () => {
      const msg = inbound({ type: 'unknown', messageId: '', text: undefined })
      await run(msg)

      expect(await n(`FROM contacts WHERE phone = $1`, [msg.from])).toBe(0)
      expect(await jobCount()).toBe(0)
      expect(mockFlows).not.toHaveBeenCalled()
      expect(state.tables).toEqual([])
    })
  })

  // ------------------------------------------------------------------ 7
  describe('positive control: the same path DOES create an agent run when the flag is ON (PGlite only)', () => {
    it('flag ON for the tenant: exactly one run with its two steps, the downstream still runs', async () => {
      await testDb.query(`UPDATE accounts SET native_conversational_agent_enabled = TRUE WHERE id = $1`, [world.accountA])
      const msg = inbound()
      await run(msg)

      const runs = await testDb.query<{ account_id: string; status: string; agent_consumed: boolean; skip_reason: string | null; inbound_message_id: string }>(
        `SELECT account_id, status, agent_consumed, skip_reason, inbound_message_id FROM agent_runs`,
      )
      const messageId = (await testDb.query<{ id: string }>(`SELECT id FROM messages WHERE message_id = $1`, [msg.messageId])).rows[0]!.id
      expect(runs.rows).toEqual([
        { account_id: world.accountA, status: 'completed', agent_consumed: false, skip_reason: null, inbound_message_id: messageId },
      ])
      const steps = await testDb.query<{ kind: string; decision: Record<string, unknown> }>(
        `SELECT kind, decision FROM agent_steps ORDER BY step_index`,
      )
      expect(steps.rows.map((s) => s.kind)).toEqual(['eligibility', 'turn_stub'])
      expect(steps.rows[0]!.decision).toEqual({ eligible: true, reason: 'ok' })

      // The detectors used by the OFF tests see this.
      expect(touchedAgentTables()).toEqual(expect.arrayContaining(AGENT_TABLES))
      expect(state.tables).toContain('flow_runs')
      // The agent does not consume the message in this scaffold: downstream is unchanged.
      expect(await job(msg.messageId)).toMatchObject({ status: 'completed', attempt_count: 1 })
      expect(triggers()).toHaveLength(4)
    })

    it('the flag is per tenant: ON for another account does not start a run for this one', async () => {
      await testDb.query(`UPDATE accounts SET native_conversational_agent_enabled = TRUE WHERE id = $1`, [world.accountB])
      await run(inbound())

      expect(await agentRuns()).toBe(0)
      expect(touchedAgentTables()).toEqual([])
    })

    it('the control leaves nothing behind: the next message, with the flag reset, creates no run', async () => {
      // afterEach of the previous tests reset the flag and cleared agent_runs.
      expect(await n(`FROM accounts WHERE native_conversational_agent_enabled`)).toBe(0)
      await run(inbound())
      expect(await agentRuns()).toBe(0)
    })
  })
})
