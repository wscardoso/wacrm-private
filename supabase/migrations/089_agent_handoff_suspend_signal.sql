-- 089_agent_handoff_suspend_signal.sql — ADR-AI-001 Q11 / §6.7
-- Apply once in sequence 088 -> 089 -> 090 -> 091. Independent of 088 objects;
-- ADD COLUMN IF NOT EXISTS and CREATE OR REPLACE make this file re-runnable.

BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS agent_suspended_after_handoff_at TIMESTAMPTZ;

COMMENT ON COLUMN public.conversations.agent_suspended_after_handoff_at IS
  'Q11: dedicated IA suspension after handoff; explicit resume clears. Distinct from assigned_agent_id and paused_by_agent.';

CREATE OR REPLACE FUNCTION public.suspend_conversational_agent_after_handoff(
  p_conversation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
     SET agent_suspended_after_handoff_at = NOW(),
         updated_at = NOW()
   WHERE id = p_conversation_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_conversational_agent(
  p_conversation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.conversations
     SET agent_suspended_after_handoff_at = NULL,
         updated_at = NOW()
   WHERE id = p_conversation_id
     AND agent_suspended_after_handoff_at IS NOT NULL;
  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.suspend_conversational_agent_after_handoff(UUID) OWNER TO postgres;
ALTER FUNCTION public.resume_conversational_agent(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.suspend_conversational_agent_after_handoff(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_conversational_agent(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_conversational_agent_after_handoff(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_conversational_agent(UUID) TO service_role;

COMMIT;
