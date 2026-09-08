import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Plan 001 (S2) — chat-media / flow-media stop leaking cross-tenant reads.
//
// Proves, against real Postgres (PGlite), that migration 076 REAL
// (loaded verbatim) replaces the old "publicly readable" SELECT
// policy (023:83-86, 016:87-90 — `USING (bucket_id = '...')`, no
// account check) with an account-scoped one, and that:
//
//   - a member of the owning account CAN read an object under their
//     account's folder in either bucket;
//   - a member of a DIFFERENT account CANNOT read it (RLS blocks the
//     row, mirroring the plan's "403 instead of the file" behavior —
//     PGlite has no Storage HTTP layer, so this proves the row-level
//     access the Storage API's authorization ultimately relies on);
//   - flow-media's dual predicate (account-scoped OR legacy
//     user-scoped, from migration 020) still lets the ORIGINAL
//     uploader read a pre-020 object stored under the legacy
//     `{auth.uid()}/...` path convention.
//
// No prior PGlite test exercises the `storage.*` schema (grepped
// `src/test` for storage.objects/storage.buckets/storage.foldername
// — no hits), so this hand-rolls the minimal slice of that schema
// (buckets/objects tables + the real `storage.foldername()` body)
// needed to exercise the policy predicate — the same technique
// gate2-profiles-tenant-escalation.pglite.test.ts already uses for
// `public.profiles` (hand-rolled foundation + a REAL migration file
// loaded verbatim + `SET ROLE authenticated` / `set_config('app.current_user', ...)`
// to simulate `auth.uid()`).

let db: PGlite

const FOUNDATION = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::UUID
$$;

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'x'
);

-- Minimal shape of public.profiles — only the columns migration 076's
-- policy predicate reads.
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE
);
GRANT SELECT ON profiles TO authenticated;

-- ============================================================
-- Minimal storage.* schema — just enough surface for migration
-- 076 to run verbatim and for its policy predicate to evaluate.
-- storage.foldername() body copied from Supabase's real
-- implementation (splits on '/', drops the last — filename —
-- segment).
-- ============================================================
CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA storage TO authenticated;

CREATE TABLE storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public BOOLEAN NOT NULL DEFAULT FALSE,
  file_size_limit BIGINT,
  allowed_mime_types TEXT[]
);

CREATE TABLE storage.objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT REFERENCES storage.buckets(id),
  name TEXT
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON storage.objects TO authenticated;

CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
  RETURNS TEXT[]
  LANGUAGE plpgsql
AS $$
DECLARE
  _parts TEXT[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1 : array_length(_parts, 1) - 1];
END;
$$;

INSERT INTO storage.buckets (id, name, public) VALUES
  ('chat-media', 'chat-media', TRUE),
  ('flow-media', 'flow-media', TRUE);
`

function loadMigration(name: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const file = readdirSync(dir).find((f) => f.endsWith(name))
  if (!file) throw new Error(`migration not found: ${name}`)
  return readFileSync(join(dir, file), 'utf8')
}

async function run<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(text, params)
  return r.rows as T[]
}

async function asUser<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await run(`SET ROLE authenticated`)
  await run(`SELECT set_config('app.current_user', $1, false)`, [userId ?? ''])
  try {
    return await fn()
  } finally {
    await run(`SELECT set_config('app.current_user', NULL, false)`)
    await run(`RESET ROLE`)
  }
}

const U = {
  memberA: '50000000-0000-0000-0000-000000000001',
  memberB: '50000000-0000-0000-0000-000000000002',
  legacyUploader: '50000000-0000-0000-0000-000000000003',
}
const ACC = {
  a: '60000000-0000-0000-0000-000000000001',
  b: '60000000-0000-0000-0000-000000000002',
}

async function seed() {
  await run(`INSERT INTO accounts (id, name) VALUES ($1, 'account-a'), ($2, 'account-b')`, [ACC.a, ACC.b])
  await run(`INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)`, [U.memberA, U.memberB, U.legacyUploader])
  await run(
    `INSERT INTO profiles (user_id, account_id) VALUES ($1, $2), ($3, $4), ($5, $2)`,
    [U.memberA, ACC.a, U.memberB, ACC.b, U.legacyUploader],
  )

  // chat-media: account-scoped object under account A's folder.
  await run(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)`, [
    'chat-media',
    `account-${ACC.a}/1700000000000-photo.png`,
  ])

  // flow-media: one account-scoped object (post-020 convention) and one
  // legacy per-user object (pre-020 convention, uploaded by legacyUploader
  // who — per seed above — is ALSO a member of account B, so the test can
  // tell apart "readable because account-scoped" from "readable because
  // legacy uid match").
  await run(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)`, [
    'flow-media',
    `account-${ACC.a}/1700000000000-node.png`,
  ])
  await run(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)`, [
    'flow-media',
    `${U.legacyUploader}/1650000000000-legacy-node.png`,
  ])
}

describe('migration 076 — chat-media / flow-media SELECT is account-scoped, not public', () => {
  beforeAll(async () => {
    db = new PGlite()
    await db.exec(FOUNDATION)
    await seed()
    await db.exec(loadMigration('076_private_media_buckets.sql'))
  })

  it('sets both buckets to public = FALSE', async () => {
    const rows = await run<{ id: string; public: boolean }>(
      `SELECT id, public FROM storage.buckets WHERE id IN ('chat-media', 'flow-media') ORDER BY id`,
    )
    expect(rows).toEqual([
      { id: 'chat-media', public: false },
      { id: 'flow-media', public: false },
    ])
  })

  it('chat-media: account A member reads their own account-scoped object', async () => {
    const rows = await asUser(U.memberA, () =>
      run<{ name: string }>(`SELECT name FROM storage.objects WHERE bucket_id = 'chat-media'`),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toContain(`account-${ACC.a}`)
  })

  it('chat-media: account B member CANNOT read account A object (cross-tenant blocked)', async () => {
    const rows = await asUser(U.memberB, () =>
      run<{ name: string }>(`SELECT name FROM storage.objects WHERE bucket_id = 'chat-media'`),
    )
    expect(rows).toEqual([])
  })

  it('flow-media: account A member reads the account-scoped object', async () => {
    const rows = await asUser(U.memberA, () =>
      run<{ name: string }>(
        `SELECT name FROM storage.objects WHERE bucket_id = 'flow-media' AND name LIKE 'account-%'`,
      ),
    )
    expect(rows).toHaveLength(1)
  })

  it('flow-media: the legacy uploader still reads their pre-020 legacy-path object', async () => {
    const rows = await asUser(U.legacyUploader, () =>
      run<{ name: string }>(
        `SELECT name FROM storage.objects WHERE bucket_id = 'flow-media' AND name LIKE $1`,
        [`${U.legacyUploader}/%`],
      ),
    )
    expect(rows).toHaveLength(1)
  })

  it('flow-media: account A member (not the legacy uploader, different account) cannot read the legacy-path object', async () => {
    const rows = await asUser(U.memberA, () =>
      run<{ name: string }>(
        `SELECT name FROM storage.objects WHERE bucket_id = 'flow-media' AND name LIKE $1`,
        [`${U.legacyUploader}/%`],
      ),
    )
    expect(rows).toEqual([])
  })

  it('no longer defines a public "publicly readable" policy for either bucket', async () => {
    const rows = await run<{ policyname: string }>(
      `SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE '%publicly readable%'`,
    )
    expect(rows).toEqual([])
  })
})
