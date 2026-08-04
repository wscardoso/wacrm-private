-- ============================================================
-- 071_identity_merge_backfill_checkpoint.sql — checkpoint do backfill
--
-- HOTFIX-001 Fase E.1/E.2. Unidade de trabalho do backfill é UM grupo
-- de merge ativo ((account_id, phone_identity) com >= 2 contatos) —
-- nunca uma linha, nunca uma conta inteira (E.1).
--
-- O checkpoint é também auditoria de backfill: grupos que falham 5x
-- ficam presos em 'failed' para triagem manual (E.4) e NUNCA são
-- deletados. 'done' grava o merge_run_id retornado pela RPC.
--
-- 'in_progress' + claimed_at forma o lease do runner (E.3.2): se o
-- processo morre entre chamadas de RPC, o lease expira em
-- LEASE_TIMEOUT_SECONDS (default 300s, configurável no runner) e o
-- grupo volta a 'pending' — nunca fica órfão invisível.
-- ============================================================

CREATE TABLE IF NOT EXISTS identity_merge_backfill_checkpoint (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_identity  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  merge_run_id    UUID,               -- preenchido quando status = 'done'
  claimed_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, phone_identity)
);

CREATE INDEX IF NOT EXISTS idx_identity_merge_checkpoint_pending
  ON identity_merge_backfill_checkpoint (account_id, status)
  WHERE status IN ('pending', 'failed');
