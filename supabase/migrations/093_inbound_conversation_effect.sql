-- 093_inbound_conversation_effect.sql
-- R1 follow-up: the conversation effect of an inbound message, applied exactly once
-- and safe for messages that execute out of message order.
--
-- Local only until separately applied. Apply after 088..092. Additive: one nullable
-- column on inbound_turn_jobs and one new function.
--
-- Before. The downstream wrote the conversation row from a snapshot taken when the
-- message was persisted:
--     unread_count = <count read at persist time> + 1,  last_message_text = <preview>,
--     last_message_at = now()
-- Consequences: (1) a burst of N messages whose jobs were queued together each wrote
-- <same count> + 1, so the counter moved by 1 instead of N (lost updates); (2) a
-- message that executes after a later one (a gap filled by a redelivery, a backlog
-- drained out of order) overwrote the newer preview; (3) re-running a turn after a
-- failure was only harmless because the written value was absolute.
--
-- Now. apply_inbound_message_to_conversation(message_id, preview), one transaction:
--   * it claims the effect on the job row (conversation_effect_at IS NULL -> now), so
--     a retried or duplicated turn applies it ONCE and the second call returns false;
--   * unread_count is incremented atomically (read-modify-write inside the UPDATE);
--   * the preview and last_message_at only move FORWARD in message time: a message
--     older than the conversation's last_message_at leaves the preview untouched but
--     is still counted as unread;
--   * the message time is the provider time, capped at the database clock so a
--     provider clock running ahead cannot park the conversation in the future.
--
-- Failure atomicity: if the conversation UPDATE fails, the job-row claim rolls back
-- with it and the next attempt applies the effect again.

BEGIN;

ALTER TABLE public.inbound_turn_jobs
  ADD COLUMN IF NOT EXISTS conversation_effect_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.apply_inbound_message_to_conversation(
  p_message_id UUID,
  p_preview TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation_id UUID;
  v_message_ts TIMESTAMPTZ;
BEGIN
  UPDATE public.inbound_turn_jobs j
     SET conversation_effect_at = clock_timestamp()
   WHERE j.message_id = p_message_id
     AND j.conversation_effect_at IS NULL
  RETURNING j.conversation_id INTO v_conversation_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT LEAST(m.created_at, clock_timestamp())
    INTO v_message_ts
    FROM public.messages m
   WHERE m.id = p_message_id;

  UPDATE public.conversations c
     SET unread_count = COALESCE(c.unread_count, 0) + 1,
         last_message_text = CASE
                               WHEN c.last_message_at IS NULL OR c.last_message_at <= v_message_ts
                                 THEN p_preview
                               ELSE c.last_message_text
                             END,
         last_message_at = GREATEST(COALESCE(c.last_message_at, v_message_ts), v_message_ts),
         updated_at = NOW()
   WHERE c.id = v_conversation_id;

  RETURN TRUE;
END;
$$;

ALTER FUNCTION public.apply_inbound_message_to_conversation(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_inbound_message_to_conversation(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_inbound_message_to_conversation(UUID, TEXT) TO service_role;

COMMIT;
