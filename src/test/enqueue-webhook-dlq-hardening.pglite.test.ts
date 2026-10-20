import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// L5 — migration 082_enqueue_webhook_dlq_hardening.sql.
//
// 031 and 082 are loaded VERBATIM from supabase/migrations. Shows the
// exposure with 031 alone ("before") and the hardened behaviour after 082.
// PGlite = Postgres-in-WASM, single connection: privileges and logic only.
// It says nothing about the real Supabase project (see the migration header
// for the operator-reported evidence) and nothing about concurrency.

const MIG = join(process.cwd(), 'supabase', 'migrations')
const m031 = readFileSync(join(MIG, '031_webhook_dlq.sql'), 'utf8')
const m082 = readFileSync(join(MIG, '082_enqueue_webhook_dlq_hardening.sql'), 'utf8')

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CA = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const CB = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1'
const NOPE = 'deadbeef-dead-beef-dead-beefdeadbeef'
const FN = 'public.enqueue_webhook_dlq(uuid,uuid,jsonb,text)'

async function freshDb(applyHardening: boolean, platformDefaultGrants = true): Promise<PGlite> {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE TABLE accounts (id UUID PRIMARY KEY);
    CREATE TABLE whatsapp_config (id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE);
    CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    INSERT INTO accounts VALUES ('${A}'), ('${B}');
    INSERT INTO whatsapp_config VALUES ('${CA}', '${A}'), ('${CB}', '${B}');
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  `)
  await db.exec(m031)
  // Supabase-style default grants (assumed shape; the real ACL is in the migration header).
  // platformDefaultGrants=false models an install that does NOT pre-grant service_role,
  // where only the grant in 082 gives it EXECUTE once PUBLIC is revoked.
  if (platformDefaultGrants) {
    await db.exec(`GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
                   GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;`)
  }
  if (applyHardening) await db.exec(m082)
  return db
}

async function callAs(db: PGlite, role: string, acct: string, cfg: string): Promise<{ id?: string; code?: string }> {
  await db.exec(`SET ROLE ${role}`)
  try {
    const r = await db.query<{ id: string }>(`SELECT public.enqueue_webhook_dlq($1::uuid,$2::uuid,'{"k":1}'::jsonb,'probe') AS id`, [acct, cfg])
    return { id: r.rows[0].id }
  } catch (e) {
    return { code: (e as { code?: string }).code }
  } finally {
    await db.exec('RESET ROLE')
  }
}
const count = async (db: PGlite) => (await db.query<{ n: number }>('SELECT count(*)::int n FROM whatsapp_webhook_dlq')).rows[0].n

describe('BEFORE (031 only): the L5 exposure reproduces', () => {
  it('anon and authenticated can execute it and write a cross-account row', async () => {
    const db = await freshDb(false)
    for (const role of ['anon', 'authenticated']) {
      const ok = await callAs(db, role, A, CA)
      const cross = await callAs(db, role, A, CB) // account A with the config of B
      expect(ok.id).toBeTruthy()
      expect(cross.id).toBeTruthy()
    }
    const x = await db.query<{ n: number }>(`SELECT count(*)::int n FROM whatsapp_webhook_dlq WHERE account_id = '${A}' AND whatsapp_config_id = '${CB}'`)
    expect(x.rows[0].n).toBe(2)
  })
})

describe('AFTER (031 + 082): hardened', () => {
  it('anon and authenticated are denied for every input and nothing is written', async () => {
    const db = await freshDb(true)
    for (const role of ['anon', 'authenticated']) {
      for (const [a, c] of [[A, CA], [A, CB], [B, CA], [A, NOPE]]) {
        expect((await callAs(db, role, a, c)).code).toBe('42501')
      }
    }
    expect(await count(db)).toBe(0)
  })

  it('service_role still records a legitimate event (account + its own config)', async () => {
    const db = await freshDb(true)
    const r = await callAs(db, 'service_role', A, CA)
    expect(r.id).toBeTruthy()
    const row = await db.query<{ account_id: string; whatsapp_config_id: string; status: string; error_message: string }>(
      `SELECT account_id, whatsapp_config_id, status, error_message FROM whatsapp_webhook_dlq WHERE id = $1`, [r.id])
    expect(row.rows[0]).toEqual({ account_id: A, whatsapp_config_id: CA, status: 'pending', error_message: 'probe' })
  })

  it('service_role cannot link a config to another account, nor use unknown ids', async () => {
    const db = await freshDb(true)
    for (const [a, c] of [[A, CB], [B, CA], [A, NOPE], [NOPE, CA]]) {
      expect((await callAs(db, 'service_role', a, c)).code).toBe('42501')
    }
    expect(await count(db)).toBe(0)
  })

  it('PUBLIC has no EXECUTE; only service_role does', async () => {
    const db = await freshDb(true)
    const pub = await db.query<{ n: number }>(`
      SELECT count(*)::int n FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.proname = 'enqueue_webhook_dlq' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`)
    expect(pub.rows[0].n).toBe(0)
    const r = await db.query<Record<string, boolean>>(`
      SELECT has_function_privilege('anon','${FN}','EXECUTE') AS anon,
             has_function_privilege('authenticated','${FN}','EXECUTE') AS authenticated,
             has_function_privilege('service_role','${FN}','EXECUTE') AS service_role`)
    expect(r.rows[0]).toEqual({ anon: false, authenticated: false, service_role: true })
  })

  it('keeps signature, return type, SECURITY DEFINER and search_path; leaves no overload', async () => {
    const db = await freshDb(true)
    const r = await db.query<{ args: string; res: string; prosecdef: boolean; proconfig: string[] }>(`
      SELECT pg_get_function_identity_arguments(oid) args, pg_get_function_result(oid) res, prosecdef, proconfig
        FROM pg_proc WHERE proname = 'enqueue_webhook_dlq'`)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({
      args: 'p_account_id uuid, p_whatsapp_config_id uuid, p_payload jsonb, p_error_message text',
      res: 'uuid',
      prosecdef: true,
    })
    expect(r.rows[0].proconfig).toContain('search_path=public')
  })

  it('is idempotent and preserves rows recorded before the migration', async () => {
    const db = await freshDb(false)
    await db.exec(`SELECT public.enqueue_webhook_dlq('${A}','${CA}','{"pre":1}','old row')`)
    await db.exec(m082)
    await db.exec(m082)
    expect(await count(db)).toBe(1)
    expect((await callAs(db, 'service_role', A, CA)).id).toBeTruthy()
    expect(await count(db)).toBe(2)
  })

  it('re-running leaves the exact same ACL, owner and body (also for an install patched by hand beforehand)', async () => {
    const state = async (db: PGlite) =>
      (await db.query<{ acl: string; owner: string; src: string }>(
        `SELECT proacl::text acl, proowner::regrole::text owner, prosrc src FROM pg_proc WHERE proname = 'enqueue_webhook_dlq'`)).rows[0]
    const db = await freshDb(true) // 031 + 082
    const once = await state(db)
    await db.exec(m082)
    expect(await state(db)).toEqual(once)
    // manual fix first (same privileges, 031 body), then the migration: converges to the same state
    const manual = await freshDb(false)
    await manual.exec(`REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC, anon, authenticated;
                       GRANT EXECUTE ON FUNCTION ${FN} TO service_role;`)
    await manual.exec(m082)
    expect(await state(manual)).toMatchObject({ owner: once.owner, src: once.src })
    expect((await callAs(manual, 'anon', A, CA)).code).toBe('42501')
  })

  it('service_role keeps EXECUTE where the platform did not pre-grant it (the GRANT in 082 is load-bearing)', async () => {
    const db = await freshDb(true, false)
    expect((await callAs(db, 'service_role', A, CA)).id).toBeTruthy()
    for (const role of ['anon', 'authenticated']) expect((await callAs(db, role, A, CA)).code).toBe('42501')
  })
})
