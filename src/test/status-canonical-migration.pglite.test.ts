import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Gate 2 — E2.1 Activation. Smoke test que aplica a migration REAL 063
// (verbatim) contra Postgres real (PGlite) e prova:
//   - reexecutável (DROP CONSTRAINT IF EXISTS antes do ADD);
//   - aditiva — os cinco valores pré-existentes continuam válidos;
//   - os dois novos valores canônicos ('pending', 'received') passam a
//     ser aceitos (ADR-MSG-STATUS-001 D2, espelhado em src/lib/message/status.ts);
//   - qualquer outro valor continua rejeitado pelo CHECK.
//
// A aplicação em produção (Supabase) é um passo operacional fora do
// escopo deste repositório de código — este teste é a evidência de que
// a migration, tal como está no working tree, aplica sem erro sobre o
// schema real de `messages` e produz exatamente o vocabulário canônico.

let db: PGlite

const MINIMAL = `
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed'))
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

beforeAll(async () => {
  db = new PGlite()
  await db.exec(MINIMAL)
  await db.exec(loadMigration('063_messages_status_canonical.sql'))
})

describe('063 — CHECK canônico de messages.status', () => {
  it('reexecutável — aplicar novamente não falha', async () => {
    await expect(db.exec(loadMigration('063_messages_status_canonical.sql'))).resolves.not.toThrow()
  })

  it('aditiva — os cinco valores pré-existentes continuam válidos', async () => {
    for (const status of ['sending', 'sent', 'delivered', 'read', 'failed']) {
      await expect(
        run(`INSERT INTO messages (status) VALUES ($1)`, [status]),
      ).resolves.toBeDefined()
    }
  })

  it("aceita 'pending' (novo estado canônico)", async () => {
    await expect(run(`INSERT INTO messages (status) VALUES ('pending')`)).resolves.toBeDefined()
  })

  it("aceita 'received' (novo estado canônico, entrada)", async () => {
    await expect(run(`INSERT INTO messages (status) VALUES ('received')`)).resolves.toBeDefined()
  })

  it('rejeita valor fora do vocabulário canônico de sete estados', async () => {
    await expect(run(`INSERT INTO messages (status) VALUES ('replied')`)).rejects.toThrow()
    await expect(run(`INSERT INTO messages (status) VALUES ('bogus')`)).rejects.toThrow()
  })
})
