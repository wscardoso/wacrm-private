import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain, seedWorld } from '@/test/support/full-migration-chain'
import { pgliteSupabaseWithRpc, type PgliteRpcError } from '@/test/support/pglite-supabase-rpc'

/**
 * H0 — the generic rpc() helper, checked against the real 088–091 functions.
 * The last block drives the seven substrate.ts wrappers through one job
 * lifecycle, so the argument names/types they send are the ones Postgres has.
 */

let testDb: PGlite

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => pgliteSupabaseWithRpc(testDb),
}))

const substrate = await import('@/lib/agent/turn/substrate')

describe('pgliteSupabaseWithRpc (H0)', () => {
  let world: Awaited<ReturnType<typeof seedWorld>>
  let contactId: string
  let client: ReturnType<typeof pgliteSupabaseWithRpc>

  async function message(externalId: string): Promise<string> {
    const { rows } = await testDb.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
       VALUES ($1, 'customer', 'text', 'hello', $2, 'delivered') RETURNING id`,
      [world.convA, externalId],
    )
    return rows[0]!.id
  }

  const registerArgs = (messageId: string) => ({
    p_message_id: messageId,
    p_account_id: world.accountA,
    p_contact_id: contactId,
    p_conversation_id: world.convA,
    p_downstream_context: { accountId: world.accountA },
  })

  async function jobRow(messageId: string) {
    const { rows } = await testDb.query<{ status: string; attempt_count: number; claim_token: string | null }>(
      `SELECT status, attempt_count, claim_token FROM inbound_turn_jobs WHERE message_id = $1`,
      [messageId],
    )
    return rows[0]
  }

  beforeAll(async () => {
    testDb = await bootChain(91)
    world = await seedWorld(testDb)
    contactId = (
      await testDb.query<{ contact_id: string }>(`SELECT contact_id FROM conversations WHERE id = $1`, [
        world.convA,
      ])
    ).rows[0]!.contact_id
    client = pgliteSupabaseWithRpc(testDb)
  })

  beforeEach(async () => {
    await testDb.exec(`DELETE FROM inbound_turn_jobs`)
  })

  describe('return shapes', () => {
    it('scalar boolean: register is true once, then false (ON CONFLICT DO NOTHING)', async () => {
      const id = await message('wamid.h0.scalar')
      expect(await client.rpc('register_inbound_turn_job', registerArgs(id))).toEqual({ data: true, error: null })
      expect(await client.rpc('register_inbound_turn_job', registerArgs(id))).toEqual({ data: false, error: null })
    })

    it('scalar boolean reflects the SQL result (suspend of an unknown conversation is false)', async () => {
      const real = await client.rpc('suspend_conversational_agent_after_handoff', {
        p_conversation_id: world.convA,
      })
      const unknown = await client.rpc('suspend_conversational_agent_after_handoff', {
        p_conversation_id: '99999999-9999-4999-8999-999999999999',
      })
      expect(real.data).toBe(true)
      expect(unknown.data).toBe(false)
      expect((await client.rpc('resume_conversational_agent', { p_conversation_id: world.convA })).data).toBe(true)
    })

    it('scalar integer: reclaim returns a number', async () => {
      const { data, error } = await client.rpc('reclaim_stuck_inbound_turn_jobs', { p_stale_seconds: 0 })
      expect(error).toBeNull()
      expect(data).toBe(0)
    })

    it('set-returning: claim returns rows, and [] (not null) on an empty queue', async () => {
      const empty = await client.rpc('claim_inbound_turn_job', { p_lock_seconds: 300 })
      expect(empty).toEqual({ data: [], error: null })

      const id = await message('wamid.h0.set')
      await client.rpc('register_inbound_turn_job', registerArgs(id))
      const { data, error } = await client.rpc('claim_inbound_turn_job', { p_lock_seconds: 300 })
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0]).toMatchObject({ message_id: id, account_id: world.accountA, contact_id: contactId })
      expect(typeof data![0].claim_token).toBe('string')
    })

    it('jsonb return with 13 arguments (uuid, text, timestamptz, jsonb) comes back as an object', async () => {
      const { data, error } = await client.rpc('persist_inbound_message_with_turn', {
        p_conversation_id: world.convA,
        p_sender_type: 'customer',
        p_content_type: 'text',
        p_content_text: 'hi',
        p_media_url: null,
        p_message_id: 'wamid.h0.jsonb',
        p_status: 'delivered',
        p_created_at: '2026-10-23T12:00:00.000Z',
        p_reply_to_message_id: null,
        p_interactive_reply_id: null,
        p_account_id: world.accountA,
        p_contact_id: contactId,
        p_downstream_context: { accountId: world.accountA },
      })
      expect(error).toBeNull()
      expect(data).toMatchObject({ message_inserted: true, job_ready: true })
      expect(typeof (data as { message_id: string }).message_id).toBe('string')
    })
  })

  describe('errors are surfaced, not swallowed', () => {
    it('SQL error keeps the SQLSTATE and message (foreign key violation)', async () => {
      const { data, error } = await client.rpc('register_inbound_turn_job', {
        ...registerArgs('88888888-8888-4888-8888-888888888888'),
      })
      expect(data).toBeNull()
      const e = error as unknown as PgliteRpcError
      expect(e.code).toBe('23503')
      expect(e.message).toMatch(/foreign key/i)
    })

    it('argument of the wrong type fails in Postgres (22P02), it is not coerced away', async () => {
      const { data, error } = await client.rpc('claim_inbound_turn_job', { p_lock_seconds: 'abc' })
      expect(data).toBeNull()
      expect((error as unknown as PgliteRpcError).code).toBe('22P02')
    })

    it('unknown function is PGRST202', async () => {
      const { data, error } = await client.rpc('no_such_function', {})
      expect(data).toBeNull()
      expect((error as unknown as PgliteRpcError).code).toBe('PGRST202')
    })

    it('unknown argument name is PGRST202 and names the argument', async () => {
      const { data, error } = await client.rpc('claim_inbound_turn_job', { p_lock_secs: 300 })
      expect(data).toBeNull()
      const e = error as unknown as PgliteRpcError
      expect(e.code).toBe('PGRST202')
      expect(e.message).toContain('p_lock_secs')
    })

    it('a function missing a required argument fails in Postgres, not in the helper', async () => {
      const { data, error } = await client.rpc('complete_inbound_turn_job', {
        p_message_id: '77777777-7777-4777-8777-777777777777',
      })
      expect(data).toBeNull()
      expect((error as unknown as PgliteRpcError).code).toBe('42883')
    })
  })

  it('keeps the shared adapter from() untouched', async () => {
    const { data } = await client.from('accounts').select('id').eq('id', world.accountA).maybeSingle()
    expect(data).toMatchObject({ id: world.accountA })
  })

  describe('substrate.ts wrappers over the real functions', () => {
    it('runs register, persist, claim, renew, complete and reclaim through one job lifecycle', async () => {
      // persist (091): new message + job, then the duplicate recovers the same ids.
      const persistArgs = {
        conversationId: world.convA,
        contentType: 'text',
        contentText: 'hi',
        mediaUrl: null,
        externalMessageId: 'wamid.h0.lifecycle',
        createdAt: '2026-10-23T12:00:00.000Z',
        replyToMessageId: null,
        interactiveReplyId: null,
        accountId: world.accountA,
        contactId,
        downstreamContext: { accountId: world.accountA },
      }
      const first = await substrate.persistInboundMessageWithTurn(persistArgs)
      const dup = await substrate.persistInboundMessageWithTurn(persistArgs)
      expect(first).toMatchObject({ messageInserted: true, jobReady: true })
      expect(dup).toEqual({ messageId: first.messageId, messageInserted: false, jobReady: true })

      // register is idempotent on the persisted message; a fresh message registers.
      expect(
        await substrate.registerInboundTurnJob({
          messageId: first.messageId,
          accountId: world.accountA,
          contactId,
          conversationId: world.convA,
        }),
      ).toBe(false)
      const other = await message('wamid.h0.register')
      expect(
        await substrate.registerInboundTurnJob({
          messageId: other,
          accountId: world.accountA,
          contactId,
          conversationId: world.convA,
          downstreamContext: { k: 1 },
        }),
      ).toBe(true)

      // claim by message id, renew, fail it once: back to pending with backoff.
      const claim = await substrate.claimInboundTurnForMessage(first.messageId, 300)
      expect(claim).toMatchObject({ messageId: first.messageId, accountId: world.accountA, contactId })
      expect(await substrate.renewInboundTurnLease({ messageId: first.messageId, claimToken: claim!.claimToken })).toBe(
        true,
      )
      expect(
        await substrate.completeInboundTurnJob({
          messageId: first.messageId,
          claimToken: claim!.claimToken,
          success: false,
          error: 'boom',
        }),
      ).toBe(true)
      expect(await jobRow(first.messageId)).toMatchObject({ status: 'pending', attempt_count: 1, claim_token: null })

      // stale token is refused after the job moved on.
      expect(
        await substrate.completeInboundTurnJob({
          messageId: first.messageId,
          claimToken: claim!.claimToken,
          success: true,
        }),
      ).toBe(false)

      // the older job of the pair is in backoff, so it holds the pair: nothing to claim (null, not an error).
      expect(await substrate.claimInboundTurnJob(300)).toBeNull()

      // once available it is first in the global queue; an expired lease is reclaimed.
      await testDb.query(`UPDATE inbound_turn_jobs SET available_at = clock_timestamp() WHERE message_id = $1`, [
        first.messageId,
      ])
      const next = await substrate.claimInboundTurnJob(300)
      expect(next?.messageId).toBe(first.messageId)
      await testDb.query(
        `UPDATE inbound_turn_jobs SET locked_until = clock_timestamp() - INTERVAL '1 second' WHERE message_id = $1`,
        [first.messageId],
      )
      expect(await substrate.reclaimStuckInboundTurnJobs(0)).toBe(1)
      expect(await jobRow(first.messageId)).toMatchObject({ status: 'pending', attempt_count: 2, claim_token: null })
      expect(await jobRow(other)).toMatchObject({ status: 'pending', attempt_count: 0 })
    })
  })
})
