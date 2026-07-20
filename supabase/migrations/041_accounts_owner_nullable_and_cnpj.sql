-- ============================================================
-- 041_accounts_owner_nullable_and_cnpj.sql
-- P2.2 / Lote 1 — Database foundation for Superadmin Workspace
-- provisioning.
--
-- Two additive schema changes to `accounts`:
--
--   1. owner_user_id DROP NOT NULL.
--      A Workspace can now legitimately exist WITHOUT a human Owner —
--      the state "provisioned by the platform, awaiting association to
--      its human Owner". This is represented by owner_user_id = NULL.
--      Digitall Force is NEVER set as owner; there is no sentinel user
--      and no placeholder account.
--
--      Compatibility with idx_accounts_one_per_owner (017): a Postgres
--      UNIQUE index does NOT treat NULLs as equal, so any number of
--      pending-owner Workspaces (owner_user_id = NULL) can coexist
--      while the "at most one account per real owner" invariant is
--      preserved unchanged for non-NULL owners.
--
--      Signup (017 handle_new_user) is UNTOUCHED and keeps inserting
--      owner_user_id = NEW.id — normal personal accounts still get an
--      Owner at creation. Only administrative provisioning (042 RPC)
--      creates NULL-owner Workspaces.
--
--   2. cnpj column (nullable), stored NORMALIZED as exactly 14 digits
--      (no mask/punctuation). A CHECK enforces the structural shape
--      only ('' -> NULL allowed; 14 numeric digits when present). Full
--      check-digit validation is a later application-layer concern; the
--      DB guarantees storage shape and uniqueness.
--
--      A PARTIAL UNIQUE index prevents two Workspaces sharing the same
--      filled CNPJ while allowing many NULL-CNPJ accounts (every signup
--      account has no CNPJ).
--
-- Scoping & invariants (do NOT violate):
--   * profiles / account_role_enum / platform_* tables UNTOUCHED.
--   * idx_accounts_one_per_owner preserved (never dropped/relaxed).
--   * No RLS policy is added or changed here. No new client INSERT/
--     UPDATE path on accounts is opened — administrative creation flows
--     exclusively through the SECURITY DEFINER RPC in 042.
--   * handle_new_user() and transfer_account_ownership() UNCHANGED.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- 1. owner_user_id becomes nullable. Idempotent: DROP NOT NULL on an
-- already-nullable column is a no-op.
ALTER TABLE accounts ALTER COLUMN owner_user_id DROP NOT NULL;

-- 2. cnpj column — nullable, 14-digit normalized storage.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cnpj TEXT NULL;

-- Structural validation only: NULL allowed, otherwise exactly 14 digits.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_cnpj_format;
ALTER TABLE accounts ADD CONSTRAINT accounts_cnpj_format
  CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$');

-- Prevent duplicate filled CNPJs; NULLs are ignored by the partial index
-- so every CNPJ-less account (all signup accounts) is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_cnpj_unique
  ON accounts(cnpj) WHERE cnpj IS NOT NULL;
