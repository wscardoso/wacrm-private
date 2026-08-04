-- ============================================================
-- 063_messages_status_canonical.sql — E2.1 Fase 1
--
-- ADR-MSG-STATUS-001 D2 + CHECKPOINT-E2.1-STATUS-CANONICAL §8, pré-condição 3:
--   "Migration aditiva de messages.status para admitir `pending` e
--    `received`. Aditiva, reexecutável, sem remoção nem renomeação."
--
-- Contexto: 001_initial_schema.sql:173 fixou o CHECK em cinco valores
--   ('sending','sent','delivered','read','failed')
-- que são o vocabulário da Meta adotado por coincidência, não o conjunto
-- canônico do domínio. ADR-MSG-001 D7 ampliou o conjunto para admitir
-- `pending` e `received`; ADR-MSG-STATUS-001 D2 o fixa em exatamente sete
-- estados.
--
-- Natureza da alteração:
--   ADITIVA  — os cinco valores existentes permanecem válidos, com a mesma
--              semântica. Nenhuma linha existente se torna inválida.
--   SEM RENOMEAÇÃO — nenhum valor é substituído.
--   SEM BACKFILL   — o acervo de mensagens de entrada gravado como
--                    'delivered' NÃO é convertido para 'received'. Essa
--                    decisão é D4 do §15 do MASTER-ROADMAP e permanece
--                    aberta (ADR-MSG-001 §7). Enquanto isso, direção é
--                    derivada de sender_type (invariante D), nunca do
--                    estado.
--   REEXECUTÁVEL   — DROP ... IF EXISTS antes do ADD.
--
-- Reversibilidade: restaurar o CHECK de cinco valores só é seguro enquanto
-- nenhuma linha tiver sido gravada com 'pending' ou 'received'.
-- ============================================================

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_status_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_status_check
  CHECK (status IN (
    -- eixo de progresso (saída), em ordem de nível
    'pending',
    'sending',
    'sent',
    'delivered',
    'read',
    -- terminal de exceção (saída), fora do eixo
    'failed',
    -- entrada: ciclo de vida degenerado, sem transições (D6/T6)
    'received'
  ));

COMMENT ON COLUMN messages.status IS
  'ADR-MSG-STATUS-001 D2 — conjunto canônico de sete estados. Eixo de progresso: pending<sending<sent<delivered<read. Exceção terminal: failed. Entrada: received (sem transições). `replied` NÃO pertence aqui (D3) — é de broadcast_recipients.';
