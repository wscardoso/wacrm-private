-- 084_reconcile_settlement_authorization.sql
--
-- STATUS: reported by the operator as APPLIED manually to the Supabase
-- project. Verified from the catalog (operator-run query, output reviewed in
-- the session):
--   * the six functions below exist, owner postgres, SECURITY DEFINER, jsonb;
--   * EXECUTE: *_core -> nobody; settle_outbound_message and
--     enqueue_outbound_retry -> authenticated only; *_system -> service_role
--     only; anon -> none;
--   * md5(prosrc) of settle_outbound_message_core / settle_outbound_message /
--     settle_outbound_message_system equals the md5 of the bodies in this file,
--     and md5 of enqueue_outbound_retry_core / enqueue_outbound_retry /
--     enqueue_outbound_retry_system equals the bodies in 052 (the stored
--     bodies carry CRLF line endings, i.e. the text was applied from a CRLF
--     source).
-- Not verified: the pre-084 definition of settle_outbound_message (it was not
-- captured here), a functional call as each role, and the date of application.
-- This file is the repository record of that change. It is idempotent
-- (CREATE OR REPLACE + REVOKE/GRANT), so re-running it is safe, provided the
-- functions it names already exist with these exact signatures.
--
-- Objectives:
--   1. Restore authorization of the human facade.
--   2. Create the single settlement core.
--   3. Create the service_role-only facade.
--   4. Restrict direct access to the settlement and retry cores.
--   5. Preserve the signature and jsonb return that /send expects.
--
-- Preconditions:
--   - The human facade returns jsonb (CREATE OR REPLACE cannot change it).
--   - Signatures and dependencies exist in the target database
--     (migrations 047, 051, 052).
--   - pg_get_functiondef and ACLs captured before applying.

BEGIN;

-- ============================================================
-- 1. CORE: single authority for the message transition
-- ============================================================

CREATE OR REPLACE FUNCTION public.settle_outbound_message_core(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_outcome TEXT;
BEGIN
  SELECT status
    INTO v_current_status
    FROM public.messages
   WHERE id = p_message_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'settle_outbound_message: message not found (id: %)',
      p_message_id;
  END IF;

  -- Compare-and-set: somente mensagens em sending podem transicionar.
  IF v_current_status <> 'sending' THEN
    RETURN jsonb_build_object(
      'messageId', p_message_id,
      'outcome', 'noop'
    );
  END IF;

  IF p_status = 'sent' THEN
    IF p_provider_message_id IS NULL THEN
      RAISE EXCEPTION
        'settle_outbound_message: provider_message_id is required for status sent';
    END IF;

    UPDATE public.messages
       SET status = 'sent',
           message_id = p_provider_message_id
     WHERE id = p_message_id;

    IF p_connection_ref IS NOT NULL
       AND p_identities IS NOT NULL
       AND jsonb_array_length(p_identities) > 0
    THEN
      INSERT INTO public.message_external_ids (
        message_id,
        connection_ref,
        kind,
        value
      )
      SELECT
        (item->>'message_id')::UUID,
        (item->>'connection_ref')::UUID,
        item->>'kind',
        item->>'value'
      FROM jsonb_array_elements(p_identities) AS item;
    END IF;

    v_outcome := 'sent';

  ELSIF p_status = 'failed' THEN
    UPDATE public.messages
       SET status = 'failed'
     WHERE id = p_message_id;

    v_outcome := 'failed';

  ELSE
    RAISE EXCEPTION
      'settle_outbound_message: invalid status: %',
      p_status;
  END IF;

  RETURN jsonb_build_object(
    'messageId', p_message_id,
    'outcome', v_outcome
  );
END;
$$;

-- Revoke explicit grants, not only PUBLIC.
REVOKE ALL ON FUNCTION public.settle_outbound_message_core(
  UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================
-- 2. HUMAN FACADE: per-account authorization
-- ============================================================

-- CREATE OR REPLACE preserves the existing signature.
-- Precondition: the current function already returns jsonb.

CREATE OR REPLACE FUNCTION public.settle_outbound_message(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT c.account_id
    INTO v_account_id
    FROM public.messages m
    JOIN public.conversations c
      ON c.id = m.conversation_id
   WHERE m.id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'settle_outbound_message: message not found (id: %)',
      p_message_id;
  END IF;

  IF NOT (
    public.is_account_member(v_account_id)
    OR public.can_access_account(v_account_id)
  ) THEN
    RAISE EXCEPTION
      'settle_outbound_message: not authorized for account %',
      v_account_id;
  END IF;

  RETURN public.settle_outbound_message_core(
    p_message_id,
    p_status,
    p_connection_ref,
    p_provider_message_id,
    p_identities
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_outbound_message(
  UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.settle_outbound_message(
  UUID, TEXT, UUID, TEXT, JSONB
) TO authenticated;


-- ============================================================
-- 3. SYSTEM FACADE: service_role only
-- ============================================================

CREATE OR REPLACE FUNCTION public.settle_outbound_message_system(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.settle_outbound_message_core(
    p_message_id,
    p_status,
    p_connection_ref,
    p_provider_message_id,
    p_identities
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_outbound_message_system(
  UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.settle_outbound_message_system(
  UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;


-- ============================================================
-- 4. RETRY CORE: prevent direct calls
-- ============================================================

-- The existing function is kept; only privileges change.
-- The signature must exist exactly as below.

REVOKE ALL ON FUNCTION public.enqueue_outbound_retry_core(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================
-- 5. RETRY FACADES
-- ============================================================

-- Human facade: keep its internal authorization and allow only the
-- authenticated role.
REVOKE ALL ON FUNCTION public.enqueue_outbound_retry(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.enqueue_outbound_retry(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) TO authenticated;

-- System facade: keep the path of internal processes.
REVOKE ALL ON FUNCTION public.enqueue_outbound_retry_system(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_outbound_retry_system(
  UUID, TEXT, TIMESTAMPTZ, TEXT
) TO service_role;

COMMIT;
