-- ============================================================
-- 079_flow_runs_automation_logs_dml_hardening.sql — F-DB-04
--
-- Same bug CLASS as 074/078 (table-wide grant from the Supabase
-- project bootstrap outstrips what RLS policies actually expose), but
-- confirmed NOT exploitable here — this is hardening, not a fix for a
-- live bypass.
--
-- flow_runs and automation_logs each carry only a SELECT policy for
-- `authenticated` (flow_runs_select / automation_logs_select,
-- 038_platform_read_context.sql:113-126) — no INSERT/UPDATE/DELETE
-- policy exists for either table (confirmed: F-DB-03, CLOSED —
-- INTENTIONAL). Every real write goes through supabaseAdmin()
-- (service-role, bypasses RLS) from server-only engines/cron/webhook
-- code (src/lib/flows/engine.ts, src/lib/automations/engine.ts,
-- src/app/api/flows/cron/route.ts, src/app/api/whatsapp/delivery/
-- orphan-sweep/route.ts) or from SECURITY DEFINER functions
-- (070_identity_merge_rpc.sql, owner postgres). No browser/
-- authenticated-client code path anywhere in the repo attempts
-- INSERT/UPDATE/UPSERT/DELETE on either table — confirmed by
-- exhaustive grep across src/app, src/components, src/lib during the
-- F-DB-03 investigation.
--
-- With RLS enabled and no INSERT/UPDATE/DELETE policy, Postgres
-- already default-denies those commands for `authenticated` today —
-- there is no live bypass. What remains is the same latent
-- defense-in-depth gap 074/078 closed for profiles/accounts: RLS is a
-- *row* filter layered on top of a *table* privilege check. Because
-- `authenticated` still holds table-wide INSERT/UPDATE/DELETE from
-- `GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated`
-- (Supabase project bootstrap, issued outside these migrations at
-- project creation — same source 074/078 identified), a future
-- accidental permissive policy on either table (e.g. a careless
-- `FOR ALL USING (is_account_member(account_id))` copy-paste, the
-- exact shape of the pre-074 profiles bug) would make it fully
-- writable table-wide the moment it landed, with no additional grant
-- required. Revoking the unused table-wide privilege now removes that
-- one-step failure mode.
--
-- Difference from 074/078's shape: those tables have real
-- self-service columns a client legitimately writes directly, so they
-- REVOKE then re-GRANT UPDATE on a narrow column list. flow_runs and
-- automation_logs have no such column — F-DB-03 confirmed zero
-- legitimate client-side DML of any kind — so there is nothing to
-- re-grant. SELECT is untouched; only the unused INSERT/UPDATE/DELETE
-- privilege is revoked.
--
-- service_role is unaffected: this REVOKE targets the grantee
-- `authenticated` only. service_role's writes go through
-- supabaseAdmin(), which uses the service-role key/role, a distinct
-- Postgres role from `authenticated` and outside RLS enforcement
-- entirely.
--
-- Idempotent — REVOKE of a privilege the grantee no longer holds is a
-- no-op, safe to re-run.
-- ============================================================

REVOKE INSERT, UPDATE, DELETE ON flow_runs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON automation_logs FROM authenticated;

COMMENT ON TABLE flow_runs IS
  'Estado de execução do motor de flows. Gravável apenas por supabaseAdmin() (service-role) em src/lib/flows/engine.ts, src/app/api/flows/cron/route.ts, src/app/api/whatsapp/delivery/orphan-sweep/route.ts e src/app/api/whatsapp/send/route.ts, e por merge_identity_group()/_merge_group_flow_runs() (070, SECURITY DEFINER). authenticated não tem privilégio de tabela para INSERT/UPDATE/DELETE desde 079 (F-DB-04: hardening — nenhum bypass ativo, mesma classe de defense-in-depth de 074/078). SELECT permanece concedido, escopado por RLS (flow_runs_select, 038).';

COMMENT ON TABLE automation_logs IS
  'Log de execução do motor de automations. Gravável apenas por supabaseAdmin() (service-role) em src/lib/automations/engine.ts, e por merge_identity_group() (070, SECURITY DEFINER). authenticated não tem privilégio de tabela para INSERT/UPDATE/DELETE desde 079 (F-DB-04: hardening — nenhum bypass ativo, mesma classe de defense-in-depth de 074/078). SELECT permanece concedido, escopado por RLS (automation_logs_select, 038).';
