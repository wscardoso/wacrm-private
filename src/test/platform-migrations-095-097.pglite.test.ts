import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain, readMigration } from './support/full-migration-chain'

/**
 * Migration review gate for 095–097 on the full chain (001..097): the final
 * ACL of every function they touch, SECURITY DEFINER + pinned search_path, and
 * idempotency (each file can be applied a second time without changing the
 * result). In-memory PGlite; nothing here touches a remote database.
 */

const FUNCTIONS = [
  'log_platform_context_entered',
  'log_platform_context_exited',
  'log_platform_context_denied',
  'list_platform_tenant_metrics',
  'list_platform_audit_log',
] as const

let db: PGlite

async function describeFunctions() {
  const r = await db.query<{ proname: string; secdef: boolean; config: string[] | null; grantees: string[] }>(
    `SELECT p.proname,
            p.prosecdef AS secdef,
            p.proconfig AS config,
            COALESCE(
              (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee) ORDER BY pg_get_userbyid(a.grantee))
                 FROM aclexplode(p.proacl) a
                WHERE a.privilege_type = 'EXECUTE'),
              ARRAY[]::text[]
            ) AS grantees
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
      ORDER BY p.proname`,
    [FUNCTIONS as unknown as string[]],
  )
  return r.rows
}

beforeAll(async () => {
  db = await bootChain(97)
}, 120_000)

afterAll(async () => {
  await db.close()
})

describe('095–097 final function state', () => {
  it('defines exactly one overload of each function', async () => {
    const rows = await describeFunctions()
    expect(rows.map((r) => r.proname)).toEqual([...FUNCTIONS].sort())
  })

  it('is SECURITY DEFINER with a pinned search_path', async () => {
    for (const row of await describeFunctions()) {
      expect(row.secdef, row.proname).toBe(true)
      expect(row.config, row.proname).toContain('search_path=public')
    }
  })

  it('is executable by the owner and authenticated only (no PUBLIC, anon or service_role entry)', async () => {
    for (const row of await describeFunctions()) {
      expect(row.grantees, row.proname).toEqual(['authenticated', 'postgres'])
    }
  })
})

describe('095–097 idempotency', () => {
  it('re-applying each migration leaves the same ACLs and function set', async () => {
    const before = await describeFunctions()
    for (const prefix of ['095', '096', '097']) {
      await db.exec(readMigration(prefix))
    }
    expect(await describeFunctions()).toEqual(before)
  })
})
