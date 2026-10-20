-- =====================================================================
-- Z-API decommission — 01 INVENTORY (READ ONLY)
--
-- Run first, in the target database, by the person authorised to read it.
-- Only SELECTs (plus the two session SET/RESET lines below). Returns only
-- aggregates and technical identifiers: no token, secret, webhook hash,
-- phone number or message content is selected, and NO credential value is
-- used in any hash or fingerprint.
--
-- HOW TO RUN (see README, "Read-only protection and its limits"):
--   * Run it statement by statement or as a whole in a session where
--     [0] shows transaction_read_only = on. If [0] shows `off`, STOP.
--   * Statements [0]..[2] read only catalogs (pg_class, pg_attribute,
--     pg_proc, pg_constraint, pg_trigger). They reference NO application
--     table by name, so they always produce a diagnosis, even on a database
--     that lacks tables or columns.
--   * Statements [3]..[10] read application tables and WILL fail on a schema
--     that does not have them. Read [1] first: its `blocks_statements`
--     column says which of them cannot run. Do not "fix" the schema to make
--     them run; report [1].
--   * Save the whole output. 02/03 are compared against it.
-- =====================================================================

-- Session-level read-only protection. It works in autocommit and inside an
-- explicit transaction alike. It is a guard rail, not a security boundary:
-- the same session (or a superuser) can undo it. [0] reports its state.
SET default_transaction_read_only = on;

-- [0] Identity of the session. Technical identity does NOT prove that this
--     is the intended environment — the person who ran it must confirm the
--     project/host by other means (connection string they chose, dashboard).
--     The application schema is not detectable without assumption: the
--     migrations and PostgREST use `public`; [0] lists every schema that
--     holds a table with these names so a duplicate is visible.
SELECT current_database()                                        AS database_name,
       current_user                                              AS db_user,
       session_user                                              AS session_user_name,
       split_part(current_setting('server_version'), ' ', 1)     AS server_version,
       current_setting('transaction_read_only')                  AS transaction_read_only,
       current_setting('default_transaction_read_only')          AS default_read_only,
       current_setting('transaction_isolation')                  AS transaction_isolation,
       current_setting('search_path')                            AS search_path,
       (SELECT string_agg(n.nspname, ',' ORDER BY n.nspname)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'whatsapp_config' AND c.relkind IN ('r', 'p')) AS schemas_with_whatsapp_config,
       (SELECT string_agg(n.nspname, ',' ORDER BY n.nspname)
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'messages' AND c.relkind IN ('r', 'p'))         AS schemas_with_messages,
       now()                                                     AS observed_at;

-- [1] Schema contract of the delivery jobs. EVERY column below is read or
--     written by code in the repository:
--       cron          src/app/api/whatsapp/delivery/cron/route.ts
--       orphan-sweep  src/app/api/whatsapp/delivery/orphan-sweep/route.ts
--       createIntent  src/lib/whatsapp/delivery/settlement.ts
--       config/webhook/DLQ code and this runbook's own queries
--     `expected_udt` is the type the code assumes (e.g. connection_ref is
--     compared with whatsapp_config.id, so it must be uuid). Result per row:
--       OK            column exists with the expected type
--       MISSING       column (or its table) does not exist
--       TYPE_MISMATCH column exists with another type
--     `blocks_statements` lists the data statements of this file that fail
--     when the row is not OK. Rows that are not OK sort first.
SELECT *
FROM (
  SELECT e.tbl                                          AS table_name,
         e.col                                          AS column_name,
         e.expected_udt,
         cols.data_type,
         cols.udt_name,
         cols.is_nullable,
         CASE WHEN cols.attname IS NULL                 THEN 'MISSING'
              WHEN cols.udt_name <> e.expected_udt      THEN 'TYPE_MISMATCH'
              ELSE 'OK' END                             AS status,
         e.used_by,
         e.blocks_statements
  FROM (VALUES
    -- messages -------------------------------------------------------
    ('messages', 'id',                  'uuid',        'cron select; orphan-sweep select; createIntent insert', '[6][7][8]'),
    ('messages', 'conversation_id',     'uuid',        'cron select; orphan-sweep select; createIntent insert', '[6][7]'),
    ('messages', 'status',              'text',        'orphan-sweep filter (sending); createIntent insert',    '[6]'),
    ('messages', 'created_at',          'timestamptz', 'cron select; orphan-sweep select/filter',               '[6]'),
    ('messages', 'content_type',        'text',        'cron select; createIntent insert',                      ''),
    ('messages', 'content_text',        'text',        'cron select; createIntent insert',                      ''),
    ('messages', 'media_url',           'text',        'cron select; createIntent insert',                      ''),
    ('messages', 'template_name',       'text',        'cron select; createIntent insert',                      ''),
    ('messages', 'reply_to_message_id', 'uuid',        'cron select; createIntent insert',                      ''),
    ('messages', 'message_id',          'text',        'cron parent lookup (reply context)',                    ''),
    ('messages', 'sender_type',         'text',        'createIntent insert',                                   ''),
    ('messages', 'idempotency_key',     'uuid',        'createIntent insert (ODI-001)',                         ''),
    -- delivery binding (migration 083): written by createIntent in the same INSERT that
    -- creates an outbound message, read by cron / orphan-sweep before any re-send.
    ('messages', 'connection_ref',       'uuid', 'createIntent insert (083); cron/orphan-sweep read -> whatsapp_config.id', '[10]'),
    ('messages', 'delivery_provider',    'text', 'createIntent insert (083); cron/orphan-sweep read',                       '[10]'),
    ('messages', 'delivery_channel_fp',  'text', 'createIntent insert (083); cron/orphan-sweep read',                       '[10]'),
    -- outbound_retry_ledger -------------------------------------------
    ('outbound_retry_ledger', 'id',              'uuid',        'cron; orphan-sweep',                 '[8]'),
    ('outbound_retry_ledger', 'message_id',      'uuid',        'cron; orphan-sweep; UNIQUE',         '[7]'),
    ('outbound_retry_ledger', 'status',          'text',        'cron; orphan-sweep',                 '[7]'),
    ('outbound_retry_ledger', 'next_attempt_at', 'timestamptz', 'cron select/update; orphan-sweep',   '[7]'),
    ('outbound_retry_ledger', 'attempt_count',   'int4',        'cron select/update; orphan-sweep',   ''),
    ('outbound_retry_ledger', 'classification',  'text',        'cron select; orphan-sweep insert',   ''),
    ('outbound_retry_ledger', 'last_error',      'text',        'cron/orphan-sweep update',           ''),
    ('outbound_retry_ledger', 'created_at',      'timestamptz', 'cron select; TTL sweep',             ''),
    ('outbound_retry_ledger', 'updated_at',      'timestamptz', 'orphan-sweep reclaim of stuck retrying', ''),
    -- whatsapp_config -------------------------------------------------
    ('whatsapp_config', 'id',                  'uuid',        'cron/orphan-sweep lookup; DLQ FK',      '[7][8][9]'),
    ('whatsapp_config', 'account_id',          'uuid',        'cron/orphan-sweep; inventory joins',    '[3][6][7][8][9]'),
    ('whatsapp_config', 'provider',            'text',        'provider selection (providerConfigFromRow)', '[3][4][5][6][7][8][9]'),
    ('whatsapp_config', 'status',              'text',        'config route; 02/03',                   '[3][8][9]'),
    ('whatsapp_config', 'access_token',        'text',        'cron/orphan-sweep (decrypt); only a presence flag (IS NOT NULL) is used here, never the value', '[8]'),
    ('whatsapp_config', 'instance_id',         'text',        'provider config',                       '[8]'),
    ('whatsapp_config', 'base_url',            'text',        'provider config (uazapi)',              '[8]'),
    ('whatsapp_config', 'phone_number_id',     'text',        'provider config (Meta)',                ''),
    ('whatsapp_config', 'waba_id',             'text',        'Meta-only; legacy Z-API token holder (presence only here)',  '[3][5][8][9]'),
    ('whatsapp_config', 'connection_id',       'text',        'non-Meta webhook URL',                  '[8]'),
    ('whatsapp_config', 'webhook_secret_hash', 'text',        'non-Meta webhook auth (presence only)', '[3][8]'),
    ('whatsapp_config', 'connected_at',        'timestamptz', 'config route',                          '[8]'),
    ('whatsapp_config', 'updated_at',           'timestamptz', 'trigger-maintained; used as change detector', '[8]'),
    -- conversations / contacts (cron resolves the recipient through them) --
    ('conversations', 'id',         'uuid', 'cron: conversations -> contact',   '[6][7]'),
    ('conversations', 'account_id', 'uuid', 'tenant scope; inventory join',     '[6][7]'),
    ('conversations', 'contact_id', 'uuid', 'cron: embedded contacts(phone)',   ''),
    ('contacts',      'id',         'uuid', 'cron: embedded contacts(phone)',   ''),
    ('contacts',      'phone',      'text', 'cron: recipient (never selected here)', ''),
    -- whatsapp_webhook_dlq ----------------------------------------------
    ('whatsapp_webhook_dlq', 'id',                 'uuid',  'DLQ capture',                    '[8]'),
    ('whatsapp_webhook_dlq', 'whatsapp_config_id', 'uuid',  'FK ON DELETE CASCADE',           '[7]'),
    ('whatsapp_webhook_dlq', 'account_id',         'uuid',  'DLQ capture',                    ''),
    ('whatsapp_webhook_dlq', 'status',             'text',  'DLQ capture',                    '[7]'),
    ('whatsapp_webhook_dlq', 'payload',            'jsonb', 'DLQ capture (never selected here)', ''),
    -- message_external_ids ----------------------------------------------
    ('message_external_ids', 'message_id',     'uuid', 'settle_outbound_message*', ''),
    ('message_external_ids', 'connection_ref', 'uuid', 'settle_outbound_message* (this is where connection_ref really exists in the versioned schema)', '')
  ) AS e(tbl, col, expected_udt, used_by, blocks_statements)
  LEFT JOIN (
    SELECT c.relname, a.attname,
           format_type(a.atttypid, a.atttypmod)           AS data_type,
           t.typname                                      AS udt_name,
           CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t      ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  ) cols ON cols.relname = e.tbl AND cols.attname = e.col
) q
ORDER BY (q.status = 'OK'), q.table_name, q.column_name;

-- [1b] Tables and functions the jobs call. `present` = 0 means MISSING.
SELECT 'table' AS kind, t.name,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = t.name AND c.relkind IN ('r', 'p')) AS present
FROM (VALUES ('messages'), ('conversations'), ('contacts'), ('whatsapp_config'),
             ('outbound_retry_ledger'), ('whatsapp_webhook_dlq'), ('message_external_ids')) AS t(name)
UNION ALL
SELECT 'function', f.name,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = f.name)
FROM (VALUES ('settle_outbound_message'), ('settle_outbound_message_system'),
             ('enqueue_outbound_retry'), ('enqueue_outbound_retry_system'),
             ('enqueue_webhook_dlq'), ('insert_message_external_ids')) AS f(name)
ORDER BY 1, 2;

-- [2] Foreign keys that reference whatsapp_config, with their DELETE rule,
--     straight from the catalog of THE CONSULTED DATABASE, followed by the
--     tables reached transitively through CASCADE / SET NULL / SET DEFAULT
--     (what a DELETE of a config row would also erase or rewrite).
--     `in_versioned_migrations` compares with what the repository's
--     migrations declare (only whatsapp_webhook_dlq -> CASCADE). A `false`
--     means the database has a dependency the repository does not know about;
--     an expected dependency that is ABSENT here shows up in [2b].
--     No row does NOT mean "no dependency": it means none was found, and an
--     absent whatsapp_config table is reported by [1b], not here.
WITH RECURSIVE chain AS (
  SELECT con.oid AS con_oid, con.conname, con.conrelid, con.confrelid, con.confdeltype, con.conkey, 1 AS depth,
         ARRAY[con.conrelid] AS path
  FROM pg_constraint con
  WHERE con.contype = 'f' AND con.confrelid = to_regclass('public.whatsapp_config')
  UNION ALL
  SELECT c2.oid, c2.conname, c2.conrelid, c2.confrelid, c2.confdeltype, c2.conkey, ch.depth + 1,
         ch.path || c2.conrelid
  FROM pg_constraint c2
  JOIN chain ch ON c2.confrelid = ch.conrelid
  WHERE c2.contype = 'f'
    AND ch.confdeltype IN ('c', 'n', 'd')       -- the parent action propagates
    AND NOT (c2.conrelid = ANY (ch.path))        -- cycle guard
    AND ch.depth < 6
)
SELECT ch.depth,
       ch.conrelid::regclass::text AS dependent_table,
       ch.confrelid::regclass::text AS references_table,
       ch.conname AS constraint_name,
       (SELECT string_agg(a.attname, ',' ORDER BY a.attnum) FROM pg_attribute a
         WHERE a.attrelid = ch.conrelid AND a.attnum = ANY (ch.conkey)) AS columns,
       CASE ch.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                           WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule,
       'catalog of the consulted database' AS evidence,
       (ch.depth = 1 AND ch.conrelid::regclass::text IN ('whatsapp_webhook_dlq', 'public.whatsapp_webhook_dlq')
          AND ch.confdeltype = 'c') AS in_versioned_migrations
FROM chain ch
ORDER BY ch.depth, dependent_table, constraint_name;

-- [2b] Dependencies the VERSIONED migrations declare. `found_in_database` is
--      computed from the catalog; false = the repository and the database
--      disagree (drift) or the table is absent.
SELECT v.child_table, v.parent_table, v.rule AS versioned_delete_rule, 'versioned migration ' || v.migration AS evidence,
       EXISTS (SELECT 1 FROM pg_constraint con
                WHERE con.contype = 'f'
                  AND con.conrelid = to_regclass('public.' || v.child_table)
                  AND con.confrelid = to_regclass('public.' || v.parent_table)
                  AND con.confdeltype = CASE v.rule WHEN 'CASCADE' THEN 'c' END) AS found_in_database
FROM (VALUES ('whatsapp_webhook_dlq', 'whatsapp_config', 'CASCADE', '031')) AS v(child_table, parent_table, rule, migration);

-- [2c] Triggers on whatsapp_config (02 relies on the one that maintains
--      updated_at, and 03 uses updated_at as the change detector).
SELECT t.tgname AS trigger_name,
       pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
WHERE t.tgrelid = to_regclass('public.whatsapp_config') AND NOT t.tgisinternal
ORDER BY t.tgname;

-- [2d] Who can write messages.connection_ref / the binding columns besides the
--      application: triggers on messages, and functions whose source mentions
--      the column names. Catalog only (function BODIES are read, no data).
--      Expected: the settle_outbound_message* / insert_message_external_ids
--      functions (they use message_external_ids.connection_ref, a different
--      column). Review by hand any OTHER function, and any trigger on
--      messages: one that fills these columns from another source would
--      invalidate the binding contract.
SELECT 'trigger' AS kind, t.tgname AS name, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
WHERE t.tgrelid = to_regclass('public.messages') AND NOT t.tgisinternal
UNION ALL
SELECT 'function_mentions_binding_column', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', NULL
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.prosrc ILIKE '%delivery_provider%' OR p.prosrc ILIKE '%delivery_channel_fp%'
       OR p.prosrc ILIKE '%connection_ref%')
ORDER BY 1, 2;

-- [2e] Exact signatures of the functions the delivery jobs call. The TTL sweep
--      passes p_connection_ref = NULL (never ''): the parameter must be uuid
--      and accept NULL (DEFAULT NULL is expected, see migration 049/050).
SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_function_arguments(p.oid) AS arguments_with_defaults,
       p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('settle_outbound_message', 'settle_outbound_message_system',
                    'enqueue_outbound_retry', 'enqueue_outbound_retry_system',
                    'enqueue_webhook_dlq', 'insert_message_external_ids')
ORDER BY p.proname, identity_arguments;

-- ---------------------------------------------------------------------
-- From here on the statements read application tables. See the header.
-- ---------------------------------------------------------------------

-- [3] Connections by provider and status.
SELECT provider,
       status,
       count(*)                                         AS config_rows,
       count(DISTINCT account_id)                       AS accounts,
       count(*) FILTER (WHERE waba_id IS NOT NULL)      AS with_waba_id,
       count(*) FILTER (WHERE webhook_secret_hash IS NOT NULL) AS with_webhook_secret_hash
FROM public.whatsapp_config
GROUP BY provider, status
ORDER BY provider, status;

-- [4] Providers other than the supported ones (meta, uazapi). Expected: only
--     'zapi'. Anything else is unexpected and must be reviewed by hand.
SELECT provider, count(*) AS config_rows
FROM public.whatsapp_config
WHERE provider NOT IN ('meta', 'uazapi')
GROUP BY provider
ORDER BY provider;

-- [5] waba_id on non-Meta rows. waba_id is a Meta-only column (036). On a
--     uazapi row a non-NULL value can only be a leftover: either a plaintext
--     Meta WABA id (provider switched meta -> uazapi) or the encrypted Z-API
--     Security Token (zapi -> uazapi). The two cannot be told apart reliably
--     by content, so 02-decommission.sql does NOT touch these rows; they are
--     for manual review. (New uazapi saves now write waba_id = NULL.)
SELECT provider, count(*) AS rows_with_waba_id
FROM public.whatsapp_config
WHERE provider <> 'meta' AND waba_id IS NOT NULL
GROUP BY provider
ORDER BY provider;

-- [6] Work that will not be sent through any other provider: messages still
--     `sending` in accounts whose connection is zapi, by age bucket. The
--     relation is made through the ACCOUNT (messages -> conversations ->
--     whatsapp_config), because messages.connection_ref may not exist; it
--     assumes one whatsapp_config per account (UNIQUE since 017). A message
--     sent earlier through another provider in the same account is not
--     distinguishable here.
SELECT CASE
         WHEN m.created_at < now() - interval '72 hours' THEN 'older than TTL (72h)'
         WHEN m.created_at < now() - interval '5 minutes' THEN 'orphan candidate (5min..72h)'
         ELSE 'recent'
       END AS age_bucket,
       count(*) AS messages
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
JOIN public.whatsapp_config w ON w.account_id = c.account_id
WHERE w.provider = 'zapi' AND m.status = 'sending'
GROUP BY 1
ORDER BY 1;

-- [7] Retry ledger entries of those messages, by state, and DLQ rows of
--     zapi connections (history that a DELETE of the config row would erase).
SELECT 'ledger' AS source, l.status, (l.next_attempt_at IS NULL) AS blocked, count(*) AS rows_
FROM public.outbound_retry_ledger l
JOIN public.messages m ON m.id = l.message_id
JOIN public.conversations c ON c.id = m.conversation_id
JOIN public.whatsapp_config w ON w.account_id = c.account_id
WHERE w.provider = 'zapi'
GROUP BY l.status, (l.next_attempt_at IS NULL)
UNION ALL
SELECT 'webhook_dlq', d.status, NULL, count(*)
FROM public.whatsapp_webhook_dlq d
JOIN public.whatsapp_config w ON w.id = d.whatsapp_config_id
WHERE w.provider = 'zapi'
GROUP BY d.status
ORDER BY 1, 2;

-- [8] Reference values for 03-verify.sql. NONE of them involves a credential
--     value: the fingerprints hash only technical, non-secret columns and
--     PRESENCE flags (is not null). `updated_at` is included on purpose: the
--     set_updated_at trigger bumps it on any UPDATE, so a row changed by
--     mistake changes the fingerprint without the fingerprint needing the
--     changed (secret) column. If trigger [2c] is absent, treat the
--     fingerprint as weaker. sha256 is computed inside the database.
--     These values are a snapshot of a live system: counts of messages /
--     ledger / DLQ move with normal traffic, so 03 compares them only
--     against the snapshot 02 takes INSIDE its own transaction. Use the
--     values below as a staleness check (zapi row count, non-zapi
--     fingerprint) before deciding to proceed.
SELECT
  (SELECT count(*) FROM public.messages)               AS messages_count,
  (SELECT count(*) FROM public.outbound_retry_ledger)  AS ledger_count,
  (SELECT count(*) FROM public.whatsapp_webhook_dlq)   AS dlq_count,
  (SELECT count(*) FROM public.whatsapp_config WHERE provider = 'zapi') AS zapi_rows,
  (SELECT count(*) FROM public.whatsapp_config WHERE provider <> 'zapi') AS non_zapi_rows,
  (SELECT encode(sha256(convert_to(coalesce(string_agg(
            concat_ws('|', id::text, account_id::text, provider, status, coalesce(instance_id, ''),
                      coalesce(base_url, ''), coalesce(connection_id, ''), coalesce(connected_at::text, ''),
                      coalesce(updated_at::text, ''), (waba_id IS NOT NULL)::text,
                      (webhook_secret_hash IS NOT NULL)::text, (access_token IS NOT NULL)::text),
            ',' ORDER BY id), ''), 'UTF8')), 'hex')
     FROM public.whatsapp_config WHERE provider <> 'zapi') AS non_zapi_fingerprint;

-- [9] The rows 02-decommission.sql WOULD change (ids only, minimised).
SELECT id, account_id, status AS current_status, (waba_id IS NOT NULL) AS has_waba_id
FROM public.whatsapp_config
WHERE provider = 'zapi'
  AND (waba_id IS NOT NULL OR status <> 'disconnected')
ORDER BY id;

-- [10] Delivery-binding coverage of OUTBOUND messages created in the last 72 h
--      (the retry window), by state. Counts only; no content, phone or id.
--      After migration 083 AND the release that writes it, every NEW outbound
--      row must show has_binding = true; rows created before stay false and
--      are never re-sent automatically (that is expected, not a defect).
--      `config_same_account` = a whatsapp_config with that id exists AND
--      belongs to the conversation's account (the isolation rule of the
--      jobs); `provider_matches_snapshot` compares the provider recorded at
--      creation with the config's current provider (false after a switch).
SELECT m.status,
       (m.connection_ref IS NOT NULL AND m.delivery_provider IS NOT NULL AND m.delivery_channel_fp IS NOT NULL) AS has_binding,
       m.delivery_provider,
       (w.id IS NOT NULL) AS config_same_account,
       (w.provider = m.delivery_provider) AS provider_matches_snapshot,
       count(*) AS messages
FROM public.messages m
JOIN public.conversations c ON c.id = m.conversation_id
LEFT JOIN public.whatsapp_config w ON w.id = m.connection_ref AND w.account_id = c.account_id
WHERE m.sender_type IN ('agent', 'bot')
  AND m.created_at > now() - interval '72 hours'
GROUP BY 1, 2, 3, 4, 5
ORDER BY 1, 2, 3, 4, 5;

-- Leave the session as it was found.
RESET default_transaction_read_only;
