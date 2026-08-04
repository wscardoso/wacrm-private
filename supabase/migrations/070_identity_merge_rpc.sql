-- ============================================================
-- 070_identity_merge_rpc.sql — merge_identity_group() e helpers
--
-- HOTFIX-001 Fase C (C.1–C.4) e Fase D (D.1). Executa, em UMA
-- transação única ([MERGE §9.2]), o merge de um grupo de contatos
-- identificado por (account_id, phone_identity) ([MERGE §2.5]).
--
-- Entrada: (account_id, phone_identity). A RPC recarrega o grupo sob
-- o advisory lock ([MERGE §2.5], C.2 — nunca recebe lista de id).
-- Saída: JSONB de resumo operacional (C.2), usado por Fase E/F.
-- No-op seguro: grupo com <= 1 membro retorna loser_contact_ids: [].
--
-- Estrutura (C.1): uma única RPC pública, merge_identity_group(),
-- chamando 5 helpers SECURITY DEFINER sem GRANT para nenhuma role de
-- aplicação. As remoções de C_L (passo 9) e de L (passo 14) são
-- emitidas DIRETAMENTE por merge_identity_group(), nunca por helper
-- (C.3, CRÍTICO-2).
--
-- Notas de implementação físicas (todas dentro da transação única;
-- nenhuma altera a semântica congelada, apenas respeita constraints):
--
--   • Colapso de mensagens (§5) intercalado com o re-apontamento de
--     messages.conversation_id (8a): o índice único parcial
--     idx_messages_conv_msgid_customer (034) torna impossível mover
--     em lote duas mensagens inbound colidentes para c_s — a própria
--     premissa de 034 que o ADR revoga em §5.5. A reconciliação de
--     §5,2/§5.5 (colapso por message_id + reações + reply_to + M14)
--     ocorre então ANTES do movimento em lote, dentro de
--     _merge_group_conversations(), satisfazendo §4.5 (dependentes de
--     C_L re-apontados antes da remoção) e a nota de D.1 de que §4.5
--     não exige colapso pós-remoção de C_L — o estado final é o mesmo
--     que o passo 10 de D.1 produziria, apenas sem jamais expor duas
--     linhas colidentes à constraint (§9.2).
--
--   • flow_runs ativos não-sobreviventes (§7.2) são transicionados
--     para 'superseded_by_identity_merge' ANTES do re-apontamento de
--     contact_id: o índice único parcial idx_one_active_run_per_contact
--     (017) proíbe duas linhas ativas por (account_id, contact_id).
--     Estado final idêntico ao exigido: exatamente um ativo, todos com
--     contact_id = sobrevivente, não-sobreviventes em estado terminal
--     distinguível com ended_at/end_reason.
--
--   • conversations.contact_id é re-apontado para o sobrevivente
--     SOMENTE após a remoção de C_L (passo 9): UNIQUE(account_id,
--     contact_id) (029) não admite duas conversas do mesmo contato.
--
--   • deals.conversation_id referencia conversations(id) com NO ACTION
--     (001) e NÃO consta da lista fechada de §4.5. Se uma negociação
--     apontar para uma conversa perdedora, o DELETE do passo 9 falha
--     alto (23503) e o grupo vira poison group para triagem manual
--     (E.4) — comportamento fail-safe, não perda silenciosa.
-- ============================================================

-- ------------------------------------------------------------
-- _merge_group_messages — [MERGE §5 completo]
--   Colapso por message_id entre as mensagens customer de c_s e C_L;
--   reações por ator (ORDEM_REACTION, §5.4); re-aponta
--   reply_to_message_id e flow_runs.last_prompt_message_id (M14, §5.3);
--   move o keeper do grupo para c_s; remove as não-guardiãs (única
--   das cinco funções que remove dado — §5.3 exige consolidação
--   imediata antes de cada remoção). Não toca conversations.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _merge_group_messages(
  p_conversation_survivor UUID,
  p_conversation_ids UUID[],
  OUT p_messages_collapsed INTEGER,
  OUT p_reactions_collapsed INTEGER
)
RETURNS record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
BEGIN
  p_messages_collapsed := 0;
  p_reactions_collapsed := 0;

  -- Todos os inbound com message_id presente nas conversas do grupo,
  -- com o keeper por message_id (ORDEM_H) e o tamanho do grupo.
  CREATE TEMP TABLE _merge_msg_grp ON COMMIT DROP AS
    SELECT id,
           message_id,
           conversation_id,
           first_value(id) OVER (
             PARTITION BY message_id
             ORDER BY created_at ASC, id::text ASC
           ) AS keeper_id,
           count(*) OVER (PARTITION BY message_id) AS members
      FROM messages
     WHERE conversation_id = ANY(p_conversation_ids)
       AND sender_type = 'customer'
       AND message_id IS NOT NULL
       AND message_id <> '';

  -- Move o keeper de cada grupo colidente para c_s (colisão impossível:
  -- um único keeper por message_id).
  UPDATE messages m
     SET conversation_id = p_conversation_survivor
    FROM (SELECT DISTINCT keeper_id FROM _merge_msg_grp WHERE members > 1) k
   WHERE m.id = k.keeper_id
     AND m.conversation_id <> p_conversation_survivor;

  -- Reações: vencedora por (keeper, actor_type, actor_id) sob
  -- ORDEM_REACTION = (está_no_guardião DESC, created_at ASC, id ASC);
  -- re-aponta a vencedora para o keeper, remove as perdedoras.
  WITH grp_reactions AS (
    SELECT r.id AS reaction_id,
           g.keeper_id,
           first_value(r.id) OVER (
             PARTITION BY g.keeper_id, r.actor_type, r.actor_id
             ORDER BY
               CASE WHEN r.message_id = g.keeper_id THEN 0 ELSE 1 END,
               r.created_at ASC,
               r.id::text ASC
           ) AS winning_reaction_id
      FROM message_reactions r
      JOIN _merge_msg_grp g ON g.id = r.message_id
     WHERE g.members > 1
  ),
  winners AS (
    SELECT DISTINCT winning_reaction_id, keeper_id FROM grp_reactions
  )
  UPDATE message_reactions r
     SET message_id = w.keeper_id
    FROM winners w
   WHERE r.id = w.winning_reaction_id
     AND r.message_id <> w.keeper_id;

  WITH grp_reactions AS (
    SELECT r.id AS reaction_id,
           g.keeper_id,
           first_value(r.id) OVER (
             PARTITION BY g.keeper_id, r.actor_type, r.actor_id
             ORDER BY
               CASE WHEN r.message_id = g.keeper_id THEN 0 ELSE 1 END,
               r.created_at ASC,
               r.id::text ASC
           ) AS winning_reaction_id
      FROM message_reactions r
      JOIN _merge_msg_grp g ON g.id = r.message_id
     WHERE g.members > 1
  )
  DELETE FROM message_reactions r
    USING (
      SELECT DISTINCT reaction_id
        FROM grp_reactions
       WHERE reaction_id <> winning_reaction_id
    ) d
   WHERE r.id = d.reaction_id;
  GET DIAGNOSTICS p_reactions_collapsed = ROW_COUNT;

  -- Respostas que apontavam para uma mensagem colapsada passam a
  -- apontar para o keeper (§5.3 — FK ON DELETE SET NULL).
  UPDATE messages m
     SET reply_to_message_id = g.keeper_id
    FROM _merge_msg_grp g
   WHERE m.reply_to_message_id = g.id
     AND g.members > 1;

  -- M14 (§5.3): flow_runs.last_prompt_message_id — mesmo re-apontamento
  -- que dedupe_inbound_messages() (034) nunca fez.
  UPDATE flow_runs fr
     SET last_prompt_message_id = g.keeper_id
    FROM _merge_msg_grp g
   WHERE fr.last_prompt_message_id = g.id
     AND g.members > 1;

  -- Remove as linhas não-guardiãs (duplicatas técnicas, §8.3).
  DELETE FROM messages m
    USING _merge_msg_grp g
   WHERE m.id = g.id
     AND g.members > 1
     AND g.id <> g.keeper_id;
  GET DIAGNOSTICS p_messages_collapsed = ROW_COUNT;

  DROP TABLE _merge_msg_grp;
END $$;

REVOKE ALL ON FUNCTION _merge_group_messages(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION _merge_group_messages(UUID, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION _merge_group_messages(UUID, UUID[]) FROM authenticated;

-- ------------------------------------------------------------
-- _merge_group_conversations — [MERGE §4.1–§4.5]
--   Elege c_s e C_L por ORDEM_H (§4.2); move mensagens para c_s e
--   colapsa (§5 via _merge_group_messages); consolida os dependentes
--   de C_L ANTES de qualquer remoção (8a–8d: messages, message_reactions
--   [M13], lead_attributions.conversation_id [M12], flow_runs.conversation_id);
--   reconcilia os campos de c_s (§4.3/§4.4). NÃO remove conversas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _merge_group_conversations(
  p_account_id UUID,
  p_survivor_contact_id UUID,
  p_loser_contact_ids UUID[],
  OUT p_conversation_survivor UUID,
  OUT p_conversation_loser_ids UUID[],
  OUT p_messages_collapsed INTEGER,
  OUT p_reactions_collapsed INTEGER,
  OUT p_attributions_conversation_repointed INTEGER
)
RETURNS record
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv_ids UUID[];
  v_rec RECORD;
BEGIN
  p_conversation_survivor := NULL;
  p_conversation_loser_ids := NULL;
  p_messages_collapsed := 0;
  p_reactions_collapsed := 0;
  p_attributions_conversation_repointed := 0;

  SELECT array_agg(sub.id ORDER BY sub.created_at ASC, sub.id::text ASC)
    INTO v_conv_ids
    FROM (
      SELECT c.id, c.created_at
        FROM conversations c
       WHERE c.account_id = p_account_id
         AND c.contact_id = ANY(p_survivor_contact_id || p_loser_contact_ids)
       ORDER BY c.created_at ASC, c.id::text ASC
       FOR UPDATE
    ) sub;

  IF v_conv_ids IS NULL OR cardinality(v_conv_ids) = 0 THEN
    RETURN;
  END IF;

  p_conversation_survivor := v_conv_ids[1];
  IF cardinality(v_conv_ids) > 1 THEN
    p_conversation_loser_ids := v_conv_ids[2:cardinality(v_conv_ids)];
  END IF;

  -- 8a/10: move + colapso de mensagens (ver nota física no cabeçalho).
  SELECT * INTO v_rec
    FROM _merge_group_messages(p_conversation_survivor, v_conv_ids);
  p_messages_collapsed := v_rec.p_messages_collapsed;
  p_reactions_collapsed := v_rec.p_reactions_collapsed;

  -- Move TODAS as mensagens remanescentes de C_L para c_s. Após o
  -- colapso isto é livre de colisão: nenhum (c_s, message_id) colidente
  -- sobrevive em C_L.
  UPDATE messages m
     SET conversation_id = p_conversation_survivor
   WHERE m.conversation_id = ANY(p_conversation_loser_ids);

  -- 8b: message_reactions.conversation_id -> c_s (M13, §4.5.2).
  UPDATE message_reactions
     SET conversation_id = p_conversation_survivor
   WHERE conversation_id = ANY(p_conversation_loser_ids);

  -- 8c: lead_attributions.conversation_id -> c_s (M12, §4.5.3 —
  --      FK é ON DELETE CASCADE; omitir destrói a linha inteira).
  UPDATE lead_attributions
     SET conversation_id = p_conversation_survivor
   WHERE conversation_id = ANY(p_conversation_loser_ids);
  GET DIAGNOSTICS p_attributions_conversation_repointed = ROW_COUNT;

  -- 8d: flow_runs.conversation_id -> c_s (§4.5.4 — FK ON DELETE SET NULL).
  UPDATE flow_runs
     SET conversation_id = p_conversation_survivor
   WHERE conversation_id = ANY(p_conversation_loser_ids);

  -- §4.3/§4.4: reconciliação dos campos de c_s, com last_message_* e
  -- unread_count DERIVADOS após o colapso (N_inbound pós-§5).
  UPDATE conversations c
     SET status = CASE
           WHEN EXISTS (SELECT 1 FROM conversations x
                         WHERE x.id = ANY(v_conv_ids) AND x.status = 'open')
             THEN 'open'
           WHEN EXISTS (SELECT 1 FROM conversations x
                         WHERE x.id = ANY(v_conv_ids) AND x.status = 'pending')
             THEN 'pending'
           ELSE 'closed'
         END,
         assigned_agent_id = COALESCE(
           c.assigned_agent_id,
           (SELECT x.assigned_agent_id FROM conversations x
             WHERE x.id = ANY(v_conv_ids)
               AND x.assigned_agent_id IS NOT NULL
             ORDER BY x.created_at ASC, x.id::text ASC
             LIMIT 1)
         ),
         attribution_id = COALESCE(
           c.attribution_id,
           (SELECT x.attribution_id FROM conversations x
             WHERE x.id = ANY(v_conv_ids)
               AND x.attribution_id IS NOT NULL
             ORDER BY x.created_at ASC, x.id::text ASC
             LIMIT 1)
         ),
         last_message_at = COALESCE(
           (SELECT max(m.created_at) FROM messages m
             WHERE m.conversation_id = p_conversation_survivor),
           (SELECT max(x.last_message_at) FROM conversations x
             WHERE x.id = ANY(v_conv_ids))
         ),
         last_message_text = COALESCE(
           (SELECT m.content_text FROM messages m
             WHERE m.conversation_id = p_conversation_survivor
             ORDER BY m.created_at DESC, m.id::text DESC
             LIMIT 1),
           c.last_message_text
         ),
         unread_count = LEAST(
           (SELECT COALESCE(sum(x.unread_count), 0) FROM conversations x
             WHERE x.id = ANY(v_conv_ids)),
           (SELECT count(*) FROM messages m
             WHERE m.conversation_id = p_conversation_survivor
               AND m.sender_type = 'customer')
         )
   WHERE c.id = p_conversation_survivor;
END $$;

REVOKE ALL ON FUNCTION _merge_group_conversations(UUID, UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION _merge_group_conversations(UUID, UUID, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION _merge_group_conversations(UUID, UUID, UUID[]) FROM authenticated;

-- ------------------------------------------------------------
-- _merge_group_contacts — [MERGE §3.1–§3.5]
--   fill-gap dos campos escalares (§3.1); proveniência obrigatória
--   (§3.3); re-apontamento integral de contact_notes/deals/
--   broadcast_recipients (13a — as três tabelas de §3.4 que nenhum
--   outro helper alcança); colapso de contact_tags/contact_custom_values
--   por unicidade (§3.5, 13b). NÃO remove contatos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _merge_group_contacts(
  p_account_id UUID,
  p_phone_identity TEXT,
  p_survivor_contact_id UUID,
  p_loser_contact_ids UUID[],
  p_merge_run_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- §3.1: o valor do sobrevivente prevalece quando presente; ausente
  -- (NULL/''/somente espaços) recebe o do primeiro perdedor sob ORDEM_H
  -- com valor presente.
  UPDATE contacts c
     SET name       = COALESCE(NULLIF(btrim(c.name), ''),       NULLIF(btrim(l.name), '')),
         email      = COALESCE(NULLIF(btrim(c.email), ''),      NULLIF(btrim(l.email), '')),
         company    = COALESCE(NULLIF(btrim(c.company), ''),    NULLIF(btrim(l.company), '')),
         avatar_url = COALESCE(NULLIF(btrim(c.avatar_url), ''), NULLIF(btrim(l.avatar_url), ''))
    FROM (
      SELECT
        (SELECT x.name FROM contacts x
          WHERE x.id = ANY(p_loser_contact_ids)
            AND x.name IS NOT NULL AND btrim(x.name) <> ''
          ORDER BY x.created_at ASC, x.id::text ASC LIMIT 1) AS name,
        (SELECT x.email FROM contacts x
          WHERE x.id = ANY(p_loser_contact_ids)
            AND x.email IS NOT NULL AND btrim(x.email) <> ''
          ORDER BY x.created_at ASC, x.id::text ASC LIMIT 1) AS email,
        (SELECT x.company FROM contacts x
          WHERE x.id = ANY(p_loser_contact_ids)
            AND x.company IS NOT NULL AND btrim(x.company) <> ''
          ORDER BY x.created_at ASC, x.id::text ASC LIMIT 1) AS company,
        (SELECT x.avatar_url FROM contacts x
          WHERE x.id = ANY(p_loser_contact_ids)
            AND x.avatar_url IS NOT NULL AND btrim(x.avatar_url) <> ''
          ORDER BY x.created_at ASC, x.id::text ASC LIMIT 1) AS avatar_url
    ) l
   WHERE c.id = p_survivor_contact_id;

  -- §3.3: proveniência obrigatória — o phone cru de cada perdedor é
  -- informação e não pode desaparecer (A6, §11).
  INSERT INTO identity_merge_provenance
    (account_id, survivor_contact_id, loser_contact_id, loser_phone_raw, phone_identity, merge_run_id)
  SELECT p_account_id, p_survivor_contact_id, c.id, c.phone, p_phone_identity, p_merge_run_id
    FROM contacts c
   WHERE c.id = ANY(p_loser_contact_ids);

  -- §3.4 (13a): re-apontamento integral, sem colisão possível.
  -- broadcast_recipients.contact_id é NOT NULL sem anulação em cascata
  -- (001) — omitir este passo faz o DELETE do passo 14 falhar por
  -- integridade referencial.
  UPDATE contact_notes        SET contact_id = p_survivor_contact_id WHERE contact_id = ANY(p_loser_contact_ids);
  UPDATE deals                SET contact_id = p_survivor_contact_id WHERE contact_id = ANY(p_loser_contact_ids);
  UPDATE broadcast_recipients SET contact_id = p_survivor_contact_id WHERE contact_id = ANY(p_loser_contact_ids);

  -- §3.5 (13b): contact_tags — UNIQUE(contact_id, tag_id). União por
  -- tag: tags já no sobrevivente são colapsadas; as demais ganham uma
  -- única linha (a do primeiro perdedor sob ORDEM_H); excedentes colapsados.
  DELETE FROM contact_tags ct
   WHERE ct.contact_id = ANY(p_loser_contact_ids)
     AND EXISTS (SELECT 1 FROM contact_tags s
                  WHERE s.contact_id = p_survivor_contact_id AND s.tag_id = ct.tag_id);

  UPDATE contact_tags ct
     SET contact_id = p_survivor_contact_id
   WHERE ct.contact_id = ANY(p_loser_contact_ids)
     AND ct.id = (
       SELECT fc.id FROM contact_tags fc
        WHERE fc.tag_id = ct.tag_id
          AND fc.contact_id = ANY(p_loser_contact_ids)
        ORDER BY fc.created_at ASC, fc.id::text ASC
        LIMIT 1
     );

  DELETE FROM contact_tags WHERE contact_id = ANY(p_loser_contact_ids);

  -- §3.5 (13b): contact_custom_values — UNIQUE(contact_id, custom_field_id).
  -- União por campo, valor por fill-gap (§3.1 aplicada por campo).
  -- (a) campos em que o sobrevivente tem valor presente: perdedores colapsam.
  DELETE FROM contact_custom_values cv
   WHERE cv.contact_id = ANY(p_loser_contact_ids)
     AND EXISTS (SELECT 1 FROM contact_custom_values s
                  WHERE s.contact_id = p_survivor_contact_id
                    AND s.custom_field_id = cv.custom_field_id
                    AND s.value IS NOT NULL AND btrim(s.value) <> '');

  -- (b) campos em que o sobrevivente só tem valor ausente e algum
  -- perdedor tem valor presente: libera a linha do sobrevivente.
  DELETE FROM contact_custom_values cv
   WHERE cv.contact_id = p_survivor_contact_id
     AND (cv.value IS NULL OR btrim(cv.value) = '')
     AND EXISTS (SELECT 1 FROM contact_custom_values l
                  WHERE l.custom_field_id = cv.custom_field_id
                    AND l.contact_id = ANY(p_loser_contact_ids)
                    AND l.value IS NOT NULL AND btrim(l.value) <> '');

  -- (c) re-aponta a linha do primeiro perdedor com valor presente.
  UPDATE contact_custom_values cv
     SET contact_id = p_survivor_contact_id
   WHERE cv.contact_id = ANY(p_loser_contact_ids)
     AND NOT EXISTS (SELECT 1 FROM contact_custom_values s
                      WHERE s.contact_id = p_survivor_contact_id
                        AND s.custom_field_id = cv.custom_field_id)
     AND cv.id = (
       SELECT fc.id FROM contact_custom_values fc
        WHERE fc.custom_field_id = cv.custom_field_id
          AND fc.contact_id = ANY(p_loser_contact_ids)
          AND fc.value IS NOT NULL AND btrim(fc.value) <> ''
        ORDER BY fc.created_at ASC, fc.id::text ASC
        LIMIT 1
     );

  -- (d) excedentes colapsados.
  DELETE FROM contact_custom_values WHERE contact_id = ANY(p_loser_contact_ids);
END $$;

REVOKE ALL ON FUNCTION _merge_group_contacts(UUID, TEXT, UUID, UUID[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION _merge_group_contacts(UUID, TEXT, UUID, UUID[], UUID) FROM anon;
REVOKE ALL ON FUNCTION _merge_group_contacts(UUID, TEXT, UUID, UUID[], UUID) FROM authenticated;

-- ------------------------------------------------------------
-- _merge_group_attributions — [MERGE §6]
--   §6.1/§6.2: re-aponta lead_attributions.contact_id para o
--   sobrevivente ANTES de qualquer remoção de contacts (§6.2 — FK
--   ON DELETE SET NULL). §6.3: first_attribution_id/first_source_channel
--   = argmin (created_at, id) sobre A. NÃO remove linhas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _merge_group_attributions(
  p_survivor_contact_id UUID,
  p_loser_contact_ids UUID[],
  OUT p_attributions_contact_repointed INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_ids UUID[] := p_survivor_contact_id || p_loser_contact_ids;
  v_first UUID;
  v_channel TEXT;
BEGIN
  p_attributions_contact_repointed := 0;

  UPDATE lead_attributions
     SET contact_id = p_survivor_contact_id
   WHERE contact_id = ANY(p_loser_contact_ids);
  GET DIAGNOSTICS p_attributions_contact_repointed = ROW_COUNT;

  -- §6.3: A = first_attribution_id de todos os membros (não-nulos) ∪
  -- atribuições ligadas ao sobrevivente (já re-apontadas acima).
  SELECT la.id INTO v_first
    FROM lead_attributions la
   WHERE la.id IN (
         SELECT c.first_attribution_id FROM contacts c
          WHERE c.id = ANY(v_member_ids)
            AND c.first_attribution_id IS NOT NULL
       )
      OR la.contact_id = p_survivor_contact_id
   ORDER BY la.created_at ASC, la.id::text ASC
   LIMIT 1;

  IF v_first IS NOT NULL THEN
    SELECT source_channel INTO v_channel FROM lead_attributions WHERE id = v_first;
    UPDATE contacts
       SET first_attribution_id = v_first,
           first_source_channel = v_channel
     WHERE id = p_survivor_contact_id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION _merge_group_attributions(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION _merge_group_attributions(UUID, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION _merge_group_attributions(UUID, UUID[]) FROM authenticated;

-- ------------------------------------------------------------
-- _merge_group_flow_runs — [MERGE §7]
--   §7.1: re-aponta contact_id em automation_logs,
--   automation_pending_executions e flow_runs (inclusive ativos).
--   §7.2: colisão de ativos por ORDEM_R (last_advanced_at DESC, id ASC);
--   não-sobreviventes transicionam para 'superseded_by_identity_merge'
--   com ended_at = NOW() transacional e end_reason =
--   'identity_merge:<merge_run_id>:<survivor_flow_run_id>' (B.5).
--   NÃO remove linhas.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION _merge_group_flow_runs(
  p_survivor_contact_id UUID,
  p_loser_contact_ids UUID[],
  p_merge_run_id UUID,
  OUT p_flow_runs_superseded INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_ids UUID[] := p_survivor_contact_id || p_loser_contact_ids;
  v_active_ids UUID[];
  v_survivor_run UUID;
  v_superseded UUID[];
BEGIN
  p_flow_runs_superseded := 0;

  -- Runs ativos do grupo, ordenados por ORDEM_R.
  SELECT array_agg(fr.id ORDER BY fr.last_advanced_at DESC, fr.id::text ASC)
    INTO v_active_ids
    FROM flow_runs fr
   WHERE fr.contact_id = ANY(v_member_ids)
     AND fr.status = 'active';

  IF v_active_ids IS NOT NULL AND cardinality(v_active_ids) > 1 THEN
    v_survivor_run := v_active_ids[1];
    v_superseded := v_active_ids[2:cardinality(v_active_ids)];

    -- Transição ANTES do re-apontamento (nota física do cabeçalho:
    -- o índice único parcial de ativos não admite duas linhas ativas
    -- para o mesmo (account_id, contact_id) após o re-apontamento).
    UPDATE flow_runs
       SET status   = 'superseded_by_identity_merge',
           ended_at = NOW(),
           end_reason = 'identity_merge:' || p_merge_run_id::text || ':' || v_survivor_run::text
     WHERE id = ANY(v_superseded);
    p_flow_runs_superseded := cardinality(v_superseded);
  END IF;

  -- §7.1: re-apontamento integral (agora com no máximo um ativo).
  UPDATE flow_runs SET contact_id = p_survivor_contact_id
   WHERE contact_id = ANY(p_loser_contact_ids);

  -- §7.1: tabelas de automação sem colisão.
  UPDATE automation_logs               SET contact_id = p_survivor_contact_id WHERE contact_id = ANY(p_loser_contact_ids);
  UPDATE automation_pending_executions SET contact_id = p_survivor_contact_id WHERE contact_id = ANY(p_loser_contact_ids);
END $$;

REVOKE ALL ON FUNCTION _merge_group_flow_runs(UUID, UUID[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION _merge_group_flow_runs(UUID, UUID[], UUID) FROM anon;
REVOKE ALL ON FUNCTION _merge_group_flow_runs(UUID, UUID[], UUID) FROM authenticated;

-- ------------------------------------------------------------
-- merge_identity_group — RPC pública única (C.1/C.2)
--   Esqueleto D.1: 1 lock → 2 recarrega grupo → 3 elege sobrevivente →
--   4 lock conversas → 5 merge_run_id → 6+13 contatos → 7/8/10
--   conversas/mensagens → 9 remove C_L → 11 atribuições → 12 flow_runs
--   → 14 remove L → 15 JSONB. Uma transação, nenhum COMMIT interno.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION merge_identity_group(
  p_account_id UUID,
  p_phone_identity TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_ids UUID[];
  v_loser_ids UUID[];
  v_survivor_id UUID;
  v_conv_ids UUID[];
  v_rec RECORD;
  v_c_s UUID;
  v_C_L UUID[];
  v_merge_run_id UUID;
  v_messages_collapsed INTEGER := 0;
  v_reactions_collapsed INTEGER := 0;
  v_attr_repointed INTEGER := 0;
  v_flow_superseded INTEGER := 0;
  v_conversations_merged INTEGER := 0;
BEGIN
  -- 1. Serialização do grupo (B.6). Reentrante se o caminho de escrita
  --    (C.4.2) já a detém nesta transação.
  PERFORM identity_merge_group_lock(p_account_id, p_phone_identity);

  -- Identidade vazia nunca forma grupo ([MERGE §2.5], item 3).
  IF p_phone_identity IS NULL OR p_phone_identity = '' THEN
    RETURN jsonb_build_object(
      'merge_run_id', NULL,
      'survivor_contact_id', NULL,
      'loser_contact_ids', jsonb_build_array(),
      'conversations_merged', 0,
      'messages_collapsed', 0,
      'reactions_collapsed', 0,
      'attributions_repointed', 0,
      'flow_runs_superseded', 0
    );
  END IF;

  -- 2. Recarrega o grupo sob o lock (TOCTOU evita lista de id do chamador).
  SELECT array_agg(sub.id ORDER BY sub.created_at ASC, sub.id::text ASC)
    INTO v_member_ids
    FROM (
      SELECT c.id, c.created_at
        FROM contacts c
       WHERE c.account_id = p_account_id
         AND c.phone_identity = p_phone_identity
       ORDER BY c.created_at ASC, c.id::text ASC
       FOR UPDATE
    ) sub;

  -- No-op seguro (C.2): grupo unitário ou inexistente.
  IF v_member_ids IS NULL OR cardinality(v_member_ids) <= 1 THEN
    RETURN jsonb_build_object(
      'merge_run_id', NULL,
      'survivor_contact_id',
        CASE WHEN v_member_ids IS NOT NULL AND cardinality(v_member_ids) = 1
             THEN v_member_ids[1] ELSE NULL END,
      'loser_contact_ids', jsonb_build_array(),
      'conversations_merged', 0,
      'messages_collapsed', 0,
      'reactions_collapsed', 0,
      'attributions_repointed', 0,
      'flow_runs_superseded', 0
    );
  END IF;

  -- 3. Sobrevivente = mínimo sob ORDEM_H (created_at ASC, id ASC).
  v_survivor_id := v_member_ids[1];
  v_loser_ids := v_member_ids[2:cardinality(v_member_ids)];

  -- 4. Lock das conversas do grupo (FOR UPDATE) — mesmo objetivo do
  --    lock de contatos (defesa em profundidade).
  SELECT array_agg(sub.id ORDER BY sub.created_at ASC, sub.id::text ASC)
    INTO v_conv_ids
    FROM (
      SELECT c.id, c.created_at
        FROM conversations c
       WHERE c.account_id = p_account_id
         AND c.contact_id = ANY(v_member_ids)
       ORDER BY c.created_at ASC, c.id::text ASC
       FOR UPDATE
    ) sub;

  -- 5. merge_run_id correlaciona todas as linhas de proveniência.
  v_merge_run_id := gen_random_uuid();

  -- 6 + 13: contatos — fill-gap, proveniência, re-apontamentos, colapsos.
  PERFORM _merge_group_contacts(
    p_account_id, p_phone_identity, v_survivor_id, v_loser_ids, v_merge_run_id
  );

  -- 7/8/10: conversas + mensagens (move, colapso, dependentes, campos).
  IF v_conv_ids IS NOT NULL AND cardinality(v_conv_ids) > 0 THEN
    SELECT * INTO v_rec
      FROM _merge_group_conversations(p_account_id, v_survivor_id, v_loser_ids);
    v_c_s := v_rec.p_conversation_survivor;
    v_C_L := v_rec.p_conversation_loser_ids;
    v_messages_collapsed := v_rec.p_messages_collapsed;
    v_reactions_collapsed := v_rec.p_reactions_collapsed;
    v_attr_repointed := v_rec.p_attributions_conversation_repointed;

    -- 9: remoção de C_L — somente agora, com 8a–8d completos e nenhuma
    --    linha remanescente referenciando C_L ([MERGE §4.5]).
    IF v_C_L IS NOT NULL AND cardinality(v_C_L) > 0 THEN
      DELETE FROM conversations WHERE id = ANY(v_C_L);
      v_conversations_merged := cardinality(v_C_L);
    END IF;

    -- §3.4/§4: a conversa sobrevivente pertence ao contato sobrevivente.
    -- Após a remoção de C_L, UNIQUE(account_id, contact_id) (029) admite
    -- o re-apontamento sem colisão.
    UPDATE conversations SET contact_id = v_survivor_id WHERE id = v_c_s;
  END IF;

  -- 11: lead_attributions.contact_id + first-touch (§6.2/§6.3).
  IF cardinality(v_loser_ids) > 0 THEN
    SELECT * INTO v_rec FROM _merge_group_attributions(v_survivor_id, v_loser_ids);
    v_attr_repointed := v_attr_repointed + v_rec.p_attributions_contact_repointed;
  END IF;

  -- 12: automation_logs / automation_pending_executions / flow_runs (§7).
  SELECT * INTO v_rec
    FROM _merge_group_flow_runs(v_survivor_id, v_loser_ids, v_merge_run_id);
  v_flow_superseded := v_rec.p_flow_runs_superseded;

  -- 14: remoção de L — por último, após literalmente tudo o mais
  --     ([MERGE §3.6]; CASCADE/SET NULL não atinge dado vivo).
  DELETE FROM contacts WHERE id = ANY(v_loser_ids);

  -- 15: JSONB de resumo operacional (C.2).
  RETURN jsonb_build_object(
    'merge_run_id', v_merge_run_id,
    'survivor_contact_id', v_survivor_id,
    'loser_contact_ids',
      (SELECT COALESCE(jsonb_agg(x.id), '[]'::jsonb) FROM unnest(v_loser_ids) AS x(id)),
    'conversations_merged', v_conversations_merged,
    'messages_collapsed', v_messages_collapsed,
    'reactions_collapsed', v_reactions_collapsed,
    'attributions_repointed', v_attr_repointed,
    'flow_runs_superseded', v_flow_superseded
  );
END $$;

REVOKE ALL ON FUNCTION merge_identity_group(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_identity_group(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION merge_identity_group(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION merge_identity_group(UUID, TEXT) TO service_role;
