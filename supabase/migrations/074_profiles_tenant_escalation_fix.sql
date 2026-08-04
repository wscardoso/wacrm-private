-- ============================================================
-- 074_profiles_tenant_escalation_fix.sql — Gate 2 (Segurança S1)
--
-- profiles_update e profiles_insert (017_account_sharing.sql:619-628)
-- only check auth.uid() = user_id — they never restrict account_id or
-- account_role, the two columns is_account_member() (017:136-164)
-- reads as the single source of truth for EVERY tenant-isolation
-- policy in the system (contacts, conversations, whatsapp_config,
-- flows, broadcasts, deals, pipelines, automations, etc. — all of
-- 017_account_sharing.sql §"ADD account_id TO EVERY PARENT TENANT
-- TABLE" is built on top of is_account_member()).
--
-- Confirmed independently by three audits (2026-08-04), same line,
-- same exploit:
--   PATCH /rest/v1/profiles?user_id=eq.<own-uid>
--   {"account_id": "<target-account>", "account_role": "owner"}
-- passes USING (row belongs to caller) and WITH CHECK (user_id is
-- unchanged) — the caller becomes owner of any account whose UUID
-- they know, with zero invite, zero approval, zero RPC involved.
--
-- This is not an RLS bypass — RLS is active and the policy IS being
-- enforced exactly as written. The policy itself is incomplete: it
-- guards row ownership but not column contents.
--
-- Why column-level GRANT (not a column-level REVOKE, not a WITH CHECK
-- rewrite)
--
--   RLS policies of kind USING/WITH CHECK do not give SQL-language
--   or plpgsql-language policies safe access to the pre-update (OLD)
--   row for comparison — there is no built-in OLD reference outside
--   a trigger. Re-deriving "unchanged from current value" inside
--   WITH CHECK would require a correlated subquery against the same
--   table under RLS recursion, which is exactly the kind of trap
--   is_account_member() was written SECURITY DEFINER to avoid
--   (017:136-141 comment).
--
--   The column itself already tells us the intended contract:
--   018_account_member_rpcs.sql's own header (lines 4-16) states
--   plainly that profiles_update was designed to allow only
--   "self-service edits (name, avatar)" and that admin-driven role
--   changes were always meant to go through the three SECURITY
--   DEFINER "escape hatches" (set_member_role, remove_account_member,
--   transfer_account_ownership) — never through a direct client
--   UPDATE. The RLS policy simply never enforced that boundary.
--
--   IMPORTANT — a REVOKE UPDATE(account_id, account_role) alone does
--   NOT work here and was verified (PGlite) to be a no-op in practice.
--   Column-level privileges in PostgreSQL are ADDITIVE on top of a
--   table-level grant, never subtractive: `authenticated` already
--   holds table-wide UPDATE/INSERT on `profiles` from the Supabase
--   project bootstrap (`GRANT ALL ON ALL TABLES IN SCHEMA public TO
--   authenticated`, issued outside these migrations at project
--   creation). Revoking a column-level privilege that was never the
--   one actually granting access leaves the table-wide grant fully
--   intact. The only correct fix is to REVOKE the table-wide
--   UPDATE/INSERT privilege entirely, then GRANT UPDATE back on only
--   the columns that need to stay self-editable. PostgreSQL checks
--   this against the UPDATE/INSERT target list before RLS even runs:
--   any statement touching a column without an explicit grant fails
--   the whole statement with `permission denied for table profiles`
--   (SQLSTATE 42501) — including a mixed statement that also touches
--   an allowed column (full_name/avatar_url); nothing in it is
--   applied. The three RPCs (018) run SECURITY DEFINER (owner
--   postgres), so they are unaffected by a grantee-level revoke.
--
-- Confirmed no legitimate client-side codepath needs these:
--   - profiles is never INSERTed by an authenticated-role client
--     query; every row is created by handle_new_user()
--     (001/017, SECURITY DEFINER, owner postgres) or by the
--     workspace-provisioning RPCs (043/044/045/046, SECURITY
--     DEFINER, owner postgres).
--   - The only client-side UPDATE of profiles
--     (src/components/settings/profile-form.tsx) writes
--     full_name/avatar_url only. Email changes route through
--     supabase.auth.updateUser(), never profiles.email directly.
--
-- Idempotent — REVOKE of a privilege the grantee no longer holds is
-- a no-op, safe to run multiple times.
-- ============================================================

-- Strip the table-wide UPDATE/INSERT privilege `authenticated` holds
-- from the Supabase project bootstrap. authenticated never
-- legitimately inserts a profiles row — every creation path is a
-- SECURITY DEFINER function (owner postgres).
REVOKE INSERT, UPDATE ON profiles FROM authenticated;

-- Re-grant UPDATE on only the self-service columns (name, avatar —
-- the sole real usage, profile-form.tsx:149-152). account_id/
-- account_role are deliberately left out: they become writable only
-- through the existing SECURITY DEFINER RPCs (018), which run as the
-- function owner and are unaffected by this grantee-level privilege.
GRANT UPDATE (full_name, avatar_url) ON profiles TO authenticated;

COMMENT ON COLUMN profiles.account_id IS
  'Tenant do usuário. Gravável apenas por handle_new_user() / RPCs de provisionamento de workspace (INSERT, 001/017/043-046) e set_member_role() / transfer_account_ownership() (UPDATE, 018) — todas SECURITY DEFINER. authenticated não tem privilégio de coluna para account_id desde 074 (S1: auto-escalada de tenant via PATCH direto em /rest/v1/profiles).';

COMMENT ON COLUMN profiles.account_role IS
  'Papel do usuário na conta. Gravável apenas por handle_new_user() / RPCs de provisionamento de workspace (INSERT, 001/017/043-046) e set_member_role() (UPDATE, 018) — todas SECURITY DEFINER. authenticated não tem privilégio de coluna para account_role desde 074 (S1: auto-escalada de tenant via PATCH direto em /rest/v1/profiles).';
