-- ============================================================
-- 060_platform_lookup_account_by_cnpj.sql
-- E9 / Fase 1 (CreateWorkspaceDialog UX fix) — resolve a conflicting
-- CNPJ to the account_id + name of the tenant that already holds it,
-- so the "New Workspace" dialog can offer "go to the existing
-- tenant" instead of a dead-end generic error.
--
-- This is ADDITIVE: create_platform_workspace() (042/043) is NOT
-- modified. This RPC is a separate, narrow, read-only lookup used
-- only after that RPC's 23505 (unique violation on accounts.cnpj,
-- migration 041) is caught client-side.
--
-- Authorization: admin-gated, same two-step pattern as the sibling
-- platform_lookup_user_id_by_email() (061) and the write RPCs in 037
-- — two DISTINCT checks with distinct messages, not one collapsed
-- check:
--   1. auth.uid() IS NULL                      -> 'Unauthorized' / 42501
--   2. authenticated but not an active admin   -> 'This action requires
--                                                  an active platform
--                                                  admin' / 42501
--
-- Returns:
--   - NULL (no exception) when the caller IS an active admin and no
--     account currently holds this CNPJ — "no conflict" is a valid,
--     unexceptional outcome, not an error.
--   - {"account_id": ..., "name": ...} when a conflict exists.
--
-- No column beyond accounts.id/accounts.name is read or returned —
-- irrelevant to whatsapp_config entirely.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION platform_lookup_account_by_cnpj(p_cnpj TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_active_admin BOOLEAN;
  v_row JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT (po.role = 'admin' AND po.is_active) INTO v_caller_active_admin
    FROM platform_operators po WHERE po.user_id = auth.uid();

  IF NOT COALESCE(v_caller_active_admin, FALSE) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object('account_id', a.id, 'name', a.name) INTO v_row
  FROM accounts a
  WHERE a.cnpj = btrim(p_cnpj);

  -- v_row stays NULL (no exception) when the SELECT above matches
  -- zero rows — "no conflict" is the common, unexceptional case.
  RETURN v_row;
END;
$$;

ALTER FUNCTION platform_lookup_account_by_cnpj(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION platform_lookup_account_by_cnpj(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_lookup_account_by_cnpj(TEXT) TO authenticated;
