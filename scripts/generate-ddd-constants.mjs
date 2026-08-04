#!/usr/bin/env node
// ============================================================
// generate-ddd-constants.mjs — fonte única de VALID_DDD
//
// Consome docs/reference/anatel-ddd.json (ADR-IDENTITY-BR-001,
// Anexo A.1.1 — arquivo-fonte único, versionado) e gera, em uma
// única execução determinística, os TRÊS artefatos derivados:
//
//   (a) supabase/migrations/064_identity_br_ddd_reference.sql
//       — tabela-espelho identity_br_valid_ddd + seed (B.1)
//   (b) supabase/migrations/065_identity_br_functions.sql
//       — canonical_br()/phone_identity() com VALID_DDD como
//         array literal embutido no corpo (B.2, IDENT §8.2)
//   (c) src/lib/whatsapp/phone-identity.ts
//       — constante + funções TypeScript equivalentes
//
// O teste de paridade da Fase G.1 falha o build se qualquer um dos
// três divergir do arquivo-fonte. Regenerar este gerador + os três
// artefatos é o ÚNICO mecanismo de atualização de VALID_DDD
// (HOTFIX-001 A.6) — nunca editar o array manualmente.
//
// Uso: node scripts/generate-ddd-constants.mjs
// ============================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'docs', 'reference', 'anatel-ddd.json')
const source = JSON.parse(readFileSync(sourcePath, 'utf8'))

// ---- validação do arquivo-fonte (Anexo A.1.2/A.1.3) ----
if (!Number.isInteger(source.version) || source.version < 1) {
  throw new Error('anatel-ddd.json: "version" precisa ser um inteiro >= 1')
}
if (!Array.isArray(source.ddds) || source.ddds.length === 0) {
  throw new Error('anatel-ddd.json: "ddds" precisa ser um array não-vazio')
}
if (!source.source_ref || typeof source.source_ref !== 'string') {
  throw new Error('anatel-ddd.json: "source_ref" (origem factual Anatel) é obrigatório [IDENT Anexo A.1.3]')
}

const seen = new Set()
for (const entry of source.ddds) {
  if (!/^\d{2}$/.test(entry.ddd)) {
    throw new Error(`anatel-ddd.json: ddd inválido "${entry.ddd}" (esperado 2 dígitos)`)
  }
  if (!/^[A-Z]{2}$/.test(entry.uf)) {
    throw new Error(`anatel-ddd.json: uf inválida "${entry.uf}" (esperado 2 letras maiúsculas)`)
  }
  if (seen.has(entry.ddd)) {
    throw new Error(`anatel-ddd.json: ddd duplicado "${entry.ddd}"`)
  }
  seen.add(entry.ddd)
}

// Ordena deterministicamente (ordem numérica crescente) para que a
// geração seja estável independentemente da ordem no JSON.
const ddds = [...source.ddds].sort((a, b) => Number(a.ddd) - Number(b.ddd))
const codes = ddds.map((d) => d.ddd)
const version = source.version
const sourceRef = source.source_ref

// ---- artefato (a): migration 064 (espelho/auditoria) ----
const sqlArray = `ARRAY[${codes.map((c) => `'${c}'`).join(', ')}]::text[]`

const migration064 = `-- ============================================================
-- 064_identity_br_ddd_reference.sql — espelho de auditoria de VALID_DDD
--
-- GERADO por scripts/generate-ddd-constants.mjs a partir de
-- docs/reference/anatel-ddd.json (versão ${version}). NÃO editar manualmente.
-- Para atualizar: mudar o arquivo-fonte (Anexo A.1.4 incrementa "version")
-- e rodar o gerador (HOTFIX-001 A.6). O gerador também regrava 065 e
-- phone-identity.ts na mesma execução.
--
-- PAPEL: espelho para leitura humana/operacional (dashboards, auditoria)
-- e registro versionado usado pelo gerador. NUNCA é consultada por
-- canonical_br()/phone_identity() em runtime — a função IMMUTABLE usa o
-- array literal embutido no corpo de 065 (IDENT §8.2, HOTFIX-001 B.1).
-- ============================================================

CREATE TABLE IF NOT EXISTS identity_br_valid_ddd (
  ddd        CHAR(2) PRIMARY KEY,
  uf         CHAR(2) NOT NULL,
  source_ref TEXT NOT NULL,
  version    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_br_valid_ddd_version
  ON identity_br_valid_ddd (version);

INSERT INTO identity_br_valid_ddd (ddd, uf, source_ref, version) VALUES
${ddds.map((d) => `  ('${d.ddd}', '${d.uf}', '${sourceRef.replace(/'/g, "''")}', ${version})`).join(',\n')}
ON CONFLICT (ddd) DO NOTHING;
`

// ---- artefato (b): migration 065 (funções IMMUTABLE) ----
// envelopeSql retorna o envelope canônico "DDD + assinante" (§6.3 + §6.4).
// O formato final da CanonicalKey é '55' + DDD + assinante (IDENT §5) —
// o DDD NUNCA pode ser descartado, senão DDDs distintos com o mesmo
// assinante colidiriam (§7.1) e a idempotência de §8.1 quebraria.
const envelopeSql = `
        SELECT CASE
          -- Móvel: 11 dígitos, DDD válido, assinante de 9 começando em 9
          -- -> envelope canônico = DDD + assinante (já na forma de §6.4)
          WHEN length(payload.body) = 11
           AND left(payload.body, 2) = ANY (${sqlArray})
           AND left(substring(payload.body, 3), 1) = '9'
          THEN payload.body
          -- Móvel legado: 10 dígitos, assinante de 8 começando em 6-9
          -- -> prefixa 9 ao assinante, mantendo o DDD (§6.4)
          WHEN length(payload.body) = 10
           AND left(payload.body, 2) = ANY (${sqlArray})
           AND left(substring(payload.body, 3), 1) IN ('6','7','8','9')
          THEN left(payload.body, 2) || '9' || substring(payload.body, 3)
          -- Fixo: 10 dígitos, assinante de 8 começando em 2-5 -> como está
          WHEN length(payload.body) = 10
           AND left(payload.body, 2) = ANY (${sqlArray})
           AND left(substring(payload.body, 3), 1) IN ('2','3','4','5')
          THEN payload.body
          ELSE NULL
        END`

const migration065 = `-- ============================================================
-- 065_identity_br_functions.sql — canonical_br() e phone_identity()
--
-- GERADO por scripts/generate-ddd-constants.mjs a partir de
-- docs/reference/anatel-ddd.json (versão ${version}). NÃO editar manualmente.
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
        FROM (SELECT regexp_replace(input, '\\D', '', 'g') AS digits) d
        WHERE digits <> ''
      ),
      envelope AS (
        SELECT
          (${envelopeSql.trim()}) AS subscriber
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
  SELECT COALESCE(canonical_br(input), regexp_replace(input, '\\D', '', 'g'));
$$;
`

// ---- artefato (c): constante + funções TypeScript ----
const tsArray = codes.map((c) => `'${c}'`).join(', ')

const phoneIdentityTs = `// ============================================================
// phone-identity.ts — identidade canônica de telefone (BR)
//
// GERADO por scripts/generate-ddd-constants.mjs a partir de
// docs/reference/anatel-ddd.json (versão ${version}). NÃO editar manualmente.
//
// Espelha canonical_br()/phone_identity() de 065_identity_br_functions.sql
// (ADR-IDENTITY-BR-001 §5–§9 e §6.6). O teste de paridade da Fase G.1
// compara este módulo contra as funções SQL byte a byte; divergência é
// falha de build. Atualizar apenas via gerador (HOTFIX-001 A.6).
// ============================================================

export const VALID_DDD_VERSION = ${version}

/** Conjunto fechado de Códigos Nacionais (DDD) — IDENT Anexo A. */
export const VALID_DDD: ReadonlySet<string> = new Set([${tsArray}])

/** CanonicalKey é a string '55' + DDD + assinante canônico — IDENT §5. */
export type CanonicalKey = string

/** NonBR (não-canônico) é representado como null — IDENT §5/§9. */
export function canonicalBr(input: string | null | undefined): CanonicalKey | null {
  if (!input) return null
  const digits = input.replace(/\\D/g, '')
  if (!digits) return null

  let body: string | null = null
  // §6.2.1 DDI explícito confirmado: começa com 55 e o restante casa o envelope.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    body = digits.slice(2)
  }
  // §6.2.2 DDI inferido por omissão: não começa com 55 e o próprio digits casa o envelope.
  else if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    body = digits
  }
  // §6.2.3 qualquer outro caso -> NonBR.
  if (!body) return null

  const subscriber = envelope(body)
  return subscriber ? '55' + subscriber : null
}

/** identity() global — IDENT §6.6: canonicalBr quando não-NULL, senão dígitos exatos. */
export function phoneIdentity(input: string | null | undefined): string {
  return canonicalBr(input) ?? (input ?? '').replace(/\\D/g, '')
}

/** Envelope fechado DDD+assinante de §6.3 + canonicalização do 9º dígito (§6.4). */
function envelope(body: string): string | null {
  if (body.length === 11) {
    const ddd = body.slice(0, 2)
    const subscriber = body.slice(2)
    // Móvel: DDD válido + assinante de 9 começando em 9 -> envelope canônico.
    if (VALID_DDD.has(ddd) && subscriber.startsWith('9')) return body
    return null
  }
  if (body.length === 10) {
    const ddd = body.slice(0, 2)
    const subscriber = body.slice(2)
    if (!VALID_DDD.has(ddd) || subscriber.length !== 8) return null
    const first = subscriber[0]
    // Móvel legado: prefixa 9 ao assinante, mantendo o DDD (§6.4).
    if (first >= '6' && first <= '9') return ddd + '9' + subscriber
    // Fixo: como está, nunca ganha 9º dígito.
    if (first >= '2' && first <= '5') return body
    return null
  }
  return null
}
`

// ---- escrita (mesma execução, três artefatos) ----
writeFileSync(join(root, 'supabase', 'migrations', '064_identity_br_ddd_reference.sql'), migration064, 'utf8')
writeFileSync(join(root, 'supabase', 'migrations', '065_identity_br_functions.sql'), migration065, 'utf8')
writeFileSync(join(root, 'src', 'lib', 'whatsapp', 'phone-identity.ts'), phoneIdentityTs, 'utf8')

console.log(
  `generate-ddd-constants: OK — versão ${version}, ${ddds.length} DDDs, ` +
    `três artefatos regravados (064, 065, phone-identity.ts).`,
)
