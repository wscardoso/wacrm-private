-- ============================================================
-- 081_lead_round_robin_atomic.sql
--
-- Corrige a condição de corrida do round-robin de atribuição de
-- leads introduzido na 080 (tabela `account_lead_routing`).
--
-- Problema (engine.ts, passo `assign_conversation` em modo
-- `round_robin`): o cursor era lido e reescrito em duas idas
-- separadas ao banco —
--
--   SELECT last_assigned_user_id FROM account_lead_routing ...
--   ... calcula o próximo membro ...
--   UPSERT account_lead_routing SET last_assigned_user_id = <próximo>
--
-- Duas execuções concorrentes para a MESMA conta (o caso normal:
-- dois leads entrando quase juntos) leem o mesmo `last_assigned_user_id`
-- e ambas calculam o MESMO próximo agente. O segundo upsert apenas
-- reescreve o valor do primeiro: o cursor avança uma posição só, e
-- dois leads consecutivos caem no mesmo agente — a distribuição
-- deixa de ser equitativa e passa a variar com a concorrência.
--
-- Correção: uma única operação atômica no banco. A função abaixo
-- faz, na MESMA transação:
--   1. monta a lista de membros elegíveis (determinística, user_id ASC);
--   2. garante/locka a linha de cursor com SELECT ... FOR UPDATE
--      (INSERT ... ON CONFLICT DO NOTHING cobre a primeira vez);
--   3. lê o cursor, calcula o próximo e o regrava;
--   4. devolve o agente escolhido.
--
-- O lock de linha serializa chamadas concorrentes da mesma conta:
-- a segunda transação só lê o cursor depois que a primeira comitou,
-- então nunca lê um valor obsoleto. Contas diferentes não se bloqueiam
-- (a linha de cursor é por account_id).
--
-- Mesmo padrão de 007/012 (increment_*_execution_count): onde havia
-- read-modify-write no app, passa a haver RPC atômica SECURITY DEFINER.
-- A precedência de nomes/ordem preserva o comportamento observável
-- anterior (filtro por `account_role`, ordem por `user_id`, "último
-- agente desconhecido → começa no primeiro").
--
-- Escopo: apenas a distribuição (autor-only, service-role). NÃO toca
-- a feature de negócio perdido, `departments`/filas/SLA, nem o
-- dispatcher de `conversation_assigned`.
--
-- Depende de: 080 (tabela account_lead_routing), 017 (profiles.account_role).
-- Idempotente — seguro reexecutar.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assign_next_lead_agent(p_account_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_members UUID[];
  v_len     INT;
  v_last    UUID;
  v_pos     INT;
  v_next    UUID;
BEGIN
  -- Defensivo: account_id é NOT NULL na origem (automations.account_id),
  -- mas uma chamada direta não deve criar linha de cursor "vazia".
  IF p_account_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Membros elegíveis da conta. `account_role` é o enum escopado por
  -- conta (owner/admin/agent, migration 017) — NUNCA a coluna legada
  -- `profiles.role` (TEXT global que default 'user' e não casa ninguém).
  -- A ordem por user_id é o que torna a rotação reproduzível e mantém
  -- o resultado idêntico ao da implementação anterior.
  SELECT array_agg(p.user_id ORDER BY p.user_id)
    INTO v_members
  FROM profiles p
  WHERE p.account_id = p_account_id
    AND p.account_role IN ('owner', 'admin', 'agent');

  v_len := COALESCE(array_length(v_members, 1), 0);

  -- Sem agente elegível: não cria/avança cursor. O chamador trata o
  -- NULL como "no agent resolved" (mesmo texto de antes).
  IF v_len = 0 THEN
    RETURN NULL;
  END IF;

  -- Garante a linha de cursor (atômico) e então a locka. Em READ
  -- COMMITTED, o SELECT ... FOR UPDATE relê a versão mais recente
  -- já comitada depois de obter o lock — por isso a leitura do cursor
  -- abaixo nunca é obsoleta, mesmo com N chamadas simultâneas.
  INSERT INTO account_lead_routing (account_id, last_assigned_user_id)
  VALUES (p_account_id, NULL)
  ON CONFLICT (account_id) DO NOTHING;

  SELECT r.last_assigned_user_id
    INTO v_last
  FROM account_lead_routing r
  WHERE r.account_id = p_account_id
  FOR UPDATE;

  -- array_position é 1-based e NULL quando não encontra (ou quando o
  -- cursor está vazio/NULL). COALESCE(..., 0) normaliza os dois casos.
  -- Reproduz o `findIndex` (→ -1) + `(idx + 1) % len` do JS:
  --   último conhecido na posição i (1-based) → próxima = (i % len) + 1
  --   último desconhecido/ausente             → primeira = 1
  v_pos := COALESCE(array_position(v_members, v_last), 0);

  IF v_pos = 0 THEN
    v_next := v_members[1];
  ELSE
    v_next := v_members[(v_pos % v_len) + 1];
  END IF;

  UPDATE account_lead_routing
     SET last_assigned_user_id = v_next,
         updated_at            = NOW()
   WHERE account_id = p_account_id;

  RETURN v_next;
END;
$$;

-- Somente o service-role chama isto: o motor de automations usa
-- supabaseAdmin() (service-role, fora da RLS). Espelha 007/012 —
-- remove o EXECUTE herdado de PUBLIC/anon/authenticated para que
-- nenhum cliente autenticado possa girar o cursor de distribuição
-- (a 080 já revogou o DML da tabela para `authenticated`).
ALTER FUNCTION public.assign_next_lead_agent(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_next_lead_agent(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_next_lead_agent(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.assign_next_lead_agent(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_next_lead_agent(UUID) TO service_role;

COMMENT ON FUNCTION public.assign_next_lead_agent(UUID) IS
  'Round-robin atômico de atribuição de leads: monta os membros elegíveis (profiles.account_role IN owner/admin/agent, ordem user_id ASC), locka o cursor account_lead_routing da conta com SELECT ... FOR UPDATE, avança uma posição e devolve o user_id escolhido (NULL se não houver agente elegível). Substitui o read-then-upsert não atômico de src/lib/automations/engine.ts (passo assign_conversation, modo round_robin). service-role apenas.';
