# ADR-AUT-001 — Reconciliação Arquitetural de Automations × Flows

| | |
|---|---|
| **Tipo** | Architecture Decision Record — documental, formaliza comportamento existente. Não altera código de produção. |
| **Escopo** | `src/lib/automations/*`, `src/lib/flows/*`, o ponto de dispatch em `src/app/api/whatsapp/webhook/route.ts` e `src/lib/whatsapp/inbound-processor.ts`. Não decide IA, não decide `departments`, não decide round-robin real. |
| **Deriva de** | `docs/MASTER-ROADMAP.md` E10 (`ADR-AUT-001 + Convergência`, P2, referenciado desde `MASTER-ROADMAP.md:205`) · `ADR-MSG-001` D3.b (provider dispatch) · achados de `docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md` §1 (duplicação `engineSendBase`, contrato implícito em `flows/engine.ts:1003`) |
| **Resolve** | Formaliza a relação entre os dois motores de orquestração (responsabilidade, precedência, fronteira com provider abstraction) e registra as dívidas conhecidas (duplicação de dispatch, superfícies mortas, round-robin fake) com seus critérios de saída — sem implementar nenhuma correção. |
| **Status** | Aceito — decisão documental sobre estado observado, sem código associado nesta etapa. |
| **Autoridade** | Decide **apenas** fronteira de responsabilidade, precedência e classificação de dívidas entre Automations e Flows. **Não decide** onde IA entra (deferido a FORCECRM × ROXY), não decide implementação de round-robin real, não decide `departments`/filas. |
| **Baseline de código** | HEAD `2a6061e` (working tree com `docs/MASTER-ROADMAP.md` modificado, não commitado, ver §9) |

---

## 1. Contexto

O `MASTER-ROADMAP.md` registra desde a v1.4 (`§2.3`, `§6`, risco `R12`) que Automations e Flows são "dois motores paralelos... nenhum documento explica se são complementares ou se um substitui o outro". A reconciliação competitiva de 2026-08-07 (`ANALISE-COMPETITIVA-CHATPRO-2026-08-07.md` §5.3, `RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md` §1) aprofundou essa investigação e encontrou evidência concreta de que a pergunta certa não é "qual motor vence", mas "que infraestrutura de baixo nível os dois reimplementam de forma independente, e que contrato de alto nível já existe no código sem nunca ter sido escrito como decisão".

Este ADR fecha essa lacuna: transforma em decisão explícita o que o código já faz, sem redesenhar nada.

## 2. Estado atual (Observed)

### 2.1 Automations

**Responsabilidade:** árvore de ações reativas a um evento discreto. Schema: `automations` (`trigger_type` TEXT livre) + `automation_steps` (árvore com `parent_step_id`/branch Yes-No) + `automation_logs` (execução) + `automation_pending_executions` (fila de espera para passos `wait`, drenada por cron) — `supabase/migrations/006_automations.sql`.

**Dispatch:** ponto único de entrada `runAutomationsForTrigger` (`src/lib/automations/engine.ts:57`), documentado como "must never throw — callers use fire-and-forget from the webhook" (`engine.ts:53-55`). Confirmado por grep: **apenas dois call-sites em runtime de produção**, ambos disparando exatamente os mesmos quatro `triggerType` (`new_message_received`, `keyword_match`, `new_contact_created`, `first_inbound_message`):
- `src/app/api/whatsapp/webhook/route.ts:824-840` (caminho Meta)
- `src/lib/whatsapp/inbound-processor.ts:380-393` (caminho não-Meta)

Ambos usam `retryOnError(...).catch(...)` sem `await` bloqueante do resultado — fire-and-forget real, não apenas em comentário.

**Deduplicação:** heurística por janela de tempo, não constraint de banco — `engine.ts:101-119`: pula a automação se já existe uma linha em `automation_logs` para `(automation_id, contact_id, trigger_event)` nos últimos 60 segundos. É best-effort (cobre retry de webhook do Meta dentro da janela), não uma garantia de banco.

### 2.2 Flows

**Responsabilidade:** máquina de estados conversacional multi-turno, persistida por contato. Descrição no próprio código, `src/lib/flows/engine.ts:1-33`: *"the runner walks the customer through a DB-stored node graph, suspending only at nodes that need customer input. Each tap or text reply wakes it back up."* Schema: `flows` (`trigger_type` restrito por CHECK a `keyword|first_inbound_message|manual`, `010_flows.sql:84-85`) + `flow_nodes` (grafo, `node_type` restrito por CHECK, `010_flows.sql:118-129`) + `flow_runs` (posição por contato, `current_node_key`) + `flow_run_events` (log append-only).

**Dispatch:** ponto único de entrada `dispatchInboundToFlows` (`src/lib/flows/engine.ts:829`), chamado de forma **awaited** (bloqueante) pelos dois mesmos call-sites de Automations, antes de decidir quais gatilhos de Automations disparar — não é fire-and-forget.

**Concorrência/idempotência:** garantida por banco, não por heurística — índice parcial único `idx_one_active_run_per_contact` (uma única run ativa por contato; segunda tentativa de INSERT colide com `23505`, tratado como `duplicate_inbound_ignored`, `engine.ts:1080-1086`), mais idempotência por `meta_message_id` para runs já ativas (`isDuplicateInbound`, `engine.ts:844-856`) e precondição otimista em `current_node_key` para taps simultâneos (`engine.ts:23-29` docstring).

### 2.3 Contrato de precedência — já implementado, nunca formalizado

Existe hoje um contrato real e funcionando, duplicado verbatim em dois arquivos:

```
webhook/route.ts:758-840          inbound-processor.ts:360-393
```

1. `dispatchInboundToFlows` roda **primeiro**, com `await` — o resultado é necessário antes de decidir o próximo passo (`webhook/route.ts:771-776`: *"Awaited... because we need the consumed result before deciding whether to dispatch automations"*).
2. Se `flowResult.consumed === true`, os gatilhos de Automations **de conteúdo** (`new_message_received`, `keyword_match`) são suprimidos para aquela mensagem (`webhook/route.ts:811-815`, `inbound-processor.ts:376`).
3. Os gatilhos de Automations **de identidade** (`new_contact_created`, `first_inbound_message`) disparam **sempre**, independentemente de consumo por Flows (`webhook/route.ts:822-823`) — a justificativa registrada no comentário é que esses gatilhos descrevem *quem* está mandando mensagem, não *o que* foi dito.
4. Dentro do próprio runner de Flows existe um segundo ponto de cessão explícita: quando a política de fallback decide `ignore` (nenhuma resposta reconhecida dentro de um `collect_input`), o runner retorna `consumed: false` propositalmente — comentário `flows/engine.ts:1003`: *"Don't consume — let automations have a shot at it."*

Este contrato é **Implemented**, testado indiretamente pelos testes de `engine.test.ts` de cada motor, mas nunca foi registrado como decisão arquitetural em nenhum ADR — está apenas em comentários de dois arquivos que precisam permanecer sincronizados manualmente.

### 2.4 `getProvider()` — camada de integração, não pertence a nenhum dos dois motores

Confirmado por leitura direta: `automations/meta-send.ts:104` e `flows/meta-send.ts:97,229,400` chamam `getProvider()` com a mesma lógica de branch por `config.provider` (`zapi`/`uazapi`/`meta`), ambas rotuladas com o mesmo comentário `// ── Provider dispatch (ADR-MSG-001/D3.b) ──`. **Nenhum dos dois motores é Meta-only.** O rótulo "ambos Meta-only" que constava em `MASTER-ROADMAP.md §2.3` já foi corrigido (ver `docs/checkpoints/CHECKPOINT-ROADMAP-*` e o diff pendente de `MASTER-ROADMAP.md`, item já concluído na etapa anterior desta reconciliação — não reaberto aqui).

### 2.5 `engineSendBase` — não existe. É um alvo de extração nomeado, não infraestrutura.

Busca no código confirma: `engineSendBase` **não é uma função, tipo ou módulo existente** — a única ocorrência do nome em todo `src/` é um comentário. `flows/meta-send.ts:23-28`:
> *"Mirrors src/lib/automations/meta-send.ts (engineSendText / engineSendTemplate) but emits interactive button + list messages. Kept separate from the automations file so the two engines don't fight over each other's shape — once both stabilize, the phone-variant retry + DB persistence are obvious extraction candidates into a shared base."*

E `flows/meta-send.ts:56-59`, no docstring de `engineSendText`:
> *"Wraps the same phone-variant retry + DB persistence pattern as the interactive senders; the duplication will be DRY'd into a shared engineSendBase once the v2 features (templates with variables, media sends) settle."*

Ou seja: o próprio time já identificou e nomeou o alvo da extração, mas decidiu deliberadamente **não fazer isso ainda** (esperar v2 estabilizar). A duplicação é real e comprovada por leitura completa dos dois arquivos: `automations/meta-send.ts:62-199` (`sendViaMeta`) e cada uma das quatro funções de `flows/meta-send.ts` (`engineSendText`, `engineSendMedia`, `sendInteractiveViaMeta` para buttons e list) reimplementam, byte a byte, o mesmo bloco: lookup de `contacts`+`whatsapp_config` escopado por `account_id`, descriptografia via `decryptWithBindingContext`, branch de `getProvider()`, criação de intent em `messages` (`ODI-001 §4`), `sendWithPhoneVariantRetry`, `settleMessageSystem`/`handleSendFailure` com `actor='system'` (`ADR-SYS-001`), e atualização de `conversations.last_message_text/last_message_at`.

### 2.6 Superfícies mortas / sem dispatcher em runtime

Quatro superfícies são **configuráveis pela UI e validadas na ativação, mas nunca disparadas por nenhum evento real**:

| Superfície | Onde é oferecida | Por que está morta |
|---|---|---|
| Automation trigger `conversation_assigned` | Tipo em `src/types/index.ts:413`; opção em `src/components/automations/automation-builder.tsx:128`; rótulo em `src/lib/automations/trigger-meta.ts:26-29` | `runAutomationsForTrigger` só é chamada (2 call-sites de produção) com `triggerType` em `{new_message_received, keyword_match, new_contact_created, first_inbound_message}` — nunca `conversation_assigned`. Nenhum código em `src/` dispara esse evento ao gravar `conversations.assigned_agent_id`. |
| Automation trigger `tag_added` | Tipo em `src/types/index.ts:414`; opção em `automation-builder.tsx:129`; validação em `src/lib/automations/validate.ts:173-176` (exige `tag_id` para ativar) | Mesma ausência de dispatcher — nada em `src/` chama `runAutomationsForTrigger({triggerType: 'tag_added', ...})`. |
| Automation trigger `time_based` | Tipo em `src/types/index.ts:415`; opção em `automation-builder.tsx:130`; validação em `validate.ts:169-172` (exige `schedule`) | Nenhum cron em `src/app/api` invoca `runAutomationsForTrigger` com esse tipo. `automation_pending_executions` é a fila de passos `wait` *dentro* de uma automação já disparada — não é um agendador de gatilho de entrada. |
| Flow node `http_fetch` | Permitido pelo CHECK de `node_type` (`010_flows.sql:127`); citado como "v2" em `flows/engine.ts:464` e `flows/types.ts:184` | O switch de execução de nó em `flows/engine.ts` (linhas 576-770) não possui nenhum branch `node_type === "http_fetch"`. Um flow com esse nó trava na execução — nenhum handler o processa. |
| Flow trigger `manual` | Permitido pelo CHECK de `trigger_type` (`010_flows.sql:85`); aceito por `POST/PUT /api/flows` e `/api/flows/[id]/activate` | `findEntryFlow` ignora explicitamente flows com esse trigger (`flows/engine.ts:344`: *"'manual' triggers do not auto-start from inbound messages"*), e não existe nenhum outro endpoint que inicie uma run manualmente — `GET /api/flows/[id]/runs` só lista runs existentes, não cria. |

Nenhuma dessas superfícies é removida ou implementada por este ADR — são registradas como dívida de configuração morta (usuário pode configurar algo que nunca vai rodar, sem erro visível).

### 2.7 Round-robin fake

`src/lib/automations/engine.ts:451-464`, passo `assign_conversation` em modo `round_robin`:
```
if (cfg.mode === 'round_robin') {
  // Pick any member of the account. The existing implementation
  // only ever returned the automation's author; preserving that
  // shape until a real round-robin algorithm replaces it.
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', args.automation.account_id)
    .limit(1)
  agentId = profiles?.[0]?.user_id
}
```
`.limit(1)` sem `ORDER BY` determinístico de rotação real — na prática, sempre retorna o mesmo (ou um arbitrário, dependendo do plano de query) membro da conta, não distribui. O comentário já documenta que essa é uma preservação de forma anterior ("author-only"), à espera de um algoritmo real.

## 3. Problema

Duas ambiguidades de fronteira, hoje resolvidas apenas implicitamente no código:

1. **Onde termina Automation e começa Flow?** Resposta observada: não é uma fronteira de features, é uma fronteira de forma de execução — evento discreto → ação (Automations) vs. estado conversacional persistido → múltiplos turnos (Flows). Nunca foi escrito.
2. **Quando os dois competem pelo mesmo evento de entrada, quem ganha?** Resposta observada: Flows sempre primeiro, com um mecanismo de supressão seletiva por classe de gatilho. Nunca foi escrito — está apenas em comentários que podem divergir do código sem aviso.

## 4. Decisões

**D1 — Automations e Flows permanecem dois motores distintos e complementares.** Não convergem em um único motor. Automations resolve reação simples a um evento discreto sem necessidade de estado entre turnos; Flows resolve conversação multi-turno com estado persistido por contato. Um não é redutível ao outro sem perder capacidade (Automations não tem `current_node_key`/suspensão; Flows não tem árvore de condição arbitrária reaproveitável fora de um grafo).

**D2 — Provider abstraction (`getProvider()`) pertence à camada de entrega (`ADR-MSG-001`/D3.b), não a nenhum dos dois motores.** Automations e Flows são consumidores desse contrato, não donos. Nenhuma decisão de arquitetura de Automations ou Flows deve reimplementar ou contornar `getProvider()`.

**D3 — `engineSendBase` é um alvo de extração nomeado, autorizado para uma etapa futura de implementação, não uma decisão arquitetural pendente.** A forma da extração (função compartilhada consumida por `automations/meta-send.ts` e `flows/meta-send.ts`) já está definida pelo próprio código-comentário; falta só a execução. Este ADR não a executa — apenas remove a ambiguidade sobre se ela deveria existir (deveria) e sobre sua forma (a nomeada nos comentários já citados).

**D4 — O contrato de precedência observado em §2.3 é promovido de comportamento implícito para decisão arquitetural formal.** Regra: Flows sempre avalia primeiro (síncrono, aguardado); consumo por Flows suprime gatilhos de Automations de conteúdo (`new_message_received`, `keyword_match`) para a mesma mensagem; gatilhos de identidade (`new_contact_created`, `first_inbound_message`) dependem apenas do evento de contato, não do resultado de Flows, e disparam sempre. Fallback `ignore` dentro de um `collect_input` de Flows libera a mensagem para Automations. **Débito reconhecido, não corrigido aqui:** essa regra está duplicada byte a byte em `webhook/route.ts` e `inbound-processor.ts` — os dois precisam ser editados em conjunto manualmente hoje; a extração para um helper único de dispatch é trabalho de implementação futura, não decidido neste ADR.

**D5 — As superfícies mortas de §2.6 são registradas como débito de configuração, não removidas nem implementadas.** Um usuário pode hoje configurar uma automação com `tag_added`/`conversation_assigned`/`time_based`, ou um flow com nó `http_fetch`/gatilho `manual`, sem qualquer erro de validação — e essa configuração nunca executa. Isso é uma lacuna de UX/confiabilidade a resolver quando essas superfícies entrarem em escopo de implementação real (fora deste ADR).

**D6 — Round-robin permanece fake, com critério de saída explícito (não altera o já registrado no MASTER-ROADMAP):**
- **A.** existir um dispatcher real do evento `conversation_assigned` (hoje só validado como *destino* possível de trigger, nunca emitido — ver §2.6) e a atribuição deixar de ser author-only; **OU**
- **B.** um cliente operar com 2+ agentes ativos onde distribuição equitativa vire requisito real de produto.
Enquanto nenhuma das duas condições existir, `round_robin` permanece implementação provisória documentada. Este ADR não implementa round-robin real.

**D7 — IA não entra como terceiro motor nesta decisão.** Automations e Flows continuam sendo os dois mecanismos de orquestração vigentes. A localização concreta de qualquer capacidade de IA (nó dentro de Flows, capacidade de Automations, ou algo distinto) permanece **deliberadamente em aberto** até a reconciliação de fronteiras FORCECRM × ROXY, que é uma etapa posterior e não autorizada aqui. Este ADR não cria `ADR-AI-001`, não cria arquitetura de agente/copiloto, não cria event bus para IA.

## 5. Fronteiras

| Camada | Responsabilidade | Não é responsabilidade de |
|---|---|---|
| **Automation** (`src/lib/automations/`) | Reagir a um evento discreto de entrada com uma árvore de ações (mensagem, tag, criar deal, atribuir conversa, esperar). Sem estado entre invocações além do que já existe em `contacts`/`conversations`. | Não gerencia posição de conversa multi-turno; não decide se uma mensagem "pertence" a um menu em andamento — isso é decidido antes, por Flows. |
| **Flow** (`src/lib/flows/`) | Conduzir uma conversação multi-turno com estado persistido por contato (`flow_runs.current_node_key`), incluindo suspensão aguardando resposta do cliente e handoff explícito. | Não é um motor de regras genérico para eventos não-conversacionais (ex.: "quando uma tag for adicionada" não é uma preocupação de Flow). |
| **Provider abstraction** (`getProvider()`, `src/lib/whatsapp/providers/`) | Traduzir uma chamada de envio (texto/mídia/template/interativo) para o provider configurado (`meta`/`zapi`/`uazapi`). Camada de entrega, `ADR-MSG-001`. | Não decide quando enviar, nem para qual motor uma mensagem pertence — é chamada por ambos os motores de forma idêntica. |
| **`engineSendBase` (não implementado)** | Alvo futuro: unificar o bloco de dispatch+retry+settle hoje duplicado entre `automations/meta-send.ts` e `flows/meta-send.ts`. | Não existe hoje. Não deve ser tratado como infraestrutura disponível até ser implementado. |
| **Dispatch/eventos de entrada** (`webhook/route.ts`, `inbound-processor.ts`) | Ponto único onde a precedência Flow-antes-de-Automation (D4) é aplicada. | Não deveria conter lógica de negócio de nenhum dos dois motores — hoje só decide *se* dispara, não *o quê*. |

## 6. Precedência

Ver §2.3 (Observed) e D4 (Decision). Resumo formal:

```
inbound message
  → dispatchInboundToFlows()  [awaited, síncrono]
      → consumed=true  (run avançada ou iniciada)
          → gatilhos de CONTEÚDO de Automations suprimidos
          → gatilhos de IDENTIDADE de Automations disparam normalmente
      → consumed=false (nenhum flow ativo/casou, OU fallback "ignore")
          → todos os gatilhos de Automations aplicáveis disparam
  → runAutomationsForTrigger()  [fire-and-forget, por gatilho aplicável]
```

Não há ciclo: Automations nunca decide se consome uma mensagem de forma que afete Flows — a precedência é unidirecional (Flows decide primeiro, Automations reage ao resultado).

## 7. Round-robin

Ver D6. Debt controlado, sem implementação nesta etapa.

## 8. Superfícies mortas

Ver §2.6 e D5. Cinco superfícies catalogadas (três triggers de Automations, um node type e um trigger type de Flows) — configuráveis, validadas, nunca executadas.

## 9. IA

Ver D7. Fora de escopo. Nenhuma arquitetura de IA, ADR-AI-001, ou documento FORCECRM × Roxy é criado aqui.

## 10. Consequências

**Melhora:**
- A pergunta "Automations e Flows convergem?" tem resposta escrita e fundamentada em evidência de código (não convergem; são complementares por design observável).
- O contrato de precedência, hoje só em comentários síncronos em dois arquivos, tem uma fonte única de verdade documental — reduz o risco de os dois arquivos divergirem silenciosamente em uma edição futura sem que ninguém note que é um contrato, não um detalhe local.
- `engineSendBase` deixa de ser uma referência ambígua espalhada em comentários e passa a ser um item de trabalho nomeado e escopado (extração pontual, não redesenho).
- As cinco superfícies mortas passam de "descoberta por auditoria" para "débito catalogado", visível para qualquer implementação futura que mexa nessas áreas.

**Limitações que permanecem:**
- A duplicação de dispatch (`automations/meta-send.ts` × `flows/meta-send.ts`) continua existindo em código — este ADR autoriza a extração futura, não a executa.
- A duplicação do contrato de precedência entre `webhook/route.ts` e `inbound-processor.ts` continua existindo em código — mesma situação.
- As superfícies mortas continuam configuráveis e silenciosamente inertes — nenhuma validação de UI foi adicionada para avisar o usuário.
- Round-robin continua fake.
- Nenhuma decisão sobre onde IA entra foi tomada — isso é debito consciente, não esquecimento, e está explicitamente atribuído a uma etapa futura.

## 11. Fora de escopo (explícito)

- Implementação real de round-robin.
- `departments` / filas / SLA / take-over.
- Extração de fato de `engineSendBase` (só nomeada e autorizada como próximo passo, não executada).
- Unificação do dispatch de precedência (`webhook/route.ts` × `inbound-processor.ts`) em um helper único.
- Implementação de qualquer uma das cinco superfícies mortas de §2.6.
- Event bus.
- `ADR-AI-001`.
- Reconciliação de fronteiras FORCECRM × ROXY.
- Qualquer novo motor de automação/orquestração.
- S2, S3, alterações em RLS, `is_account_member()`, `assigned_agent_id`, migration 075/C21.

---

## Apêndice — evidências citadas

| Afirmação | Arquivo:linha |
|---|---|
| `runAutomationsForTrigger` — fire-and-forget, must-never-throw | `src/lib/automations/engine.ts:53-57` |
| Dois call-sites de produção, mesmos 4 triggers | `src/app/api/whatsapp/webhook/route.ts:824-840`, `src/lib/whatsapp/inbound-processor.ts:380-393` |
| Dedup por janela de 60s (heurística, não constraint) | `src/lib/automations/engine.ts:101-119` |
| Docstring de responsabilidade de Flows | `src/lib/flows/engine.ts:1-33` |
| `trigger_type` CHECK de `flows` | `supabase/migrations/010_flows.sql:84-85` |
| `node_type` CHECK de `flow_nodes` | `supabase/migrations/010_flows.sql:118-129` |
| Índice único de run ativa por contato | `idx_one_active_run_per_contact`, citado em `src/lib/flows/engine.ts:30-32` |
| `dispatchInboundToFlows` — awaited, decide antes de Automations | `src/app/api/whatsapp/webhook/route.ts:758-797` |
| Supressão de gatilhos de conteúdo quando `flowConsumed` | `src/app/api/whatsapp/webhook/route.ts:811-815`, `src/lib/whatsapp/inbound-processor.ts:376` |
| Gatilhos de identidade disparam sempre | `src/app/api/whatsapp/webhook/route.ts:822-823` |
| Cessão explícita de Flows para Automations no fallback `ignore` | `src/lib/flows/engine.ts:1002-1004` |
| `getProvider()` em Automations | `src/lib/automations/meta-send.ts:104` |
| `getProvider()` em Flows (3 call-sites) | `src/lib/flows/meta-send.ts:97,229,400` |
| `engineSendBase` citado só em comentário, não implementado | `src/lib/flows/meta-send.ts:23-28,56-59` (única ocorrência do nome em `src/`) |
| Trigger `conversation_assigned` — tipo/UI/sem dispatcher | `src/types/index.ts:413`, `src/components/automations/automation-builder.tsx:128`, `src/lib/automations/trigger-meta.ts:26-29` |
| Trigger `tag_added` — tipo/UI/validação/sem dispatcher | `src/types/index.ts:414`, `automation-builder.tsx:129`, `src/lib/automations/validate.ts:173-176` |
| Trigger `time_based` — tipo/UI/validação/sem dispatcher | `src/types/index.ts:415`, `automation-builder.tsx:130`, `validate.ts:169-172` |
| Node `http_fetch` — CHECK permite, engine não trata | `supabase/migrations/010_flows.sql:127`, ausência confirmada em `src/lib/flows/engine.ts:576-770` |
| Trigger `manual` — CHECK/API permitem, sem dispatcher de start | `supabase/migrations/010_flows.sql:85`, `src/lib/flows/engine.ts:344`, `src/app/api/flows/[id]/runs/route.ts:19` (só `GET`) |
| Round-robin fake (author-only preservado) | `src/lib/automations/engine.ts:451-464` |
