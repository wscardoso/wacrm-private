-- ============================================================
-- 053_accounts_commercial_identity.sql — E5a: Account Identity Data
--
-- Feature Contract: docs/architecture/E5-workspace-commercial-identity.md
-- (§3, §5, §6, §7). Additive only — no new table, no new trigger, no
-- new type. Adds three nullable identity columns to `accounts` plus
-- CHECK constraints (precedent: `accounts_cnpj_format` 041,
-- `accounts_default_currency_format` 021) so that BOTH writers of E5
-- (member PATCH here in E5a, platform RPC in E5b/054) inherit the
-- exact same validation and cannot diverge (§5 normative principle).
--
-- Column names are an implementation decision (contract §6 fixes only
-- existence/nullability/validation, not identifiers):
--   legal_name        — razão social (jurídico)
--   commercial_phone  — telefone comercial
--   commercial_email  — e-mail comercial
--
-- All three are NULLable — identity is filled in over time, not
-- required at account creation (same posture as owner_user_id, 041).
--
-- CNPJ (041) and default_currency (021) constraints are NOT redefined
-- here — this migration only ADDS the three new columns/constraints
-- (§7.4, §13 risk 4).
--
-- Validation posture (§7.2/§7.3 normative): reject obvious garbage,
-- never a legitimate value. Format hygiene, not gatekeeping — err on
-- the side of accepting when in doubt.
--
-- Idempotent — safe to re-run (IF NOT EXISTS / DROP+ADD CONSTRAINT).
-- ============================================================

-- ------------------------------------------------------------
-- Columns
-- ------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS legal_name TEXT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS commercial_phone TEXT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS commercial_email TEXT NULL;

COMMENT ON COLUMN accounts.legal_name IS
  'E5a — razão social. NULL = not informed. When present: non-empty after trim, <=160 chars (accounts_legal_name_format).';
COMMENT ON COLUMN accounts.commercial_phone IS
  'E5a — telefone comercial. NULL = not informed. Basic format only (digits/+/spaces/hyphens/parens, 6-30 chars) — not E.164-strict, no delivery verification (accounts_commercial_phone_format).';
COMMENT ON COLUMN accounts.commercial_email IS
  'E5a — e-mail comercial. NULL = not informed. Basic shape only (local@domain.tld) — not RFC 5322, no delivery verification (accounts_commercial_email_format).';

-- ------------------------------------------------------------
-- CHECK constraints (§7.1–§7.3)
-- ------------------------------------------------------------

-- 7.1 Razão social: NULL allowed; otherwise non-blank after trim and
-- bounded (same spirit as the app-layer MAX_NAME_LEN=80 used for
-- `name` in /api/account, given a bit more headroom since a legal
-- entity name commonly runs longer than a workspace nickname).
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_legal_name_format;
ALTER TABLE accounts ADD CONSTRAINT accounts_legal_name_format
  CHECK (legal_name IS NULL OR (btrim(legal_name) <> '' AND length(legal_name) <= 160));

-- 7.2 Telefone comercial: permitted chars only (digits, +, spaces,
-- hyphens, parens), reasonable length, and at least 6 digit characters
-- somewhere in the value (rejects "+()--" style garbage while staying
-- far short of a telecom-grade parser or E.164 enforcement).
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_commercial_phone_format;
ALTER TABLE accounts ADD CONSTRAINT accounts_commercial_phone_format
  CHECK (
    commercial_phone IS NULL
    OR (
      commercial_phone ~ '^[0-9+()\-\s]{6,30}$'
      AND length(regexp_replace(commercial_phone, '[^0-9]', '', 'g')) >= 6
    )
  );

-- 7.3 E-mail comercial: minimal shape (something@domain.tld), not a
-- full RFC 5322 validator. Reuses the exact same pattern already used
-- at the application layer for owner email in
-- src/lib/workspaces/create-workspace.ts (EMAIL_RE) — same shape,
-- expressed here as the DB-side CHECK so both writers share it.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_commercial_email_format;
ALTER TABLE accounts ADD CONSTRAINT accounts_commercial_email_format
  CHECK (
    commercial_email IS NULL
    OR (commercial_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' AND length(commercial_email) <= 254)
  );

-- Note: CNPJ correction path (§3 item 3) needs no schema change here —
-- the column and accounts_cnpj_format/idx_accounts_cnpj_unique already
-- exist (041). E5a opens the member-side WRITE path to it in the PATCH
-- route; E5b (054) opens the platform-side path. Neither redefines the
-- constraint.
