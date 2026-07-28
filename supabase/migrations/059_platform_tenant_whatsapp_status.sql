-- ============================================================
-- 059_platform_tenant_whatsapp_status.sql
-- E9 / Fase 1 — WhatsApp connection status for the platform
-- operator "control tower" grid (/act, Tenants tab).
--
-- whatsapp_config was DELIBERATELY EXCLUDED from the operator read
-- grant in migration 038 ("SECRETS" section — RLS cannot mask
-- columns, so widening SELECT to operators would expose
-- access_token/verify_token/etc). This RPC is the narrow, explicit
-- exception: it returns ONLY account_id + status + provider, never
-- access_token, verify_token, phone_number_id, or waba_id.
--
-- Authorization pattern: mirrors list_platform_operator_accounts()
-- (039) exactly — a plain SQL function with no explicit auth.uid()
-- IS NULL / is_platform_operator() check. The JOIN chain itself does
-- the filtering: a caller who is unauthenticated, not an operator, or
-- an inactive operator simply gets an EMPTY result set, never the
-- directory and never an exception. This is a deliberate choice
-- (confirmed with the requester) to stay consistent with 039's own
-- test suite (platform-account-discovery.pglite.test.ts asserts
-- "non-operator user receives an empty set" / "inactive operator
-- receives an empty set" — not a thrown 42501). Rows are further
-- naturally scoped to only the tenants THIS caller supervises via the
-- platform_operator_accounts join, exactly like 039.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION list_platform_tenant_whatsapp_status()
RETURNS TABLE (
  account_id UUID,
  status     TEXT,
  provider   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT wc.account_id, wc.status, wc.provider
  FROM whatsapp_config wc
  JOIN platform_operator_accounts poa ON poa.account_id = wc.account_id
  JOIN platform_operators po ON po.user_id = poa.operator_user_id
  WHERE poa.operator_user_id = auth.uid() AND po.is_active = TRUE;
$$;

ALTER FUNCTION list_platform_tenant_whatsapp_status() OWNER TO postgres;
REVOKE ALL ON FUNCTION list_platform_tenant_whatsapp_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_platform_tenant_whatsapp_status() TO authenticated;
