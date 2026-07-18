-- ============================================================
-- 038_platform_read_context.sql
-- P1b — Platform operator READ-ONLY access to tenant data, via
-- explicit per-URL context (resolved server-side) and enforced
-- by RLS. The URL is ONLY a selector; authorization is always
-- re-checked by the database using auth.uid() + can_access_account().
--
-- Scoping & invariants (do NOT violate):
--   * accounts / profiles / owner_user_id UNTOUCHED.
--   * idx_accounts_one_per_owner preserved.
--   * profiles stays single-membership.
--   * is_account_member() UNCHANGED (not altered in 037, not now).
--   * WRITE policies (INSERT/UPDATE/DELETE) are NOT touched — a platform
--     operator is never a member, so can_access_account() grants SELECT
--     only; every write policy still requires is_account_member(...) with
--     a minimum role, which an operator can never satisfy.
--   * whatsapp_config is DELIBERATELY EXCLUDED from this read grant
--     (see "SECRETS" section below).
--
-- What this migration adds:
--   1. Extends each tenant-domain SELECT policy with
--        ... OR can_access_account(<account_id>)
--      so an authorized platform operator may READ the rows of the
--      tenant(s) they supervise, while members keep their existing path.
--   2. Three audit RPCs stamping actor_user_id = auth.uid() — never
--      trusted from caller args:
--        log_platform_context_entered
--        log_platform_context_exited
--        log_platform_context_denied
--
-- SECRETS: whatsapp_config holds credentials/tokens (access tokens,
-- phone_number_id, webhook secrets). RLS cannot mask columns, so
-- widening its SELECT to operators would expose secrets. It is left
-- out of this batch by design. The operator inbox proof therefore
-- does not read whatsapp_config; the client suppresses the connection
-- banner under platform context. Revisit with column-level controls
-- or a redacted view in a later phase before exposing it.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. EXTEND SELECT POLICIES (read-only additive grant)
--
-- Pattern: every SELECT policy currently gates on
--   is_account_member(<account_id>)
-- We append
--   OR can_access_account(<account_id>)
-- can_access_account() already composes is_account_member() OR
-- is_platform_operator_for(), so members are unaffected and
-- authorized operators gain read. Write policies are untouched.
--
-- Note: DROP+CREATE per policy (Postgres has no CREATE POLICY IF
-- NOT EXISTS). Only SELECT policies are dropped/recreated; write
-- policies keep their exact 017 definitions.
-- ============================================================

-- ---- accounts --------------------------------------------------
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts
  FOR SELECT USING (is_account_member(id) OR can_access_account(id));

-- ---- contacts (parent) ----------------------------------------
DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- tags (settings-class, parent) ----------------------------
DROP POLICY IF EXISTS tags_select ON tags;
CREATE POLICY tags_select ON tags
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- custom_fields (parent) -----------------------------------
DROP POLICY IF EXISTS custom_fields_select ON custom_fields;
CREATE POLICY custom_fields_select ON custom_fields
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- contact_notes (parent) -----------------------------------
DROP POLICY IF EXISTS contact_notes_select ON contact_notes;
CREATE POLICY contact_notes_select ON contact_notes
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- conversations (parent) -----------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- message_templates (parent) -------------------------------
DROP POLICY IF EXISTS message_templates_select ON message_templates;
CREATE POLICY message_templates_select ON message_templates
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- pipelines (parent) ---------------------------------------
DROP POLICY IF EXISTS pipelines_select ON pipelines;
CREATE POLICY pipelines_select ON pipelines
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- deals (parent) -------------------------------------------
DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- broadcasts (parent) --------------------------------------
DROP POLICY IF EXISTS broadcasts_select ON broadcasts;
CREATE POLICY broadcasts_select ON broadcasts
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- automations (parent) ------------------------------------
DROP POLICY IF EXISTS automations_select ON automations;
CREATE POLICY automations_select ON automations
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- automation_logs (parent) ---------------------------------
DROP POLICY IF EXISTS automation_logs_select ON automation_logs;
CREATE POLICY automation_logs_select ON automation_logs
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- flows (parent) -------------------------------------------
DROP POLICY IF EXISTS flows_select ON flows;
CREATE POLICY flows_select ON flows
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- flow_runs (parent) ---------------------------------------
DROP POLICY IF EXISTS flow_runs_select ON flow_runs;
CREATE POLICY flow_runs_select ON flow_runs
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- lead_attributions (parent) -------------------------------
DROP POLICY IF EXISTS lead_attributions_select ON lead_attributions;
CREATE POLICY lead_attributions_select ON lead_attributions
  FOR SELECT USING (is_account_member(account_id) OR can_access_account(account_id));

-- ---- contact_tags (child of contacts) -------------------------
DROP POLICY IF EXISTS contact_tags_select ON contact_tags;
CREATE POLICY contact_tags_select ON contact_tags
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_tags.contact_id
            AND (is_account_member(c.account_id) OR can_access_account(c.account_id)))
  );

-- ---- contact_custom_values (child of contacts) ----------------
DROP POLICY IF EXISTS contact_custom_values_select ON contact_custom_values;
CREATE POLICY contact_custom_values_select ON contact_custom_values
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_custom_values.contact_id
            AND (is_account_member(c.account_id) OR can_access_account(c.account_id)))
  );

-- ---- messages (child of conversations) ------------------------
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id
            AND (is_account_member(c.account_id) OR can_access_account(c.account_id)))
  );

-- ---- pipeline_stages (child of pipelines) ---------------------
DROP POLICY IF EXISTS pipeline_stages_select ON pipeline_stages;
CREATE POLICY pipeline_stages_select ON pipeline_stages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM pipelines p WHERE p.id = pipeline_stages.pipeline_id
            AND (is_account_member(p.account_id) OR can_access_account(p.account_id)))
  );

-- ---- broadcast_recipients (child of broadcasts) ---------------
DROP POLICY IF EXISTS broadcast_recipients_select ON broadcast_recipients;
CREATE POLICY broadcast_recipients_select ON broadcast_recipients
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = broadcast_recipients.broadcast_id
            AND (is_account_member(b.account_id) OR can_access_account(b.account_id)))
  );

-- ---- automation_steps (child of automations) ------------------
DROP POLICY IF EXISTS automation_steps_select ON automation_steps;
CREATE POLICY automation_steps_select ON automation_steps
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id
            AND (is_account_member(a.account_id) OR can_access_account(a.account_id)))
  );

-- ---- flow_nodes (child of flows) ------------------------------
DROP POLICY IF EXISTS flow_nodes_select ON flow_nodes;
CREATE POLICY flow_nodes_select ON flow_nodes
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id
            AND (is_account_member(f.account_id) OR can_access_account(f.account_id)))
  );

-- ---- flow_run_events (optional child of flow_runs) ------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'flow_run_events'
             AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS flow_run_events_select ON flow_run_events;
    CREATE POLICY flow_run_events_select ON flow_run_events
      FOR SELECT USING (
        EXISTS (SELECT 1 FROM flow_runs r WHERE r.id = flow_run_events.flow_run_id
                AND (is_account_member(r.account_id) OR can_access_account(r.account_id)))
      );
  END IF;
END $$;

-- ---- message_reactions (optional child of messages) -----------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'message_reactions'
             AND relnamespace = 'public'::regnamespace) THEN
    DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
    CREATE POLICY message_reactions_select ON message_reactions
      FOR SELECT USING (
        EXISTS (
          SELECT 1 FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = message_reactions.message_id
            AND (is_account_member(c.account_id) OR can_access_account(c.account_id))
        )
      );
  END IF;
END $$;

-- ============================================================
-- 2. AUDIT RPCs — context entered / exited / denied
--
-- Every one stamps actor_user_id = auth.uid() (NEVER trusted from
-- the caller). These are pure inserts into platform_audit_log.
-- ============================================================

CREATE OR REPLACE FUNCTION log_platform_context_entered(p_target_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action)
  VALUES (auth.uid(), p_target_account_id, 'context_entered');
END;
$$;

ALTER FUNCTION log_platform_context_entered(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION log_platform_context_entered(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_platform_context_entered(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION log_platform_context_exited(p_target_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action)
  VALUES (auth.uid(), p_target_account_id, 'context_exited');
END;
$$;

ALTER FUNCTION log_platform_context_exited(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION log_platform_context_exited(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_platform_context_exited(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION log_platform_context_denied(p_target_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  INSERT INTO platform_audit_log (actor_user_id, target_account_id, action)
  VALUES (auth.uid(), p_target_account_id, 'context_access_denied');
END;
$$;

ALTER FUNCTION log_platform_context_denied(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION log_platform_context_denied(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_platform_context_denied(UUID) TO authenticated;
