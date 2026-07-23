-- ============================================================
-- 056_enrichment_ledger.sql — E6.0: Enrichment State Ledger
--
-- Own retry/observability ledger for the enrichment cycle.
-- NOT the E4b outbound_retry_ledger — this is a separate table
-- with its own lifecycle (E6.0 §9.6, §15).
--
-- Each row tracks the enrichment state of one lead_attributions
-- line. The job (service_role) reads eligible rows via a system
-- RPC, claims them atomically, processes, and updates status.
--
-- Observability (§15): every transition writes metadata that
-- answers "what was processed, when, how many tries, what error,
-- what state".
-- ============================================================

CREATE TABLE IF NOT EXISTS enrichment_ledger (
  attribution_id    UUID NOT NULL REFERENCES lead_attributions(id) ON DELETE CASCADE PRIMARY KEY,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'completed', 'failed_permanent', 'expired')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ,
  last_outcome_class TEXT,
  last_error        TEXT,
  locked_until      TIMESTAMPTZ,
  ttl_expires_at    TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enrichment_ledger_eligible
  ON enrichment_ledger(account_id, status, ttl_expires_at)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS idx_enrichment_ledger_account
  ON enrichment_ledger(account_id);

-- Only service_role can access enrichment_ledger directly; all
-- mutations go through SECURITY DEFINER RPCs.
ALTER TABLE enrichment_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY enrichment_ledger_select ON enrichment_ledger
  FOR SELECT USING (auth.role() = 'service_role');

CREATE POLICY enrichment_ledger_update ON enrichment_ledger
  FOR UPDATE USING (auth.role() = 'service_role');

-- ============================================================
-- Trigger: updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_enrichment_ledger_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enrichment_ledger_updated_at ON enrichment_ledger;
CREATE TRIGGER trg_enrichment_ledger_updated_at
  BEFORE UPDATE ON enrichment_ledger
  FOR EACH ROW EXECUTE FUNCTION update_enrichment_ledger_updated_at();

-- ============================================================
-- enqueue_pending_attributions()
--
-- Scans lead_attributions for rows that have ad_source_id
-- (eligible for enrichment) and no enrichment_ledger entry yet.
-- Enqueues them as 'pending'. Safe to call multiple times —
-- ON CONFLICT DO NOTHING.
-- Called by the enrichment job at the start of each cycle.
-- ============================================================
CREATE OR REPLACE FUNCTION enqueue_pending_attributions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO enrichment_ledger (attribution_id, account_id, ttl_expires_at)
  SELECT
    la.id,
    la.account_id,
    NOW() + INTERVAL '72 hours'
  FROM lead_attributions la
  WHERE la.ad_source_id IS NOT NULL
    AND la.enriched_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM enrichment_ledger el WHERE el.attribution_id = la.id)
  ON CONFLICT (attribution_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION enqueue_pending_attributions() OWNER TO postgres;
REVOKE ALL ON FUNCTION enqueue_pending_attributions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_pending_attributions() TO service_role;

-- ============================================================
-- claim_enrichment_batch(p_limit, p_account_id default NULL)
--
-- Atomically claims up to p_limit eligible enrichment rows.
-- If p_account_id is provided, only claims rows for that tenant.
-- Returns the claimed rows for the app-tier to process.
-- Status transition: pending → claimed (locked).
-- ============================================================
CREATE OR REPLACE FUNCTION claim_enrichment_batch(
  p_limit     INTEGER DEFAULT 10,
  p_account_id UUID DEFAULT NULL
)
RETURNS TABLE (
  attribution_id UUID,
  account_id UUID,
  attempt_count INTEGER,
  last_error TEXT,
  ad_source_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH eligible AS (
    SELECT el.attribution_id, el.account_id, el.attempt_count, el.last_error
    FROM enrichment_ledger el
    WHERE el.status IN ('pending', 'claimed')
      AND (el.locked_until IS NULL OR el.locked_until < NOW())
      AND el.ttl_expires_at > NOW()
      AND (p_account_id IS NULL OR el.account_id = p_account_id)
    ORDER BY el.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE enrichment_ledger el
  SET status = 'claimed',
      locked_until = NOW() + INTERVAL '5 minutes'
  FROM eligible e
  WHERE el.attribution_id = e.attribution_id
  RETURNING
    el.attribution_id,
    el.account_id,
    el.attempt_count,
    el.last_error,
    (SELECT la.ad_source_id FROM lead_attributions la WHERE la.id = el.attribution_id) AS ad_source_id;
END;
$$;

ALTER FUNCTION claim_enrichment_batch(INTEGER, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION claim_enrichment_batch(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_enrichment_batch(INTEGER, UUID) TO service_role;

-- ============================================================
-- resolve_enrichment_success(p_attribution_id, p_campaign_id,
--   p_campaign_name, p_adset_id, p_adset_name, p_ad_id,
--   p_ad_name, p_placement)
--
-- Called by the enrichment job after a successful Graph API call.
-- Writes enrichment data to lead_attributions (only the additive
-- enrichment columns, never the capture columns) and transitions
-- the ledger to 'completed'.
-- Single transaction — both happen or neither (E6.0 §15.3.1).
-- ============================================================
CREATE OR REPLACE FUNCTION resolve_enrichment_success(
  p_attribution_id UUID,
  p_campaign_id    TEXT,
  p_campaign_name  TEXT,
  p_adset_id       TEXT,
  p_adset_name     TEXT,
  p_ad_id          TEXT,
  p_ad_name        TEXT,
  p_placement      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
BEGIN
  UPDATE lead_attributions SET
    campaign_id   = COALESCE(p_campaign_id, campaign_id),
    campaign_name = COALESCE(p_campaign_name, campaign_name),
    adset_id      = COALESCE(p_adset_id, adset_id),
    adset_name    = COALESCE(p_adset_name, adset_name),
    ad_id         = COALESCE(p_ad_id, ad_id),
    ad_name       = COALESCE(p_ad_name, ad_name),
    placement     = COALESCE(p_placement, placement),
    enriched_at   = NOW()
  WHERE id = p_attribution_id
  RETURNING to_jsonb(lead_attributions.*) INTO v_row;

  UPDATE enrichment_ledger
  SET status = 'completed',
      locked_until = NULL
  WHERE attribution_id = p_attribution_id
    AND status = 'claimed';

  RETURN v_row;
END;
$$;

ALTER FUNCTION resolve_enrichment_success(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION resolve_enrichment_success(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_enrichment_success(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ============================================================
-- resolve_enrichment_failure(p_attribution_id, p_outcome_class,
--   p_error_code, p_attempt_count)
--
-- Called by the enrichment job after a failure.
-- outcome_class controls the ledger state transition:
--   'permanent' → failed_permanent (terminal)
--   'transient' → back to pending with attempt_count incremented
--   'blocked'   → same as permanent (creds unavailable)
-- ============================================================
CREATE OR REPLACE FUNCTION resolve_enrichment_failure(
  p_attribution_id UUID,
  p_outcome_class  TEXT,
  p_error_code     TEXT,
  p_attempt_count  INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
  v_ttl_expired BOOLEAN;
  v_max_attempts CONSTANT INTEGER := 10;
BEGIN
  IF p_outcome_class NOT IN ('permanent', 'transient', 'blocked') THEN
    RAISE EXCEPTION 'Invalid outcome class' USING ERRCODE = '22023';
  END IF;

  SELECT el.ttl_expires_at < NOW()
  INTO v_ttl_expired
  FROM enrichment_ledger el
  WHERE el.attribution_id = p_attribution_id;

  IF v_ttl_expired THEN
    UPDATE enrichment_ledger
    SET status = 'expired',
        locked_until = NULL,
        last_attempt_at = NOW(),
        last_outcome_class = p_outcome_class,
        last_error = p_error_code,
        attempt_count = p_attempt_count
    WHERE attribution_id = p_attribution_id AND status = 'claimed'
    RETURNING to_jsonb(enrichment_ledger.*) INTO v_row;
    RETURN v_row;
  END IF;

  IF p_outcome_class IN ('permanent', 'blocked') THEN
    UPDATE enrichment_ledger
    SET status = 'failed_permanent',
        locked_until = NULL,
        last_attempt_at = NOW(),
        last_outcome_class = p_outcome_class,
        last_error = p_error_code,
        attempt_count = p_attempt_count
    WHERE attribution_id = p_attribution_id AND status = 'claimed'
    RETURNING to_jsonb(enrichment_ledger.*) INTO v_row;
  ELSIF p_attempt_count >= v_max_attempts THEN
    UPDATE enrichment_ledger
    SET status = 'failed_permanent',
        locked_until = NULL,
        last_attempt_at = NOW(),
        last_outcome_class = 'permanent',
        last_error = p_error_code,
        attempt_count = p_attempt_count
    WHERE attribution_id = p_attribution_id AND status = 'claimed'
    RETURNING to_jsonb(enrichment_ledger.*) INTO v_row;
  ELSE
    UPDATE enrichment_ledger
    SET status = 'pending',
        locked_until = NULL,
        last_attempt_at = NOW(),
        last_outcome_class = p_outcome_class,
        last_error = p_error_code,
        attempt_count = p_attempt_count
    WHERE attribution_id = p_attribution_id AND status = 'claimed'
    RETURNING to_jsonb(enrichment_ledger.*) INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

ALTER FUNCTION resolve_enrichment_failure(UUID, TEXT, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION resolve_enrichment_failure(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_enrichment_failure(UUID, TEXT, TEXT, INTEGER) TO service_role;

-- ============================================================
-- reclaim_stuck_enrichment()
--
-- Orphan sweeper for enrichment: recycles rows stuck in 'claimed'
-- past the lock window (locked_until < NOW()) back to 'pending'
-- so another job cycle can pick them up.
-- ============================================================
CREATE OR REPLACE FUNCTION reclaim_stuck_enrichment()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE enrichment_ledger
  SET status = 'pending',
      locked_until = NULL,
      last_error = 'stale_claim'
  WHERE status = 'claimed'
    AND locked_until < NOW()
    AND ttl_expires_at > NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION reclaim_stuck_enrichment() OWNER TO postgres;
REVOKE ALL ON FUNCTION reclaim_stuck_enrichment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reclaim_stuck_enrichment() TO service_role;

-- ============================================================
-- expire_stale_enrichments()
--
-- Moves any non-terminal row past TTL to 'expired'.
-- ============================================================
CREATE OR REPLACE FUNCTION expire_stale_enrichments()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE enrichment_ledger
  SET status = 'expired',
      locked_until = NULL,
      last_error = 'ttl_expired'
  WHERE status IN ('pending', 'claimed')
    AND ttl_expires_at < NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

ALTER FUNCTION expire_stale_enrichments() OWNER TO postgres;
REVOKE ALL ON FUNCTION expire_stale_enrichments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_stale_enrichments() TO service_role;

-- ============================================================
-- get_enrichment_report(p_account_id)
--
-- Returns enrichment summary for a single tenant.
-- Called by the report route (authenticated, via RLS).
-- ============================================================
CREATE OR REPLACE FUNCTION get_enrichment_report(p_account_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'total', COUNT(*),
    'pending', COUNT(*) FILTER (WHERE el.status = 'pending'),
    'claimed', COUNT(*) FILTER (WHERE el.status = 'claimed'),
    'completed', COUNT(*) FILTER (WHERE el.status = 'completed'),
    'failed_permanent', COUNT(*) FILTER (WHERE el.status = 'failed_permanent'),
    'expired', COUNT(*) FILTER (WHERE el.status = 'expired'),
    'never_enqueued',
      (SELECT COUNT(*) FROM lead_attributions la
       WHERE la.account_id = p_account_id
         AND la.ad_source_id IS NOT NULL
         AND la.enriched_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM enrichment_ledger el2 WHERE el2.attribution_id = la.id))
  ) INTO v_result
  FROM enrichment_ledger el
  WHERE el.account_id = p_account_id;

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

ALTER FUNCTION get_enrichment_report(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION get_enrichment_report(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_enrichment_report(UUID) TO authenticated;
