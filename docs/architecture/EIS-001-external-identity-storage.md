# EIS-001 — External Identity Storage Specification

| | |
|---|---|
| **Tipo** | Contrato derivado (design document) |
| **Deriva de** | `ADR-MSG-001 v4` — **D2** (identidade como conjunto), **D3** (declaração de identidades pelo provider) |
| **Épico consumidor** | E2.0 — Message Identity Correction |
| **Status** | **Aprovado — tecnicamente fechado para implementação** |
| **Autoridade** | Este documento **não altera decisão do ADR**. Onde houver divergência entre este texto e o `ADR-MSG-001 v4`, prevalece o ADR e este documento está errado. |
| **Baseline de código** | HEAD `c8f1585` |

---

## 1. Escopo

### 1.1 O que este documento especifica

A **forma de armazenamento, escrita e resolução** do conjunto de identidades externas de mensagem, decidido em D2 e alimentado pela declaração de identidades de D3.

### 1.2 O que este documento não especifica

- **Retenção de variante de evento não reconhecida** (D3, cláusula de consumo não-destrutivo). É problema de retenção de *evento*, não de *identidade*; matéria de contrato derivado próprio. Registrado em §10 como dependência aberta.
- **Contrato da operação de interpretação de payload** (`parseEvents`) — pertence ao contrato de E1.
- **Máquina de estados e transições** — delegada por D7 a contrato próprio.
- **Entidade `connections`** — pertence ao contrato de E3. Este documento consome sua futura existência e declara como se comporta antes dela.
- **Convivência entre `delivered` (acervo) e `received` (novo)** — é armazenamento de estado, não de identidade. Pertence ao contrato de E2.0; registrado em §10.

### 1.3 Rastreabilidade obrigatória

Toda cláusula normativa deste documento cita a decisão do ADR que a autoriza. Cláusula sem citação é design livre e está identificada como **[SPEC]** — decisão deste documento, não do ADR, e portanto revisável sem reabrir o ADR.

---

## 2. Problema concreto a resolver

Herdado de `ADR-MSG-001 §2.3`, verificado no código do baseline:

```
zapi.ts:86,104,115,124,144,166   return { messageId: data.zaapId ?? data.messageId ?? '' }
zapi.ts:177   (inbound)          const messageId = (msg.messageId as string) ?? ''
```

O envio grava preferencialmente `zaapId` (identificador interno Z-API); os callbacks referenciam `messageId` (nível WhatsApp). uazapi lê `key.id` em ambos os caminhos (`uazapi.ts:83,200`) e é consistente. Meta usa `wamid` e é consistente.

**Este documento existe para que a correção não seja uma troca de precedência**, e sim a eliminação da escolha — conforme D2 e a alternativa A2 rejeitada no ADR.

### 2.1 Delimitação do dano histórico

O caminho de **entrada** do adaptador Z-API sempre leu `msg.messageId`. O operador `??` existe apenas no caminho de **envio**.

Consequências, ambas verificadas:

1. **O acervo de mensagens de entrada está correto e sempre esteve.** O dano de R16 é confinado às linhas de saída.
2. **O invariante B nunca foi afetado.** O índice `idx_messages_conv_msgid_customer` (034) é parcial em `sender_type = 'customer'` — isto é, entrada. R16 e o invariante B nunca se tocaram.

Esta delimitação fundamenta §4.3 e §7.

---

## 3. Estrutura de armazenamento

### 3.1 Tabela

```sql
CREATE TABLE IF NOT EXISTS message_external_ids (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id     UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  connection_ref UUID NOT NULL,
  kind           TEXT NOT NULL,
  value          TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Nomenclatura [SPEC].** A coluna chama-se `connection_ref`, não `connection_id`, deliberadamente: durante E2.0 ela referencia `whatsapp_config.id`, e em E3 passa a referenciar `connections.id`. O nome neutro evita que o re-pointing obrigatório de E3 seja confundido com mudança semântica — a semântica é a mesma nos dois regimes: *a conexão à qual esta identidade pertence*.

**Ausência de FK declarada [SPEC].** `connection_ref` não declara FK em E2.0. Declará-la contra `whatsapp_config` criaria dependência formal sobre a tabela que D1 rebaixa a legado, e obrigaria a derrubá-la e recriá-la em E3 sobre uma tabela com dados já migrados. A integridade referencial no regime E2.0 é garantida pelo caminho de escrita (§5), que é exclusivamente server-side. A FK contra `connections` é declarada em E3.

A alternativa — FK contra `whatsapp_config`, derrubada em E3 — é defensável e custa uma operação a mais na migração de E3.

### 3.2 Resolução do regime transitório de ancoragem

**Autorizado por D2, bloco "Estado transitório da ancoragem". APROVADO.**

O ADR admite que a ancoragem em conexão permaneça **pendente** entre as Etapas 2 e 5, com a unicidade garantida pelo invariante B. Este documento **não exerce essa permissão** e ancora desde E2.0 **[SPEC]**.

Fundamento: enquanto vigora `whatsapp_config_account_id_key UNIQUE(account_id)` (017), existe **exatamente uma conexão por conta, e ela tem identidade própria** — `whatsapp_config.id`. A conexão não é uma entidade formal, mas é uma entidade de fato. Ancorar nela é possível hoje.

Consequências:

1. `connection_ref` é `NOT NULL` desde o primeiro dia, o que elimina o problema de chave com componente nulo.
2. O invariante B permanece a garantia de unicidade de entrada durante todo o período, como o ADR exige — a ancoragem antecipada é **adicional**, não substitutiva.
3. E3 executa um *re-pointing* de `connection_ref`, transporte já previsto no faseamento da Etapa 5 do ADR.

**Verificação de conformidade:** esta escolha satisfaz D2 por meio mais forte do que o mínimo exigido. Não altera a decisão; exerce menos permissão do que ela concede. Nenhum estado intermediário admite identidade sem invariante B vigente — condição preservada.

**Obrigação vinculante para E3.** O contrato de E3 deve tratar o re-pointing de `connection_ref` de `whatsapp_config.id` para `connections.id` como **migração estrutural, sem alteração semântica da identidade**. A identidade referenciada é a mesma conexão antes e depois; muda a entidade que a representa, não o que ela identifica. Nenhuma linha de `message_external_ids` pode ter seu significado alterado por essa migração.

### 3.3 Espécies de identidade (`kind`)

**Autorizado por D2** — *"uma espécie... conjunto extensível"*.

| `kind` | Significado | Providers que a declaram |
|---|---|---|
| `wamid` | Identificador de mensagem no nível WhatsApp | Meta, Z-API |
| `provider_message_id` | Identificador interno atribuído pelo provider ao aceitar o envio | Z-API (`zaapId`), uazapi (`key.id`) |
| `provider_status_id` | Identificador usado pelo provider exclusivamente em eventos de status, quando distinto dos anteriores | nenhum, hoje |

**Sem `CHECK` sobre `kind` [SPEC].** D2 declara o conjunto extensível; um `CHECK` transformaria cada espécie nova em migração. A validação ocorre na camada de aplicação contra o registro acima, e o registro é mantido neste documento. Espécie desconhecida escrita por engano é detectável por consulta, não por constraint — trade-off aceito em favor da extensibilidade decidida no ADR.

`provider_status_id` consta do registro sem produtor atual porque é a espécie que o ADR nomeia (D2) e cuja ausência de uso é informação: hoje, nenhum provider integrado separa identidade de status da identidade de envio.

### 3.4 Unicidade e índices

```sql
-- Unicidade de resolução: um valor, numa conexão, numa espécie,
-- resolve para no máximo uma mensagem.
CREATE UNIQUE INDEX IF NOT EXISTS uq_meid_connection_kind_value
  ON message_external_ids (connection_ref, kind, value);

-- Caminho de leitura inverso: todas as identidades de uma mensagem.
CREATE INDEX IF NOT EXISTS idx_meid_message
  ON message_external_ids (message_id);
```

**Escopo da unicidade [SPEC], derivado de D2.**

D2 estabelece que a identidade declarada *"garante correlação dentro do escopo da conexão de origem"* e *"não garante unicidade global entre providers, entre conexões"*. O índice traduz literalmente esse alcance: unicidade **dentro** de `(connection_ref, kind)`, nenhuma pretensão fora dele.

Escopos rejeitados:

- **`(kind, value)` global** — violaria a garantia declarada em D2, ao presumir unicidade entre conexões que o ADR explicitamente nega.
- **`(message_id, kind, value)`** — permitiria que duas mensagens da mesma conexão reivindicassem o mesmo valor, tornando a resolução ambígua e destruindo a propriedade que justifica a estrutura.

O prefixo `connection_ref` está presente em todos os caminhos de resolução previstos (§4.2), de modo que o índice composto os atende integralmente.

### 3.5 RLS

**Espelha o padrão vigente de `messages`**, verificado em 017 (`messages_modify`) e 038 (`messages_select`).

```sql
ALTER TABLE message_external_ids ENABLE ROW LEVEL SECURITY;

-- Leitura: membro do tenant OU operador de platform com acesso.
-- Mesmo alcance de messages_select (038).
CREATE POLICY meid_select ON message_external_ids
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = message_external_ids.message_id
        AND (is_account_member(c.account_id) OR can_access_account(c.account_id))
    )
  );

-- Nenhuma policy de escrita para cliente.
```

**Ausência deliberada de policy de escrita.** Identidade externa não é dado editável por usuário: é asserção do provider, registrada pelo sistema. A escrita ocorre exclusivamente por service-role ou `SECURITY DEFINER` (§5.1), como já ocorre com a inserção de mensagens de entrada. Diferença consciente em relação a `messages`, que possui `messages_modify` para membros com papel `agent`.

**Isolamento de tenant.** Derivado por junção até E3, exatamente como `messages` hoje. Quando E3 ancorar `messages` à conta, esta especificação deve ser reavaliada para tirar proveito do caminho direto — registrado em §10.

---

## 4. Contrato de resolução

### 4.1 Operação

```
resolveMessageByExternalId(connectionRef, value, kind?) → messageId | null
```

**Autorizado por D2** — *"O domínio nunca pergunta 'qual é o identificador desta mensagem?'. Pergunta 'que mensagem responde por este valor?'"*.

`kind` é opcional **[SPEC]**: o chamador raramente sabe qual espécie o provider usou num evento — é justamente a ambiguidade que motivou D2. Omitido, a busca percorre todas as espécies daquela conexão; informado, restringe. A unicidade de §3.4 garante no máximo um resultado em ambos os modos.

### 4.2 Pré-condição: conexão conhecida

A resolução exige `connectionRef`. **Consequência direta de D3.a**, que determina a atribuição do evento a exatamente uma conexão *antes* de qualquer interpretação de domínio. No fluxo correto, a conexão é sempre conhecida quando a resolução ocorre.

Uma operação de resolução sem conexão **não é oferecida** — ela contornaria D3.a e reintroduziria a ambiguidade entre tenants que a unicidade escopada de §3.4 declaradamente não cobre.

### 4.3 Fallback sobre o acervo histórico

**[SPEC]** — decisão deste documento, necessária e não prevista pelo ADR.

Mensagens gravadas antes de E2.0 não possuem linhas em `message_external_ids`. Sem tratamento, o ciclo de status habilitado em E2.1 não correlacionaria nenhuma mensagem anterior à correção.

**Regra:** quando a resolução não encontrar identidade registrada, ela recorre a `messages.message_id`, **restrita à conexão**.

**Precedência normativa:** identidade registrada tem precedência absoluta; o fallback só atua na ausência total. Isso garante que a semântica nova nunca seja sobreposta pela antiga — condição que `ADR-MSG-001 §6.2` (Etapa 2, reversibilidade assimétrica) torna crítica.

**Superfície de risco declarada.** O fallback lê `messages.message_id`, campo **sem unicidade estrutural**. Diferente do caminho de identidade registrada, que tem garantia por índice (§3.4), o fallback depende inteiramente da restrição por conexão aplicada em código. É a única superfície de vazamento cross-tenant introduzida por este contrato, e por isso tem critério de aceitação dedicado (§8, critério 15).

Por §2.1, o fallback é na prática um mecanismo de correlação de **status sobre saída antiga** — o acervo de entrada nunca esteve afetado.

O fallback é **transitório por natureza e permanente por decisão**: sua remoção exigiria backfill completo do acervo, operação que este documento não recomenda (§7).

---

## 5. Contrato de escrita

### 5.1 Autoridade

A escrita ocorre exclusivamente por caminho server-side privilegiado — service-role ou `SECURITY DEFINER` — em coerência com §3.5 e com o padrão já vigente em `insert_inbound_message` (035).

### 5.2 Atomicidade

**Autorizado por D2** — *"O conjunto é mecanismo de correlação do domínio, não metadado descritivo"*.

A persistência das identidades ocorre **na mesma transação** que a persistência da mensagem. Uma mensagem sem suas identidades é uma mensagem sem capacidade de correlação — estado que D2 proíbe tratar como aceitável.

Consequência normativa: falha ao gravar identidade **invalida a operação inteira**. Não há degradação graciosa em que a mensagem é gravada e a identidade omitida.

### 5.3 Interação com o invariante A do ADR

**Crítico. Deriva do invariante A (`ADR-MSG-001 §4`).**

`insert_inbound_message` (035) retorna `NULL` em conflito, e `inbound-processor.ts:324` aborta os efeitos colaterais nesse caso.

**Regra:** quando a inserção da mensagem for suprimida por conflito — isto é, quando se tratar de reentrega — **a escrita de identidades não ocorre**. As identidades da mensagem original já estão registradas; reescrevê-las seria, na melhor hipótese, ruído, e na pior, violação da unicidade de §3.4.

A escrita de identidades é, portanto, **subordinada ao mesmo gate** que governa os efeitos colaterais. Ela é um efeito da criação da mensagem, não um efeito da chegada do evento.

### 5.4 Declaração parcial

**Autorizado por D3** — *"Identidades ausentes são omitidas; nunca são preenchidas com valor vazio"* — e por D2 — *"a declaração de uma identidade não obriga o provider a usá-la"*.

O provider declara o que conhece. Valor vazio, nulo ou ausente **não gera linha**. Uma mensagem pode legitimamente ter uma única identidade.

### 5.5 Idempotência da escrita

**[SPEC]** Reescrita da mesma tripla `(connection_ref, kind, value)` para a **mesma** mensagem é tratada como no-op. Para mensagem **diferente**, é conflito e deve falhar ruidosamente: indica erro de correlação, não condição normal.

---

## 6. Mapa de declaração por provider

Derivado de D3 e da verificação de código do baseline. Este mapa é o núcleo funcional de E2.0.

| Provider | Momento | Identidades declaradas | Origem no código |
|---|---|---|---|
| **Meta** | envio | `wamid` | inalterado |
| **Meta** | entrada | `wamid` | inalterado |
| **uazapi** | envio | `provider_message_id` | `uazapi.ts:83` (`key.id`) |
| **uazapi** | entrada | `provider_message_id` | `uazapi.ts:200` (`key.id`) |
| **Z-API** | envio | `wamid` **e** `provider_message_id` | `zapi.ts:83-86` — os dois campos que hoje competem no `??` |
| **Z-API** | entrada | `wamid` | `zapi.ts:177` (`msg.messageId`) |

### 6.1 Correção obrigatória em `zapi.ts`

Nos seis call-sites (`86, 104, 115, 124, 144, 166`):

1. O valor devolvido como identidade primária da mensagem — o que é gravado em `messages.message_id` — passa a ser `data.messageId`, **não** `data.zaapId`.

   Fundamento: é o valor que os callbacks referenciam, e `messages.message_id` tem semântica própria no modelo atual, participando do invariante B. A resolubilidade pela tabela de identidades **não substitui** a correção do valor persistido.

2. Ambos os valores são declarados como identidades: `data.messageId` como `wamid`, `data.zaapId` como `provider_message_id`.

3. Valores ausentes são omitidos, nunca convertidos em string vazia (§5.4).

**O operador `??` desaparece dos seis pontos.** Ele é a materialização da escolha que D2 elimina.

---

## 7. Acervo existente

**Decisão: não realizar backfill [SPEC]. APROVADO.**

Fundamentos:

1. O fallback de §4.3 preserva integralmente a capacidade de correlação sobre o acervo.
2. Um backfill teria de decidir, por mensagem antiga de Z-API, se o valor gravado é `zaapId` ou `messageId` — informação que **não é recuperável a partir do próprio dado**, já que o `??` não deixa rastro de qual ramo foi tomado. Um backfill seria adivinhação registrada como fato.
3. O dado irrecuperável está confinado ao caminho de saída (§2.1). O acervo de entrada está correto e não requer tratamento.
4. `ADR-MSG-001 §6.2` (Etapa 2) qualifica a reversão desta etapa como decisão sobre acervo. Não produzir acervo derivado mantém essa decisão mais simples.

O acervo permanece **legível por fallback e não migrado**. Dívida declarada, não esquecimento.

---

## 8. Critérios de aceitação

Critérios 1–9 originais; 10–16 acrescentados após validação de cobertura para o teste de regressão de R16 e para a convivência entre mensagens antigas e novas. Todos aprovados.

1. Toda mensagem criada após E2.0 possui ao menos uma linha de identidade, na mesma transação de sua criação.
2. Reentrega de mensagem de entrada não cria mensagem nem identidade, e não dispara efeito colateral — invariante A preservado ponta a ponta.
3. Para Z-API: mensagem enviada é resolvível tanto por `wamid` quanto por `provider_message_id`; a resolução por `wamid` retorna a mesma mensagem que a resolução por `provider_message_id`.
4. **Regressão de R16:** evento de status Z-API referenciando `messageId` resolve para a mensagem enviada. Este teste deve **falhar** contra o baseline `c8f1585` — se passar, o teste está errado, não o código.
5. Mensagem anterior a E2.0 permanece resolvível pelo fallback de §4.3.
6. Meta e uazapi não apresentam mudança de comportamento observável.
7. Nenhum cliente consegue escrever em `message_external_ids`; leitura respeita o mesmo alcance de `messages_select`, incluindo o acesso de operador de platform (038).
8. Nenhum valor vazio ou nulo é persistido como identidade.
9. Migração reexecutável sem erro.
10. Para Z-API, `messages.message_id` de mensagem de saída contém o identificador de nível WhatsApp (`data.messageId`). Verificado como asserção sobre o **valor persistido**, não sobre a resolubilidade.
11. Os critérios 3, 4 e 10 são verificados para **cada uma das seis operações de envio** de `zapi.ts` — texto, mídia, template, reação, botões e lista. Cobertura de uma operação não satisfaz o critério.
12. Nenhuma ocorrência de escolha entre `zaapId` e `messageId` permanece em `zapi.ts`, verificada como teste de arquitetura, no mesmo regime de D6.
13. Evento de status cujo valor não resolve para mensagem alguma produz registro observável e não é descartado em silêncio. A ausência de correlação é sinal, nunca ausência de sinal.
14. Mensagem que possua identidade registrada **e** `messages.message_id` preenchido resolve pela identidade registrada. A precedência de §4.3 é verificada, não presumida.
15. O fallback de §4.3 não resolve valor pertencente a outra conexão. Verificado com duas contas distintas portando o mesmo valor em `messages.message_id`.
16. Mensagem de entrada anterior a E2.0 permanece sujeita ao invariante B sem alteração — a correção de §6.1 não afeta o acervo de entrada, que sempre gravou o identificador de nível WhatsApp.

### 8.1 Notas sobre a cobertura

O critério **10** existe porque o conjunto de identidades **mascara** o defeito que ele corrige: sem ele, o critério 3 ficaria verde mesmo se `messages.message_id` continuasse recebendo `zaapId`.

O critério **13** existe porque a falha de R16 é *silenciosa*, e um conjunto de critérios que só verifica o caminho feliz não protege contra a propriedade que torna o risco crítico.

O critério **16** é registro de fronteira: afirma o que a mudança **não** toca, e impede que revisão futura conclua que o acervo de entrada precisa de tratamento.

---

## 9. Conformidade com o ADR

| Cláusula do ADR | Como este documento a cumpre |
|---|---|
| D2 — cardinalidade N | §3.1, sem restrição de contagem por mensagem |
| D2 — caracterização (conexão, espécie, valor) | §3.1, três colunas |
| D2 — resolução por valor, nunca leitura por campo | §4.1 |
| D2 — alcance das garantias | §3.4, unicidade escopada à conexão |
| D2 — conjunto é correlação, não metadado | §5.2, atomicidade obrigatória |
| D2 — regime transitório de ancoragem | §3.2, exercido por meio mais forte |
| D3 — provider declara, domínio resolve | §6, mapa de declaração |
| D3 — identidades ausentes omitidas | §5.4 |
| D3.a — conexão conhecida antes do domínio | §4.2, pré-condição da resolução |
| Invariante A | §5.3, escrita subordinada ao gate |
| Invariante B | §3.2, preservado como garantia de unicidade; §8 critério 16 |

**Nenhuma decisão do ADR foi alterada, ampliada ou reinterpretada.**

Cláusulas **[SPEC]** — revisáveis sem reabrir o ADR: nomenclatura de coluna (§3.1), ausência de FK em E2.0 (§3.1), ancoragem antecipada (§3.2), ausência de `CHECK` em `kind` (§3.3), escopo do índice de unicidade (§3.4), `kind` opcional na resolução (§4.1), fallback histórico (§4.3), idempotência da escrita (§5.5), política de backfill (§7).

Os critérios 10–16 não introduzem cláusula `[SPEC]` nova: 10–12 derivam de §6.1, 13 de D3, 14 de §4.3, 15 do alcance de garantias de D2, e 16 do invariante B.

---

## 10. Dependências abertas

1. **Retenção de variante de evento não reconhecida** (D3, não-destrutividade) — contrato derivado próprio, ainda não escrito. É a única obrigação de D3 sem contrato correspondente.
2. **Convivência `delivered` / `received`** — as três consequências normativas de `ADR-MSG-001 §7` precisam de critérios de aceitação próprios antes de E2.1. Portador natural: o contrato de E2.0. Hoje não estão em nenhum documento.
3. **Re-pointing de `connection_ref`** — o contrato de E3 deve prever o transporte de `whatsapp_config.id` para `connections.id` e a declaração da FK, como migração estrutural sem alteração semântica (§3.2).
4. **Reavaliação de RLS pós-E3** — quando `messages` ancorar à conta, a política desta tabela pode abandonar a dupla junção.
5. **N-3 do ADR** — deduplicação de efeitos no caminho de saída permanece aberta no ADR e pode afetar §5.3 quando resolvida, caso a escrita de identidades no envio precise do mesmo gate.
