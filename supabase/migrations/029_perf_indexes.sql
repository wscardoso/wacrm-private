-- ============================================================
-- Migration 029: Performance indexes
--
-- 1. pg_trgm extension + GIN index on contacts(phone_normalized)
--    to support LIKE '%suffix' lookups in findExistingContact.
-- 2. Unique index on conversations(account_id, contact_id) so the
--    webhook can use ON CONFLICT DO NOTHING instead of SELECT+INSERT.
-- 3. Composite index on messages(message_id, conversation_id) for
--    lookupInternalIdByMetaId.
-- ============================================================

-- 1. Trigram index for LIKE '%suffix' on contacts
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_contacts_phone_normalized_trgm
  ON contacts USING gin (phone_normalized gin_trgm_ops)
  WHERE phone_normalized <> '';

-- 2. Unique constraint so findOrCreateConversation can upsert
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations (account_id, contact_id);

-- 3. Composite index for message_id + conversation_id lookups
CREATE INDEX IF NOT EXISTS idx_messages_message_id_conversation
  ON messages (message_id, conversation_id);
