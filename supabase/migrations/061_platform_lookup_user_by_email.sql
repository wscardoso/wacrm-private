-- ============================================================
-- 061_platform_lookup_user_by_email.sql
-- E9 / Fase 2 (Equipe tab) — resolve an operator-candidate's e-mail
-- to their auth.users UUID, so "Invite operator" can accept an e-mail
-- (the natural input for an admin) while grant_platform_operator()
-- (037) keeps its existing UUID-only signature UNCHANGED.
--
-- Same limitation as create_platform_workspace()'s owner_email: the
-- target user must ALREADY have an account in the system. This RPC
-- does not create one.
--
-- Authorization: admin-gated, two DISTINCT checks with distinct
-- messages (not one collapsed check) — same pattern as 037's write
-- RPCs and the sibling platform_lookup_account_by_cnpj() (060):
--   1. auth.uid() IS NULL                      -> 'Unauthorized' / 42501
--   2. authenticated but not an active admin   -> 'This action requires
--                                                  an active platform
--                                                  admin' / 42501
--   3. no auth.users row for that e-mail       -> 'No user found with
--                                                  email %' / 22023
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION platform_lookup_user_id_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_active_admin BOOLEAN;
  v_user_id UUID;
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
  SELECT au.id INTO v_user_id FROM auth.users au
    WHERE au.email = btrim(p_email);
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'No user found with email %', p_email
      USING ERRCODE = '22023';
  END IF;
  RETURN v_user_id;
END;
$$;

ALTER FUNCTION platform_lookup_user_id_by_email(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION platform_lookup_user_id_by_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_lookup_user_id_by_email(TEXT) TO authenticated;
