// ============================================================
// phone-identity.ts — identidade canônica de telefone (BR)
//
// GERADO por scripts/generate-ddd-constants.mjs a partir de
// docs/reference/anatel-ddd.json (versão 1). NÃO editar manualmente.
//
// Espelha canonical_br()/phone_identity() de 065_identity_br_functions.sql
// (ADR-IDENTITY-BR-001 §5–§9 e §6.6). O teste de paridade da Fase G.1
// compara este módulo contra as funções SQL byte a byte; divergência é
// falha de build. Atualizar apenas via gerador (HOTFIX-001 A.6).
// ============================================================

export const VALID_DDD_VERSION = 1

/** Conjunto fechado de Códigos Nacionais (DDD) — IDENT Anexo A. */
export const VALID_DDD: ReadonlySet<string> = new Set(['11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '24', '27', '28', '31', '32', '33', '34', '35', '37', '38', '41', '42', '43', '44', '45', '46', '47', '48', '49', '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68', '69', '71', '73', '74', '75', '77', '79', '81', '82', '83', '84', '85', '86', '87', '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99'])

/** CanonicalKey é a string '55' + DDD + assinante canônico — IDENT §5. */
export type CanonicalKey = string

/** NonBR (não-canônico) é representado como null — IDENT §5/§9. */
export function canonicalBr(input: string | null | undefined): CanonicalKey | null {
  if (!input) return null
  const digits = input.replace(/\D/g, '')
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
  return canonicalBr(input) ?? (input ?? '').replace(/\D/g, '')
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
