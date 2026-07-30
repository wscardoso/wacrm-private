# ADR-MSG-STATUS-001 — Canonical Message Status

| | |
|---|---|
| **Tipo** | ADR derivado — normatiza o que `ADR-MSG-001` D7 delegou explicitamente a contrato derivado |
| **Épico** | E2.1 — Canonical Message Status (Fase 0 — contrato) |
| **Status** | **Aceito** — aprovado no Gate arquitetural de 2026-07-29, registrado em `docs/checkpoints/CHECKPOINT-E2.1-STATUS-CANONICAL.md` §9 ("🟢 Contrato aprovado para implementação"). Sincronização de estado em 2026-07-30: o gate havia aprovado o contrato sem que este campo fosse promovido. Nenhum conteúdo normativo foi alterado nesta promoção — as sete pré-condições vinculantes de `CHECKPOINT-E2.1` §8 permanecem exigíveis. |
| **Deriva de / vinculado a** | `ADR-MSG-001` D3, D4, D7, invariantes A–D, §6.2, §7 · `EIS-001` §3.3, §3.4, §4.1, §4.2, §4.3, §8 critérios 4 e 10–16 · `ODI-001` §5, §6.1 · `ADR-E4B-001/002/003` (eixo de tentativa — fronteira, não reuso) · `DLB-001` §10.1 |
| **Autoridade** | Decide **exclusivamente** o vocabulário canônico de estado de mensagem, suas transições, a normalização de callbacks de provider e a resolução de identidade no caminho de status. **Não** decide migration, DDL, nome de tabela/coluna, RPC, nem assinatura de função. **Não** reabre `ADR-MSG-001`, `EIS-001`, `ODI-001`, `ADR-E4B-001/002/003`, `DLB-001` ou `ADR-ATTR-001/002`. |
| **Baseline de código auditado** | `HEAD 26e5d39` |
| **Escopo de produção** | Somente documentação. Nenhuma linha de código, schema ou migration é produzida por este documento. |
| **Histórico** | Substitui integralmente um rascunho anterior de mesmo nome (não versionado, 2026-07-29 14:34), cujos defeitos estão registrados em `CHECKPOINT-E2.1-STATUS-CANONICAL.md` §7. |

---

## 1. Contexto

`ADR-MSG-001` D7 amplia o conjunto canônico de estados, fixa **duas** propriedades — o estado inicial de mensagem de entrada e a monotonicidade do eixo de progresso — e **delega explicitamente** a normatização completa das transições:

> *"A normatização completa das transições admissíveis é delegada a contrato derivado, e sua ausência aqui é deliberada: uma tabela de transições é artefato de design, revisada e versionada em cadência distinta da deste documento."* — `ADR-MSG-001` D7

Este é esse contrato.

Ele existe porque E2.0 (`EIS-001`) construiu o lado de **escrita** da identidade externa sem nenhum consumidor de **leitura**: a operação `resolveMessageByExternalId` de `EIS-001` §4.1 não possui implementação no baseline (verificado por busca exaustiva em `src/` e `supabase/`). O ciclo de status é o consumidor para o qual E2.0 foi construído — é o que torna a cadeia `E2.0 → E2.1` dura, e não de conveniência.

---

## 2. Auditoria do estado atual (evidências)

Todas as afirmações desta seção foram verificadas contra `HEAD 26e5d39`.

### 2.1 Como cada provider representa status atualmente

| Provider | Representa status? | Onde |
|---|---|---|
| **Meta** | Sim — payload `value.statuses[]` consumido cru | `webhook/route.ts:276-278` → `handleStatusUpdate:392-461` |
| **Z-API** | **Não** — nenhum código interpreta `MessageStatusCallback` | `zapi.ts` — `grep status` retorna apenas HTTP status code em `classifyZApiSendFailure` e o endpoint `/status` de conectividade |
| **uazapi** | **Não** — nenhum código interpreta `MESSAGES_UPDATE` | `uazapi.ts` — idem |

A interface `WhatsAppProvider` (`providers/types.ts:139-161`) declara oito métodos: seis de envio, `parseInboundMessage`, `verifyWebhookRequest` e `classifySendFailure`. **Nenhum** é de parsing de status. Busca exaustiva por `parseStatus|StatusUpdate|statusEvent|status_event` em `src/` retorna exatamente duas linhas, ambas no webhook Meta.

### 2.2 Quais status chegam via callback

| Provider | Vocabulário do callback | Estado no sistema |
|---|---|---|
| **Meta** | `sent`, `delivered`, `read`, `failed` — objeto `statuses[]` com `id`, `status`, `timestamp` (segundos), `recipient_id` | Consumido cru |
| **Z-API** | `SENT`, `RECEIVED`, `READ`, `PLAYED` — evento `MessageStatusCallback`, identificadores em `ids[]`, instante em `momment` (milissegundos) | **Descartado ou mal interpretado** (D-C) |
| **uazapi / Evolution** | `ack` numérico Baileys (`0` erro, `1` pendente, `2` server-ack, `3` delivery-ack, `4` read, `5` played) — evento `MESSAGES_UPDATE` | **Descartado em silêncio** — `uazapi.ts:255` retorna `null` na ausência de `msg.message` |

**Meta não emite `pending`.** O vocabulário de `statuses[]` é exatamente o das quatro linhas acima. Qualquer contrato que declare um mapeamento a partir de "Meta `pending`" está descrevendo vocabulário inexistente.

### 2.3 Quais status são persistidos

`messages.status` — `CHECK (status IN ('sending','sent','delivered','read','failed'))`, `001_initial_schema.sql:173`, `DEFAULT 'sent'`. **`pending` e `received` não constam do CHECK**, apesar de D7 declarar o conjunto ampliado para admiti-los.

Três autoridades escrevem `messages.status` hoje, com regras mutuamente divergentes:

| Autoridade | Regra | Origem |
|---|---|---|
| `settle_outbound_message` | CAS estrito: transiciona **apenas** a partir de `'sending'`; fora disso retorna `noop`; `sent` exige `provider_message_id` não-nulo | `048_outbound_delivery_integrity.sql` |
| `insert_inbound_message` | Grava entrada com `p_status: 'delivered'` **fixo** | `inbound-processor.ts:309` (não-Meta) e `webhook/route.ts:695` (Meta) |
| `handleStatusUpdate` | Escada `RECIPIENT_STATUS_LADDER` | `webhook/route.ts:359-390`, aplicada em `414` (messages) e `446` (broadcast_recipients) |

`broadcast_recipients.status` — `CHECK (... 'pending','sent','delivered','read','replied','failed')`, `001:325`. Vocabulário **diferente** do de `messages`.

### 2.4 Existe normalização parcial?

**Não existe normalização.** Existe **coincidência assumida**, declarada em comentário no próprio código:

> `// Meta's status values already match the CHECK constraint on messages.status` — `webhook/route.ts:398-399`

O vocabulário do domínio **é** o vocabulário da Meta, por adoção implícita. Não há tradução, tipo canônico, tabela de mapeamento nem ponto de extensão.

`template-status-normalize.ts` normaliza **status de template Meta** — domínio distinto, e falso-positivo frequente de auditoria por nome de arquivo.

### 2.5 Onde existem diferenças entre providers

1. **Vocabulário** — Meta minúsculo/verbal, Z-API MAIÚSCULO, uazapi numérico.
2. **Colisão semântica crítica** — Z-API `RECEIVED` significa **entregue ao dispositivo**, ou seja `delivered` no domínio. Traduzi-lo para `received` seria correto lexicalmente e **errado semanticamente**, colidindo com o `received` de D7, que é o estado inicial de mensagem de **entrada**.
3. **Granularidade** — `PLAYED` existe em Z-API e uazapi; não existe na Meta.
4. **Falha** — apenas a Meta emite evento de falha pós-aceite com código.
5. **Cardinalidade** — Meta emite um status por objeto; Z-API emite `ids[]`, ou seja **um evento pode referenciar N mensagens**.
6. **Unidade de tempo** — Meta em segundos, Z-API em milissegundos. O caminho de entrada já convive com isso por detecção de magnitude (`inbound-processor.ts:287-292`); o caminho de status **não**: `webhook/route.ts:430` aplica `parseInt(timestamp) * 1000` incondicionalmente.
7. **Identidade referenciada** — R16: Z-API gravava `zaapId` no envio e referencia `messageId` no status. Corrigido no lado de **escrita** por E2.0 (`EIS-001` §6.1); **sem consumidor no lado de leitura**.

### 2.6 Defeitos ativos identificados

| # | Defeito | Evidência | Severidade |
|---|---|---|---|
| **D-A** | Uma única escada governa **dois vocabulários distintos**: `messages` (sem `pending`, sem `replied`) e `broadcast_recipients` (com ambos) | `webhook/route.ts:359-390`, `414`, `446` | Alta |
| **D-B** | `'sending'` — estado real de `messages` sob E4a — **não está na escada**. `ladderLevel('sending') = -1` → linha 388 `if (ci < 0) return true` aceita qualquer estado do eixo; e as linhas 379-381 **recusam** `failed` a partir de `sending`. Um `failed` por callback sobre mensagem em `sending` é descartado | `webhook/route.ts:379-390` | Alta |
| **D-C** | O parser de entrada Z-API **não discrimina pelo campo `type` do envelope**. `MessageStatusCallback` não carrega `fromMe`, carrega `phone`, e não carrega `text`/mídia → o gate de `zapi.ts:230` não dispara e o parser retorna `type:'unknown'` com `messageId` vazio. Não há guarda por `type === 'unknown'` nem por `messageId` vazio em `inbound-processor.ts` | `zapi.ts:227-317`, `inbound-processor.ts:294-320` | **Crítica** |
| **D-D** | Evento de status não correlacionável é descartado em silêncio em todos os caminhos não-Meta. Viola `EIS-001` §8 critério 13 | `webhook/[provider]/[connectionId]/[webhookSecret]/route.ts:165-176` | Alta |
| **D-E** | `webhook_dlq` (`031`) é tabela órfã — zero referências em `src/` fora de um teste | `grep dlq src/` | Média |
| **D-F** | `resolveMessageByExternalId` (`EIS-001` §4.1) não existe. E2.0 grava identidades que nenhum leitor consome | busca exaustiva em `src/` e `supabase/` | Alta |

**Nota de honestidade sobre D-C.** É inferência a partir de leitura de código, não observação de payload capturado. A ausência de discriminação por `type` no parser é fato verificado; a consequência depende da forma exata do `MessageStatusCallback` em produção. Fase 1 **deve** capturar um payload real antes de qualquer correção. Registrado como risco de severidade crítica, **não** como incidente confirmado.

### 2.7 Quais estados pertencem ao domínio e quais pertencem ao provider

| Pertence ao **provider** | Pertence ao **domínio** |
|---|---|
| `SENT`, `RECEIVED`, `READ`, `PLAYED` (Z-API) | `pending`, `sending`, `sent`, `delivered`, `read`, `failed`, `received` |
| `ack: 0..5` (uazapi/Baileys) | — |
| `sent`, `delivered`, `read`, `failed` (Meta) | — |
| Códigos de erro, subcódigos, `error.title` | Classificação de falha, já normatizada por `ADR-E4B-003` §3.4 e não reaberta aqui |

O fato de o vocabulário Meta **coincidir textualmente** com o canônico é acidente histórico, não fundamento. A coincidência é preservada por compatibilidade (§5), nunca por autoridade.

---

## 3. Decisão

### D1 — O Status Canônico é vocabulário próprio do domínio, não o de nenhum provider

O domínio define seu conjunto de estados. Todo valor recebido de qualquer provider — **inclusive Meta** — é resultado de tradução declarada, nunca de adoção direta.

A coincidência textual entre o vocabulário Meta e o canônico permanece verdadeira e passa a ser **consequência de um mapeamento explícito de identidade**, não da ausência de mapeamento.

> *Racional:* enquanto o vocabulário do domínio for o de um provider, todo provider novo é uma negociação com a Meta em vez de uma implementação de contrato. É a mesma patologia que D6 de `ADR-MSG-001` eliminou no eixo de envio.

### D2 — Estados canônicos

**Eixo de progresso de entrega (saída) — ordenado e monotônico:**

| Nível | Estado | Natureza | Significado |
|---|---|---|---|
| 0 | `pending` | transitório | Intenção persistida; nenhuma tentativa de despacho em curso. Origem de E4a e de reenfileiramento de E4b |
| 1 | `sending` | transitório | Tentativa em curso; resultado do provider ainda desconhecido |
| 2 | `sent` | transitório | Provider aceitou; a mensagem partiu para a rede WhatsApp |
| 3 | `delivered` | transitório | Alcançou o dispositivo do destinatário |
| 4 | `read` | **terminal de progresso** | O destinatário abriu a mensagem |

**Estado terminal de exceção (saída):**

| Estado | Natureza | Significado |
|---|---|---|
| `failed` | **terminal** | Não-entrega estabelecida. Fora do eixo de progresso, conforme D7 de `ADR-MSG-001` |

**Estado de entrada:**

| Estado | Natureza | Significado |
|---|---|---|
| `received` | **terminal e único** | Mensagem de entrada. Ciclo de vida degenerado: nasce e permanece neste estado |

**O conjunto canônico é exatamente `{pending, sending, sent, delivered, read, failed, received}` — sete estados. Nenhum outro.**

`pending` e `received` são exatamente os dois estados que D7 declara acrescentados ao conjunto. Este ADR **não os inventa** — normatiza o que D7 já ampliou.

### D3 — `replied` não é estado de mensagem

`replied` é propriedade de **destinatário de disparo** (`broadcast_recipients`), derivada da existência de uma mensagem de entrada correlacionada. Não é estado do ciclo de vida da mensagem enviada e **não pertence a `messages.status`**.

Corrige D-A: as duas tabelas têm vocabulários distintos e **exigem escadas distintas**. Uma escada compartilhada entre vocabulários divergentes é defeito, não economia de código.

> *Racional:* o eixo de `messages` responde "o que aconteceu com esta mensagem". O eixo de `broadcast_recipients` responde "qual o desfecho comercial deste destinatário". Uma resposta do cliente não altera o que aconteceu com a mensagem enviada.

### D4 — Sinais de granularidade superior colapsam no estado imediatamente inferior existente

`PLAYED` (Z-API; uazapi `ack:5`) mapeia para `read`. Nenhum estado canônico novo é criado para sinal que apenas um subconjunto de providers emite.

> *Racional:* um estado canônico emitido por 2 de 3 providers força todo leitor do domínio a ramificar por provider — exatamente o que D1 elimina. `PLAYED` é estritamente mais forte que `read` e não sustenta decisão de produto que `read` não sustente. Se um requisito futuro exigir a distinção, ela entra como **atributo** do evento, nunca como estado do eixo.

### D5 — Ordenação por nível canônico, nunca por timestamp de provider

A admissibilidade de uma transição é decidida **exclusivamente** pela comparação de níveis de D2. O timestamp do evento **nunca** decide transição.

Timestamps são usados unicamente para preencher as marcas temporais do nível efetivamente alcançado, e sua conversão de unidade é responsabilidade do adapter (D9), nunca do domínio.

> *Racional:* os providers divergem em unidade, relógio de origem e garantia de ordenação. `webhook/route.ts:430` já assume segundos incondicionalmente — o mesmo defeito que o caminho de entrada evita por detecção de magnitude. Nível é a única grandeza comparável entre providers.

### D6 — Transições permitidas

Sendo `nivel(x)` a posição de `x` no eixo de D2:

| Regra | Enunciado |
|---|---|
| **T1 — Progresso** | `x → y` é admissível **se e somente se** `nivel(y) > nivel(x)`. **Saltos são admissíveis** |
| **T2 — Regressão** | `nivel(y) ≤ nivel(x)` → **noop**. Nunca erro, nunca escrita |
| **T3 — Exceção** | `→ failed` é admissível **se e somente se** o estado atual é `pending`, `sending` ou `sent` (`nivel ≤ 2`) |
| **T4 — Terminalidade de exceção** | `failed` é terminal absoluto. Evento posterior é **noop observável** (D8/N2) |
| **T5 — Terminalidade de progresso** | `read` é terminal de progresso; T3 já o exclui de `failed` |
| **T6 — Entrada** | `received` não admite transição alguma. Evento de status que resolva para mensagem de entrada é **rejeitado e registrado**, nunca aplicado |
| **T7 — Progresso implícito** | Alcançar o nível `N` estabelece que todos os níveis inferiores ocorreram. As marcas temporais dos níveis pulados permanecem `NULL` e **nunca são inferidas, interpoladas ou retroalimentadas** |

**Matriz de admissibilidade** (linha = estado atual, coluna = evento recebido):

| ↓ atual \ evento → | `sending` | `sent` | `delivered` | `read` | `failed` |
|---|---|---|---|---|---|
| `pending` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `sending` | ⭕ | ✅ | ✅ | ✅ | ✅ |
| `sent` | ⭕ | ⭕ | ✅ | ✅ | ✅ |
| `delivered` | ⭕ | ⭕ | ⭕ | ✅ | 🚫 |
| `read` | ⭕ | ⭕ | ⭕ | ⭕ | 🚫 |
| `failed` | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 |
| `received` | 🚫 | 🚫 | 🚫 | 🚫 | 🚫 |

✅ aplica · ⭕ noop silencioso (repetição/reentrega esperada) · 🚫 **noop observável** — produz sinal (D8)

> **Errata (2026-07-30).** A linha `failed` desta matriz continha `⭕` nas cinco colunas na versão original, contradizendo a própria prosa de T4 ("Evento posterior é **noop observável** (D8/N2)") e a classificação D8 (que trata qualquer evento inadmissível, incluindo os que alvejam um estado terminal, como N2 — nunca como `⭕`). A matriz estava errada; T4 e D8 são a fonte da verdade e permanecem inalterados. Corrigido para `🚫` nas cinco colunas: qualquer evento posterior a `failed` — incluindo um `failed` repetido — é sinal de que o provider está se contradizendo (ou de reentrega tardia de uma falha já registrada), não silêncio esperado. Achado durante a implementação de Fase 1; a implementação (`evaluateTransition` em `src/lib/message/status.ts`) já seguia T4 corretamente antes desta correção — apenas a matriz do ADR estava desalinhada com o próprio texto.

**T1 admite salto deliberadamente.** Webhooks se perdem: um `read` que chega sem que o `delivered` tenha chegado é ocorrência normal, não anomalia. Um contrato que exija `delivered` como pré-condição de `read` deixa a mensagem **permanentemente presa** no nível inferior sempre que o provider perder um evento intermediário — e o eixo de progresso passa a medir a confiabilidade do webhook, não o fato do mundo.

A inclusão de `sending` na matriz corrige D-B em ambas as direções: `failed` sobre `sending` passa a ser admissível, e `read` sobre `sending` deixa de ser aceito por acidente de `ladderLevel = -1`.

### D7 — Idempotência

| Regra | Enunciado |
|---|---|
| **I1** | Aplicar `N` vezes o mesmo evento produz o mesmo estado que aplicá-lo uma vez |
| **I2** | A transição é **compare-and-set** sobre o estado atual, na mesma transação da leitura. É a disciplina já vigente em `settle_outbound_message` (`ODI-001` §5); ela **não é reimplementada** — é estendida ao eixo de status |
| **I3** | Marca temporal já preenchida **nunca** é sobrescrita. O primeiro evento a estabelecer um nível fixa sua marca |
| **I4** | Idempotência de **persistência** não substitui idempotência de **efeito**. Invariante A de `ADR-MSG-001` aplica-se integralmente: evento de status reentregue não pode disparar duas vezes qualquer efeito derivado — contadores de disparo, automações, realtime |
| **I5** | Evento Z-API com `ids[]` de N elementos é decomposto em N aplicações independentes. Falha de uma não impede as demais — mesma disciplina do laço de entrada não-Meta (`route.ts:165-171`) |

### D8 — Evento não aplicável produz sinal, nunca silêncio

Três classes **não** transicionam e **devem** produzir registro observável:

| Classe | Situação | Fundamento |
|---|---|---|
| **N1 — Não correlacionado** | O valor não resolve para mensagem alguma na conexão | `EIS-001` §8 critério 13 |
| **N2 — Inadmissível** | Resolve, mas a transição é 🚫 na matriz de D6 | Este ADR |
| **N3 — Desconhecido** | Valor de status que o mapa do provider não reconhece | D9 |

**Regra:** nenhuma das três é descartada. Cada uma produz registro consultável. `⭕` (repetição esperada) **não** é sinal — é o caso normal de reentrega e não deve poluir o registro.

> *Racional:* `EIS-001` §8.13 é literal — *"a ausência de correlação é sinal, nunca ausência de sinal"*. Um provider que passe a referenciar identidade nova quebraria a correlação de 100% das mensagens sem produzir um único registro no comportamento atual. Foi exatamente o formato de R16, e é o que torna esta regra não-negociável.

O **destino físico** do registro é decisão de implementação de Fase 1. `webhook_dlq` (`031`) é o candidato preexistente e órfão (D-E); este ADR não decide entre reutilizá-lo e criar superfície própria, e **não autoriza migration**.

### D9 — Todo provider declara seu mapa de status; nada é inferido

Cada adapter declara, estaticamente:

1. **O mapa** `valor-do-provider → estado canônico | não-aplicável`, exaustivo sobre o vocabulário conhecido do provider.
2. **A cobertura** — quais níveis do eixo o provider é capaz de emitir.
3. **A extração** — como obter, do payload, o conjunto de identificadores referenciados e o instante do evento **já normalizado em unidade**.

**Mapa normativo do baseline:**

| Canônico | Meta | Z-API | uazapi (`ack`) |
|---|---|---|---|
| `sent` | `sent` | `SENT` | `2` (server-ack) |
| `delivered` | `delivered` | **`RECEIVED`** | `3` (delivery-ack) |
| `read` | `read` | `READ`, `PLAYED` | `4`, `5` |
| `failed` | `failed` | — | `0` (erro) |
| *não-aplicável* | — | — | `1` (pendente — anterior ao aceite; não transiciona) |

⚠️ **`RECEIVED` (Z-API) → `delivered`. Nunca `received`.** `received` é estado de mensagem de **entrada** (D7 de `ADR-MSG-001`) e é inalcançável por qualquer callback de status. A homonímia é a armadilha de maior severidade deste mapa e tem critério de aceitação dedicado (§10.7).

**Regras de declaração:**

- Valor fora do mapa → **N3**. Nunca palpite, nunca aproximação por similaridade textual, **nunca default para `failed`**.
- Ausência de emissão **nunca** é evidência de negativa: um provider que não emita `read` não autoriza concluir "não lido". Silêncio é ausência de informação, não informação negativa.
- Provider novo sem mapa declarado tem cobertura **vazia** por padrão — conservador, na disciplina de `DLB-001` §10.1 e `ADR-E4B-003` §3.3.

> *Racional para a proibição de default `failed`:* inferir não-entrega a partir de desconhecimento fabrica fato que ninguém observou, é visível ao operador, contamina métrica de entrega e pode disparar retry de mensagem já entregue. Um estado desconhecido é ignorância; `failed` é afirmação. Converter uma na outra é o pior default disponível — estritamente pior que não fazer nada.

**Fronteira com `ADR-E4B-003`.** Esta declaração é **própria deste contrato** e **não** amplia `ProviderCapabilities`, cujos dois eixos (`nativeIdempotency`, `deliveryReconciliation`) são governados por `ADR-E4B-003` §3.2 e não são reabertos aqui. Nenhum campo agregado combinando os dois contratos é admitido.

### D10 — O caminho de status resolve identidade; não consulta coluna

A correlação entre evento e mensagem ocorre **exclusivamente** por `resolveMessageByExternalId(connectionRef, value, kind?)` — `EIS-001` §4.1 — incluindo a precedência absoluta da identidade registrada sobre o fallback de §4.3.

Consulta direta a `messages.message_id` no caminho de status é **proibida**. Corrige D-F e é a razão pela qual E2.0 precede E2.1 na cadeia dura.

**Pré-condição de conexão.** Por `EIS-001` §4.2 e D3.a de `ADR-MSG-001`, a resolução exige `connectionRef`. Evento não atribuível a uma conexão **não entra no domínio** e é recusado sob invariante C.

**Superfície de risco herdada.** O fallback de §4.3 lê `messages.message_id`, campo sem unicidade estrutural, e depende inteiramente da restrição por conexão aplicada em código. `EIS-001` §8 critério 15 é reexecutado no caminho de status (§10.12).

### D11 — Autoridade única de escrita

A transição de `messages.status` no eixo de callback passa a ter **uma** autoridade transacional, com a disciplina CAS de I2. As três autoridades divergentes de §2.3 convergem para ela.

Preservado sem alteração: `settle_outbound_message` continua sendo a autoridade de **liquidação de tentativa de envio** (`ODI-001` §5). Este ADR não a reimplementa nem a substitui — declara que o caminho de **callback** não pode ser uma segunda autoridade com regras próprias, que é o estado atual.

### D12 — Fronteira com o eixo de tentativa (E4b)

O estado da **mensagem** (este contrato) e o estado da **tentativa de entrega** (`outbound_retry_ledger`: `pending`, `retrying`, `delivered`, `dead` — `049`) são **eixos distintos e não conversíveis**.

- `ambiguous` (`ADR-E4B-002` §2) classifica **tentativa**, jamais mensagem. Não é, e não se tornará, estado canônico.
- Uma mensagem pode estar `sent` com a tentativa `retrying`. Não é inconsistência.
- **Nenhum dos dois eixos deriva o outro.** O estado do ledger nunca é consultado para decidir uma transição de status, e um evento de status nunca é suprimido por causa do estado do ledger.
- Nenhuma tabela, função ou enum é compartilhada.

Réplica exata da disciplina que `E6.0` §1.2.7 aplicou ao mesmo eixo: **replicar a disciplina, nunca a instância.**

---

## 4. Estados transitórios e terminais — quadro consolidado

| Estado | Direção | Transitório | Terminal | Sai por |
|---|---|---|---|---|
| `pending` | saída | ✅ | — | despacho, falha |
| `sending` | saída | ✅ | — | resultado do provider, callback |
| `sent` | saída | ✅ | — | callback de progresso, falha |
| `delivered` | saída | ✅ | — | callback `read` **apenas** |
| `read` | saída | — | ✅ progresso | — |
| `failed` | saída | — | ✅ exceção | — |
| `received` | entrada | — | ✅ absoluto | — |

`delivered` **não é terminal.** É o erro de leitura mais provável desta tabela: é o último estado que o remetente controla, mas admite `read` e é, por definição, transitório.

**Advertência de leitura (`ADR-MSG-001` §7).** Enquanto D4 do §15 do roadmap não for resolvida, o acervo conterá mensagens de entrada gravadas como `delivered`. Nenhuma consulta pode qualificar direção por estado; direção deriva de `sender_type` (invariante D). Este ADR **não** trata o acervo e **não** autoriza backfill.

---

## 5. Compatibilidade retroativa

| Superfície | Efeito | Tratamento |
|---|---|---|
| **Vocabulário Meta** | Nenhuma mudança observável — o mapeamento é identidade | Critério de regressão de `ADR-MSG-001` §7 preservado |
| **CHECK de `messages.status`** | `pending` e `received` ausentes do CHECK de `001:173` | Ampliação **aditiva** em Fase 1. Nenhum valor existente é removido, renomeado ou reinterpretado. Este ADR declara a necessidade e **não** autoriza a migration |
| **Acervo de entrada como `delivered`** | Duas populações convivem | `ADR-MSG-001` §7 vigente e inalterado. Este ADR não decide D4 do §15 |
| **Saída anterior a E2.0** | Sem linhas em `message_external_ids` | Fallback de `EIS-001` §4.3, com precedência e restrição por conexão |
| **`broadcast_recipients`** | Vocabulário próprio, incluindo `replied` | Intocado. Ganha escada **própria** por D3 — o compartilhamento atual é o defeito D-A |
| **`settle_outbound_message`** | Autoridade de liquidação de tentativa | Preservada integralmente (D11) |
| **`outbound_retry_ledger`** | Eixo de tentativa | Intocado (D12) |
| **UI de status** | `message-thread.tsx` lê o vocabulário atual | Vocabulário preservado; `pending` e `received` exigem tratamento de exibição em Fase 1 (`ADR-MSG-001` §7: leitura equivalente para as duas populações) |
| **`template-status-normalize.ts`** | Domínio de templates Meta | Fora de escopo. Nenhuma unificação — homonímia, não parentesco |
| **API pública** | Não expõe mensagens | Nenhuma quebra de contrato externo |

---

## 6. Compatibilidade com providers futuros

Um provider novo é compatível quando, e somente quando:

1. Declara o mapa de D9, exaustivo sobre seu vocabulário conhecido.
2. Declara a cobertura de níveis que emite.
3. Extrai identificadores e instante do payload, com unidade de tempo **já normalizada no adapter**.
4. Declara suas identidades no envio conforme `EIS-001` §3.3 e §6 — sem o que a correlação de status é estruturalmente impossível.
5. É atribuível a exatamente uma conexão antes de qualquer interpretação de domínio (D3.a, invariante C).

**Nada mais.** O domínio não é alterado por provider novo. Se a adição de um provider exigir estado canônico novo, ramificação por `provider.kind` fora do adapter, ou exceção à matriz de D6, **o contrato foi violado** — e a violação é o sinal, não o provider.

---

## 7. Alternativas rejeitadas

| # | Alternativa | Razão da rejeição |
|---|---|---|
| A1 | Manter o vocabulário Meta como canônico | É o estado atual. Torna cada provider novo uma negociação com a Meta; foi a causa direta de Z-API e uazapi não terem ciclo de status nenhum |
| A2 | Estado canônico `played` | Emitido por 2 de 3 providers; força todo leitor a ramificar por provider. D4 colapsa em `read` |
| A3 | Manter `replied` em `messages.status` | Confunde desfecho comercial de destinatário com ciclo de vida de mensagem. É o defeito D-A |
| A4 | Ordenar por timestamp do evento | Unidades, relógios e garantias divergem entre providers. Nível é a única grandeza comparável (D5) |
| A5 | Exigir nível `N-1` como pré-condição de `N` (proibir saltos) | Deixa a mensagem permanentemente presa sempre que um webhook intermediário se perde — ocorrência normal. Converte o eixo de progresso em medida de confiabilidade do webhook (T1) |
| A6 | Status desconhecido → `failed` como default conservador | Não é conservador: fabrica não-entrega não observada, contamina métrica e pode disparar retry de mensagem entregue. `failed` é afirmação; desconhecimento é ignorância (D9/N3) |
| A7 | Descartar evento não correlacionável | Viola `EIS-001` §8.13. É o formato exato de R16 — falha silenciosa e total |
| A8 | Consultar o ledger de retry (E4b) para decidir transição de status | Conflaria eixo de tentativa com eixo de mensagem. Rejeitado pelo mesmo fundamento de `E6.0` §1.2.7 (D12) |
| A9 | Reusar `outbound_retry_ledger` como eixo de status | Idem A8, em forma estrutural |
| A10 | Inferir marcas temporais dos níveis pulados | Fabrica fato não observado. T7 proíbe |
| A11 | Ampliar `ProviderCapabilities` com o eixo de status | Reabriria `ADR-E4B-003` §3.2, que este ADR não tem autoridade para alterar. D9 declara em contrato próprio |
| A12 | Tratar callback de status por `parseInboundMessage` | É a causa presumida de D-C. Status e entrada são eventos de naturezas distintas e exigem parsers distintos |
| A13 | Tabela de histórico de status (`message_status_history`) | Fora da autoridade deste ADR — é decisão de schema. Registrada como candidata legítima para contrato futuro; nada neste ADR a impede nem a pressupõe |

---

## 8. Riscos

| # | Risco | Mitigação | Severidade |
|---|---|---|---|
| R1 | `RECEIVED` (Z-API) traduzido para `received` | Mapa normativo D9 + critério de aceitação dedicado (§10.7) | **Crítica** |
| R2 | D-C confirmado em produção — mensagens fantasma de cliente já gravadas | Captura de payload real **antes** de qualquer código; se confirmado, quantificar o acervo afetado antes de corrigir | **Crítica** |
| R3 | Implementador lê `EIS-001` §4.1 como trabalho a fazer e reescreve a resolução | D10 é normativo; §4.1 é contrato aprovado a que falta apenas o consumidor | Média |
| R4 | Fallback de `EIS-001` §4.3 sem restrição por conexão → vazamento cross-tenant | `EIS-001` §8 critério 15 obrigatório na suíte de E2.1 | **Alta** |
| R5 | Segunda autoridade de escrita sobrevive à implementação | D11 + teste que prove caminho único de transição | Alta |
| R6 | Regressão no caminho Meta em produção | Suíte Meta verde antes e depois (`ADR-MSG-001` §7) | Alta |
| R7 | Estado novo no CHECK sem tratamento na UI → estado cru vazando ao operador | `ADR-MSG-001` §7: leitura equivalente para as duas populações | Média |
| R8 | Escada de `broadcast_recipients` degradada ao ser separada da de `messages` | Teste que prove `flagBroadcastReplyIfAny` e os contadores agregados inalterados | Média |

---

## 9. Consequências

**Aceitas.** Toda tradução de status passa a ter custo declarado por provider. A duplicação de escada entre `messages` e `broadcast_recipients` é intencional e é correção, não regressão de reuso.

**Desejadas.** Z-API e uazapi ganham ciclo de status pela primeira vez. R16 fecha ponta a ponta — escrita em E2.0, leitura em E2.1. E2.0 deixa de gravar dados sem leitor. Provider novo passa a custar uma declaração, não uma negociação.

**Negativas assumidas.** `PLAYED` perde granularidade (D4/A2, reversível por atributo). O acervo de entrada gravado como `delivered` permanece — este ADR **não** o resolve, e a decisão continua sendo D4 do §15 do roadmap.

---

## 10. Critérios de aceitação (vinculantes para a Fase 1)

1. Nenhum valor de status de provider aparece fora do respectivo adapter — verificado por **teste de arquitetura**, no mesmo regime de D6 de `ADR-MSG-001`.
2. O caminho de status **não** consulta `messages.message_id` diretamente; resolve por `EIS-001` §4.1 — verificado por teste de arquitetura.
3. **Regressão de R16 fechada na leitura:** callback Z-API referenciando `messageId` transiciona a mensagem enviada. Complementa `EIS-001` §8 critério 4, que cobre apenas a escrita.
4. As três classes N1/N2/N3 produzem registro consultável; `⭕` não produz.
5. Reentrega do mesmo evento não altera estado nem dispara efeito duplicado (invariante A + I4).
6. Evento fora de ordem — `delivered` após `read` — não regride, nos três providers.
7. **`RECEIVED` (Z-API) resolve para `delivered`.** Teste dedicado e nomeado. Um teste que aceite `received` está errado, não o código.
8. `failed` sobre mensagem em `sending` é aplicado (fecha D-B).
9. `read` sobre mensagem em `sending` é aplicado, a mensagem **não** transita por `sent`/`delivered`, e as marcas temporais puladas permanecem `NULL` (T1 + T7).
10. Evento de status que resolva para mensagem de entrada é rejeitado e registrado (T6).
11. Evento Z-API com `ids[]` de N elementos aplica N transições independentes (I5).
12. O fallback de `EIS-001` §4.3 não resolve valor pertencente a outra conexão — critério 15 de `EIS-001`, reexecutado no caminho de status.
13. Caminho Meta sem mudança externamente observável; suíte Meta verde antes e depois.
14. Um único caminho transiciona `messages.status` no eixo de callback (D11).
15. Payload real de `MessageStatusCallback` Z-API capturado e usado como fixture; o comportamento do parser de **entrada** sobre ele é explicitamente asseverado (D-C).
16. Nenhum teste de E2.1 referencia `outbound_retry_ledger` nem `ambiguous` como estado de mensagem (D12).
17. Status desconhecido não produz `failed` nem qualquer transição (D9/N3, A6).

---

## 11. Fronteiras deste contrato

**Não decide:** migration, DDL, nome de tabela/coluna/função, assinatura, destino físico do registro de D8, tratamento do acervo (D4 do §15 do roadmap), wiring de cron, `webhook_dlq` vs. superfície nova, apresentação em UI.

**Não reabre:** `ADR-MSG-001` (invariantes A–D, D1–D7), `EIS-001` (§3.3, §3.4, §4.1–§4.3, §8), `ODI-001` §5/§6.1, `ADR-E4B-001/002/003`, `DLB-001`, `ADR-ATTR-001/002`, `ADR-CRYPTO-001`, `ADR-E7-001`.

**Não produz código.** Fase 0 é contrato. Nenhuma linha de `src/`, `supabase/` ou de configuração foi alterada na produção deste documento.
