-- ============================================================
-- 069_identity_merge_group_lock.sql — advisory lock de grupo
--
-- HOTFIX-001 B.6 (MÉDIO resolvido). Trava real por (account_id,
-- phone_identity), usada tanto por merge_identity_group() quanto pelo
-- caminho de escrita em tempo real (Estados 1 e 2, HOTFIX-001 A.4/C.4)
-- para que a chave de hashing NUNCA divirja entre os dois lados.
--
-- pg_advisory_xact_lock: liberado no COMMIT/ROLLBACK da transação
-- corrente — nunca trava presa por caminho de erro. Reentrante: se o
-- caminho de escrita já a adquiriu e depois chama merge_identity_group()
-- (que a chama de novo como passo 1), o segundo pedido é no-op seguro.
-- ============================================================

CREATE OR REPLACE FUNCTION identity_merge_group_lock(
  p_account_id UUID,
  p_phone_identity TEXT
) RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock(hashtext(p_account_id::text || ':' || p_phone_identity));
$$;

REVOKE ALL ON FUNCTION identity_merge_group_lock(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_merge_group_lock(UUID, TEXT) TO service_role;
