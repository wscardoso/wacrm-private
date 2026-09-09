-- 078_accounts_owner_escalation_fix.sql — Gate 2 follow-up (E2E validation, F-DB-01)
--
-- accounts_update (017_account_sharing.sql:643-645) only checks
-- is_account_member(id, 'admin') in USING/WITH CHECK — it never
-- restricts which columns an admin can write. Same bug class as
-- 074_profiles_tenant_escalation_fix.sql, one table over:
--
--   PATCH /rest/v1/accounts?id=eq.<my-account>
--   {"owner_user_id": "<my-own-uid>"}
--
-- passes both RLS clauses (the row belongs to an account the caller
-- administers) and lets any admin — not just the owner — silently
-- reassign owner_user_id, bypassing transfer_account_ownership()
-- (018_account_member_rpcs.sql:217-283), which exists specifically to
-- keep accounts.owner_user_id and profiles.account_role in sync and
-- to preserve idx_accounts_one_per_owner (045/046). A direct column
-- write skips all of that, producing an owner_user_id that points to
-- someone whose profiles.account_role never became 'owner'.
--
-- Fix: same shape as 074 — REVOKE the table-wide UPDATE/INSERT grant
-- `authenticated` holds from the Supabase project bootstrap, then
-- GRANT UPDATE back on only the columns a client legitimately edits
-- directly (confirmed by reading every call site: src/app/api/account/
-- route.ts PATCH writes name/legal_name/commercial_phone/
-- commercial_email/cnpj; src/components/settings/deals-settings.tsx
-- writes default_currency directly). owner_user_id is deliberately
-- left out — it becomes writable only through
-- transfer_account_ownership() (018, SECURITY DEFINER, owner
-- postgres, unaffected by a grantee-level REVOKE).
--
-- accounts is never client-INSERTed (personal accounts are created by
-- handle_new_user(), workspaces by the platform RPCs — both SECURITY
-- DEFINER, owner postgres) — same as profiles in 074.
--
-- Idempotent — REVOKE of a privilege the grantee no longer holds is a
-- no-op, safe to re-run.

REVOKE INSERT, UPDATE ON accounts FROM authenticated;

GRANT UPDATE (name, legal_name, commercial_phone, commercial_email, cnpj, default_currency)
  ON accounts TO authenticated;

COMMENT ON COLUMN accounts.owner_user_id IS
  'Dono da conta. Gravável apenas por handle_new_user() / RPCs de provisionamento de workspace (INSERT, 001/017/043-046) e transfer_account_ownership() (UPDATE, 018) — todas SECURITY DEFINER. authenticated não tem privilégio de coluna para owner_user_id desde 078 (F-DB-01: auto-escalada de posse de conta via PATCH direto em /rest/v1/accounts, mesma classe de bug de 074).';
