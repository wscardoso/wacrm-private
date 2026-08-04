-- ============================================================
-- 065_identity_br_functions.sql — canonical_br() e phone_identity()
--
-- GERADO por scripts/generate-ddd-constants.mjs a partir de
-- docs/reference/anatel-ddd.json (versão 1). NÃO editar manualmente.
--
-- Implementam ADR-IDENTITY-BR-001 §5–§9 passo a passo (normalização,
-- resolução de DDI, envelope fechado DDD+assinante, canonicalização do
-- 9º dígito) e §6.6 (identity() = COALESCE). VALID_DDD é array literal
-- embutido no corpo (constante fechada) — NUNCA subquery em
-- identity_br_valid_ddd: isso tornaria a função, no melhor caso, STABLE,
-- violando IDENT §8.2. Regenerar via gerador é o único mecanismo de
-- atualização (HOTFIX-001 A.6).
-- ============================================================

CREATE OR REPLACE FUNCTION canonical_br(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN input IS NULL THEN NULL
    ELSE (
      WITH payload AS (
        SELECT
          CASE
            -- §6.2.1 DDI explícito confirmado: começa com 55 e o
            -- restante casa o envelope -> prossegue com o restante.
            WHEN length(digits) IN (12, 13) AND left(digits, 2) = '55'
            THEN substring(digits, 3)
            -- §6.2.2 DDI inferido por omissão: NÃO começa com 55 e o
            -- próprio digits casa o envelope (nunca sobrescreve um DDI).
            WHEN length(digits) IN (10, 11) AND left(digits, 2) <> '55'
            THEN digits
            -- §6.2.3 qualquer outro caso -> NonBR (nunca adivinhado).
            ELSE NULL
          END AS body,
          digits
        FROM (SELECT regexp_replace(input, '\D', '', 'g') AS digits) d
        WHERE digits <> ''
      ),
      envelope AS (
        SELECT
          (SELECT CASE
          -- Móvel: 11 dígitos, DDD válido, assinante de 9 começando em 9
          -- -> envelope canônico = DDD + assinante (já na forma de §6.4)
          WHEN length(payload.body) = 11
           AND left(payload.body, 2) = ANY (ARRAY['11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '24', '27', '28', '31', '32', '33', '34', '35', '37', '38', '41', '42', '43', '44', '45', '46', '47', '48', '49', '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68', '69', '71', '73', '74', '75', '77', '79', '81', '82', '83', '84', '85', '86', '87', '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99']::text[])
           AND left(substring(payload.body, 3), 1) = '9'
          THEN payload.body
          -- Móvel legado: 10 dígitos, assinante de 8 começando em 6-9
          -- -> prefixa 9 ao assinante, mantendo o DDD (§6.4)
          WHEN length(payload.body) = 10
           AND left(payload.body, 2) = ANY (ARRAY['11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '24', '27', '28', '31', '32', '33', '34', '35', '37', '38', '41', '42', '43', '44', '45', '46', '47', '48', '49', '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68', '69', '71', '73', '74', '75', '77', '79', '81', '82', '83', '84', '85', '86', '87', '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99']::text[])
           AND left(substring(payload.body, 3), 1) IN ('6','7','8','9')
          THEN left(payload.body, 2) || '9' || substring(payload.body, 3)
          -- Fixo: 10 dígitos, assinante de 8 começando em 2-5 -> como está
          WHEN length(payload.body) = 10
           AND left(payload.body, 2) = ANY (ARRAY['11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '24', '27', '28', '31', '32', '33', '34', '35', '37', '38', '41', '42', '43', '44', '45', '46', '47', '48', '49', '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68', '69', '71', '73', '74', '75', '77', '79', '81', '82', '83', '84', '85', '86', '87', '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99']::text[])
           AND left(substring(payload.body, 3), 1) IN ('2','3','4','5')
          THEN payload.body
          ELSE NULL
        END) AS subscriber
        FROM payload
        WHERE payload.body IS NOT NULL
      )
      SELECT
        CASE
          WHEN envelope.subscriber IS NULL THEN NULL
          -- §5: CanonicalKey = '55' + DDD + assinante canônico.
          ELSE '55' || envelope.subscriber
        END
      FROM envelope
    )
  END
$$;

CREATE OR REPLACE FUNCTION phone_identity(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  -- identity() de IDENT §6.6: canonical_br quando não-NULL, senão
  -- regexp_replace (dígitos exatos) — mesmo predicado de phone_normalized.
  SELECT COALESCE(canonical_br(input), regexp_replace(input, '\D', '', 'g'));
$$;
