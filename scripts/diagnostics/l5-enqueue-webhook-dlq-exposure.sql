-- ============================================================
-- l5-enqueue-webhook-dlq-exposure.sql  (READ-ONLY)
--
-- L5 (C6 audit): who can execute public.enqueue_webhook_dlq (031), and has
-- it already been used with an account/config mismatch?
--
-- Single statement (one WITH ... SELECT). Writes nothing. Not a migration
-- (do NOT copy it into supabase/migrations). Run it in a read-only session,
-- e.g. the Supabase SQL editor or psql, and keep the whole result row with
-- the date of the run:
--
--   BEGIN READ ONLY;  <this file>;  ROLLBACK;
--
-- Returns ZERO rows if the function does not exist in schema public.
-- Requires the roles anon / authenticated / service_role to exist
-- (they do on Supabase); has_function_privilege errors otherwise.
--
-- Privileges are EFFECTIVE ones: a NULL ACL means "default privileges"
-- (PUBLIC can execute), which acldefault() expands, so a NULL ACL is never
-- read as "no grants".
--
-- Columns:
--   function_signature, security_definer, owner, function_config, acl
--                                       the function as it is installed
--   execute_grantees                    every grantee holding EXECUTE
--                                       (PUBLIC shown as 'PUBLIC')
--   unexpected_execute_grantees         grantees other than the owner and
--                                       service_role (NULL when none)
--   public_can_execute                  EXECUTE granted to PUBLIC
--   anon_can_execute / authenticated_can_execute / service_role_can_execute
--                                       EFFECTIVE privilege (direct grant,
--                                       PUBLIC, or role inheritance)
--   client_roles_exposed                anon OR authenticated can execute
--                                       (true = the L5 exposure is present)
--   hardened                            TRUE only when: not exposed to PUBLIC,
--                                       anon or authenticated, service_role
--                                       can execute, and nobody else holds
--                                       EXECUTE. This is the PASS criterion
--                                       after migration 082.
--   dlq_rls_enabled / dlq_policy_count  RLS state of whatsapp_webhook_dlq
--   dlq_rows_total                      all rows in the DLQ
--   dlq_rows_account_config_mismatch    rows whose whatsapp_config does not
--                                       belong to the row's account_id; any
--                                       value > 0 is evidence of misuse (or of
--                                       a bug) and should be investigated
-- ============================================================
WITH f AS (
  SELECT
    p.oid,
    p.proowner,
    p.prosecdef,
    p.proconfig,
    p.proacl,
    p.oid::regprocedure::text AS signature,
    p.proowner::regrole::text AS owner_name,
    (SELECT array_agg(s.g ORDER BY s.g)
       FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
               FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
              WHERE a.privilege_type = 'EXECUTE') s) AS grantees
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'enqueue_webhook_dlq'
),
x AS (
  SELECT
    f.*,
    (SELECT array_agg(g ORDER BY g)
       FROM unnest(f.grantees) AS g
      WHERE g <> f.owner_name AND g <> 'service_role') AS unexpected,
    ('PUBLIC' = ANY (f.grantees))                                   AS public_exec,
    has_function_privilege('anon', f.oid, 'EXECUTE')                AS anon_exec,
    has_function_privilege('authenticated', f.oid, 'EXECUTE')       AS auth_exec,
    has_function_privilege('service_role', f.oid, 'EXECUTE')        AS svc_exec
  FROM f
)
SELECT
  now()              AS measured_at,
  current_database() AS database_name,
  x.signature        AS function_signature,
  x.prosecdef        AS security_definer,
  x.owner_name       AS owner,
  x.proconfig        AS function_config,
  x.proacl::text     AS acl,
  x.grantees         AS execute_grantees,
  x.unexpected       AS unexpected_execute_grantees,
  x.public_exec      AS public_can_execute,
  x.anon_exec        AS anon_can_execute,
  x.auth_exec        AS authenticated_can_execute,
  x.svc_exec         AS service_role_can_execute,
  (x.anon_exec OR x.auth_exec) AS client_roles_exposed,
  (NOT x.public_exec AND NOT x.anon_exec AND NOT x.auth_exec AND x.svc_exec
     AND COALESCE(cardinality(x.unexpected), 0) = 0) AS hardened,
  (SELECT relrowsecurity FROM pg_class
     WHERE oid = 'public.whatsapp_webhook_dlq'::regclass)        AS dlq_rls_enabled,
  (SELECT count(*) FROM pg_policy
     WHERE polrelid = 'public.whatsapp_webhook_dlq'::regclass)   AS dlq_policy_count,
  (SELECT count(*) FROM public.whatsapp_webhook_dlq)             AS dlq_rows_total,
  (SELECT count(*)
     FROM public.whatsapp_webhook_dlq d
     JOIN public.whatsapp_config c ON c.id = d.whatsapp_config_id
    WHERE c.account_id <> d.account_id)                          AS dlq_rows_account_config_mismatch
FROM x;
