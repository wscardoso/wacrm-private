-- ============================================================
-- 083_messages_delivery_binding.sql
--
-- STATUS: PREPARED. NOT APPLIED to any database by this repository's
-- tooling. It must be applied by an authorised operator BEFORE the
-- application release that writes these columns (see
-- docs/operations/zapi-decommission/delivery-binding-rollout.md):
-- code that inserts them into a database that lacks them fails every
-- outbound send.
--
-- Records, on every OUTBOUND message and in the same INSERT that creates
-- it, the channel it was created for:
--
--   connection_ref       UUID  whatsapp_config.id at creation. Semantics of
--                              EIS-001 §3.2 (becomes connections.id in E3);
--                              no FK, as that decision states.
--   delivery_provider    TEXT  'meta' | 'uazapi' (validated by the application;
--                              no CHECK, so a future provider needs no DDL).
--   delivery_channel_fp  TEXT  'v1:' + sha256 hex of the non-secret channel
--                              identity (provider, phone_number_id /
--                              instance_id + base_url). Format: see
--                              src/lib/whatsapp/delivery/connection-binding.ts.
--
-- Why a snapshot and not the config id alone: whatsapp_config is updated in
-- place, so its id survives a change of provider, number or instance. The
-- retry jobs re-send a message only when the connection that exists now
-- reproduces this snapshot and belongs to the conversation's account.
--
-- Deliberately NOT done here:
--   * no default, no NOT NULL, no FK, no index (no query filters by these
--     columns; the jobs read them by messages.id);
--   * no backfill. Older messages stay NULL on purpose: the account's current
--     provider says nothing about the provider that sent them, and there is
--     no history of provider changes. NULL = "cannot be re-sent
--     automatically". The retry window is 72 h, so the population that
--     matters drains by itself after the release.
--
-- Safe to re-run (ADD COLUMN IF NOT EXISTS). If a column of the same name
-- ALREADY exists with a different type — e.g. a `connection_ref` created out
-- of band — the migration stops before changing anything: adopting an
-- unversioned column needs a decision, not a guess.
-- ============================================================

DO $guard$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT a.attname AS col, t.typname AS actual,
           CASE a.attname WHEN 'connection_ref' THEN 'uuid' ELSE 'text' END AS wanted
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t      ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relname = 'messages' AND c.relkind IN ('r', 'p')
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attname IN ('connection_ref', 'delivery_provider', 'delivery_channel_fp')
  LOOP
    IF rec.actual <> rec.wanted THEN
      RAISE EXCEPTION
        '083: messages.% already exists with type % (expected %); refusing to adopt it silently',
        rec.col, rec.actual, rec.wanted;
    END IF;
  END LOOP;
END
$guard$;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS connection_ref       UUID,
  ADD COLUMN IF NOT EXISTS delivery_provider    TEXT,
  ADD COLUMN IF NOT EXISTS delivery_channel_fp  TEXT;

COMMENT ON COLUMN public.messages.connection_ref IS
  'Outbound only. whatsapp_config.id of the connection the message was created for (EIS-001 §3.2; connections.id in E3). NULL on inbound and on messages created before 083: such a message is never re-sent automatically.';
COMMENT ON COLUMN public.messages.delivery_provider IS
  'Outbound only. Provider the message was created for (meta | uazapi). Snapshot: whatsapp_config.provider can change later.';
COMMENT ON COLUMN public.messages.delivery_channel_fp IS
  'Outbound only. v<version>:<sha256 hex> of the non-secret channel identity at creation. A retry proceeds only if the current connection reproduces it.';

-- PostgREST caches the schema; without a reload the new columns are unknown to it.
NOTIFY pgrst, 'reload schema';
