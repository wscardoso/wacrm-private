import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { asUser, bootChain, errorOf, readMigration, seedWorld, U, type World } from './support/full-migration-chain'

/**
 * Finding E-2 (/act audit): the log_platform_context_* RPCs (038) accepted any
 * authenticated caller and any account id. Migration 095 restricts entered /
 * exited to active operators who can access the account, and keeps denied
 * callable by non-operators but bounded. Real migration chain on in-memory
 * PGlite; nothing here touches a remote database.
 */

let db: PGlite
let w: World

const NOBODY = '' // authenticated role with no end user: auth.uid() IS NULL
const MISSING_ACCOUNT = '99999999-9999-4999-8999-999999999999'

async function auditRows(action: string, actor?: string) {
  const r = await db.query<{ actor_user_id: string; target_account_id: string | null; metadata: Record<string, unknown> | null }>(
    `SELECT actor_user_id, target_account_id, metadata FROM platform_audit_log
     WHERE action = $1 AND ($2::uuid IS NULL OR actor_user_id = $2::uuid)
     ORDER BY id`,
    [action, actor ?? null],
  )
  return r.rows
}

async function canExecute(role: string, signature: string) {
  const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, signature])
  return r.rows[0].ok
}

beforeAll(async () => {
  db = await bootChain(94)
  w = await seedWorld(db)
}, 120_000)

afterAll(async () => {
  await db.close()
})

describe('E-2 reproduction on the pre-095 chain (038 behaviour)', () => {
  it('a plain member of tenant B can append context_entered rows for tenant A', async () => {
    await asUser(db, U.ownerB, async () => {
      await db.query('SELECT log_platform_context_entered($1)', [w.accountA])
    })
    const rows = await auditRows('context_entered', U.ownerB)
    expect(rows).toHaveLength(1)
    expect(rows[0].target_account_id).toBe(w.accountA)
  })
})

describe('095 — entered / exited are operator-only', () => {
  beforeAll(async () => {
    await db.exec(readMigration('095'))
    await db.query(`DELETE FROM platform_audit_log`)
  })

  it.each(['log_platform_context_entered', 'log_platform_context_exited'])(
    '%s: a tenant member who is not an operator is rejected and nothing is written',
    async (fn) => {
      const err = await asUser(db, U.ownerB, () => errorOf(db.query(`SELECT ${fn}($1)`, [w.accountA])))
      expect(err).toMatch(/Not authorized for this account/)
      const err2 = await asUser(db, U.agentA, () => errorOf(db.query(`SELECT ${fn}($1)`, [w.accountA])))
      expect(err2).toMatch(/Not authorized for this account/)
      expect((await db.query(`SELECT 1 FROM platform_audit_log WHERE action = $1`, [fn.replace('log_platform_', '')])).rows).toHaveLength(0)
    },
  )

  it.each(['log_platform_context_entered', 'log_platform_context_exited'])(
    '%s: an unauthenticated session is rejected',
    async (fn) => {
      const err = await asUser(db, NOBODY, () => errorOf(db.query(`SELECT ${fn}($1)`, [w.accountA])))
      expect(err).toMatch(/Unauthorized/)
    },
  )

  it('an active operator assigned to the tenant logs entered/exited as the real actor', async () => {
    await asUser(db, U.operator, async () => {
      await db.query('SELECT log_platform_context_entered($1)', [w.accountA])
      await db.query('SELECT log_platform_context_exited($1)', [w.accountA])
    })
    const entered = await auditRows('context_entered')
    const exited = await auditRows('context_exited')
    expect(entered.map((r) => [r.actor_user_id, r.target_account_id])).toEqual([[U.operator, w.accountA]])
    expect(exited.map((r) => [r.actor_user_id, r.target_account_id])).toEqual([[U.operator, w.accountA]])
  })

  it('an operator is rejected for a tenant they are not assigned to', async () => {
    const err = await asUser(db, U.operator, () => errorOf(db.query('SELECT log_platform_context_entered($1)', [w.accountB])))
    expect(err).toMatch(/Not authorized for this account/)
  })

  it('a deactivated operator is rejected', async () => {
    await db.query(`UPDATE platform_operators SET is_active = FALSE WHERE user_id = $1`, [U.operator])
    try {
      const err = await asUser(db, U.operator, () => errorOf(db.query('SELECT log_platform_context_exited($1)', [w.accountA])))
      expect(err).toMatch(/Not authorized for this account/)
    } finally {
      await db.query(`UPDATE platform_operators SET is_active = TRUE WHERE user_id = $1`, [U.operator])
    }
  })
})

describe('095 — denied stays available to non-operators, bounded', () => {
  beforeAll(async () => {
    await db.query(`DELETE FROM platform_audit_log`)
  })

  it('a non-operator can still record a denied attempt against an existing tenant', async () => {
    await asUser(db, U.ownerB, async () => {
      await db.query('SELECT log_platform_context_denied($1)', [w.accountA])
    })
    const rows = await auditRows('context_access_denied', U.ownerB)
    expect(rows).toHaveLength(1)
    expect(rows[0].target_account_id).toBe(w.accountA)
  })

  it('an unknown account id is recorded without a target and without an error', async () => {
    await db.query(`DELETE FROM platform_audit_log`)
    await asUser(db, U.agentB, async () => {
      await db.query('SELECT log_platform_context_denied($1)', [MISSING_ACCOUNT])
    })
    const rows = await auditRows('context_access_denied', U.agentB)
    expect(rows).toHaveLength(1)
    expect(rows[0].target_account_id).toBeNull()
    expect(rows[0].metadata).toEqual({ attempted_account_id: MISSING_ACCOUNT })
  })

  it('stores at most 20 denied rows per actor per minute', async () => {
    await db.query(`DELETE FROM platform_audit_log`)
    await asUser(db, U.viewerA, async () => {
      for (let i = 0; i < 35; i++) {
        await db.query('SELECT log_platform_context_denied($1)', [w.accountB])
      }
    })
    expect(await auditRows('context_access_denied', U.viewerA)).toHaveLength(20)
    // The guard is per actor: another user is not throttled by it.
    await asUser(db, U.agentB, async () => {
      await db.query('SELECT log_platform_context_denied($1)', [w.accountA])
    })
    expect(await auditRows('context_access_denied', U.agentB)).toHaveLength(1)
  })

  it('an unauthenticated session is rejected', async () => {
    const err = await asUser(db, NOBODY, () => errorOf(db.query('SELECT log_platform_context_denied($1)', [w.accountA])))
    expect(err).toMatch(/Unauthorized/)
  })
})

describe('095 — EXECUTE surface (087 convention)', () => {
  it.each([
    'public.log_platform_context_entered(uuid)',
    'public.log_platform_context_exited(uuid)',
    'public.log_platform_context_denied(uuid)',
  ])('%s is executable by authenticated only', async (signature) => {
    expect(await canExecute('authenticated', signature)).toBe(true)
    expect(await canExecute('anon', signature)).toBe(false)
    expect(await canExecute('service_role', signature)).toBe(false)
  })
})
