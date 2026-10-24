-- 088_inbound_turn_substrate.sql
-- ADR-AI-001 Q10 / D15: durable inbound turn substrate (Postgres claim by messages.id,
-- conversation serialization, recovery). Local-only until separately applied.
-- Does NOT implement LLM execution.
--
-- Apply once, in order: 088 -> 089 -> 090 -> 091. Prerequisite for 091 (inbound_turn_jobs).
-- Re-running this whole file after a successful apply fails: CREATE POLICY has no
-- IF NOT EXISTS, so inbound_turn_jobs_service / inbound_turn_slots_service raise
-- and the surrounding BEGIN/COMMIT rolls the file back. Do not rewrite history
-- here just for reapply; use a follow-up migration if policies must change.
--
-- Turn contract
--   States: pending -> processing -> completed | failed.
--   Ordering: FIFO per (account_id, contact_id) by (created_at, message_id). A job
--     is claimable only when it is pending, available_at has passed, no other job
--     of the same pair is processing (whatever its lease), and no older job of the
--     same pair is still pending. A blocked pair never blocks other pairs.
--   Lease: locked_until is the only ownership deadline (30..3600 s). The holder of
--     claim_token may renew it while it is still valid; complete requires a valid
--     lease too. An expired lease means ownership is lost: renew and complete
--     return false, and reclaim hands the job back (new claim, new token).
--   Retry: attempt_count counts claims (executions started). A failed attempt
--     (complete with p_success = false, or a lease that expired) returns the job
--     to pending after 30/60/120/240 s while attempt_count < 5; the 5th failed
--     attempt ends in failed. Both paths share this rule.
--   failed is terminal and stays in the table. Inspect with
--     SELECT * FROM public.inbound_turn_jobs WHERE status = 'failed';
--   and requeue one deliberately (operator action, service role) with
--     UPDATE public.inbound_turn_jobs
--        SET status = 'pending', attempt_count = 0, available_at = NOW(), completed_at = NULL
--      WHERE message_id = '<id>' AND status = 'failed';

BEGIN;

-- The FKs below take SHARE ROW EXCLUSIVE on messages/accounts/contacts/conversations.
-- Fail fast (and roll back) instead of queueing inbound writes behind a long transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.inbound_turn_jobs (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  downstream_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inbound_turn_jobs_processing_has_lease
    CHECK (status <> 'processing' OR (claim_token IS NOT NULL AND locked_until IS NOT NULL))
);

-- Global claim queue (oldest pending first).
CREATE INDEX IF NOT EXISTS idx_inbound_turn_jobs_claimable
  ON public.inbound_turn_jobs (created_at ASC, message_id ASC)
  WHERE status = 'pending';

-- Per-pair serialization checks and reclaim; only unfinished rows are indexed.
CREATE INDEX IF NOT EXISTS idx_inbound_turn_jobs_active_pair
  ON public.inbound_turn_jobs (account_id, contact_id, created_at, message_id)
  WHERE status IN ('pending', 'processing');

-- Reserved. Not read or written by the functions below: serialization is enforced
-- on inbound_turn_jobs itself (pair predicate + advisory lock).
CREATE TABLE IF NOT EXISTS public.inbound_conversation_turn_slots (
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  holder_message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  locked_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, contact_id)
);

ALTER TABLE public.inbound_turn_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_conversation_turn_slots ENABLE ROW LEVEL SECURITY;

-- Service role only — workers run under supabaseAdmin().
CREATE POLICY inbound_turn_jobs_service ON public.inbound_turn_jobs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY inbound_turn_slots_service ON public.inbound_conversation_turn_slots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Default privileges hand new public tables to the API roles; these are worker-only.
REVOKE ALL ON TABLE public.inbound_turn_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inbound_conversation_turn_slots FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- register_inbound_turn_job — idempotent on message_id
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_inbound_turn_job(
  p_message_id UUID,
  p_account_id UUID,
  p_contact_id UUID,
  p_conversation_id UUID,
  p_downstream_context JSONB DEFAULT '{}'::jsonb
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  INSERT INTO public.inbound_turn_jobs (
    message_id, account_id, contact_id, conversation_id, status, downstream_context
  )
  VALUES (
    p_message_id, p_account_id, p_contact_id, p_conversation_id, 'pending',
    COALESCE(p_downstream_context, '{}'::jsonb)
  )
  ON CONFLICT (message_id) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

ALTER FUNCTION public.register_inbound_turn_job(UUID, UUID, UUID, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_inbound_turn_job(UUID, UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_inbound_turn_job(UUID, UUID, UUID, UUID, JSONB) TO service_role;

-- ------------------------------------------------------------
-- claim_inbound_turn_job — oldest claimable job across all pairs
-- ------------------------------------------------------------
-- The pair predicate in the SELECT skips blocked pairs without stopping the queue.
-- It reads a snapshot, so after taking the pair's advisory lock the predicate is
-- checked again against freshly committed state (e.g. a newer job of the same pair
-- claimed by a transaction that committed meanwhile); a rejected candidate is
-- skipped and the next one is tried.
CREATE OR REPLACE FUNCTION public.claim_inbound_turn_job(
  p_lock_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  message_id UUID,
  account_id UUID,
  contact_id UUID,
  conversation_id UUID,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_variable
DECLARE
  v_job public.inbound_turn_jobs%ROWTYPE;
  v_token UUID;
  v_lease INTERVAL;
  v_now TIMESTAMPTZ;
  v_rejected UUID[] := '{}';
  v_tries INTEGER := 0;
BEGIN
  v_lease := make_interval(secs => LEAST(GREATEST(COALESCE(p_lock_seconds, 300), 30), 3600));

  LOOP
    v_tries := v_tries + 1;
    EXIT WHEN v_tries > 20;

    SELECT j.*
      INTO v_job
      FROM public.inbound_turn_jobs j
     WHERE j.status = 'pending'
       AND j.available_at <= clock_timestamp()
       AND NOT (j.message_id = ANY (v_rejected))
       AND NOT EXISTS (
             SELECT 1
               FROM public.inbound_turn_jobs b
              WHERE b.account_id = j.account_id
                AND b.contact_id = j.contact_id
                AND b.message_id <> j.message_id
                AND (
                      b.status = 'processing'
                      OR (b.status = 'pending'
                          AND (b.created_at, b.message_id) < (j.created_at, j.message_id))
                    )
           )
     ORDER BY j.created_at ASC, j.message_id ASC
     FOR UPDATE OF j SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtext(v_job.account_id::text || ':' || v_job.contact_id::text)
    );

    IF EXISTS (
      SELECT 1
        FROM public.inbound_turn_jobs b
       WHERE b.account_id = v_job.account_id
         AND b.contact_id = v_job.contact_id
         AND b.message_id <> v_job.message_id
         AND (
               b.status = 'processing'
               OR (b.status = 'pending'
                   AND (b.created_at, b.message_id) < (v_job.created_at, v_job.message_id))
             )
    ) THEN
      v_rejected := v_rejected || v_job.message_id;
      CONTINUE;
    END IF;

    v_token := gen_random_uuid();
    v_now := clock_timestamp();

    UPDATE public.inbound_turn_jobs j
       SET status = 'processing',
           claim_token = v_token,
           claimed_at = COALESCE(j.claimed_at, v_now),
           locked_until = v_now + v_lease,
           attempt_count = j.attempt_count + 1,
           processing_started_at = v_now
     WHERE j.message_id = v_job.message_id
       AND j.status = 'pending';

    IF FOUND THEN
      message_id := v_job.message_id;
      account_id := v_job.account_id;
      contact_id := v_job.contact_id;
      conversation_id := v_job.conversation_id;
      claim_token := v_token;
      RETURN NEXT;
      RETURN;
    END IF;

    v_rejected := v_rejected || v_job.message_id;
  END LOOP;
END;
$$;

ALTER FUNCTION public.claim_inbound_turn_job(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_inbound_turn_job(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_inbound_turn_job(INTEGER) TO service_role;

-- ------------------------------------------------------------
-- claim_inbound_turn_for_message — claim one known message (same pair rules)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_inbound_turn_for_message(
  p_message_id UUID,
  p_lock_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  message_id UUID,
  account_id UUID,
  contact_id UUID,
  conversation_id UUID,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_variable
DECLARE
  v_job public.inbound_turn_jobs%ROWTYPE;
  v_token UUID;
  v_lease INTERVAL;
  v_now TIMESTAMPTZ;
BEGIN
  v_lease := make_interval(secs => LEAST(GREATEST(COALESCE(p_lock_seconds, 300), 30), 3600));

  SELECT j.*
    INTO v_job
    FROM public.inbound_turn_jobs j
   WHERE j.message_id = p_message_id
     AND j.status = 'pending'
     AND j.available_at <= clock_timestamp()
   FOR UPDATE OF j SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_job.account_id::text || ':' || v_job.contact_id::text)
  );

  IF EXISTS (
    SELECT 1
      FROM public.inbound_turn_jobs b
     WHERE b.account_id = v_job.account_id
       AND b.contact_id = v_job.contact_id
       AND b.message_id <> v_job.message_id
       AND (
             b.status = 'processing'
             OR (b.status = 'pending'
                 AND (b.created_at, b.message_id) < (v_job.created_at, v_job.message_id))
           )
  ) THEN
    RETURN;
  END IF;

  v_token := gen_random_uuid();
  v_now := clock_timestamp();

  UPDATE public.inbound_turn_jobs j
     SET status = 'processing',
         claim_token = v_token,
         claimed_at = COALESCE(j.claimed_at, v_now),
         locked_until = v_now + v_lease,
         attempt_count = j.attempt_count + 1,
         processing_started_at = v_now
   WHERE j.message_id = p_message_id
     AND j.status = 'pending';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  message_id := v_job.message_id;
  account_id := v_job.account_id;
  contact_id := v_job.contact_id;
  conversation_id := v_job.conversation_id;
  claim_token := v_token;
  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.claim_inbound_turn_for_message(UUID, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_inbound_turn_for_message(UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_inbound_turn_for_message(UUID, INTEGER) TO service_role;

-- ------------------------------------------------------------
-- renew_inbound_turn_lease — heartbeat for the current lease holder
-- ------------------------------------------------------------
-- Succeeds only while the job is processing, the token matches and the lease has
-- not expired. false means ownership is lost: stop and do not complete.
CREATE OR REPLACE FUNCTION public.renew_inbound_turn_lease(
  p_message_id UUID,
  p_claim_token UUID,
  p_lock_seconds INTEGER DEFAULT 300
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.inbound_turn_jobs j
     SET locked_until = clock_timestamp()
           + make_interval(secs => LEAST(GREATEST(COALESCE(p_lock_seconds, 300), 30), 3600))
   WHERE j.message_id = p_message_id
     AND j.claim_token = p_claim_token
     AND j.status = 'processing'
     AND j.locked_until > clock_timestamp();

  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.renew_inbound_turn_lease(UUID, UUID, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.renew_inbound_turn_lease(UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_inbound_turn_lease(UUID, UUID, INTEGER) TO service_role;

-- ------------------------------------------------------------
-- complete_inbound_turn_job — lease holder reports the outcome
-- ------------------------------------------------------------
-- false: caller is not the current lease holder (token replaced or lease expired);
-- nothing changes. On failure the retry rule from the header applies.
CREATE OR REPLACE FUNCTION public.complete_inbound_turn_job(
  p_message_id UUID,
  p_claim_token UUID,
  p_success BOOLEAN,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  UPDATE public.inbound_turn_jobs j
     SET status = CASE
                    WHEN p_success THEN 'completed'
                    WHEN j.attempt_count >= 5 THEN 'failed'
                    ELSE 'pending'
                  END,
         completed_at = CASE
                          WHEN p_success OR j.attempt_count >= 5 THEN v_now
                          ELSE NULL
                        END,
         available_at = CASE
                          WHEN p_success OR j.attempt_count >= 5 THEN j.available_at
                          ELSE v_now + make_interval(
                                 secs => LEAST(30 * power(2, GREATEST(j.attempt_count - 1, 0)), 900)
                               )
                        END,
         last_error = CASE
                        WHEN p_success THEN COALESCE(p_error, j.last_error)
                        ELSE COALESCE(p_error, 'failed_without_message')
                      END,
         claim_token = NULL,
         locked_until = NULL,
         processing_started_at = CASE
                                   WHEN p_success OR j.attempt_count >= 5 THEN j.processing_started_at
                                   ELSE NULL
                                 END
   WHERE j.message_id = p_message_id
     AND j.claim_token = p_claim_token
     AND j.status = 'processing'
     AND j.locked_until > v_now;

  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.complete_inbound_turn_job(UUID, UUID, BOOLEAN, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.complete_inbound_turn_job(UUID, UUID, BOOLEAN, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_inbound_turn_job(UUID, UUID, BOOLEAN, TEXT) TO service_role;

-- ------------------------------------------------------------
-- reclaim_stuck_inbound_turn_jobs — recover expired leases
-- ------------------------------------------------------------
-- A processing job whose lease expired more than p_stale_seconds ago (grace,
-- default 0) counts as a failed attempt: back to pending with backoff, or failed
-- once attempt_count reached 5. Rows locked by a concurrent claim/complete are
-- skipped, so reclaim never waits on (or deadlocks with) a worker.
-- Returns how many jobs were reclaimed (requeued + failed).
CREATE OR REPLACE FUNCTION public.reclaim_stuck_inbound_turn_jobs(
  p_stale_seconds INTEGER DEFAULT 0
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_cutoff TIMESTAMPTZ;
BEGIN
  v_cutoff := v_now - make_interval(secs => GREATEST(COALESCE(p_stale_seconds, 0), 0));

  WITH stale AS (
    SELECT s.message_id
      FROM public.inbound_turn_jobs s
     WHERE s.status = 'processing'
       AND s.locked_until < v_cutoff
     FOR UPDATE OF s SKIP LOCKED
  )
  UPDATE public.inbound_turn_jobs j
     SET status = CASE WHEN j.attempt_count >= 5 THEN 'failed' ELSE 'pending' END,
         completed_at = CASE WHEN j.attempt_count >= 5 THEN v_now ELSE NULL END,
         available_at = CASE
                          WHEN j.attempt_count >= 5 THEN j.available_at
                          ELSE v_now + make_interval(
                                 secs => LEAST(30 * power(2, GREATEST(j.attempt_count - 1, 0)), 900)
                               )
                        END,
         last_error = CASE
                        WHEN j.attempt_count >= 5 THEN 'lease_expired_max_attempts'
                        ELSE 'lease_expired'
                      END,
         claim_token = NULL,
         locked_until = NULL,
         processing_started_at = NULL
    FROM stale
   WHERE j.message_id = stale.message_id
     AND j.status = 'processing';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION public.reclaim_stuck_inbound_turn_jobs(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reclaim_stuck_inbound_turn_jobs(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stuck_inbound_turn_jobs(INTEGER) TO service_role;

COMMIT;
