-- ============================================================
-- 054_platform_workspace_identity_update.sql — E5b: Platform Workspace
-- Identity Management
--
-- Feature Contract: docs/architecture/E5-workspace-commercial-identity.md
-- (§4, §8.2, §8.3, §9). Depends on E5a (053) for the three identity
-- columns — this migration adds ZERO columns, only the platform-side
-- write RPC + its audit action.
--
-- update_platform_workspace_identity(p_account_id, p_updates) is the
-- structural sibling of create_platform_workspace (042/043): same
-- SECURITY DEFINER / OWNER / REVOKE+GRANT shape, same 42501 for
-- unauthorized, same 22023 for structural validation, same single-
-- transaction audit write. The one deliberate difference is the
-- authorization PREDICATE: 042/043 create a brand-new tenant (no
-- target yet) and gate on "platform_operators.role = 'admin'" (global
-- admin rank). This RPC targets an EXISTING, already-supervised tenant,
-- so it gates on tenant-scoped admin role instead
-- (platform_operator_accounts.access_role = 'admin'). This is the
-- same Scope-vs-Action distinction documented in §8.2 of the E5
-- Feature Contract: viewer/agent operators can ACCESS the tenant
-- (scope gate / can_access_account) but only admin operators can
-- MUTATE its identity (action gate / access_role check).
--
-- p_updates is a JSONB partial-update payload — the SQL-side expression
-- of the exact partial-update contract (§7.5) already implemented by
-- the member-side PATCH /api/account (053/route.ts): a key OMITTED from
-- p_updates leaves that column UNCHANGED; a key present with JSON null
-- CLEARS the column. Recognized keys: name, legal_name,
-- commercial_phone, commercial_email, cnpj. Plain scalar parameters
-- cannot represent the omitted-vs-null distinction (a SQL NULL default
-- and an explicit NULL argument are indistinguishable), so JSONB is the
-- only faithful way to give both writers identical partial-update
-- semantics (§5) without duplicating overloads.
--
-- Column-level CHECK constraints (053) remain the authoritative
-- validation gate — this RPC does the same LIGHT structural validation
-- 042/043 already do for name/cnpj (fail fast with 22023 before
-- attempting the UPDATE), and otherwise lets 053's CHECK constraints
-- (23514) / 041's unique index (23505) do the rest, exactly as the
-- member-side route does.
--
-- Idempotent DDL — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION update_platform_workspace_identity(
  p_account_id UUID,
  p_updates    JSONB
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

  -- Tenant-scoped + action-gated authorization (§8.2): the operator must
  -- be ACTIVE AND explicitly authorized for THIS account (scope gate,
  -- same as can_access_account/037) AND hold access_role = 'admin' for
  -- this tenant (action gate). A viewer or agent operator with a valid
  -- platform_operator_accounts row passes the scope gate but FAILS the
  -- action gate — identity mutation requires admin rank on the target
  -- tenant. A non-operator, an operator of a DIFFERENT tenant, and an
  -- operator with no row for this account all fail identically with
  -- 42501 — matching 042's posture of never leaking which check failed.
  IF NOT EXISTS (
    SELECT 1
    FROM platform_operators po
    JOIN platform_operator_accounts poa
      ON poa.operator_user_id = po.user_id
    WHERE po.user_id = auth.uid()
      AND po.is_active
      AND poa.account_id = p_account_id
      AND poa.access_role = 'admin'
  ) THEN
    RAISE EXCEPTION 'This action requires platform admin access to this account'
      USING ERRCODE = '42501';
  END IF;

  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' THEN
    RAISE EXCEPTION 'p_updates must be a JSON object' USING ERRCODE = '22023';
  END IF;

  IF NOT (p_updates ?| ARRAY['name','legal_name','commercial_phone','commercial_email','cnpj']) THEN
    RAISE EXCEPTION 'No recognized fields in p_updates' USING ERRCODE = '22023';
  END IF;

  -- name is NOT NULL at the schema level (001) — explicit null/blank
  -- would violate that constraint; reject early with the same 22023
  -- posture 042/043 use for "Workspace name is required", and the same
  -- wording as the member-side route's validateName().
  IF p_updates ? 'name'
     AND (p_updates->>'name' IS NULL OR btrim(p_updates->>'name') = '') THEN
    RAISE EXCEPTION 'Workspace name cannot be empty' USING ERRCODE = '22023';
  END IF;

  -- cnpj structural check mirrors 042/043 verbatim (14 digits or NULL);
  -- the authoritative gate remains accounts_cnpj_format (041).
  IF p_updates ? 'cnpj' AND p_updates->>'cnpj' IS NOT NULL
     AND p_updates->>'cnpj' !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'Invalid CNPJ format (expected 14 digits)'
      USING ERRCODE = '22023';
  END IF;

  UPDATE accounts SET
    name             = CASE WHEN p_updates ? 'name'             THEN btrim(p_updates->>'name') ELSE name END,
    legal_name       = CASE WHEN p_updates ? 'legal_name'       THEN p_updates->>'legal_name' ELSE legal_name END,
    commercial_phone = CASE WHEN p_updates ? 'commercial_phone' THEN p_updates->>'commercial_phone' ELSE commercial_phone END,
    commercial_email = CASE WHEN p_updates ? 'commercial_email' THEN p_updates->>'commercial_email' ELSE commercial_email END,
    cnpj             = CASE WHEN p_updates ? 'cnpj'             THEN p_updates->>'cnpj' ELSE cnpj END
  WHERE id = p_account_id
  RETURNING to_jsonb(accounts.*) INTO v_row;

  IF v_row IS NULL THEN
    -- Structurally unreachable in practice: the authorization check
    -- above already requires a platform_operator_accounts row with
    -- access_role='admin' referencing p_account_id (FK to accounts,
    -- ON DELETE CASCADE), so an unauthorized/nonexistent account was
    -- already rejected above with 42501. Kept as a defensive guard,
    -- not a distinguishable error path an authorized caller can
    -- actually hit.
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  -- Audit — same transaction, real actor, new action. Records WHICH
  -- fields were touched, not their raw values (§9: "sem vazar valores
  -- sensíveis além do necessário") — sufficient for an audit trail
  -- without duplicating PII into a second table.
  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action, metadata)
  VALUES (
    auth.uid(),
    p_account_id,
    'update_workspace_identity',
    jsonb_build_object(
      'fields_changed',
      (SELECT jsonb_agg(k) FROM jsonb_object_keys(p_updates) AS k)
    )
  );

  RETURN v_row;
END;
$$;

ALTER FUNCTION update_platform_workspace_identity(UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION update_platform_workspace_identity(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_platform_workspace_identity(UUID, JSONB) TO authenticated;
