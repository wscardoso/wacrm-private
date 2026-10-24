import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, bootChain, readMigration, seedWorld, U, type World } from './support/full-migration-chain'
import { pgliteSupabaseWithRpc } from './support/pglite-supabase-rpc'
import { loadTenantMetrics, TenantMetricsError } from '@/lib/platform-ops/tenant-metrics'

/**
 * Finding E-1 (/act audit): per-tenant numbers are now aggregated in SQL by
 * list_platform_tenant_metrics() (096). These tests run the REAL migration
 * and drive the real TypeScript loader against it on in-memory PGlite, with
 * more rows than PostgREST's default 1000-row response cap. Nothing here
 * touches a remote database.
 */

let db: PGlite
let w: World

const BIG = 1500

async function seedVolume() {
  // BIG contacts + BIG messages in tenant A (the operator's tenant) and a
  // distinct, smaller volume in tenant B (NOT supervised by the operator).
  await db.query(
    `INSERT INTO contacts (user_id, account_id, name, phone)
     SELECT $1, $2, 'bulk', '55119' || lpad(g::text, 8, '0') FROM generate_series(1, $3::int) g`,
    [U.ownerA, w.accountA, BIG],
  )
  await db.query(
    `INSERT INTO messages (conversation_id, sender_type, content_type, content_text, status)
     SELECT $1, 'customer', 'text', 'x', 'delivered' FROM generate_series(1, $2::int) g`,
    [w.convA, BIG],
  )
  await db.query(`UPDATE conversations SET unread_count = 4, last_message_at = '2026-06-01T10:00:00Z' WHERE id = $1`, [w.convA])
  await db.query(
    `INSERT INTO contacts (user_id, account_id, name, phone)
     SELECT $1, $2, 'b', '55118' || lpad(g::text, 8, '0') FROM generate_series(1, 7) g`,
    [U.ownerB, w.accountB],
  )
}

beforeAll(async () => {
  db = await bootChain(95)
  w = await seedWorld(db)
  await db.exec(readMigration('096'))
  await seedVolume()
}, 120_000)

afterAll(async () => {
  await db.close()
})

describe('list_platform_tenant_metrics (096)', () => {
  it('counts every row for a tenant holding more than 1000 contacts and messages', async () => {
    const rows = await asUser(db, U.operator, async () =>
      (
        await db.query<{
          account_id: string
          contacts_count: string
          messages_today: string
          unread_count: string
          last_message_at: string | null
        }>(`SELECT * FROM list_platform_tenant_metrics()`)
      ).rows,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].account_id).toBe(w.accountA)
    // seedWorld already created 1 contact + 1 conversation for A.
    expect(Number(rows[0].contacts_count)).toBe(BIG + 1)
    expect(Number(rows[0].messages_today)).toBe(BIG)
    expect(Number(rows[0].unread_count)).toBe(4)
    expect(new Date(rows[0].last_message_at as string).toISOString()).toBe('2026-06-01T10:00:00.000Z')
  })

  it('is scoped to the operator assignments: tenant B is invisible to an operator assigned only to A', async () => {
    const rows = await asUser(db, U.operator, async () =>
      (await db.query<{ account_id: string }>(`SELECT account_id FROM list_platform_tenant_metrics()`)).rows,
    )
    expect(rows.map((r) => r.account_id)).toEqual([w.accountA])
  })

  it('returns nothing to a tenant member, an unauthenticated session and a deactivated operator', async () => {
    const asMember = await asUser(db, U.ownerB, async () => (await db.query(`SELECT * FROM list_platform_tenant_metrics()`)).rows)
    expect(asMember).toHaveLength(0)
    const anonymous = await asUser(db, '', async () => (await db.query(`SELECT * FROM list_platform_tenant_metrics()`)).rows)
    expect(anonymous).toHaveLength(0)

    await db.query(`UPDATE platform_operators SET is_active = FALSE WHERE user_id = $1`, [U.operator])
    try {
      const revoked = await asUser(db, U.operator, async () => (await db.query(`SELECT * FROM list_platform_tenant_metrics()`)).rows)
      expect(revoked).toHaveLength(0)
    } finally {
      await db.query(`UPDATE platform_operators SET is_active = TRUE WHERE user_id = $1`, [U.operator])
    }
  })

  it('honours p_messages_since for messages_today', async () => {
    const rows = await asUser(db, U.operator, async () =>
      (
        await db.query<{ messages_today: string }>(
          `SELECT messages_today FROM list_platform_tenant_metrics(NOW() + INTERVAL '1 day')`,
        )
      ).rows,
    )
    expect(Number(rows[0].messages_today)).toBe(0)
  })

  it('is executable by authenticated only', async () => {
    const r = await db.query<{ role: string; ok: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'public.list_platform_tenant_metrics(timestamptz)', 'EXECUTE') AS ok
       FROM unnest(ARRAY['authenticated','anon','service_role']) r`,
    )
    expect(Object.fromEntries(r.rows.map((x) => [x.role, x.ok]))).toEqual({ authenticated: true, anon: false, service_role: false })
  })
})

describe('loadTenantMetrics against the real RPCs', () => {
  it('returns the true totals (not capped at 1000) through the TypeScript loader', async () => {
    const client = pgliteSupabaseWithRpc(db)
    const map = await asUser(db, U.operator, () => loadTenantMetrics(client as never, [w.accountA]))
    expect(map.get(w.accountA)).toMatchObject({
      contactsCount: BIG + 1,
      messagesToday: BIG,
      unreadCount: 4,
    })
  })

  it('surfaces a failing RPC as a TenantMetricsError instead of zeros', async () => {
    const client = pgliteSupabaseWithRpc(db)
    await db.exec(`ALTER FUNCTION list_platform_tenant_metrics(timestamptz) RENAME TO list_platform_tenant_metrics_off`)
    try {
      const err = await asUser(db, U.operator, () => loadTenantMetrics(client as never, [w.accountA]).catch((e) => e))
      expect(err).toBeInstanceOf(TenantMetricsError)
      expect((err as TenantMetricsError).source).toBe('metrics')
    } finally {
      await db.exec(`ALTER FUNCTION list_platform_tenant_metrics_off(timestamptz) RENAME TO list_platform_tenant_metrics`)
    }
  })
})
