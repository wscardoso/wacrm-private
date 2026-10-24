import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, bootChain, errorOf, readMigration, seedWorld, U, type World } from './support/full-migration-chain'
import { pgliteSupabaseWithRpc } from './support/pglite-supabase-rpc'
import { fetchAuditPage } from '@/lib/platform-ops/audit-log'

/**
 * Audit viewer read path (migration 097): tenant-scoped authorization,
 * keyset pagination, and e-mail visibility. Real migration chain on
 * in-memory PGlite; nothing here touches a remote database.
 */

let db: PGlite
let w: World

const TOTAL_A = 120

beforeAll(async () => {
  db = await bootChain(96)
  w = await seedWorld(db)
  await db.exec(readMigration('097'))
  await db.query(`DELETE FROM platform_audit_log`)
  // TOTAL_A rows for tenant A: operator actions, one external 'denied'.
  await db.query(
    `INSERT INTO platform_audit_log (actor_user_id, target_account_id, action, metadata)
     SELECT $1, $2, 'update_workspace_identity', jsonb_build_object('seq', g) FROM generate_series(1, $3::int) g`,
    [U.operator, w.accountA, TOTAL_A - 1],
  )
  await db.query(
    `INSERT INTO platform_audit_log (actor_user_id, target_account_id, action) VALUES ($1, $2, 'context_access_denied')`,
    [U.ownerB, w.accountA],
  )
  // Noise in tenant B that operator-of-A must never see.
  await db.query(
    `INSERT INTO platform_audit_log (actor_user_id, target_account_id, action) VALUES ($1, $2, 'create_workspace')`,
    [U.operator, w.accountB],
  )
}, 120_000)

afterAll(async () => {
  await db.close()
})

const rpc = (sql: string, params: unknown[] = []) => db.query<Record<string, unknown>>(sql, params)

describe('list_platform_audit_log (097) — authorization', () => {
  it('lets an operator assigned to the tenant read its trail', async () => {
    const rows = await asUser(db, U.operator, async () => (await rpc(`SELECT * FROM list_platform_audit_log($1)`, [w.accountA])).rows)
    expect(rows.length).toBe(50)
  })

  it.each([
    ['an operator not assigned to the tenant', () => [U.operator, 'accountB'] as const],
    ['a member of the tenant who is not an operator', () => [U.ownerA, 'accountA'] as const],
    ['a member of another tenant', () => [U.ownerB, 'accountA'] as const],
    ['an unauthenticated session', () => ['', 'accountA'] as const],
  ])('rejects %s', async (_label, who) => {
    const [user, which] = who()
    const account = which === 'accountA' ? w.accountA : w.accountB
    const err = await asUser(db, user, () => errorOf(rpc(`SELECT * FROM list_platform_audit_log($1)`, [account])))
    expect(err).toMatch(/Not authorized for this account|Unauthorized/)
  })

  it('rejects a deactivated operator', async () => {
    await db.query(`UPDATE platform_operators SET is_active = FALSE WHERE user_id = $1`, [U.operator])
    try {
      const err = await asUser(db, U.operator, () => errorOf(rpc(`SELECT * FROM list_platform_audit_log($1)`, [w.accountA])))
      expect(err).toMatch(/Not authorized for this account/)
    } finally {
      await db.query(`UPDATE platform_operators SET is_active = TRUE WHERE user_id = $1`, [U.operator])
    }
  })

  it('is executable by authenticated only', async () => {
    const r = await db.query<{ role: string; ok: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'public.list_platform_audit_log(uuid, integer, bigint)', 'EXECUTE') AS ok
       FROM unnest(ARRAY['authenticated','anon','service_role']) r`,
    )
    expect(Object.fromEntries(r.rows.map((x) => [x.role, x.ok]))).toEqual({ authenticated: true, anon: false, service_role: false })
  })
})

describe('list_platform_audit_log (097) — scope and identity', () => {
  it("never returns another tenant's rows", async () => {
    const rows = await asUser(db, U.operator, async () =>
      (await rpc(`SELECT action FROM list_platform_audit_log($1, 101)`, [w.accountA])).rows,
    )
    expect(rows.some((r) => r.action === 'create_workspace')).toBe(false)
  })

  it('resolves the e-mail of operator actors but hides tenant users', async () => {
    const rows = await asUser(db, U.operator, async () =>
      (await rpc(`SELECT action, actor_email, actor_is_operator FROM list_platform_audit_log($1, 101)`, [w.accountA])).rows,
    )
    const denied = rows.find((r) => r.action === 'context_access_denied')!
    expect(denied.actor_is_operator).toBe(false)
    expect(denied.actor_email).toBeNull()
    const op = rows.find((r) => r.action === 'update_workspace_identity')!
    expect(op.actor_is_operator).toBe(true)
    expect(op.actor_email).toBe('operator@example.test')
  })
})

describe('fetchAuditPage against the real RPC — pagination', () => {
  it('walks the whole trail newest-first with no gaps or duplicates', async () => {
    const client = pgliteSupabaseWithRpc(db)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    await asUser(db, U.operator, async () => {
      do {
        const page = await fetchAuditPage(client as never, w.accountA, cursor, 50)
        seen.push(...page.entries.map((e) => e.id))
        cursor = page.nextCursor
        pages++
      } while (cursor)
    })
    expect(seen).toHaveLength(TOTAL_A)
    expect(new Set(seen).size).toBe(TOTAL_A)
    expect(pages).toBe(3)
    const asNumbers = seen.map(Number)
    expect(asNumbers).toEqual([...asNumbers].sort((a, b) => b - a))
  })

  it('clamps an oversized limit instead of returning everything', async () => {
    const rows = await asUser(db, U.operator, async () =>
      (await rpc(`SELECT id FROM list_platform_audit_log($1, 100000)`, [w.accountA])).rows,
    )
    expect(rows).toHaveLength(101)
    const one = await asUser(db, U.operator, async () => (await rpc(`SELECT id FROM list_platform_audit_log($1, 0)`, [w.accountA])).rows)
    expect(one).toHaveLength(1)
  })
})
