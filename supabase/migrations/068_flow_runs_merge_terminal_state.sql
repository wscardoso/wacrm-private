-- ============================================================
-- 068_flow_runs_merge_terminal_state.sql — estado terminal distinguível
--
-- HOTFIX-001 B.5; ADR-CONTACT-MERGE-001 §7.2(d). Runs ativos
-- não-sobreviventes de um merge transicionam para
-- 'superseded_by_identity_merge' — distinguível de toda terminação
-- natural (completed / handed_off / timed_out / paused_by_agent /
-- failed). end_reason segue o formato
-- 'identity_merge:<merge_run_id>:<survivor_flow_run_id>' e ended_at é
-- sempre gravado com o instante do merge (A8, MERGE §11).
-- ============================================================

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_status_check;

ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_status_check
  CHECK (status IN (
    'active',
    'completed',
    'handed_off',
    'timed_out',
    'paused_by_agent',
    'failed',
    'superseded_by_identity_merge'
  ));
