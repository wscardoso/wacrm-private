-- ============================================================
-- 082_enqueue_webhook_dlq_hardening.sql
--
-- L5 — security fix for public.enqueue_webhook_dlq (031). Corrective only.
--
-- STATUS (updated): reported by the operator as applied manually to the
-- Supabase Cloud project on 2026-10-18; the post-apply check in
-- scripts/diagnostics/l5-enqueue-webhook-dlq-exposure.sql was reported with
-- hardened=true, execute_grantees=["postgres","service_role"],
-- has_ownership_check=true, overloads_in_public=1 (2026-10-18 21:35 UTC).
-- These results were produced by the operator and were NOT re-run from this
-- repository; that the text executed there is byte-identical to this file is
-- not verifiable here. This file is the repository record of the change. It is
-- idempotent, so re-running it (for example from a migration tool) is safe.
-- Not verified: a functional write test on the Cloud, and a review of
-- historical API logs for earlier misuse.
--
-- Evidence of the problem
--   * 031 created the function SECURITY DEFINER and never revoked the default
--     EXECUTE, so PUBLIC could call it. Unlike its siblings
--     (007 increment_automation_execution_count, 035 insert_inbound_message,
--     which REVOKE then GRANT service_role).
--   * Operator-reported query on the real Supabase project confirmed:
--       enqueue_webhook_dlq(uuid,uuid,jsonb,text): security_definer = true,
--       anon_can_execute = true, authenticated_can_execute = true,
--       service_role_can_execute = true, owner postgres, search_path=public.
--     (Reported by the operator; not independently re-run from this repository.)
--   * 031 has two independent FKs (account_id, whatsapp_config_id), so any
--     existing account/config PAIR was accepted — including a config that
--     belongs to a different account. Because the function bypasses RLS, a
--     client role holding two valid UUIDs could write rows into another
--     tenant's DLQ.
--
-- What this migration does (and nothing else)
--   1. The function now verifies that the whatsapp_config belongs to the
--      account before inserting (SQLSTATE 42501 otherwise).
--   2. EXECUTE is revoked from PUBLIC, anon and authenticated and granted
--      only to service_role (same pattern as 007/012/035).
--   Signature, return type, owner, SECURITY DEFINER and search_path are
--   unchanged. No new columns, no claim/retry/drain, no retention decision.
--
-- Behaviour change to be aware of: an unknown config or account now fails
-- with 42501 (ownership check) instead of the FK error 23503. The function
-- has no caller in src/ today (checked by grep and by a repository test).
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enqueue_webhook_dlq(
  p_account_id UUID,
  p_whatsapp_config_id UUID,
  p_payload JSONB,
  p_error_message TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.whatsapp_config c
     WHERE c.id = p_whatsapp_config_id
       AND c.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'enqueue_webhook_dlq: whatsapp_config does not belong to the account'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.whatsapp_webhook_dlq (
    account_id, whatsapp_config_id, payload, error_message
  ) VALUES (p_account_id, p_whatsapp_config_id, p_payload, p_error_message)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_webhook_dlq(UUID, UUID, JSONB, TEXT) TO service_role;
