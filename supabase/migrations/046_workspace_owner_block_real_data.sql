-- ============================================================
-- 046_workspace_owner_block_real_data.sql
-- P2.3-B — Block provisioning when the target account has real
-- tenant data. Expand the data check to cover ALL tenant-domain
-- tables (matching redeem_invitation 019).
--
-- Problems fixed:
--
--   Problem 1 — Owner of a real workspace can still be disowned.
--     After a first provisioning, the user's personal account is
--     deleted and the provisioned workspace takes owner_user_id.
--     A second provisioning call would find THAT workspace via
--     WHERE owner_user_id = v_owner_user_id and, since profile
--     and owner match, pass the integrity check. Then the data
--     check (only contacts + conversations in 045) might miss
--     other tables, causing the real workspace to be disowned.
--
--     Fix: change the data check from "disown if data exists" to
--     "BLOCK if data exists". A personal account with real tenant
--     data is no longer a fresh personal account — it is a real
--     workspace that must not be silently orphaned.
--
--   Problem 2 — Data check was too narrow.
--     Only contacts + conversations were checked. A workspace
--     with deals, pipelines, flows, etc. would pass the check
--     as "no data" and be deleted or disowned.
--
--     Fix: check ALL tenant-domain tables exactly like
--     redeem_invitation (migration 019). If ANY one has a row,
--     the account has real data and provisioning is blocked.
--
-- Behavioral change:
--   Before (045):
--     personal account has data → disown (set owner_user_id = NULL)
--     personal account empty    → delete
--   After (046):
--     account has data → BLOCK (raise exception)
--     account empty    → delete (same as before)
--
-- This is safe because:
--   * A fresh personal account (just created by handle_new_user)
--     has ZERO tenant data — it will be deleted and replaced.
--   * A provisioned workspace (or a personal account where the
--     user started working) has data — it will be protected.
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
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Workspace name is required' USING ERRCODE = '22023';
  END IF;
  IF p_cnpj IS NOT NULL AND p_cnpj !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'Invalid CNPJ format (expected 14 digits)'
      USING ERRCODE = '22023';
  END IF;
  v_owner_email_normal := btrim(COALESCE(p_owner_email, ''));
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
  --    workspace that is NOT their personal account.
  -- ============================================================
  SELECT id INTO v_personal_account_id
    FROM accounts
    WHERE owner_user_id = v_owner_user_id;

  SELECT account_id INTO v_current_account_id
    FROM profiles
    WHERE user_id = v_owner_user_id;

  IF v_current_account_id IS NOT NULL
     AND (v_personal_account_id IS NULL
          OR v_current_account_id != v_personal_account_id)
  THEN
    RAISE EXCEPTION 'User is already a member of another workspace'
      USING ERRCODE = '22023';
  END IF;

  -- ============================================================
  -- 6. Data guard — if the account has real tenant data, it is a
  --    real workspace and must not be silently replaced.
  --
  --    We check every tenant-domain table (same comprehensive list
  --    used by redeem_invitation in migration 019). If ANY one has
  --    a row for this account, the account is "real" and we refuse.
  --    Only a truly empty account (fresh personal account) may be
  --    deleted and replaced.
  -- ============================================================
  IF v_personal_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM contacts        WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM conversations   WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM broadcasts      WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM automations     WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM flows           WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM flow_runs       WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM pipelines       WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM deals           WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM message_templates WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM tags            WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM custom_fields   WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM contact_notes   WHERE account_id = v_personal_account_id
      UNION ALL
      SELECT 1 FROM whatsapp_config WHERE account_id = v_personal_account_id
      LIMIT 1
    ) INTO v_has_data;

    IF v_has_data THEN
      RAISE EXCEPTION 'User already has data in their current workspace; provision a new account'
        USING ERRCODE = '22023';
    END IF;

    -- Empty personal account — delete it and proceed.
    DELETE FROM accounts WHERE id = v_personal_account_id;
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
