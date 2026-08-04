# ADR-CONTACT-MERGE-001 — Semântica de Consolidação de Contatos e Conversas

| | |
|---|---|
| **Tipo** | ADR fundacional — segundo de dois; consome `ADR-IDENTITY-BR-001` como entrada congelada |
| **Status** | Proposto — para Gate Arquitetural |
| **Depende de** | `ADR-IDENTITY-BR-001` (**congelado**, §14 daquele documento). Este ADR **não altera, não reinterpreta e não estende** nenhuma decisão de identidade. Onde precisa de identidade, invoca `identity()` conforme `ADR-IDENTITY-BR-001` §6.6 e nada mais. |
| **Autoridade** | Decide **exclusivamente**: quem sobrevive a um merge, como cada tabela dependente é consolidada, como cada colisão de constraint é resolvida, o que significa formalmente "não perder informação", e as propriedades de idempotência/determinismo do merge. **Não decide**: identidade telefônica (congelada no ADR anterior), DDL, migrations, RPCs, APIs, rollout, *feature flags*, backfill operacional, janela de rollback. |
| **Baseline de código auditado** | `001` (schema de `conversations`, `messages`, `broadcast_recipients`), `004`, `006` (`automation_logs`, `automation_pending_executions`), `009` (`message_reactions`, `reply_to_message_id`), `010` (`flow_runs`), `017` (`conversations.account_id`), `022` (`merge_duplicate_contacts()`), `029` (UNIQUE `conversations(account_id, contact_id)`), `033` (`lead_attributions`), `034` (`dedupe_inbound_messages()`, UNIQUE parcial de inbound), `035` (RPCs idempotentes) |
| **Escopo de produção** | Somente documentação. Nenhuma linha de código, schema ou migration é produzida por este documento. |

---

## 1. Consolidação dos achados remanescentes (Fase 1)

Esta seção agrupa **apenas** os achados das três revisões independentes que **não** pertencem ao domínio de identidade (já resolvidos e congelados em `ADR-IDENTITY-BR-001`). Achados equivalentes entre revisores foram fundidos em uma única decisão. A matriz completa de rastreabilidade está em §12.

| # | Decisão arquitetural única | Levantada por |
|---|---|---|
| **M1** | A regra de sobrevivente nunca foi definida e existem duas regras divergentes em produção (`022` usa mais-antigo; `dedupe.ts` usa ordem arbitrária de retorno do banco) | DeepSeek B3 |
| **M2** | O merge de contatos colide com `UNIQUE(account_id, contact_id)` de `conversations`: duas conversas **têm** de virar uma, e o comportamento atual aborta a transação ou destrói a conversa perdedora por CASCADE | Nemotron B-4, Ling 4 |
| **M3** | A fusão de conversas colide com o índice único parcial de inbound de `034`, cujo próprio comentário declara que `conversation_id` é imutável e que "nenhum fluxo de merge existe" — premissa quebrada por construção | DeepSeek B1, Ling 15 |
| **M4** | "Nenhuma informação é perdida" é incompatível com "nenhuma linha é deletada": duplicatas técnicas **precisam** ser colapsadas. O conceito precisa ser reformulado em termos de eventos, não de linhas | DeepSeek B1 (invariante 5 × critério 4), Nemotron M-3 |
| **M5** | `merge_duplicate_contacts()` não trata `lead_attributions.contact_id` nem `contacts.first_attribution_id` (tabelas criadas em `033`, depois de `022`) — o merge atual destrói atribuição via `ON DELETE SET NULL` | Nemotron B-1, Nemotron I-5, Ling 5 |
| **M6** | O tratamento de `flow_runs` ativos em `022` (deixar o FK NULar a ligação) é perda de informação silenciosa; `automation_logs` e `automation_pending_executions` não constam de nenhum contrato | Nemotron M-2, Nemotron M-4, DeepSeek I5, Ling 7 |
| **M7** | A conversa perdedora carrega `unread_count`, `last_message_at`, `attribution_id`, `status` e `assigned_agent_id` sem regra de reconciliação definida | DeepSeek I4 |
| **M8** | `message_reactions` e `reply_to_message_id` precisam de consolidação explícita quando mensagens são movidas ou colapsadas | Ling 7 |
| **M9** | A atomicidade do merge era implícita; uma implementação em camada de aplicação não-transacional satisfaria o texto anterior | DeepSeek M2 |
| **M10** | O `phone` cru do contato sobrevivente pode ficar em formato diferente do perdedor, e o destino dos valores crus perdidos não estava definido | Ling 12 |
| **M11** | O baseline de contagem para validação é mal definido quando a granularidade muda (duas conversas viram uma) | Nemotron M-3 |

### 1.1 Achados novos desta auditoria (não levantados por nenhum revisor)

A auditoria de constraints conduzida para este ADR encontrou três vetores de perda de dados que **nenhuma das três revisões identificou**. São tratados como decisões de primeira classe:

| # | Achado | Evidência |
|---|---|---|
| **M12** | `lead_attributions.conversation_id` é `ON DELETE CASCADE`. Deletar a conversa perdedora **destrói a linha de atribuição inteira** — consequência estritamente pior que o `SET NULL` de `contact_id` apontado pela Nemotron B-1 | `033:43` |
| **M13** | `message_reactions.conversation_id` é coluna própria com CASCADE de `conversations`. Mover mensagens para a conversa sobrevivente **sem** re-apontar essa coluna faz as reações serem destruídas quando a conversa perdedora é removida | `009` (definição da tabela) |
| **M14** | `flow_runs.last_prompt_message_id` é `ON DELETE SET NULL`, e o `dedupe_inbound_messages()` de `034` **não** o re-aponta. Colapsar mensagens duplicadas hoje perde silenciosamente essa ligação | `010` (definição) × `034:44-199` (ausência) |

---

## 2. Regra de Seleção de Sobrevivente (Fase 2)

### 2.1 Duas classes de objeto, duas regras — princípio explícito

Um contrato de merge determinístico exige uma regra de sobrevivente por classe de objeto, não uma regra global aplicada cegamente. Este documento reconhece **exatamente duas classes**, e nenhuma outra:

| Classe | Semântica | Regra | Justificativa |
|---|---|---|---|
| **Classe H — Âncora histórica** | O objeto **é** o registro de que algo aconteceu. Sua identidade é o próprio fato de ter sido criado primeiro. | **Mais antigo vence** | Preservar o registro original. Consistente com `022` (`created_at ASC, id ASC`) e com `034` (mesma ordenação) — este ADR adota a regra que o sistema já usa, em vez de introduzir uma terceira. |
| **Classe R — Estado de runtime** | O objeto **é** o estado corrente de um processo vivo. Seu valor é ser atual, não ser original. | **Mais recente vence** | Preservar o estado vivo. Escolher o mais antigo terminaria o processo que o cliente está executando agora em favor de um processo parado — regressão observável de produto, não meramente uma escolha estética. |

**Membros da Classe H (lista fechada):** `contacts`, `conversations`, `messages`, `message_reactions`.
**Membros da Classe R (lista fechada):** `flow_runs` com `status = 'active'`.

Nenhuma outra tabela seleciona sobrevivente por linha — todas as demais são **re-apontadas integralmente** (§3.4) ou colapsadas por regra de constraint específica (§3.5), sem eleição de sobrevivente.

> A existência de duas classes não é uma exceção à determinismo: **ambas** as regras são totais, determinísticas e livres de ordem. A classe de cada tabela está fixada acima e não é decidível pela implementação.

### 2.2 Regra da Classe H — formal

Dado um conjunto não-vazio `S` de linhas candidatas da mesma classe H, o sobrevivente é o elemento mínimo sob a ordem lexicográfica total:

```
ORDEM_H = (created_at ASC, id ASC)
```

- `created_at` é o carimbo de criação da própria linha, nunca modificado por este ou por qualquer merge (§10, I4).
- `id` é o UUID da linha, comparado como **string, ordem lexicográfica ascendente**. A representação textual canônica de UUID (minúsculas, com hífens, 36 caracteres) é fixada aqui como a forma de comparação, para que duas implementações não divirjam ao comparar UUID como bytes vs. como texto.

`ORDEM_H` é uma ordem **total** sobre qualquer conjunto de linhas: `id` é único por construção (chave primária), logo o empate nunca sobrevive ao segundo critério. **Não existe cenário em que o desempate falhe.**

### 2.3 Regra da Classe R — formal

Dado um conjunto não-vazio `S` de `flow_runs` com `status = 'active'` disputando a mesma chave `(user_id, contact_id)`, o sobrevivente é o elemento mínimo sob:

```
ORDEM_R = (last_advanced_at DESC, id ASC)
```

Também total, pelo mesmo argumento (`id` único). Os não-sobreviventes **não são deletados** — são transicionados para estado terminal preservando toda a sua ligação (§7.2).

### 2.4 Determinismo, estabilidade e reexecução

| Propriedade | Garantia |
|---|---|
| **Determinismo** | Ambas as ordens são totais e computadas apenas sobre colunas imutáveis (`created_at`, `id`) ou sobre uma coluna cujo valor é lido uma única vez no início da transação (`last_advanced_at`). Nenhuma depende de ordem de varredura, plano de query, ordem de inserção, locale ou relógio. |
| **Estabilidade** | O merge **nunca modifica** `created_at`, `id` ou `started_at` de nenhuma linha (§10, I4). Logo a eleição de sobrevivente sobre o mesmo conjunto de candidatos produz sempre o mesmo resultado, em qualquer instante. |
| **Estabilidade sob crescimento** | Se novas duplicatas surgirem depois, o sobrevivente eleito anteriormente continua sendo o mínimo do novo conjunto sob `ORDEM_H` — porque qualquer linha criada depois tem `created_at` maior. O sobrevivente de um merge **nunca deixa de ser sobrevivente** por causa de um merge futuro. Esta propriedade é o que torna o merge composicional. |
| **Reexecução** | Após um merge, o grupo tem exatamente um membro. Um conjunto unitário sob qualquer ordem total elege esse próprio membro. Logo a reexecução não muda nada (§9). |

### 2.5 Definição do grupo de merge

Um **grupo de merge** é o conjunto de linhas de `contacts` que satisfazem simultaneamente:

1. mesmo `account_id`;
2. mesmo valor de `identity(phone)`, conforme `ADR-IDENTITY-BR-001` §6.6 — invocado, não reinterpretado;
3. `identity(phone)` é não-vazio.

Contatos cujo `identity(phone)` é vazio **nunca** participam de nenhum grupo e nunca são fundidos (preserva o comportamento de `022`, que exclui `phone_normalized = ''`).

Grupos com um único membro são no-op. Grupos com ≥2 membros são **grupos de merge ativos** e sofrem o processamento de §3–§7.

**Os grupos particionam o conjunto de contatos** — cada contato pertence a exatamente um grupo, pois `(account_id, identity(phone))` é uma função total do contato. Essa disjunção é o alicerce da independência de ordem (§9.3).

---

## 3. Contact Merge (Fase 3)

Seja `G` um grupo de merge ativo, `s` seu sobrevivente por `ORDEM_H`, e `L = G \ {s}` o conjunto de perdedores.

### 3.1 Precedência de campos escalares

Para cada campo escalar de `contacts` que não seja `id`, `account_id`, `created_at`, `phone`, `phone_normalized` ou `first_attribution_id`:

> **Regra de preenchimento por lacuna (fill-gap):** o valor do sobrevivente prevalece sempre que for **presente**. Quando o valor do sobrevivente é **ausente**, ele recebe o valor do primeiro perdedor, sob `ORDEM_H`, cujo valor seja presente. Se nenhum perdedor tiver valor presente, o campo permanece ausente.

**"Ausente"** é definido de forma fechada, para não deixar interpretação: `NULL`, ou string vazia, ou string composta exclusivamente de espaços em branco. Qualquer outro valor é **presente**. Esta definição vale para todo o documento.

Justificativa: a regra maximiza retenção de informação (um contato duplicado frequentemente tem o nome preenchido em uma linha e o e-mail em outra) sem jamais sobrescrever um dado que o sobrevivente já possuía. É determinística porque `ORDEM_H` é total.

### 3.2 Campos com regra própria

| Campo | Regra | Justificativa |
|---|---|---|
| `phone` (cru) | **Imutável.** O sobrevivente mantém seu próprio valor cru, verbatim. | `ADR-IDENTITY-BR-001` §4 mantém a coluna crua fora de escopo; a identidade é computada, não armazenada, logo reescrever o cru não traria benefício de identidade e destruiria o valor exato que o provider entregou. Resolve Ling 12. |
| `phone_normalized` | Derivado pelo banco; não é escrito por ninguém. | É coluna gerada (`022`). |
| `first_attribution_id` | Regra própria — ver §6.3. | É first-touch da **pessoa**, não da linha; exige união sobre o grupo. |
| `created_at` | **Imutável.** | Invariante I4 (§10). Alterá-lo quebraria a estabilidade do sobrevivente (§2.4). |

### 3.3 Preservação dos valores crus dos perdedores

Os valores de `phone` cru de **todos** os membros de `L` são **informação** (§8.2) e não podem desaparecer. Antes da remoção de qualquer perdedor, o merge **deve** registrar, de forma durável e consultável, a proveniência do merge contendo, no mínimo:

- o `id` do sobrevivente;
- o `id` e o `phone` cru de cada perdedor;
- o valor de `identity(phone)` que agrupou o conjunto;
- o instante do merge.

Este ADR decide que esse registro **é obrigatório** e qual é seu conteúdo mínimo. **Onde** ele é materializado (tabela, coluna, formato) é DDL — explicitamente fora de escopo (cabeçalho) e propriedade do HOTFIX derivado. A obrigação não é delegável: uma implementação que remove perdedores sem registrar proveniência viola I2 (§10) e falha o critério de aceite A6 (§11).

### 3.4 Tabelas re-apontadas integralmente (sem colisão possível)

As tabelas abaixo referenciam `contact_id` **sem** qualquer constraint de unicidade que envolva `contact_id`. Toda linha pertencente a qualquer perdedor é re-apontada ao sobrevivente. Nenhuma linha é deletada, nenhuma colisão é possível, nenhuma eleição de sobrevivente ocorre.

`conversations` · `contact_notes` · `deals` · `broadcast_recipients` · `automation_logs` · `automation_pending_executions` · `lead_attributions` · `flow_runs`

Observações vinculantes:

- **`conversations` é re-apontada primeiro**, e imediatamente submetida à fusão de §4, porque o re-apontamento sozinho colide com `UNIQUE(account_id, contact_id)` (`029`). O re-apontamento e a fusão são **uma única operação lógica indivisível**, não dois passos observáveis (§9.2).
- **`broadcast_recipients.contact_id` é `NOT NULL` sem `ON DELETE` de anulação** (`001`). Re-apontar não é otimização: é condição necessária para que a remoção do perdedor seja sequer possível. Uma implementação que pule este passo falha por erro de integridade referencial, não silenciosamente.
- **`flow_runs`** é re-apontada integralmente aqui — inclusive os runs ativos, contrariando `022`, que os excluía deliberadamente. O tratamento da colisão de runs ativos é §7.2, e ocorre **depois** do re-apontamento, não por omissão dele.

### 3.5 Tabelas com colisão de unicidade por contato

| Tabela | Constraint | Resolução |
|---|---|---|
| `contact_tags` | `UNIQUE(contact_id, tag_id)` | Para cada `tag_id` presente em qualquer membro de `G`: se o sobrevivente já possui a tag, as linhas dos perdedores para essa tag são colapsadas (removidas); caso contrário, a linha do primeiro perdedor sob `ORDEM_H` é re-apontada e as demais colapsadas. **Resultado: o sobrevivente termina com a união dos `tag_id` do grupo, exatamente uma linha por tag.** |
| `contact_custom_values` | `UNIQUE(contact_id, custom_field_id)` | Idêntica em forma: união por `custom_field_id`, uma linha por campo. O valor do sobrevivente prevalece quando **presente**; quando ausente, prevalece o do primeiro perdedor sob `ORDEM_H` com valor presente — mesma regra fill-gap de §3.1, aplicada por campo customizado. |

Ambos os colapsos são permitidos por §8.3 porque as linhas removidas denotam a **mesma associação lógica** (mesma tag / mesmo campo, mesma pessoa) — são duplicatas técnicas criadas pela duplicação do contato, não fatos distintos.

### 3.6 Remoção dos perdedores

Somente após §3.1–§3.5, §4, §5, §6 e §7 terem sido integralmente aplicados, as linhas de `L` são removidas de `contacts`. Nesse instante, **nenhuma** linha em nenhuma tabela referencia qualquer membro de `L` — logo nenhum `ON DELETE CASCADE` e nenhum `ON DELETE SET NULL` dispara sobre dado vivo. Esta ordenação não é otimização: é o que torna I2 (§10) verdadeira.

---

## 4. Conversation Merge (Fase 4)

### 4.1 Quando duas conversas viram uma

`UNIQUE(account_id, contact_id)` (`029`) admite **no máximo uma** conversa por par conta/contato. Portanto: sempre que dois ou mais membros de `G` possuírem conversas na mesma conta, essas conversas **obrigatoriamente** se fundem em uma. Não é escolha de design — é consequência de constraint. Resolve M2 / Nemotron B-4 / Ling 4.

Seja `C` o conjunto das conversas de todos os membros de `G` em uma dada conta. Se `|C| ≤ 1`, não há fusão (apenas o re-apontamento de §3.4). Se `|C| ≥ 2`, aplica-se §4.2–§4.4.

### 4.2 Qual conversa sobrevive

A conversa sobrevivente `c_s` é o mínimo de `C` sob `ORDEM_H` (Classe H — a conversa é a âncora histórica da thread). As demais, `C_L = C \ {c_s}`, são conversas perdedoras.

### 4.3 Reconciliação de campos (resolve M7 / DeepSeek I4)

| Campo | Regra | Justificativa |
|---|---|---|
| `status` | `'open'` se **qualquer** membro de `C` é `'open'`; senão `'pending'` se qualquer é `'pending'`; senão `'closed'`. | Ordem de precedência total e fail-safe rumo à visibilidade: uma thread que estava aberta em algum lugar nunca é silenciosamente fechada pelo merge. |
| `assigned_agent_id` | Regra fill-gap de §3.1 aplicada sobre `C` sob `ORDEM_H`. | Consistência com contatos; nunca desatribui quem já estava atribuído. |
| `last_message_at` | **Derivado**: o maior `created_at` entre as mensagens da conversa fundida (após §5). Se a conversa fundida não tiver nenhuma mensagem, o maior `last_message_at` armazenado em `C`, tratando ausente como menor que qualquer valor. | Derivar da realidade elimina divergência entre o contador e os dados. |
| `last_message_text` | **Derivado**: o `content_text` da mensagem de maior `(created_at, id)` da conversa fundida. Se não houver mensagens, o valor de `c_s`. | Consistente com `last_message_at` por construção — impossível ficarem dessincronizados. |
| `attribution_id` | Regra fill-gap de §3.1 sobre `C` sob `ORDEM_H`, **após** a preservação obrigatória de §6.2. | Ver §6.2: a atribuição da conversa perdedora nunca é destruída, independentemente de qual ponteiro sobrevive. |
| `unread_count` | Regra própria — §4.4. | Contador não reconstruível; exige decisão explícita. |
| `created_at` | **Imutável** (é o de `c_s`). | I4. |
| `user_id`, `account_id`, `contact_id` | `account_id` inalterado; `contact_id` passa a ser `s`; `user_id` é o de `c_s`. | — |

### 4.4 `unread_count` — decisão e justificativa

**Constatação factual (verificada no schema):** não existe marcador de leitura por mensagem para mensagens de entrada. `messages` não possui `read_at` nem equivalente; a única coluna `read_at` do schema pertence a `broadcast_recipients` (`001`). `unread_count` é um contador denormalizado, incrementado em +1 pelo webhook a cada inbound e zerado quando o agente abre a thread. **Logo `unread_count` é matematicamente não reconstruível a partir das mensagens** — qualquer regra que se apresente como "recalcular" seria uma invenção, não uma derivação.

**Decisão:**

```
unread_count(c_s) = min( Σ unread_count(c) para c ∈ C ,  N_inbound )
```

onde `N_inbound` é a quantidade de mensagens com `sender_type = 'customer'` presentes na conversa fundida **após** o colapso de duplicatas de §5.

- A **soma** preserva todo sinal genuíno de não-lido: nenhuma notificação legítima desaparece.
- O **teto em `N_inbound`** corrige a superestimativa causada pelo colapso de duplicatas — que é exatamente o cenário deste merge, em que a mesma mensagem externa foi contada em duas conversas. O contador nunca pode alegar mais não-lidas do que existem mensagens.
- O **piso é 0** por construção (soma de não-negativos, teto não-negativo).

A decisão é determinística (soma e mínimo são livres de ordem), idempotente (§9.1) e explicitamente reconhecida como **aproximação de um contador não reconstruível** — não como derivação exata, que o schema não permite. Registrar essa limitação aqui impede que uma implementação futura a "conserte" silenciosamente.

### 4.5 Consolidação dos dependentes da conversa

Antes de qualquer conversa de `C_L` ser removida, e nesta ordem lógica:

1. **`messages`** — todas as mensagens de cada `c ∈ C_L` passam a pertencer a `c_s` (§5).
2. **`message_reactions`** — a coluna `conversation_id` de toda reação pertencente às mensagens movidas passa a apontar para `c_s`. **Obrigatório** (M13): a tabela tem `conversation_id` próprio com CASCADE de `conversations`; omitir este passo destrói as reações na remoção da conversa perdedora.
3. **`lead_attributions`** — toda atribuição com `conversation_id ∈ C_L` é re-apontada para `c_s`. **Obrigatório e crítico** (M12): o FK é `ON DELETE CASCADE`; omitir este passo **apaga a linha de atribuição inteira**, não apenas a ligação.
4. **`flow_runs`** — toda linha com `conversation_id ∈ C_L` é re-apontada para `c_s`. O FK é `ON DELETE SET NULL`; omitir perde a ligação.

Somente após 1–4, as conversas de `C_L` são removidas. Nesse instante nenhuma linha as referencia, logo nenhum CASCADE atinge dado vivo.

### 4.6 Preservação cronológica

Nenhum `created_at` de mensagem é alterado ao mover mensagens entre conversas (I4). A ordem cronológica da conversa fundida é a ordenação por `(created_at, id)` do conjunto unido. O entrelaçamento resultante de duas threads **é** a cronologia verdadeira dos eventos daquela pessoa — não é um artefato do merge, é a correção do artefato que a duplicação havia criado.

---

## 5. Message Merge (Fase 5)

### 5.1 O que colide, e o que não colide

`034` impõe unicidade parcial em `(conversation_id, message_id)` **restrita** a `sender_type = 'customer'` e a `message_id` não-nulo e não-vazio. Consequências, decididas explicitamente:

| Categoria | Colide? | Decisão |
|---|---|---|
| Inbound (`customer`) com `message_id` presente | **Sim** | Colapso determinístico — §5.2 |
| Inbound com `message_id` nulo ou vazio | Não (excluído do índice) | **Preservada verbatim, nunca colapsada.** Sem chave de identidade externa, não há como afirmar que duas linhas denotam o mesmo evento; §8.3 proíbe colapsar sob incerteza. |
| Outbound (`agent` / `bot`), qualquer `message_id` | Não (fora do predicado do índice) | **Preservada verbatim, nunca colapsada.** Ver §5.6. |

### 5.2 Colisão de `message_id` — regra de colapso

Após as mensagens serem movidas para `c_s` (§4.5.1), forma-se, para cada valor de `message_id`, um **grupo de colapso** com as mensagens `sender_type = 'customer'` daquele `message_id` em `c_s`. Grupos com um membro são no-op.

Em cada grupo, o **guardião** (*keeper*) é o mínimo sob `ORDEM_H` — `(created_at ASC, id ASC)`. Esta é **literalmente** a mesma regra que `dedupe_inbound_messages()` de `034` já aplica. A escolha de reusar a semântica existente em vez de introduzir uma nova é deliberada e resolve DeepSeek B1: o sistema passa a ter **uma** regra de colapso de inbound, não duas.

### 5.3 Consolidação obrigatória antes da remoção

Para cada mensagem não-guardiã `d` de um grupo de colapso, e **antes** de `d` ser removida:

| Dependente | Ação | Constraint / risco |
|---|---|---|
| `message_reactions` de `d` | Re-apontar ao guardião, resolvendo `UNIQUE(message_id, actor_type, actor_id)` por §5.4 | CASCADE de `messages` destruiria as reações |
| `messages.reply_to_message_id` apontando para `d` | Re-apontar ao guardião | FK `ON DELETE SET NULL` — a cadeia de resposta seria rompida |
| `flow_runs.last_prompt_message_id` apontando para `d` | Re-apontar ao guardião | **M14** — FK `ON DELETE SET NULL`; `034` **não** trata isto hoje. Lacuna fechada por este ADR. |

Nenhuma outra tabela referencia `messages.id`. `lead_attributions.origin_message_id` é `TEXT` contendo o identificador externo (wamid), **não** um FK para `messages.id` (`033:56`) — logo o colapso de linhas de mensagem não o afeta de forma alguma.

### 5.4 Reactions — regra de vencedor

Para cada tripla `(guardião, actor_type, actor_id)`, o conjunto de reações candidatas é a união das reações de todo o grupo de colapso para aquele ator. A reação vencedora é o mínimo sob:

```
ORDEM_REACTION = (está_no_guardião DESC, created_at ASC, id ASC)
```

isto é: prefere-se a reação que já pertencia ao guardião; na ausência dela, a mais antiga; empate final pelo `id`. Esta é, novamente, **exatamente** a regra que `034` já implementa — reusada, não reinventada.

As reações perdedoras são removidas. Isto é colapso permitido por §8.3: a constraint `UNIQUE(message_id, actor_type, actor_id)` já declara, no modelo de dados vigente, que **um ator possui no máximo uma reação por mensagem**. Duas linhas do mesmo ator para a mesma mensagem lógica são, por definição do modelo, a mesma reação registrada duas vezes — não duas opiniões distintas.

### 5.5 Redelivery e duplicate inbound

- **Redelivery pós-merge:** uma reentrega do mesmo webhook após o merge encontra o índice único parcial de `034` sobre a conversa fundida e resulta em zero linhas inseridas, exatamente como antes do merge. O merge **não** altera o caminho de idempotência de inbound; apenas garante que, após ele, exista **uma** conversa onde antes havia duas — o que na verdade **fortalece** a idempotência, porque elimina a segunda conversa onde a mesma mensagem podia legitimamente reentrar.
- **Duplicate inbound pré-existente** (a duplicata que o merge encontra ao fundir duas conversas) é resolvida por §5.2.
- **Premissa de `034` explicitamente revogada:** o comentário de `034:12-15` declara que `conversation_id` é imutável por mensagem e que "nenhum fluxo de reatribuição/merge existe". Este ADR **cria** esse fluxo. A premissa deixa de valer a partir da aprovação deste documento, e a chave de idempotência `(conversation_id, message_id)` permanece correta **porque** o merge reconcilia o conjunto de mensagens antes de a constraint ser reavaliada — nunca deixando duas linhas colidentes visíveis (§9.2, atomicidade). Resolve M3 / DeepSeek B1 / Ling 15.

### 5.6 Outbound — decisão de fronteira

Mensagens outbound (`agent`, `bot`) **nunca** são colapsadas por este ADR, mesmo que duas linhas compartilhem `message_id` na conversa fundida.

Justificativa: a identidade de mensagens de saída é governada por contratos já congelados do eixo de entrega (`EIS-001`, `ODI-001`), que definem identidade externa e integridade de saída fora do escopo deste documento. Colapsar outbound aqui exigiria decidir o que é "a mesma mensagem de saída" — decisão que pertence àqueles contratos, não a este. Preservar verbatim é a única ação que **não** invade autoridade alheia e **não** perde informação. Esta é uma fronteira deliberada, não uma omissão.

### 5.7 Ordering e timestamps

`created_at`, `message_id`, `content_text`, `media_url`, `content_type`, `sender_type`, `sender_id`, `status` e `template_name` de toda mensagem preservada são **imutáveis** durante o merge. A única coluna de `messages` que o merge escreve é `conversation_id` (re-apontamento) e `reply_to_message_id` (§5.3). Anexos são referenciados por `media_url`, coluna imutável — logo nenhum anexo pode ser perdido ou reassociado.

---

## 6. Lead Attribution Merge (Fase 6)

### 6.1 Prova de que não existe colisão em `lead_attributions`

`033:103-105` define unicidade em `origin_message_id` isoladamente (parcial, onde não-nulo) — **globalmente**, sem escopo de conta. As colunas que o merge escreve nesta tabela são `contact_id` e `conversation_id`. **Nenhuma delas participa de qualquer índice único.**

Portanto: re-apontar `contact_id` ou `conversation_id` de qualquer linha de `lead_attributions` **não pode, em nenhuma circunstância, violar unicidade**. A preocupação de Ling 5 (colisão de `origin_message_id` ao re-apontar) está formalmente resolvida: `origin_message_id` não é tocado pelo merge, e duas linhas distintas ou têm valores distintos (garantido pelo índice) ou têm `NULL` (que o índice não restringe). **Nenhuma regra de resolução de conflito é necessária, porque nenhum conflito é possível.**

### 6.2 Preservação absoluta das linhas de atribuição

> **Nenhuma linha de `lead_attributions` é jamais removida por um merge.** A contagem de linhas desta tabela antes e depois de qualquer merge é **idêntica**. Esta é a formulação mais forte de preservação do documento e é diretamente verificável (critério A5, §11).

Isto exige, obrigatoriamente:

1. Toda atribuição com `contact_id` em `L` é re-apontada para `s` **antes** da remoção dos perdedores (senão `ON DELETE SET NULL` de `033:42` anula a ligação — Nemotron B-1).
2. Toda atribuição com `conversation_id` em `C_L` é re-apontada para `c_s` **antes** da remoção das conversas perdedoras (senão `ON DELETE CASCADE` de `033:43` **destrói a linha** — M12, achado desta auditoria).

O histórico multi-toque é integralmente preservado: se a pessoa entrou por três anúncios diferentes ao longo do tempo, as três linhas continuam existindo após o merge, todas apontando para o contato sobrevivente e para a conversa sobrevivente.

### 6.3 `first_attribution_id` — preservação do first-touch

`033:17-20` estabelece que `contacts.first_attribution_id` é o first-touch, escrito uma vez e nunca sobrescrito. Sob duplicação de contatos, cada linha duplicada pode ter capturado um first-touch diferente — e o first-touch **da pessoa** é o mais antigo entre eles.

**Decisão:**

```
first_attribution_id(s) = argmin sob (created_at ASC, id ASC) do conjunto A
```

onde `A` é a união de:
- os valores de `first_attribution_id` de **todos** os membros de `G` que sejam não-nulos; e
- todas as linhas de `lead_attributions` cujo `contact_id` seja, após §6.2, igual a `s`.

Se `A` é vazio, `first_attribution_id(s)` permanece `NULL`.

Propriedades:
- **Preserva o first-touch verdadeiro:** o resultado é a atribuição cronologicamente mais antiga conhecida da pessoa, que é precisamente a definição de first-touch.
- **Nunca regride para `NULL`:** se qualquer membro de `G` tinha um first-touch, `A` é não-vazio, logo o sobrevivente tem um. Resolve Nemotron I-5 e a metade de B-1 referente a `first_attribution_id`.
- **Determinístico e livre de ordem:** `argmin` sobre um conjunto, sob ordem total.
- **Idempotente:** reexecutar sobre o grupo unitário resultante reavalia `A` (agora composto do first-touch do sobrevivente e das atribuições já ligadas a ele) e reelege o mesmo mínimo.

`first_source_channel` (`033:119`) acompanha `first_attribution_id`: recebe o `source_channel` da atribuição eleita, mantendo os dois campos coerentes por construção. Deixá-los divergir seria admitir um estado inconsistente que nenhum consumidor saberia interpretar.

---

## 7. Flow & Automation Merge (Fase 7)

### 7.1 Tabelas sem colisão

`automation_logs`, `automation_pending_executions` e `flow_runs` não-ativos não possuem constraint de unicidade envolvendo `contact_id`. São re-apontados integralmente ao sobrevivente (§3.4). **Nenhuma linha é removida, nenhum estado é alterado.** Resolve Nemotron M-2 e M-4, e a parte de `flow_runs` de DeepSeek I5 / Ling 7.

`automation_pending_executions` merece nota explícita: são execuções **futuras agendadas**. Re-apontá-las (em vez de anulá-las, como o `ON DELETE SET NULL` de `006` faria) garante que uma automação agendada para a pessoa continue disparando para a pessoa após o merge. Anulá-las seria perda de informação de um efeito ainda não ocorrido.

### 7.2 `flow_runs` ativos — a única colisão

`010:189-191` impõe `UNIQUE(user_id, contact_id)` restrito a `status = 'active'`. Após o re-apontamento de §3.4, dois ou mais runs ativos podem disputar a mesma chave.

**Decisão (Classe R, §2.3):** sobrevive como ativo o run com maior `last_advanced_at`, desempate por `id` ascendente.

**Justificativa arquitetural:** um run ativo representa o estado corrente de uma conversa automatizada aguardando resposta do cliente. Aplicar "mais antigo vence" terminaria o fluxo que o cliente está respondendo **agora** em favor de um fluxo parado — regressão de produto observável. Para estado de runtime, "mais recente" **é** a semântica correta de preservação; para âncoras históricas, "mais antigo" é. Ambas as regras são igualmente determinísticas; a distinção entre as classes está fixada em §2.1 e não é decidível pela implementação.

**Tratamento dos runs ativos não-sobreviventes:**

1. **Não são deletados.** Nenhuma linha de `flow_runs` é removida por um merge.
2. **Mantêm `contact_id` apontando para o sobrevivente.** A ligação com a pessoa é preservada — corrigindo diretamente o comportamento de `022:93-99`, que deixava o FK anular a ligação e perdia a informação de a quem o run pertencia (M6).
3. **São transicionados para um estado terminal distinguível.** O estado terminal atribuído **deve** ser distinguível de toda terminação natural (`completed`, `handed_off`, `timed_out`, `paused_by_agent`, `failed`), de modo que uma auditoria futura possa identificar que o run terminou por consolidação de identidade e não por comportamento do cliente ou do sistema.
4. **`ended_at` recebe o instante do merge; `end_reason` registra a proveniência**, incluindo o `id` do run que sobreviveu como ativo.

O **token concreto** desse estado terminal e qualquer ajuste no conjunto de valores admissíveis de `status` são **materialização** — DDL, fora de escopo deste ADR (cabeçalho) e propriedade do HOTFIX derivado. O que este ADR decide, e que não é delegável, é: (a) o run não é deletado; (b) mantém a ligação com o contato sobrevivente; (c) termina em estado terminal; (d) esse estado é distinguível de terminação natural. Uma implementação que reutilize `failed` ou `timed_out` viola (d) e falha o critério A8 (§11).

---

## 8. Conceito Formal de Não Perda (Fase 8)

A expressão "nenhuma informação é perdida" é ambígua e, na formulação original do HOTFIX, **autocontraditória** — porque exigia simultaneamente que nenhuma linha fosse deletada e que constraints de unicidade fossem respeitadas, o que é impossível quando duas linhas colidem (DeepSeek B1). Esta seção substitui a formulação por uma definição operacional.

### 8.1 Definição de informação

**Informação** é o par ordenado composto por:

1. **Fato observável** — o registro de um evento ou estado que existiu no mundo: o conteúdo e o instante de uma mensagem, uma atribuição de lead, uma nota, um negócio, uma tag, um valor customizado, um destinatário de broadcast, uma execução de automação ou fluxo, uma reação.
2. **Vínculo** — a associação entre esse fato e a pessoa e a thread a que ele pertence.

Perder o vínculo é perder informação **mesmo que a linha sobreviva**. Uma atribuição de lead com `contact_id` anulado é perda de informação, ainda que a linha exista. Esta é a razão pela qual §3.6, §4.5 e §6.2 impõem ordenação obrigatória de operações: elas existem para proteger o vínculo, não a linha.

### 8.2 O que nunca pode desaparecer

| Categoria | Garantia |
|---|---|
| Qualquer linha que denote um evento externo distinto | Preservada. Duas mensagens com `message_id` distinto são dois eventos, sempre. |
| Toda linha de `lead_attributions` | Preservada — contagem idêntica antes/depois (§6.2). |
| Todo registro histórico de auditoria (`automation_logs`, `flow_runs` de qualquer status, `broadcast_recipients`) | Preservado, com vínculo re-apontado ao sobrevivente. |
| Todo `created_at` de toda linha sobrevivente | Imutável. |
| O `phone` cru de **todos** os contatos do grupo, inclusive perdedores | Preservado via proveniência obrigatória (§3.3). |
| O vínculo de toda linha que tinha vínculo antes do merge | Preservado. Nada que apontava para algo passa a apontar para nada. |

### 8.3 O que pode desaparecer — condições fechadas

Uma linha pode ser removida por um merge **se e somente se as três condições valerem simultaneamente**:

1. **Existe constraint:** uma restrição de unicidade vigente no schema seria violada caso ambas as linhas coexistissem após a consolidação;
2. **Mesma denotação:** as duas linhas denotam o **mesmo** fato do mundo — o mesmo evento externo (mesmo `message_id` na mesma thread), a mesma associação (mesma tag, mesmo campo customizado) ou a mesma reação do mesmo ator sobre a mesma mensagem lógica;
3. **Regra determinística nomeada:** este documento nomeia explicitamente qual linha sobrevive (`ORDEM_H`, `ORDEM_REACTION`, ou as regras de §3.5).

Se **qualquer** das três falhar, a linha **não** pode ser removida. Em particular, ausência de chave de identidade externa (`message_id` nulo ou vazio) faz a condição 2 falhar por indecidibilidade — e a linha é preservada (§5.1). O documento resolve incerteza sempre a favor da preservação, herdando o mesmo princípio fail-safe de `ADR-IDENTITY-BR-001` §9.

Chamamos as linhas removidas sob essas três condições de **duplicatas técnicas**. Uma duplicata técnica não é informação: é a mesma informação materializada duas vezes por um defeito que este merge existe para corrigir.

### 8.4 O que pode mudar de valor

Exatamente dois campos são **redefinidos** (não preservados) pelo merge, e ambos são contadores/derivados denormalizados, nunca fatos:

- `unread_count` — redefinido por §4.4, com justificativa de não reconstrutibilidade.
- `last_message_at` / `last_message_text` — redefinidos por derivação a partir das mensagens reais (§4.3).

Nenhum outro campo de nenhuma tabela muda de valor por efeito do merge, exceto colunas de vínculo (`contact_id`, `conversation_id`, `message_id` de reações, `reply_to_message_id`, `last_prompt_message_id`), os campos preenchidos por fill-gap sobre lacunas (§3.1, §4.3), `first_attribution_id`/`first_source_channel` (§6.3) e o estado terminal dos runs ativos não-sobreviventes (§7.2).

### 8.5 Métrica de não perda (resolve M11 / Nemotron M-3)

Contagem de linhas **não** é a métrica de não perda, porque o merge legitimamente reduz linhas (duplicatas técnicas) e legitimamente reduz conversas (duas viram uma). A métrica correta é a **contagem de eventos distintos**, invariante por construção:

| Métrica | Definição | Comportamento esperado |
|---|---|---|
| `E_inbound` | Número de pares distintos `(contato-sobrevivente, message_id)` entre mensagens `sender_type='customer'` com `message_id` presente | **Idêntico** antes e depois |
| `E_inbound_sem_id` | Número de mensagens `sender_type='customer'` com `message_id` ausente | **Idêntico** antes e depois |
| `E_outbound` | Número de mensagens `sender_type IN ('agent','bot')` | **Idêntico** antes e depois |
| `E_attr` | Número de linhas de `lead_attributions` | **Idêntico** antes e depois |
| `E_hist` | Número de linhas de `automation_logs` + `flow_runs` + `broadcast_recipients` + `contact_notes` + `deals` | **Idêntico** antes e depois |
| `E_assoc` | Número de pares distintos `(contato-sobrevivente, tag_id)` e `(contato-sobrevivente, custom_field_id)` | **Idêntico** antes e depois |

Todas são computáveis mecanicamente sobre um dump anterior e um posterior. Nenhuma depende de julgamento.

---

## 9. Idempotência, Atomicidade e Independência de Ordem (Fase 9)

### 9.1 Idempotência

Seja `M` a função de merge que leva um estado de banco a outro. Exige-se:

```
M(M(x)) = M(x)   para todo estado x
```

e, por indução imediata, `Mⁿ(x) = M(x)` para todo `n ≥ 1`. Executar o merge uma vez ou cem vezes produz o mesmo banco.

**Demonstração**, por construção:

1. Após `M(x)`, todo grupo de merge (§2.5) tem exatamente um membro, porque o merge remove todos os perdedores e **não altera o `phone` cru de ninguém** (§3.2) — logo `identity()` de cada contato sobrevivente é inalterada e nenhum grupo novo pode se formar.
2. Um grupo unitário não é grupo de merge ativo (§2.5), logo o driver não o processa. Todas as operações de §3–§7 são vacuamente no-op.
3. As regras que **computam valores** (fill-gap, `argmin` de first-touch, soma com teto de `unread_count`, máximos de `last_message_*`) são funções de agregação sobre um **conjunto**. Aplicadas a um conjunto unitário, retornam o valor daquele único elemento — que é exatamente o valor já gravado pela primeira execução. Nenhuma delas é um *fold* sequencial acumulativo, que seria o único caso capaz de divergir sob reexecução.
4. O merge nunca cria linhas novas em nenhuma tabela de domínio, logo não pode gerar material para um grupo futuro.

Portanto `M(M(x)) = M(x)`. ∎

> Nota sobre `unread_count`: é o único campo cuja regra envolve **soma**, que seria não-idempotente se reaplicada ao mesmo conjunto de conversas. Ela é segura porque, após o merge, o conjunto `C` é unitário — a soma degenera no próprio valor, e o teto `N_inbound` já está satisfeito. Esta é a razão de a regra ser "soma com teto" e não "soma" pura.

### 9.2 Atomicidade (resolve M9 / DeepSeek M2)

Um merge de um grupo `G` é uma **transação única**. Não existe estado intermediário observável por qualquer leitor, e não existe falha parcial: ou todo o grupo está consolidado, ou nada mudou.

Esta exigência é normativa e não é uma preferência de implementação. Ela é o que torna verdadeiras:

- a revogação da premissa de `034` (§5.5) — a constraint de unicidade nunca "vê" duas linhas colidentes, porque a reconciliação e o re-apontamento ocorrem na mesma transação;
- a proteção contra CASCADE (§3.6, §4.5, §6.2) — a ordenação obrigatória de operações só tem significado dentro de uma fronteira transacional;
- a idempotência (§9.1) — uma execução parcialmente aplicada produziria um estado que não é nem `x` nem `M(x)`, quebrando a demonstração.

Uma implementação que consolide um grupo em múltiplas transações independentes **não satisfaz este contrato**, ainda que produza o mesmo estado final no caminho feliz.

### 9.3 Independência de ordem

Exige-se que o estado final seja idêntico independentemente de: a ordem em que os grupos são processados; a ordem em que as linhas são retornadas por qualquer varredura; a ordem física de inserção das linhas.

**Demonstração:**

1. **Entre grupos:** os grupos particionam `contacts` por `(account_id, identity(phone))` (§2.5). Grupos distintos não compartilham nenhuma linha de `contacts`, e portanto — como toda tabela consolidada é alcançada exclusivamente por `contact_id` ou por `conversation_id` de uma conversa de um contato do grupo — também não compartilham nenhuma linha dependente. Operações sobre conjuntos disjuntos comutam.
2. **Dentro de um grupo:** toda decisão é `min`, `max`, `argmin`, soma ou união sobre um **conjunto**, sob uma ordem **total** definida em §2.2/§2.3/§5.4. Nenhuma é um *fold* dependente da ordem de iteração. A eleição do sobrevivente não consulta o estado parcial de nenhuma operação anterior.
3. **Entre níveis:** contatos → conversas → mensagens → reações formam uma árvore de partições aninhadas; cada nível é disjunto dentro do nível acima. A árvore é processada por níveis, e a ordem entre irmãos é irrelevante pelo item 2.

Portanto `M` é independente de ordem. ∎

---

## 10. Invariantes (Fase 10)

Cada invariante abaixo é verificável mecanicamente, mensurável sobre dumps pré/pós, e independente das demais (nenhuma é implicada por outra).

| # | Invariante | Verificação |
|---|---|---|
| **I1** | **Unicidade de identidade.** Após qualquer merge, não existem dois contatos na mesma conta com o mesmo `identity(phone)` não-vazio. | Agrupar `contacts` por `(account_id, identity(phone))` com `identity` não-vazia; nenhum grupo tem mais de um membro. |
| **I2** | **Totalidade referencial.** Nenhuma linha que possuía vínculo não-nulo (`contact_id`, `conversation_id`, `message_id`, `reply_to_message_id`, `last_prompt_message_id`, `attribution_id`, `first_attribution_id`) antes do merge possui vínculo nulo ou pendente depois. | Comparar, por `id` de linha, a nulidade de cada coluna de vínculo antes/depois. Nenhuma transição não-nulo → nulo é admissível. |
| **I3** | **Conservação de eventos.** Todas as seis métricas de §8.5 são idênticas antes e depois. | Cálculo direto sobre os dumps. |
| **I4** | **Fidelidade cronológica.** Nenhum `created_at`, `started_at` ou `id` de qualquer linha sobrevivente foi modificado. | Comparação campo a campo por `id` para todas as linhas presentes em ambos os dumps. |
| **I5** | **Determinismo.** Duas execuções sobre o mesmo estado inicial produzem dumps idênticos em todas as colunas de domínio. | Executar duas vezes a partir do mesmo estado; comparar. |
| **I6** | **Idempotência.** `M(M(x))` e `M(x)` produzem dumps idênticos. | Executar `M` duas vezes em sequência; comparar com uma execução. |
| **I7** | **First-touch monotônico.** Se algum membro do grupo possuía `first_attribution_id` não-nulo, o sobrevivente o possui, e ele aponta para a atribuição de menor `(created_at, id)` conhecida da pessoa. | Comparar `first_attribution_id` do sobrevivente com o `argmin` calculado sobre o grupo pré-merge. |
| **I8** | **Unicidade de estado ativo com vínculo preservado.** Existe no máximo um `flow_run` ativo por `(user_id, contact_id)`, e todo run não-sobrevivente mantém `contact_id` não-nulo e estado terminal distinguível. | Agrupar `flow_runs` ativos; verificar cardinalidade ≤ 1 e a ausência de `contact_id` nulo entre os terminados pelo merge. |

Nenhuma invariante contradiz outra: I3 (conservação) e I4 (imutabilidade) operam sobre linhas preservadas; §8.3 delimita exatamente o conjunto de linhas removíveis, e §8.5 define as métricas de I3 de modo a **excluir** duplicatas técnicas da contagem — que é precisamente o que resolve a contradição original entre "não deletar linhas" e "respeitar constraints" (DeepSeek B1).

---

## 11. Critérios de Aceite (Fase 11)

Todos objetivos, mecanicamente verificáveis, sem julgamento humano.

| # | Critério | Método |
|---|---|---|
| **A1** | `M(M(x)) = M(x)` para todo fixture do conjunto de conformidade | Teste baseado em propriedades sobre fixtures gerados; comparação de dump |
| **A2** | O estado final independe da ordem de processamento | Executar `M` sobre permutações da ordem de inserção e da ordem de varredura; dumps idênticos |
| **A3** | As seis métricas de §8.5 são preservadas | Cálculo automatizado pré/pós |
| **A4** | Nenhuma transição de vínculo não-nulo → nulo (I2) | Diff automatizado das colunas de vínculo por `id` |
| **A5** | `COUNT(lead_attributions)` idêntico antes e depois | Contagem direta |
| **A6** | Para todo contato removido, existe registro de proveniência contendo seu `id` e seu `phone` cru | Verificação de cobertura: o conjunto de `id` removidos é subconjunto dos `id` registrados na proveniência |
| **A7** | Nenhum `created_at` modificado (I4) | Diff automatizado |
| **A8** | Todo `flow_run` ativo não-sobrevivente terminou em estado distinguível de terminação natural, com `contact_id` não-nulo | Consulta sobre `status` e `contact_id` dos runs afetados |
| **A9** | Após o merge, zero violações das constraints vigentes: `contacts(account_id, phone_normalized)`, `conversations(account_id, contact_id)`, `messages(conversation_id, message_id)` parcial, `message_reactions(message_id, actor_type, actor_id)`, `flow_runs(user_id, contact_id)` parcial | Validação de integridade do banco |
| **A10** | Duas implementações independentes deste contrato produzem dumps idênticos sobre o mesmo fixture | Execução cruzada e comparação — o critério terminal de não ambiguidade |
| **A11** | Cada cenário do conjunto mínimo de conformidade (§11.1) está coberto por ao menos um teste | Cobertura por cenário |

### 11.1 Conjunto mínimo de cenários de conformidade

Nenhuma expansão pode remover estes cenários sem nova revisão deste ADR:

1. Dois contatos, nenhum com conversa.
2. Dois contatos, apenas um com conversa.
3. Dois contatos, ambos com conversa, sem mensagens colidentes.
4. Dois contatos, ambos com conversa, **com** a mesma `message_id` inbound em ambas (o cenário central do HOTFIX).
5. Cenário 4, com reações do **mesmo** ator em ambas as cópias da mensagem.
6. Cenário 4, com uma terceira mensagem respondendo (`reply_to_message_id`) à cópia que será colapsada.
7. Cenário 4, com `flow_runs.last_prompt_message_id` apontando para a cópia colapsada (M14).
8. Dois contatos, cada um com `lead_attributions` e `first_attribution_id` distintos, o mais antigo pertencendo ao **perdedor**.
9. Dois contatos, ambos com `flow_run` **ativo** sob o mesmo `user_id`.
10. Dois contatos com `automation_pending_executions` agendadas em ambos.
11. Três ou mais contatos no mesmo grupo (verifica que as regras são de conjunto, não binárias).
12. Contatos com `created_at` idêntico (verifica o desempate por `id`).
13. Grupo em que o sobrevivente tem campos ausentes preenchidos por perdedores distintos (verifica fill-gap).
14. Mensagens inbound com `message_id` ausente em ambas as conversas (verifica preservação, não colapso).
15. Mensagens outbound com `message_id` repetido (verifica preservação, não colapso — §5.6).

---

## 12. Matriz de Rastreabilidade

Legenda: **AQUI** = resolvido neste ADR · **IDENT** = resolvido em `ADR-IDENTITY-BR-001` (congelado) · **HOTFIX** = pertence ao HOTFIX reescrito, com justificativa.

### 12.1 DeepSeek

| Achado | Severidade | Onde | Referência |
|---|---|---|---|
| B1 — invariante 5 × `034` × critério 4 | Bloqueante | **AQUI** | §5.2, §8.3, §8.5, §10 I3 |
| B2 — invariante 8 × unique `phone_normalized` × escopo | Bloqueante | **IDENT** | §6.6, §8.2 |
| B3 — vencedor indefinido | Bloqueante | **AQUI** | §2 (integral) |
| B4 — país implícito × invariante 2 | Bloqueante | **IDENT** | §6.2, §6.3 |
| B5 — Fase D × Fase E × critérios 4–5 | Bloqueante | **HOTFIX** | Sequenciamento de fases, backfill e irreversibilidade — explicitamente proibidos neste ADR (cabeçalho). Este ADR fornece a semântica que o HOTFIX sequencia. |
| I1 — critério 8 × expectativas de teste | Importante | **HOTFIX** | Política de testes e permissão de alterar expectativas |
| I2 — flag por caminho viola invariante | Importante | **HOTFIX** | Rollout — fora de escopo |
| I3 — caminho de envio muta `phone` | Importante | **AQUI** + **IDENT** | §3.2 fixa `phone` imutável no merge; o caminho de envio é escopo de identidade (`IDENT` §4) |
| I4 — `unread_count`, `last_message_at`, `attribution_id` da perdedora | Importante | **AQUI** | §4.3, §4.4, §6.2 |
| I5 — tabelas-filhas incompletas | Importante | **AQUI** | §3.4, §3.5, §7 |
| I6 — equivalência não transitiva | Importante | **IDENT** | §8.1 (transitividade estrutural) |
| I7 — pré-filtro indexado | Importante | **IDENT** | §8.2 (indexabilidade) |
| M1 — dono da verdade da equivalência | Melhoria | **IDENT** | Anexo A.1 |
| M2 — atomicidade explícita | Melhoria | **AQUI** | §9.2 |
| M3 — casos de teste obrigatórios | Melhoria | **AQUI** | §11.1 |

### 12.2 Nemotron

| Achado | Severidade | Onde | Referência |
|---|---|---|---|
| B-1 — merge perde `lead_attributions`, não idempotente | Bloqueante | **AQUI** | §6.2, §6.3, §9.1 |
| B-2 — duas relações de equivalência | Bloqueante | **IDENT** | §5, §6.6, §11 |
| B-3 — identidade canônica indefinida | Bloqueante | **IDENT** | §6 (integral) |
| B-4 — colisão de conversa deleta mensagens | Bloqueante | **AQUI** | §4.1, §4.2, §4.5 |
| B-5 — pré-filtro em coluna sem índice | Bloqueante | **IDENT** | §8.2 |
| I-1 — flag por caminho × predicado único | Importante | **HOTFIX** | Rollout — fora de escopo |
| I-2 — números sem DDI/DDD | Importante | **IDENT** | §9 (lista fechada de ambiguidade) |
| I-3 — regra do 9º dígito | Importante | **IDENT** | §6.4 |
| I-4 — coexistência `phonesMatch`/`Strict` | Importante | **IDENT** | §11 |
| I-5 — `first_attribution_id` | Importante | **AQUI** | §6.3 |
| M-1 — critério 6 redundante | Melhoria | **AQUI** | §5.5 esclarece que o merge fortalece, não duplica, a idempotência de `034` |
| M-2 — `flow_runs` ausente do contrato | Melhoria | **AQUI** | §7 |
| M-3 — baseline com granularidade mutável | Melhoria | **AQUI** | §8.5 (métrica de eventos, não de linhas) |
| M-4 — tabelas de automação ausentes | Melhoria | **AQUI** | §7.1 |

### 12.3 Ling

| Achado | Severidade | Onde | Referência |
|---|---|---|---|
| 1 — forma canônica não travada | Bloqueante | **IDENT** | §5, §6 |
| 2 — expressão SQL do pré-filtro | Bloqueante | **IDENT** | §8.2 |
| 3 — flag × critério de aceite 1 | Bloqueante | **HOTFIX** | Rollout — fora de escopo |
| 4 — algoritmo de fusão de conversas | Bloqueante | **AQUI** | §4 (integral) |
| 5 — `lead_attributions` × `origin_message_id` | Importante | **AQUI** | §6.1 — **provado impossível**, nenhuma regra de conflito necessária |
| 6 — `phoneVariants` genérico | Importante | **IDENT** | §6.5 |
| 7 — invariante não cobre reactions/broadcast/flows | Importante | **AQUI** | §4.5, §5.3, §5.4, §7 |
| 8 — "identidade incerta" indefinida | Importante | **IDENT** | §9 |
| 9 — janela de rollback / RPO | Importante | **HOTFIX** | Operacional — explicitamente proibido aqui |
| 10 — falso positivo de DDI em `phonesMatchStrict` | Importante | **IDENT** | §6.2, §7 |
| 11 — mecanismo de flag | Melhoria | **HOTFIX** | Rollout — fora de escopo |
| 12 — `phone` cru após o merge | Melhoria | **AQUI** | §3.2, §3.3 |
| 13 — critérios de sucesso da Fase E | Melhoria | **HOTFIX** | Backfill — fora de escopo; §8.5 fornece as métricas que o backfill deve usar |
| 14 — `phonesMatch` deletada ou não | Melhoria | **IDENT** | §11 |
| 15 — merge × índice único de `034` | Melhoria | **AQUI** | §5.2, §5.5 |

### 12.4 Achados desta auditoria

| # | Achado | Onde |
|---|---|---|
| M12 | `lead_attributions.conversation_id` CASCADE destrói atribuição | **AQUI** — §4.5.3, §6.2 |
| M13 | `message_reactions.conversation_id` CASCADE destrói reações | **AQUI** — §4.5.2 |
| M14 | `flow_runs.last_prompt_message_id` não tratado por `034` | **AQUI** — §5.3 |

### 12.5 Cobertura

Todos os **14 bloqueantes** das três revisões estão resolvidos: 6 neste ADR, 7 no ADR de identidade congelado, 1 (DeepSeek B5) formalmente deferido ao HOTFIX por ser sequenciamento de fases — matéria explicitamente proibida a este documento e que **depende** desta semântica, nunca o inverso. Nenhum bloqueante permanece sem destino. Os 7 itens deferidos ao HOTFIX (DeepSeek B5, I1, I2; Nemotron I-1; Ling 3, 9, 11, 13) são, sem exceção, de rollout, *feature flags*, backfill, rollback ou política de testes — as cinco categorias que o escopo deste ADR exclui por decisão do Gate.

---

## 13. Autovalidação

- **Existem duas implementações diferentes que ainda obedecem ao contrato?** Não. Toda eleição de sobrevivente usa uma ordem **total** explicitamente nomeada (§2.2, §2.3, §5.4), incluindo a representação de comparação de UUID; toda reconciliação de campo tem regra nomeada (§3.1, §4.3, §6.3); toda colisão de constraint tem resolução nomeada (§3.5, §4.1, §5.2, §5.4, §7.2). A5, A9 e A10 (§11) tornam qualquer divergência mecanicamente detectável.
- **Existe alguma colisão cuja resolução foi deixada para o código?** Não. As cinco constraints de unicidade que o merge pode violar estão enumeradas e resolvidas: `contacts` (§2.5/§3.6), `conversations` (§4.1–§4.2), `messages` (§5.2), `message_reactions` (§5.4), `flow_runs` ativos (§7.2). `lead_attributions` está **provada** livre de colisão (§6.1). `contact_tags` e `contact_custom_values` em §3.5.
- **Existe alguma perda de informação não formalizada?** Não. §8.1 define informação; §8.2 enumera o que nunca desaparece; §8.3 fecha em três condições conjuntas o que pode desaparecer; §8.4 enumera exaustivamente o que muda de valor; §8.5 dá as métricas verificáveis.
- **Existe alguma decisão dependente da ordem de execução?** Não — demonstrado em §9.3 a partir da disjunção dos grupos e do uso exclusivo de agregações sobre conjuntos sob ordens totais.
- **Existe algum merge cuja reexecução produza estado diferente?** Não — demonstrado em §9.1, com nota específica sobre `unread_count`, o único campo cuja regra envolve soma.
- **O documento depende de decisões futuras?** Não. Depende exclusivamente de `ADR-IDENTITY-BR-001`, que está **congelado**. Os itens deferidos ao HOTFIX (§12.5) dependem deste documento, e não o contrário — não há dependência circular.
- **Existe algum relacionamento que possa permanecer inconsistente após um merge válido?** Não. Toda tabela que referencia `contacts`, `conversations` ou `messages` está enumerada e tratada: re-apontada (§3.4, §7.1), colapsada com regra (§3.5, §5.2, §5.4), reconciliada (§4.3, §6.3) ou preservada verbatim com justificativa de fronteira (§5.6). I2 (§10) e A4 (§11) tornam qualquer vínculo rompido detectável mecanicamente. As três ordenações obrigatórias (§3.6, §4.5, §6.2) existem especificamente para que nenhum CASCADE ou SET NULL atinja dado vivo.

---

## 14. Cláusula de Congelamento

Este ADR fica **congelado** após aprovação no Gate até que uma evidência operacional concreta exija sua revisão. Novos casos de borda, preferências de implementação ou conveniência não são motivos suficientes para alterar a semântica de merge.

Especificamente, **não** constitui motivo válido para alterar qualquer regra deste documento sem nova revisão formal:

- Descobrir, durante a implementação, que uma regra de sobrevivente "seria mais fácil" com outra ordenação;
- Encontrar uma tabela nova que referencia `contacts`, `conversations` ou `messages` — nesse caso, a tabela **deve** ser classificada segundo §3.4/§3.5/§8.3 por uma revisão deste ADR, nunca tratada ad-hoc no código;
- Otimizar a atomicidade de §9.2 para múltiplas transações por razões de performance;
- Substituir a regra de `unread_count` (§4.4) por outra aproximação sem que um marcador de leitura por mensagem tenha sido efetivamente introduzido no schema.

O único gatilho legítimo de revisão é evidência operacional concreta e verificável: um cenário real em que a aplicação fiel deste contrato produza estado incorreto, perda de informação segundo §8, ou violação de invariante de §10.

Qualquer código, PR ou decisão do `HOTFIX-001` reescrito que altere a semântica de merge sem revisão formal deste ADR está, por definição, fora de conformidade com o Gate — independentemente da justificativa técnica apresentada no momento.
