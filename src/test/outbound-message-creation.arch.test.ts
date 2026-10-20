import { describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'

// =============================================================
// DLB-001 §3 / ODI-001 §4 — the creation of an OUTBOUND message has exactly
// one owner: `createIntent` (src/lib/whatsapp/delivery/settlement.ts). It is
// the only place that writes the delivery binding (connection_ref,
// delivery_provider, delivery_channel_fp) in the same INSERT as the message,
// and a retry refuses any message that lacks it. A second creator would
// produce messages that can never be retried — or, worse, bypass the binding
// rules.
//
// This test fails when another module inserts into `messages`.
//
// Inbound messages are persisted by the SQL function `insert_inbound_message`
// (called through `.rpc(...)`, not through a table insert), which is why no
// TypeScript file is expected to insert customer messages directly.
// =============================================================

const SRC = join(__dirname, '..')

/** Files allowed to INSERT into `messages`, with the reason. Keep it at one entry. */
const ALLOWED: Record<string, string> = {
  'lib/whatsapp/delivery/settlement.ts': 'createIntent — the single owner of outbound message creation',
}

/** Removes comments so a mention in documentation is not mistaken for code. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

const INSERT_INTO_MESSAGES = /\.from\(\s*(['"`])messages\1\s*\)\s*\.(?:insert|upsert)\s*\(/g
/** Same thing through an intermediate variable: `const t = db.from('messages'); t.insert(`. */
const MESSAGES_HANDLE = /=\s*[\w.$]+\s*\.from\(\s*(['"`])messages\1\s*\)\s*;?\s*$/gm

export function findMessageInserts(code: string): number {
  const clean = stripComments(code)
  return (clean.match(INSERT_INTO_MESSAGES) ?? []).length + (clean.match(MESSAGES_HANDLE) ?? []).length
}

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      await sourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|arch\.test|pglite\.test)\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('the scanner itself (positive and negative controls)', () => {
  it('detects direct inserts in the forms used by the codebase', () => {
    expect(findMessageInserts(`await db.from('messages').insert({ a: 1 })`)).toBe(1)
    expect(findMessageInserts(`await db\n    .from("messages")\n    .insert({ a: 1 })`)).toBe(1)
    expect(findMessageInserts("await supabase.from(`messages`).upsert(rows)")).toBe(1)
    expect(findMessageInserts(`const t = admin.from('messages')\nt.insert({})`)).toBeGreaterThanOrEqual(1)
  })

  it('ignores reads, updates, other tables and comments', () => {
    expect(findMessageInserts(`await db.from('messages').select('id')`)).toBe(0)
    expect(findMessageInserts(`await db.from('messages').update({ status: 'x' })`)).toBe(0)
    expect(findMessageInserts(`await db.from('message_external_ids').insert({})`)).toBe(0)
    expect(findMessageInserts(`// db.from('messages').insert({})\n/* db.from('messages').insert({}) */`)).toBe(0)
    expect(findMessageInserts(`await db.rpc('insert_inbound_message', {})`)).toBe(0)
  })
})

describe('DLB-001 §3: outbound message creation has one owner', () => {
  it('only the allow-listed module inserts into messages', async () => {
    const offenders: string[] = []
    const seen: Record<string, number> = {}
    for (const file of await sourceFiles(SRC)) {
      const n = findMessageInserts(await fs.readFile(file, 'utf8'))
      if (n === 0) continue
      const rel = relative(SRC, file).split(sep).join('/')
      seen[rel] = n
      if (!(rel in ALLOWED)) offenders.push(`${rel} (${n})`)
    }
    expect(offenders).toEqual([])
    // the allow-list is not decorative: the owner really contains the one insert
    expect(seen).toEqual({ 'lib/whatsapp/delivery/settlement.ts': 1 })
  })

  it('every outbound creation site goes through createIntent', async () => {
    const sites = [
      'app/api/whatsapp/send/route.ts',
      'lib/flows/meta-send.ts',
      'lib/automations/meta-send.ts',
    ]
    for (const rel of sites) {
      const code = stripComments(await fs.readFile(join(SRC, rel), 'utf8'))
      expect(code, rel).toMatch(/createIntent\(/)
    }
  })

  it('createIntent persists the whole delivery binding in its single INSERT', async () => {
    const code = stripComments(await fs.readFile(join(SRC, 'lib/whatsapp/delivery/settlement.ts'), 'utf8'))
    const insert = code.slice(code.indexOf(".from('messages')"), code.indexOf('.select(', code.indexOf(".from('messages')")))
    for (const field of ['connection_ref', 'delivery_provider', 'delivery_channel_fp', 'idempotency_key', "status: 'sending'"]) {
      expect(insert, field).toContain(field)
    }
  })
})
