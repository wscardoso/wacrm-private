# F3 — Ownership / isolamento entre contas

Status: **implementação parcial autorizada** (caminhos `service_role`) +
**proposta de migration pendente de autorização**.

Nenhuma migration foi criada. Nenhum SQL foi executado no Supabase Cloud.
O SQL abaixo é uma proposta técnica; a validação executável está em
`src/test/f3-ownership-db-gaps.pglite.test.ts` (PGlite local).

## 1. Superfície mapeada

| Área | Caminho de escrita | Guard atual | Gap | Camada da correção |
|---|---|---|---|---|
| `contact_tags` | `contact-form.tsx`, `contact-detail-view.tsx`, `resolve-import-tags.ts`, `automations/engine.ts`, `flows/engine.ts` | RLS 017 valida **apenas** o `contact_id`; engines validam o contato no dispatch | `tag_id` de outra conta é aceito; os engines não validavam a tag | app (engines, feito) + RLS (proposta) |
| `deals` | `deal-form.tsx`, `automations/engine.ts`, `api/deals/status` | RLS 017 valida **apenas** `account_id`; `move_deal_stage` já validava stage; `create_deal` não | `contact_id`, `pipeline_id`, `stage_id`, `conversation_id` estrangeiros | app (`create_deal`, feito) + RLS (proposta) |
| `conversations` | webhook, inbound-processor, send route, flows | webhook/inbound criam o contato com escopo de conta; update do engine filtra `account_id` | RLS 017 valida **apenas** `account_id`; `contact_id` e `assigned_agent_id` estrangeiros | RLS/trigger (proposta); `handoff` e `assign_conversation` (feito) |
| `automation_steps` | `steps-tree.ts` (admin), `duplicate` (admin) | API valida a automação; RLS 017 valida **apenas** `automation_id` | `parent_step_id` pode apontar para step de outra automação/conta; `step_config` carrega IDs estrangeiros | trigger de parent (proposta) + guards de runtime (feito) |
| `flow_nodes` | `api/flows/[id]` e `api/flows` (admin) | flow é validado por `requireOwnership`; RLS 017 valida **apenas** `flow_id` | `config` é JSON sem FK: `tag_id` e `assign_to` podem ser estrangeiros | guards de runtime (feito); validação no save é hardening opcional |

Observação: o `contact_tags` é a única tabela do conjunto sem
`account_id`; a conta é derivada do contato. `deals` e `conversations`
têm `account_id`, mas as policies de 017 não o cruzam com as FKs.

## 2. Correções implementadas (sem migration)

### 2.1 `src/lib/automations/engine.ts`

- `add_tag` / `remove_tag`: antes do `upsert`/`delete` no client
  `service_role`, verifica `tags.id = tag_id AND tags.account_id =
  automation.account_id`. ID estrangeiro falha o step com
  `tag not in account`; nada é escrito.
- `create_deal`: verifica que o `stage_id` pertence a um pipeline da
  conta e que `stage.pipeline_id = cfg.pipeline_id`, o mesmo padrão já
  usado em `move_deal_stage`. ID estrangeiro falha com
  `pipeline/stage not in account`; nenhum deal é inserido.
- `assign_conversation` (modo `specific`): verifica que o
  `agent_id` é membro da conta antes de gravar
  `conversations.assigned_agent_id`. O modo `round_robin` continua
  delegando a checagem ao RPC `assign_next_lead_agent`, que já é
  account-scoped.

### 2.2 `src/lib/flows/engine.ts`

- `set_tag`: verifica `tags.account_id = run.account_id` antes de
  escrever `contact_tags`. A falha é registrada como
  `set_tag_failed` e o fluxo avança sem escrever.
- `handoff`: só grava `assigned_agent_id` quando o profile pertence à
  conta do run. Um `assign_to` estrangeiro gera o evento
  `handoff_agent_not_in_account` e o handoff prossegue sem assignee.

Esses guards fecham os caminhos que usam `supabaseAdmin()` e,
portanto, não podem contar com RLS.

## 3. Proposta de migration (NÃO criada)

Nome sugerido: `083_ownership_cross_account_hardening.sql`.

### 3.1 `contact_tags`

Recriar `contact_tags_modify` exigindo que a tag pertença à mesma conta
do contato, tanto no `USING` quanto no `WITH CHECK`:

```sql
DROP POLICY contact_tags_modify ON contact_tags;
CREATE POLICY contact_tags_modify ON contact_tags FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = contact_tags.contact_id
        AND is_account_member(c.account_id, 'agent')
    )
    AND EXISTS (
      SELECT 1 FROM contacts c
      JOIN tags t ON t.account_id = c.account_id
      WHERE c.id = contact_tags.contact_id
        AND t.id = contact_tags.tag_id
    )
  )
  WITH CHECK (/* mesma expressão */);
```

Índice de apoio: `tags (id, account_id)` já é coberto pela PK + coluna;
`contact_tags (tag_id)` já existe (`idx_contact_tags_tag`).

### 3.2 `deals`

Adicionar `WITH CHECK` em `deals_insert` e `deals_update`:

```sql
DROP POLICY deals_insert ON deals;
CREATE POLICY deals_insert ON deals FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = deals.contact_id AND c.account_id = deals.account_id
    )
    AND EXISTS (
      SELECT 1 FROM pipeline_stages s
      JOIN pipelines p ON p.id = s.pipeline_id
      WHERE s.id = deals.stage_id
        AND s.pipeline_id = deals.pipeline_id
        AND p.account_id = deals.account_id
    )
    AND (
      deals.conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM conversations cv
        WHERE cv.id = deals.conversation_id
          AND cv.account_id = deals.account_id
          AND cv.contact_id = deals.contact_id
      )
    )
  );

DROP POLICY deals_update ON deals;
CREATE POLICY deals_update ON deals FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (/* mesma expressão do INSERT */);
```

`deals.assigned_to` (002) também deve ser validado como profile da
mesma conta, se for mantido como coluna gravável pelo cliente:

```sql
AND (
  deals.assigned_to IS NULL
  OR EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = deals.assigned_to
      AND p.account_id = deals.account_id
  )
)
```

### 3.3 `conversations`

Adicionar `WITH CHECK` em `conversations_insert` e `conversations_update`:

```sql
DROP POLICY conversations_insert ON conversations;
CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = conversations.contact_id
        AND c.account_id = conversations.account_id
    )
    AND (
      conversations.assigned_agent_id IS NULL
      OR EXISTS (
        SELECT 1 FROM profiles p
        WHERE p.user_id = conversations.assigned_agent_id
          AND p.account_id = conversations.account_id
      )
    )
  );

DROP POLICY conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (/* mesma expressão do INSERT */);
```

A FK de 075 (`assigned_agent_id → profiles.user_id`) permanece; ela
garante que o profile existe, não que ele seja da mesma conta.

### 3.4 `automation_steps`

Trigger `BEFORE INSERT OR UPDATE` para impedir `parent_step_id` de
outra automação:

```sql
CREATE OR REPLACE FUNCTION automation_steps_parent_same_automation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_parent_automation UUID;
BEGIN
  IF NEW.parent_step_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT automation_id INTO v_parent_automation
    FROM automation_steps
   WHERE id = NEW.parent_step_id;

  IF v_parent_automation IS NULL THEN
    RAISE EXCEPTION 'automation_steps: parent step not found';
  END IF;

  IF v_parent_automation <> NEW.automation_id THEN
    RAISE EXCEPTION 'automation_steps: parent step belongs to another automation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER automation_steps_parent_tenant
  BEFORE INSERT OR UPDATE ON automation_steps
  FOR EACH ROW EXECUTE FUNCTION automation_steps_parent_same_automation();
```

`step_config` é JSON e não tem FK. A validação dos IDs internos
(`tag_id`, `pipeline_id`, `stage_id`, `agent_id`) fica nos guards de
runtime da seção 2. Uma validação no save é possível, mas exige uma
lista fechada de campos por `step_type`; não foi implementada nesta
rodada para não ampliar o escopo.

### 3.5 `flow_nodes`

`flow_nodes.config` também é JSON sem FK. Não há trigger genérico
seguro para validar `tag_id` / `assign_to` sem conhecer o formato de
cada `node_type`. A proteção efetiva nesta rodada é a de runtime
(seção 2.2). Hardening opcional: validar no `PUT /api/flows/[id]` os
campos `set_tag.tag_id`, `condition.subject_key` (quando
`subject = 'tag'`) e `handoff.assign_to` contra a conta do flow, antes
do insert.

## 4. Evidência

- `src/test/f3-ownership-db-gaps.pglite.test.ts`
  - bloco **ANTES**: reproduz as quatro associações cross-account
    aceitas pelas policies de 017 (contact_tags, deals, conversations,
    automation_steps).
  - bloco **PROPOSTA**: aplica o SQL da seção 3 inline e prova que os
    quatro casos passam a ser rejeitados, mantendo os casos legítimos
    da própria conta funcionando.
- `src/lib/automations/engine.funnel.test.ts`: add/remove tag, criação
  de deal e assignee específico.
- `src/lib/flows/engine.test.ts`: `set_tag` e `handoff`.

## 5. Riscos residuais

1. Enquanto a migration não for autorizada e aplicada, um cliente
   autenticado ainda pode chamar o PostgREST diretamente e criar
   `contact_tags`, `deals`, `conversations` ou `automation_steps`
   cross-account. Os guards de aplicação não cobrem chamadas diretas ao
   banco.
2. `flow_nodes.config` e `automation_steps.step_config` continuam sem
   validação estrutural no banco.
3. A migration precisa ser testada contra os dados existentes: as
   consultas D7 encontraram linhas cross-account em seed. A aplicação
   da policy pode falhar se houver linhas antigas que violem o novo
   `WITH CHECK`? `WITH CHECK` não revalida linhas existentes; a
   limpeza/backfill é necessária para que edições futuras dessas linhas
   não sejam bloqueadas.
4. `deals_update` e `conversations_update` com `WITH CHECK` podem
   bloquear updates legítimos que hoje mudam `contact_id` ou
   `assigned_agent_id`; a suíte e2e deve cobrir deal form, inbox e
   automação de assignment.

## 6. O que precisa de autorização

- Criar a migration `083` com o SQL da seção 3.
- Executar a validação da migration em ambiente de staging/Cloud.
- Definir o tratamento das linhas seed cross-account já existentes
  (backfill, quarentena ou correção manual).
- Autorizar a implementação do hardening de save-time em
  `automation_steps`/`flow_nodes`, se desejado.
