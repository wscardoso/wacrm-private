-- 077_fix_list_platform_operators_email_type.sql
--
-- list_platform_operators() (062) declares `email TEXT` in its
-- RETURNS TABLE, but auth.users.email is `character varying(255)`.
-- PostgreSQL's function-return type check is strict on RETURN QUERY,
-- so every call fails at runtime with 42804 ("structure of query
-- does not match function result type") regardless of caller or role
-- — reproduced live against production (2026-09-09).
--
-- The client-side wrapper (src/lib/platform-ops/operators.ts) doesn't
-- recognize 42804 and falls through to a generic "unexpected" error,
-- which the Equipe tab (team-tab.tsx) then silently renders as an
-- empty operator list — masking the real failure as "no operators
-- registered yet" instead of surfacing an error.
--
-- Fix: cast au.email to text in the SELECT list. Signature (OUT
-- parameter types) is unchanged, so CREATE OR REPLACE is sufficient
-- — no DROP FUNCTION / no caller changes needed.
--
-- Idempotent — safe to re-run.

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
    au.email::TEXT,
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
