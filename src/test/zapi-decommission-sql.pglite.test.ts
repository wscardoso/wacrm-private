import { beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Executes the ACTUAL prepared SQL in docs/operations/zapi-decommission/ on an
// in-memory Postgres. This is the only validation the scripts get before an
// authorised operator runs them: nothing here touches a remote database.
//
// The schema below mirrors the columns the repository's code and migrations
// define for the tables the scripts read (see 01-inventory.sql [1]), EXCEPT
// messages.connection_ref, which no versioned migration creates and which the
// tests add or change explicitly where they need it.

const DIR = join(process.cwd(), 'docs', 'operations', 'zapi-decommission')
const sql = (f: string) => readFileSync(join(DIR, f), 'utf8')

/** SQL text with comments and string literals blanked, so keyword checks look at code only. */
function codeWithoutCommentsOrLiterals(file: string): string {
  return sql(file).replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''")
}

/** Splits a script made only of simple statements (no DO blocks / $$). */
function statements(file: string): string[] {
  const code = sql(file).replace(/--[^\n]*/g, '')
  return code.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)
}

const SCHEMA = (opts: { connectionRef?: 'uuid' | 'text' | null } = {}) => `
CREATE TABLE whatsapp_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'meta',
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected')),
  waba_id TEXT,
  instance_id TEXT,
  base_url TEXT,
  phone_number_id TEXT,
  access_token TEXT NOT NULL,
  connection_id TEXT,
  webhook_secret_hash TEXT,
  connected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_config FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE contacts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone TEXT NOT NULL DEFAULT '');
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  contact_id UUID REFERENCES contacts(id)
);
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  sender_type TEXT NOT NULL DEFAULT 'agent',
  content_type TEXT NOT NULL DEFAULT 'text',
  content_text TEXT,
  media_url TEXT,
  template_name TEXT,
  message_id TEXT,
  status TEXT NOT NULL,
  idempotency_key UUID,
  reply_to_message_id UUID,
  ${opts.connectionRef ? `connection_ref ${opts.connectionRef.toUpperCase()},` : ''}
  ${opts.connectionRef === 'uuid' ? 'delivery_provider TEXT, delivery_channel_fp TEXT,' : ''}
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE outbound_retry_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE REFERENCES messages(id),
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  classification TEXT NOT NULL DEFAULT 'ambiguous',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_webhook_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  whatsapp_config_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE message_external_ids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id),
  connection_ref UUID NOT NULL,
  kind TEXT NOT NULL DEFAULT 'wamid',
  value TEXT NOT NULL DEFAULT 'x'
);
`

const ID = {
  metaConn: '00000000-0000-0000-0000-0000000000a1',
  metaDisc: '00000000-0000-0000-0000-0000000000a2',
  uazapi: '00000000-0000-0000-0000-0000000000a3',
  uazapiResidual: '00000000-0000-0000-0000-0000000000a4',
  zapiConn: '00000000-0000-0000-0000-0000000000b1',
  zapiConnNoToken: '00000000-0000-0000-0000-0000000000b2',
  zapiDiscWithToken: '00000000-0000-0000-0000-0000000000b3',
  zapiClean: '00000000-0000-0000-0000-0000000000b4',
  unknown: '00000000-0000-0000-0000-0000000000c1',
}
const SECRETS = ['tok-meta-1', 'tok-ua-1', 'tok-z-1', 'enc:zapi-client-token', 'enc:residual-cipher', 'hash-']

let db: PGlite

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query(q, p)).rows as T[]
}

async function seed() {
  const cfg = (id: string, provider: string, status: string, waba: string | null, token: string) =>
    db.query(
      `INSERT INTO whatsapp_config (id, account_id, provider, status, waba_id, instance_id, access_token, webhook_secret_hash, connection_id, connected_at)
       VALUES ($1::uuid, gen_random_uuid(), $2, $3, $4, 'inst', $5, 'hash-' || $1::text, 'conn-' || $1::text, now())`,
      [id, provider, status, waba, token],
    )
  await cfg(ID.metaConn, 'meta', 'connected', '123456789012345', 'tok-meta-1')
  await cfg(ID.metaDisc, 'meta', 'disconnected', null, 'tok-meta-2')
  await cfg(ID.uazapi, 'uazapi', 'connected', null, 'tok-ua-1')
  await cfg(ID.uazapiResidual, 'uazapi', 'connected', 'enc:residual-cipher', 'tok-ua-2')
  await cfg(ID.zapiConn, 'zapi', 'connected', 'enc:zapi-client-token', 'tok-z-1')
  await cfg(ID.zapiConnNoToken, 'zapi', 'connected', null, 'tok-z-2')
  await cfg(ID.zapiDiscWithToken, 'zapi', 'disconnected', 'enc:zapi-client-token-2', 'tok-z-3')
  await cfg(ID.zapiClean, 'zapi', 'disconnected', null, 'tok-z-4')
  await cfg(ID.unknown, 'evolution', 'connected', null, 'tok-x')

  const { rows: acc } = await db.query(`SELECT account_id FROM whatsapp_config WHERE id = $1`, [ID.zapiConn])
  const accountId = (acc[0] as { account_id: string }).account_id
  const { rows: conv } = await db.query(`INSERT INTO conversations (account_id) VALUES ($1) RETURNING id`, [accountId])
  const convId = (conv[0] as { id: string }).id
  const { rows: msg } = await db.query(
    `INSERT INTO messages (conversation_id, status, created_at) VALUES ($1, 'sending', now() - interval '1 hour') RETURNING id`, [convId])
  const msgId = (msg[0] as { id: string }).id
  await db.query(`INSERT INTO outbound_retry_ledger (message_id, status, next_attempt_at) VALUES ($1, 'pending', NULL)`, [msgId])
  await db.query(`INSERT INTO whatsapp_webhook_dlq (whatsapp_config_id, status) VALUES ($1, 'pending')`, [ID.zapiConn])
}

async function newDb(connectionRef: 'uuid' | 'text' | null = null, withSeed = true) {
  db = new PGlite()
  await db.exec(SCHEMA({ connectionRef }))
  if (withSeed) await seed()
}

// The default schema is the one AFTER migration 083 (binding columns present), so the
// whole inventory runs; the tests about a database that lacks them use the diagnostics only.
beforeEach(async () => { await newDb('uuid') })

/** Statements that read only catalogs: the ones that always run, even on a pre-083 schema. */
async function runDiagnostics() {
  const stmts = statements('01-inventory.sql')
  const firstData = stmts.findIndex((x) => x.includes('FROM public.whatsapp_config\nGROUP BY provider, status'))
  const out: Array<{ sql: string; rows: Array<Record<string, unknown>> }> = []
  for (const x of stmts.slice(0, firstData)) out.push({ sql: x, rows: (await db.query(x)).rows as Array<Record<string, unknown>> })
  return out
}

/** Runs every statement of 01 in order; returns the result rows of each, keyed by label. */
async function runInventory(upTo?: number) {
  const stmts = statements('01-inventory.sql')
  const out: Array<{ sql: string; rows: Array<Record<string, unknown>>; fields: string[] }> = []
  for (const [i, s] of stmts.entries()) {
    if (upTo !== undefined && i >= upTo) break
    const r = await db.query(s)
    out.push({ sql: s, rows: r.rows as Array<Record<string, unknown>>, fields: r.fields.map((f) => f.name) })
  }
  return out
}
const find = (res: Awaited<ReturnType<typeof runInventory>>, marker: string) => {
  const hit = res.find((r) => r.sql.includes(marker))
  if (!hit) throw new Error(`no statement containing ${marker}`)
  return hit
}

const DECOMMISSION = (extra = '') =>
  `BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL zapi_decommission.backup_confirmed = 'yes'; ${sql('02-decommission.sql')} ${extra}`

async function referenceValues() {
  const res = await runInventory()
  const ref = find(res, 'AS non_zapi_fingerprint').rows[0] as { zapi_rows: string; non_zapi_fingerprint: string }
  await db.query('RESET default_transaction_read_only')
  return ref
}

async function decommissionAndVerify(opts: { ref?: { zapi_rows: string; non_zapi_fingerprint: string }; between?: string; end?: 'COMMIT' | 'ROLLBACK' } = {}) {
  const ref = opts.ref ?? (await referenceValues())
  const script =
    DECOMMISSION() +
    (opts.between ?? '') +
    `SET LOCAL zapi_decommission.expected_zapi_rows = '${ref.zapi_rows}';
     SET LOCAL zapi_decommission.expected_non_zapi_fingerprint = '${ref.non_zapi_fingerprint}';
     ${sql('03-verify.sql')}
     ${opts.end ?? 'COMMIT'};`
  const r = await db.exec(script)
  const verify = r.find((x) => x.fields.some((f) => f.name === 'criterion'))!
  return verify.rows as Array<{ n: number; criterion: string; observed: string | null; ok: boolean }>
}

describe('01-inventory.sql — static properties', () => {
  it('contains only SELECT plus the session SET/RESET of the read-only guard', () => {
    const verbs = statements('01-inventory.sql').map((s) => s.match(/^(\w+)/)![1].toUpperCase())
    expect([...new Set(verbs)].sort()).toEqual(['RESET', 'SELECT', 'SET', 'WITH'])
    expect(codeWithoutCommentsOrLiterals('01-inventory.sql')).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/i)
  })

  it('no credential value enters any hash or output: access_token only appears as a presence flag or a catalog label', () => {
    const code = sql('01-inventory.sql').replace(/--[^\n]*/g, '')
    const uses = [...code.matchAll(/access_token(.{0,20})/g)].map((m) => m[1])
    for (const tail of uses) expect(tail.startsWith(' IS NOT NULL') || tail.startsWith("'")).toBe(true)
    expect(code).not.toMatch(/md5\(/i)
  })
})

describe('01-inventory.sql — D2 identity and D4 read-only protection', () => {
  it('[0] reports database, user, version and that the session is read-only', async () => {
    const res = await runInventory()
    const id = find(res, 'AS database_name').rows[0] as Record<string, string>
    expect(id.database_name).toBeTruthy()
    expect(id.transaction_read_only).toBe('on')
    expect(id.default_read_only).toBe('on')
    expect(id.server_version).toMatch(/^\d+/)
    expect(id.db_user).toBeTruthy()
    expect(id.schemas_with_messages).toBe('public')
    expect(id.schemas_with_whatsapp_config).toBe('public')
  })

  it('while the guard is on, a write in the same session is rejected', async () => {
    await runInventory(statements('01-inventory.sql').length - 1) // everything except the final RESET
    await expect(db.query(`UPDATE whatsapp_config SET status = 'disconnected'`)).rejects.toThrow(/read-only/i)
  })

  it('the final RESET leaves the session as it was found', async () => {
    await runInventory()
    expect((await rows<{ s: string }>(`SHOW transaction_read_only`))[0]).toEqual({ transaction_read_only: 'off' })
  })
})

describe('01-inventory.sql — D1 schema contract', () => {
  it('reports the three binding columns as MISSING before migration 083 and everything else OK', async () => {
    await newDb(null)
    const res = await runDiagnostics()
    const contract = find(res as never, 'e.expected_udt') .rows as Array<Record<string, string>>
    const notOk = contract.filter((r) => r.status !== 'OK')
    expect(notOk.map((r) => `${r.table_name}.${r.column_name}`)).toEqual(['messages.connection_ref', 'messages.delivery_channel_fp', 'messages.delivery_provider'])
    expect(notOk.every((r) => r.status === 'MISSING' && r.data_type === null && r.blocks_statements === '[10]')).toBe(true)
    expect(notOk[0]).toMatchObject({ expected_udt: 'uuid' })
    expect(notOk[0].used_by).toContain('orphan-sweep')
    // non-OK rows sort first
    expect(contract[0].column_name).toBe('connection_ref')
  })

  it('reports data_type / udt_name / nullability when the column exists with the right type', async () => {
    await newDb('uuid')
    const contract = find(await runInventory(), 'e.expected_udt').rows as Array<Record<string, string>>
    expect(contract.every((r) => r.status === 'OK')).toBe(true)
    const ref = contract.find((r) => r.column_name === 'connection_ref' && r.table_name === 'messages')!
    expect(ref).toMatchObject({ data_type: 'uuid', udt_name: 'uuid', is_nullable: 'YES' })
    const notNull = contract.find((r) => r.table_name === 'messages' && r.column_name === 'status')!
    expect(notNull.is_nullable).toBe('NO')
  })

  it('reports TYPE_MISMATCH when connection_ref exists with another type', async () => {
    await newDb('text')
    const contract = find((await runDiagnostics()) as never, 'e.expected_udt').rows as Array<Record<string, string>>
    expect(contract.filter((r) => r.status !== 'OK')).toEqual([
      expect.objectContaining({ table_name: 'messages', column_name: 'connection_ref', status: 'TYPE_MISMATCH', udt_name: 'text', expected_udt: 'uuid' }),
      expect.objectContaining({ table_name: 'messages', column_name: 'delivery_channel_fp', status: 'MISSING' }),
      expect.objectContaining({ table_name: 'messages', column_name: 'delivery_provider', status: 'MISSING' }),
    ])
  })

  it('on a database WITHOUT the application tables the diagnosis still runs (all MISSING, no failure)', async () => {
    db = new PGlite()
    const stmts = statements('01-inventory.sql')
    const diagnostics = stmts.slice(0, stmts.findIndex((s) => s.includes('FROM public.whatsapp_config\nGROUP BY provider, status')))
    const out: Array<{ sql: string; rows: Array<Record<string, unknown>> }> = []
    for (const s of diagnostics) out.push({ sql: s, rows: (await db.query(s)).rows as Array<Record<string, unknown>> })
    const contract = out.find((r) => r.sql.includes('e.expected_udt'))!.rows
    expect(contract.length).toBeGreaterThan(40)
    expect(contract.every((r) => r.status === 'MISSING')).toBe(true)
    const objects = out.find((r) => r.sql.includes("'message_external_ids'") && r.sql.includes('AS present'))!.rows as Array<{ present: string | number }>
    expect(objects.every((o) => Number(o.present) === 0)).toBe(true)
    // the data statements are the ones that fail on such a schema — and [1] told the operator so
    await expect(db.query(stmts.find((s) => s.includes('FROM public.whatsapp_config\nGROUP BY provider, status'))!)).rejects.toThrow()
    expect(contract.find((r) => r.column_name === 'provider' && r.table_name === 'whatsapp_config')!.blocks_statements).toContain('[3]')
  })

  it('every column named in the contract is one the repository code actually reads (spot check against the sources)', () => {
    const cron = readFileSync(join(process.cwd(), 'src/app/api/whatsapp/delivery/cron/route.ts'), 'utf8')
    const sweep = readFileSync(join(process.cwd(), 'src/app/api/whatsapp/delivery/orphan-sweep/route.ts'), 'utf8')
    for (const col of ['id', 'conversation_id', 'content_type', 'content_text', 'media_url', 'template_name', 'reply_to_message_id', 'connection_ref', 'created_at']) {
      expect(cron).toContain(col)
    }
    for (const col of ['connection_ref', 'conversation_id', 'created_at', 'updated_at', 'next_attempt_at', 'classification']) {
      expect(cron + sweep).toContain(col)
    }
    const inv = sql('01-inventory.sql')
    for (const col of ['reply_to_message_id', 'connection_ref', 'attempt_count', 'classification', 'last_error']) expect(inv).toContain(`'${col}'`)
  })
})

describe('01-inventory.sql — D6 dependencies and cascades', () => {
  it('finds the DLQ FK from the catalog and marks it as declared by the versioned migrations', async () => {
    const res = await runInventory()
    const deps = find(res, 'WITH RECURSIVE chain').rows as Array<Record<string, unknown>>
    expect(deps).toEqual([
      expect.objectContaining({ depth: 1, dependent_table: 'whatsapp_webhook_dlq', references_table: 'whatsapp_config', delete_rule: 'CASCADE', columns: 'whatsapp_config_id', evidence: 'catalog of the consulted database', in_versioned_migrations: true }),
    ])
    expect(find(res, 'AS found_in_database').rows).toEqual([
      expect.objectContaining({ child_table: 'whatsapp_webhook_dlq', versioned_delete_rule: 'CASCADE', found_in_database: true }),
    ])
  })

  it('surfaces a dependency the repository does not know about, and the tables reached through the cascade chain', async () => {
    await db.exec(`
      CREATE TABLE audit_unknown (id UUID PRIMARY KEY, cfg UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL);
      CREATE TABLE dlq_child (id UUID PRIMARY KEY, dlq UUID REFERENCES whatsapp_webhook_dlq(id) ON DELETE CASCADE);
      CREATE TABLE dlq_grandchild (id UUID PRIMARY KEY, c UUID REFERENCES dlq_child(id) ON DELETE CASCADE);
    `)
    const deps = find(await runInventory(), 'WITH RECURSIVE chain').rows as Array<Record<string, unknown>>
    const byTable = Object.fromEntries(deps.map((d) => [d.dependent_table as string, d]))
    expect(byTable.audit_unknown).toMatchObject({ depth: 1, delete_rule: 'SET NULL', in_versioned_migrations: false })
    expect(byTable.dlq_child).toMatchObject({ depth: 2, delete_rule: 'CASCADE' })
    expect(byTable.dlq_grandchild).toMatchObject({ depth: 3, delete_rule: 'CASCADE' })
  })

  it('reports drift when the versioned dependency is absent from the database', async () => {
    await db.exec(`ALTER TABLE whatsapp_webhook_dlq DROP CONSTRAINT whatsapp_webhook_dlq_whatsapp_config_id_fkey`)
    const res = await runInventory()
    expect(find(res, 'AS found_in_database').rows[0]).toMatchObject({ found_in_database: false })
    expect(find(res, 'WITH RECURSIVE chain').rows).toEqual([])
  })

  it('lists the triggers on whatsapp_config (02/03 rely on set_updated_at)', async () => {
    const trig = find(await runInventory(), 'pg_get_triggerdef').rows as Array<{ trigger_name: string }>
    expect(trig.map((t) => t.trigger_name)).toEqual(['set_updated_at'])
  })
})

describe('01-inventory.sql — delivery binding ([2d] [2e] [10])', () => {
  async function outbound(opts: { cfg: string | null; provider: string | null; fp?: string | null; status?: string; sender?: string; ageHours?: number; account?: string }) {
    const accountId = opts.account ?? ((await rows<{ account_id: string }>(`SELECT account_id FROM whatsapp_config WHERE id = $1`, [ID.metaConn]))[0].account_id)
    const conv = (await rows<{ id: string }>(`INSERT INTO conversations (account_id) VALUES ($1) RETURNING id`, [accountId]))[0].id
    await db.query(
      `INSERT INTO messages (conversation_id, status, sender_type, connection_ref, delivery_provider, delivery_channel_fp, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' hours')::interval)`,
      [conv, opts.status ?? 'sent', opts.sender ?? 'agent', opts.cfg, opts.provider, opts.fp === undefined ? (opts.provider ? 'v1:' + 'a'.repeat(64) : null) : opts.fp, String(opts.ageHours ?? 1)],
    )
  }
  const coverage = async () => find(await runInventory(), 'provider_matches_snapshot').rows

  it('[10] separates bound, unbound (legacy), foreign-account and provider-switched outbound messages — counts only', async () => {
    await outbound({ cfg: ID.metaConn, provider: 'meta' })                       // bound, same account, provider unchanged
    await outbound({ cfg: ID.metaConn, provider: 'uazapi' })                     // bound, but the provider changed since
    await outbound({ cfg: null, provider: null })                                // legacy: no binding
    await outbound({ cfg: ID.metaConn, provider: 'meta', fp: null })             // incomplete binding
    await outbound({ cfg: ID.metaConn, provider: 'meta', account: '00000000-0000-0000-0000-00000000dead' }) // config of ANOTHER account
    await outbound({ cfg: ID.metaConn, provider: 'meta', ageHours: 100 })        // outside the 72 h window
    await outbound({ cfg: null, provider: null, sender: 'customer' })            // inbound: not counted
    const r = (await coverage()) as Array<{ has_binding: boolean; delivery_provider: string | null; config_same_account: boolean; provider_matches_snapshot: boolean | null; messages: number }>
    const pick = (f: (x: (typeof r)[number]) => boolean) => r.filter(f).reduce((n, x) => n + Number(x.messages), 0)
    expect(pick((x) => x.has_binding && x.config_same_account && x.provider_matches_snapshot === true)).toBe(1)
    expect(pick((x) => x.has_binding && x.config_same_account && x.provider_matches_snapshot === false)).toBe(1)
    expect(pick((x) => x.has_binding && !x.config_same_account)).toBe(1)
    expect(pick((x) => !x.has_binding)).toBe(3) // the seeded legacy message, the null one and the incomplete one
    expect(pick(() => true)).toBe(6) // inbound and >72 h rows are not in the result
  })

  it('[10] does not select content, phone, ids or the fingerprint itself', async () => {
    await outbound({ cfg: ID.metaConn, provider: 'meta' })
    const fields = find(await runInventory(), 'provider_matches_snapshot').fields
    expect(fields.sort()).toEqual(['config_same_account', 'delivery_provider', 'has_binding', 'messages', 'provider_matches_snapshot', 'status'])
  })

  it('[2d] lists triggers on messages and functions that mention the binding columns', async () => {
    await db.exec(`
      CREATE FUNCTION fill_ref() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.connection_ref := gen_random_uuid(); RETURN NEW; END $$;
      CREATE TRIGGER messages_fill_ref BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION fill_ref();
    `)
    const rows2d = find(await runInventory(), 'function_mentions_binding_column').rows as Array<{ kind: string; name: string }>
    expect(rows2d.map((x) => `${x.kind}:${x.name}`)).toEqual(['function_mentions_binding_column:fill_ref()', 'trigger:messages_fill_ref'])
  })

  it('[2d] is empty on a clean schema', async () => {
    expect(find(await runInventory(), 'function_mentions_binding_column').rows).toEqual([])
  })

  it('[2e] reports exact signatures, so a rename or a changed parameter type is visible', async () => {
    await db.exec(`CREATE FUNCTION settle_outbound_message_system(p_message_id uuid, p_status text, p_connection_ref uuid DEFAULT NULL) RETURNS void LANGUAGE sql AS $$ SELECT $$`)
    const r = find(await runInventory(), 'arguments_with_defaults').rows as Array<{ function_name: string; identity_arguments: string; arguments_with_defaults: string }>
    expect(r).toHaveLength(1)
    expect(r[0].identity_arguments).toBe('p_message_id uuid, p_status text, p_connection_ref uuid')
    expect(r[0].arguments_with_defaults).toContain('p_connection_ref uuid DEFAULT NULL')
  })
})

describe('01-inventory.sql — data statements', () => {
  it('reports the legacy footprint, never a secret', async () => {
    const res = await runInventory()
    const byProvider = find(res, 'GROUP BY provider, status').rows as Array<{ provider: string; status: string; config_rows: number; with_waba_id: number }>
    const zc = byProvider.find((x) => x.provider === 'zapi' && x.status === 'connected')!
    expect(Number(zc.config_rows)).toBe(2)
    expect(Number(zc.with_waba_id)).toBe(1)
    expect(find(res, 'provider NOT IN').rows.map((r) => r.provider as string).sort()).toEqual(['evolution', 'zapi'])
    expect(find(res, 'rows_with_waba_id').rows.find((r) => r.provider === 'uazapi')?.rows_with_waba_id).toBe(1)
    expect(find(res, "m.status = 'sending'").rows).toEqual([{ age_bucket: 'orphan candidate (5min..72h)', messages: 1 }])
    expect(find(res, "'webhook_dlq'").rows).toEqual([
      { source: 'ledger', status: 'pending', blocked: true, rows_: 1 },
      { source: 'webhook_dlq', status: 'pending', blocked: null, rows_: 1 },
    ])
    const everything = JSON.stringify(res.map((r) => r.rows))
    for (const secret of SECRETS) expect(everything).not.toContain(secret)
    const fields = res.flatMap((r) => r.fields)
    for (const forbidden of ['access_token', 'webhook_secret_hash', 'phone', 'content_text', 'payload']) expect(fields).not.toContain(forbidden)
  })

  it('[8] reference values carry no credential and are a sha256 hex digest', async () => {
    const ref = find(await runInventory(), 'AS non_zapi_fingerprint').rows[0] as Record<string, string | number>
    expect(String(ref.non_zapi_fingerprint)).toMatch(/^[0-9a-f]{64}$/)
    expect(Number(ref.zapi_rows)).toBe(4)
    expect(Number(ref.non_zapi_rows)).toBe(5)
  })

  it('the fingerprint does NOT change when only a credential value changes without the row being updated... and DOES change when the row is updated through the application trigger', async () => {
    const before = (find(await runInventory(), 'AS non_zapi_fingerprint').rows[0] as { non_zapi_fingerprint: string }).non_zapi_fingerprint
    await db.query('RESET default_transaction_read_only')
    await db.query(`UPDATE whatsapp_config SET status = 'disconnected' WHERE id = $1`, [ID.metaConn])
    const after = (find(await runInventory(), 'AS non_zapi_fingerprint').rows[0] as { non_zapi_fingerprint: string }).non_zapi_fingerprint
    expect(after).not.toBe(before)
  })
})

describe('02-decommission.sql — guards, scope, idempotence', () => {
  it('refuses without the backup confirmation and changes nothing', async () => {
    const before = await rows(`SELECT id, status, waba_id FROM whatsapp_config ORDER BY id`)
    await expect(db.exec(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${sql('02-decommission.sql')} COMMIT;`)).rejects.toThrow(/refused/)
    await db.exec('ROLLBACK')
    expect(await rows(`SELECT id, status, waba_id FROM whatsapp_config ORDER BY id`)).toEqual(before)
  })

  it('a confirmation other than the exact value is also refused', async () => {
    await expect(db.exec(`BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL zapi_decommission.backup_confirmed = 'true'; ${sql('02-decommission.sql')} COMMIT;`)).rejects.toThrow(/refused/)
    await db.exec('ROLLBACK')
  })

  it('refuses outside REPEATABLE READ (the snapshot would not be meaningful) and changes nothing', async () => {
    await expect(db.exec(`BEGIN; SET LOCAL zapi_decommission.backup_confirmed = 'yes'; ${sql('02-decommission.sql')} COMMIT;`)).rejects.toThrow(/REPEATABLE READ/)
    await db.exec('ROLLBACK')
    expect((await rows(`SELECT count(*)::int AS n FROM whatsapp_config WHERE provider='zapi' AND status='connected'`))[0].n).toBe(2)
  })

  it('with confirmation: only zapi rows change; every other row, credential and message/ledger/DLQ row is untouched', async () => {
    const others = {
      cfg: await rows(`SELECT * FROM whatsapp_config WHERE provider <> 'zapi' ORDER BY id`),
      zapiSecrets: await rows(`SELECT id, access_token, webhook_secret_hash, instance_id, connection_id FROM whatsapp_config WHERE provider='zapi' ORDER BY id`),
      messages: await rows(`SELECT * FROM messages ORDER BY id`),
      ledger: await rows(`SELECT * FROM outbound_retry_ledger ORDER BY id`),
      dlq: await rows(`SELECT * FROM whatsapp_webhook_dlq ORDER BY id`),
    }
    await db.exec(`${DECOMMISSION()} COMMIT;`)
    const zapi = await rows<{ status: string; waba_id: string | null }>(`SELECT status, waba_id FROM whatsapp_config WHERE provider='zapi'`)
    expect(zapi).toHaveLength(4)
    expect(zapi.every((z) => z.status === 'disconnected' && z.waba_id === null)).toBe(true)
    expect(await rows(`SELECT * FROM whatsapp_config WHERE provider <> 'zapi' ORDER BY id`)).toEqual(others.cfg)
    expect(await rows(`SELECT id, access_token, webhook_secret_hash, instance_id, connection_id FROM whatsapp_config WHERE provider='zapi' ORDER BY id`)).toEqual(others.zapiSecrets)
    expect(await rows(`SELECT * FROM messages ORDER BY id`)).toEqual(others.messages)
    expect(await rows(`SELECT * FROM outbound_retry_ledger ORDER BY id`)).toEqual(others.ledger)
    expect(await rows(`SELECT * FROM whatsapp_webhook_dlq ORDER BY id`)).toEqual(others.dlq)
    expect((await rows(`SELECT waba_id FROM whatsapp_config WHERE id = $1`, [ID.uazapiResidual]))[0].waba_id).toBe('enc:residual-cipher')
  })

  it('is idempotent: a second run changes nothing (not even updated_at)', async () => {
    await db.exec(`${DECOMMISSION()} COMMIT;`)
    const snap = await rows(`SELECT id, status, waba_id, updated_at FROM whatsapp_config ORDER BY id`)
    await db.exec(`${DECOMMISSION()} COMMIT;`)
    expect(await rows(`SELECT id, status, waba_id, updated_at FROM whatsapp_config ORDER BY id`)).toEqual(snap)
  })

  it('matches the provider literally: no case variants, no uazapi, no substring match', async () => {
    await db.query(`INSERT INTO whatsapp_config (account_id, provider, status, waba_id, access_token) VALUES (gen_random_uuid(),'ZAPI','connected','w1','t'), (gen_random_uuid(),'z-api','connected','w2','t')`)
    await db.exec(`${DECOMMISSION()} COMMIT;`)
    const left = await rows<{ status: string; waba_id: string | null }>(`SELECT status, waba_id FROM whatsapp_config WHERE provider IN ('ZAPI','z-api')`)
    expect(left).toHaveLength(2)
    expect(left.every((r) => r.status === 'connected' && r.waba_id !== null)).toBe(true)
  })
})

describe('03-verify.sql — D3 invariants (same transaction as 02)', () => {
  it('after a correct decommission every criterion is ok', async () => {
    const v = await decommissionAndVerify()
    expect(v.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(v.filter((c) => !c.ok)).toEqual([])
    expect(v.find((c) => c.n === 9)!.observed).toBe('1 / 1')
  })

  it('does not leak a credential in its output', async () => {
    const v = await decommissionAndVerify()
    for (const s of SECRETS) expect(JSON.stringify(v)).not.toContain(s)
  })

  it('is not a read-write script: it contains no write or DDL statement', () => {
    expect(codeWithoutCommentsOrLiterals('03-verify.sql')).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/i)
  })

  it.each([
    ['a non-zapi row changed by mistake', 6, `UPDATE whatsapp_config SET status = 'disconnected' WHERE id = '${ID.metaConn}';`],
    ['a zapi row deleted (its DLQ history cascades away)', 5, `DELETE FROM whatsapp_config WHERE id = '${ID.zapiClean}';`],
    ['a zapi row column other than status/waba_id changed', 7, `UPDATE whatsapp_config SET instance_id = 'moved' WHERE id = '${ID.zapiConn}';`],
    ['a message deleted', 8, `DELETE FROM outbound_retry_ledger; DELETE FROM messages;`],
    ['a DLQ row deleted', 9, `DELETE FROM whatsapp_webhook_dlq;`],
    ['a ledger row deleted', 9, `DELETE FROM outbound_retry_ledger;`],
  ])('detects: %s', async (_name, criterion, damage) => {
    const v = await decommissionAndVerify({ between: damage, end: 'ROLLBACK' })
    expect(v.find((c) => c.n === criterion)!.ok).toBe(false)
  })

  it('detects a stale inventory (state changed after 01 was read)', async () => {
    const ref = await referenceValues()
    await db.query(`INSERT INTO whatsapp_config (account_id, provider, status, access_token) VALUES (gen_random_uuid(), 'zapi', 'connected', 't')`)
    const v = await decommissionAndVerify({ ref, end: 'ROLLBACK' })
    expect(v.find((c) => c.n === 10)!.ok).toBe(false)
  })

  it('fails the reference criteria when no inventory reference is supplied', async () => {
    const r = await db.exec(`${DECOMMISSION()} ${sql('03-verify.sql')} ROLLBACK;`)
    const v = r.find((x) => x.fields.some((f) => f.name === 'criterion'))!.rows as Array<{ n: number; ok: boolean }>
    expect(v.filter((c) => !c.ok).map((c) => c.n)).toEqual([10, 11])
  })

  it('fails the snapshot criterion when run outside the transaction that took the snapshot', async () => {
    const r = await db.exec(`BEGIN ISOLATION LEVEL REPEATABLE READ; ${sql('03-verify.sql')} ROLLBACK;`)
    const v = r.find((x) => x.fields.some((f) => f.name === 'criterion'))!.rows as Array<{ n: number; ok: boolean }>
    expect(v.find((c) => c.n === 2)!.ok).toBe(false)
    expect(v.filter((c) => !c.ok).map((c) => c.n)).toEqual(expect.arrayContaining([2, 5, 6, 7, 8, 9]))
  })

  it('fails the isolation criterion under READ COMMITTED', async () => {
    const r = await db.exec(`BEGIN; ${sql('03-verify.sql')} ROLLBACK;`)
    const v = r.find((x) => x.fields.some((f) => f.name === 'criterion'))!.rows as Array<{ n: number; ok: boolean }>
    expect(v.find((c) => c.n === 1)!.ok).toBe(false)
  })
})
