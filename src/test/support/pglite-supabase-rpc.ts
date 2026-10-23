import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pgliteSupabase } from '@/test/support/pglite-supabase-adapter'

/**
 * Supabase-shaped client whose `rpc()` calls the real function in PGlite.
 *
 * `from()` is the shared adapter's, untouched. `rpc()` resolves the function
 * in `pg_proc` (schema `public`), binds the named arguments with a cast to the
 * declared parameter type and returns what PostgREST would:
 *   - set-returning function -> array of rows (`[]` when empty)
 *   - scalar / jsonb function -> the bare value
 * SQL failures come back as `{ data: null, error: { message, code, ... } }`
 * with the driver's SQLSTATE; an unknown function or argument name is an error
 * (PGRST202), never a silent success.
 *
 * Nothing here talks to a remote database.
 */

export interface PgliteRpcError {
  message: string
  code?: string
  details?: string | null
  hint?: string | null
}

interface FunctionMeta {
  returnsSet: boolean
  argNames: string[]
  argTypes: string[]
}

const META_SQL = `
  SELECT p.proretset AS returns_set,
         COALESCE(p.proargnames[1:p.pronargs], '{}') AS arg_names,
         ARRAY(
           SELECT format_type(u.t, NULL)
             FROM unnest(string_to_array(p.proargtypes::text, ' ')::oid[]) WITH ORDINALITY AS u(t, i)
            ORDER BY u.i
         ) AS arg_types
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = $1`

const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`

function toRpcError(e: unknown): PgliteRpcError {
  const err = e as { message?: unknown; code?: unknown; detail?: unknown; hint?: unknown }
  return {
    message: typeof err?.message === 'string' ? err.message : String(e),
    code: typeof err?.code === 'string' ? err.code : undefined,
    details: typeof err?.detail === 'string' ? err.detail : null,
    hint: typeof err?.hint === 'string' ? err.hint : null,
  }
}

function bind(value: unknown, type: string): unknown {
  if (value instanceof Date) return value.toISOString()
  // supabase-js sends the argument as JSON, so a json/jsonb parameter always
  // receives serialized JSON (a JS string becomes a JSON string).
  if ((type === 'jsonb' || type === 'json') && value !== null && value !== undefined) {
    return JSON.stringify(value)
  }
  return value
}

export function pgliteSupabaseWithRpc(db: PGlite): SupabaseClient {
  const base = pgliteSupabase(db) as unknown as Record<string, unknown>
  const metaCache = new Map<string, FunctionMeta[]>()

  async function metaFor(name: string): Promise<FunctionMeta[]> {
    const cached = metaCache.get(name)
    if (cached) return cached
    const { rows } = await db.query<{ returns_set: boolean; arg_names: string[]; arg_types: string[] }>(
      META_SQL,
      [name],
    )
    const meta = rows.map((r) => ({ returnsSet: r.returns_set, argNames: r.arg_names, argTypes: r.arg_types }))
    metaCache.set(name, meta)
    return meta
  }

  async function rpc(name: string, args: Record<string, unknown> = {}) {
    try {
      const candidates = await metaFor(name)
      const given = Object.keys(args).filter((k) => args[k] !== undefined)
      const notFound = (why: string) => ({
        data: null,
        error: {
          message: `Could not find the function public.${name}(${given.join(', ')}) in the schema cache: ${why}`,
          code: 'PGRST202',
          details: null,
          hint: null,
        } satisfies PgliteRpcError,
      })

      if (candidates.length === 0) return notFound('no such function')
      if (candidates.length > 1) return notFound('overloaded; the R1 contract expects one signature per name')
      const meta = candidates[0]!

      const unknown = given.filter((k) => !meta.argNames.includes(k))
      if (unknown.length > 0) return notFound(`unknown argument(s) ${unknown.join(', ')}`)

      const values: unknown[] = []
      const bindings = given.map((k, i) => {
        const type = meta.argTypes[meta.argNames.indexOf(k)]!
        values.push(bind(args[k], type))
        return `${quoteIdent(k)} => $${i + 1}::${type}`
      })

      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT * FROM public.${quoteIdent(name)}(${bindings.join(', ')})`,
        values,
      )
      const data = meta.returnsSet ? rows : (rows[0]?.[name] ?? null)
      return { data, error: null }
    } catch (e) {
      return { data: null, error: toRpcError(e) }
    }
  }

  return { ...base, rpc } as unknown as SupabaseClient
}
