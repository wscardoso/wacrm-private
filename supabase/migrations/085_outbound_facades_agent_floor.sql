-- 085_outbound_facades_agent_floor.sql
--
-- STATUS: PREPARED — NOT APPLIED
--   Written locally on branch local/post-audit-a-sql (base a203a1e). It has
--   NOT been applied to any database (local, staging or production). It is
--   exercised only against in-memory PGlite by
--   src/test/outbound-facade-agent-floor.pglite.test.ts, which runs the real
--   chain 001..085. An authorised operator applies it, after the capture and
--   verification steps below.
--
-- DEFECT (post-audit item 4)
--   settle_outbound_message and enqueue_outbound_retry (050/052, re-stated by
--   084) authorise with
--       is_account_member(acct)  OR  can_access_account(acct)
--   * is_account_member(acct) defaults to min_role = 'viewer' (017);
--   * can_access_account(acct) = member OR authorised platform operator (037),
--     and the operator is a READ-ONLY role by design (038).
--   POST /api/whatsapp/send, the only legitimate caller, needs role 'agent'
--   (the INSERT of the intent is under RLS: messages_modify requires 'agent').
--   So a viewer, or the platform operator, could (a) settle any 'sending'
--   message of the account as 'sent' with a forged provider id or as 'failed',
--   and (b) enqueue a retry for ANY message — including one already 'sent':
--   /api/whatsapp/delivery/cron does not re-check messages.status, so it would
--   resend the content to the customer (duplicate delivery).
--
-- CHANGES
--   1. settle_outbound_message (human facade): floor is now
--        is_account_member(acct, 'agent')
--      (owner/admin/agent). can_access_account() is gone: an operator is not a
--      member and has no write path. Two extra checks that the application
--      already satisfies (settlement.ts builds the identities from the same
--      message id and connection it passes):
--        - p_connection_ref must not be a connection of ANOTHER account;
--          a connection id that does not exist is still accepted, so a
--          connection deleted while the provider call was in flight does not
--          leave the message stuck in 'sending';
--        - every p_identities item must carry message_id = p_message_id and
--          connection_ref = p_connection_ref. Before, a member could write
--          message_external_ids rows for ANOTHER tenant's message / namespace
--          through the core (which inserts the items verbatim).
--   2. enqueue_outbound_retry (human facade): same agent floor.
--   3. enqueue_outbound_retry_core: refuses (returns enqueued=false, reason
--      'message_not_sending', writes nothing) when the message is not in
--      status 'sending'. Both facades inherit it, so the system path
--      (automations / flows) gets the same protection. The legitimate caller,
--      handleSendFailure, only enqueues the intent it has just created and
--      failed to send, which is 'sending'. FOR SHARE serialises against the
--      settlement's FOR UPDATE, so "sent, then enqueue" cannot interleave.
--   4. insert_message_external_ids (047/073): same agent floor, and EXECUTE is
--      revoked from anon (073 only revoked PUBLIC). Nothing in src/ calls it
--      (settlement writes identities through the core), so there is no
--      application path to break; service_role keeps its grant.
--
--   The system facades (*_system) and settle_outbound_message_core are NOT
--   changed. Signatures and the jsonb return type are preserved (CREATE OR
--   REPLACE); grants are re-asserted to the 084 state.
--
-- PRECONDITIONS (verify; abort if any is false)
--   * 084 is applied: the six functions exist with the signatures below, owner
--     postgres, SECURITY DEFINER, returning jsonb (insert_message_external_ids
--     returns void).
--   * is_account_member(uuid, account_role_enum) and whatsapp_config(id,
--     account_id) exist.
--
-- OPERATOR: CAPTURE BEFORE APPLYING (the repository does not hold the live
--   definitions; 084 records that they were applied from a CRLF source, so a
--   byte compare against this file will differ even where the logic is equal):
--     SELECT p.oid::regprocedure, pg_get_functiondef(p.oid), p.proacl, pg_get_userbyid(p.proowner)
--       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--        AND p.proname IN ('settle_outbound_message','settle_outbound_message_core',
--            'settle_outbound_message_system','enqueue_outbound_retry',
--            'enqueue_outbound_retry_core','enqueue_outbound_retry_system',
--            'insert_message_external_ids') ORDER BY 1;
--   Save the output: it is the rollback source.
--
-- ROLLBACK PLAN (also from the captured text; nothing here is destructive)
--   Re-run the captured pg_get_functiondef of the seven functions, then restore
--   the captured proacl with REVOKE/GRANT. In particular the previous
--   authorisation expression was
--        NOT (public.is_account_member(v_account_id) OR public.can_access_account(v_account_id))
--   and the previous core had no status guard. No data is changed by this file,
--   so there is nothing to restore in tables.
--
-- VERIFY AFTER APPLYING (read-only)
--   * proacl unchanged: *_core -> nobody; settle_outbound_message /
--     enqueue_outbound_retry -> authenticated; *_system -> service_role;
--     insert_message_external_ids -> authenticated (+ service_role if it had
--     it), no longer anon.
--   * md5(prosrc) of the four replaced facades/cores/insert_message_external_ids
--     equals the md5 of the bodies in this file (LF line endings).

BEGIN;

-- ============================================================
-- 1. settle_outbound_message — agent floor + identity scoping
-- ============================================================
CREATE OR REPLACE FUNCTION public.settle_outbound_message(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT c.account_id
    INTO v_account_id
    FROM public.messages m
    JOIN public.conversations c
      ON c.id = m.conversation_id
   WHERE m.id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'settle_outbound_message: message not found (id: %)',
      p_message_id;
  END IF;

  -- Same floor as the write path of /send (messages INSERT requires 'agent').
  -- No can_access_account(): a platform operator is read-only.
  IF NOT public.is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION
      'settle_outbound_message: not authorized for account %',
      v_account_id;
  END IF;

  -- The connection may not belong to another tenant. An id that no longer
  -- exists is tolerated on purpose (see header).
  IF p_connection_ref IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.whatsapp_config w
     WHERE w.id = p_connection_ref
       AND w.account_id <> v_account_id
  ) THEN
    RAISE EXCEPTION
      'settle_outbound_message: connection % does not belong to account %',
      p_connection_ref, v_account_id;
  END IF;

  -- The identities describe THIS message on THIS connection, nothing else.
  IF p_identities IS NOT NULL
     AND jsonb_typeof(p_identities) = 'array'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_identities) AS item
        WHERE (item->>'message_id') IS DISTINCT FROM p_message_id::text
           OR (item->>'connection_ref') IS DISTINCT FROM p_connection_ref::text
     )
  THEN
    RAISE EXCEPTION
      'settle_outbound_message: identities must reference message % and connection %',
      p_message_id, p_connection_ref;
  END IF;

  RETURN public.settle_outbound_message_core(
    p_message_id,
    p_status,
    p_connection_ref,
    p_provider_message_id,
    p_identities
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_outbound_message(
  UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.settle_outbound_message(
  UUID, TEXT, UUID, TEXT, JSONB
) TO authenticated;


-- ============================================================
-- 2. enqueue_outbound_retry_core — only an in-flight message can be retried
-- ============================================================
CREATE OR REPLACE FUNCTION public.enqueue_outbound_retry_core(
  p_message_id      UUID,
  p_classification  TEXT,
  p_next_attempt_at TIMESTAMPTZ,
  p_last_error      TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF p_classification NOT IN ('ambiguous', 'deterministic_transient', 'deterministic_permanent') THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: invalid classification: %', p_classification;
  END IF;

  -- The retry cron re-sends whatever a ledger entry points at and does not
  -- re-check messages.status. A message that is no longer 'sending' (sent,
  -- delivered, read, failed, inbound) must never get an entry. A missing
  -- message falls through to the INSERT and fails on the foreign key, as before.
  SELECT status
    INTO v_status
    FROM public.messages
   WHERE id = p_message_id
     FOR SHARE;

  IF FOUND AND v_status IS DISTINCT FROM 'sending' THEN
    RETURN jsonb_build_object(
      'messageId', p_message_id,
      'enqueued', false,
      'reason', 'message_not_sending'
    );
  END IF;

  INSERT INTO public.outbound_retry_ledger
    (message_id, attempt_count, next_attempt_at, classification, last_error, status)
  VALUES
    (p_message_id, 0, p_next_attempt_at, p_classification, p_last_error, 'pending')
  ON CONFLICT (message_id) DO NOTHING;

  RETURN jsonb_build_object('messageId', p_message_id, 'enqueued', true);
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_outbound_retry_core(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================
-- 3. enqueue_outbound_retry — agent floor
-- ============================================================
CREATE OR REPLACE FUNCTION public.enqueue_outbound_retry(
  p_message_id      UUID,
  p_classification  TEXT,
  p_next_attempt_at TIMESTAMPTZ,
  p_last_error      TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT c.account_id INTO v_account_id
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
   WHERE m.id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: message not found (id: %)', p_message_id;
  END IF;

  IF NOT public.is_account_member(v_account_id, 'agent') THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: not authorized for account %', v_account_id;
  END IF;

  RETURN public.enqueue_outbound_retry_core(p_message_id, p_classification, p_next_attempt_at, p_last_error);
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_outbound_retry(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.enqueue_outbound_retry(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) TO authenticated;


-- ============================================================
-- 4. insert_message_external_ids — agent floor (body otherwise as in 073)
-- ============================================================
CREATE OR REPLACE FUNCTION public.insert_message_external_ids(p_identities JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_foreign_account UUID;
BEGIN
  SELECT c.account_id INTO v_foreign_account
    FROM jsonb_array_elements(p_identities) AS item
    JOIN public.messages m ON m.id = (item->>'message_id')::UUID
    JOIN public.conversations c ON c.id = m.conversation_id
   WHERE NOT public.is_account_member(c.account_id, 'agent')
   LIMIT 1;

  IF v_foreign_account IS NOT NULL THEN
    RAISE EXCEPTION 'insert_message_external_ids: not authorized for account %', v_foreign_account;
  END IF;

  INSERT INTO public.message_external_ids (message_id, connection_ref, kind, value)
  SELECT
    (item->>'message_id')::UUID,
    (item->>'connection_ref')::UUID,
    item->>'kind',
    item->>'value'
  FROM jsonb_array_elements(p_identities) AS item;
END;
$$;

-- 073 only revoked PUBLIC; on a Supabase project the default privileges also
-- leave EXECUTE with anon. anon has no business here (auth.uid() is NULL, so it
-- could only ever reach the foreign-key error path).
REVOKE ALL ON FUNCTION public.insert_message_external_ids(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.insert_message_external_ids(JSONB) TO authenticated;

COMMIT;
