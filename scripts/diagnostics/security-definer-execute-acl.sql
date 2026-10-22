-- ============================================================
-- security-definer-execute-acl.sql
--
-- READ-ONLY diagnostic. Safe to run on production: only SELECTs from
-- catalogs. It changes nothing.
--
-- Purpose: before applying 087_function_execute_acl_hardening.sql,
-- establish the REAL EXECUTE ACL of the SECURITY DEFINER functions that
-- the application is supposed to call with the service-role client.
--
-- Why PUBLIC alone is not the question: on Supabase, default privileges
-- grant EXECUTE explicitly to anon/authenticated/service_role. A
-- migration that only does `REVOKE ... FROM PUBLIC` leaves those ACL
-- entries behind (082 documents exactly this on enqueue_webhook_dlq).
-- `has_function_privilege` answers what a role can actually do, which
-- is the only thing that matters.
-- ============================================================

-- 1. Every SECURITY DEFINER function in public with its raw ACL and the
--    effective EXECUTE answer per role. Anything with anon=true or
--    authenticated=true in the "should be service-role only" list is a
--    finding.
SELECT
  p.oid::regprocedure                       AS function,
  pg_get_userbyid(p.proowner)               AS owner,
  p.prosecdef                               AS security_definer,
  p.proacl::text                            AS proacl,
  has_function_privilege('anon',           p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated',  p.oid, 'EXECUTE') AS authenticated_can_execute,
  has_function_privilege('service_role',   p.oid, 'EXECUTE') AS service_role_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
ORDER BY p.oid::regprocedure::text;

-- 2. Focus list: the functions 087 touches. If any row is missing, the
--    signature in the draft does not match the database and the
--    migration would fail on that statement — do not apply it blindly.
WITH expected(name, args) AS (
  VALUES
    ('enqueue_pending_attributions', ''),
    ('claim_enrichment_batch', 'integer, uuid'),
    ('resolve_enrichment_success', 'uuid, text, text, text, text, text, text, text'),
    ('resolve_enrichment_failure', 'uuid, text, text, integer'),
    ('reclaim_stuck_enrichment', ''),
    ('expire_stale_enrichments', ''),
    ('get_enrichment_report', 'uuid'),
    ('get_ad_account_credential', 'uuid'),
    ('set_ad_account_credential', 'uuid, text, timestamp with time zone'),
    ('revoke_ad_account_credential', 'uuid, text')
)
SELECT
  e.name || '(' || e.args || ')' AS expected_signature,
  to_regprocedure('public.' || e.name || '(' || e.args || ')') IS NOT NULL AS exists,
  COALESCE(has_function_privilege(
    'anon', to_regprocedure('public.' || e.name || '(' || e.args || ')'), 'EXECUTE'
  ), false) AS anon_can_execute,
  COALESCE(has_function_privilege(
    'authenticated', to_regprocedure('public.' || e.name || '(' || e.args || ')'), 'EXECUTE'
  ), false) AS authenticated_can_execute
FROM expected e
ORDER BY e.name;

-- 3. Same question for enqueue_webhook_dlq (082): regression guard. It
--    was reported hardened by the operator on 2026-10-18; this confirms
--    the state did not drift (e.g. a later CREATE OR REPLACE with a new
--    default ACL).
SELECT
  p.oid::regprocedure AS function,
  has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'enqueue_webhook_dlq';

-- 4. Default privileges that create the problem, for the record. A row
--    granting EXECUTE ON FUNCTIONS to anon/authenticated means every new
--    function starts exposed unless the migration revokes explicitly.
SELECT
  pg_get_userbyid(d.defaclrole) AS grantor,
  n.nspname                     AS schema,
  d.defaclobjtype               AS object_type,
  d.defaclacl::text             AS acl
FROM pg_default_acl d
LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
ORDER BY 1, 2, 3;
