-- ============================================================
-- 087_function_execute_acl_hardening.sql
--
-- STATUS: DRAFT — NOT APPLIED. Do not run against production without
-- Commander approval. The number 087 is provisional: 085/086 are also
-- drafts (outbound facades / messages direct-write hardening) and the
-- final numbering is decided at integration.
--
-- P0-5 — SECURITY DEFINER EXECUTE surface.
--
-- Evidence of the defect class
--   * 082_enqueue_webhook_dlq_hardening.sql records the same bug on
--     enqueue_webhook_dlq (031): the function was created SECURITY
--     DEFINER and the migration revoked only PUBLIC. The operator
--     measured, on the real project, that anon/authenticated could
--     still execute it (execute_grantees=["postgres","service_role"]
--     only after the corrective REVOKE ... FROM anon, authenticated).
--   * On Supabase, the default privileges of the `postgres` role grant
--     EXECUTE explicitly to anon/authenticated/service_role. Those are
--     ACL entries, not the PUBLIC grant, so `REVOKE ... FROM PUBLIC`
--     alone leaves them in place. 084 already uses the correct form
--     ("Revoke explicit grants, not only PUBLIC": PUBLIC, anon,
--     authenticated, service_role).
--
--   * 056_enrichment_ledger.sql locks six service-role RPCs with
--     `REVOKE ALL ... FROM PUBLIC` only (lines 99, 153, 208, 296, 328,
--     357) and grants service_role. get_enrichment_report (line 402)
--     revokes PUBLIC only and grants authenticated (its body checks
--     is_account_member, so the residual risk there is anon, not a
--     cross-tenant read).
--   * 055_ad_account_credentials.sql does the same for
--     get_ad_account_credential (line 202): PUBLIC-only revoke, grant
--     service_role. It returns the stored ciphertext of a tenant's
--     Marketing API credential — still secret material, even though
--     decryption needs the app key.
--
-- What is / is not proven
--   * CONFIRMED IN CODE: the six 056 RPCs and get_ad_account_credential
--     revoke only PUBLIC.
--   * CONFIRMED BY PRIOR OPERATOR MEASUREMENT (082): on this project,
--     default explicit grants to anon/authenticated survive that
--     revoke. It is the same mechanism, not a new assumption.
--   * NOT VERIFIED IN THE CURRENT DATABASE: the actual proacl of these
--     seven functions. Run scripts/diagnostics/security-definer-execute-acl.sql
--     first. If the ACL already shows only postgres/service_role, this
--     migration is a no-op (idempotent by construction).
--
-- Exploitability if the default grants are present
--   * claim_enrichment_batch(INTEGER, UUID) with p_account_id = NULL
--     claims across ALL tenants. An authenticated user of any tenant
--     could mark other tenants' rows as claimed (availability/integrity)
--     and read the returned rows (cross-tenant data exposure).
--   * resolve_enrichment_success/failure mutate any ledger row by id.
--   * reclaim_stuck_enrichment / expire_stale_enrichments mutate rows
--     across tenants.
--   * get_ad_account_credential(UUID) returns another tenant's
--     ciphertext.
--
-- Rollback
--   * Only REVOKE/GRANT changes on functions that already existed; no
--     DDL body changes, no data changes. Re-granting is possible with
--     GRANT EXECUTE ... TO anon/authenticated, but that should never be
--     needed: the application calls these RPCs with the service-role
--     client only.
--   * Re-running is safe (REVOKE and GRANT are idempotent).
--
-- Preconditions checked by the diagnostic, not by this file
--   * Each signature below must exist. If any is missing, this script
--     fails on that statement (fail-closed; the rest still applies).
-- ============================================================

BEGIN;

-- ── 056: service-role-only enrichment RPCs ─────────────────
REVOKE ALL ON FUNCTION public.enqueue_pending_attributions()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_pending_attributions()
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_enrichment_batch(INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_enrichment_batch(INTEGER, UUID)
  TO service_role;

REVOKE ALL ON FUNCTION public.resolve_enrichment_success(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_enrichment_success(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.resolve_enrichment_failure(
  UUID, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_enrichment_failure(
  UUID, TEXT, TEXT, INTEGER
) TO service_role;

REVOKE ALL ON FUNCTION public.reclaim_stuck_enrichment()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stuck_enrichment()
  TO service_role;

REVOKE ALL ON FUNCTION public.expire_stale_enrichments()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_enrichments()
  TO service_role;

-- ── 056: authenticated report (member-checked in the body) ─
-- anon must not even reach the function. authenticated keeps EXECUTE;
-- the body's is_account_member(p_account_id) is the tenant control.
REVOKE ALL ON FUNCTION public.get_enrichment_report(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_enrichment_report(UUID)
  TO authenticated;

-- ── 055: Marketing API credential (ciphertext) ─────────────
REVOKE ALL ON FUNCTION public.get_ad_account_credential(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ad_account_credential(UUID)
  TO service_role;

-- set/revoke stay executable by authenticated: their bodies require a
-- platform operator (poa.account_id = p_account_id) and they never
-- return the ciphertext. Revoke the anonymous path only.
REVOKE ALL ON FUNCTION public.set_ad_account_credential(UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ad_account_credential(UUID, TEXT, TIMESTAMPTZ)
  TO authenticated;

REVOKE ALL ON FUNCTION public.revoke_ad_account_credential(UUID, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_ad_account_credential(UUID, TEXT)
  TO authenticated;

COMMIT;

-- Post-apply verification (run separately, read-only):
--   scripts/diagnostics/security-definer-execute-acl.sql
-- Expect: the seven service-role-only functions list only
-- postgres/service_role in proacl, and get_enrichment_report lists
-- postgres/authenticated/service_role (no anon, no PUBLIC).
