-- ============================================================
-- 044_workspace_owner_required.sql
-- P2.3-B — Make p_owner_email a required parameter in
-- create_platform_workspace (remove DEFAULT NULL).
--
-- Why:
--   The 043 version used p_owner_email TEXT DEFAULT NULL and relied
--   on runtime validation to reject NULL/empty. While effective, the
--   DEFAULT NULL in the function signature is architecturally misleading:
--   it allows omitting the parameter (creating a latent orphan path).
--
--   This migration removes the default so the RPC signature becomes
--   (TEXT, TEXT, TEXT) with NO defaults — all 3 arguments are always
--   mandatory at the SQL call site. PostgreSQL syntax requires that
--   non-defaulted parameters must precede defaulted ones, and since
--   p_owner_email must not have a default, p_cnpj loses its default
--   too (the calling code always passes it explicitly anyway).
--
--   Calling convention after this migration:
--     create_platform_workspace('name', null, 'owner@email.com')  ✓
--     create_platform_workspace('name', '123...', 'owner@email.com')  ✓
--     create_platform_workspace('name', null, null)  ✗ (owner required)
--     create_platform_workspace('name', null)  ✗ (2-arg function does not exist)
--
--   The runtime validation is preserved as a defence-in-depth layer.
--
-- Invariants preserved:
--   * Same function body (only defaults removed)
--   * SECURITY DEFINER, SET search_path = public
--   * REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated
--   * actor ALWAYS auth.uid(), never from caller arguments
--   * handle_new_user() and transfer_account_ownership() UNTOUCHED
-- ============================================================

DROP FUNCTION IF EXISTS create_platform_workspace(TEXT, TEXT);
DROP FUNCTION IF EXISTS create_platform_workspace(TEXT, TEXT, TEXT);

CREATE FUNCTION create_platform_workspace(
  p_name         TEXT,
  p_cnpj         TEXT,
  p_owner_email  TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_active_admin BOOLEAN;
  v_account_id          UUID;
  v_owner_user_id       UUID;
  v_owner_name          TEXT;
  v_owner_email_normal  TEXT;
BEGIN
  -- ============================================================
  -- 1. Authentication — caller must be a real session.
  -- ============================================================
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- ============================================================
  -- 2. Authorization — caller must be an ACTIVE platform admin.
  -- ============================================================
  SELECT (po.role = 'admin' AND po.is_active)
    INTO v_caller_active_admin
    FROM platform_operators po
    WHERE po.user_id = auth.uid();

  IF NOT COALESCE(v_caller_active_admin, FALSE) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  -- ============================================================
  -- 3. Argument validation
  -- ============================================================

  -- Name is required (non-empty after trim).
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Workspace name is required' USING ERRCODE = '22023';
  END IF;

  -- CNPJ, if present, must be exactly 14 digits.
  IF p_cnpj IS NOT NULL AND p_cnpj !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'Invalid CNPJ format (expected 14 digits)'
      USING ERRCODE = '22023';
  END IF;

  -- Normalise owner email.
  v_owner_email_normal := btrim(COALESCE(p_owner_email, ''));

  -- Owner is REQUIRED — a client workspace cannot be born orphan.
  IF v_owner_email_normal = '' THEN
    RAISE EXCEPTION 'Workspace owner is required' USING ERRCODE = '22023';
  END IF;

  -- ============================================================
  -- 4. Owner lookup & disown previous account
  -- ============================================================
  SELECT au.id, COALESCE(au.raw_user_meta_data->>'full_name', au.email)
    INTO v_owner_user_id, v_owner_name
    FROM auth.users au
    WHERE au.email = v_owner_email_normal;

  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email %', v_owner_email_normal
      USING ERRCODE = '22023';
  END IF;

  -- Clear the user's old owner_user_id so the UNIQUE index
  -- (idx_accounts_one_per_owner) does not block the INSERT below.
  UPDATE accounts SET owner_user_id = NULL
  WHERE owner_user_id = v_owner_user_id;

  -- ============================================================
  -- 5. Create the Workspace
  -- ============================================================
  INSERT INTO accounts (name, owner_user_id, default_currency, cnpj)
  VALUES (btrim(p_name), v_owner_user_id, 'BRL', p_cnpj)
  RETURNING id INTO v_account_id;

  -- ============================================================
  -- 6. Associate the Owner's profile
  -- ============================================================
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role)
  VALUES (v_owner_user_id, v_owner_name, v_owner_email_normal, v_account_id, 'owner')
  ON CONFLICT (user_id) DO UPDATE SET
    account_id   = EXCLUDED.account_id,
    account_role = EXCLUDED.account_role;

  -- ============================================================
  -- 7. Self-associate the Superadmin as SUPERVISOR
  --    This is SUPERVISION, not ownership/membership.
  -- ============================================================
  INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by)
  VALUES (auth.uid(), v_account_id, 'admin', auth.uid());

  -- ============================================================
  -- 8. Audit — same transaction, real actor.
  -- ============================================================
  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action, metadata)
  VALUES (
    auth.uid(),
    v_account_id,
    'create_workspace',
    jsonb_build_object(
      'name',             btrim(p_name),
      'cnpj',             p_cnpj,
      'default_currency', 'BRL',
      'owner_user_id',    v_owner_user_id,
      'owner_email',      v_owner_email_normal
    )
  );

  RETURN v_account_id;
END;
$$;

ALTER FUNCTION create_platform_workspace(TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION create_platform_workspace(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_platform_workspace(TEXT, TEXT, TEXT) TO authenticated;
