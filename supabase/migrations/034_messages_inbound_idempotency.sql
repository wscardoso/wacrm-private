-- ============================================================
-- 034_messages_inbound_idempotency.sql — C4: inbound message idempotency
--
-- WhatsApp providers (Meta, Z-API, uazapi) redeliver webhooks on
-- timeout / error. Both inbound pipelines
--   - src/app/api/whatsapp/webhook/route.ts      (Meta, inline)
--   - src/lib/whatsapp/inbound-processor.ts      (Z-API / uazapi)
-- INSERT into `messages` with no uniqueness guard, so a redelivery
-- creates a duplicate inbox row (and, before this change, double-counted
-- unread and re-fired flows/automations).
--
-- Canonical idempotency key: (conversation_id, message_id) — validated
-- against the code as stable (conversation_id is immutable per message;
-- no reassignment/merge flow exists) and provider-agnostic (the adapters
-- normalise the provider message id into `messages.message_id`).
--
-- This migration:
--   1. Defines `dedupe_inbound_messages()` — a deterministic cleanup that
--      collapses pre-existing duplicate inbound rows, keeping the OLDEST
--      per key and consolidating dependent `message_reactions` across the
--      ENTIRE duplicate group (not just keeper-vs-duplicate), then
--      repointing `messages.reply_to_message_id` and deleting non-keepers.
--   2. Creates a partial UNIQUE index enforcing the key for inbound
--      (customer) messages only, excluding NULL / '' message_ids.
--
-- The application performs idempotent inserts via the RPC
-- `insert_inbound_message()` (migration 035), which uses
--   ON CONFLICT (conversation_id, message_id)
--     WHERE sender_type='customer' AND message_id IS NOT NULL AND message_id <> ''
--     DO NOTHING
-- RETURNING id
-- so redelivery yields zero rows and the app short-circuits downstream
-- effects.
--
-- Runs inside the migration transaction. NOT CONCURRENTLY — the cleanup
-- and index creation must be atomic.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Deterministic dedupe, group-aware reaction consolidation.
--    Exposed as a function so it can be unit-tested against real
--    PostgreSQL (PGlite) and re-invoked if needed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dedupe_inbound_messages()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removed INTEGER := 0;
BEGIN
  -- Identify duplicate groups and the keeper per group.
  -- dup_rows: every message in a group that has >1 member, tagged with
  -- its keeper (oldest by created_at, then id).
  WITH groups AS (
    SELECT
      id,
      conversation_id,
      message_id,
      first_value(id) OVER w AS keeper_id
    FROM messages
    WHERE sender_type = 'customer'
      AND message_id IS NOT NULL
      AND message_id <> ''
    WINDOW w AS (
      PARTITION BY conversation_id, message_id
      ORDER BY created_at ASC, id ASC
    )
  ),
  dup_groups AS (
    -- groups with more than one member
    SELECT conversation_id, message_id, keeper_id
    FROM groups
    GROUP BY conversation_id, message_id, keeper_id
    HAVING count(*) > 1
  ),
  dup_rows AS (
    -- every row that belongs to a multi-member group
    SELECT g.id AS dup_id, dg.keeper_id
    FROM groups g
    JOIN dup_groups dg
      ON dg.conversation_id = g.conversation_id
     AND dg.message_id = g.message_id
  ),
  -- All reactions across the whole group (keeper + duplicates), with the
  -- actor identity used to detect logical conflicts.
  group_reactions AS (
    SELECT
      r.id AS reaction_id,
      r.message_id,
      r.actor_type,
      r.actor_id,
      dr.keeper_id,
      -- winning reaction per (keeper, actor_type, actor_id):
      -- prefer the one already on the keeper; otherwise the oldest.
      first_value(r.id) OVER (
        PARTITION BY dr.keeper_id, r.actor_type, r.actor_id
        ORDER BY
          CASE WHEN r.message_id = dr.keeper_id THEN 0 ELSE 1 END,
          r.created_at ASC,
          r.id ASC
      ) AS winning_reaction_id
    FROM message_reactions r
    JOIN dup_rows dr ON dr.dup_id = r.message_id
  ),
  -- Reactions to delete: anything in the group that is NOT the winner for
  -- its (keeper, actor) identity.
  to_delete AS (
    SELECT reaction_id FROM group_reactions
    WHERE reaction_id <> winning_reaction_id
  ),
  -- Repoint the survivors onto the keeper before deleting the dups.
  repointed AS (
    UPDATE message_reactions r
    SET message_id = gr.keeper_id
    FROM group_reactions gr
    WHERE r.id = gr.winning_reaction_id
      AND gr.winning_reaction_id <> gr.keeper_id
    RETURNING r.id
  )
  -- delete losing reactions
  DELETE FROM message_reactions r
  USING to_delete d
  WHERE r.id = d.reaction_id;

  -- Repoint replies that point at any duplicate onto the keeper
  -- (FK is ON DELETE SET NULL, so do this before deleting dups).
  WITH groups AS (
    SELECT
      id,
      conversation_id,
      message_id,
      first_value(id) OVER w AS keeper_id
    FROM messages
    WHERE sender_type = 'customer'
      AND message_id IS NOT NULL
      AND message_id <> ''
    WINDOW w AS (
      PARTITION BY conversation_id, message_id
      ORDER BY created_at ASC, id ASC
    )
  ),
  dup_groups AS (
    SELECT conversation_id, message_id, keeper_id
    FROM groups
    GROUP BY conversation_id, message_id, keeper_id
    HAVING count(*) > 1
  ),
  dup_rows AS (
    SELECT g.id AS dup_id, dg.keeper_id
    FROM groups g
    JOIN dup_groups dg
      ON dg.conversation_id = g.conversation_id
     AND dg.message_id = g.message_id
  )
  UPDATE messages m
  SET reply_to_message_id = dr.keeper_id
  FROM dup_rows dr
  WHERE m.reply_to_message_id = dr.dup_id;

  -- Finally delete the non-keeper duplicate rows.
  WITH groups AS (
    SELECT
      id,
      conversation_id,
      message_id,
      first_value(id) OVER w AS keeper_id
    FROM messages
    WHERE sender_type = 'customer'
      AND message_id IS NOT NULL
      AND message_id <> ''
    WINDOW w AS (
      PARTITION BY conversation_id, message_id
      ORDER BY created_at ASC, id ASC
    )
  ),
  dup_groups AS (
    SELECT conversation_id, message_id, keeper_id
    FROM groups
    GROUP BY conversation_id, message_id, keeper_id
    HAVING count(*) > 1
  ),
  dup_rows AS (
    SELECT g.id AS dup_id
    FROM groups g
    JOIN dup_groups dg
      ON dg.conversation_id = g.conversation_id
     AND dg.message_id = g.message_id
    WHERE g.id <> dg.keeper_id
  )
  DELETE FROM messages m
  USING dup_rows d
  WHERE m.id = d.dup_id;

  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RAISE NOTICE '[034] dedupe_inbound_messages removed % duplicate inbound rows', v_removed;
  RETURN v_removed;
END $$;

REVOKE ALL ON FUNCTION dedupe_inbound_messages() FROM PUBLIC;
REVOKE ALL ON FUNCTION dedupe_inbound_messages() FROM anon;
REVOKE ALL ON FUNCTION dedupe_inbound_messages() FROM authenticated;
GRANT EXECUTE ON FUNCTION dedupe_inbound_messages() TO service_role;

-- ------------------------------------------------------------
-- 2. Run the cleanup FIRST — while the partial unique index does not
--    yet exist. If we created the index before deduping, the pre-existing
--    duplicate rows would make CREATE UNIQUE INDEX fail outright. The
--    dedupe collapses them; THEN the index is safe to build, and it
--    guards all future inserts via the RPC.
-- ------------------------------------------------------------
SELECT dedupe_inbound_messages();

-- ------------------------------------------------------------
-- 3. Partial UNIQUE index — the idempotency guard.
--    Inbound (customer) messages only; outbound (agent/bot) rows also
--    carry message_id and must not collide with the inbound key.
--    NULL / '' excluded (Z-API can emit an empty message id).
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conv_msgid_customer
  ON messages (conversation_id, message_id)
  WHERE sender_type = 'customer'
    AND message_id IS NOT NULL
    AND message_id <> '';
