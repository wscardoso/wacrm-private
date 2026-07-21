-- ============================================================
-- 048_outbound_delivery_integrity.sql — E4a: Outbound Delivery Integrity
--
-- ODI-001 v3:
--   §6.1 — idempotency_key column (escopo próprio de ODI-001)
--   §5   — settle_outbound_message RPC (modo-2 da liquidação)
-- ============================================================

-- ------------------------------------------------------------
-- §6.1 — idempotency_key column
--
-- A chave é o próprio UUID da mensagem (message.id), gerado
-- pelo cliente no momento da criação da intenção. Isso garante
-- que:
--   1. a chave nasce com a intenção (mesmo INSERT)
--   2. é estável — o mesmo UUID identifica a mesma intenção em
--      qualquer tentativa
--   3. é única por intenção (PK da tabela)
--   4. retry lê o mesmo UUID sem recalcular (E4b busca pelo PK)
-- ------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key UUID;

COMMENT ON COLUMN messages.idempotency_key IS
  'ODI-001 §6.1: idempotency key = messages.id — criada com a intenção, lida em retry, nunca recalculada.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency_key
  ON messages (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ------------------------------------------------------------
-- §5 — settle_outbound_message (modo-2)
--
-- SECURITY DEFINER, transacional.
--
-- Autorização:
--   Valida que auth.uid() é membro ou operador da account
--   dona da conversa antes de qualquer mutação. O mesmo padrão
--   usado por todas as RLS policies e RPCs do sistema.
--
-- Compare-and-set:
--   Transiciona a intenção de 'sending' para o estado resultante
--   apenas se o estado atual ainda for 'sending'. Se já tiver
--   mudado (concorrência), retorna outcome = 'noop' sem alterar
--   nada.
--
-- Noop:
--   outcome = 'noop' significa NENHUMA mutação — o estado não
--   mudou. Status inválido rejeita com erro.
--
-- Hardening:
--   sent requer provider_message_id não nulo; caso contrário
--   rejeita (impede sobrescrever message_id com NULL).
--
-- Retorno: { messageId: UUID, outcome: 'sent' | 'failed' | 'noop' }
--   sent   → esta invocação transicionou para sent   (sucesso efetivo)
--   failed → esta invocação transicionou para failed (falha efetiva)
--   noop   → mensagem já estava no estado-alvo        (repetição)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION settle_outbound_message(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_account_id UUID;
  v_outcome TEXT;
BEGIN
  -- Lock + read current state + resolve owning account
  SELECT m.status, c.account_id
  INTO v_current_status, v_account_id
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settle_outbound_message: message not found (id: %)', p_message_id;
  END IF;

  -- Authorize: caller must be member or operator of the owning account
  IF NOT (is_account_member(v_account_id) OR can_access_account(v_account_id)) THEN
    RAISE EXCEPTION 'settle_outbound_message: not authorized for account %', v_account_id;
  END IF;

  -- Compare-and-set: only transition from 'sending'
  IF v_current_status != 'sending' THEN
    RETURN jsonb_build_object('messageId', p_message_id, 'outcome', 'noop')::text;
  END IF;

  -- Dispatch by target status
  IF p_status = 'sent' THEN
    IF p_provider_message_id IS NULL THEN
      RAISE EXCEPTION 'settle_outbound_message: provider_message_id is required for status sent';
    END IF;

    UPDATE messages
    SET status = p_status,
        message_id = p_provider_message_id
    WHERE id = p_message_id;

    IF p_connection_ref IS NOT NULL
       AND p_identities IS NOT NULL AND jsonb_array_length(p_identities) > 0
    THEN
      INSERT INTO message_external_ids (message_id, connection_ref, kind, value)
      SELECT
        (item->>'message_id')::UUID,
        (item->>'connection_ref')::UUID,
        item->>'kind',
        item->>'value'
      FROM jsonb_array_elements(p_identities) AS item;
    END IF;

    v_outcome := 'sent';
  ELSIF p_status = 'failed' THEN
    UPDATE messages
    SET status = p_status
    WHERE id = p_message_id;

    v_outcome := 'failed';
  ELSE
    RAISE EXCEPTION 'settle_outbound_message: invalid status: %', p_status;
  END IF;

  RETURN jsonb_build_object('messageId', p_message_id, 'outcome', v_outcome)::text;
END;
$$;

REVOKE ALL ON FUNCTION settle_outbound_message FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_outbound_message TO authenticated;
