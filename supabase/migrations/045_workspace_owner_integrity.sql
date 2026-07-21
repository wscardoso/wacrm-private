-- ============================================================
-- 045_workspace_owner_integrity.sql
-- P2.3-B — Prevent profile theft from existing workspaces
-- during provisioning.
--
-- Problem discovered during audit:
--   create_platform_workspace('WS B', null, 'x@email.com')
--     ↓
--   User X (already a member of Workspace A)
--     ↓
--   UPDATE accounts SET owner_user_id = NULL WHERE owner_user_id = user_X_id
--     ↓ disowns ANY account the user owned (not just the personal one)
--   INSERT INTO profiles ... ON CONFLICT (user_id) DO UPDATE SET account_id = new_ws
--     ↓ steals profile from Workspace A
--   Workspace A loses User X's membership without warning.
--
-- Fix (three changes):
--
--   1. Integrity guard — if the user's profile already points to a
--      workspace that is NOT their personal signup account, refuse.
--      The user already belongs to a real workspace (e.g. was invited
--      via redeem_invitation) and must not have their membership stolen.
--
--   2. Targeted disown — instead of the blanket
--        UPDATE accounts SET owner_user_id = NULL WHERE owner_user_id = v_owner_user_id
--      find the personal account by ID first, then only disown THAT
--      specific record. This prevents accidentally disowning a real
--      client workspace that happens to share the same owner_user_id.
--
--   3. Data-preserving delete — consistent with the redeem_invitation
--      pattern (migration 019): check for domain data in the personal
--      account. If data exists, disown (keep the data, orphan the old
--      account). If no data, delete the empty personal account.
--
-- What stays the same:
--   * p_owner_email is required (no DEFAULT NULL)
--   * p_cnpj is required (no DEFAULT NULL)
--   * Actor is always auth.uid()
--   * SECURITY DEFINER, SET search_path = public
--   * handle_new_user() and transfer_account_ownership() UNTOUCHED
--   * idx_accounts_one_per_owner preserved
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
  v_personal_account_id UUID;
  v_current_account_id  UUID;
  v_has_data            BOOLEAN;
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
  -- 4. Owner lookup
  -- ============================================================
  SELECT au.id, COALESCE(au.raw_user_meta_data->>'full_name', au.email)
    INTO v_owner_user_id, v_owner_name
    FROM auth.users au
    WHERE au.email = v_owner_email_normal;

  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email %', v_owner_email_normal
      USING ERRCODE = '22023';
  END IF;

  -- ============================================================
  -- 5. Integrity check — refuse if the user already belongs to a
  --    workspace that is NOT their personal signup account.
  --
  --    The personal account is the one created by handle_new_user at
  --    signup — it is the account where owner_user_id = v_owner_user_id.
  -- ============================================================

  -- 5a. Find the user's personal account (the one they own).
  SELECT id INTO v_personal_account_id
    FROM accounts
    WHERE owner_user_id = v_owner_user_id;

  -- 5b. Find where the user's profile currently points.
  SELECT account_id INTO v_current_account_id
    FROM profiles
    WHERE user_id = v_owner_user_id;

  -- 5c. If the profile points to a workspace that is NOT the user's
  --     personal account, the user already belongs to another workspace
  --     and moving them would steal their membership.
  --
  --     v_current_account_id can be NULL in theory (no profile row),
  --     and v_personal_account_id can be NULL if the personal account
  --     was already deleted (e.g. by a prior redeem_invitation). Both
  --     are allowed — only the theft scenario is blocked.
  IF v_current_account_id IS NOT NULL
     AND (v_personal_account_id IS NULL
          OR v_current_account_id != v_personal_account_id)
  THEN
    RAISE EXCEPTION 'User is already a member of another workspace'
      USING ERRCODE = '22023';
  END IF;

  -- ============================================================
  -- 6. Handle the personal account (consistent with
  --    redeem_invitation pattern from migration 019).
  --
  --    Pattern: check for domain data. If data exists, disown but
  --    preserve (don't destroy data). If no data, delete the empty
  --    personal account entirely.
  -- ============================================================
  IF v_personal_account_id IS NOT NULL THEN
    -- Check for real domain data in the personal account.
    SELECT EXISTS (
      SELECT 1 FROM contacts WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM conversations WHERE account_id = v_personal_account_id
      LIMIT 1
    ) INTO v_has_data;

    IF v_has_data THEN
      -- Account has real data — disown it but keep the data.
      UPDATE accounts SET owner_user_id = NULL
        WHERE id = v_personal_account_id;
    ELSE
      -- Empty personal account — delete it (same as redeem_invitation).
      DELETE FROM accounts WHERE id = v_personal_account_id;
    END IF;
  END IF;

  -- ============================================================
  -- 7. Create the Workspace
  -- ============================================================
  INSERT INTO accounts (name, owner_user_id, default_currency, cnpj)
  VALUES (btrim(p_name), v_owner_user_id, 'BRL', p_cnpj)
  RETURNING id INTO v_account_id;

  -- ============================================================
  -- 8. Associate the Owner's profile
  -- ============================================================
  INSERT INTO profiles (user_id, full_name, email, account_id, account_role)
  VALUES (v_owner_user_id, v_owner_name, v_owner_email_normal, v_account_id, 'owner')
  ON CONFLICT (user_id) DO UPDATE SET
    account_id   = EXCLUDED.account_id,
    account_role = EXCLUDED.account_role;

  -- ============================================================
  -- 9. Self-associate the Superadmin as SUPERVISOR
  --    This is SUPERVISION, not ownership/membership.
  -- ============================================================
  INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by)
  VALUES (auth.uid(), v_account_id, 'admin', auth.uid());

  -- ============================================================
  -- 10. Audit — same transaction, real actor.
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
