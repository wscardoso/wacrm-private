import { describe, it, expect, beforeAll } from 'vitest'
import { bootChain, seedWorld } from '@/test/support/full-migration-chain'
import type { PGlite } from '@electric-sql/pglite'

describe('agent handoff suspension (089 / Q11)', () => {
  let db: PGlite
  let convId: string

  beforeAll(async () => {
    db = await bootChain(89)
    const world = await seedWorld(db)
    convId = world.convA
  })

  it('suspend then resume requires explicit resume', async () => {
    await db.query(`SELECT suspend_conversational_agent_after_handoff($1::uuid)`, [convId])
    const mid = await db.query<{ agent_suspended_after_handoff_at: string | null }>(
      `SELECT agent_suspended_after_handoff_at FROM conversations WHERE id = $1`,
      [convId],
    )
    expect(mid.rows[0]?.agent_suspended_after_handoff_at).toBeTruthy()

    await db.query(`SELECT resume_conversational_agent($1::uuid)`, [convId])
    const after = await db.query<{ agent_suspended_after_handoff_at: string | null }>(
      `SELECT agent_suspended_after_handoff_at FROM conversations WHERE id = $1`,
      [convId],
    )
    expect(after.rows[0]?.agent_suspended_after_handoff_at).toBeNull()
  })

  it('inbound message alone does not clear suspension', async () => {
    await db.query(`SELECT suspend_conversational_agent_after_handoff($1::uuid)`, [convId])
    await db.query(
      `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
       VALUES ($1, 'customer', 'text', 'oi', 'inbound-no-resume', 'delivered')`,
      [convId],
    )
    const row = await db.query<{ agent_suspended_after_handoff_at: string | null }>(
      `SELECT agent_suspended_after_handoff_at FROM conversations WHERE id = $1`,
      [convId],
    )
    expect(row.rows[0]?.agent_suspended_after_handoff_at).toBeTruthy()
    await db.query(`SELECT resume_conversational_agent($1::uuid)`, [convId])
  })
})
