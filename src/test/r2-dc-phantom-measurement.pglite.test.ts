import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// R2 — scripts/diagnostics/r2-dc-phantom-measurement.sql
//
// Verifies (a) the metrics are computed as specified, on a seeded fixture, and
// (b) the script is read-only: statically (a single SELECT, no write/DDL
// keywords once comments are stripped) and at runtime (it executes inside a
// READ ONLY transaction and leaves the data unchanged).
//
// PGlite is sequential Postgres-in-WASM; nothing here touches any real database.

const SQL_PATH = join(process.cwd(), 'scripts', 'diagnostics', 'r2-dc-phantom-measurement.sql')
const sql = readFileSync(SQL_PATH, 'utf8')

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE messages (
      id SERIAL PRIMARY KEY,
      sender_type TEXT NOT NULL,
      message_id TEXT,
      content_text TEXT
    );
    CREATE TABLE whatsapp_webhook_dlq (id SERIAL PRIMARY KEY, status TEXT);
    INSERT INTO messages (sender_type, message_id, content_text) VALUES
      ('customer', 'w.1',  'oi'),   -- legit
      ('customer', 'w.2',  NULL),   -- legit, media without text (has id)
      ('customer', '',     NULL),   -- phantom: empty id, no text      (strict)
      ('customer', '',     'x'),    -- empty id but has text           (not strict)
      ('customer', NULL,   NULL),   -- phantom: NULL id, no text       (strict)
      ('customer', NULL,   'y'),    -- NULL id but has text            (not strict)
      ('agent',    '',     NULL),   -- not a customer row: never counted as customer
      ('bot',      'w.9',  'resp');
    INSERT INTO whatsapp_webhook_dlq (status) VALUES ('pending'), ('done'), ('pending');
  `)
})

describe('R2 measurement script: metrics', () => {
  it('computes the six metrics as specified (global scope)', async () => {
    const { rows } = await db.query<Record<string, unknown>>(sql.replace(/;\s*$/, ''))
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(Number(r.messages_total)).toBe(8)
    expect(Number(r.messages_customer)).toBe(6)
    expect(Number(r.phantom_customer_empty_id)).toBe(2)
    expect(Number(r.phantom_customer_null_id)).toBe(2)
    expect(Number(r.phantom_strict)).toBe(2)
    expect(Number(r.webhook_dlq_total)).toBe(3)
  })

  it('returns run context columns', async () => {
    const { rows } = await db.query<Record<string, unknown>>(sql.replace(/;\s*$/, ''))
    expect(rows[0].measured_at).toBeTruthy()
    expect(typeof rows[0].database_name).toBe('string')
    expect(Object.keys(rows[0])).toEqual([
      'measured_at',
      'database_name',
      'messages_total',
      'messages_customer',
      'phantom_customer_empty_id',
      'phantom_customer_null_id',
      'phantom_strict',
      'webhook_dlq_total',
    ])
  })

  it('reports zeros on empty tables', async () => {
    const empty = new PGlite()
    await empty.exec(`
      CREATE TABLE messages (id SERIAL PRIMARY KEY, sender_type TEXT, message_id TEXT, content_text TEXT);
      CREATE TABLE whatsapp_webhook_dlq (id SERIAL PRIMARY KEY);
    `)
    const { rows } = await empty.query<Record<string, unknown>>(sql.replace(/;\s*$/, ''))
    for (const k of ['messages_total', 'messages_customer', 'phantom_customer_empty_id', 'phantom_customer_null_id', 'phantom_strict', 'webhook_dlq_total']) {
      expect(Number(rows[0][k])).toBe(0)
    }
  })
})

describe('R2 measurement script: read-only guarantees', () => {
  const body = stripComments(sql)

  it('is exactly one statement and it is a SELECT', () => {
    const statements = body.split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatch(/^select\b/i)
  })

  it('contains no write, DDL, privilege or session-changing keyword', () => {
    const forbidden =
      /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|merge|call|do|vacuum|analyze|reindex|cluster|lock|listen|notify|set|reset|begin|commit|rollback|savepoint|nextval|setval|pg_sleep|dblink|lo_import|lo_export)\b/i
    expect(body).not.toMatch(forbidden)
  })

  it('runs inside a READ ONLY transaction and leaves the data unchanged', async () => {
    const before = await db.query<{ n: number }>(`SELECT (SELECT count(*) FROM messages)::int + (SELECT count(*) FROM whatsapp_webhook_dlq)::int AS n`)
    await db.exec('BEGIN READ ONLY')
    const { rows } = await db.query<Record<string, unknown>>(sql.replace(/;\s*$/, ''))
    await db.exec('ROLLBACK')
    expect(rows).toHaveLength(1)
    const after = await db.query<{ n: number }>(`SELECT (SELECT count(*) FROM messages)::int + (SELECT count(*) FROM whatsapp_webhook_dlq)::int AS n`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('self-check: a READ ONLY transaction really rejects writes (guards against a vacuous test)', async () => {
    await db.exec('BEGIN READ ONLY')
    await expect(db.exec(`INSERT INTO messages(sender_type) VALUES ('customer')`)).rejects.toThrow(/read-only/i)
    await db.exec('ROLLBACK')
  })
})
