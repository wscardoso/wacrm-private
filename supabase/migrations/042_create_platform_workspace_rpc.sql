-- ============================================================
-- 042_create_platform_workspace_rpc.sql
-- P2.2 / Lote 1 — Privileged, audited Workspace provisioning RPC.
--
-- create_platform_workspace(p_name, p_cnpj) lets a Superadmin
-- (platform_operators.role = 'admin', is_active) create a new
-- Workspace (accounts row) WITHOUT becoming its Owner or a member.
--
-- Security model (mirrors 037's privileged RPC contract):
--   * SECURITY DEFINER, SET search_path = public — required to write
--     accounts / platform_operator_accounts / platform_audit_log,
--     which deny direct client DML via RLS.
--   * REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated only.
--   * The caller MUST be an ACTIVE platform admin. A common user,
--     an inactive operator, or a non-admin operator is rejected
--     (ERRCODE 42501). No self-service path exists.
--   * actor / created_by are ALWAYS auth.uid() — never trusted from
--     caller arguments. There is no privilege escalation: creating a
--     Workspace does not change any platform or tenant role.
--
-- What it does, atomically (single plpgsql body = one transaction;
-- any failure rolls the whole thing back — no orphan account, no
-- false audit row):
--   1. Insert accounts (name, owner_user_id = NULL, default_currency
--      = 'BRL', cnpj) — the Workspace is born WITHOUT a human Owner.
--      Digitall Force is NOT the owner.
--   2. Self-associate the Superadmin in platform_operator_accounts
--      with access_role = 'admin' so the new Workspace is immediately
--      discoverable (039 list_platform_operator_accounts) and
--      reachable (037/038 can_access_account / requirePlatformContext).
--      This is SUPERVISION, not ownership/membership.
--   3. Append a 'create_workspace' row to platform_audit_log stamped
--      with the real actor. Reuses the existing audit mechanism; no
--      new audit table or trigger.
--
-- Scoping & invariants (do NOT violate):
--   * No RLS policy added or changed. No new client INSERT/UPDATE path
--     on accounts. account_role_enum / platform_* enums UNCHANGED.
--   * handle_new_user() and transfer_account_ownership() UNTOUCHED.
--   * default_currency respects the accounts_default_currency_format
--     CHECK from 021 ('BRL' is a valid 3-letter uppercase code).
--   * cnpj respects accounts_cnpj_format / idx_accounts_cnpj_unique
--     from 041.
--
-- Idempotent DDL (CREATE OR REPLACE) — safe to re-run. Note: each
-- successful CALL creates a new Workspace (that is its purpose); the
-- function DEFINITION is what is idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION create_platform_workspace(
  p_name TEXT,
  p_cnpj TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_active_admin BOOLEAN;
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Caller must be an ACTIVE platform admin (Superadmin). This is the
  -- only role permitted to provision Workspaces.
  SELECT (po.role = 'admin' AND po.is_active)
    INTO v_caller_active_admin
    FROM platform_operators po
    WHERE po.user_id = auth.uid();

  IF NOT COALESCE(v_caller_active_admin, FALSE) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  -- Structural argument validation (defensive; DB CHECKs are the final
  -- gate). Name required; CNPJ, if present, must be 14 digits.
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Workspace name is required' USING ERRCODE = '22023';
  END IF;

  IF p_cnpj IS NOT NULL AND p_cnpj !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'Invalid CNPJ format (expected 14 digits)'
      USING ERRCODE = '22023';
  END IF;

  -- (1) Create the Workspace with NO human Owner and BRL default.
  INSERT INTO accounts (name, owner_user_id, default_currency, cnpj)
  VALUES (btrim(p_name), NULL, 'BRL', p_cnpj)
  RETURNING id INTO v_account_id;

  -- (2) Self-associate the Superadmin as SUPERVISOR (never owner/member).
  INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by)
  VALUES (auth.uid(), v_account_id, 'admin', auth.uid());

  -- (3) Audit — same transaction, real actor.
  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action, metadata)
  VALUES (
    auth.uid(),
    v_account_id,
    'create_workspace',
    jsonb_build_object(
      'name', btrim(p_name),
      'cnpj', p_cnpj,
      'default_currency', 'BRL'
    )
  );

  RETURN v_account_id;
END;
$$;

ALTER FUNCTION create_platform_workspace(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION create_platform_workspace(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_platform_workspace(TEXT, TEXT) TO authenticated;
