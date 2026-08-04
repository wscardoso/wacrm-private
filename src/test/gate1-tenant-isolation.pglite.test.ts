import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Gate 1 — Segurança Multi-Tenant.
//
// Prova, contra Postgres real (PGlite), que a migration 073 REAL
// (carregada verbatim) fecha os três bloqueios:
//   1. insert_message_external_ids() rejeita message_id de outra conta.
//   2/3/4. whatsapp_webhook_dlq / identity_merge_provenance /
//      identity_merge_backfill_checkpoint só retornam linhas da própria
//      conta sob RLS.
//
// O schema-base recria a FORMA real dessas tabelas (colunas relevantes)
// e a versão PRÉ-Gate-1 de insert_message_external_ids() (idêntica ao
// corpo original de 047, sem validação) — para que o teste também prove
// que, sem a 073, o ataque funcionava.

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

CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'x'
);

CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum
);

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
  );
$$;

-- Stub fiel ao contrato de 037 (composição sobre is_account_member); a
-- via de platform operator não é exercitada neste gate.
CREATE OR REPLACE FUNCTION can_access_account(target_account_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_account_member(target_account_id);
$$;
`

// Forma real das tabelas tocadas (colunas relevantes ao gate) + a versão
// PRÉ-Gate-1 de insert_message_external_ids (corpo original de 047,
// sem checagem de tenant) — 073 faz CREATE OR REPLACE sobre ela.
const BASE = `
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE message_external_ids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  connection_ref UUID NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_meid_connection_kind_value ON message_external_ids (connection_ref, kind, value);

CREATE OR REPLACE FUNCTION insert_message_external_ids(p_identities JSONB)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO message_external_ids (message_id, connection_ref, kind, value)
  SELECT (item->>'message_id')::UUID, (item->>'connection_ref')::UUID, item->>'kind', item->>'value'
  FROM jsonb_array_elements(p_identities) AS item;
END; $$;
REVOKE ALL ON FUNCTION insert_message_external_ids(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_message_external_ids(JSONB) TO authenticated;

CREATE TABLE whatsapp_webhook_dlq (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE OR REPLACE FUNCTION enqueue_webhook_dlq(p_account_id UUID, p_payload JSONB)
RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO whatsapp_webhook_dlq (account_id, payload) VALUES (p_account_id, p_payload) RETURNING id;
$$;

CREATE TABLE identity_merge_provenance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  survivor_contact_id UUID NOT NULL,
  loser_contact_id UUID NOT NULL,
  loser_phone_raw TEXT NOT NULL,
  phone_identity TEXT NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  merge_run_id UUID NOT NULL
);

CREATE TABLE identity_merge_backfill_checkpoint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_identity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (account_id, phone_identity)
);

-- Espelha o grant padrão do Supabase (privilégios de tabela amplos;
-- RLS é a camada de enforcement) — sem isto o teste "ANTES" não
-- reproduziria fielmente por que a ausência de RLS era exploravel.
GRANT SELECT ON whatsapp_webhook_dlq, identity_merge_provenance, identity_merge_backfill_checkpoint TO authenticated;
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

async function asUser(userId: string | null, fn: () => Promise<void>) {
  await run(`SET ROLE authenticated`)
  await run(`SELECT set_config('app.current_user', $1, false)`, [userId ?? ''])
  try {
    await fn()
  } finally {
    await run(`SELECT set_config('app.current_user', NULL, false)`)
    await run(`RESET ROLE`)
  }
}

const U = {
  memberA: '10000000-0000-0000-0000-000000000001',
  memberB: '10000000-0000-0000-0000-000000000002',
}
const ACC = {
  a: '20000000-0000-0000-0000-000000000001',
  b: '20000000-0000-0000-0000-000000000002',
}

let convA: string, convB: string, msgA: string, msgB: string

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await db.exec(BASE)

  await run(`INSERT INTO accounts (id) VALUES ($1), ($2)`, [ACC.a, ACC.b])
  await run(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [U.memberA, U.memberB])
  await run(
    `INSERT INTO profiles (user_id, account_id, account_role) VALUES ($1, $2, 'agent'), ($3, $4, 'agent')`,
    [U.memberA, ACC.a, U.memberB, ACC.b],
  )

  const c1 = await run<{ id: string }>(`INSERT INTO conversations (account_id) VALUES ($1) RETURNING id`, [ACC.a])
  const c2 = await run<{ id: string }>(`INSERT INTO conversations (account_id) VALUES ($1) RETURNING id`, [ACC.b])
  convA = c1[0].id
  convB = c2[0].id
  const m1 = await run<{ id: string }>(`INSERT INTO messages (conversation_id) VALUES ($1) RETURNING id`, [convA])
  const m2 = await run<{ id: string }>(`INSERT INTO messages (conversation_id) VALUES ($1) RETURNING id`, [convB])
  msgA = m1[0].id
  msgB = m2[0].id

  await run(`INSERT INTO whatsapp_webhook_dlq (account_id, payload) VALUES ($1, '{}'), ($2, '{}')`, [ACC.a, ACC.b])
  await run(
    `INSERT INTO identity_merge_provenance (account_id, survivor_contact_id, loser_contact_id, loser_phone_raw, phone_identity, merge_run_id)
     VALUES ($1, gen_random_uuid(), gen_random_uuid(), '5511900000000', '5511900000000', gen_random_uuid()),
            ($2, gen_random_uuid(), gen_random_uuid(), '5521900000000', '5521900000000', gen_random_uuid())`,
    [ACC.a, ACC.b],
  )
  await run(
    `INSERT INTO identity_merge_backfill_checkpoint (account_id, phone_identity) VALUES ($1, '5511900000000'), ($2, '5521900000000')`,
    [ACC.a, ACC.b],
  )
})

async function asUserSelect<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  let result: T[] = []
  await asUser(userId, async () => {
    result = await run<T>(sql, params)
  })
  return result
}

describe('ANTES da 073 — prova de que o ataque funcionava', () => {
  it('authenticated de A anexa external id a mensagem de B (sem validação de tenant)', async () => {
    await asUser(U.memberA, async () => {
      await run(`SELECT insert_message_external_ids($1::jsonb)`, [
        JSON.stringify([{ message_id: msgB, connection_ref: ACC.b, kind: 'wamid', value: 'PRE-GATE-ATTACK' }]),
      ])
    })
    const rows = await run(`SELECT * FROM message_external_ids WHERE value = 'PRE-GATE-ATTACK'`)
    expect(rows).toHaveLength(1) // confirma o estado vulnerável antes da correção
    await run(`DELETE FROM message_external_ids WHERE value = 'PRE-GATE-ATTACK'`)
  })

  it('sem RLS, authenticated de A lê a DLQ inteira, inclusive linha de B', async () => {
    const before = await asUserSelect(U.memberA, `SELECT count(*)::int AS c FROM whatsapp_webhook_dlq`)
    expect(before[0].c).toBe(2) // as duas contas, sem isolamento
  })
})

describe('DEPOIS da 073', () => {
  // Aplica a migration 073 REAL sobre o schema pré-Gate-1 acima — só
  // depois que os testes "ANTES" (bloco anterior) já rodaram — exatamente
  // como ela roda em produção sobre as tabelas já existentes.
  beforeAll(async () => {
    await db.exec(loadMigration('073_tenant_isolation_hardening.sql'))
  })

describe('RLS de leitura por tenant', () => {
  it('whatsapp_webhook_dlq: authenticated de A só vê a linha de A', async () => {
    const rows = await asUserSelect<{ account_id: string }>(U.memberA, `SELECT account_id FROM whatsapp_webhook_dlq`)
    expect(rows).toEqual([{ account_id: ACC.a }])
  })
  it('whatsapp_webhook_dlq: authenticated de B só vê a linha de B', async () => {
    const rows = await asUserSelect<{ account_id: string }>(U.memberB, `SELECT account_id FROM whatsapp_webhook_dlq`)
    expect(rows).toEqual([{ account_id: ACC.b }])
  })
  it('identity_merge_provenance: authenticated de A só vê a linha de A', async () => {
    const rows = await asUserSelect<{ account_id: string }>(U.memberA, `SELECT account_id FROM identity_merge_provenance`)
    expect(rows).toEqual([{ account_id: ACC.a }])
  })
  it('identity_merge_backfill_checkpoint: authenticated de A só vê a linha de A', async () => {
    const rows = await asUserSelect<{ account_id: string }>(U.memberA, `SELECT account_id FROM identity_merge_backfill_checkpoint`)
    expect(rows).toEqual([{ account_id: ACC.a }])
  })
  it('sem SET ROLE (sessão privilegiada / service_role-like), RLS não filtra — vê as duas contas', async () => {
    const rows = await run<{ account_id: string }>(`SELECT account_id FROM whatsapp_webhook_dlq ORDER BY account_id`)
    expect(rows.map((r) => r.account_id).sort()).toEqual([ACC.a, ACC.b].sort())
  })
})

describe('insert_message_external_ids valida tenant', () => {
  it('BLOQUEIA: authenticated de A não anexa external id a mensagem de B', async () => {
    await expect(
      asUser(U.memberA, async () => {
        await run(`SELECT insert_message_external_ids($1::jsonb)`, [
          JSON.stringify([{ message_id: msgB, connection_ref: ACC.b, kind: 'wamid', value: 'POST-GATE-ATTACK' }]),
        ])
      }),
    ).rejects.toThrow(/not authorized for account/)

    const rows = await run(`SELECT * FROM message_external_ids WHERE value = 'POST-GATE-ATTACK'`)
    expect(rows).toHaveLength(0) // nada foi escrito — lote inteiro rejeitado
  })

  it('PERMITE: authenticated de A anexa external id à própria mensagem', async () => {
    await asUser(U.memberA, async () => {
      await run(`SELECT insert_message_external_ids($1::jsonb)`, [
        JSON.stringify([{ message_id: msgA, connection_ref: ACC.a, kind: 'wamid', value: 'OWN-TENANT-OK' }]),
      ])
    })
    const rows = await run<{ message_id: string }>(`SELECT message_id FROM message_external_ids WHERE value = 'OWN-TENANT-OK'`)
    expect(rows).toEqual([{ message_id: msgA }])
  })

  it('PERMITE: authenticated de B anexa external id à própria mensagem (reciprocidade)', async () => {
    await asUser(U.memberB, async () => {
      await run(`SELECT insert_message_external_ids($1::jsonb)`, [
        JSON.stringify([{ message_id: msgB, connection_ref: ACC.b, kind: 'wamid', value: 'OWN-TENANT-OK-B' }]),
      ])
    })
    const rows = await run<{ message_id: string }>(`SELECT message_id FROM message_external_ids WHERE value = 'OWN-TENANT-OK-B'`)
    expect(rows).toEqual([{ message_id: msgB }])
  })
})

describe('caminhos privilegiados (service_role-like) continuam funcionando', () => {
  it('enqueue_webhook_dlq (SECURITY DEFINER, sem checagem de auth.uid) continua escrevendo em qualquer conta', async () => {
    const r = await run<{ enqueue_webhook_dlq: string }>(
      `SELECT enqueue_webhook_dlq($1, '{"probe":true}'::jsonb) AS enqueue_webhook_dlq`,
      [ACC.b],
    )
    expect(r[0].enqueue_webhook_dlq).toBeTruthy()
    const check = await run(`SELECT id FROM whatsapp_webhook_dlq WHERE id = $1`, [r[0].enqueue_webhook_dlq])
    expect(check).toHaveLength(1)
  })

  it('sessão privilegiada continua lendo identity_merge_provenance de qualquer conta', async () => {
    const rows = await run<{ account_id: string }>(`SELECT account_id FROM identity_merge_provenance ORDER BY account_id`)
    expect(rows.map((r) => r.account_id).sort()).toEqual([ACC.a, ACC.b].sort())
  })

  it('sessão privilegiada continua lendo identity_merge_backfill_checkpoint de qualquer conta', async () => {
    const rows = await run<{ account_id: string }>(`SELECT account_id FROM identity_merge_backfill_checkpoint ORDER BY account_id`)
    expect(rows.map((r) => r.account_id).sort()).toEqual([ACC.a, ACC.b].sort())
  })
})
}) // fecha 'DEPOIS da 073'
