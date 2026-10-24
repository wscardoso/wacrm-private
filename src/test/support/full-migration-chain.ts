import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================
// Shared PGlite harness: the REAL migration chain (001..N), applied in file
// order on top of a minimal Supabase shell (auth schema + auth.uid() driven by
// a GUC, storage schema, the three API roles, and the default privileges the
// Supabase project bootstrap grants). Used by the post-audit A-sql tests to
// reconstruct the EFFECTIVE state of policies, ACLs and functions on
// public.messages — not a hand-copied approximation of it.
//
// Nothing here touches a remote database.
// =============================================================

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

export const SUPABASE_SHELL = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE PUBLICATION supabase_realtime;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase bootstrap: everything created later in public is reachable by the
-- API roles; RLS (and explicit REVOKEs) are the enforcement layer.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  raw_user_meta_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::UUID
$$;
CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE AS $$ SELECT 'authenticated' $$;

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id TEXT PRIMARY KEY, name TEXT, public BOOLEAN DEFAULT false, file_size_limit BIGINT, allowed_mime_types TEXT[]);
CREATE TABLE storage.objects (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT, name TEXT, owner UUID, metadata JSONB);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name TEXT) RETURNS TEXT[] LANGUAGE sql AS $$ SELECT string_to_array(name, '/') $$;
`

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
}

export function readMigration(prefix: string): string {
  const file = migrationFiles().find((f) => f.startsWith(prefix))
  if (!file) throw new Error(`migration not found: ${prefix}`)
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
}

/** Boots PGlite and applies every migration whose numeric prefix is <= `upTo` (inclusive). */
export async function bootChain(upTo = 9999): Promise<PGlite> {
  const db = new PGlite({ extensions: { uuid_ossp, pg_trgm } })
  await db.exec(SUPABASE_SHELL)
  for (const f of migrationFiles()) {
    if (parseInt(f.slice(0, 3), 10) > upTo) continue
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    } catch (e) {
      throw new Error(`migration ${f} failed on PGlite: ${(e as Error).message}`)
    }
  }
  return db
}

export const U = {
  ownerA: '10000000-0000-4000-8000-00000000000a',
  agentA: '10000000-0000-4000-8000-0000000000a1',
  viewerA: '10000000-0000-4000-8000-0000000000a2',
  adminA: '10000000-0000-4000-8000-0000000000a3',
  operator: '10000000-0000-4000-8000-0000000000f1',
  ownerB: '10000000-0000-4000-8000-00000000000b',
  agentB: '10000000-0000-4000-8000-0000000000b1',
} as const

export interface World {
  accountA: string
  accountB: string
  convA: string
  convB: string
  cfgA: string
  cfgB: string
}

const asRows = async <T>(db: PGlite, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows

/**
 * Two tenants. A: owner, admin, agent, viewer (+ an authorized platform
 * operator who is NOT a member). B: owner, agent. One conversation and one
 * whatsapp_config per tenant.
 */
export async function seedWorld(db: PGlite): Promise<World> {
  for (const [key, id] of Object.entries(U)) {
    await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `${key}@example.test`])
  }
  // handle_new_user() gave every user a personal account (as owner). Pull the
  // A-side members into ownerA's account and demote them.
  const acc = async (uid: string) =>
    (await asRows<{ account_id: string }>(db, `SELECT account_id FROM profiles WHERE user_id = $1`, [uid]))[0].account_id
  const accountA = await acc(U.ownerA)
  const accountB = await acc(U.ownerB)
  for (const [uid, role] of [[U.adminA, 'admin'], [U.agentA, 'agent'], [U.viewerA, 'viewer']] as const) {
    await db.query(`UPDATE profiles SET account_id = $1, account_role = $2 WHERE user_id = $3`, [accountA, role, uid])
  }
  await db.query(`UPDATE profiles SET account_id = $1, account_role = 'agent' WHERE user_id = $2`, [accountB, U.agentB])

  await db.query(`INSERT INTO platform_operators (user_id, role, is_active, created_by) VALUES ($1,'admin',TRUE,$1)`, [U.operator])
  await db.query(`INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by) VALUES ($1,$2,'admin',$1)`, [U.operator, accountA])

  const cfg = async (account: string, owner: string, phoneNumberId: string) =>
    (await asRows<{ id: string }>(db,
      `INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token, connection_id)
       VALUES ($1,$2,$3,'enc:token',$4) RETURNING id`,
      [owner, account, phoneNumberId, `conn-${phoneNumberId}`]))[0].id
  const cfgA = await cfg(accountA, U.ownerA, '111111111')
  const cfgB = await cfg(accountB, U.ownerB, '222222222')

  const conv = async (account: string, owner: string, phone: string) => {
    const contact = (await asRows<{ id: string }>(db,
      `INSERT INTO contacts (user_id, account_id, name, phone) VALUES ($1,$2,'c',$3) RETURNING id`, [owner, account, phone]))[0].id
    return (await asRows<{ id: string }>(db,
      `INSERT INTO conversations (user_id, account_id, contact_id) VALUES ($1,$2,$3) RETURNING id`, [owner, account, contact]))[0].id
  }
  const convA = await conv(accountA, U.ownerA, '5511999990001')
  const convB = await conv(accountB, U.ownerB, '5511999990002')
  return { accountA, accountB, convA, convB, cfgA, cfgB }
}

/** Runs `fn` as an authenticated end-user (JWT sub = userId); always resets the role. */
export async function asUser<T>(db: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`SET ROLE authenticated`)
  await db.query(`SELECT set_config('app.current_user', $1, false)`, [userId])
  try {
    return await fn()
  } finally {
    await db.query(`SELECT set_config('app.current_user', '', false)`)
    await db.query(`RESET ROLE`)
  }
}

/** Runs `fn` as the service_role API role (no end user). */
export async function asService<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  await db.query(`SET ROLE service_role`)
  try {
    return await fn()
  } finally {
    await db.query(`RESET ROLE`)
  }
}

/** Resolves to the error message when `p` rejects, or null when it resolves. */
export async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** Inserts an outbound message as a superuser (setup only, bypasses RLS). */
export async function seedMessage(
  db: PGlite,
  conversationId: string,
  status: string,
  extra: { connectionRef?: string | null; messageId?: string | null; senderType?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID()
  await db.query(
    `INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text, status, message_id, idempotency_key, connection_ref)
     VALUES ($1,$2,$3,'text','hello',$4,$5,$1,$6)`,
    [id, conversationId, extra.senderType ?? 'agent', status, extra.messageId ?? null, extra.connectionRef ?? null],
  )
  return id
}
