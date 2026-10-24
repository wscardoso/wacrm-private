import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain, seedWorld } from '@/test/support/full-migration-chain'
import { buildDlqEnvelope, buildDlqErrorMessage } from '@/lib/whatsapp/inbound-dlq'

/**
 * 092 (queue order by message time), 093 (conversation effect, exactly once and
 * order-safe) and 094 (DLQ dedup + resolution), on the full migration chain in PGlite.
 * PGlite is a single connection: these tests fix the SEMANTICS; the behaviour under
 * overlapping connections is asserted in inbound-recovery.pg-server.test.ts.
 */

type Pair = { account: string; contact: string; conv: string; cfg: string }

describe('inbound turn ordering, conversation effect and DLQ (092-094)', () => {
  let db: PGlite
  let A: Pair
  let B: Pair
  let seq = 0
  /** Message times are expressed as seconds after this instant (an hour ago: always in the past). */
  const BASE = Date.now() - 3_600_000

  const iso = (sec: number) => new Date(BASE + sec * 1000).toISOString()
  const ext = () => `wamid.ord.${++seq}`

  const n = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`, params)).rows[0]!.n

  async function persist(pair: Pair, externalId: string, messageSec: number): Promise<string> {
    const { rows } = await db.query<{ r: { message_id: string } }>(
      `SELECT persist_inbound_message_with_turn(
         $1::uuid, 'customer', 'text', $2, NULL, $2, 'delivered', $3::timestamptz, NULL, NULL,
         $4::uuid, $5::uuid, '{}'::jsonb) AS r`,
      [pair.conv, externalId, iso(messageSec), pair.account, pair.contact],
    )
    return rows[0]!.r.message_id
  }
  const claimNext = async () =>
    (await db.query<{ message_id: string; claim_token: string }>(`SELECT * FROM claim_inbound_turn_job(300)`)).rows[0]
  const claimFor = async (id: string) =>
    (await db.query<{ message_id: string; claim_token: string }>(`SELECT * FROM claim_inbound_turn_for_message($1::uuid, 300)`, [id]))
      .rows[0]
  const complete = async (id: string, token: string) =>
    (await db.query<{ ok: boolean }>(`SELECT complete_inbound_turn_job($1::uuid, $2::uuid, true, NULL) AS ok`, [id, token])).rows[0]!.ok

  /** Claims and completes jobs one at a time, returning the order they ran in. */
  async function runAll(): Promise<string[]> {
    const order: string[] = []
    for (let i = 0; i < 20; i++) {
      const c = await claimNext()
      if (!c) break
      order.push(c.message_id)
      expect(await complete(c.message_id, c.claim_token)).toBe(true)
    }
    return order
  }

  beforeAll(async () => {
    db = await bootChain(9999)
    const world = await seedWorld(db)
    const pair = async (account: string, conv: string, cfg: string): Promise<Pair> => ({
      account,
      conv,
      cfg,
      contact: (await db.query<{ contact_id: string }>(`SELECT contact_id FROM conversations WHERE id = $1`, [conv])).rows[0]!.contact_id,
    })
    A = await pair(world.accountA, world.convA, world.cfgA)
    B = await pair(world.accountB, world.convB, world.cfgB)
  })

  beforeEach(async () => {
    await db.exec(`DELETE FROM inbound_turn_jobs; DELETE FROM whatsapp_webhook_dlq;`)
    await db.exec(`UPDATE conversations SET unread_count = 0, last_message_text = NULL, last_message_at = NULL`)
  })

  // ------------------------------------------------------------------ 092
  describe('092: the oldest MESSAGE of a contact runs first', () => {
    it('jobs inserted out of message order run in message order', async () => {
      const c = await persist(A, ext(), 3)
      const b = await persist(A, ext(), 2)
      const a = await persist(A, ext(), 1)
      expect(await runAll()).toEqual([a, b, c])
    })

    it('a redelivery that fills a gap runs the missing message before the later one that is still pending', async () => {
      const first = await persist(A, ext(), 1)
      const third = await persist(A, ext(), 3)
      const c1 = (await claimNext())!
      expect(c1.message_id).toBe(first)
      await complete(first, c1.claim_token)

      const second = await persist(A, ext(), 2) // inserted AFTER the third's job
      expect(await runAll()).toEqual([second, third])
    })

    it('messages with the same message time run in arrival order', async () => {
      const x = await persist(A, ext(), 5)
      await new Promise((r) => setTimeout(r, 5))
      const y = await persist(A, ext(), 5)
      await new Promise((r) => setTimeout(r, 5))
      const z = await persist(A, ext(), 5)
      expect(await runAll()).toEqual([x, y, z])
    })

    it('claim by message follows the same order: a younger message cannot jump an older pending one', async () => {
      const later = await persist(A, ext(), 9)
      const earlier = await persist(A, ext(), 8)

      expect(await claimFor(later)).toBeUndefined()
      const c = await claimFor(earlier)
      expect(c?.message_id).toBe(earlier)
      await complete(earlier, c!.claim_token)
      expect((await claimFor(later))?.message_id).toBe(later)
    })

    it('a turn that already started is not undone: an older message arriving now waits, then runs (late)', async () => {
      const later = await persist(A, ext(), 9)
      const running = (await claimNext())!
      expect(running.message_id).toBe(later)

      const earlier = await persist(A, ext(), 8)
      expect(await claimNext()).toBeUndefined() // blocked while the later one is processing
      expect(await complete(later, running.claim_token)).toBe(true)
      expect((await claimNext())?.message_id).toBe(earlier)
    })

    it('an older message arriving after a later one finished is simply the next job', async () => {
      const later = await persist(A, ext(), 9)
      const c = (await claimNext())!
      await complete(later, c.claim_token)

      const earlier = await persist(A, ext(), 8)
      expect((await claimNext())?.message_id).toBe(earlier)
    })

    it('an older pending job in backoff still holds a younger message, as in 088', async () => {
      const older = await persist(A, ext(), 1)
      const younger = await persist(A, ext(), 2)
      const c = (await claimNext())!
      expect(c.message_id).toBe(older)
      await db.query(`SELECT complete_inbound_turn_job($1::uuid, $2::uuid, false, 'boom')`, [older, c.claim_token])

      expect(await claimNext()).toBeUndefined()
      expect(await claimFor(younger)).toBeUndefined()
    })

    it('another contact is never held by the ordering of this one', async () => {
      await persist(A, ext(), 1)
      const holder = (await claimNext())! // A is now processing
      const other = await persist(B, ext(), 50)

      expect((await claimNext())?.message_id).toBe(other)
      expect(holder).toBeDefined()
    })

    it('the claim functions are still service_role only, SECURITY DEFINER, with a pinned search_path', async () => {
      const { rows } = await db.query<{ proname: string; secdef: boolean; cfg: string[] | null; anon: boolean; auth: boolean; svc: boolean }>(
        `SELECT p.proname, p.prosecdef AS secdef, p.proconfig AS cfg,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('claim_inbound_turn_job', 'claim_inbound_turn_for_message', 'apply_inbound_message_to_conversation')
          ORDER BY 1`,
      )
      expect(rows).toHaveLength(3)
      for (const r of rows) {
        expect(r).toMatchObject({ secdef: true, anon: false, auth: false, svc: true })
        expect(r.cfg).toContain('search_path=public')
      }
    })

    it('092 can be applied again without error', async () => {
      const { readMigration } = await import('@/test/support/full-migration-chain')
      await db.exec(readMigration('092'))
      const a = await persist(A, ext(), 1)
      expect(await runAll()).toEqual([a])
    })
  })

  // ------------------------------------------------------------------ 093
  describe('093: the conversation effect is applied once, atomically, and never regresses the preview', () => {
    const conversation = async (pair: Pair = A) =>
      (
        await db.query<{ unread_count: number; last_message_text: string | null; last_message_at: Date | null }>(
          `SELECT unread_count, last_message_text, last_message_at FROM conversations WHERE id = $1`,
          [pair.conv],
        )
      ).rows[0]!
    const apply = async (id: string, preview: string) =>
      (await db.query<{ ok: boolean }>(`SELECT apply_inbound_message_to_conversation($1::uuid, $2) AS ok`, [id, preview])).rows[0]!.ok

    it('applies once: the second call for the same message changes nothing and returns false', async () => {
      const id = await persist(A, ext(), 1)

      expect(await apply(id, 'hello')).toBe(true)
      expect(await apply(id, 'hello')).toBe(false)
      expect(await apply(id, 'other text')).toBe(false)
      expect(await conversation()).toMatchObject({ unread_count: 1, last_message_text: 'hello' })
    })

    it('a burst counts every message (no lost updates), whatever order the effects run in', async () => {
      const ids = [await persist(A, ext(), 1), await persist(A, ext(), 2), await persist(A, ext(), 3), await persist(A, ext(), 4), await persist(A, ext(), 5)]
      for (const id of ids) await apply(id, 'm')
      expect((await conversation()).unread_count).toBe(5)
    })

    it('the preview follows the newest message time', async () => {
      const one = await persist(A, ext(), 1)
      const two = await persist(A, ext(), 2)
      await apply(one, 'one')
      expect((await conversation()).last_message_text).toBe('one')
      await apply(two, 'two')
      expect(await conversation()).toMatchObject({ last_message_text: 'two', unread_count: 2 })
    })

    it('a message that runs after a newer one is counted but does not regress the preview or last_message_at', async () => {
      const older = await persist(A, ext(), 2)
      const newer = await persist(A, ext(), 3)
      await apply(newer, 'three')
      const before = await conversation()

      expect(await apply(older, 'two')).toBe(true)
      const after = await conversation()
      expect(after.unread_count).toBe(2)
      expect(after.last_message_text).toBe('three')
      expect(after.last_message_at!.getTime()).toBe(before.last_message_at!.getTime())
    })

    it('does not move the preview behind a more recent outbound activity', async () => {
      const id = await persist(A, ext(), 10)
      await db.query(`UPDATE conversations SET last_message_text = 'reply from the team', last_message_at = NOW() WHERE id = $1`, [A.conv])

      await apply(id, 'late customer message')
      expect(await conversation()).toMatchObject({ last_message_text: 'reply from the team', unread_count: 1 })
    })

    it('caps a provider clock that runs ahead at the database clock', async () => {
      const future = await persist(A, ext(), 7 * 24 * 3600)
      await apply(future, 'from the future')

      const { last_message_at } = await conversation()
      expect(last_message_at!.getTime()).toBeLessThanOrEqual(Date.now() + 5_000)
    })

    it('an unknown message is not applied', async () => {
      expect(await apply('99999999-9999-4999-8999-999999999999', 'x')).toBe(false)
      expect((await conversation()).unread_count).toBe(0)
    })

    it('is atomic: if the conversation update fails the claim of the effect rolls back, and the retry applies it once', async () => {
      const id = await persist(A, ext(), 1)
      await db.exec(`
        CREATE OR REPLACE FUNCTION t_fail_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF current_setting('app.t_fail_conversation', true) = 'on' THEN RAISE EXCEPTION 'injected conversation failure'; END IF;
          RETURN NEW;
        END $$;
        DROP TRIGGER IF EXISTS t_fail_conversation ON conversations;
        CREATE TRIGGER t_fail_conversation BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION t_fail_conversation();
      `)
      await db.query(`SELECT set_config('app.t_fail_conversation', 'on', false)`)

      await expect(apply(id, 'hello')).rejects.toThrow(/injected conversation failure/)
      expect(await n(`FROM inbound_turn_jobs WHERE message_id = $1 AND conversation_effect_at IS NULL`, [id])).toBe(1)
      expect((await conversation()).unread_count).toBe(0)

      await db.query(`SELECT set_config('app.t_fail_conversation', 'off', false)`)
      expect(await apply(id, 'hello')).toBe(true)
      expect(await apply(id, 'hello')).toBe(false)
      expect((await conversation()).unread_count).toBe(1)
    })

    it('only touches the conversation of the message', async () => {
      const id = await persist(A, ext(), 1)
      await apply(id, 'hello')
      expect((await conversation(B)).unread_count).toBe(0)
    })
  })

  // ------------------------------------------------------------------ 094
  describe('094: the DLQ stops growing per retry and resolves when the message is stored', () => {
    const enqueue = async (pair: Pair, stage: string, externalId: string | null, dbCode: string | null = 'P0001') => {
      const payload = buildDlqEnvelope('meta', stage as 'message_insert', { type: 'text', externalMessageId: externalId ?? undefined })
      const message = buildDlqErrorMessage('meta', stage as 'message_insert', dbCode)
      return (
        await db.query<{ id: string }>(`SELECT enqueue_webhook_dlq($1::uuid, $2::uuid, $3::jsonb, $4) AS id`, [
          pair.account,
          pair.cfg,
          JSON.stringify(payload),
          message,
        ])
      ).rows[0]!.id
    }
    const rows = async () =>
      (
        await db.query<{ id: string; status: string; occurrences: number; error_message: string; last_error_message: string; payload: { captured_at: string } }>(
          `SELECT id, status, occurrences, error_message, last_error_message, payload FROM whatsapp_webhook_dlq ORDER BY created_at, id`,
        )
      ).rows

    it('the same failure of the same message is one row whose occurrences grow', async () => {
      const e = ext()
      const first = await enqueue(A, 'message_insert', e)
      const second = await enqueue(A, 'message_insert', e)
      const third = await enqueue(A, 'message_insert', e)

      expect([second, third]).toEqual([first, first])
      const r = await rows()
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ id: first, status: 'pending', occurrences: 3 })
    })

    it('keeps the first diagnosis and envelope, and records the latest error', async () => {
      const e = ext()
      await enqueue(A, 'message_insert', e, 'P0001')
      const firstCapturedAt = (await rows())[0]!.payload.captured_at
      await enqueue(A, 'message_insert', e, 'XX000')

      const r = (await rows())[0]!
      expect(r.error_message).toBe('source=meta;stage=message_insert;db_code=P0001')
      expect(r.last_error_message).toBe('source=meta;stage=message_insert;db_code=XX000')
      expect(r.payload.captured_at).toBe(firstCapturedAt)
    })

    it('a different stage, message or tenant is a different failure with its own row', async () => {
      const e = ext()
      const a1 = await enqueue(A, 'message_insert', e)
      const a2 = await enqueue(A, 'conversation', e)
      const a3 = await enqueue(A, 'message_insert', ext())
      const b1 = await enqueue(B, 'message_insert', e)
      expect(new Set([a1, a2, a3, b1]).size).toBe(4)
      expect(await n(`FROM whatsapp_webhook_dlq`)).toBe(4)
    })

    it('a failure that cannot be correlated (no external id) still gets one row per call, as before', async () => {
      await enqueue(A, 'parse', null)
      await enqueue(A, 'parse', null)
      expect(await n(`FROM whatsapp_webhook_dlq`)).toBe(2)
    })

    it('the row is resolved when the message is stored, and a later failure opens a new row', async () => {
      const e = ext()
      const failed = await enqueue(A, 'message_insert', e)
      await enqueue(A, 'message_insert', e)

      await persist(A, e, 1)
      let r = await rows()
      expect(r).toHaveLength(1)
      expect(r[0]).toMatchObject({ id: failed, status: 'resolved', occurrences: 2 })

      const reopened = await enqueue(A, 'message_insert', e)
      expect(reopened).not.toBe(failed)
      r = await rows()
      expect(r.map((x) => x.status).sort()).toEqual(['pending', 'resolved'])
    })

    it('resolution is scoped to the tenant that stored the message', async () => {
      const e = ext()
      await enqueue(B, 'message_insert', e)
      await persist(A, e, 1) // same external id, other tenant

      expect((await rows())[0]!.status).toBe('pending')
    })

    it('a duplicate persist of an already stored message still resolves leftover pending rows', async () => {
      const e = ext()
      await persist(A, e, 1)
      await enqueue(A, 'message_insert', e)
      await persist(A, e, 1)
      expect((await rows())[0]!.status).toBe('resolved')
    })

    it('still refuses a config that does not belong to the account (ownership check of 082)', async () => {
      const payload = JSON.stringify(buildDlqEnvelope('meta', 'message_insert', { type: 'text', externalMessageId: ext() }))
      await expect(
        db.query(`SELECT enqueue_webhook_dlq($1::uuid, $2::uuid, $3::jsonb, 'x')`, [A.account, B.cfg, payload]),
      ).rejects.toMatchObject({ code: '42501' })
    })

    it('enqueue_webhook_dlq and persist keep their service_role-only ACL', async () => {
      const { rows: acl } = await db.query<{ proname: string; anon: boolean; auth: boolean; pub: boolean; svc: boolean }>(
        `SELECT p.proname,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('enqueue_webhook_dlq', 'persist_inbound_message_with_turn') ORDER BY 1`,
      )
      expect(acl).toHaveLength(2)
      for (const r of acl) expect(r).toMatchObject({ anon: false, auth: false, pub: false, svc: true })
    })
  })
})
