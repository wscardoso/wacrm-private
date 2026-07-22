-- ============================================================
-- 047_message_external_ids.sql — E2.1: External Message Identity
--
-- EIS-001 §3: Storage for the set of external identities of each message.
-- Each message can have N identities (wamid, provider_message_id, etc.)
-- declared by the provider at send time.
--
-- No client-side write policy exists. Writes happen exclusively through
-- the SECURITY DEFINER function insert_message_external_ids, called by
-- the delivery layer (settlement.ts) via supabase.rpc().
-- ============================================================

-- ------------------------------------------------------------
-- Table (EIS-001 §3.1)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_external_ids (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  connection_ref UUID NOT NULL,
  kind           TEXT NOT NULL,
  value          TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  message_external_ids IS 'EIS-001: External identities of each message, declared by the provider.';
COMMENT ON COLUMN message_external_ids.connection_ref IS 'References whatsapp_config.id in E2.0 regime; re-pointed to connections.id in E3 (EIS-001 §3.2).';
COMMENT ON COLUMN message_external_ids.kind IS 'Species: wamid, provider_message_id, provider_status_id — extensible set (EIS-001 §3.3).';

-- ------------------------------------------------------------
-- Uniqueness (EIS-001 §3.4)
-- One value, per connection, per kind → at most one message.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_meid_connection_kind_value
  ON message_external_ids (connection_ref, kind, value);

COMMENT ON INDEX uq_meid_connection_kind_value IS 'EIS-001 §3.4: uniqueness scoped to (connection, kind) — no cross-tenant presumption.';

-- ------------------------------------------------------------
-- Reverse read: all identities of a message
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_meid_message
  ON message_external_ids (message_id);

-- ------------------------------------------------------------
-- RLS (EIS-001 §3.5)
-- Read only — mirrors messages_select (038) scope.
-- No INSERT/UPDATE/DELETE policy: writes are SECURITY DEFINER only.
-- ------------------------------------------------------------
ALTER TABLE message_external_ids ENABLE ROW LEVEL SECURITY;

CREATE POLICY meid_select ON message_external_ids
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = message_external_ids.message_id
        AND (is_account_member(c.account_id) OR can_access_account(c.account_id))
    )
  );

-- ------------------------------------------------------------
-- SECURITY DEFINER function for writing identities
-- (EIS-001 §5.1, §5.4)
--
-- Called by the delivery layer (settlement.ts) via supabase.rpc().
-- Authenticated users can EXECUTE this function but have no direct
-- INSERT privilege on the table. Identities absent/null/empty are
-- omitted (the caller filters before calling).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_message_external_ids(p_identities JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO message_external_ids (message_id, connection_ref, kind, value)
  SELECT
    (item->>'message_id')::UUID,
    (item->>'connection_ref')::UUID,
    item->>'kind',
    item->>'value'
  FROM jsonb_array_elements(p_identities) AS item;
END;
$$;

REVOKE ALL ON FUNCTION insert_message_external_ids FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_message_external_ids TO authenticated;
