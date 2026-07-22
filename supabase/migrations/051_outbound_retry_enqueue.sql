-- ============================================================
-- 051_outbound_retry_enqueue.sql — E4b: Outbound Retry Enqueue
--
-- ARO-001 v3 §7, §8.2, §11, §12, §16:
--   SECURITY DEFINER function for writing to outbound_retry_ledger
--   from the synchronous send path (sender.ts → handleSendFailure).
--
-- Migration 049 declared that INSERT/UPDATE on the ledger would be
-- "exclusivamente via função(ões) SECURITY DEFINER, a introduzir
-- junto com quem as consome (Commits 4 e 6 do plano de implementação
-- de E4b)." This function closes that contract for the authenticated
-- send path. The scheduler (service_role) writes directly via
-- supabaseAdmin() — no RPC needed there.
-- ============================================================

-- ------------------------------------------------------------
-- enqueue_outbound_retry
--
-- Called by sender.ts → handleSendFailure when the Failure
-- Classifier returns a non‑permanent decision (retryable or
-- any ambiguous‑* branch).
--
-- Auth check: same guard as settle_outbound_message (050) —
-- is_account_member OR can_access_account.
--
-- Idempotency: ON CONFLICT (message_id) DO NOTHING. The UNIQUE
-- constraint on message_id guarantees one ledger row per intent.
-- If a row already exists (e.g. from a previous retry attempt),
-- the scheduler owns it — this first‑failure enqueue does not
-- overwrite.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_outbound_retry(
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
  -- Resolve account + auth check (same pattern as 050)
  SELECT c.account_id INTO v_account_id
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: message not found (id: %)', p_message_id;
  END IF;

  IF NOT (is_account_member(v_account_id) OR can_access_account(v_account_id)) THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: not authorized for account %', v_account_id;
  END IF;

  -- Validate classification (mirrors the ledger CHECK constraint)
  IF p_classification NOT IN ('ambiguous', 'deterministic_transient', 'deterministic_permanent') THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: invalid classification: %', p_classification;
  END IF;

  -- Insert — idempotent on conflict (scheduler may already have created a row)
  INSERT INTO outbound_retry_ledger
    (message_id, attempt_count, next_attempt_at, classification, last_error, status)
  VALUES
    (p_message_id, 0, p_next_attempt_at, p_classification, p_last_error, 'pending')
  ON CONFLICT (message_id) DO NOTHING;

  RETURN jsonb_build_object('messageId', p_message_id, 'enqueued', true);
END;
$$;

REVOKE ALL ON FUNCTION enqueue_outbound_retry FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_outbound_retry TO authenticated;
