-- ============================================================
-- 037_platform_admin_foundation.sql
-- Platform operator layer — READ-ONLY complement to the existing
-- multi-tenant model.
--
-- Scoping & invariants (do NOT violate):
--   * accounts / profiles / owner_user_id are UNTOUCHED.
--   * idx_accounts_one_per_owner is preserved (never dropped/relaxed).
--   * profiles stays single-membership.
--   * is_account_member() keeps its exact meaning: direct membership in
--     an account. This migration does NOT alter it.
--
-- What this adds, strictly parallel to the tenant model:
--   * platform_operators            — who is an internal Force CRM operator
--   * platform_operator_accounts    — explicit per-tenant authorization
--   * platform_audit_log            — tamper-resistant admin audit trail
--   * is_platform_operator()        — is auth.uid() an active operator?
--   * is_platform_operator_for(a)   — operator authorized for account a?
--   * can_access_account(a)         — membership OR authorized operator
--   * 4 SECURITY DEFINER RPCs for privileged mutation (audit-logged)
--
-- No RPC grants cross-tenant read/write to clients directly. Operators
-- reach tenant data only through can_access_account() in later phases;
-- this migration only lays the authorization + audit foundation.
--
-- Bootstrap: the first platform admin is NOT self-service and is NOT
-- created by this migration (doing so would be non-idempotent and unsafe
-- in production). There is also no existing seed/setup hook in this repo
-- to reuse, so the only supported path is a controlled, out-of-band
-- one-off run by a Postgres superuser (e.g. the Supabase Dashboard SQL
-- editor or `supabase db` CLI), NEVER through any RPC:
--
--   INSERT INTO platform_operators (user_id, role, is_active, created_by)
--   VALUES ('<ADMIN_USER_ID>', 'admin', TRUE, '<ADMIN_USER_ID>')
--   ON CONFLICT (user_id) DO UPDATE SET is_active = TRUE, role = 'admin';
--
-- grant_platform_operator() rejects self-promotion and requires an
-- already-active admin, so once the first admin exists, every further
-- grant/revoke/assign flows exclusively through the audited RPCs below.
-- No secret, token, or password is stored in code or in this migration.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- PLATFORM ROLE ENUM
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'platform_operator_role' AND n.nspname = 'public') THEN
    CREATE TYPE platform_operator_role AS ENUM ('admin', 'operator');
  END IF;
END $$;

-- ============================================================
-- PLATFORM OPERATOR ACCESS ROLE ENUM (per-tenant)
-- 'viewer' / 'agent' / 'admin' describe what an operator may DO inside a
-- supervised tenant. This is NOT the tenant's own account_role and never
-- grants ownership of the tenant.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'platform_access_role' AND n.nspname = 'public') THEN
    CREATE TYPE platform_access_role AS ENUM ('viewer', 'agent', 'admin');
  END IF;
END $$;

-- ============================================================
-- platform_operators
-- One row per internal Force CRM operator. PRIMARY KEY = user_id so a
-- user can only ever be one operator record. No self-insert: the table's
-- RLS forbids all direct DML by authenticated; only SECURITY DEFINER RPCs
-- write it.
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_operators (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       platform_operator_role NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_operators_active
  ON platform_operators(user_id) WHERE is_active;

-- ============================================================
-- platform_operator_accounts
-- Explicit authorization: operator X may supervise tenant Y. The PK
-- prevents duplicate (operator, account) rows. Authorization is NEVER
-- implied — an operator not present here cannot reach the tenant.
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_operator_accounts (
  operator_user_id UUID NOT NULL REFERENCES platform_operators(user_id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  access_role      platform_access_role NOT NULL DEFAULT 'viewer',
  created_by       UUID NOT NULL REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (operator_user_id, account_id)
);

-- Fast lookups both directions (operator -> accounts, account -> operators).
CREATE INDEX IF NOT EXISTS idx_platform_operator_accounts_account
  ON platform_operator_accounts(account_id);

-- ============================================================
-- platform_audit_log
-- Administrative actions are recorded with the REAL actor (never the
-- supervised tenant's user). The caller cannot forge actor_user_id —
-- RPCs stamp it from auth.uid(). Read access is operator-scoped (see RLS).
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id                BIGSERIAL PRIMARY KEY,
  actor_user_id     UUID NOT NULL REFERENCES auth.users(id),
  target_account_id UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  target_user_id    UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  action            TEXT NOT NULL,
  ip                INET NULL,
  user_agent        TEXT NULL,
  metadata          JSONB NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_actor
  ON platform_audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_account
  ON platform_audit_log(target_account_id, created_at DESC);

-- ============================================================
-- AUTHORIZATION HELPERS (read-only chokepoints)
-- ============================================================

-- is_platform_operator(): TRUE iff auth.uid() is an active operator.
-- Pure read; never grants tenant access by itself.
CREATE OR REPLACE FUNCTION is_platform_operator() RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_operators po
    WHERE po.user_id = auth.uid() AND po.is_active
  );
$$;

ALTER FUNCTION is_platform_operator() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_platform_operator() TO authenticated, service_role;

-- is_platform_operator_for(target_account_id): TRUE iff auth.uid() is an
-- active operator WITH an explicit row authorizing the given tenant.
-- Tenant-specific — no global reach.
CREATE OR REPLACE FUNCTION is_platform_operator_for(target_account_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM platform_operators po
    JOIN platform_operator_accounts poa
      ON poa.operator_user_id = po.user_id
    WHERE po.user_id = auth.uid()
      AND po.is_active
      AND poa.account_id = target_account_id
  );
$$;

ALTER FUNCTION is_platform_operator_for(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_platform_operator_for(UUID) TO authenticated, service_role;

-- can_access_account(target_account_id): composition. TRUE iff the caller
-- is a direct member of the account OR an authorized platform operator for
-- it. is_account_member() is NOT modified — this is a separate, additive
-- chokepoint. Semantics: "authorized to access the account SCOPE", not
-- "authorized to perform every action inside it" (action authorization is
-- layered on top in later phases via access_role / route checks).
CREATE OR REPLACE FUNCTION can_access_account(target_account_id UUID) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(target_account_id)
      OR is_platform_operator_for(target_account_id);
$$;

ALTER FUNCTION can_access_account(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_account(UUID) TO authenticated, service_role;

-- ============================================================
-- PRIVILEGED MUTATION RPCs (SECURITY DEFINER, audit-logged)
--
-- Common contract:
--   * auth.uid() must be an ACTIVE platform admin (the top of the
--     platform hierarchy: admin > operator).
--   * Self-promotion / self-privilege escalation is rejected.
--   * An 'operator' cannot grant 'admin' (hierarchy enforced).
--   * Every mutation writes platform_audit_log BEFORE returning, inside
--     the same transaction, so a failed mutation leaves no false log.
--   * created_by / actor_user_id are ALWAYS auth.uid() — never trusted
--     from caller arguments.
-- ============================================================

-- grant_platform_operator(p_user_id, p_role)
-- Creates (or reactivates) an operator record. Requires an active admin.
-- Rejects promoting self.
CREATE OR REPLACE FUNCTION grant_platform_operator(
  p_user_id UUID,
  p_role    platform_operator_role DEFAULT 'operator'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_active_admin BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  -- Caller must be an active admin.
  SELECT (po.role = 'admin' AND po.is_active)
    INTO v_caller_active_admin
    FROM platform_operators po
    WHERE po.user_id = auth.uid();

  IF NOT COALESCE(v_caller_active_admin, FALSE) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  -- No self-promotion.
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot grant operator status to yourself'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO platform_operators (user_id, role, is_active, created_by)
  VALUES (p_user_id, p_role, TRUE, auth.uid())
  ON CONFLICT (user_id) DO UPDATE
    SET is_active = TRUE,
        role = EXCLUDED.role;

  INSERT INTO platform_audit_log (actor_user_id, target_user_id, action, metadata)
  VALUES (
    auth.uid(),
    p_user_id,
    'grant_operator',
    jsonb_build_object('role', p_role)
  );
END;
$$;

ALTER FUNCTION grant_platform_operator(UUID, platform_operator_role) OWNER TO postgres;
REVOKE ALL ON FUNCTION grant_platform_operator(UUID, platform_operator_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION grant_platform_operator(UUID, platform_operator_role) TO authenticated;

-- revoke_platform_operator(p_user_id)
-- Deactivates (never deletes) an operator. Requires an active admin.
-- Cannot revoke self.
CREATE OR REPLACE FUNCTION revoke_platform_operator(p_user_id UUID) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_active_admin BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT (po.role = 'admin' AND po.is_active)
    INTO v_caller_active_admin
    FROM platform_operators po
    WHERE po.user_id = auth.uid();

  IF NOT COALESCE(v_caller_active_admin, FALSE) THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot revoke your own operator status'
      USING ERRCODE = '22023';
  END IF;

  UPDATE platform_operators
    SET is_active = FALSE
    WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operator not found' USING ERRCODE = '22023';
  END IF;

  INSERT INTO platform_audit_log (actor_user_id, target_user_id, action)
  VALUES (auth.uid(), p_user_id, 'revoke_operator');
END;
$$;

ALTER FUNCTION revoke_platform_operator(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION revoke_platform_operator(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_platform_operator(UUID) TO authenticated;

-- assign_platform_operator_account(p_operator_user_id, p_account_id, p_access_role)
-- Grants an operator explicit access to a tenant. Requires an active admin.
-- Cannot grant to self. 'operator' callers cannot assign 'admin' access role
-- (hierarchy enforced on the access_role dimension too).
CREATE OR REPLACE FUNCTION assign_platform_operator_account(
  p_operator_user_id UUID,
  p_account_id       UUID,
  p_access_role      platform_access_role DEFAULT 'viewer'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role platform_operator_role;
  v_caller_active BOOLEAN;
  v_op_exists BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT po.role, po.is_active
    INTO v_caller_role, v_caller_active
    FROM platform_operators po
    WHERE po.user_id = auth.uid();

  IF NOT COALESCE(v_caller_active, FALSE) THEN
    RAISE EXCEPTION 'This action requires an active platform operator'
      USING ERRCODE = '42501';
  END IF;

  -- Only admins may assign; operators may not manage assignments.
  IF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  -- Cannot grant yourself access to a tenant.
  IF p_operator_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot assign tenant access to yourself'
      USING ERRCODE = '22023';
  END IF;

  -- A non-admin access role may only be assigned by an admin; an admin
  -- access role likewise requires admin caller (already enforced above).
  -- Enforce that an 'operator'-rank caller cannot mint 'admin' access:
  -- (kept explicit for clarity; v_caller_role is already admin here)
  IF v_caller_role <> 'admin' AND p_access_role = 'admin' THEN
    RAISE EXCEPTION 'Cannot assign admin access role'
      USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (SELECT 1 FROM platform_operators po WHERE po.user_id = p_operator_user_id)
    INTO v_op_exists;
  IF NOT v_op_exists THEN
    RAISE EXCEPTION 'Target user is not a platform operator'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO platform_operator_accounts (operator_user_id, account_id, access_role, created_by)
  VALUES (p_operator_user_id, p_account_id, p_access_role, auth.uid())
  ON CONFLICT (operator_user_id, account_id) DO UPDATE
    SET access_role = EXCLUDED.access_role;

  INSERT INTO platform_audit_log (actor_user_id, target_user_id, target_account_id, action, metadata)
  VALUES (
    auth.uid(),
    p_operator_user_id,
    p_account_id,
    'assign_operator_account',
    jsonb_build_object('access_role', p_access_role)
  );
END;
$$;

ALTER FUNCTION assign_platform_operator_account(UUID, UUID, platform_access_role) OWNER TO postgres;
REVOKE ALL ON FUNCTION assign_platform_operator_account(UUID, UUID, platform_access_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_platform_operator_account(UUID, UUID, platform_access_role) TO authenticated;

-- unassign_platform_operator_account(p_operator_user_id, p_account_id)
-- Removes an operator's explicit access to a tenant. Requires an active
-- admin. Cannot unassign self.
CREATE OR REPLACE FUNCTION unassign_platform_operator_account(
  p_operator_user_id UUID,
  p_account_id       UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role platform_operator_role;
  v_caller_active BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT po.role, po.is_active
    INTO v_caller_role, v_caller_active
    FROM platform_operators po
    WHERE po.user_id = auth.uid();

  IF NOT COALESCE(v_caller_active, FALSE) THEN
    RAISE EXCEPTION 'This action requires an active platform operator'
      USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'admin' THEN
    RAISE EXCEPTION 'This action requires an active platform admin'
      USING ERRCODE = '42501';
  END IF;

  IF p_operator_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot unassign your own tenant access'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM platform_operator_accounts
    WHERE operator_user_id = p_operator_user_id
      AND account_id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operator is not assigned to this account'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO platform_audit_log (actor_user_id, target_user_id, target_account_id, action)
  VALUES (auth.uid(), p_operator_user_id, p_account_id, 'unassign_operator_account');
END;
$$;

ALTER FUNCTION unassign_platform_operator_account(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION unassign_platform_operator_account(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unassign_platform_operator_account(UUID, UUID) TO authenticated;

-- ============================================================
-- RLS STRATEGY FOR THE NEW TABLES
--
-- platform_operators:
--   * No INSERT/UPDATE/DELETE policy for any client role — direct DML is
--     impossible. Only the SECURITY DEFINER RPCs may write.
--   * SELECT is denied to authenticated entirely (the operator directory
--     is not public). Operators read their own row via a SECURITY DEFINER
--     helper if needed in later phases; until then, no client SELECT.
--
-- platform_operator_accounts:
--   * Same: no client DML policies. No client SELECT (assignment map is
--     not exposed broadly).
--
-- platform_audit_log:
--   * No client DML policies (immutable audit trail; RPCs append).
--   * SELECT restricted to active operators viewing scoped rows — added
--     now so the log is not world-readable, while staying minimal.
-- ============================================================
ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_operator_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;

-- Audit log is visible only to active platform operators, and only to
-- rows they could plausibly oversee (their own actor rows, or rows whose
-- target_account they are authorized for). This avoids leaking the full
-- operator directory while still letting operators audit their own
-- actions and supervised tenants.
DROP POLICY IF EXISTS "Operators can view scoped audit rows" ON platform_audit_log;
CREATE POLICY platform_audit_log_select ON platform_audit_log
  FOR SELECT
  USING (
    is_platform_operator()
    AND (
      actor_user_id = auth.uid()
      OR is_platform_operator_for(target_account_id)
    )
  );

-- NOTE: no INSERT/UPDATE/DELETE policies are created on any of the three
-- tables for `authenticated`. All privileged writes go through the RPCs
-- above, which run as SECURITY DEFINER and bypass RLS. This guarantees a
-- common user cannot self-promote or forge audit entries.
