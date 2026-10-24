import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { SUPABASE_SHELL, migrationFiles } from '@/test/support/full-migration-chain'

/**
 * A throwaway database holding the COMPLETE migration chain, on a LOOPBACK disposable
 * PostgreSQL server (scripts/diagnostics/r1-disposable-pg.mjs start, R1_PG_URL).
 *
 * Refuses any non-loopback host. Creates its own database (UTF-8: the migrations carry
 * UTF-8 text, the disposable cluster may not be) and drops only that database. The roles
 * the Supabase shell needs are cluster-wide and may already exist, so their creation is
 * made idempotent. Nothing else on the server is touched.
 */

const LOOPBACK = ['127.0.0.1', '::1', '[::1]', 'localhost']

export interface ChainDatabase {
  name: string
  /** One connection, for setup, seeding and single-connection tests. */
  client: pg.Client
  /** Several connections, for tests that need truly overlapping transactions. */
  pool: pg.Pool
  /** A fresh dedicated connection (the caller ends it). */
  connect(): Promise<pg.Client>
  drop(): Promise<void>
}

export async function createChainDatabase(
  adminUrl: string,
  tag: string,
  opts: { poolMax?: number; extraSql?: string } = {},
): Promise<ChainDatabase> {
  const uri = new URL(adminUrl)
  if (!LOOPBACK.includes(uri.hostname)) {
    throw new Error('R1_PG_URL must point to a loopback disposable server; refusing to connect')
  }
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const name = `r1_${tag}_${process.pid}_${Date.now()}`
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`)
  uri.pathname = `/${name}`
  const url = uri.toString()

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  const shell = SUPABASE_SHELL.replace(
    /CREATE ROLE (\w+)([^;]*);/g,
    (_m, role: string, rest: string) =>
      `DO $$ BEGIN CREATE ROLE ${role}${rest}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  )
  await client.query(shell)
  const dir = join(process.cwd(), 'supabase', 'migrations')
  for (const f of migrationFiles()) {
    try {
      await client.query(readFileSync(join(dir, f), 'utf8'))
    } catch (e) {
      throw new Error(`migration ${f} failed on the real server: ${(e as Error).message}`)
    }
  }
  if (opts.extraSql) await client.query(opts.extraSql)

  const pool = new pg.Pool({ connectionString: url, max: opts.poolMax ?? 8 })
  const extra: pg.Client[] = []

  return {
    name,
    client,
    pool,
    async connect() {
      const c = new pg.Client({ connectionString: url })
      await c.connect()
      extra.push(c)
      return c
    },
    async drop() {
      await pool.end().catch(() => undefined)
      for (const c of extra) await c.end().catch(() => undefined)
      await client.end().catch(() => undefined)
      await admin
        .query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name])
        .catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined)
      await admin.end().catch(() => undefined)
    },
  }
}

/**
 * Fault injection for the throwaway database ONLY (never a migration): one trigger on the
 * turn-job insert. 091 inserts the message and the job in one function, so a failure of the
 * job insert rolls the message back as well, which is what a database error looks like to
 * the routes.
 *   - permanent: SQLSTATE P0001 for one external message id;
 *   - flaky: SQLSTATE 40001 for one external message id, for its first N attempts (a
 *     sequence counts the attempts because the failed statement rolls everything else back).
 */
export const JOB_INSERT_FAULT_SQL = `
  CREATE SEQUENCE r1_flaky_seq;
  CREATE FUNCTION r1_fail_job_insert() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_ext TEXT := NEW.downstream_context->>'externalMessageId';
  BEGIN
    IF v_ext = current_setting('app.r1_fail_ext_id', true) THEN
      RAISE EXCEPTION 'r1 injected permanent failure';
    END IF;
    IF v_ext = current_setting('app.r1_flaky_ext_id', true)
       AND nextval('r1_flaky_seq') <= COALESCE(NULLIF(current_setting('app.r1_flaky_failures', true), '')::int, 0) THEN
      RAISE EXCEPTION 'r1 injected transient failure' USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER r1_fail_job_insert BEFORE INSERT ON inbound_turn_jobs
    FOR EACH ROW EXECUTE FUNCTION r1_fail_job_insert();
`

type Q = { query(sql: string, params?: unknown[]): Promise<unknown> }

export const faults = {
  permanent: (c: Q, extId: string) => c.query(`SELECT set_config('app.r1_fail_ext_id', $1, false)`, [extId]),
  async transient(c: Q, extId: string, times: number) {
    await c.query(`ALTER SEQUENCE r1_flaky_seq RESTART WITH 1`)
    await c.query(`SELECT set_config('app.r1_flaky_ext_id', $1, false)`, [extId])
    await c.query(`SELECT set_config('app.r1_flaky_failures', $1, false)`, [String(times)])
  },
  async clear(c: Q) {
    await c.query(`SELECT set_config('app.r1_fail_ext_id', '', false)`)
    await c.query(`SELECT set_config('app.r1_flaky_ext_id', '', false)`)
    await c.query(`SELECT set_config('app.r1_flaky_failures', '0', false)`)
  },
}
