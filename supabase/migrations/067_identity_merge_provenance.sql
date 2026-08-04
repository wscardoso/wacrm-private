-- ============================================================
-- 067_identity_merge_provenance.sql — proveniência do merge
--
-- HOTFIX-001 B.4; ADR-CONTACT-MERGE-001 §3.3. Registro durável do que
-- foi fundido: sobrevivente, perdedores (id + phone cru), a identidade
-- que agrupou o conjunto e o instante. Contém o mínimo fixado pelo ADR;
-- formato é decisão do HOTFIX.
--
-- survivor_contact_id NÃO é FK de propósito: se um sobrevivente for
-- removido por fluxo alheio no futuro, a proveniência não pode
-- desaparecer com ele (seria perda de auditoria). O critério de aceite
-- A6 (MERGE §11) é verificado diretamente sobre esta tabela.
-- ============================================================

CREATE TABLE IF NOT EXISTS identity_merge_provenance (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  survivor_contact_id UUID NOT NULL,
  loser_contact_id    UUID NOT NULL,
  loser_phone_raw     TEXT NOT NULL,
  phone_identity      TEXT NOT NULL,
  merged_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  merge_run_id        UUID NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_merge_prov_survivor
  ON identity_merge_provenance (survivor_contact_id);
CREATE INDEX IF NOT EXISTS idx_identity_merge_prov_run
  ON identity_merge_provenance (merge_run_id);
CREATE INDEX IF NOT EXISTS idx_identity_merge_prov_account
  ON identity_merge_provenance (account_id, merged_at DESC);
