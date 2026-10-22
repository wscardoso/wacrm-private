import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asService, asUser, bootChain, errorOf, seedMessage, seedWorld, U, type World } from './support/full-migration-chain'

// =============================================================
// Post-audit defect 4 — the human facades of the outbound pipeline
// (public.settle_outbound_message, public.enqueue_outbound_retry,
// public.insert_message_external_ids) authorised through
// `is_account_member(acct)` (min_role defaults to 'viewer') OR
// `can_access_account(acct)` (membership OR authorised platform operator).
// /send, the only legitimate caller, needs role 'agent' (RLS on messages), so
// the facades must have at least that floor and must not admit the read-only
// operator.
//
// The "BEFORE" block runs the REAL chain 001..084 and PROVES the defect. The
// "AFTER" block runs the REAL chain 001..latest (migration 085 included).
// Everything runs on in-memory PGlite; nothing touches a remote database.
// =============================================================

const NOT_AUTH = /not authorized/

const settle = (db: PGlite, id: string, status: string, ref: string | null, providerId: string | null, identities: unknown[] = []) =>
  db.query(`SELECT settle_outbound_message($1::uuid, $2, $3::uuid, $4, $5::jsonb) AS r`, [id, status, ref, providerId, JSON.stringify(identities)])

const enqueue = (db: PGlite, id: string, classification = 'deterministic_transient') =>
  db.query(`SELECT enqueue_outbound_retry($1::uuid, $2, now() - interval '1 minute', 'boom') AS r`, [id, classification])

const enqueueSystem = (db: PGlite, id: string, classification = 'deterministic_transient') =>
  db.query(`SELECT enqueue_outbound_retry_system($1::uuid, $2, now() - interval '1 minute', 'boom') AS r`, [id, classification])

const statusOf = async (db: PGlite, id: string) =>
  (await db.query<{ status: string; message_id: string | null }>(`SELECT status, message_id FROM messages WHERE id = $1`, [id])).rows[0]
const ledgerRows = async (db: PGlite, id: string) =>
  (await db.query<{ status: string; classification: string }>(`SELECT status, classification FROM outbound_retry_ledger WHERE message_id = $1`, [id])).rows
const identityRows = async (db: PGlite, id: string) =>
  (await db.query(`SELECT 1 FROM message_external_ids WHERE message_id = $1`, [id])).rows

// ---------------------------------------------------------------
describe('BEFORE (chain 001..084): the facades admit a viewer and the operator', () => {
  let db: PGlite
  let w: World
  beforeAll(async () => {
    db = await bootChain(84)
    w = await seedWorld(db)
  })
  afterAll(async () => { await db.close() })

  it('a VIEWER settles a message of the account (status flips, provider id forged)', async () => {
    const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
    await asUser(db, U.viewerA, () => settle(db, id, 'sent', w.cfgA, 'wamid.FORGED'))
    expect(await statusOf(db, id)).toEqual({ status: 'sent', message_id: 'wamid.FORGED' })
  })

  it('the platform OPERATOR (not a member, read-only by design) settles a message', async () => {
    const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
    await asUser(db, U.operator, () => settle(db, id, 'failed', null, null))
    expect((await statusOf(db, id)).status).toBe('failed')
  })

  it('a VIEWER enqueues a retry for a message that is ALREADY sent (the cron would resend it)', async () => {
    const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.REAL' })
    await asUser(db, U.viewerA, () => enqueue(db, id))
    expect(await ledgerRows(db, id)).toEqual([{ status: 'pending', classification: 'deterministic_transient' }])
  })

  it('the OPERATOR enqueues a retry too', async () => {
    const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
    await asUser(db, U.operator, () => enqueue(db, id))
    expect(await ledgerRows(db, id)).toHaveLength(1)
  })

  it('a member of the account can attach foreign-tenant identities while settling', async () => {
    const mine = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
    const theirs = await seedMessage(db, w.convB, 'sent', { connectionRef: w.cfgB, messageId: 'wamid.B' })
    await asUser(db, U.agentA, () =>
      settle(db, mine, 'sent', w.cfgA, 'wamid.MINE', [
        { message_id: theirs, connection_ref: w.cfgB, kind: 'wamid', value: 'wamid.POISON' },
      ]))
    expect((await identityRows(db, theirs)).length).toBe(1)
  })
})

// ---------------------------------------------------------------
describe('AFTER (full chain, migration 085): agent floor, no operator, no retry of a settled message', () => {
  let db: PGlite
  let w: World
  beforeAll(async () => {
    db = await bootChain()
    w = await seedWorld(db)
  })
  afterAll(async () => { await db.close() })

  describe('settle_outbound_message', () => {
    it.each([
      ['viewer', U.viewerA],
      ['platform operator (not a member)', U.operator],
      ['agent of ANOTHER tenant', U.agentB],
    ])('%s is refused and the message is untouched', async (_n, uid) => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      const err = await asUser(db, uid, () => errorOf(settle(db, id, 'sent', w.cfgA, 'wamid.FORGED')))
      expect(err).toMatch(NOT_AUTH)
      expect(await statusOf(db, id)).toEqual({ status: 'sending', message_id: null })
    })

    it.each([
      ['agent', U.agentA],
      ['admin', U.adminA],
      ['owner', U.ownerA],
    ])('%s settles sent (the /send path keeps working) and the identity is attached', async (_n, uid) => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      const r = await asUser(db, uid, () =>
        settle(db, id, 'sent', w.cfgA, 'wamid.OK', [{ message_id: id, connection_ref: w.cfgA, kind: 'wamid', value: `wamid.OK.${id}` }]))
      expect((r.rows[0] as { r: { outcome: string } }).r.outcome).toBe('sent')
      expect(await statusOf(db, id)).toEqual({ status: 'sent', message_id: 'wamid.OK' })
      expect(await identityRows(db, id)).toHaveLength(1)
    })

    it('an agent settles failed with no identities and no connection (permanent failure path)', async () => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      await asUser(db, U.agentA, () => settle(db, id, 'failed', w.cfgA, null, []))
      expect((await statusOf(db, id)).status).toBe('failed')
    })

    it('CAS is intact: a second settle of a settled message is a noop', async () => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      await asUser(db, U.agentA, () => settle(db, id, 'sent', w.cfgA, 'wamid.1'))
      const r = await asUser(db, U.agentA, () => settle(db, id, 'failed', w.cfgA, null))
      expect((r.rows[0] as { r: { outcome: string } }).r.outcome).toBe('noop')
      expect(await statusOf(db, id)).toEqual({ status: 'sent', message_id: 'wamid.1' })
    })

    it('identities that point at another message or at another tenant\'s connection are refused (whole call rolls back)', async () => {
      const mine = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      const theirs = await seedMessage(db, w.convB, 'sent', { connectionRef: w.cfgB, messageId: 'wamid.B' })
      const otherMessage = await asUser(db, U.agentA, () =>
        errorOf(settle(db, mine, 'sent', w.cfgA, 'wamid.X', [{ message_id: theirs, connection_ref: w.cfgA, kind: 'wamid', value: 'wamid.POISON1' }])))
      expect(otherMessage).toMatch(/identit/i)
      const otherConnection = await asUser(db, U.agentA, () =>
        errorOf(settle(db, mine, 'sent', w.cfgB, 'wamid.X', [{ message_id: mine, connection_ref: w.cfgB, kind: 'wamid', value: 'wamid.POISON2' }])))
      expect(otherConnection).toMatch(/connection/i)
      expect(await identityRows(db, theirs)).toHaveLength(0)
      expect(await identityRows(db, mine)).toHaveLength(0)
      expect(await statusOf(db, mine)).toEqual({ status: 'sending', message_id: null })
    })

    it('the system facade (service_role) is unchanged: no auth.uid(), may settle and may carry a NULL connection', async () => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      await asService(db, () =>
        db.query(`SELECT settle_outbound_message_system($1::uuid,'failed',NULL,NULL,'[]'::jsonb)`, [id]))
      expect((await statusOf(db, id)).status).toBe('failed')
    })
  })

  describe('enqueue_outbound_retry', () => {
    it.each([
      ['viewer', U.viewerA],
      ['platform operator (not a member)', U.operator],
      ['agent of ANOTHER tenant', U.agentB],
    ])('%s cannot enqueue; no ledger row appears', async (_n, uid) => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      const err = await asUser(db, uid, () => errorOf(enqueue(db, id)))
      expect(err).toMatch(NOT_AUTH)
      expect(await ledgerRows(db, id)).toHaveLength(0)
    })

    it('an agent enqueues the retry of a message that is still sending (handleSendFailure keeps working)', async () => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      const r = await asUser(db, U.agentA, () => enqueue(db, id))
      expect((r.rows[0] as { r: { enqueued: boolean } }).r.enqueued).toBe(true)
      expect(await ledgerRows(db, id)).toEqual([{ status: 'pending', classification: 'deterministic_transient' }])
    })

    it.each(['sent', 'delivered', 'read', 'failed'])('NOBODY (agent or system) can enqueue a %s message: the cron would resend it to the customer', async (status) => {
      const id = await seedMessage(db, w.convA, status, { connectionRef: w.cfgA, messageId: 'wamid.REAL' })
      const human = await asUser(db, U.agentA, () => enqueue(db, id))
      expect((human.rows[0] as { r: { enqueued: boolean } }).r.enqueued).toBe(false)
      const system = await asService(db, () => enqueueSystem(db, id))
      expect((system.rows[0] as { r: { enqueued: boolean } }).r.enqueued).toBe(false)
      expect(await ledgerRows(db, id)).toHaveLength(0)
    })

    it('the system facade still enqueues a sending message (automations / flows path)', async () => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      await asService(db, () => enqueueSystem(db, id, 'ambiguous'))
      expect(await ledgerRows(db, id)).toEqual([{ status: 'pending', classification: 'ambiguous' }])
    })

    it('enqueue stays idempotent per message (ON CONFLICT DO NOTHING)', async () => {
      const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
      await asUser(db, U.agentA, () => enqueue(db, id))
      await asUser(db, U.agentA, () => enqueue(db, id, 'ambiguous'))
      expect(await ledgerRows(db, id)).toHaveLength(1)
    })
  })

  describe('insert_message_external_ids (same facade pattern, no application caller)', () => {
    it.each([
      ['viewer', U.viewerA],
      ['platform operator (not a member)', U.operator],
    ])('%s is refused', async (_n, uid) => {
      const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.R' })
      const err = await asUser(db, uid, () =>
        errorOf(db.query(`SELECT insert_message_external_ids($1::jsonb)`, [JSON.stringify([{ message_id: id, connection_ref: w.cfgA, kind: 'wamid', value: `v.${id}` }])])))
      expect(err).toMatch(NOT_AUTH)
      expect(await identityRows(db, id)).toHaveLength(0)
    })

    it('an agent is still accepted', async () => {
      const id = await seedMessage(db, w.convA, 'sent', { connectionRef: w.cfgA, messageId: 'wamid.R2' })
      await asUser(db, U.agentA, () =>
        db.query(`SELECT insert_message_external_ids($1::jsonb)`, [JSON.stringify([{ message_id: id, connection_ref: w.cfgA, kind: 'wamid', value: `v.${id}` }])]))
      expect(await identityRows(db, id)).toHaveLength(1)
    })
  })

  describe('contract invariants preserved (signatures, return type, ACLs)', () => {
    const acl = async (proname: string) =>
      (await db.query<{ ident: string; ret: string; sec: boolean; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `SELECT p.oid::regprocedure::text AS ident, pg_get_function_result(p.oid) AS ret, p.prosecdef AS sec,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [proname])).rows

    it.each([
      ['settle_outbound_message', 'uuid, text, uuid, text, jsonb', 'jsonb', { anon: false, auth: true, svc: false }],
      ['settle_outbound_message_system', 'uuid, text, uuid, text, jsonb', 'jsonb', { anon: false, auth: false, svc: true }],
      ['settle_outbound_message_core', 'uuid, text, uuid, text, jsonb', 'jsonb', { anon: false, auth: false, svc: false }],
      ['enqueue_outbound_retry', 'uuid, text, timestamp with time zone, text', 'jsonb', { anon: false, auth: true, svc: false }],
      ['enqueue_outbound_retry_system', 'uuid, text, timestamp with time zone, text', 'jsonb', { anon: false, auth: false, svc: true }],
      ['enqueue_outbound_retry_core', 'uuid, text, timestamp with time zone, text', 'jsonb', { anon: false, auth: false, svc: false }],
    ])('%s: single overload, SECURITY DEFINER, jsonb, ACL %j', async (name, args, ret, want) => {
      const rows = await acl(name)
      expect(rows).toHaveLength(1)
      expect(rows[0].ident).toBe(`${name}(${args.replace(/, /g, ",")})`)
      expect(rows[0].ret).toBe(ret)
      expect(rows[0].sec).toBe(true)
      expect({ anon: rows[0].anon, auth: rows[0].auth, svc: rows[0].svc }).toEqual(want)
      expect(rows[0].pub).toBe(false)
    })

    it('insert_message_external_ids: authenticated yes, anon and PUBLIC no', async () => {
      const rows = await acl('insert_message_external_ids')
      expect(rows).toHaveLength(1)
      expect({ anon: rows[0].anon, auth: rows[0].auth, pub: rows[0].pub }).toEqual({ anon: false, auth: true, pub: false })
    })
  })

  it('re-applying migration 085 is idempotent and changes no behaviour', async () => {
    const { readMigration } = await import('./support/full-migration-chain')
    await db.exec(readMigration('085'))
    await db.exec(readMigration('085'))
    const id = await seedMessage(db, w.convA, 'sending', { connectionRef: w.cfgA })
    expect(await asUser(db, U.viewerA, () => errorOf(settle(db, id, 'sent', w.cfgA, 'x')))).toMatch(NOT_AUTH)
  })
})
