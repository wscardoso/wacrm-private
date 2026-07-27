-- ============================================================
-- 058_convergence_attestation.sql — IMP-E7-001 Fase 5:
-- Convergence Attestation (ADR-E7-001 §13.3).
--
-- Structural precondition for T8 (Retired → Destroyed).
--
-- Implements the 4 properties from ADR-E7-001 §13.3:
--   1. Persistência independente do Key Ring — tabela própria,
--      não um campo do Key Ring ou da configuração.
--   2. Vínculo explícito a KID + versão do Inventário — colunas
--      kid + inventory_version, ambas obrigatórias.
--   3. Distinguibilidade obrigatória — a existência de uma row
--      distingue "destruído com prova (Attestation existe)" de
--      "ausente por omissão (Attestation não existe)".
--   4. Imutabilidade — sem UPDATE/DELETE policies; único INSERT
--      via RPC SECURITY DEFINER que rejeita sobrescrita
--      (ON CONFLICT DO NOTHING + raise).
--
-- Depende de: 037 (is_platform_operator), 057 (key_lifecycle_events,
--   key_lifecycle_event_type enum, declare_kid_retired).
--
-- Idempotente — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Extend lifecycle event type enum with 'destroyed' (T8)
-- ============================================================
ALTER TYPE key_lifecycle_event_type ADD VALUE IF NOT EXISTS 'destroyed';

-- ============================================================
-- 2. Convergence attestations table
-- ============================================================
CREATE TABLE IF NOT EXISTS convergence_attestations (
  id                BIGSERIAL PRIMARY KEY,
  kid               TEXT NOT NULL,
  inventory_version INTEGER NOT NULL CHECK (inventory_version >= 1),
  issued_by         UUID NOT NULL REFERENCES auth.users(id),
  metadata          JSONB NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kid)       -- At most one attestation per KID (imutabilidade)
);

CREATE INDEX IF NOT EXISTS idx_convergence_attestations_kid
  ON convergence_attestations(kid);

ALTER TABLE convergence_attestations ENABLE ROW LEVEL SECURITY;

-- Visible to active platform operators (same posture as 057).
DROP POLICY IF EXISTS convergence_attestations_select ON convergence_attestations;
CREATE POLICY convergence_attestations_select ON convergence_attestations
  FOR SELECT
  USING (is_platform_operator());

-- NOTE: no INSERT/UPDATE/DELETE policies for authenticated on this table
-- — all writes go through the SECURITY DEFINER RPC below. Imutabilidade:
-- no UPDATE/DELETE policies exist at all (not even for service_role, not even for postgres).

-- ============================================================
-- 3. Single-row inventory version tracker
--
-- The inventory (E7-ciphertext-surface-inventory.md) is the authoritative
-- list of all ciphertext-bearing tables/columns. Each time a new surface
-- is discovered or a new épico declares one, the inventory_version is
-- bumped here. This version is used by validate_kid_destroyable to ensure
-- that convergence attestations reference the current inventory snapshot
-- (ADR-E7-001 §13.1 — the inventory grows over time, never by omission).
-- ============================================================

CREATE TABLE IF NOT EXISTS inventory_versions (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- enforce single row
  version     INTEGER NOT NULL CHECK (version >= 1),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Nullable deliberately: a migration applies with no authenticated
  -- session (auth.uid() is NULL at migration-apply time, same as 037's
  -- bootstrap admin, which is likewise not created BY the migration).
  -- The seed row below represents the migration's own default, not an
  -- operator action — NULL here means exactly that, never "forged".
  -- Every subsequent bump via bump_inventory_version() below DOES stamp
  -- a real auth.uid() and cannot leave this column NULL again (the RPC
  -- always sets it from the authenticated admin caller).
  updated_by  UUID NULL REFERENCES auth.users(id)
);

-- Seed the initial row if the table is empty (safe to re-run). Runs at
-- migration-apply time, outside any authenticated session — updated_by
-- is NULL for this one bootstrap row only (see column comment above).
INSERT INTO inventory_versions (id, version, updated_by)
SELECT 1, 1, NULL
WHERE NOT EXISTS (SELECT 1 FROM inventory_versions WHERE id = 1);

ALTER TABLE inventory_versions ENABLE ROW LEVEL SECURITY;

-- Visible to active platform operators (same posture as convergence_attestations).
DROP POLICY IF EXISTS inventory_versions_select ON inventory_versions;
CREATE POLICY inventory_versions_select ON inventory_versions
  FOR SELECT
  USING (is_platform_operator());

-- NOTE: deliberately NO UPDATE (or INSERT/DELETE) policy for `authenticated`
-- on this table — a raw RLS-permitted UPDATE, even gated by
-- is_platform_operator(), would let ANY active operator (not just admin)
-- set `version` to an arbitrary value and forge `updated_by` (RLS
-- WITH CHECK only re-tests is_platform_operator(), it cannot pin
-- updated_by = auth.uid()). Since validate_kid_destroyable() compares an
-- Attestation's inventory_version against this table's current value,
-- an under-gated UPDATE path here would let a caller defeat that check
-- entirely by bumping the version to match a stale Attestation on
-- demand. All writes go exclusively through bump_inventory_version()
-- below — same posture as every other mutation in 037/057/this file.
CREATE OR REPLACE FUNCTION get_current_inventory_version()
RETURNS INTEGER
LANGUAGE SQL
STABLE
RETURNS NULL ON NULL INPUT
SET search_path = public
AS $$
  SELECT version FROM inventory_versions WHERE id = 1;
$$;

ALTER FUNCTION get_current_inventory_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION get_current_inventory_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_current_inventory_version() TO authenticated;

-- bump_inventory_version(p_new_version) — the ONLY way to change the
-- tracked inventory version. Admin-gated (same posture as every other
-- mutation here), strictly monotonic (must be exactly current + 1, so
-- no version can be skipped or reused), and stamps updated_by from
-- auth.uid() — never trusted from a caller argument.
CREATE OR REPLACE FUNCTION bump_inventory_version(p_new_version INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current INTEGER;
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

  v_current := get_current_inventory_version();

  IF p_new_version IS DISTINCT FROM v_current + 1 THEN
    RAISE EXCEPTION 'inventory_version must increase by exactly 1 (current: %, requested: %)', v_current, p_new_version
      USING ERRCODE = '22023';
  END IF;

  UPDATE inventory_versions
  SET version = p_new_version, updated_at = NOW(), updated_by = auth.uid()
  WHERE id = 1
  RETURNING to_jsonb(inventory_versions.*) INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION bump_inventory_version(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION bump_inventory_version(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bump_inventory_version(INTEGER) TO authenticated;

-- ============================================================
-- 4. RPC: issue_convergence_attestation(p_kid, p_inventory_version, p_metadata)
--
-- Emits a Convergence Attestation for a KID. Preconditions:
--   * caller is an active platform admin (same gate as 057)
--   * kid is non-empty
--   * inventory_version >= 1
--   * no prior attestation exists for this KID (imutabilidade — UNIQUE + ON CONFLICT)
-- ============================================================
CREATE OR REPLACE FUNCTION issue_convergence_attestation(
  p_kid               TEXT,
  p_inventory_version INTEGER,
  p_metadata          JSONB DEFAULT NULL
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

  IF p_inventory_version IS NULL OR p_inventory_version < 1 THEN
    RAISE EXCEPTION 'inventory_version must be >= 1' USING ERRCODE = '22023';
  END IF;

  INSERT INTO convergence_attestations (kid, inventory_version, issued_by, metadata)
  VALUES (p_kid, p_inventory_version, auth.uid(), p_metadata)
  ON CONFLICT (kid) DO NOTHING
  RETURNING to_jsonb(convergence_attestations.*) INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Attestation already exists for this KID (immutable — cannot overwrite)'
      USING ERRCODE = '23505';
  END IF;

  RETURN v_row;
END;
$$;

ALTER FUNCTION issue_convergence_attestation(TEXT, INTEGER, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION issue_convergence_attestation(TEXT, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_convergence_attestation(TEXT, INTEGER, JSONB) TO authenticated;

-- ============================================================
-- 5. RPC: validate_kid_destroyable(p_kid)
--
-- Pre-flight check for operational teams. Returns:
--   { valid: true/false, reason: text|null, attestation: {...}|null, retired_event: {...}|null }
--
-- Validates THREE preconditions of T8:
--   (a) convergence attestation exists for this KID
--   (b) attestation's inventory_version == current inventory version
--   (c) the KID's MOST RECENT lifecycle event (of any type) is 'retired'
--
-- Condition (b) closes the race: if the inventory grows after an
-- attestation is issued (new ciphertext-bearing surface discovered
-- in a later épico, ADR-E7-001 §13.1), the old attestation becomes
-- stale and must be re-issued against the current version before
-- any T8 can proceed. This prevents an obsolete proof from
-- justifying an irreversible action.
--
-- Condition (c) is deliberately "most recent event of ANY type is
-- retired", not "a retired event exists somewhere in history". A KID
-- can be declared Retired (T6) and later reverted to DecryptOnly (T7)
-- or reactivated to Active (T5) — in either case it is no longer
-- Retired, even though a 'retired' row still exists in its history.
-- Filtering on event_type = 'retired' before ordering (as an earlier
-- revision of this function did) would find that stale row and
-- incorrectly validate a KID that is not currently Retired at all.
-- ============================================================
CREATE OR REPLACE FUNCTION validate_kid_destroyable(p_kid TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attestation JSONB;
  v_latest_event JSONB;
  v_current_version INTEGER;
BEGIN
  -- Read-gate only: this function changes no state, it mirrors the
  -- SELECT policies on the two tables it reads (convergence_attestations,
  -- key_lifecycle_events — both is_platform_operator()-gated). The
  -- higher admin bar belongs to issue_convergence_attestation/destroy_kid,
  -- which actually mutate state.
  IF NOT is_platform_operator() THEN
    RAISE EXCEPTION 'This action requires an active platform operator'
      USING ERRCODE = '42501';
  END IF;

  IF p_kid IS NULL OR btrim(p_kid) = '' THEN
    RAISE EXCEPTION 'kid must not be empty' USING ERRCODE = '22023';
  END IF;

  SELECT to_jsonb(ca.*) INTO v_attestation
  FROM convergence_attestations ca
  WHERE ca.kid = p_kid;

  IF v_attestation IS NULL THEN
    RETURN jsonb_build_object(
      'valid', FALSE,
      'reason', 'No convergence attestation found for this KID. Issue one via issue_convergence_attestation first.',
      'attestation', NULL,
      'retired_event', NULL
    );
  END IF;

  v_current_version := get_current_inventory_version();

  IF (v_attestation->>'inventory_version')::INTEGER <> v_current_version THEN
    RETURN jsonb_build_object(
      'valid', FALSE,
      'reason', 'Convergence attestation was issued against inventory version ' ||
                (v_attestation->>'inventory_version') ||
                ', but the current inventory version is ' || v_current_version ||
                '. Re-issue the attestation against the current inventory version before destroying this KID.',
      'attestation', v_attestation,
      'retired_event', NULL
    );
  END IF;

  -- Most recent event of ANY type — not filtered to 'retired' — so a
  -- later T7/T5 reversal correctly invalidates a stale 'retired' row.
  SELECT to_jsonb(kle.*) INTO v_latest_event
  FROM key_lifecycle_events kle
  WHERE kle.kid = p_kid
  ORDER BY kle.created_at DESC, kle.id DESC
  LIMIT 1;

  IF v_latest_event IS NULL OR (v_latest_event->>'event_type') <> 'retired' THEN
    RETURN jsonb_build_object(
      'valid', FALSE,
      'reason', 'KID''s most recent lifecycle event is not Retired. Declare via declare_kid_retired first (T6), and ensure no later reversal (T7) or reactivation (T5) has occurred since.',
      'attestation', v_attestation,
      'retired_event', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'valid', TRUE,
    'reason', NULL,
    'attestation', v_attestation,
    'retired_event', v_latest_event
  );
END;
$$;

ALTER FUNCTION validate_kid_destroyable(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION validate_kid_destroyable(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION validate_kid_destroyable(TEXT) TO authenticated;

-- ============================================================
-- 6. RPC: destroy_kid(p_kid, p_reason)
--
-- Records the Destroyed event in key_lifecycle_events, gated by
-- the same preconditions as validate_kid_destroyable (reuses it).
--
-- This is the governance-layer declaration of T8 in the audit trail.
-- The operational removal of the KID from KeyRing configuration
-- (env/secret) is a separate step — this RPC does not touch config.
--
-- Authorization: same admin gate as 057 + issue_convergence_attestation.
-- ============================================================
CREATE OR REPLACE FUNCTION destroy_kid(
  p_kid    TEXT,
  p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_validation JSONB;
  v_event JSONB;
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

  v_validation := validate_kid_destroyable(p_kid);
  IF NOT (v_validation->>'valid')::BOOLEAN THEN
    -- ERRCODE 22023 (validation), not 42501 (insufficient_privilege):
    -- this is a precondition/business-rule failure (missing attestation,
    -- not Retired, stale inventory version), not an authorization
    -- failure — the two admin checks above already use 42501 for the
    -- genuine "you are not an admin" case. keyLifecycle.ts's
    -- translateRpcError collapses every 42501 into a generic "not
    -- authorized" message, discarding the real reason; 22023 preserves
    -- it, which matters most on the one transition in this whole
    -- contract that is irreversible.
    RAISE EXCEPTION 'Cannot destroy KID: %', v_validation->>'reason'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO key_lifecycle_events (kid, event_type, actor_user_id, reason)
  VALUES (p_kid, 'destroyed', auth.uid(), p_reason)
  RETURNING to_jsonb(key_lifecycle_events.*) INTO v_event;

  RETURN jsonb_build_object(
    'event', v_event,
    'attestation', v_validation->'attestation'
  );
END;
$$;

ALTER FUNCTION destroy_kid(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION destroy_kid(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION destroy_kid(TEXT, TEXT) TO authenticated;
