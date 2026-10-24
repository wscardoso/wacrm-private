-- ============================================================
-- 095_platform_context_audit_rpc_hardening.sql
--
-- STATUS: LOCAL — NOT APPLIED to any remote database. Applying it needs
-- explicit authorization. 037/038 are NOT edited; this migration only
-- replaces the three function bodies with CREATE OR REPLACE.
--
-- Finding E-2 (/act audit): log_platform_context_entered / _exited /
-- _denied (038) only checked `auth.uid() IS NOT NULL` and were executable
-- by every authenticated user. Any tenant member could therefore append
-- rows to platform_audit_log for ANY account id. The actor was always the
-- caller (no impersonation), but the rows are visible to the operators
-- supervising that account (platform_audit_log_select, 037), so a member
-- of tenant B could fill tenant A's operator-visible audit trail with
-- arbitrary context_entered / context_exited rows, at unbounded volume.
--
-- Fix:
--   * context_entered / context_exited are legitimate only for an ACTIVE
--     platform operator who can access the target account. That is the
--     exact gate requirePlatformContext() applies before it logs
--     (is_platform_operator() AND can_access_account()), so the app flow
--     is unchanged. Anyone else gets 42501.
--   * context_access_denied must stay callable by non-operators, because
--     recording "someone who is not authorized tried this tenant" is its
--     purpose. It is kept, but:
--       - a call for an account id that does not exist is recorded with a
--         NULL target and the attempted id in metadata (no FK error, no
--         difference observable by the caller, and the row is not
--         attributable to any real tenant's trail);
--       - at most 20 denied rows per actor per minute are stored; further
--         calls inside that window are dropped silently, so the function
--         cannot be used to flood the log.
--   * EXECUTE follows the 087 convention: PUBLIC, anon, authenticated and
--     service_role are revoked explicitly, then authenticated is granted.
--
-- Rollback: re-run the 038 definitions of the three functions.
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION log_platform_context_entered(p_target_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT (is_platform_operator() AND can_access_account(p_target_account_id)) THEN
    RAISE EXCEPTION 'Not authorized for this account' USING ERRCODE = '42501';
  END IF;

  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action)
  VALUES (auth.uid(), p_target_account_id, 'context_entered');
END;
$$;

CREATE OR REPLACE FUNCTION log_platform_context_exited(p_target_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT (is_platform_operator() AND can_access_account(p_target_account_id)) THEN
    RAISE EXCEPTION 'Not authorized for this account' USING ERRCODE = '42501';
  END IF;

  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action)
  VALUES (auth.uid(), p_target_account_id, 'context_exited');
END;
$$;

CREATE OR REPLACE FUNCTION log_platform_context_denied(p_target_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recent       INTEGER;
  v_target_exists BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Flood guard: bounded by actor, independent of the target.
  SELECT count(*) INTO v_recent
    FROM platform_audit_log
    WHERE actor_user_id = auth.uid()
      AND action = 'context_access_denied'
      AND created_at > NOW() - INTERVAL '1 minute';
  IF v_recent >= 20 THEN
    RETURN;
  END IF;

  SELECT EXISTS (SELECT 1 FROM accounts WHERE id = p_target_account_id)
    INTO v_target_exists;

  IF v_target_exists THEN
    INSERT INTO platform_audit_log (actor_user_id, target_account_id, action)
    VALUES (auth.uid(), p_target_account_id, 'context_access_denied');
  ELSE
    INSERT INTO platform_audit_log (actor_user_id, target_account_id, action, metadata)
    VALUES (
      auth.uid(),
      NULL,
      'context_access_denied',
      jsonb_build_object('attempted_account_id', p_target_account_id)
    );
  END IF;
END;
$$;

ALTER FUNCTION log_platform_context_entered(UUID) OWNER TO postgres;
ALTER FUNCTION log_platform_context_exited(UUID)  OWNER TO postgres;
ALTER FUNCTION log_platform_context_denied(UUID)  OWNER TO postgres;

REVOKE ALL ON FUNCTION log_platform_context_entered(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION log_platform_context_exited(UUID)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION log_platform_context_denied(UUID)  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION log_platform_context_entered(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION log_platform_context_exited(UUID)  TO authenticated;
GRANT EXECUTE ON FUNCTION log_platform_context_denied(UUID)  TO authenticated;
