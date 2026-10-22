-- ============================================================
-- r2-dc-phantom-measurement.sql  (READ-ONLY)
--
-- R2 (ADR-MSG-STATUS-001 §2.6 / roadmap §17): reproducible measurement of
-- the D-C footprint — customer messages written for provider callbacks
-- that were not real customer messages ("phantoms").
--
-- This is a single SELECT. It writes nothing, takes no locks beyond
-- ordinary read snapshots, and is not a migration (do NOT copy it into
-- supabase/migrations). Run it manually, e.g. in a read-only session:
--
--   BEGIN READ ONLY;  <this file>;  ROLLBACK;
--
-- Scope: GLOBAL (all accounts) — the same universe as the 2026-07-29
-- measurement recorded in the roadmap. No per-account dimension.
--
-- Columns:
--   measured_at / database_name   context of the run (keep with the result)
--   messages_total                all rows in messages
--   messages_customer             rows with sender_type = 'customer'
--   phantom_customer_empty_id     customer AND message_id = ''
--   phantom_customer_null_id      customer AND message_id IS NULL
--   phantom_strict                customer AND content_text IS NULL
--                                 AND (message_id = '' OR message_id IS NULL)
--   webhook_dlq_total             all rows in whatsapp_webhook_dlq
--
-- Reading the result: phantom_strict = 0 means no D-C phantom signature in
-- the table at the time of the run. It is evidence about stored rows only;
-- it does not prove the parser/route is free of the defect.
-- ============================================================
SELECT
  now()              AS measured_at,
  current_database() AS database_name,
  (SELECT count(*) FROM messages)                                          AS messages_total,
  (SELECT count(*) FROM messages WHERE sender_type = 'customer')           AS messages_customer,
  (SELECT count(*) FROM messages
     WHERE sender_type = 'customer' AND message_id = '')                   AS phantom_customer_empty_id,
  (SELECT count(*) FROM messages
     WHERE sender_type = 'customer' AND message_id IS NULL)                AS phantom_customer_null_id,
  (SELECT count(*) FROM messages
     WHERE sender_type = 'customer'
       AND content_text IS NULL
       AND (message_id = '' OR message_id IS NULL))                        AS phantom_strict,
  (SELECT count(*) FROM whatsapp_webhook_dlq)                              AS webhook_dlq_total;
