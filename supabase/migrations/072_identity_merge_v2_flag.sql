-- ============================================================
-- 072_identity_merge_v2_flag.sql — feature flag de rollout
--
-- HOTFIX-001 A.4/F.1. Um ÚNICO campo por conta, com três valores,
-- codificando os dois sub-estados atados dentro do mesmo registro:
--
--   'off'              -> Estado 0: comportamento atual, sem alteração.
--   'identity_v2'      -> Estado 1: escrita usa phoneIdentity() (menos
--                          duplicatas novas); merge automático OFF —
--                          só o backfill controlado (Fase E) invoca
--                          merge_identity_group().
--   'identity_v2_merge'-> Estado 2: comportamento final — qualquer
--                          caminho que detecte colisão de grupo invoca
--                          merge_identity_group() inline, sob o mesmo
--                          advisory lock do backfill (C.4.2).
--
-- Dois campos booleanos independentes permitiriam a combinação
-- "identidade v2 off + merge auto on" — o exato cenário "flag por
-- caminho" que as revisões originais marcaram como bloqueante. Um
-- campo único com três valores torna essa combinação irrepresentável
-- por construção (F.1). Default 'off' mantém todo estado existente em
-- Estado 0 na aplicação (A.5 passo 2).
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS identity_merge_v2_state TEXT NOT NULL DEFAULT 'off'
    CHECK (identity_merge_v2_state IN ('off', 'identity_v2', 'identity_v2_merge'));
