import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asService, asUser, bootChain, errorOf, readMigration, seedMessage, seedWorld, U, type World } from './support/full-migration-chain'

// =============================================================
// Post-audit defect 5 — public.messages carried ONE write policy for
// authenticated users, `messages_modify FOR ALL ... is_account_member(acct,
// 'agent')` (017, never overridden by 038/073/083), on top of full table
// grants. Any agent could therefore, through PostgREST and with their own JWT:
//   * UPDATE status / message_id (bypassing settle_outbound_message and the
//     CAS of the status handler);
//   * UPDATE or INSERT connection_ref / delivery_provider / delivery_channel_fp
//     (migration 083), bypassing "createIntent is the only creator" (DLB-001).
//
// Effective-state evidence: this file runs the REAL chain 001..N on PGlite.
//   BEFORE = chain 001..085 (085 is the unrelated facade patch; messages is
//            untouched until 086) -> proves the defect;
//   AFTER  = full chain (086 included).
// "Who legitimately writes messages with a user session" was mapped by grep
// over src/: exactly one writer — createIntent (INSERT, from /send) — and no
// UPDATE/DELETE at all; every status write is service_role (CAS handler,
// webhook) or SECURITY DEFINER (settle_*). That is what the AFTER block pins.
// =============================================================

const PROTECTED_UPDATES: Array<[string, string]> = [
  ['status', `status = 'failed'`],
  ['message_id', `message_id = 'wamid.FORGED'`],
  ['connection_ref', `connection_ref = NULL`],
  ['delivery_provider', `delivery_provider = 'uazapi'`],
  ['delivery_channel_fp', `delivery_channel_fp = 'v1:forged'`],
  ['idempotency_key', `idempotency_key = gen_random_uuid()`],
  ['content_text (history rewrite)', `content_text = 'rewritten'`],
]

interface IntentOverrides {
  id?: string
  conversation?: string
  sender?: string
  status?: string
  messageId?: string | null
  connectionRef?: string | null
  provider?: string | null
  fp?: string | null
}

/** Exactly the column set createIntent (src/lib/whatsapp/delivery/settlement.ts) INSERTs, with overrides. */
function insertIntent(db: PGlite, w: World, o: IntentOverrides = {}) {
  const id = o.id ?? crypto.randomUUID()
  return db
    .query<{ id: string }>(
      `INSERT INTO messages (id, conversation_id, sender_type, connection_ref, delivery_provider, delivery_channel_fp,
                             content_type, content_text, media_url, template_name, status, message_id, idempotency_key, reply_to_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,'text','hi',NULL,NULL,$7,$8,$1,NULL) RETURNING id`,
      [
        id,
        o.conversation ?? w.convA,
        o.sender ?? 'agent',
        o.connectionRef === undefined ? w.cfgA : o.connectionRef,
        o.provider === undefined ? 'meta' : o.provider,
        o.fp === undefined ? `v1:${'a'.repeat(64)}` : o.fp,
        o.status ?? 'sending',
        o.messageId ?? null,
      ],
    )
    .then((r) => r.rows[0].id)
}

const row = async (db: PGlite, id: string) =>
  (await db.query<Record<string, unknown>>(`SELECT status, message_id, connection_ref, delivery_provider, delivery_channel_fp, content_text FROM messages WHERE id = $1`, [id])).rows[0]

// ---------------------------------------------------------------
describe('BEFORE (chain 001..085): an agent writes the protected columns directly', () => {
  let db: PGlite
  let w: World
  beforeAll(async () => {
    db = await bootChain(85)
    w = await seedWorld(db)
  })
  afterAll(async () => { await db.close() })

  it('the effective policy is one FOR ALL policy at role agent, and authenticated holds UPDATE', async () => {
    const pol = await db.query<{ polname: string; polcmd: string }>(
      `SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.messages'::regclass ORDER BY polname`)
    expect(pol.rows).toEqual([
      { polname: 'messages_modify', polcmd: '*' },
      { polname: 'messages_select', polcmd: 'r' },
    ])
    expect((await db.query<{ ok: boolean }>(`SELECT has_table_privilege('authenticated','public.messages','UPDATE') AS ok`)).rows[0].ok).toBe(true)
  })

  it('an AGENT UPDATEs status + message_id of a sent message (settle/CAS bypassed)', async () => {
    const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.REAL' })
    await asUser(db, U.agentA, () => db.query(`UPDATE messages SET status = 'failed', message_id = 'wamid.FORGED' WHERE id = $1`, [id]))
    expect(await row(db, id)).toMatchObject({ status: 'failed', message_id: 'wamid.FORGED' })
  })

  it('an AGENT rewrites the delivery binding of an existing message', async () => {
    const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
    await asUser(db, U.agentA, () =>
      db.query(`UPDATE messages SET connection_ref = $2, delivery_provider = 'meta', delivery_channel_fp = 'v1:forged' WHERE id = $1`, [id, w.cfgB]))
    expect(await row(db, id)).toMatchObject({ connection_ref: w.cfgB, delivery_channel_fp: 'v1:forged' })
  })

  it('an AGENT INSERTs a message directly: already "sent", with a provider id and bound to ANOTHER tenant\'s connection', async () => {
    const id = await asUser(db, U.agentA, () =>
      insertIntent(db, w, { status: 'sent', messageId: 'wamid.FORGED', connectionRef: w.cfgB, sender: 'customer' }))
    expect(await row(db, id)).toMatchObject({ status: 'sent', connection_ref: w.cfgB })
  })
})

// ---------------------------------------------------------------
describe('AFTER (full chain, migration 086)', () => {
  let db: PGlite
  let w: World
  beforeAll(async () => {
    db = await bootChain()
    w = await seedWorld(db)
  })
  afterAll(async () => { await db.close() })

  describe('UPDATE is closed to every user session (nobody but service_role / SECURITY DEFINER writes status)', () => {
    it.each(['agent', 'admin', 'owner'])('%s cannot UPDATE any column; the row is unchanged', async (who) => {
      const uid = { agent: U.agentA, admin: U.adminA, owner: U.ownerA }[who]!
      for (const [label, set] of PROTECTED_UPDATES) {
        const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.REAL' })
        const before = await row(db, id)
        const err = await asUser(db, uid, () => errorOf(db.query(`UPDATE messages SET ${set} WHERE id = $1`, [id])))
        expect(err, label).toMatch(/permission denied/i)
        expect(await row(db, id), label).toEqual(before)
      }
    })

    it('an UPDATE with ON CONFLICT DO UPDATE (upsert) cannot be used to reach the same columns', async () => {
      const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.REAL' })
      const err = await asUser(db, U.agentA, () =>
        errorOf(db.query(
          `INSERT INTO messages (id, conversation_id, sender_type, status, idempotency_key)
           VALUES ($1,$2,'agent','sending',$1) ON CONFLICT (id) DO UPDATE SET status = 'failed'`, [id, w.convA])))
      expect(err).not.toBeNull()
      expect((await row(db, id)).status).toBe('sent')
    })

    it('no policy and no privilege grants UPDATE/ALL on messages to the API roles', async () => {
      const pol = await db.query<{ polname: string; polcmd: string }>(
        `SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.messages'::regclass ORDER BY polname`)
      expect(pol.rows.filter((p) => p.polcmd === '*' || p.polcmd === 'w')).toEqual([])
      expect(pol.rows.map((p) => p.polname).sort()).toEqual(['messages_delete', 'messages_insert', 'messages_select'])
      for (const role of ['anon', 'authenticated']) {
        const p = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1,'public.messages','UPDATE') AS ok`, [role])
        expect(p.rows[0].ok, role).toBe(false)
      }
      const colPriv = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.column_privileges
          WHERE table_schema='public' AND table_name='messages' AND privilege_type='UPDATE' AND grantee IN ('anon','authenticated','PUBLIC')`)
      expect(colPriv.rows[0].n).toBe(0)
    })
  })

  describe('INSERT stays open for the one legitimate creator (createIntent, from /send), and only for its shape', () => {
    it('an agent inserts the createIntent shape: sending, agent, no provider id, binding to its own connection', async () => {
      const id = await asUser(db, U.agentA, () => insertIntent(db, w))
      expect(await row(db, id)).toMatchObject({ status: 'sending', message_id: null, connection_ref: w.cfgA, delivery_provider: 'meta' })
    })

    it('admin and owner insert it too', async () => {
      for (const uid of [U.adminA, U.ownerA]) await asUser(db, uid, () => insertIntent(db, w))
    })

    it('a NULL binding is accepted (such a message is never re-sent automatically)', async () => {
      await asUser(db, U.agentA, () => insertIntent(db, w, { connectionRef: null, provider: null, fp: null }))
    })

    it.each([
      ['status sent', { status: 'sent' }],
      ['status delivered', { status: 'delivered' }],
      ['status failed', { status: 'failed' }],
      ['a forged provider message_id', { messageId: 'wamid.FORGED' }],
      ['sender_type customer (fake inbound)', { sender: 'customer' }],
      ['sender_type bot (bots run as service_role)', { sender: 'bot' }],
      ['ANOTHER tenant\'s connection_ref', { connectionRef: 'CFG_B' }],
      ['a connection_ref that does not exist', { connectionRef: '99999999-9999-4999-8999-999999999999' }],
    ] as Array<[string, IntentOverrides & { connectionRef?: string | null }]>)('an agent INSERT with %s is refused by RLS', async (_n, o) => {
      const over = { ...o, connectionRef: o.connectionRef === 'CFG_B' ? w.cfgB : o.connectionRef }
      const err = await asUser(db, U.agentA, () => errorOf(insertIntent(db, w, over)))
      expect(err).toMatch(/row-level security/i)
    })

    it('a viewer, the platform operator and an agent of ANOTHER tenant cannot insert', async () => {
      for (const uid of [U.viewerA, U.operator, U.agentB]) {
        const err = await asUser(db, uid, () => errorOf(insertIntent(db, w)))
        expect(err).toMatch(/row-level security/i)
      }
    })
  })

  describe('what must keep working', () => {
    it('SELECT: members read the thread (viewer too) and the operator reads it; a stranger does not', async () => {
      const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.R' })
      const count = (uid: string) => asUser(db, uid, async () =>
        (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE id = $1`, [id])).rows[0].n)
      expect(await count(U.viewerA)).toBe(1)
      expect(await count(U.agentA)).toBe(1)
      expect(await count(U.operator)).toBe(1)
      expect(await count(U.agentB)).toBe(0)
    })

    it('the end-to-end /send path as an agent: INSERT intent -> settle_outbound_message -> sent', async () => {
      const id = await asUser(db, U.agentA, () => insertIntent(db, w))
      await asUser(db, U.agentA, () =>
        db.query(`SELECT settle_outbound_message($1::uuid,'sent',$2::uuid,'wamid.E2E','[]'::jsonb)`, [id, w.cfgA]))
      expect(await row(db, id)).toMatchObject({ status: 'sent', message_id: 'wamid.E2E' })
    })

    it('the end-to-end failure path as an agent: INSERT intent -> enqueue_outbound_retry -> still sending', async () => {
      const id = await asUser(db, U.agentA, () => insertIntent(db, w))
      await asUser(db, U.agentA, () =>
        db.query(`SELECT enqueue_outbound_retry($1::uuid,'deterministic_transient', now(), 'boom')`, [id]))
      expect((await row(db, id)).status).toBe('sending')
      expect((await db.query(`SELECT 1 FROM outbound_retry_ledger WHERE message_id = $1`, [id])).rows).toHaveLength(1)
    })

    it('service_role keeps its CAS UPDATE of status (webhook / status-handler) and settle_*_system', async () => {
      const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.S' })
      await asService(db, () =>
        db.query(`UPDATE messages SET status = 'delivered' WHERE id = $1 AND status = 'sent'`, [id]))
      expect((await row(db, id)).status).toBe('delivered')
      const sending = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      await asService(db, () => db.query(`SELECT settle_outbound_message_system($1::uuid,'failed',NULL,NULL,'[]'::jsonb)`, [sending]))
      expect((await row(db, sending)).status).toBe('failed')
    })

    it('service_role keeps inserting inbound messages through insert_inbound_message (SECURITY DEFINER, not subject to the new INSERT policy)', async () => {
      const r = await asService(db, () =>
        db.query<{ id: string }>(
          `SELECT insert_inbound_message($1::uuid,'customer','text','oi',NULL,'wamid.IN','delivered', now(), NULL, NULL) AS id`, [w.convA]))
      expect(await row(db, r.rows[0].id)).toMatchObject({ status: 'delivered', message_id: 'wamid.IN' })
    })

    it('cascades are not blocked: deleting the conversation removes its messages (RI runs as owner)', async () => {
      const contact = (await db.query<{ id: string }>(`INSERT INTO contacts (user_id, account_id, name, phone) VALUES ($1,$2,'tmp','5511999990099') RETURNING id`, [U.ownerA, w.accountA])).rows[0].id
      const conv = (await db.query<{ id: string }>(`INSERT INTO conversations (user_id, account_id, contact_id) VALUES ($1,$2,$3) RETURNING id`, [U.ownerA, w.accountA, contact])).rows[0].id
      const id = await seedMessage(db, conv, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.C' })
      await asUser(db, U.agentA, () => db.query(`DELETE FROM conversations WHERE id = $1`, [conv]))
      expect((await db.query(`SELECT 1 FROM messages WHERE id = $1`, [id])).rows).toHaveLength(0)
    })

    it('DELETE is unchanged: an agent may delete a message of the account, a viewer and a stranger may not', async () => {
      const mine = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.D1' })
      await asUser(db, U.viewerA, () => db.query(`DELETE FROM messages WHERE id = $1`, [mine]))
      await asUser(db, U.agentB, () => db.query(`DELETE FROM messages WHERE id = $1`, [mine]))
      expect((await db.query(`SELECT 1 FROM messages WHERE id = $1`, [mine])).rows).toHaveLength(1)
      await asUser(db, U.agentA, () => db.query(`DELETE FROM messages WHERE id = $1`, [mine]))
      expect((await db.query(`SELECT 1 FROM messages WHERE id = $1`, [mine])).rows).toHaveLength(0)
    })
  })

  it('migration 086 is idempotent: applying it twice leaves exactly the same policies', async () => {
    const snapshot = async () =>
      (await db.query(`SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS q, pg_get_expr(polwithcheck, polrelid) AS c FROM pg_policy WHERE polrelid = 'public.messages'::regclass ORDER BY polname`)).rows
    const before = await snapshot()
    await db.exec(readMigration('086'))
    await db.exec(readMigration('086'))
    expect(await snapshot()).toEqual(before)
    expect(before).toHaveLength(3)
  })
})
