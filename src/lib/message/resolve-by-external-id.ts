/**
 * EIS-001 §4.1 — resolveMessageByExternalId.
 *
 * Resolve um valor de identidade externa para o UUID interno da mensagem.
 * Consulta `message_external_ids` primeiro e, na ausência total de
 * identidade registrada, recorre ao acervo por `messages.message_id`
 * (EIS-001 §4.3).
 *
 * E2.1-RC1 — B3/B5. Duas propriedades são obrigatórias aqui:
 *
 *   determinismo — a resolução nunca escolhe entre candidatos. Quando o
 *   conjunto de candidatos aponta para mais de uma mensagem, a operação
 *   não resolve. Escolher pela ordem devolvida pelo banco produziria uma
 *   correlação que depende do plano de execução, não do dado.
 *
 *   isolamento — nenhum caminho de resolução alcança mensagem fora do
 *   escopo do `connectionRef` recebido (EIS-001 §8, critério 15).
 */

import { supabaseAdmin } from '@/lib/supabase/admin-client'

const LOG = '[resolveMessageByExternalId]'

/**
 * Resolve uma referência de mensagem de nível provider para `messages.id`.
 *
 * @param connectionRef - `whatsapp_config.id` (regime E2.0) ou `connections.id` (E3).
 * @param value - Identificador de mensagem referenciado pelo evento.
 * @param kind - Filtro de espécie opcional (ex.: 'wamid', 'provider_message_id').
 *               Omitido, percorre todas as espécies da conexão.
 * @returns O `messages.id` interno, ou null quando não há resolução
 *          inequívoca. Um null nunca é silencioso: ou o chamador registra
 *          N1, ou esta função já registrou a ambiguidade.
 */
export async function resolveMessageByExternalId(
  connectionRef: string,
  value: string,
  kind?: string,
): Promise<string | null> {
  // ------------------------------------------------------------------
  // 1) Identidades registradas — caminho primário de EIS-001 §4.1.
  // ------------------------------------------------------------------
  let query = supabaseAdmin()
    .from('message_external_ids')
    .select('message_id')
    .eq('connection_ref', connectionRef)
    .eq('value', value)

  if (kind) {
    query = query.eq('kind', kind)
  }

  const { data: identityRows, error: idError } = await query

  if (idError) {
    // Falha de consulta não é "ausência total" de identidade registrada.
    // Cair para o fallback aqui inverteria a precedência absoluta de
    // EIS-001 §4.3: uma indisponibilidade momentânea passaria a autorizar
    // a semântica antiga a resolver no lugar da nova.
    console.error(`${LOG} identity query error:`, idError.message)
    return null
  }

  const identities = (identityRows ?? []) as { message_id: string }[]

  if (identities.length > 0) {
    // Sem `kind`, a unicidade de §3.4 é por espécie, não por valor: N
    // espécies podem portar o mesmo valor na mesma conexão. N linhas
    // apontando para a MESMA mensagem são uma resolução; apontando para
    // mensagens distintas, não são resolução alguma.
    const distinct = new Set(identities.map((r) => r.message_id))

    if (distinct.size === 1) {
      return identities[0].message_id
    }

    console.warn(
      `${LOG} ambiguous external identity`,
      JSON.stringify({
        connectionRef,
        value,
        kind: kind ?? null,
        candidates: distinct.size,
      }),
    )
    return null
  }

  // ------------------------------------------------------------------
  // 2) Fallback sobre o acervo — EIS-001 §4.3 e sua errata de 2026-07-30.
  //
  //    A restrição literal "à conexão" não é executável: `messages` não
  //    tem vínculo a conexão, apenas a conversa, e a conversa à conta.
  //    Sob UNIQUE(account_id) em whatsapp_config (017) há no máximo uma
  //    conexão por conta, e o escopo por conta é equivalente. A errata
  //    registra que a equivalência é datada e cessa em E3.
  // ------------------------------------------------------------------
  const { data: configRow, error: cfgError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id')
    .eq('id', connectionRef)
    .maybeSingle()

  if (cfgError || !configRow?.account_id) {
    console.warn(
      `${LOG} connection_ref not resolvable to an account:`,
      JSON.stringify({ connectionRef, error: cfgError?.message ?? null }),
    )
    return null
  }

  // O escopo é aplicado pelo banco, num único statement, por junção
  // interna com `conversations`. A variante anterior — carregar todos os
  // ids de conversa da conta e passá-los num `IN` — produzia a mesma
  // restrição por um caminho que cresce sem limite com o tenant.
  const { data: fallbackRows, error: fallbackError } = await supabaseAdmin()
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', value)
    .eq('sender_type', 'agent')
    .eq('conversations.account_id', configRow.account_id)

  if (fallbackError) {
    console.error(`${LOG} fallback query error:`, fallbackError.message)
    return null
  }

  const candidates = (fallbackRows ?? []) as { id: string }[]

  if (candidates.length === 1) {
    return candidates[0].id
  }

  if (candidates.length > 1) {
    // `messages.message_id` não tem unicidade estrutural no caminho de
    // saída (EIS-001 §4.3, superfície de risco declarada). Mais de um
    // candidato é ambiguidade real, não empate a desempatar.
    console.warn(
      `${LOG} ambiguous fallback match`,
      JSON.stringify({ connectionRef, value, candidates: candidates.length }),
    )
    return null
  }

  // 3) Sem correlação — EIS-001 §8, critério 13. O chamador registra N1.
  return null
}

export type ResolveResult = { messageId: string; resolvedBy: 'identity' | 'fallback' }
