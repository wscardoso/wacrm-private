-- 094_webhook_dlq_dedup.sql
-- R1 follow-up: the inbound-failure DLQ stops growing by one row per retry, and a
-- row stops being "pending" once its message has actually been persisted.
--
-- Local only until separately applied. Apply after 088..093. Additive: three
-- columns and two indexes on whatsapp_webhook_dlq, and CREATE OR REPLACE of two
-- functions (same signatures, owners and ACLs):
--   enqueue_webhook_dlq (031, hardened in 082) and
--   persist_inbound_message_with_turn (091).
--
-- Why. The DLQ is diagnostic only (C6.2: a minimised envelope, never the message).
-- When a provider keeps redelivering a delivery whose persistence keeps failing, each
-- retry used to add an identical row; a hung database turned a handful of messages
-- into thousands of rows that say the same thing, and the table could not answer the
-- question operators actually have: "which messages are still not stored?".
--
-- Deduplication. A pending row is unique per
--   (account, whatsapp_config, source, stage, external message id).
-- A repeat of the same failure updates that row instead of inserting: occurrences + 1,
-- last_seen_at, last_error_message. The first error_message and the first envelope
-- (captured_at) are kept, so nothing needed for investigation is lost. A failure
-- without an external id cannot be correlated and keeps inserting one row per call,
-- exactly as before. A different stage of the same message is a different failure and
-- has its own row.
--
-- Resolution. persist_inbound_message_with_turn now marks the pending rows of that
-- message 'resolved' the first time the message becomes durable. A later failure of
-- the same message (it can happen, e.g. a lost job) opens a new row, because the
-- unique index only covers pending rows. Pending therefore means: still not stored.

BEGIN;

ALTER TABLE public.whatsapp_webhook_dlq
  ADD COLUMN IF NOT EXISTS dedup_key TEXT,
  ADD COLUMN IF NOT EXISTS occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_error_message TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_dlq_pending_dedup
  ON public.whatsapp_webhook_dlq (dedup_key)
  WHERE status = 'pending' AND dedup_key IS NOT NULL;

-- Lookup used by the resolution step of the persist function; pending rows are few.
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_pending_ext
  ON public.whatsapp_webhook_dlq (account_id, (payload ->> 'external_message_id'))
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.enqueue_webhook_dlq(
  p_account_id UUID,
  p_whatsapp_config_id UUID,
  p_payload JSONB,
  p_error_message TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_source TEXT := p_payload ->> 'source';
  v_stage TEXT := p_payload ->> 'stage';
  v_ext TEXT := p_payload ->> 'external_message_id';
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.whatsapp_config c
     WHERE c.id = p_whatsapp_config_id
       AND c.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'enqueue_webhook_dlq: whatsapp_config does not belong to the account'
      USING ERRCODE = '42501';
  END IF;

  IF v_source IS NULL OR v_stage IS NULL OR v_ext IS NULL OR v_ext = '' THEN
    -- Not correlatable: one row per call, as before.
    INSERT INTO public.whatsapp_webhook_dlq (
      account_id, whatsapp_config_id, payload, error_message, last_error_message
    ) VALUES (p_account_id, p_whatsapp_config_id, p_payload, p_error_message, p_error_message)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  INSERT INTO public.whatsapp_webhook_dlq AS d (
    account_id, whatsapp_config_id, payload, error_message, last_error_message, dedup_key
  ) VALUES (
    p_account_id, p_whatsapp_config_id, p_payload, p_error_message, p_error_message,
    p_account_id::text || ':' || p_whatsapp_config_id::text || ':' || v_source || ':' || v_stage || ':' || v_ext
  )
  ON CONFLICT (dedup_key) WHERE status = 'pending' AND dedup_key IS NOT NULL
  DO UPDATE SET occurrences = d.occurrences + 1,
                last_seen_at = clock_timestamp(),
                last_error_message = EXCLUDED.last_error_message
  RETURNING d.id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) TO service_role;

-- 091 body unchanged except the resolution step after a genuine insert.
CREATE OR REPLACE FUNCTION public.persist_inbound_message_with_turn(
  p_conversation_id UUID,
  p_sender_type TEXT,
  p_content_type TEXT,
  p_content_text TEXT,
  p_media_url TEXT,
  p_message_id TEXT,
  p_status TEXT,
  p_created_at TIMESTAMPTZ,
  p_reply_to_message_id UUID,
  p_interactive_reply_id TEXT,
  p_account_id UUID,
  p_contact_id UUID,
  p_downstream_context JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_inserted BOOLEAN := FALSE;
BEGIN
  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    content_type,
    content_text,
    media_url,
    message_id,
    status,
    created_at,
    reply_to_message_id,
    interactive_reply_id
  )
  VALUES (
    p_conversation_id,
    p_sender_type,
    p_content_type,
    p_content_text,
    p_media_url,
    p_message_id,
    p_status,
    p_created_at,
    p_reply_to_message_id,
    p_interactive_reply_id
  )
  ON CONFLICT (conversation_id, message_id)
    WHERE sender_type = 'customer'
      AND message_id IS NOT NULL
      AND message_id <> ''
  DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    v_inserted := TRUE;
  ELSE
    SELECT m.id
      INTO v_id
      FROM public.messages m
     WHERE m.conversation_id = p_conversation_id
       AND m.message_id = p_message_id
       AND m.sender_type = 'customer'
     LIMIT 1;
  END IF;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'inbound_message_not_durable'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.inbound_turn_jobs (
    message_id,
    account_id,
    contact_id,
    conversation_id,
    status,
    downstream_context
  )
  VALUES (
    v_id,
    p_account_id,
    p_contact_id,
    p_conversation_id,
    'pending',
    COALESCE(p_downstream_context, '{}'::jsonb)
  )
  ON CONFLICT (message_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.inbound_turn_jobs j WHERE j.message_id = v_id
  ) THEN
    RAISE EXCEPTION 'inbound_turn_job_not_durable'
      USING ERRCODE = 'P0001';
  END IF;

  -- The message is durable (inserted now or earlier): its pending failure records are
  -- no longer "not stored".
  -- Same transaction as the insert, so a rollback keeps them pending.
  IF p_message_id IS NOT NULL AND p_message_id <> '' THEN
    UPDATE public.whatsapp_webhook_dlq d
       SET status = 'resolved',
           last_seen_at = clock_timestamp()
     WHERE d.account_id = p_account_id
       AND d.status = 'pending'
       AND d.payload ->> 'external_message_id' = p_message_id;
  END IF;

  RETURN jsonb_build_object(
    'message_id', v_id,
    'message_inserted', v_inserted,
    'job_ready', TRUE
  );
END;
$$;

ALTER FUNCTION public.persist_inbound_message_with_turn(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, UUID, UUID, JSONB
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.persist_inbound_message_with_turn(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_inbound_message_with_turn(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, UUID, TEXT, UUID, UUID, JSONB
) TO service_role;

COMMIT;
