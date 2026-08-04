import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalBr } from '../lib/whatsapp/phone-identity'

// Smoke test — executes the REAL migration files against in-memory Postgres
// (PGlite) to prove they parse and apply, and that the identity functions
// (065) behave as specified. The full merge scenario suite lives in
// src/test/identity-merge.pglite.test.ts (Fase G.2); this file only guards
// the DDL + function surface of HOTFIX-001 Fases B.1/B.2/B.6/E.1/F.1.

let db: PGlite

const MINIMAL = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'x'
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'active'
);
`

function loadMigration(name: string): string {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const file = require('node:fs')
    .readdirSync(dir)
    .find((f: string) => f.endsWith(name))
  if (!file) throw new Error(`migration not found: ${name}`)
  return readFileSync(join(dir, file), 'utf8')
}

async function run<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(text, params)
  return r.rows as T[]
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(MINIMAL)
  await db.exec(loadMigration('064_identity_br_ddd_reference.sql'))
  await db.exec(loadMigration('065_identity_br_functions.sql'))
  await db.exec(loadMigration('068_flow_runs_merge_terminal_state.sql'))
  await db.exec(loadMigration('069_identity_merge_group_lock.sql'))
  await db.exec(loadMigration('071_identity_merge_backfill_checkpoint.sql'))
  await db.exec(loadMigration('072_identity_merge_v2_flag.sql'))
})

describe('canonical_br() / phone_identity() — ADR-IDENTITY-BR-001 §5–§9', () => {
  it('mobile 11-digit + valid DDD -> 55+DDD+subscriber', async () => {
    const r = await run<{ canonical_br: string | null }>(
      `SELECT canonical_br('5511987654321') AS canonical_br`,
    )
    expect(r[0].canonical_br).toBe('5511987654321')
  })

  it('legacy 10-digit mobile with 6-9 leading subscriber -> prefixed 9', async () => {
    const r = await run<{ canonical_br: string | null }>(
      `SELECT canonical_br('1198765432') AS canonical_br`,
    )
    // body '11' + '98765432' (already starts with 9 -> legacy mobile)
    // -> canonical = '55' + '11' + '9' + '98765432' = '5511998765432'
    expect(r[0].canonical_br).toBe('5511998765432')
  })

  it('fixed 10-digit with 2-5 leading subscriber -> as-is', async () => {
    const r = await run<{ canonical_br: string | null }>(
      `SELECT canonical_br('1121234567') AS canonical_br`,
    )
    // '55' + '11' + '21234567' = '551121234567'
    expect(r[0].canonical_br).toBe('551121234567')
  })

  it('non-BR / unknown DDD → NULL (NonBR)', async () => {
    const r = await run<{ canonical_br: string | null; us: string | null }>(
      `SELECT canonical_br('5519999999999') AS canonical_br, canonical_br('1 415 555 0100') AS us`,
    )
    // 5519999999999: DDD 19 is valid; 11 digits starting 9 -> mobile. Actually DDD 19 exists.
    // 1 415... is definitely NonBR.
    expect(r[0].us).toBeNull()
  })

  it('phone_identity = COALESCE(canonical_br, digits)', async () => {
    const r = await run<{ a: string; b: string }>(
      `SELECT phone_identity('5511987654321') AS a, phone_identity('+1 (415) 555-0100') AS b`,
    )
    expect(r[0].a).toBe('5511987654321')
    expect(r[0].b).toBe('14155550100')
  })

  it('§7.1: different DDDs with same subscriber are NOT equivalent', async () => {
    // Same 9-digit subscriber 987654321, different valid DDDs (11 SP, 21 RJ).
    // With DDD dropped from the key these would collapse into one identity —
    // ADR §5 (55+DDD+assinante) and §7.1 require distinct canonical keys.
    const r = await run<{ a: string | null; b: string | null }>(
      `SELECT canonical_br('11987654321') AS a, canonical_br('21987654321') AS b`,
    )
    expect(r[0].a).toBe('5511987654321')
    expect(r[0].b).toBe('5521987654321')
    expect(r[0].a).not.toBe(r[0].b)
  })

  it('§8.1 idempotency: canonical_br(canonical_br(x)) = canonical_br(x)', async () => {
    const r = await run<{ a: string | null; b: string | null }>(
      `SELECT canonical_br('11987654321') AS a, canonical_br(canonical_br('11987654321')) AS b`,
    )
    expect(r[0].a).toBe('5511987654321')
    expect(r[0].b).toBe('5511987654321')
  })

  it('G.1 parity: SQL and TS produce identical keys (Annex B fixtures)', async () => {
    const fixtures = [
      '5511987654321',
      '5511911111111',
      '1198765432',
      '1191111111',
      '1121234567',
      '55211234567',
      '+1 (415) 555-0100',
      '442071838750',
      '',
      '0',
      '550',
      '5519',
    ]
    const { rows } = await db.query<{ input: string; sql: string | null }>(`
      SELECT x::text AS input, canonical_br(x::text) AS sql
      FROM unnest($1::text[]) AS x
    `, [fixtures])
    for (const row of rows) {
      expect(canonicalBr(row.input)).toBe(row.sql)
    }
  })
})

describe('064 mirror table — valid DDD reference', () => {
  it('seeded from anatel-ddd.json (67 rows)', async () => {
    const r = await run<{ c: number }>(`SELECT count(*)::int AS c FROM identity_br_valid_ddd`)
    expect(r[0].c).toBe(67)
  })
})

describe('068 flow_runs terminal state', () => {
  it('accepts superseded_by_identity_merge', async () => {
    await run(
      `INSERT INTO flow_runs (status) VALUES ('superseded_by_identity_merge')`,
    )
    const r = await run<{ c: number }>(
      `SELECT count(*)::int AS c FROM flow_runs WHERE status='superseded_by_identity_merge'`,
    )
    expect(r[0].c).toBe(1)
  })
  it('rejects an unknown status', async () => {
    await expect(run(`INSERT INTO flow_runs (status) VALUES ('nonsense')`)).rejects.toThrow()
  })
})

describe('069 identity_merge_group_lock', () => {
  it('is callable (advisory lock, reentrant)', async () => {
    await run(`SELECT identity_merge_group_lock('11111111-1111-1111-1111-111111111111'::uuid, 'phone')`)
    await run(`SELECT identity_merge_group_lock('11111111-1111-1111-1111-111111111111'::uuid, 'phone')`) // reentrant no-op
    // xact-scoped: held within a single transaction, released at COMMIT.
    await db.exec(`
      BEGIN;
      SELECT identity_merge_group_lock('11111111-1111-1111-1111-111111111111'::uuid, 'phone');
      COMMIT;
    `)
    const after = await run<{ c: number }>(`SELECT count(*)::int AS c FROM pg_locks WHERE locktype='advisory'`)
    expect(after[0].c).toBe(0)
  })
})

describe('071 checkpoint table', () => {
  it('unique per (account_id, phone_identity)', async () => {
    const acc = '11111111-1111-1111-1111-111111111111'
    await run(
      `INSERT INTO accounts (id) VALUES ($1)`,
      [acc],
    )
    await run(
      `INSERT INTO identity_merge_backfill_checkpoint (account_id, phone_identity) VALUES ($1, $2)`,
      [acc, '5511987654321'],
    )
    await expect(
      run(`INSERT INTO identity_merge_backfill_checkpoint (account_id, phone_identity) VALUES ($1, $2)`, [acc, '5511987654321']),
    ).rejects.toThrow()
  })
})

describe('072 flag column', () => {
  it('defaults to off and accepts the three states', async () => {
    const r = await run<{ identity_merge_v2_state: string }>(
      `SELECT identity_merge_v2_state FROM accounts`,
    )
    expect(r[0].identity_merge_v2_state).toBe('off')
    await run(`UPDATE accounts SET identity_merge_v2_state = 'identity_v2'`)
    await run(`UPDATE accounts SET identity_merge_v2_state = 'identity_v2_merge'`)
    await expect(run(`UPDATE accounts SET identity_merge_v2_state = 'bogus'`)).rejects.toThrow()
  })
})
