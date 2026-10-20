-- =====================================================================
-- Z-API decommission — 03 VERIFY (reads only; run INSIDE the transaction
-- that ran 02, before COMMIT)
--
-- 02 stored a "before" snapshot in transaction-local settings. This script
-- compares the current state with it. It must run in the SAME transaction
-- (the settings do not outlive it) and that transaction must be REPEATABLE
-- READ, which 02 enforces. Every row of the result must have ok = true;
-- otherwise ROLLBACK.
--
-- Optionally-required reference values from 01-inventory.sql [8]:
--     SET LOCAL zapi_decommission.expected_zapi_rows = '<zapi_rows>';
--     SET LOCAL zapi_decommission.expected_non_zapi_fingerprint = '<non_zapi_fingerprint>';
-- Criteria 10 and 11 compare with them (state unchanged since the inventory
-- was read). They are REQUIRED: absent values make those rows fail.
--
-- What these checks prove and what they do not:
--   * counts and fingerprints computed inside one frozen snapshot show that
--     THIS transaction did not delete/insert rows or touch other providers'
--     rows or the zapi rows' other columns. They do not prove anything about
--     the data's content, about concurrent history, or about the backup.
--   * no credential value is read or output; only presence flags are hashed.
-- =====================================================================

WITH cur AS (
  SELECT
    (SELECT count(*) FROM public.messages)::text              AS messages,
    (SELECT count(*) FROM public.outbound_retry_ledger)::text AS ledger,
    (SELECT count(*) FROM public.whatsapp_webhook_dlq)::text  AS dlq,
    (SELECT count(*) FROM public.whatsapp_config WHERE provider = 'zapi')::text AS zapi_rows,
    (SELECT encode(sha256(convert_to(coalesce(string_agg(
            concat_ws('|', id::text, account_id::text, provider, status, coalesce(instance_id, ''),
                      coalesce(base_url, ''), coalesce(connection_id, ''), coalesce(connected_at::text, ''),
                      coalesce(updated_at::text, ''), (waba_id IS NOT NULL)::text,
                      (webhook_secret_hash IS NOT NULL)::text, (access_token IS NOT NULL)::text),
            ',' ORDER BY id), ''), 'UTF8')), 'hex')
       FROM public.whatsapp_config WHERE provider <> 'zapi') AS non_zapi_fingerprint,
    (SELECT encode(sha256(convert_to(coalesce(string_agg(
            concat_ws('|', id::text, account_id::text, provider, coalesce(instance_id, ''),
                      coalesce(base_url, ''), coalesce(connection_id, ''), coalesce(connected_at::text, ''),
                      (webhook_secret_hash IS NOT NULL)::text, (access_token IS NOT NULL)::text),
            ',' ORDER BY id), ''), 'UTF8')), 'hex')
       FROM public.whatsapp_config WHERE provider = 'zapi') AS zapi_other_columns
)
SELECT 1 AS n, 'transaction is repeatable read or stricter (snapshot is meaningful)' AS criterion,
       current_setting('transaction_isolation') AS observed,
       current_setting('transaction_isolation') IN ('repeatable read', 'serializable') AS ok
UNION ALL
SELECT 2, 'the "before" snapshot taken by 02 is present',
       CASE WHEN current_setting('zapi_decommission.before_messages', true) IS NULL THEN 'absent' ELSE 'present' END,
       current_setting('zapi_decommission.before_messages', true) IS NOT NULL
UNION ALL
SELECT 3, 'no zapi row is still connected',
       (SELECT count(*)::text FROM public.whatsapp_config WHERE provider = 'zapi' AND status <> 'disconnected'),
       (SELECT count(*) = 0 FROM public.whatsapp_config WHERE provider = 'zapi' AND status <> 'disconnected')
UNION ALL
SELECT 4, 'no zapi row keeps a waba_id',
       (SELECT count(*)::text FROM public.whatsapp_config WHERE provider = 'zapi' AND waba_id IS NOT NULL),
       (SELECT count(*) = 0 FROM public.whatsapp_config WHERE provider = 'zapi' AND waba_id IS NOT NULL)
UNION ALL
SELECT 5, 'zapi row count unchanged (nothing deleted or inserted)', cur.zapi_rows,
       cur.zapi_rows = current_setting('zapi_decommission.before_zapi_rows', true) FROM cur
UNION ALL
SELECT 6, 'non-zapi rows untouched (fingerprint of technical columns + presence flags + updated_at)', NULL,
       cur.non_zapi_fingerprint = current_setting('zapi_decommission.before_non_zapi_fingerprint', true) FROM cur
UNION ALL
SELECT 7, 'zapi rows: columns other than status/waba_id/updated_at untouched', NULL,
       cur.zapi_other_columns = current_setting('zapi_decommission.before_zapi_other_columns', true) FROM cur
UNION ALL
SELECT 8, 'messages row count unchanged', cur.messages,
       cur.messages = current_setting('zapi_decommission.before_messages', true) FROM cur
UNION ALL
SELECT 9, 'outbound_retry_ledger and whatsapp_webhook_dlq row counts unchanged (history preserved)',
       cur.ledger || ' / ' || cur.dlq,
       cur.ledger = current_setting('zapi_decommission.before_ledger', true)
         AND cur.dlq = current_setting('zapi_decommission.before_dlq', true) FROM cur
UNION ALL
SELECT 10, 'zapi row count equals the inventory reference (state unchanged since 01 [8])', cur.zapi_rows,
       cur.zapi_rows = coalesce(current_setting('zapi_decommission.expected_zapi_rows', true), '') FROM cur
UNION ALL
SELECT 11, 'non-zapi fingerprint equals the inventory reference (state unchanged since 01 [8])', NULL,
       cur.non_zapi_fingerprint = coalesce(current_setting('zapi_decommission.expected_non_zapi_fingerprint', true), '') FROM cur
ORDER BY n;
