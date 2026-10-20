import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// L5 — scripts/diagnostics/l5-enqueue-webhook-dlq-exposure.sql
//
// Verifies the diagnostic reports the exposure correctly on a local fixture
// (PGlite = Postgres in WASM, sequential) and is read-only. It does NOT run
// against, and says nothing about, any real database.

const sql = readFileSync(join(process.cwd(), 'scripts', 'diagnostics', 'l5-enqueue-webhook-dlq-exposure.sql'), 'utf8')
const query = sql.replace(/;\s*$/, '')
const m082 = readFileSync(join(process.cwd(), 'supabase', 'migrations', '082_enqueue_webhook_dlq_hardening.sql'), 'utf8')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

let db: PGlite
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CA = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const CB = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1'

async function row(): Promise<Record<string, unknown>> {
  const { rows } = await db.query<Record<string, unknown>>(query)
  expect(rows).toHaveLength(1)
  return rows[0]
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE TABLE accounts (id UUID PRIMARY KEY);
    CREATE TABLE whatsapp_config (id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id));
    CREATE TABLE whatsapp_webhook_dlq (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES accounts(id),
      whatsapp_config_id UUID NOT NULL REFERENCES whatsapp_config(id),
      payload JSONB NOT NULL, error_message TEXT, status TEXT NOT NULL DEFAULT 'pending'
    );
    INSERT INTO accounts VALUES ('${A}'), ('${B}');
    INSERT INTO whatsapp_config VALUES ('${CA}', '${A}'), ('${CB}', '${B}');
    -- Shape of 031: SECURITY DEFINER, search_path=public, NO revoke (default PUBLIC execute)
    CREATE FUNCTION public.enqueue_webhook_dlq(p_account_id UUID, p_whatsapp_config_id UUID, p_payload JSONB, p_error_message TEXT)
    RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      INSERT INTO public.whatsapp_webhook_dlq (account_id, whatsapp_config_id, payload, error_message)
      VALUES (p_account_id, p_whatsapp_config_id, p_payload, p_error_message) RETURNING id;
    $$;
  `)
})

describe('L5 diagnostic: reports the exposure and the hardened state', () => {
  it('flags the 031 shape as exposed (PUBLIC execute, anon/authenticated can run it)', async () => {
    const r = await row()
    expect(r.function_signature).toBe('enqueue_webhook_dlq(uuid,uuid,jsonb,text)')
    expect(r.security_definer).toBe(true)
    expect(r.public_can_execute).toBe(true)
    expect(r.anon_can_execute).toBe(true)
    expect(r.authenticated_can_execute).toBe(true)
    expect(r.service_role_can_execute).toBe(true)
    expect(r.client_roles_exposed).toBe(true)
    expect(r.hardened).toBe(false)
    // NULL ACL = default privileges: must be read as PUBLIC-executable, not as "no grants"
    expect(r.acl).toBeNull()
    expect(r.execute_grantees).toEqual(expect.arrayContaining(['PUBLIC']))
  })

  it('counts DLQ rows and detects account/config mismatches', async () => {
    await db.exec(`
      INSERT INTO whatsapp_webhook_dlq (account_id, whatsapp_config_id, payload) VALUES
        ('${A}', '${CA}', '{}'),   -- consistent
        ('${A}', '${CB}', '{}');   -- mismatch
    `)
    const r = await row()
    expect(Number(r.dlq_rows_total)).toBe(2)
    expect(Number(r.dlq_rows_account_config_mismatch)).toBe(1)
    expect(r.dlq_rls_enabled).toBe(false)
    expect(Number(r.dlq_policy_count)).toBe(0)
  })

  it('does not call it hardened when only the privileges were fixed and the ownership check is missing', async () => {
    await db.exec(`
      REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM PUBLIC;
      REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM anon;
      REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM authenticated;
      GRANT EXECUTE ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) TO service_role;
    `)
    const r = await row()
    expect(r.public_can_execute).toBe(false)
    expect(r.anon_can_execute).toBe(false)
    expect(r.authenticated_can_execute).toBe(false)
    expect(r.service_role_can_execute).toBe(true)
    expect(r.client_roles_exposed).toBe(false)
    expect(r.unexpected_execute_grantees).toBeNull()
    expect(r.execute_grantees).toEqual(['postgres', 'service_role'])
    expect(r.has_ownership_check).toBe(false) // still the 031 body
    expect(r.hardened).toBe(false)
  })

  it('flags the state produced by the real migration 082 as hardened', async () => {
    await db.exec(m082)
    const r = await row()
    expect(r.client_roles_exposed).toBe(false)
    expect(r.execute_grantees).toEqual(['postgres', 'service_role'])
    expect(Number(r.overloads_in_public)).toBe(1)
    expect(r.has_ownership_check).toBe(true)
    expect(r.hardened).toBe(true)
  })

  it('does not call it hardened while some other role still holds EXECUTE (even if anon/authenticated are clean)', async () => {
    await db.exec(`CREATE ROLE stray NOLOGIN; GRANT EXECUTE ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) TO stray;`)
    const r = await row()
    expect(r.client_roles_exposed).toBe(false)
    expect(r.unexpected_execute_grantees).toEqual(['stray'])
    expect(r.hardened).toBe(false)
    await db.exec(`REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM stray;`)
    expect((await row()).hardened).toBe(true)
  })

  it('reports an exposed overload as its own row and withholds hardened from the main function', async () => {
    await db.exec(`CREATE FUNCTION public.enqueue_webhook_dlq(p_account_id UUID) RETURNS UUID LANGUAGE sql AS $$ SELECT NULL::uuid $$;`)
    const { rows } = await db.query<Record<string, unknown>>(query)
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(Number(r.overloads_in_public)).toBe(2)
      expect(r.hardened).toBe(false)
    }
    const overload = rows.find((r) => r.function_signature === 'enqueue_webhook_dlq(uuid)')
    expect(overload?.public_can_execute).toBe(true)
    expect(overload?.client_roles_exposed).toBe(true)
    await db.exec('DROP FUNCTION public.enqueue_webhook_dlq(UUID)')
    expect((await row()).hardened).toBe(true)
  })

  it('returns zero rows when the function does not exist', async () => {
    await db.exec('DROP FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT)')
    const { rows } = await db.query(query)
    expect(rows).toHaveLength(0)
  })
})

describe('L5 diagnostic: read-only guarantees', () => {
  const body = stripComments(sql)

  it('is exactly one statement and it is a SELECT (optionally with a WITH prefix)', () => {
    const statements = body.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^(select|with)\b/i)
  })

  it('contains no write, DDL, privilege or session-changing keyword', () => {
    const forbidden =
      /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge|call|do|vacuum|analyze|reindex|cluster|lock|listen|notify|set|reset|begin|commit|rollback|savepoint|nextval|setval|set_config|pg_sleep|pg_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_notify|dblink\w*|lo_import|lo_export)\b/i
    expect(body).not.toMatch(forbidden)
  })

  it('runs inside a READ ONLY transaction', async () => {
    await db.exec(`
      CREATE FUNCTION public.enqueue_webhook_dlq(p_account_id UUID, p_whatsapp_config_id UUID, p_payload JSONB, p_error_message TEXT)
      RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT NULL::uuid $$;
    `)
    await db.exec('BEGIN READ ONLY')
    const { rows } = await db.query(query)
    await db.exec('ROLLBACK')
    expect(rows).toHaveLength(1)
  })
})
