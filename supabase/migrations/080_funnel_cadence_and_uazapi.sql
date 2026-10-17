-- ============================================================
-- 080_funnel_cadence_and_uazapi.sql
--
-- 1. Deals enhancements:
--    - loss_reason TEXT NULL for deals marked as lost
--    - custom_fields JSONB DEFAULT '{}'::jsonb for custom deal metadata
--    - default currency changed from 'USD' to 'BRL'
-- 2. Accounts default currency changed from 'USD' to 'BRL'
-- 3. Automations cadence pause:
--    - cancel_on_reply BOOLEAN NOT NULL DEFAULT true
-- 4. Lead distribution routing:
--    - account_lead_routing table for deterministic round-robin
-- ============================================================

-- 1. Deals enhancements
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS loss_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE deals
  ALTER COLUMN currency SET DEFAULT 'BRL';

-- 2. Accounts currency default
ALTER TABLE accounts
  ALTER COLUMN default_currency SET DEFAULT 'BRL';

-- 3. Automations cadence pause flag
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS cancel_on_reply BOOLEAN NOT NULL DEFAULT true;

-- 4. Lead distribution routing table
CREATE TABLE IF NOT EXISTS account_lead_routing (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_assigned_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE account_lead_routing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_lead_routing_select ON account_lead_routing;
CREATE POLICY account_lead_routing_select ON account_lead_routing
  FOR SELECT USING (is_account_member(account_id));

-- No client-side write path exists: the round-robin in
-- src/lib/automations/engine.ts writes through supabaseAdmin()
-- (service-role, outside RLS). Mirror 079's defense-in-depth: drop the
-- former FOR ALL policy and revoke the unused table-wide DML privilege
-- so a future accidental permissive policy cannot make it writable by
-- `authenticated` without an explicit re-grant.
DROP POLICY IF EXISTS account_lead_routing_manage ON account_lead_routing;
REVOKE INSERT, UPDATE, DELETE ON account_lead_routing FROM authenticated;

-- 5. Cadence cancellation state
-- cancelPendingCadencesForContact() marks a parked wait as 'cancelled'
-- (distinct from 'done' = ran to completion). Extend the 006 CHECK.
ALTER TABLE automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;
ALTER TABLE automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled'));

-- 6. Index supporting the per-contact cancellation lookup
-- (account_id + contact_id + status='pending').
CREATE INDEX IF NOT EXISTS idx_automation_pending_account_contact
  ON automation_pending_executions(account_id, contact_id, status);
