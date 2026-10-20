import { beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createIntent, settleMessageSystem } from '@/lib/whatsapp/delivery/settlement'
import { evaluateBinding } from '@/lib/whatsapp/delivery/connection-binding'

// =============================================================
// Real PostgreSQL (PGlite) for the three database-facing pieces of the
// delivery-binding work:
//   1. migration 083 (additive, idempotent, refuses to adopt a column of the
//      wrong type);
//   2. `createIntent` — the real function — inserting into the migrated
//      schema, and the stored binding verifying against the config row;
//   3. the TTL settlement: `settle_outbound_message_system` with a NULL
//      connection (the old '' is rejected by PostgreSQL), through the real
//      `settleMessageSystem` wrapper.
// The Supabase client is a thin adapter that runs real SQL; nothing here
// touches a remote database.
// =============================================================

const BASE_SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE TABLE profiles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, account_id UUID NOT NULL);
CREATE TABLE conversations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL);
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','agent','bot')),
  content_type TEXT,
  content_text TEXT,
  media_url TEXT,
  template_name TEXT,
  message_id TEXT,
  status TEXT,
  idempotency_key UUID,
  reply_to_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE message_external_ids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  connection_ref UUID NOT NULL, kind TEXT, value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
CREATE OR REPLACE FUNCTION is_account_member(p_account_id UUID) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT FALSE $$;
CREATE OR REPLACE FUNCTION can_access_account(p_account_id UUID) RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT FALSE $$;
`

const migration = (name: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8')

let db: PGlite

async function freshDb(opts: { migrate083?: boolean } = { migrate083: true }) {
  db = new PGlite()
  await db.exec(BASE_SCHEMA)
  await db.exec(migration('048_outbound_delivery_integrity.sql'))
  await db.exec(migration('049_outbound_retry_ledger.sql'))
  await db.exec(migration('050_background_system_authorization.sql'))
  if (opts.migrate083) await db.exec(migration('083_messages_delivery_binding.sql'))
}

const ACCOUNT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
async function conversation(): Promise<string> {
  return ((await db.query<{ id: string }>(`INSERT INTO conversations (account_id) VALUES ($1) RETURNING id`, [ACCOUNT])).rows[0]).id
}

const cols = async () =>
  (await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema='public' AND table_name='messages' AND column_name IN ('connection_ref','delivery_provider','delivery_channel_fp')
     ORDER BY column_name`)).rows

describe('migration 083', () => {
  beforeEach(() => freshDb({ migrate083: false }))

  it('adds the three columns: nullable, no default', async () => {
    expect(await cols()).toEqual([])
    await db.exec(migration('083_messages_delivery_binding.sql'))
    expect(await cols()).toEqual([
      { column_name: 'connection_ref', data_type: 'uuid', is_nullable: 'YES', column_default: null },
      { column_name: 'delivery_channel_fp', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'delivery_provider', data_type: 'text', is_nullable: 'YES', column_default: null },
    ])
  })

  it('adds no foreign key, no index and no CHECK on the new columns', async () => {
    await db.exec(migration('083_messages_delivery_binding.sql'))
    const fks = await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.messages'::regclass AND contype IN ('f','c','u') AND conname ILIKE '%connection_ref%' OR conname ILIKE '%delivery_%'`)
    expect(fks.rows).toEqual([])
    const refFk = await db.query(`SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY (c.conkey)
                                  WHERE c.conrelid='public.messages'::regclass AND a.attname IN ('connection_ref','delivery_provider','delivery_channel_fp')`)
    expect(refFk.rows).toEqual([])
    const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='messages' AND (indexdef ILIKE '%connection_ref%' OR indexdef ILIKE '%delivery_%')`)
    expect(idx.rows).toEqual([])
  })

  it('is idempotent and never rewrites data', async () => {
    const conv = await conversation()
    await db.exec(migration('083_messages_delivery_binding.sql'))
    await db.query(`INSERT INTO messages (conversation_id, sender_type, status, connection_ref, delivery_provider, delivery_channel_fp)
                    VALUES ($1,'agent','sending', gen_random_uuid(), 'meta', 'v1:' || repeat('a',64))`, [conv])
    const before = (await db.query(`SELECT * FROM messages`)).rows
    await db.exec(migration('083_messages_delivery_binding.sql'))
    await db.exec(migration('083_messages_delivery_binding.sql'))
    expect((await db.query(`SELECT * FROM messages`)).rows).toEqual(before)
  })

  it('does not backfill: rows that existed before it stay NULL', async () => {
    const conv = await conversation()
    await db.query(`INSERT INTO messages (conversation_id, sender_type, status) VALUES ($1,'agent','sending')`, [conv])
    await db.exec(migration('083_messages_delivery_binding.sql'))
    expect((await db.query(`SELECT connection_ref, delivery_provider, delivery_channel_fp FROM messages`)).rows)
      .toEqual([{ connection_ref: null, delivery_provider: null, delivery_channel_fp: null }])
  })

  it('adopts a pre-existing UUID connection_ref (created out of band) without touching its data', async () => {
    const conv = await conversation()
    await db.exec(`ALTER TABLE messages ADD COLUMN connection_ref UUID`)
    await db.query(`INSERT INTO messages (conversation_id, sender_type, status, connection_ref) VALUES ($1,'agent','sending','11111111-1111-4111-8111-111111111111')`, [conv])
    await db.exec(migration('083_messages_delivery_binding.sql'))
    expect((await db.query(`SELECT connection_ref FROM messages`)).rows).toEqual([{ connection_ref: '11111111-1111-4111-8111-111111111111' }])
    expect((await cols()).map((c) => c.column_name)).toEqual(['connection_ref', 'delivery_channel_fp', 'delivery_provider'])
  })

  it.each([
    ['connection_ref of type text', `ALTER TABLE messages ADD COLUMN connection_ref TEXT`, /connection_ref already exists with type text \(expected uuid\)/],
    ['delivery_provider of type uuid', `ALTER TABLE messages ADD COLUMN delivery_provider UUID`, /delivery_provider already exists with type uuid \(expected text\)/],
  ])('REFUSES a pre-existing %s and changes nothing else', async (_n, ddl, message) => {
    await db.exec(ddl)
    await expect(db.exec(migration('083_messages_delivery_binding.sql'))).rejects.toThrow(message)
    const present = (await cols()).map((c) => c.column_name)
    expect(present).toHaveLength(1) // only the pre-existing one; the other two were NOT added
  })
})

/** A thin Supabase-shaped adapter that executes real SQL on PGlite. */
function adapter(): SupabaseClient {
  return {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          const keys = Object.keys(row)
          const run = async () => {
            const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`
            try {
              const r = await db.query<{ id: string }>(sql, keys.map((k) => row[k]))
              return { data: r.rows[0], error: null }
            } catch (e) {
              return { data: null, error: e }
            }
          }
          return { select: () => ({ single: run }) }
        },
      }
    },
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        const r = await db.query<{ r: unknown }>(
          `SELECT ${name}(p_message_id := $1::uuid, p_status := $2, p_connection_ref := $3::uuid, p_provider_message_id := $4, p_identities := $5::jsonb) AS r`,
          [args.p_message_id, args.p_status, args.p_connection_ref, args.p_provider_message_id, JSON.stringify(args.p_identities)],
        )
        return { data: r.rows[0].r, error: null }
      } catch (e) {
        return { data: null, error: e }
      }
    },
  } as unknown as SupabaseClient
}

const CFG = { id: '00000000-0000-4000-8000-0000000000c1', account_id: ACCOUNT, provider: 'meta', phone_number_id: '123456789', instance_id: null, base_url: null }
const UAZ = { id: '00000000-0000-4000-8000-0000000000c1', account_id: ACCOUNT, provider: 'uazapi', phone_number_id: 'inst', instance_id: 'inst', base_url: 'https://my.uazapi.dev' }

describe('createIntent against the migrated schema', () => {
  beforeEach(() => freshDb())

  it.each([
    ['agent', CFG, 'meta'],
    ['bot', UAZ, 'uazapi'],
  ])('persists the whole binding in the single INSERT (%s via %s) and the stored binding verifies against the config', async (senderType, cfg, provider) => {
    const conv = await conversation()
    const messageId = crypto.randomUUID()
    await createIntent(adapter(), {
      messageId, conversationId: conv, contentType: 'text', contentText: 'hello',
      connection: cfg, senderType: senderType as 'agent' | 'bot',
    })

    const row = (await db.query<Record<string, string>>(`SELECT * FROM messages WHERE id = $1`, [messageId])).rows[0]
    expect(row).toMatchObject({
      sender_type: senderType, status: 'sending', idempotency_key: messageId,
      connection_ref: cfg.id, delivery_provider: provider,
    })
    expect(row.delivery_channel_fp).toMatch(/^v1:[0-9a-f]{64}$/)

    const verdict = evaluateBinding({
      stored: { connection_ref: row.connection_ref, delivery_provider: row.delivery_provider, delivery_channel_fp: row.delivery_channel_fp },
      conversationAccountId: ACCOUNT,
      connection: cfg,
    })
    expect(verdict).toEqual({ ok: true, provider })
    // and the same row, after the account moved to another number, is refused
    expect(evaluateBinding({
      stored: { connection_ref: row.connection_ref, delivery_provider: row.delivery_provider, delivery_channel_fp: row.delivery_channel_fp },
      conversationAccountId: ACCOUNT,
      connection: { ...cfg, phone_number_id: '999', instance_id: cfg.instance_id ? 'other' : null },
    })).toMatchObject({ ok: false, reason: 'channel_changed' })
  })

  it('a database lacking migration 083 rejects the insert (code must be released AFTER the migration)', async () => {
    await freshDb({ migrate083: false })
    const conv = await conversation()
    await expect(createIntent(adapter(), { messageId: crypto.randomUUID(), conversationId: conv, contentType: 'text', connection: CFG }))
      .rejects.toMatchObject({ message: expect.stringMatching(/column "connection_ref" of relation "messages" does not exist/) })
  })

  it('refuses before inserting when the connection cannot identify a channel', async () => {
    const conv = await conversation()
    await expect(createIntent(adapter(), { messageId: crypto.randomUUID(), conversationId: conv, contentType: 'text', connection: { ...CFG, phone_number_id: null } }))
      .rejects.toThrow(/phone_number_id/)
    expect((await db.query(`SELECT count(*)::int AS n FROM messages`)).rows[0]).toEqual({ n: 0 })
  })
})

describe('TTL settlement — settle_outbound_message_system with a NULL connection', () => {
  beforeEach(() => freshDb())

  async function sendingMessage() {
    const conv = await conversation()
    const id = crypto.randomUUID()
    await createIntent(adapter(), { messageId: id, conversationId: conv, contentType: 'text', connection: CFG, senderType: 'bot' })
    return id
  }
  const status = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM messages WHERE id = $1`, [id])).rows[0].status

  it('PostgreSQL rejects \'\' for the UUID parameter — the defect the TTL sweep had', async () => {
    const id = await sendingMessage()
    await expect(db.query(`SELECT settle_outbound_message_system(p_message_id := $1::uuid, p_status := 'failed', p_connection_ref := $2::uuid)`, [id, '']))
      .rejects.toThrow(/invalid input syntax for type uuid/)
    expect(await status(id)).toBe('sending')
  })

  it('the real wrapper settles a `sending` message `failed` with NULL and the database confirms it', async () => {
    const id = await sendingMessage()
    const result = await settleMessageSystem(adapter(), id, 'failed', null, [])
    expect(result).toMatchObject({ messageId: id, outcome: 'failed' })
    expect(await status(id)).toBe('failed')
  })

  it('settling again is a noop (compare-and-set), and a sent message is never turned into failed', async () => {
    const id = await sendingMessage()
    await settleMessageSystem(adapter(), id, 'sent', CFG.id, [], 'wamid.1')
    expect(await settleMessageSystem(adapter(), id, 'failed', null, [])).toMatchObject({ outcome: 'noop' })
    expect(await status(id)).toBe('sent')
  })

  it('two concurrent TTL settlements: exactly one wins', async () => {
    const id = await sendingMessage()
    const [a, b] = await Promise.all([settleMessageSystem(adapter(), id, 'failed', null, []), settleMessageSystem(adapter(), id, 'failed', null, [])])
    expect([a.outcome, b.outcome].sort()).toEqual(['failed', 'noop'])
  })

  it('the wrapper refuses identities without a connection instead of sending a bad parameter', async () => {
    const id = await sendingMessage()
    await expect(settleMessageSystem(adapter(), id, 'sent', null, [{ kind: 'wamid', value: 'x' }], 'wamid.1'))
      .rejects.toThrow(/identities require a connectionRef/)
    expect(await status(id)).toBe('sending')
  })

  it('a settlement for a message that does not exist raises: the sweep must not call it resolved', async () => {
    await expect(settleMessageSystem(adapter(), crypto.randomUUID(), 'failed', null, [])).rejects.toBeTruthy()
  })
})
