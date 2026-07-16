-- 032_whatsapp_provider.sql
-- Add multi-provider support to whatsapp_config.
--
-- provider   : 'meta' (default) | 'zapi' | 'uazapi'
-- instance_id: Z-API instance ID or uazapi instance name
-- base_url   : uazapi server URL (e.g. https://my.uazapi.dev)

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider   TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS instance_id TEXT,
  ADD COLUMN IF NOT EXISTS base_url    TEXT;

-- Existing rows are implicitly Meta
UPDATE whatsapp_config SET provider = 'meta' WHERE provider IS NULL OR provider = '';
