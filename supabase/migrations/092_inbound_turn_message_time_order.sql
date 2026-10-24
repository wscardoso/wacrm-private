-- 092_inbound_turn_message_time_order.sql
-- R1 follow-up to 088: the per-contact ordering key of the turn queue.
--
-- Local only until separately applied. Apply after 088..091. Additive: it replaces
-- the two claim functions of 088 (CREATE OR REPLACE, same signatures, owner and
-- ACL) and changes no table.
--
-- Why. 088 ordered the jobs of one (account_id, contact_id) pair by
-- (job.created_at, message_id), and job.created_at is the moment the job row was
-- inserted. That is arrival order, which is right only while jobs are inserted in
-- the order the messages were sent. A redelivery that fills a gap (message B failed
-- to persist, C did not; the provider sends the same payload again) inserts B's job
-- AFTER C's, so B was queued behind C although it is older, and the effects ran in
-- the order A, C, B. The provider can also deliver a batch out of order.
--
-- New contract. Among the jobs of one pair that are PENDING, the oldest MESSAGE runs
-- first: key = (messages.created_at, job.created_at, message_id).
--   * messages.created_at is the provider's message time (seconds for Meta);
--   * job.created_at (microseconds, insertion time) breaks ties inside the same
--     second, so two messages sent in the same second still run in arrival order;
--   * message_id breaks the remaining ties deterministically.
-- Everything else in the 088 contract is unchanged: a job is claimable only when it
-- is pending, available_at has passed, no other job of the pair is processing
-- (whatever its lease) and no OLDER pending job of the pair exists; a blocked pair
-- never blocks other pairs; the global scan still starts from the oldest job row.
--
-- What this cannot do. A turn that already started or finished is never undone: a
-- message that arrives after a later one has begun executing runs afterwards (late).
-- Waiting for a message that may never come would block the contact for as long as
-- the provider takes to give up. The conversation effects (093) are order-safe for
-- that case: the preview never regresses and the unread counter is exact.

BEGIN;

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
  v_msg_ts TIMESTAMPTZ;
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
      JOIN public.messages mj ON mj.id = j.message_id
     WHERE j.status = 'pending'
       AND j.available_at <= clock_timestamp()
       AND NOT (j.message_id = ANY (v_rejected))
       AND NOT EXISTS (
             SELECT 1
               FROM public.inbound_turn_jobs b
               JOIN public.messages mb ON mb.id = b.message_id
              WHERE b.account_id = j.account_id
                AND b.contact_id = j.contact_id
                AND b.message_id <> j.message_id
                AND (
                      b.status = 'processing'
                      OR (b.status = 'pending'
                          AND (mb.created_at, b.created_at, b.message_id)
                              < (mj.created_at, j.created_at, j.message_id))
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

    -- The scan above read a snapshot; re-check against freshly committed state now
    -- that the pair lock is held (a job of the pair may have committed meanwhile).
    SELECT m.created_at INTO v_msg_ts FROM public.messages m WHERE m.id = v_job.message_id;

    IF EXISTS (
      SELECT 1
        FROM public.inbound_turn_jobs b
        JOIN public.messages mb ON mb.id = b.message_id
       WHERE b.account_id = v_job.account_id
         AND b.contact_id = v_job.contact_id
         AND b.message_id <> v_job.message_id
         AND (
               b.status = 'processing'
               OR (b.status = 'pending'
                   AND (mb.created_at, b.created_at, b.message_id)
                       < (v_msg_ts, v_job.created_at, v_job.message_id))
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
  v_msg_ts TIMESTAMPTZ;
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

  SELECT m.created_at INTO v_msg_ts FROM public.messages m WHERE m.id = v_job.message_id;

  IF EXISTS (
    SELECT 1
      FROM public.inbound_turn_jobs b
      JOIN public.messages mb ON mb.id = b.message_id
     WHERE b.account_id = v_job.account_id
       AND b.contact_id = v_job.contact_id
       AND b.message_id <> v_job.message_id
       AND (
             b.status = 'processing'
             OR (b.status = 'pending'
                 AND (mb.created_at, b.created_at, b.message_id)
                     < (v_msg_ts, v_job.created_at, v_job.message_id))
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

COMMIT;
