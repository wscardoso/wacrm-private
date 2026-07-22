-- ============================================================
-- 049_outbound_retry_ledger.sql — E4b: Outbound Retry Ledger
--
-- ARO-001 v3 §7, §9.2, §12, §21.2:
--   Tabela nova, aditiva, molde de 031 (whatsapp_webhook_dlq) e
--   047 (message_external_ids). Guarda, por intenção não-terminal,
--   o estado do processo de reprocesso (tentativas, próximo horário,
--   último erro, classificação, estado do ledger) — nunca o estado
--   da mensagem em si (isso permanece em messages.status, ODI-001).
--
-- Escopo desta migration: apenas a estrutura. Nenhuma RPC de escrita
-- ainda — mirando o precedente de 047 (message_external_ids), a
-- tabela nasce com RLS habilitado e política de leitura apenas;
-- escrita será exclusivamente via função SECURITY DEFINER, a
-- introduzir junto com quem a consome (Commits 4 e 6 do plano de
-- implementação de E4b).
-- ============================================================

-- ------------------------------------------------------------
-- Tabela (ARO-001 §7, §9.2)
--
-- message_id = idempotency_key = messages.id (ODI-001 §6.1) —
-- uma linha de ledger por intenção não-terminal, nunca por
-- tentativa individual (as tentativas incrementam attempt_count
-- na mesma linha).
--
-- classification: vocabulário fixado em ADR-E4B-002 §5 item 3 —
-- ambíguo | determinístico-transitório | determinístico-permanente
-- (nomes concretos, decisão de implementação por ADR-E4B-003 §3.4).
--
-- status: os quatro estados de ARO-001 §9.2 — pending (aguardando
-- drenagem) · retrying (reivindicada por um drenador) · delivered
-- (liquidada sent/noop, encerrada) · dead (DLQ).
--
-- next_attempt_at nullable: representa o caso "ambíguo bloqueado"
-- (ADR-E4B-002 §5 item 2, caminho D — provider sem nenhuma
-- capability) — a intenção fica pending no ledger, mas sem
-- próxima tentativa agendada; só o TTL (ARO-001 §14) a resolve.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outbound_retry_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  attempt_count    INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  last_error       TEXT,
  classification   TEXT NOT NULL
                     CHECK (classification IN ('ambiguous', 'deterministic_transient', 'deterministic_permanent')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'retrying', 'delivered', 'dead')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.outbound_retry_ledger IS
  'ARO-001 v3 §7/§9.2: estado do processo de reprocesso de uma intenção de saída não-terminal. Eixo distinto de messages.status (fato do mundo vs. processo de orquestração, §9.2).';
COMMENT ON COLUMN public.outbound_retry_ledger.message_id IS
  'ODI-001 §6.1: = idempotency_key = messages.id. Uma linha de ledger por intenção, nunca por tentativa.';
COMMENT ON COLUMN public.outbound_retry_ledger.classification IS
  'ADR-E4B-002 §5 item 3: classe de domínio emitida pelo Provider Adapter (ADR-E4B-003 §3.4) — nunca a resposta bruta do provider.';
COMMENT ON COLUMN public.outbound_retry_ledger.next_attempt_at IS
  'NULL representa o caminho D de ADR-E4B-002 §5 item 2 (ambíguo bloqueado, sem capability) — só o TTL (ARO-001 §14) resolve; nunca selecionável pelo scheduler (ARO-001 §12).';
COMMENT ON COLUMN public.outbound_retry_ledger.status IS
  'ARO-001 §9.2: pending (aguardando drenagem) · retrying (reivindicada por um drenador) · delivered (liquidada sent/noop) · dead (DLQ).';

-- ------------------------------------------------------------
-- Índices (ARO-001 §12 — seleção do scheduler; §15 — superfície DLQ)
-- ------------------------------------------------------------

-- Seleção do scheduler: apenas linhas pending com próxima tentativa
-- agendada e devida. Exclui explicitamente next_attempt_at IS NULL
-- (caso bloqueado, ARO-001 §11/§16) — essas nunca são "devidas".
CREATE INDEX IF NOT EXISTS idx_outbound_retry_ledger_due
  ON public.outbound_retry_ledger (next_attempt_at)
  WHERE status = 'pending' AND next_attempt_at IS NOT NULL;

-- Superfície de operação sobre a DLQ (dead) e visão geral por status.
CREATE INDEX IF NOT EXISTS idx_outbound_retry_ledger_status
  ON public.outbound_retry_ledger (status, created_at DESC);

-- Reverse lookup: existe entrada de ledger para esta mensagem?
-- (usado pelo orphan sweeper, ARO-001 §16, para não reenfileirar
-- uma intenção já rastreada).
CREATE INDEX IF NOT EXISTS idx_outbound_retry_ledger_message
  ON public.outbound_retry_ledger (message_id);

-- ------------------------------------------------------------
-- updated_at (reuso do trigger já existente, 001_initial_schema.sql)
-- ------------------------------------------------------------
CREATE OR REPLACE TRIGGER set_updated_at
  BEFORE UPDATE ON public.outbound_retry_ledger
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- RLS (mesmo padrão de 047_message_external_ids.sql)
--
-- Apenas leitura via policy — mirror de meid_select, join até
-- conversations.account_id via messages. Nenhuma política de
-- escrita: INSERT/UPDATE serão exclusivamente via função(ões)
-- SECURITY DEFINER, introduzidas junto com o código que as
-- consome (Commits 4 e 6 do plano de implementação de E4b).
-- ------------------------------------------------------------
ALTER TABLE public.outbound_retry_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbound_retry_ledger_select ON public.outbound_retry_ledger
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = outbound_retry_ledger.message_id
        AND (is_account_member(c.account_id) OR can_access_account(c.account_id))
    )
  );
