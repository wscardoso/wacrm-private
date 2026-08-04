-- ============================================================
-- 066_contacts_phone_identity_column.sql — coluna e índice de identidade
--
-- HOTFIX-001 B.3. Materializa identity(phone) como coluna gerada STORED
-- (ADR-IDENTITY-BR-001 §6.6) e um índice NÃO-único sobre
-- (account_id, phone_identity). O índice só se torna UNIQUE depois que o
-- backfill da conta chega a zero grupos ativos (HOTFIX-001 F.5) — um
-- índice único aqui quebraria a criação da coluna em qualquer conta com
-- duplicatas de identidade pré-existentes.
--
-- phone_normalized (022) NÃO é removida: continua sendo a base do
-- ramo NonBR/K_EXACT de identity() e do índice trigram de 029.
--
-- Estratégia de reescrita de ADD COLUMN ... GENERATED STORED (B.3,
-- ALTO-2): medir o tamanho de contacts ANTES de migrar (fora da
-- migration), e a própria migration usa SET lock_timeout para falhar
-- rápido em vez de enfileirar bloqueio silencioso atrás de outra
-- transação. Tabela grande (>500k) deve ser destacada da lista de
-- deploy contínuo e executada em janela de manutenção (ver B.3).
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS phone_identity TEXT
  GENERATED ALWAYS AS (phone_identity(phone)) STORED;

CREATE INDEX IF NOT EXISTS idx_contacts_phone_identity
  ON contacts (account_id, phone_identity)
  WHERE phone_identity <> '';
