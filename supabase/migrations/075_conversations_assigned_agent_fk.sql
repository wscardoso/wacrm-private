-- ============================================================
-- 075_conversations_assigned_agent_fk.sql — C21
--
-- conversations.assigned_agent_id (001_initial_schema.sql:145) was
-- declared `UUID` with no FOREIGN KEY. Every legitimate writer stores
-- a profiles.user_id there:
--
--   - Inbox manual reassignment      message-thread.tsx:767 (dropdown
--                                     sources p.user_id, :963)
--   - Automation assign_conversation automations/engine.ts:469
--                                     (cfg.agent_id, or round_robin
--                                     falls back to profiles.user_id, :459-464)
--   - Flow assign node               flows/engine.ts:443 (cfg.assign_to)
--
-- profiles.user_id is NOT NULL, UNIQUE (001:22) and REFERENCES
-- auth.users(id) ON DELETE CASCADE — so it is a valid and unique FK
-- target for the assignment column.
--
-- Referential-integrity-only, by audit confirmation: the RLS policy
-- governing conversations (017_account_sharing.sql:414-417) is built
-- on is_account_member(account_id) and never reads
-- assigned_agent_id, so this constraint carries zero tenant-isolation
-- surface. It exists to stop a future writer from persisting an
-- agent id that points at nobody.
--
-- ON DELETE SET NULL mirrors the merge-ADR intent that an assignment
-- must never cascade into deleting conversation rows: if the agent's
-- profile is removed (which cascades from auth.users), the
-- conversation merely becomes unassigned, preserving history.
--
-- Defensive cleanup first: pre-existing rows may already hold
-- orphaned assigned_agent_id values that would abort the ALTER.
-- Nulling them out keeps the migration safe on real data.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- 1) Null any orphaned assignment before the FK can reject it.
UPDATE conversations
SET assigned_agent_id = NULL
WHERE assigned_agent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = conversations.assigned_agent_id
  );

-- 2) Drop any prior constraint with the same name, then add the FK.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_assigned_agent_id_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      DROP CONSTRAINT conversations_assigned_agent_id_fkey;
  END IF;
END $$;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_assigned_agent_id_fkey
    FOREIGN KEY (assigned_agent_id) REFERENCES profiles(user_id)
    ON DELETE SET NULL;

-- 3) Supporting index: profiles deletion (ON DELETE SET NULL) and any
-- future filter on assignment scan conversations.assigned_agent_id.
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_agent
  ON conversations (assigned_agent_id);
