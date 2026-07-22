-- ============================================================
-- 050_background_system_authorization.sql — ADR-SYS-001
-- Background System Authorization Boundary (Alternativa A)
--
-- Fatora a lógica de transição de settle_outbound_message (048) numa
-- função interna comum (settle_outbound_message_core), e introduz uma
-- segunda porta de autorização — settle_outbound_message_system —
-- para atores de sistema (processos sem sessão humana, service_role),
-- no mesmo molde de insert_inbound_message (035): sem checagem de
-- auth.uid(), GRANT EXECUTE só para service_role, autorização
-- delegada inteiramente à fronteira que já validou o chamador antes
-- de a chamada chegar aqui.
--
-- ADR-SYS-001 §7 (requisito estrutural vinculante): as duas portas
-- públicas (settle_outbound_message para `authenticated`,
-- settle_outbound_message_system para `service_role`) são fachadas de
-- autorização distintas sobre a MESMA autoridade de transição
-- (settle_outbound_message_core) — nunca duas lógicas de transição
-- independentes. Isso preserva ODI-001 §5/§9 (liquidação como
-- autoridade única) em espírito, não só em nome.
--
-- settle_outbound_message: mesma assinatura, mesmo modelo de
-- autorização (is_account_member/can_access_account via auth.uid()),
-- mesmo comportamento e mensagens de erro observáveis pelo chamador
-- — apenas o corpo passa a delegar a mecânica de transição ao core.
-- Nenhuma migration anterior (001–049) é alterada.
--
-- NOTA — reconciliação de contrato vivo (pós-diagnóstico de deploy):
-- a função settle_outbound_message realmente implantada no banco
-- retorna `jsonb`, não `TEXT` como a migration 048 hoje descreve no
-- repositório (048 diverge do estado real — não é alterada aqui,
-- fica como registro histórico obsoleto). Esta migration usa
-- RETURNS jsonb em todas as três funções. Como CREATE OR REPLACE não
-- permite alterar RETURNS (erro 42P13), a recriação de
-- settle_outbound_message é precedida por DROP FUNCTION IF EXISTS.
-- ============================================================

-- ------------------------------------------------------------
-- settle_outbound_message_core — autoridade única de transição.
--
-- Puramente mecânica: lock da linha, compare-and-set, hardening de
-- provider_message_id, escrita de identidades externas. NENHUMA
-- checagem de autorização — isso é responsabilidade exclusiva de
-- cada fachada que a chama.
--
-- Sem GRANT a ninguém (nem authenticated, nem service_role, nem
-- anon) — só é alcançável a partir das duas fachadas abaixo, que
-- executam como o dono da função (SECURITY DEFINER), o qual sempre
-- retém EXECUTE sobre funções que possui.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION settle_outbound_message_core(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_outcome TEXT;
BEGIN
  -- Lock + read current state. Sem join a conversations: account_id
  -- não é necessário aqui — é assunto de autorização, não de
  -- transição, e cada fachada já resolveu (ou dispensou) isso antes
  -- de chegar aqui.
  SELECT status INTO v_current_status
  FROM messages
  WHERE id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settle_outbound_message: message not found (id: %)', p_message_id;
  END IF;

  -- Compare-and-set: só transiciona a partir de 'sending'.
  IF v_current_status != 'sending' THEN
    RETURN jsonb_build_object('messageId', p_message_id, 'outcome', 'noop');
  END IF;

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

  RETURN jsonb_build_object('messageId', p_message_id, 'outcome', v_outcome);
END;
$$;

REVOKE ALL ON FUNCTION settle_outbound_message_core FROM PUBLIC;

-- ------------------------------------------------------------
-- settle_outbound_message — fachada de ator humano (inalterada em
-- assinatura, modelo de autorização e comportamento observável).
--
-- Resolve account_id via o mesmo join de antes, aplica exatamente a
-- mesma checagem is_account_member/can_access_account e, só então,
-- delega a transição ao core. O core faz seu próprio lock da linha
-- (FOR UPDATE) — a leitura de account_id aqui não usa FOR UPDATE
-- porque serve apenas para a decisão de autorização, não para a
-- transição em si.
--
-- DROP prévio necessário porque 048 criou esta mesma função com
-- RETURNS TEXT, e CREATE OR REPLACE não permite alterar o tipo de
-- retorno (erro 42P13). Bootstrap seguro: após 048, o DROP derruba
-- a versão TEXT e a recria como jsonb. Em produção (onde a função
-- já foi manualmente alterada para jsonb), o DROP é inócuo.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS settle_outbound_message(UUID, TEXT, UUID, TEXT, JSONB);
CREATE OR REPLACE FUNCTION settle_outbound_message(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
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
    RAISE EXCEPTION 'settle_outbound_message: message not found (id: %)', p_message_id;
  END IF;

  IF NOT (is_account_member(v_account_id) OR can_access_account(v_account_id)) THEN
    RAISE EXCEPTION 'settle_outbound_message: not authorized for account %', v_account_id;
  END IF;

  RETURN settle_outbound_message_core(
    p_message_id, p_status, p_connection_ref, p_provider_message_id, p_identities
  );
END;
$$;

REVOKE ALL ON FUNCTION settle_outbound_message FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_outbound_message TO authenticated;

-- ------------------------------------------------------------
-- settle_outbound_message_system — ADR-SYS-001, Alternativa A.
--
-- Fachada de ator de sistema. Mesmo comportamento de transição do
-- core; SEM checagem de auth.uid() — não há sessão humana a
-- verificar. A autorização é inteiramente delegada à posse da chave
-- de service_role, exatamente o modelo já em produção para
-- insert_inbound_message (035). Chamadores: automations/meta-send.ts
-- e flows/meta-send.ts (migração dos call-sites é trabalho
-- separado, não desta migration) e, futuramente, o scheduler de E4b
-- (ARO-001), uma vez que ADR-SYS-001 esteja implementado.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION settle_outbound_message_system(
  p_message_id UUID,
  p_status TEXT,
  p_connection_ref UUID DEFAULT NULL,
  p_provider_message_id TEXT DEFAULT NULL,
  p_identities JSONB DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN settle_outbound_message_core(
    p_message_id, p_status, p_connection_ref, p_provider_message_id, p_identities
  );
END;
$$;

REVOKE ALL ON FUNCTION settle_outbound_message_system FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_outbound_message_system FROM anon;
REVOKE ALL ON FUNCTION settle_outbound_message_system FROM authenticated;
GRANT EXECUTE ON FUNCTION settle_outbound_message_system TO service_role;
