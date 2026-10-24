-- ============================================================
-- 096_platform_tenant_metrics.sql
--
-- STATUS: LOCAL — NOT APPLIED to any remote database. Applying it needs
-- explicit authorization. Purely additive: one new function, no table or
-- policy touched.
--
-- Finding E-1 (/act audit): the control tower computed its per-tenant
-- numbers on the client from three unbounded SELECTs (all contacts, all
-- conversations, all of today's messages, across every supervised
-- tenant). PostgREST caps a response at its max-rows setting (Supabase
-- default 1000), so once the supervised tenants hold more rows than the
-- cap the counts silently stop growing, and the query errors were never
-- inspected (a failure rendered as "0" / "unconfigured").
--
-- list_platform_tenant_metrics() aggregates inside the database and
-- returns exactly one row per supervised tenant, so the response size is
-- bounded by the number of tenants, not by the number of contacts or
-- messages.
--
-- Authorization: SECURITY DEFINER, scoped ONLY by auth.uid() through
-- platform_operator_accounts joined to an ACTIVE platform_operators row —
-- the same predicate as list_platform_operator_accounts (039) and
-- list_platform_tenant_whatsapp_status (059). The caller supplies no
-- account list, so it cannot widen the scope. A non-operator, a revoked
-- operator, or an unauthenticated session gets zero rows.
--
-- p_messages_since: lower bound for messages_today (inclusive). NULL means
-- the start of the current UTC day — the same boundary the previous
-- client-side implementation used.
--
-- EXECUTE follows the 087 convention (PUBLIC, anon, authenticated and
-- service_role revoked explicitly, then authenticated granted).
--
-- Rollback: DROP FUNCTION list_platform_tenant_metrics(TIMESTAMPTZ).
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION list_platform_tenant_metrics(
  p_messages_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  account_id      UUID,
  contacts_count  BIGINT,
  unread_count    BIGINT,
  last_message_at TIMESTAMPTZ,
  messages_today  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scope AS (
    SELECT poa.account_id
    FROM platform_operator_accounts poa
    JOIN platform_operators po ON po.user_id = poa.operator_user_id
    WHERE poa.operator_user_id = auth.uid()
      AND po.is_active
  ),
  bounds AS (
    SELECT COALESCE(
             p_messages_since,
             date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           ) AS since
  )
  SELECT
    s.account_id,
    (SELECT count(*) FROM contacts c WHERE c.account_id = s.account_id)::BIGINT,
    (SELECT COALESCE(sum(cv.unread_count), 0) FROM conversations cv WHERE cv.account_id = s.account_id)::BIGINT,
    (SELECT max(cv.last_message_at) FROM conversations cv WHERE cv.account_id = s.account_id),
    (SELECT count(*)
       FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id
      WHERE cv.account_id = s.account_id
        AND m.created_at >= (SELECT since FROM bounds))::BIGINT
  FROM scope s;
$$;

ALTER FUNCTION list_platform_tenant_metrics(TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION list_platform_tenant_metrics(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION list_platform_tenant_metrics(TIMESTAMPTZ) TO authenticated;
