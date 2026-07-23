-- ============================================================
-- 055_ad_account_credentials.sql — ADR-ATTR-002: Per-Tenant
-- Meta Marketing API Credentials
--
-- Implements D-1 (dedicated table), D-2 (AES-256-GCM ciphertext),
-- D-3 (platform-side RPC, tenant-scoped admin gate), D-4 (state +
-- rotation/revocation path), D-5 (RLS by account_id), D-6 (audit
-- in platform_audit_log), D-7 (DB never sees plaintext).
--
-- The consuming job (E6.0 enrichment) reads ciphertext via SELECT
-- (service_role), decrypts app-tier, calls Graph API — it NEVER
-- writes to this table. Provisioning/rotation/revocation are
-- exclusively through the RPC below.
-- ============================================================

CREATE TABLE IF NOT EXISTS ad_account_credentials (
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE PRIMARY KEY,
  ciphertext    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_account_creds_status
  ON ad_account_credentials(status);

ALTER TABLE ad_account_credentials ENABLE ROW LEVEL SECURITY;

-- Only service_role can SELECT ciphertext directly; all other access
-- goes through SECURITY DEFINER RPCs (get_ad_account_credential,
-- set_ad_account_credential, revoke_ad_account_credential).
CREATE POLICY ad_account_creds_select ON ad_account_credentials
  FOR SELECT USING (auth.role() = 'service_role');

-- ============================================================
-- Trigger: updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_ad_account_creds_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ad_account_creds_updated_at ON ad_account_credentials;
CREATE TRIGGER trg_ad_account_creds_updated_at
  BEFORE UPDATE ON ad_account_credentials
  FOR EACH ROW EXECUTE FUNCTION update_ad_account_creds_updated_at();

-- ============================================================
-- set_ad_account_credential(p_account_id, p_ciphertext, p_expires_at)
--
-- SECURITY DEFINER — provision or rotate a credential.
-- Authorization: platform operator with access_role = 'admin' for
-- the target tenant (same gate as E5b/054).
-- The caller (app-tier Next route) encrypts the token BEFORE calling
-- this RPC — the DB never sees plaintext (D-7).
-- Audits in platform_audit_log (D-6).
-- ============================================================
CREATE OR REPLACE FUNCTION set_ad_account_credential(
  p_account_id UUID,
  p_ciphertext TEXT,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
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
    SELECT 1
    FROM platform_operators po
    JOIN platform_operator_accounts poa ON poa.operator_user_id = po.user_id
    WHERE po.user_id = auth.uid()
      AND po.is_active
      AND poa.account_id = p_account_id
      AND poa.access_role = 'admin'
  ) THEN
    RAISE EXCEPTION 'This action requires platform admin access to this account'
      USING ERRCODE = '42501';
  END IF;

  IF p_ciphertext IS NULL OR btrim(p_ciphertext) = '' THEN
    RAISE EXCEPTION 'ciphertext must not be empty' USING ERRCODE = '22023';
  END IF;

  INSERT INTO ad_account_credentials (account_id, ciphertext, status, expires_at)
  VALUES (p_account_id, p_ciphertext, 'active', p_expires_at)
  ON CONFLICT (account_id) DO UPDATE SET
    ciphertext = EXCLUDED.ciphertext,
    status     = 'active',
    expires_at = EXCLUDED.expires_at,
    revoked_at = NULL,
    revoked_reason = NULL
  RETURNING to_jsonb(ad_account_credentials.*) INTO v_row;

  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action, metadata)
  VALUES (
    auth.uid(),
    p_account_id,
    'ad_credential_set',
    jsonb_build_object('has_expiry', p_expires_at IS NOT NULL)
  );

  RETURN v_row;
END;
$$;

ALTER FUNCTION set_ad_account_credential(UUID, TEXT, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION set_ad_account_credential(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_ad_account_credential(UUID, TEXT, TIMESTAMPTZ) TO authenticated;

-- ============================================================
-- revoke_ad_account_credential(p_account_id, p_reason)
--
-- SECURITY DEFINER — marks an existing credential as revoked
-- and erases the ciphertext (D-4). Same authorization gate.
-- ============================================================
CREATE OR REPLACE FUNCTION revoke_ad_account_credential(
  p_account_id UUID,
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
    SELECT 1
    FROM platform_operators po
    JOIN platform_operator_accounts poa ON poa.operator_user_id = po.user_id
    WHERE po.user_id = auth.uid()
      AND po.is_active
      AND poa.account_id = p_account_id
      AND poa.access_role = 'admin'
  ) THEN
    RAISE EXCEPTION 'This action requires platform admin access to this account'
      USING ERRCODE = '42501';
  END IF;

  UPDATE ad_account_credentials
  SET status = 'revoked',
      ciphertext = '',
      revoked_at = NOW(),
      revoked_reason = p_reason
  WHERE account_id = p_account_id
  RETURNING to_jsonb(ad_account_credentials.*) INTO v_row;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No credential found for this account' USING ERRCODE = '22023';
  END IF;

  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action, metadata)
  VALUES (auth.uid(), p_account_id, 'ad_credential_revoked',
    jsonb_build_object('reason', p_reason));

  RETURN v_row;
END;
$$;

ALTER FUNCTION revoke_ad_account_credential(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION revoke_ad_account_credential(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_ad_account_credential(UUID, TEXT) TO authenticated;

-- ============================================================
-- get_ad_account_credential(p_account_id)
--
-- System-only RPC for E6.0 enrichment job — returns ciphertext
-- and status for the given account. Only callable by service_role.
-- The enrichment job decrypts app-tier, never persists plaintext.
-- ============================================================
CREATE OR REPLACE FUNCTION get_ad_account_credential(p_account_id UUID)
RETURNS TABLE (ciphertext TEXT, status TEXT, expires_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ciphertext, status, expires_at
  FROM ad_account_credentials
  WHERE account_id = p_account_id;
$$;

ALTER FUNCTION get_ad_account_credential(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION get_ad_account_credential(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_ad_account_credential(UUID) TO service_role;
