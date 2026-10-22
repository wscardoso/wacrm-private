-- 086_messages_direct_write_hardening.sql
--
-- STATUS: PREPARED — NOT APPLIED
--   Written locally on branch local/post-audit-a-sql (base a203a1e). It has
--   NOT been applied to any database. It is exercised only against in-memory
--   PGlite by src/test/messages-direct-write-hardening.pglite.test.ts, which
--   runs the real chain 001..086. It is independent of 085 (the facade patch):
--   either can be applied alone; the order 085 -> 086 is only a convention.
--   An authorised operator applies it, after the capture and verification
--   steps below.
--
-- DEFECT (post-audit item 5)
--   The effective write policy on public.messages is the single
--       messages_modify FOR ALL USING/WITH CHECK
--         (conversation in an account where is_account_member(acct,'agent'))
--   created by 017 and never overridden (038 only replaced messages_select;
--   073/083 did not touch policies; no trigger exists on messages), on top of
--   full table grants to anon/authenticated/service_role. With their own JWT,
--   through PostgREST, an agent could therefore:
--     * UPDATE status / message_id directly — bypassing
--       settle_outbound_message and the compare-and-set of the status handler
--       (e.g. mark a sent message failed, or forge a provider id);
--     * UPDATE or INSERT connection_ref / delivery_provider /
--       delivery_channel_fp (083) — bypassing "createIntent is the only creator
--       of an outbound message" (DLB-001, outbound-message-creation.arch.test.ts)
--       and binding a message to ANOTHER tenant's connection, which the retry
--       cron would then try to send through;
--     * INSERT arbitrary rows: sender_type 'customer' (a fake inbound message),
--       status 'sent'/'delivered', a made-up message_id.
--
-- WHO WRITES messages WITH A USER SESSION TODAY (grep of src/, the basis of
-- the smallest-possible change)
--   * INSERT: exactly one — createIntent() (src/lib/whatsapp/delivery/
--     settlement.ts) called by POST /api/whatsapp/send with the session client.
--     Shape: sender_type 'agent', status 'sending', message_id NULL,
--     idempotency_key = id, connection_ref/delivery_provider/
--     delivery_channel_fp from the account's own whatsapp_config row.
--   * UPDATE: none. Every status write is service_role (webhook status handler
--     CAS, delivery cron / orphan sweep) or SECURITY DEFINER (settle_*).
--     "Mark as read" updates conversations, not messages; reactions live in
--     message_reactions. The inbox only SELECTs.
--   * DELETE: none in src/; kept as it is (see below).
--   Bots (flows/automations) call createIntent with the service-role client
--   and inbound messages go through insert_inbound_message (SECURITY DEFINER,
--   service_role) — neither is subject to these policies.
--
-- CHANGES (nothing legitimate is removed)
--   1. messages_modify (FOR ALL) is split. SELECT stays as is (messages_select).
--   2. messages_insert (new): agent+ of the conversation's account AND the row
--      has the createIntent shape: sender_type = 'agent', status = 'sending',
--      message_id IS NULL, and connection_ref is NULL or a whatsapp_config row
--      of the SAME account. (delivery_channel_fp is an application hash and
--      cannot be recomputed in SQL; the cron re-verifies it against the config.)
--   3. messages_delete (new): identical predicate to the old FOR ALL (agent+),
--      so DELETE behaviour is unchanged. Residual, out of scope here: deleting
--      a message also removes its audit trail.
--   4. No UPDATE policy, and UPDATE is revoked from anon/authenticated, so an
--      attempt fails loudly (42501) instead of silently matching zero rows.
--      service_role (BYPASSRLS) and SECURITY DEFINER functions are unaffected,
--      as are ON DELETE SET NULL / CASCADE actions (referential-integrity
--      actions run as the table owner).
--
-- RISK OF REGRESSION
--   Anything that updates messages with a user JWT stops working. The grep
--   found no such code in this repository; an external client that does the
--   same through the REST API (a custom integration, a SQL console session
--   running as authenticated) would now get "permission denied for table
--   messages". An INSERT from a user session that is not a fresh 'sending'
--   agent message (e.g. the UI writing a 'sent' row) would be refused by RLS.
--
-- PRECONDITIONS (verify; abort if any is false)
--   * public.messages has RLS enabled and exactly the policies messages_select
--     and messages_modify (capture below). If extra policies exist, review them
--     first: permissive policies are OR-ed, so an extra FOR UPDATE/ALL policy
--     would still allow the update at RLS level (the REVOKE below would still
--     block it).
--   * Columns connection_ref/delivery_provider/delivery_channel_fp exist (083).
--
-- OPERATOR: CAPTURE BEFORE APPLYING (read-only)
--     SELECT polname, polcmd, polroles::regrole[], pg_get_expr(polqual, polrelid),
--            pg_get_expr(polwithcheck, polrelid)
--       FROM pg_policy WHERE polrelid = 'public.messages'::regclass ORDER BY polname;
--     SELECT relrowsecurity, relforcerowsecurity, relacl FROM pg_class
--      WHERE oid = 'public.messages'::regclass;
--     SELECT attname, attacl FROM pg_attribute
--      WHERE attrelid = 'public.messages'::regclass AND attnum > 0 AND attacl IS NOT NULL;
--     SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--      WHERE tgrelid = 'public.messages'::regclass AND NOT tgisinternal;
--   Also check in the project's API logs (read-only) whether any PATCH/PUT on
--   /rest/v1/messages ever came from a user JWT in the last 30 days: if one
--   exists, find its caller before applying.
--
-- ROLLBACK PLAN (restores the captured state; nothing here changes data)
--     BEGIN;
--     DROP POLICY IF EXISTS messages_insert ON public.messages;
--     DROP POLICY IF EXISTS messages_delete ON public.messages;
--     CREATE POLICY messages_modify ON public.messages FOR ALL USING (
--       EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id
--               AND is_account_member(c.account_id, 'agent'))
--     ) WITH CHECK (
--       EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id
--               AND is_account_member(c.account_id, 'agent'))
--     );
--     GRANT UPDATE ON public.messages TO anon, authenticated;  -- only if the captured relacl had it
--     COMMIT;

BEGIN;

-- ============================================================
-- 1. Remove the catch-all write policy
-- ============================================================
DROP POLICY IF EXISTS messages_modify ON public.messages;

-- ============================================================
-- 2. INSERT: only the createIntent shape, only on the account's own connection
-- ============================================================
DROP POLICY IF EXISTS messages_insert ON public.messages;
CREATE POLICY messages_insert ON public.messages FOR INSERT
  WITH CHECK (
    sender_type = 'agent'
    AND status = 'sending'
    AND message_id IS NULL
    AND EXISTS (
      SELECT 1
        FROM public.conversations c
       WHERE c.id = messages.conversation_id
         AND is_account_member(c.account_id, 'agent')
         AND (
           messages.connection_ref IS NULL
           OR EXISTS (
             SELECT 1
               FROM public.whatsapp_config w
              WHERE w.id = messages.connection_ref
                AND w.account_id = c.account_id
           )
         )
    )
  );

-- ============================================================
-- 3. DELETE: unchanged predicate (agent+ of the account)
-- ============================================================
DROP POLICY IF EXISTS messages_delete ON public.messages;
CREATE POLICY messages_delete ON public.messages FOR DELETE
  USING (
    EXISTS (
      SELECT 1
        FROM public.conversations c
       WHERE c.id = messages.conversation_id
         AND is_account_member(c.account_id, 'agent')
    )
  );

-- ============================================================
-- 4. UPDATE: nobody with a user session. Loud failure, not zero rows.
-- ============================================================
REVOKE UPDATE ON public.messages FROM PUBLIC, anon, authenticated;

COMMIT;
