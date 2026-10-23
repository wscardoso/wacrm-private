-- 091_persist_inbound_message_with_turn.sql
-- R1 / ADR-AI-001 Q10 / H6: message row and inbound_turn_jobs row commit together.
-- Additive. Does not replace insert_inbound_message (035) or rewrite 088.
-- Depends on public.messages, the partial unique index used by insert_inbound_message
-- (034), and public.inbound_turn_jobs (088). Apply after 088 (sequence 088 -> 089 -> 090 -> 091).
-- CREATE OR REPLACE makes this function re-runnable; 088/090 policies are not.
-- Local until a separate apply.

BEGIN;

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
