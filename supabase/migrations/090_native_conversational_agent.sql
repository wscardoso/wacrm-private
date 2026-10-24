-- 090_native_conversational_agent.sql — ADR-AI-001 D10, D14 (local only)
--
-- Apply once in sequence 088 -> 089 -> 090 -> 091. Flag default FALSE.
-- Independent of 088/089 for objects, but keep numeric order for deploy.
-- Re-running this whole file after a successful apply fails: CREATE POLICY has
-- no IF NOT EXISTS (agent_runs_service / agent_steps_service). Do not rewrite
-- history here just for reapply; use a follow-up migration if policies must change.

BEGIN;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS native_conversational_agent_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.accounts.native_conversational_agent_enabled IS
  'D10: tenant flag for native WhatsApp conversational agent; default OFF.';

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  inbound_message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed', 'skipped')),
  agent_consumed BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_one_per_inbound
  ON public.agent_runs (inbound_message_id);

CREATE TABLE IF NOT EXISTS public.agent_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  kind TEXT NOT NULL,
  decision JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, step_index)
);

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_runs_service ON public.agent_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY agent_steps_service ON public.agent_steps
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
