import type { SupabaseClient } from '@supabase/supabase-js'
import type { PGlite } from '@electric-sql/pglite'

/** Minimal Supabase-shaped client for PGlite integration tests. */
export function pgliteSupabase(db: PGlite): SupabaseClient {
  return {
    async rpc(name: string, args: Record<string, unknown> = {}) {
      try {
        if (name === 'suspend_conversational_agent_after_handoff') {
          await db.query(`SELECT suspend_conversational_agent_after_handoff($1::uuid)`, [
            args.p_conversation_id,
          ])
          return { data: true, error: null }
        }
        if (name === 'resume_conversational_agent') {
          await db.query(`SELECT resume_conversational_agent($1::uuid)`, [args.p_conversation_id])
          return { data: true, error: null }
        }
        throw new Error(`unsupported rpc in pglite adapter: ${name}`)
      } catch (e) {
        return { data: null, error: e }
      }
    },
    from(table: string) {
      const filters: { col: string; val: unknown }[] = []
      let limitN: number | null = null
      let op: 'select' | 'insert' | 'update' = 'select'
      const insertRow: Record<string, unknown> | null = null
      let updateRow: Record<string, unknown> | null = null

      const runSelect = async () => {
        const where = filters.map((f, i) => `${f.col} = $${i + 1}`).join(' AND ')
        const params = filters.map((f) => f.val)
        let sql = `SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''}`
        if (limitN != null) sql += ` LIMIT ${limitN}`
        const r = await db.query(sql, params)
        return { data: r.rows, error: null }
      }

      const chain = {
        insert(row: Record<string, unknown>) {
          const keys = Object.keys(row)
          const runInsert = async (returning: boolean) => {
            const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})${returning ? ' RETURNING *' : ''}`
            await db.query(sql, keys.map((k) => row[k]))
            return { error: null }
          }
          return {
            select: () => ({
              single: async () => {
                try {
                  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`
                  const r = await db.query<{ id: string }>(
                    sql,
                    keys.map((k) => row[k]),
                  )
                  return { data: r.rows[0], error: null }
                } catch (e) {
                  return { data: null, error: e }
                }
              },
            }),
            then(
              onFulfilled?: (v: { data: null; error: null }) => unknown,
              onRejected?: (e: unknown) => unknown,
            ) {
              return runInsert(false)
                .then((r) => onFulfilled?.({ data: null, error: r.error as null }))
                .catch(onRejected)
            },
          }
        },
        update(row: Record<string, unknown>) {
          op = 'update'
          updateRow = row
          return chain
        },
        select(_cols?: string) {
          op = 'select'
          return chain
        },
        eq(col: string, val: unknown) {
          filters.push({ col, val })
          return chain
        },
        limit(n: number) {
          limitN = n
          return chain
        },
        order() {
          return chain
        },
        maybeSingle: async () => {
          const { data, error } = await runSelect()
          return { data: data?.[0] ?? null, error }
        },
        single: async () => {
          const { data, error } = await runSelect()
          return { data: data?.[0] ?? null, error: data?.length ? null : { message: 'not found' } }
        },
        then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown) {
          if (op === 'insert' && insertRow) {
            const keys = Object.keys(insertRow)
            const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`
            return db
              .query(sql, keys.map((k) => insertRow![k]))
              .then((r) => onFulfilled({ data: r.rows, error: null }))
          }
          if (op === 'update' && updateRow) {
            const setCols = Object.keys(updateRow)
            const setSql = setCols.map((c, i) => `${c} = $${i + 1}`).join(', ')
            const where = filters.map((f, i) => `${f.col} = $${setCols.length + i + 1}`).join(' AND ')
            const params = [...setCols.map((c) => updateRow![c]), ...filters.map((f) => f.val)]
            const sql = `UPDATE ${table} SET ${setSql}${where ? ` WHERE ${where}` : ''}`
            return db.query(sql, params).then((r) => onFulfilled({ data: r.rows, error: null }))
          }
          return runSelect().then((r) => onFulfilled(r))
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
}
