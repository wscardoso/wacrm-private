-- ============================================================
-- 039_platform_account_discovery.sql
-- P1c / Lot 1 — Platform Account Discovery RPC.
--
-- Adds a SINGLE read-only RPC that lets an authenticated platform
-- operator discover the tenants they are authorized to supervise.
-- This is the "control tower" entry point: before an operator can open
-- a tenant via /act/[accountId] (P1b), they need to know which
-- account_ids are valid for them — without being able to enumerate the
-- whole operator/assignment directory.
--
-- Design constraints (do NOT violate):
--   * SECURITY DEFINER, SET search_path = public.
--   * Executable by `authenticated` only.
--   * Filtered EXCLUSIVELY by auth.uid() — never takes account_id or any
--     user identifier as an argument.
--   * Returns only the caller's own assignments:
--       account_id, name, access_role, created_at.
--   * No existing policy is altered. No direct client SELECT on
--     platform_operator_accounts is opened. accounts / profiles /
--     owner_user_id / is_account_member() / write policies are UNTOUCHED.
--   * No UI, route, layout, switcher, or component in this lot.
--
-- The join requires the operator to be ACTIVE (platform_operators.is_active)
-- and the assignment to belong to auth.uid(), so an inactive or
-- non-operator caller gets an empty set — never the directory.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION list_platform_operator_accounts()
RETURNS TABLE (
  account_id   UUID,
  name         TEXT,
  access_role  platform_access_role,
  created_at   TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    poa.account_id,
    a.name,
    poa.access_role,
    poa.created_at
  FROM platform_operator_accounts poa
  JOIN accounts a
    ON a.id = poa.account_id
  JOIN platform_operators po
    ON po.user_id = poa.operator_user_id
  WHERE poa.operator_user_id = auth.uid()
    AND po.user_id = auth.uid()
    AND po.is_active = TRUE;
$$;

ALTER FUNCTION list_platform_operator_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION list_platform_operator_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_platform_operator_accounts() TO authenticated;
