-- ============================================================
-- 043_workspace_provision_with_owner.sql
-- P2.3-B — Workspace provision now accepts an Owner.
--
-- What changed:
--   create_platform_workspace(p_name, p_cnpj)
--     → create_platform_workspace(p_name, p_cnpj, p_owner_email)
--
-- When p_owner_email is provided (non-empty):
--   1. Looks up the user in auth.users by email
--   2. Clears any existing owner_user_id reference from the user's
--      old personal account (so idx_accounts_one_per_owner does not
--      block the INSERT)
--   3. Creates the Workspace with owner_user_id set to the found UUID
--   4. UPSERTs profiles: if the user already has a profile (from
--      handle_new_user), UPDATEs account_id + account_role to point
--      to the new Workspace. If not, INSERTs with data from auth.users.
--   5. Self-associates the Superadmin as supervisor (unchanged)
--   6. Audit log includes owner info in metadata
--
-- p_owner_email is REQUIRED — a client workspace cannot be born orphan.
-- The RPC rejects NULL or empty owner_email with a clear error.
--
-- Why the approach matters:
--   * The old personal account (from handle_new_user) still exists but
--     the user's profile now points to the REAL client workspace.
--     This is the same pattern as redeem_invitation (019), which also
--     transfers users between accounts by updating profiles.account_id.
--   * idx_accounts_one_per_owner is preserved — the UNIQUE index
--     prevents two workspaces claiming the same owner simultaneously.
--   * The whole operation is a single transaction — any failure rolls
--     back EVERYTHING (account, profile clear, platform_operator_accounts,
--     audit log).
--   * The Superadmin does NOT become the owner or a member.
--
-- Invariants preserved (from 042):
--   * SECURITY DEFINER, SET search_path = public
--   * REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated
--   * actor ALWAYS auth.uid(), never from caller arguments
--   * No RLS policy changed
--   * handle_new_user() and transfer_account_ownership() UNTOUCHED
-- ============================================================

-- The old function signature is (TEXT, TEXT). Since we are adding a
-- third parameter, we must DROP and recreate (CREATE OR REPLACE cannot
-- change argument types/count).
DROP FUNCTION IF EXISTS create_platform_workspace(TEXT, TEXT);

CREATE OR REPLACE FUNCTION create_platform_workspace(
  p_name         TEXT,
  p_cnpj         TEXT DEFAULT NULL,
  p_owner_email  TEXT DEFAULT NULL
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
  -- Fetch user UUID + display name from auth.users.
  -- SECURITY DEFINER + postgres owner has access to the auth schema.
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
  -- The old personal account continues to exist but is disowned.
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
