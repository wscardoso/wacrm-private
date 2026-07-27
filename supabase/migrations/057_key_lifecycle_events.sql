-- ============================================================
-- 057_key_lifecycle_events.sql — ADR-E7-001 §8.0/§8.1/§8.3 (T5-T7):
-- Append-only governance log for KID lifecycle declarations.
--
-- This table is NEVER consulted by resolveKey()/getWriteKey() (the
-- application's Key Ring, src/lib/crypto/keyring.ts) — ADR-E7-001 §8.0
-- is explicit that `Retired` carries no read/write capability distinct
-- from `DecryptOnly`, and is purely a declarative, auditable marker
-- (RNF-5). This table exists solely so that marker has a durable,
-- queryable home independent of any in-memory or per-instance Key Ring
-- configuration — the same requirement IMP-E7-001 §5 Phase 5 will build
-- on for Convergence Attestation (ADR-E7-001 §13.3).
--
-- Follows the platform_audit_log pattern (037): append-only, RLS with
-- no client DML policy (writes exclusively through SECURITY DEFINER
-- RPCs below), actor stamped server-side from auth.uid().
--
-- KIDs are platform-wide, not tenant-scoped (unlike platform_audit_log's
-- target_account_id), so this is a dedicated table rather than a reuse
-- of platform_audit_log.
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'key_lifecycle_event_type' AND n.nspname = 'public') THEN
    CREATE TYPE key_lifecycle_event_type AS ENUM (
      'retired',                  -- T6: DecryptOnly -> Retired
      'reverted_to_decrypt_only', -- T7: Retired -> DecryptOnly
      'reactivated'               -- T5: Retired -> Active
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS key_lifecycle_events (
  id            BIGSERIAL PRIMARY KEY,
  kid           TEXT NOT NULL,
  event_type    key_lifecycle_event_type NOT NULL,
  actor_user_id UUID NOT NULL REFERENCES auth.users(id),
  reason        TEXT NULL,
  metadata      JSONB NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_key_lifecycle_events_kid
  ON key_lifecycle_events(kid, created_at DESC);

ALTER TABLE key_lifecycle_events ENABLE ROW LEVEL SECURITY;

-- Visible only to active platform operators — this is internal crypto
-- governance, not tenant data, so there is no target_account_id to
-- scope reads by (unlike platform_audit_log_select, 037).
DROP POLICY IF EXISTS key_lifecycle_events_select ON key_lifecycle_events;
CREATE POLICY key_lifecycle_events_select ON key_lifecycle_events
  FOR SELECT
  USING (is_platform_operator());

-- NOTE: no INSERT/UPDATE/DELETE policies for `authenticated` on this
-- table — all writes go through the three SECURITY DEFINER RPCs below.
-- This is what makes the log append-only and tamper-resistant (same
-- posture as platform_audit_log, 037).

-- ============================================================
-- Declaration RPCs (SECURITY DEFINER, admin-gated, append-only)
--
-- Common contract:
--   * auth.uid() must be an ACTIVE platform admin (role = 'admin') — KID
--     lifecycle is platform-wide governance, a strictly higher-
--     sensitivity action than tenant-scoped operator actions, so this
--     requires admin, not merely operator (mirrors
--     set_ad_account_credential / revoke_ad_account_credential's
--     admin-only gate, 055).
--   * These RPCs are PURELY DECLARATIVE — they write one event row and
--     do nothing else. They never touch, query, or reference the
--     application's Key Ring configuration in any way (ADR-E7-001 §8.0:
--     "Retired não é consultado por nenhuma lógica de decisão de
--     leitura"). Validating that `p_kid` corresponds to a real,
--     currently-configured KID is intentionally out of scope — the Key
--     Ring lives in application config/environment, not in this schema,
--     and this table's only job is to record a declaration for audit
--     (RNF-5), never to gate or drive resolveKey()/getWriteKey().
--   * actor_user_id is ALWAYS auth.uid() — never trusted from caller
--     arguments (same posture as 037).
-- ============================================================

-- declare_kid_retired(p_kid, p_reason) — T6: DecryptOnly -> Retired.
CREATE OR REPLACE FUNCTION declare_kid_retired(
  p_kid    TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM platform_operators po
    WHERE po.user_id = auth.uid() AND po.is_active AND po.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  IF p_kid IS NULL OR btrim(p_kid) = '' THEN
    RAISE EXCEPTION 'kid must not be empty' USING ERRCODE = '22023';
  END IF;

  INSERT INTO key_lifecycle_events (kid, event_type, actor_user_id, reason)
  VALUES (p_kid, 'retired', auth.uid(), p_reason)
  RETURNING to_jsonb(key_lifecycle_events.*) INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION declare_kid_retired(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION declare_kid_retired(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION declare_kid_retired(TEXT, TEXT) TO authenticated;

-- revert_kid_retired(p_kid, p_reason) — T7: Retired -> DecryptOnly.
CREATE OR REPLACE FUNCTION revert_kid_retired(
  p_kid    TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM platform_operators po
    WHERE po.user_id = auth.uid() AND po.is_active AND po.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  IF p_kid IS NULL OR btrim(p_kid) = '' THEN
    RAISE EXCEPTION 'kid must not be empty' USING ERRCODE = '22023';
  END IF;

  INSERT INTO key_lifecycle_events (kid, event_type, actor_user_id, reason)
  VALUES (p_kid, 'reverted_to_decrypt_only', auth.uid(), p_reason)
  RETURNING to_jsonb(key_lifecycle_events.*) INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION revert_kid_retired(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION revert_kid_retired(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revert_kid_retired(TEXT, TEXT) TO authenticated;

-- reactivate_kid(p_kid, p_reason) — T5: Retired -> Active (reactivation,
-- including the "late rollback" scenario of ADR-E7-001 §12).
CREATE OR REPLACE FUNCTION reactivate_kid(
  p_kid    TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM platform_operators po
    WHERE po.user_id = auth.uid() AND po.is_active AND po.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  IF p_kid IS NULL OR btrim(p_kid) = '' THEN
    RAISE EXCEPTION 'kid must not be empty' USING ERRCODE = '22023';
  END IF;

  INSERT INTO key_lifecycle_events (kid, event_type, actor_user_id, reason)
  VALUES (p_kid, 'reactivated', auth.uid(), p_reason)
  RETURNING to_jsonb(key_lifecycle_events.*) INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION reactivate_kid(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION reactivate_kid(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reactivate_kid(TEXT, TEXT) TO authenticated;
