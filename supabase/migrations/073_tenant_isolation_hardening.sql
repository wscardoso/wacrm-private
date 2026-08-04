-- ============================================================
-- 073_tenant_isolation_hardening.sql — Gate 1 (Segurança Multi-Tenant)
--
-- Fecha três bloqueios de isolamento entre tenants encontrados em
-- produção. Nenhuma mudança de arquitetura, ADR ou comportamento
-- funcional — apenas autorização/RLS ausentes.
--
-- 1. insert_message_external_ids() (047) é SECURITY DEFINER com
--    GRANT EXECUTE TO authenticated e não validava que o message_id
--    recebido pertence à conta do chamador — um usuário autenticado
--    de qualquer tenant podia anexar um external id (wamid) a uma
--    mensagem de OUTRA conta. Único chamador real, createOutboundMessage()
--    (settlement.ts), sempre roda com o client de sessão do usuário
--    (auth.uid() presente) — mesma convenção de autorização já usada
--    em settle_outbound_message (048): is_account_member OR
--    can_access_account sobre a conta dona da mensagem, ANTES do
--    INSERT. Nenhum caminho service_role chama esta função (os
--    facades settle_outbound_message*/_system inserem em
--    message_external_ids diretamente, sem passar por aqui).
--
-- 2/3/4. whatsapp_webhook_dlq (031), identity_merge_provenance (067) e
--    identity_merge_backfill_checkpoint (071) foram criadas com
--    account_id mas sem RLS — leitura cross-tenant via PostgREST.
--    Mesmo padrão já em uso no projeto (lead_attributions_select, 033;
--    meid_select, 047): policy de SELECT única via is_account_member.
--    Nenhuma policy de escrita é adicionada — todas as escritas destas
--    três tabelas já passam por SECURITY DEFINER (enqueue_webhook_dlq,
--    merge_identity_group() e helpers) ou por conexão direta com
--    service_role (scripts/backfill-identity-merge.mjs via DATABASE_URL,
--    que não é sujeita a RLS).
-- ============================================================

-- ------------------------------------------------------------
-- 1. insert_message_external_ids() — validação de posse do message_id
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_message_external_ids(p_identities JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_foreign_account UUID;
BEGIN
  -- Todo message_id do lote deve pertencer a uma conta da qual o
  -- chamador é membro ou operador (mesma checagem de settle_outbound_message,
  -- 048). Falha o lote inteiro em vez de filtrar silenciosamente — a
  -- mesma mensagem chega em requisições futuras se o motivo era um bug
  -- de cliente, e nunca escrevemos parcialmente sob incerteza.
  SELECT c.account_id INTO v_foreign_account
    FROM jsonb_array_elements(p_identities) AS item
    JOIN messages m ON m.id = (item->>'message_id')::UUID
    JOIN conversations c ON c.id = m.conversation_id
   WHERE NOT (is_account_member(c.account_id) OR can_access_account(c.account_id))
   LIMIT 1;

  IF v_foreign_account IS NOT NULL THEN
    RAISE EXCEPTION 'insert_message_external_ids: not authorized for account %', v_foreign_account;
  END IF;

  INSERT INTO message_external_ids (message_id, connection_ref, kind, value)
  SELECT
    (item->>'message_id')::UUID,
    (item->>'connection_ref')::UUID,
    item->>'kind',
    item->>'value'
  FROM jsonb_array_elements(p_identities) AS item;
END;
$$;

REVOKE ALL ON FUNCTION insert_message_external_ids(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_message_external_ids(JSONB) TO authenticated;

-- ------------------------------------------------------------
-- 2. whatsapp_webhook_dlq — RLS
-- ------------------------------------------------------------
ALTER TABLE whatsapp_webhook_dlq ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_webhook_dlq_select ON whatsapp_webhook_dlq;
CREATE POLICY whatsapp_webhook_dlq_select ON whatsapp_webhook_dlq FOR SELECT
  USING (is_account_member(account_id));

-- ------------------------------------------------------------
-- 3. identity_merge_provenance — RLS
-- ------------------------------------------------------------
ALTER TABLE identity_merge_provenance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS identity_merge_provenance_select ON identity_merge_provenance;
CREATE POLICY identity_merge_provenance_select ON identity_merge_provenance FOR SELECT
  USING (is_account_member(account_id));

-- ------------------------------------------------------------
-- 4. identity_merge_backfill_checkpoint — RLS
-- ------------------------------------------------------------
ALTER TABLE identity_merge_backfill_checkpoint ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS identity_merge_backfill_checkpoint_select ON identity_merge_backfill_checkpoint;
CREATE POLICY identity_merge_backfill_checkpoint_select ON identity_merge_backfill_checkpoint FOR SELECT
  USING (is_account_member(account_id));
