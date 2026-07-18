-- ============================================================
-- 036_webhook_nonmeta_security.sql — ADR-SEC-001 (C7)
--
-- Replace the legacy URL-secret webhook auth for non-Meta providers
-- (Z-API, uazapi) with an indexed, hashed-secret scheme:
--
--   /api/whatsapp/webhook/{provider}/{connectionId}/{webhookSecret}
--
-- Changes to whatsapp_config:
--   * connection_id        TEXT  — opaque, non-sequential, UNIQUE, indexed.
--                               Resolves the connection directly (no O(n)
--                               scan of every whatsapp_config of the provider).
--   * webhook_secret_hash  TEXT  — SHA-256 of the secret. The raw secret is
--                               NEVER stored; only the hash is persisted.
--
-- Explicitly OUT OF SCOPE (untouched):
--   * verify_token        — legacy field; preserved, NOT overwritten or
--                           deleted. After migration it is simply no longer
--                           used for non-Meta webhook auth.
--   * waba_id             — Meta only, untouched.
--   * client_token        — Z-API client token, untouched.
--   * C4 / insert_inbound_message — untouched.
--
-- Migration strategy: assisted (no permanent dual-mode).
--   * Existing rows get a connection_id backfilled here.
--   * webhook_secret_hash is left NULL; it is populated by the app-side
--     bootstrap (src/lib/whatsapp/webhook-auth.ts bootstrapConnection),
--     which generates a high-entropy secret, stores ONLY its hash, and
--     reveals the plaintext secret exactly once to the operator (who then
--     configures it in the Z-API / uazapi dashboard). No silent fallback
--     to verify_token is ever performed.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_id TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret_hash TEXT;

-- Opaque, non-sequential identifier. Backfill existing rows so they can be
-- resolved immediately; the app bootstrap later populates the secret hash.
UPDATE whatsapp_config
SET connection_id = gen_random_uuid()::text
WHERE connection_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_connection_id
  ON whatsapp_config (connection_id);

-- Add a NOT NULL + comment guard only after the backfill so the column is
-- always populated for every row (new rows get one from the app; this
-- migration guarantees historical ones already have one).
ALTER TABLE whatsapp_config
  ALTER COLUMN connection_id SET NOT NULL;
