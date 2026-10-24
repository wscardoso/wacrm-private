import { describe, it, expect, beforeAll, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain, seedWorld } from '@/test/support/full-migration-chain'
import { pgliteSupabase } from '@/test/support/pglite-supabase-adapter'
import type { InboundDownstreamContext } from '@/lib/whatsapp/inbound-downstream'

let testDb: PGlite

vi.mock('@/lib/supabase/admin-client', () => ({
  supabaseAdmin: () => pgliteSupabase(testDb),
}))

const { dispatchNativeAgentForInbound } = await import('@/lib/agent/dispatch')
const { executeHandoffToHuman } = await import('@/lib/agent/handoff/execute')

describe('native agent dispatch (090 / F4 scaffold)', () => {
  let world: Awaited<ReturnType<typeof seedWorld>>
  let contactId: string
  let inboundMessageId: string

  beforeAll(async () => {
    testDb = await bootChain(90)
    world = await seedWorld(testDb)
    contactId = (
      await testDb.query<{ contact_id: string }>(
        `SELECT contact_id FROM conversations WHERE id = $1`,
        [world.convA],
      )
    ).rows[0]!.contact_id

    inboundMessageId = (
      await testDb.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
         VALUES ($1, 'customer', 'text', 'hi', 'ext-agent-1', 'delivered') RETURNING id`,
        [world.convA],
      )
    ).rows[0]!.id
  })

  function ctx(): InboundDownstreamContext {
    return {
      configOwnerUserId: '00000000-0000-4000-8000-00000000000a',
      accountId: world.accountA,
      contactId,
      conversationId: world.convA,
      isFirstInboundMessage: false,
      contactWasCreated: false,
      inboundText: 'hello',
      inboundType: 'text',
      externalMessageId: 'ext-agent-1',
      lastMessagePreview: 'hello',
      unreadCountBefore: 0,
    }
  }

  it('flag OFF — no agent_runs row', async () => {
    await testDb.query(
      `UPDATE accounts SET native_conversational_agent_enabled = FALSE WHERE id = $1`,
      [world.accountA],
    )
    const result = await dispatchNativeAgentForInbound({
      ctx: ctx(),
      inboundMessageId,
      flowConsumed: false,
    })
    expect(result.agentConsumed).toBe(false)
    const runs = await testDb.query(`SELECT 1 FROM agent_runs WHERE inbound_message_id = $1`, [
      inboundMessageId,
    ])
    expect(runs.rows.length).toBe(0)
  })

  it('flag ON — persists run + steps (no LLM)', async () => {
    await testDb.query(
      `UPDATE accounts SET native_conversational_agent_enabled = TRUE WHERE id = $1`,
      [world.accountA],
    )
    const msgId = (
      await testDb.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
         VALUES ($1, 'customer', 'text', 'hi2', $2, 'delivered') RETURNING id`,
        [world.convA, `ext-${crypto.randomUUID()}`],
      )
    ).rows[0]!.id

    const result = await dispatchNativeAgentForInbound({
      ctx: ctx(),
      inboundMessageId: msgId,
      flowConsumed: false,
    })
    expect(result.agentConsumed).toBe(false)
    expect(result.runId).toBeTruthy()

    const steps = await testDb.query<{ kind: string }>(
      `SELECT kind FROM agent_steps WHERE run_id = $1 ORDER BY step_index`,
      [result.runId],
    )
    expect(steps.rows.map((r) => r.kind)).toEqual(['eligibility', 'turn_stub'])
  })

  it('handoff_to_human activates Q11 suspension', async () => {
    await executeHandoffToHuman({
      accountId: world.accountA,
      conversationId: world.convA,
    })
    const row = await testDb.query<{ agent_suspended_after_handoff_at: string | null }>(
      `SELECT agent_suspended_after_handoff_at FROM conversations WHERE id = $1`,
      [world.convA],
    )
    expect(row.rows[0]?.agent_suspended_after_handoff_at).toBeTruthy()
    await testDb.query(`SELECT resume_conversational_agent($1::uuid)`, [world.convA])
  })
})
