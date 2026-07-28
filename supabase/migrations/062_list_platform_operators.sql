-- ============================================================
-- 062_list_platform_operators.sql
-- E9 / Fase 2 (Equipe tab) — admin-only directory of platform
-- operators, with their assigned tenants.
--
-- Neither platform_operators nor platform_operator_accounts has any
-- SELECT policy for `authenticated` (037's own doc comment: "the
-- operator directory is not public... no client SELECT"). That
-- remains true and UNCHANGED by this migration — no policy is added
-- to either table. This RPC is the sole, narrow, admin-gated read
-- path into the directory, exactly like the other three read RPCs
-- added in this Sprint (059/060/061).
--
-- Admin-gated, not merely operator-gated: an active but non-admin
-- operator gets the same 42501 as an unauthenticated caller would (via
-- the second check below) — the operator directory stays invisible to
-- rank-and-file operators, consistent with 037's framing that grant/
-- revoke/assign are all admin-only actions. If a non-admin operator
-- could list every operator, they'd learn who else exists and what
-- they supervise without being able to act on any of it — an
-- information leak with no corresponding capability, so it is denied
-- outright rather than granted "for convenience".
--
-- Returns one row per operator (INCLUDING inactive/revoked ones, so an
-- admin can see and reactivate them) with their assigned tenants
-- aggregated inline as JSONB, to avoid a second round trip per
-- operator from the client (which would be an N+1 query pattern).
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION list_platform_operators()
RETURNS TABLE (
  user_id           UUID,
  email             TEXT,
  role              platform_operator_role,
  is_active         BOOLEAN,
  created_at        TIMESTAMPTZ,
  assigned_accounts JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_active_admin BOOLEAN;
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

  RETURN QUERY
  SELECT
    po.user_id,
    au.email,
    po.role,
    po.is_active,
    po.created_at,
    COALESCE(
      (
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'account_id', a.id,
                   'name', a.name,
                   'access_role', poa.access_role
                 )
                 ORDER BY a.name
               )
        FROM platform_operator_accounts poa
        JOIN accounts a ON a.id = poa.account_id
        WHERE poa.operator_user_id = po.user_id
      ),
      '[]'::jsonb
    ) AS assigned_accounts
  FROM platform_operators po
  JOIN auth.users au ON au.id = po.user_id
  ORDER BY po.created_at DESC;
END;
$$;

ALTER FUNCTION list_platform_operators() OWNER TO postgres;
REVOKE ALL ON FUNCTION list_platform_operators() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_platform_operators() TO authenticated;
