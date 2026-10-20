-- =====================================================================
-- Z-API decommission — 02 DECOMMISSION (WRITES — NOT EXECUTED BY ANY
-- AUTOMATION; prepared for the authorised operator)
--
-- What it does, to rows with provider = 'zapi' ONLY:
--   * waba_id := NULL      the optional Z-API Security Token (client-token)
--                          was stored here, encrypted. waba_id is a Meta-only
--                          column (036); no code reads it for zapi any more.
--   * status  := 'disconnected'   an unsupported connection is not connected.
--
-- What it deliberately does NOT do:
--   * does not DELETE any row (whatsapp_webhook_dlq.whatsapp_config_id is
--     ON DELETE CASCADE: deleting a config would erase its DLQ history);
--   * does not touch access_token (NOT NULL; it is the Z-API instance token,
--     which must be REVOKED in the Z-API dashboard by the account owner —
--     nothing here revokes anything externally), webhook_secret_hash,
--     instance_id, connection_id or any timestamp other than updated_at;
--   * does not touch messages, outbound_retry_ledger or whatsapp_webhook_dlq.
--     Stuck `sending` messages of these accounts are resolved by the existing
--     TTL sweep (72h) — see README;
--   * does not touch any row of any other provider (meta, uazapi, unknown);
--   * does not convert the account to another provider or copy credentials.
--
-- Safety:
--   * Refuses to run unless the operator confirms, inside the same
--     transaction, that a verified backup exists, and unless the transaction
--     is REPEATABLE READ (or stricter): the "before" snapshot taken below and
--     the checks of 03-verify.sql must see the same frozen database, so live
--     traffic cannot be mistaken for an effect of this script (and a
--     concurrent change to a targeted row aborts with a serialization error
--     instead of being overwritten — retry after re-running the inventory):
--         BEGIN ISOLATION LEVEL REPEATABLE READ;
--         SET LOCAL zapi_decommission.backup_confirmed = 'yes';
--         \i 02-decommission.sql
--         SET LOCAL zapi_decommission.expected_zapi_rows = '<inventory [8] zapi_rows>';
--         SET LOCAL zapi_decommission.expected_non_zapi_fingerprint = '<inventory [8]>';
--         \i 03-verify.sql      -- same transaction; every row must be ok = true
--         COMMIT;                -- otherwise ROLLBACK;
--   * Idempotent: a second run matches no row (the predicate requires
--     waba_id IS NOT NULL or status <> 'disconnected').
--   * Concurrency: rows are locked (FOR UPDATE) and re-checked by the UPDATE.
--   * Reversal: restore (id, status, waba_id) of the rows listed by
--     01-inventory.sql [9] from the backup taken beforehand. There is no
--     other copy of the cleared values.
-- =====================================================================

DO $guard$
BEGIN
  IF coalesce(current_setting('zapi_decommission.backup_confirmed', true), '') <> 'yes' THEN
    RAISE EXCEPTION
      'zapi decommission refused: set zapi_decommission.backup_confirmed = ''yes'' (SET LOCAL, inside the transaction) only after a verified backup of whatsapp_config exists';
  END IF;
END
$guard$;

DO $guard2$
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION
      'zapi decommission refused: run inside BEGIN ISOLATION LEVEL REPEATABLE READ (current: %)',
      current_setting('transaction_isolation');
  END IF;
END
$guard2$;

-- "Before" snapshot, kept ONLY in transaction-local settings (set_config with
-- is_local = true): nothing is written to any table, and the settings vanish
-- at COMMIT/ROLLBACK. No credential value is read: the fingerprints hash
-- technical columns and PRESENCE flags only (same expressions as 01 [8]).
DO $snapshot$
BEGIN
  PERFORM set_config('zapi_decommission.before_messages', (SELECT count(*) FROM public.messages)::text, true);
  PERFORM set_config('zapi_decommission.before_ledger',   (SELECT count(*) FROM public.outbound_retry_ledger)::text, true);
  PERFORM set_config('zapi_decommission.before_dlq',      (SELECT count(*) FROM public.whatsapp_webhook_dlq)::text, true);
  PERFORM set_config('zapi_decommission.before_zapi_rows', (SELECT count(*) FROM public.whatsapp_config WHERE provider = 'zapi')::text, true);
  PERFORM set_config('zapi_decommission.before_non_zapi_fingerprint',
    (SELECT encode(sha256(convert_to(coalesce(string_agg(
            concat_ws('|', id::text, account_id::text, provider, status, coalesce(instance_id, ''),
                      coalesce(base_url, ''), coalesce(connection_id, ''), coalesce(connected_at::text, ''),
                      coalesce(updated_at::text, ''), (waba_id IS NOT NULL)::text,
                      (webhook_secret_hash IS NOT NULL)::text, (access_token IS NOT NULL)::text),
            ',' ORDER BY id), ''), 'UTF8')), 'hex')
       FROM public.whatsapp_config WHERE provider <> 'zapi'), true);
  -- Columns of the zapi rows that this script must NOT change (status, waba_id
  -- and updated_at are the intended changes and are excluded).
  PERFORM set_config('zapi_decommission.before_zapi_other_columns',
    (SELECT encode(sha256(convert_to(coalesce(string_agg(
            concat_ws('|', id::text, account_id::text, provider, coalesce(instance_id, ''),
                      coalesce(base_url, ''), coalesce(connection_id, ''), coalesce(connected_at::text, ''),
                      (webhook_secret_hash IS NOT NULL)::text, (access_token IS NOT NULL)::text),
            ',' ORDER BY id), ''), 'UTF8')), 'hex')
       FROM public.whatsapp_config WHERE provider = 'zapi'), true);
END
$snapshot$;

DO $run$
DECLARE
  affected integer;
BEGIN
  WITH target AS (
    SELECT id
    FROM public.whatsapp_config
    WHERE provider = 'zapi'
      AND (waba_id IS NOT NULL OR status <> 'disconnected')
    ORDER BY id
    FOR UPDATE
  )
  UPDATE public.whatsapp_config w
     SET waba_id = NULL,
         status  = 'disconnected'
    FROM target
   WHERE w.id = target.id
     AND w.provider = 'zapi';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'zapi decommission: % row(s) updated', affected;
END
$run$;
