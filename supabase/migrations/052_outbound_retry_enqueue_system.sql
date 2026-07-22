-- ============================================================
-- 052_outbound_retry_enqueue_system.sql — ADR-SYS-001 symmetry
-- for enqueue_outbound_retry
--
-- Commit 6.1 correção #5: automations/meta-send.ts e flows/meta-send.ts
-- rodam sob supabaseAdmin() (service_role, sem sessão de usuário) e,
-- uma vez migrados para usar handleSendFailure (correção #1/#6), também
-- precisam enfileirar no retry ledger — mas a única porta hoje
-- (enqueue_outbound_retry, 051) é authenticated-only e depende de
-- auth.uid(), exatamente a mesma classe de bloqueio que motivou
-- ADR-SYS-001 para settle_outbound_message. Esta migration fecha essa
-- lacuna aplicando o mesmo padrão já aprovado:
--
--   public facade (authenticated)  ─┐
--                                    ├─► core (mecânica, sem grants)
--   system facade (service_role)   ─┘
--
-- enqueue_outbound_retry: mesma assinatura, mesmo grant, mesmo
-- comportamento observável — corpo fatorado para delegar ao core.
-- enqueue_outbound_retry_system: nova, mesmo contrato de retorno
-- (jsonb), sem checagem de auth.uid(), GRANT EXECUTE só para
-- service_role — mesmo molde de settle_outbound_message_system (050)
-- e insert_inbound_message (035).
--
-- Nota: 051 já nasceu com RETURNS jsonb (sem o drift que settle_
-- outbound_message teve em 048) — CREATE OR REPLACE de jsonb para
-- jsonb não muda tipo de retorno, então nenhum DROP FUNCTION é
-- necessário aqui.
-- ============================================================

-- ------------------------------------------------------------
-- enqueue_outbound_retry_core — mecânica pura de enfileiramento.
-- Nenhuma checagem de autorização — responsabilidade exclusiva de
-- cada fachada. Sem GRANT a ninguém.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_outbound_retry_core(
  p_message_id      UUID,
  p_classification  TEXT,
  p_next_attempt_at TIMESTAMPTZ,
  p_last_error      TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_classification NOT IN ('ambiguous', 'deterministic_transient', 'deterministic_permanent') THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: invalid classification: %', p_classification;
  END IF;

  INSERT INTO outbound_retry_ledger
    (message_id, attempt_count, next_attempt_at, classification, last_error, status)
  VALUES
    (p_message_id, 0, p_next_attempt_at, p_classification, p_last_error, 'pending')
  ON CONFLICT (message_id) DO NOTHING;

  RETURN jsonb_build_object('messageId', p_message_id, 'enqueued', true);
END;
$$;

REVOKE ALL ON FUNCTION enqueue_outbound_retry_core FROM PUBLIC;

-- ------------------------------------------------------------
-- enqueue_outbound_retry — fachada de ator humano (inalterada em
-- assinatura, grants e comportamento observável). Resolve account_id
-- + aplica a mesma checagem is_account_member/can_access_account de
-- antes, depois delega ao core.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_outbound_retry(
  p_message_id      UUID,
  p_classification  TEXT,
  p_next_attempt_at TIMESTAMPTZ,
  p_last_error      TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT c.account_id INTO v_account_id
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.id = p_message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: message not found (id: %)', p_message_id;
  END IF;

  IF NOT (is_account_member(v_account_id) OR can_access_account(v_account_id)) THEN
    RAISE EXCEPTION 'enqueue_outbound_retry: not authorized for account %', v_account_id;
  END IF;

  RETURN enqueue_outbound_retry_core(p_message_id, p_classification, p_next_attempt_at, p_last_error);
END;
$$;

REVOKE ALL ON FUNCTION enqueue_outbound_retry FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_outbound_retry TO authenticated;

-- ------------------------------------------------------------
-- enqueue_outbound_retry_system — ADR-SYS-001, Alternativa A.
-- Fachada de ator de sistema. Mesmo comportamento do core; SEM
-- checagem de auth.uid(). Autorização delegada à posse da chave de
-- service_role. Chamadores: automations/meta-send.ts e
-- flows/meta-send.ts (via handleSendFailure com actor='system').
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_outbound_retry_system(
  p_message_id      UUID,
  p_classification  TEXT,
  p_next_attempt_at TIMESTAMPTZ,
  p_last_error      TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN enqueue_outbound_retry_core(p_message_id, p_classification, p_next_attempt_at, p_last_error);
END;
$$;

REVOKE ALL ON FUNCTION enqueue_outbound_retry_system FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_outbound_retry_system FROM anon;
REVOKE ALL ON FUNCTION enqueue_outbound_retry_system FROM authenticated;
GRANT EXECUTE ON FUNCTION enqueue_outbound_retry_system TO service_role;
