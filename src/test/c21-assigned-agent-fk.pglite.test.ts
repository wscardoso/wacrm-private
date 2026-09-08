import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Gate C21 — conversations.assigned_agent_id sem FK.
//
// Prova, contra Postgres real (PGlite), que a migration 075 REAL
// (carregada verbatim) adiciona integridade referencial pura:
//   - órfãos pré-existentes são neutralizados (assigned_agent_id → NULL)
//   - a FK conversations.assigned_agent_id → profiles(user_id) existe
//   - escrita com agent válido passa, com agente inexistente é rejeitada
//   - ON DELETE SET NULL preserva a conversa quando o agente é apagado
//
// Confirma também a premissa de auditoria: a RLS de conversations
// (017_account_sharing.sql:414-417) é baseada em is_account_member —
// a FK não toca tenant isolation, é só referencial.

let db: PGlite

const FOUNDATION = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'x'
);

-- Forma real de profiles (colunas relevantes; 001 + 017).
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT 'x',
  email TEXT NOT NULL DEFAULT 'x',
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE
);

-- Forma real da coluna-alvo (001_initial_schema.sql:145), sem FK.
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID,
  user_id UUID,
  assigned_agent_id UUID,
  status TEXT NOT NULL DEFAULT 'open'
);
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

// Estado pré-migration: um órfão (assigned_agent_id apontando para um
// user_id que não existe em profiles) e uma atribuição válida. Os dois
// precisam existir ANTES da migration 075 rodar para provar o
// neutralização defensiva de órfãos sobre dados reais.
const PRE_MIGRATION_DIRTY = `
INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO profiles (user_id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'a@x.com');

INSERT INTO conversations (id, account_id, assigned_agent_id) VALUES (
  '11111111-1111-1111-1111-111111111111', NULL, '99999999-9999-9999-9999-999999999999');
INSERT INTO conversations (id, account_id, assigned_agent_id) VALUES (
  '22222222-2222-2222-2222-222222222222', NULL, '00000000-0000-0000-0000-000000000001');
`

beforeAll(async () => {
  db = new PGlite()
  await db.exec(FOUNDATION)
  await db.exec(PRE_MIGRATION_DIRTY)
  await db.exec(loadMigration('075_conversations_assigned_agent_fk.sql'))
})

describe('075_conversations_assigned_agent_fk', () => {
  it('neutraliza órfãos pré-existentes antes de criar a FK', async () => {
    const rows = await run<{ id: string; assigned_agent_id: string | null }>(
      `SELECT id, assigned_agent_id FROM conversations WHERE id = ANY($1::uuid[])`,
      [['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']],
    )
    const orphan = rows.find((r) => r.id === '11111111-1111-1111-1111-111111111111')
    const valid = rows.find((r) => r.id === '22222222-2222-2222-2222-222222222222')
    expect(orphan?.assigned_agent_id).toBeNull()
    expect(valid?.assigned_agent_id).toBe('00000000-0000-0000-0000-000000000001')
  })

  it('a FK existe e aponta para profiles(user_id)', async () => {
    const rows = await run<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname = 'conversations_assigned_agent_id_fkey'
         AND conrelid = 'conversations'::regclass`,
    )
    expect(rows).toHaveLength(1)
  })

  it('escrita com agente válido passa; com agente inexistente é rejeitada', async () => {
    // Válido
    const ok = await run(
      `UPDATE conversations SET assigned_agent_id = '00000000-0000-0000-0000-000000000001'
       WHERE id = '11111111-1111-1111-1111-111111111111'`,
    )
    expect(ok).toBeDefined()

    // Inexistente — a FK deve rejeitar.
    await expect(
      run(
        `UPDATE conversations SET assigned_agent_id = '88888888-8888-8888-8888-888888888888'
         WHERE id = '11111111-1111-1111-1111-111111111111'`,
      ),
    ).rejects.toThrow()
  })

  it('ON DELETE SET NULL preserva a conversa quando o agente é removido', async () => {
    await run(`DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001'`)
    const rows = await run<{ assigned_agent_id: string | null }>(
      `SELECT assigned_agent_id FROM conversations WHERE id = '22222222-2222-2222-2222-222222222222'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].assigned_agent_id).toBeNull()
  })
})
