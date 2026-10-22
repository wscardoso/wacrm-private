import { describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain } from './support/full-migration-chain'

/**
 * 087 closes the same hole 082 closed for enqueue_webhook_dlq: on Supabase,
 * REVOKE FROM PUBLIC leaves the explicit anon/authenticated grants that
 * default privileges created. These tests run the real migration files on
 * in-memory PGlite. They do not touch a remote database.
 */

async function canExecute(db: PGlite, role: string, signature: string): Promise<boolean> {
  const result = await db.query<{ ok: boolean }>(
    `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`,
    [role, signature],
  )
  return result.rows[0].ok
}

const SERVICE_ONLY = [
  'public.enqueue_pending_attributions()',
  'public.claim_enrichment_batch(integer, uuid)',
  'public.get_ad_account_credential(uuid)',
]

describe('087 function EXECUTE ACL', () => {
  it('before 087, anon can still execute a service-role RPC', async () => {
    const db = await bootChain(84)
    try {
      expect(await canExecute(db, 'anon', 'public.claim_enrichment_batch(integer, uuid)')).toBe(true)
      expect(await canExecute(db, 'authenticated', 'public.get_ad_account_credential(uuid)')).toBe(true)
    } finally {
      await db.close()
    }
  }, 60_000)

  it('after 087, service-role RPCs are not executable by anon or authenticated', async () => {
    const db = await bootChain(87)
    try {
      for (const signature of SERVICE_ONLY) {
        expect(await canExecute(db, 'anon', signature)).toBe(false)
        expect(await canExecute(db, 'authenticated', signature)).toBe(false)
        expect(await canExecute(db, 'service_role', signature)).toBe(true)
      }
      expect(await canExecute(db, 'anon', 'public.get_enrichment_report(uuid)')).toBe(false)
      expect(await canExecute(db, 'authenticated', 'public.get_enrichment_report(uuid)')).toBe(true)
      expect(await canExecute(db, 'service_role', 'public.set_ad_account_credential(uuid, text, timestamptz)')).toBe(true)
      expect(await canExecute(db, 'anon', 'public.set_ad_account_credential(uuid, text, timestamptz)')).toBe(false)
    } finally {
      await db.close()
    }
  })
})
