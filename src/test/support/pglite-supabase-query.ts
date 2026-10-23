import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pgliteSupabaseWithRpc } from '@/test/support/pglite-supabase-rpc'

/**
 * Supabase-shaped client over PGlite with a query builder wide enough for the
 * real inbound path (contact/conversation lookup and upsert, counts, the
 * conversation update, the agent eligibility reads and agent_runs writes):
 *
 *   select(cols, { count, head }) insert / update / upsert(onConflict) / delete
 *   eq neq like in is gt gte lt lte, order, limit, single, maybeSingle
 *
 * `rpc()` is H0's (real functions). Failures come back as
 * `{ data: null, error: { message, code, ... } }` with the SQLSTATE, like
 * PostgREST, instead of throwing. Anything the builder does not model
 * (embedded resources such as `broadcasts!inner(...)`, dotted filter columns,
 * select expressions) is an explicit `TEST_UNSUPPORTED` error, never guessed,
 * so a call outside the modelled surface cannot pass silently.
 *
 * The shared adapter (pglite-supabase-adapter.ts) is left untouched.
 * Nothing here talks to a remote database.
 */

export interface PgliteQueryError {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
}

type Result = { data: unknown; error: PgliteQueryError | null; count?: number | null }
type Filter = { col: string; op: string; val: unknown }

const IDENT = /^[a-z_][a-z0-9_]*$/i
const OPS: Record<string, string> = { eq: '=', neq: '<>', like: 'LIKE', gt: '>', gte: '>=', lt: '<', lte: '<=' }

const unsupported = (what: string): Result => ({
  data: null,
  error: { message: `pglite-supabase-query: unsupported ${what}`, code: 'TEST_UNSUPPORTED', details: null, hint: null },
})

function toError(e: unknown): PgliteQueryError {
  const err = e as { message?: unknown; code?: unknown; detail?: unknown; hint?: unknown }
  return {
    message: typeof err?.message === 'string' ? err.message : String(e),
    code: typeof err?.code === 'string' ? err.code : undefined,
    details: typeof err?.detail === 'string' ? err.detail : null,
    hint: typeof err?.hint === 'string' ? err.hint : null,
  }
}

const q = (id: string) => `"${id}"`

class Builder implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private cols = '*'
  private wantCount = false
  private head = false
  private returning = false
  private rows: Record<string, unknown>[] = []
  private patch: Record<string, unknown> = {}
  private conflict: string[] = []
  private filters: Filter[] = []
  private orderBy: { col: string; asc: boolean }[] = []
  private limitN: number | null = null
  private mode: 'single' | 'maybeSingle' | null = null

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
  ) {}

  select(cols = '*', opts?: { count?: 'exact'; head?: boolean }) {
    if (this.op === 'select') this.cols = cols
    else this.returning = true
    if (opts?.count) this.wantCount = true
    if (opts?.head) this.head = true
    return this
  }
  insert(row: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = 'insert'
    this.rows = Array.isArray(row) ? row : [row]
    return this
  }
  upsert(row: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
    this.op = 'upsert'
    this.rows = Array.isArray(row) ? row : [row]
    this.conflict = (opts?.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean)
    return this
  }
  update(patch: Record<string, unknown>) {
    this.op = 'update'
    this.patch = patch
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  private f(col: string, op: string, val: unknown) {
    this.filters.push({ col, op, val })
    return this
  }
  eq(col: string, val: unknown) { return this.f(col, 'eq', val) }
  neq(col: string, val: unknown) { return this.f(col, 'neq', val) }
  like(col: string, val: string) { return this.f(col, 'like', val) }
  gt(col: string, val: unknown) { return this.f(col, 'gt', val) }
  gte(col: string, val: unknown) { return this.f(col, 'gte', val) }
  lt(col: string, val: unknown) { return this.f(col, 'lt', val) }
  lte(col: string, val: unknown) { return this.f(col, 'lte', val) }
  in(col: string, vals: unknown[]) { return this.f(col, 'in', vals) }
  is(col: string, val: null | boolean) { return this.f(col, 'is', val) }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false })
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  single() {
    this.mode = 'single'
    return this
  }
  maybeSingle() {
    this.mode = 'maybeSingle'
    return this
  }

  then<R1 = Result, R2 = never>(
    onFulfilled?: ((v: Result) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.run().then(onFulfilled, onRejected)
  }

  private where(params: unknown[]): string | Result {
    const parts: string[] = []
    for (const { col, op, val } of this.filters) {
      if (!IDENT.test(col)) return unsupported(`filter column "${col}"`)
      if (op === 'in') {
        params.push((val as unknown[]).map(String))
        parts.push(`${q(col)}::text = ANY($${params.length}::text[])`)
      } else if (op === 'is') {
        parts.push(`${q(col)} IS ${val === null ? 'NULL' : val ? 'TRUE' : 'FALSE'}`)
      } else if (op === 'eq' && val === null) {
        parts.push(`${q(col)} IS NULL`)
      } else {
        params.push(val)
        parts.push(`${q(col)} ${OPS[op]} $${params.length}`)
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : ''
  }

  private shape(rows: Record<string, unknown>[], count: number | null): Result {
    if (this.mode) {
      if (rows.length > 1 || (this.mode === 'single' && rows.length === 0)) {
        return {
          data: null,
          error: {
            message: `JSON object requested, multiple (or no) rows returned (${rows.length})`,
            code: 'PGRST116',
            details: null,
            hint: null,
          },
        }
      }
      return { data: rows[0] ?? null, error: null }
    }
    return { data: this.head ? null : rows, error: null, count }
  }

  private async run(): Promise<Result> {
    if (!IDENT.test(this.table)) return unsupported(`table "${this.table}"`)
    try {
      const params: unknown[] = []

      if (this.op === 'select') {
        const cols = this.cols.trim()
        if (cols !== '*' && !cols.split(',').every((c) => IDENT.test(c.trim()))) {
          return unsupported(`select expression "${cols}" (embedded resources/aliases)`)
        }
        const where = this.where(params)
        if (typeof where !== 'string') return where
        const colSql = cols === '*' ? '*' : cols.split(',').map((c) => q(c.trim())).join(', ')
        let count: number | null = null
        if (this.wantCount) {
          const c = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(this.table)}${where}`, params)
          count = c.rows[0]!.n
          if (this.head) return this.shape([], count)
        }
        let sql = `SELECT ${colSql} FROM ${q(this.table)}${where}`
        if (this.orderBy.length) {
          if (!this.orderBy.every((o) => IDENT.test(o.col))) return unsupported('order column')
          sql += ` ORDER BY ${this.orderBy.map((o) => `${q(o.col)} ${o.asc ? 'ASC' : 'DESC'}`).join(', ')}`
        }
        const limit = this.mode ? Math.max(this.limitN ?? 0, 2) : this.limitN
        if (limit != null) sql += ` LIMIT ${Number(limit)}`
        const r = await this.db.query<Record<string, unknown>>(sql, params)
        return this.shape(r.rows, count)
      }

      if (this.op === 'insert' || this.op === 'upsert') {
        if (this.rows.length === 0) return { data: [], error: null }
        const keys = Object.keys(this.rows[0]!)
        if (!keys.every((k) => IDENT.test(k))) return unsupported('insert column')
        const placeholders = this.rows.map(
          (row) => `(${keys.map((k) => { params.push(row[k]); return `$${params.length}` }).join(', ')})`,
        )
        let sql = `INSERT INTO ${q(this.table)} (${keys.map(q).join(', ')}) VALUES ${placeholders.join(', ')}`
        if (this.op === 'upsert') {
          if (!this.conflict.every((c) => IDENT.test(c))) return unsupported('onConflict column')
          const target = this.conflict.length ? ` (${this.conflict.map(q).join(', ')})` : ''
          const sets = keys.map((k) => `${q(k)} = EXCLUDED.${q(k)}`).join(', ')
          sql += ` ON CONFLICT${target} DO UPDATE SET ${sets}`
        }
        if (this.returning) sql += ' RETURNING *'
        const r = await this.db.query<Record<string, unknown>>(sql, params)
        return this.returning ? this.shape(r.rows, null) : { data: null, error: null }
      }

      if (this.op === 'update') {
        const keys = Object.keys(this.patch)
        if (!keys.every((k) => IDENT.test(k))) return unsupported('update column')
        const sets = keys.map((k) => { params.push(this.patch[k]); return `${q(k)} = $${params.length}` })
        const where = this.where(params)
        if (typeof where !== 'string') return where
        const r = await this.db.query<Record<string, unknown>>(
          `UPDATE ${q(this.table)} SET ${sets.join(', ')}${where}${this.returning ? ' RETURNING *' : ''}`,
          params,
        )
        return this.returning ? this.shape(r.rows, null) : { data: null, error: null }
      }

      const where = this.where(params)
      if (typeof where !== 'string') return where
      const r = await this.db.query<Record<string, unknown>>(
        `DELETE FROM ${q(this.table)}${where}${this.returning ? ' RETURNING *' : ''}`,
        params,
      )
      return this.returning ? this.shape(r.rows, null) : { data: null, error: null }
    } catch (e) {
      return { data: null, error: toError(e) }
    }
  }
}

export function pgliteSupabaseWithQuery(db: PGlite): SupabaseClient {
  const base = pgliteSupabaseWithRpc(db) as unknown as Record<string, unknown>
  return { ...base, from: (table: string) => new Builder(db, table) } as unknown as SupabaseClient
}
