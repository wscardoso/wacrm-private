-- ============================================================
-- 097_platform_audit_log_reader.sql
--
-- STATUS: LOCAL — NOT APPLIED to any remote database. Applying it needs
-- explicit authorization. Purely additive: one new function, no table or
-- policy touched.
--
-- Backs the /act/[accountId]/audit viewer. platform_audit_log (037) has a
-- SELECT policy but nothing in the product could page through it, and the
-- table has no embedded actor identity (only a user id). This function is
-- the read path:
--
--   * Authorization: SECURITY DEFINER; the caller must be an ACTIVE
--     platform operator authorized for p_account_id
--     (is_platform_operator_for — the same tenant-scoped predicate the
--     discovery and settings paths use). Everyone else, including tenant
--     members and unauthenticated sessions, gets 42501. The rows returned
--     are exactly those the 037 SELECT policy already lets this operator
--     read (target_account_id = p_account_id), so no new visibility is
--     created — only pagination and actor/target e-mail resolution.
--   * Pagination: keyset on the primary key (newest first). p_before_id is
--     the smallest id of the previous page; p_limit is clamped to
--     1..101 so a caller can request pageSize + 1 rows to know whether
--     another page exists.
--   * Identity: an e-mail is returned only for users that are platform
--     operators (internal staff). A tenant user who triggered a
--     context_access_denied row is reported as a non-operator with no
--     e-mail, so one tenant's users never leak to another's operators.
--
-- EXECUTE follows the 087 convention (PUBLIC, anon, authenticated and
-- service_role revoked explicitly, then authenticated granted).
--
-- Rollback: DROP FUNCTION list_platform_audit_log(UUID, INTEGER, BIGINT).
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION list_platform_audit_log(
  p_account_id UUID,
  p_limit      INTEGER DEFAULT 50,
  p_before_id  BIGINT  DEFAULT NULL
)
RETURNS TABLE (
  id                BIGINT,
  created_at        TIMESTAMPTZ,
  action            TEXT,
  actor_user_id     UUID,
  actor_email       TEXT,
  actor_is_operator BOOLEAN,
  target_user_id    UUID,
  target_user_email TEXT,
  metadata          JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NULL OR NOT is_platform_operator_for(p_account_id) THEN
    RAISE EXCEPTION 'Not authorized for this account' USING ERRCODE = '42501';
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 101);

  RETURN QUERY
  SELECT
    l.id,
    l.created_at,
    l.action,
    l.actor_user_id,
    CASE WHEN actor_op.user_id IS NOT NULL THEN actor_au.email::TEXT END,
    (actor_op.user_id IS NOT NULL),
    l.target_user_id,
    CASE WHEN target_op.user_id IS NOT NULL THEN target_au.email::TEXT END,
    l.metadata
  FROM platform_audit_log l
  LEFT JOIN platform_operators actor_op  ON actor_op.user_id  = l.actor_user_id
  LEFT JOIN auth.users         actor_au  ON actor_au.id       = actor_op.user_id
  LEFT JOIN platform_operators target_op ON target_op.user_id = l.target_user_id
  LEFT JOIN auth.users         target_au ON target_au.id      = target_op.user_id
  WHERE l.target_account_id = p_account_id
    AND (p_before_id IS NULL OR l.id < p_before_id)
  ORDER BY l.id DESC
  LIMIT v_limit;
END;
$$;

ALTER FUNCTION list_platform_audit_log(UUID, INTEGER, BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION list_platform_audit_log(UUID, INTEGER, BIGINT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION list_platform_audit_log(UUID, INTEGER, BIGINT) TO authenticated;
