# ADR-AI-001 — Localização do agente conversacional

| | |
|---|---|
| **Tipo** | Architecture Decision Record — documental. **Não implementa, não cria migration, não altera código de produção.** |
| **Escopo** | Onde executa o agente que responde conversas de WhatsApp **em nome de uma conta do FORCECRM**, e qual o contrato de precedência entre Flows, agente e Automations, incluindo a prevenção de respostas duplicadas. |
| **Deriva de** | `docs/adr/ADR-AUT-001-automations-flows-reconciliation.md` D7 (deferiu a localização de IA) · `docs/architecture/SBD-001-forcecrm-roxy-boundary.md` §4.4 e `BLOQ-1` · `docs/checkpoints/CHECKPOINT-ROXY-COUNTERPART-BLOCKED.md` · `docs/planning/DIGITALL-FORCE-INTELLIGENCE-DIRECTION-2026-08-08.md` §6, §8, §9 |
| **Resolve** | A pergunta de localização de execução do agente: alternativa A (nativo), B (runtime da ROXY) ou C (nativo com reaproveitamento seletivo). |
| **Não resolve** | Acoplamento de produto FORCECRM × ROXY (Rota C), billing de IA, memória cognitiva, RAG, multi-agente, escolha de provider/modelo, e qualquer forma de integração futura entre os dois produtos. |
| **Status** | **Proposto** — decisão documental com revisão técnica/editorial (rev. 1.1 e 1.2, 2026-10-20; §14). **Aprovação arquitetural formal: não registrada.** Nenhum registro de aceite por pessoa ou instância foi localizado no repositório, e este ADR não atribui aprovação a ninguém. Até esse registro, D1–D15 são decisões **propostas**, não aprovadas. **Implementação não autorizada por este ADR** (ver §12). |
| **Autoridade** | Decide **apenas** localização de execução e precedência de turno. Não reabre `ADR-AUT-001` D1/D4/D7, não altera `SBD-001` D5–D13, não decide o roadmap da ROXY. |
| **ADR-AI-002** | **Identificador reservado, não criado.** Fronteira ampla de dados, ações, autoridade, tenant e billing. Este ADR **não** ocupa esse escopo. |
| **Baseline FORCECRM** | `main` @ `3301c77` mais o commit da release de delivery binding e remoção da Z-API (código; migrations `083` e `084`). Nada foi alterado pela auditoria que fundamenta a decisão (rev. 1.0/1.1). A rev. 1.2 (§14) registra uma correção de código **independente** em `src/app/api/whatsapp/send/route.ts` e no teste correspondente, motivada por uma afirmação factual errada deste ADR (§6.5); ela não decorre da decisão aqui tomada. |
| **Baseline ROXY** | Repositório `git@github.com:wscardoso/roxy-agent.git`, `main` @ `845ebf7` (2026-09-01), **working tree com modificações locais não commitadas**. As citações refletem a working tree, não um commit publicado. |
| **Convenção de linhas** | Referências `arquivo:linha` a código do FORCECRM seguem o **código do commit da release** acima (os números de `webhook/route.ts`, `[provider]/.../route.ts` e `inbound-processor.ts` foram remapeados para ele e podem divergir de `3301c77`). Referências a `ADR-AUT-001` seguem o commit **`3301c77`** (`git show 3301c77:docs/adr/ADR-AUT-001-automations-flows-reconciliation.md`): a working tree acrescenta ali uma linha na linha 10 (nota de reconciliação de 2026-10-17), deslocando as demais em +1. Mesma convenção de `SBD-001` e `FORCECRM-ROXY-BOUNDARY`. |
| **Data** | 2026-10-20 |

> **Convenção de identidade documental (2026-10-20).** `ADR-AI-001` designa **este** ADR: localização do agente nativo do FORCECRM e decisão de não importar o runtime da ROXY. `ADR-AI-002` designa a fronteira ampla de **dados, ações, autoridade, tenant e billing**, e permanece **reservado e não criado**. Documentos de planejamento anteriores a esta data usam `ADR-AI-001` para a fronteira ampla; onde isso ocorre, foi inserida nota editorial apontando a nova convenção. O histórico não foi reescrito.

> **Convenção de identificadores de questões (rev. 1.2, 2026-10-20).** `Q1`–`Q13` (§9) e `R-1`–`R-10` (§6.3) pertencem **a este ADR**. `FORCECRM-ROXY-BOUNDARY.md` §13 tem sequência própria `Q1`–`Q12` e `SBD-001` §13 tem `Q1`–`Q9`, com significados diferentes (por exemplo, `Q11` aqui é o handoff de flow sem assignee; `Q11` no documento de fronteira é o ciclo Automation → ROXY → Flow). Toda referência cruzada deve qualificar o documento: `ADR-AI-001 Q11`, `BOUNDARY Q11`, `SBD-001 Q7`. Sem qualificador, `Qn` significa a questão do documento em que aparece. Nenhum identificador foi renumerado.

---

## 0. Nota de método e legenda

Esta decisão foi tomada por leitura de código nos dois repositórios, não por documentação. Onde um documento e o código divergem, **o código prevalece** e a divergência é registrada.

| Marca | Significado |
|---|---|
| `[VERIFICADO]` | Lido diretamente no código, com `arquivo:linha`. |
| `[DOCUMENTADO]` | Escrito em ADR/roadmap/checkpoint do repositório. Pode não corresponder ao código atual. |
| `[OBSERVADO]` | Constatação da auditoria, inclusive ausência. |
| `[NÃO VERIFICADO]` | Não foi possível confirmar nesta auditoria. **Não é afirmação negativa.** |
| `[DECISÃO]` | Decisão deste ADR. |
| `[QUESTÃO]` | Deliberadamente não decidido. |
| `[RISCO]` | Risco registrado, não corrigido aqui. |

**Nenhum teste foi executado, nenhum processo foi iniciado, nenhuma chamada de rede foi feita.** A auditoria que fundamenta a decisão (rev. 1.0/1.1) foi exclusivamente estática. A rev. 1.2 executou testes locais **apenas** para validar a correção de código descrita em §6.5/§14; nenhuma chamada de rede foi feita.

**Regra de não-inferência preservada:** ausência de um artefato no FORCECRM não prova ausência no ecossistema, e vice-versa. Toda afirmação sobre a ROXY é ancorada em arquivo e linha do repositório dela.

---

## 1. Contexto

`ADR-AUT-001` D7 deixou a localização de IA explicitamente em aberto:

> *"A localização concreta de qualquer capacidade de IA (nó dentro de Flows, capacidade de Automations, ou algo distinto) permanece **deliberadamente em aberto** até a reconciliação de fronteiras FORCECRM × ROXY, que é uma etapa posterior e não autorizada aqui."* — `ADR-AUT-001:128` (D7; a frase seguinte de D7 é «Este ADR não cria `ADR-AI-001`, não cria arquitetura de agente/copiloto, não cria event bus para IA.») `[DOCUMENTADO]`

**O que D7 obriga — e o que este ADR não faz.** `[DOCUMENTADO]` D7 contém duas coisas distintas: (i) uma decisão substantiva — IA **não** entra como terceiro motor, e Automations/Flows permanecem os dois mecanismos de orquestração; (ii) um adiamento processual — a localização concreta permanece em aberto até a reconciliação de fronteiras FORCECRM × ROXY, que o próprio D7 descreve como «uma etapa posterior e não autorizada aqui». Este ADR **cumpre (i)** e **não preserva literalmente (ii)**: ele fecha a localização do agente de WhatsApp sem que a reconciliação ampla de produto esteja concluída. A distinção é registrada de propósito. Não se afirma que D7 já autorizava esta decisão; afirma-se que a decisão foi tomada depois, com evidência que D7 não tinha, e que o texto congelado de `ADR-AUT-001` não foi reescrito nem reinterpretado. A ressalva literal de D7 também impede usá-lo como autorização: `ADR-AUT-001` não autorizou a reconciliação nem indicou quem a autorizaria. A legitimidade de fechar a localização aqui depende, portanto, da aprovação arquitetural deste ADR (campo Status), ainda não registrada.

**Por que a decisão não é "no vácuo".** O adiamento de D7 existia para impedir que a localização fosse decidida por especulação sobre a ROXY. A leitura direta do repositório da ROXY (`SBD-001` §4.4) remove essa especulação para a pergunta estreita: a ROXY não é um runtime consumível por outro sistema hoje (§3, §4.2). A fronteira ampla — dados, ações, autoridade, tenant e billing — **não** é decidida por essa evidência e continua adiada.

`SBD-001` registrou `BLOQ-1`: sem evidência do lado ROXY, `R1`–`R10` não podiam ser respondidas e o `ADR-AI-001` não poderia ser escrito (`SBD-001` §BLOQ-1) `[DOCUMENTADO]`. O `CHECKPOINT-ROXY-COUNTERPART-BLOCKED.md:78-95` congelou esse gate. A auditoria de 2026-10-20 localizou o repositório da ROXY e o leu diretamente. Isso levanta **parte** do bloqueio: `R1`, `R3`, `R5`, `R6`, `R7`, `R8` e `R10` passam a ter resposta com evidência (§3); `R2`, `R4` e `R9` permanecem sem verificação de runtime/deploy (§11). O gate de **implementação** não é levantado por isso (§12).

**Por que este ADR é mais estreito do que a fronteira hoje reservada a `ADR-AI-002`.** O documento de direção de 2026-08-08 registrou que a fronteira completa (data/ação/autoridade/tenant/billing) *"não [foi] transformada em contrato arquitetural até a maturidade dos dois produtos permitir"* (`DIGITALL-FORCE-INTELLIGENCE-DIRECTION-2026-08-08.md:91`) `[DOCUMENTADO]`. Este ADR **não revoga essa decisão**. Ele decide uma pergunta menor e bloqueante: para o agente que responde conversas nas contas do próprio FORCECRM, **onde a execução acontece**. Billing, memória, RAG, multi-agente e o acoplamento de produto continuam adiados (§9) e pertencem ao escopo reservado a `ADR-AI-002`.

**Por que decidir agora.** A pergunta "nativo ou ROXY" precede qualquer incremento de implementação: ela define de quem é o ciclo de vida, o estado, a autorização e a observabilidade. Adiá-la mantém a implementação bloqueada sem necessidade, porque a evidência já existe.

---

## 2. Evidência — FORCECRM

### 2.1 O que já existe e pode ser reutilizado

| Capacidade | Estado | Evidência |
|---|---|---|
| Persistência idempotente de entrada | `[VERIFICADO]` | RPC `insert_inbound_message` (`supabase/migrations/034_messages_inbound_idempotency.sql`, `035_inbound_idempotency_rpcs.sql`); chamada em `src/app/api/whatsapp/webhook/route.ts:706`; duplicata interrompe efeitos downstream em `src/lib/whatsapp/inbound-processor.ts:322-328` |
| Precedência Flows → Automations | `[VERIFICADO]` | `webhook/route.ts:796` (Flows, `await`), `:816` (`flowConsumed`), `:832` (supressão), `:859` (Automations); equivalente em `inbound-processor.ts:347,367,376,392` |
| Unicidade de run ativa por **conta + contato** | `[VERIFICADO]` | índice parcial `idx_one_active_run_per_contact` **recriado em `017_account_sharing.sql:337-340`** sobre `(account_id, contact_id)`; a definição original em `010_flows.sql:189-191` era `(user_id, contact_id)` e foi substituída. Consulta: `src/lib/flows/engine.ts:180-199`. Status: `010_flows.sql:165-172`; `068_flow_runs_merge_terminal_state.sql:15-24` |
| Handoff de Flow | `[VERIFICADO]` | `src/lib/flows/engine.ts:434-455` (`assign_to` opcional, `status='pending'`, `endRun(..., "handed_off", "handoff_node")`), `:1050-1061` (fallback esgotado, sem assignee) |
| Envio com integridade transacional | `[VERIFICADO]` | intent antes do envio + settle (`048_outbound_delivery_integrity.sql`, `050_background_system_authorization.sql`), ledger de retry (`049`, `051`, `052`) |
| Marcação de autoria | `[VERIFICADO]` | `messages.sender_type CHECK (..., 'bot')` (`001_initial_schema.sql:166`); Flows grava `sender_type: 'bot'` (`src/lib/flows/meta-send.ts:112,245,415`); Automations idem (`src/lib/automations/meta-send.ts:123`) |
| Isolamento por conta | `[VERIFICADO]` | `messages` **não tem `account_id`** (`001_initial_schema.sql:163-166`); RLS por join com `conversations` (`017_account_sharing.sql:511-517`) |
| Invariante de negócio para deal | `[VERIFICADO]` | `resolveAutomationDealWrite` (`src/lib/deals/status.ts:58`) |
| Cálculo da janela de 24 h | `[VERIFICADO]` | `computeSessionInfo` (`src/lib/inbox/session-window.ts:9-21`), consumido apenas pela thread de inbox (`src/components/inbox/message-thread.tsx:239`). Lista de mensagens **vazia** retorna `expired: false` e `remaining: ""` (`session-window.ts:10`), comportamento fixado por teste (`session-window.test.ts:44-49`) |
| ACK do webhook Meta separado do processamento | `[VERIFICADO]` | `webhook/route.ts:247-252` — `processWebhook(body)` é destacado e a rota responde `200` imediatamente, **sem** garantia de durabilidade do processamento |
| ACK do webhook não-Meta acoplado ao processamento | `[VERIFICADO]` | `[provider]/[connectionId]/[webhookSecret]/route.ts:220` — `await processInboundMessage(...)` antes de responder |
| Base de testes | `[OBSERVADO]` | 34 arquivos em `src/test/`, com suíte PGlite e testes de rota co-localizados |

### 2.2 O que não existe

| Lacuna | Evidência |
|---|---|
| Superfície de IA/LLM | `[OBSERVADO]` zero ocorrências de `openrouter`, `openai`, `anthropic`, `langchain`, `ai-sdk`, `llm`, `agent_runs`, `agent_steps` em `src/`; `package.json:41-64` sem dependência de IA |
| Persistência de execução de agente | `[OBSERVADO]` nenhuma tabela de run, passo, decisão ou outbox em `supabase/migrations/` (numeração `001`–`084`; 81 arquivos, incluindo a `082`, que entrou em `main` pelo PR #25) |
| **Substrato de execução durável** | `[OBSERVADO]` **não existe fila, worker, outbox ou dispatcher de turno.** O caminho Meta destaca `processWebhook(body)` como promessa em memória e responde `200` antes de qualquer persistência (`webhook/route.ts:247-252`); o caminho não-Meta aguarda todo o processamento dentro da requisição (`.../[provider]/.../route.ts:220`). Nenhum dos dois sobrevive à queda do processo. |
| Garantia de recuperação após queda | `[OBSERVADO]` nenhuma. Não há retomada, replay ou claim persistido de turno. |
| Contexto de agente | `[OBSERVADO]` nenhum módulo; os dados existem dispersos |
| Catálogo de ferramentas reutilizável | `[VERIFICADO]` `runStep` é função privada (`src/lib/automations/engine.ts:465`) — não exportada |
| Enforcement de janela no servidor | `[VERIFICADO]` a rota de envio não valida janela: `src/app/api/whatsapp/send/route.ts` não contém verificação de expiração (as únicas menções numéricas são limites de bytes/caracteres em `:79` e `:151`) |
| Flag de agente por conta | `[VERIFICADO]` `beta_features` é por **profile** (`supabase/migrations/011_profile_beta_features.sql:29`), não por tenant |
| Rate limit distribuído | `[VERIFICADO]` `Map` em memória por processo (`src/lib/rate-limit.ts:46`) |

### 2.3 Consequência

`[OBSERVADO]` O FORCECRM tem **tudo o que é caro**: dados, tenancy, idempotência, entrega, testes. Falta-lhe a camada de decisão — que é a parte barata e a única que um runtime externo ofereceria.

---

## 3. Evidência — ROXY

### 3.1 Identidade e maturidade

| Fato | Evidência | Confiança |
|---|---|---|
| Produto em bootstrap | `README.md:22` — *"Fundação em bootstrap (R0 em andamento)"*. **Drift interno:** `ROADMAP.md:12-18` marca R0 concluído e `:37-44` registra R1 satisfeito em 2026-08-06. O README está desatualizado; nenhuma das duas fontes prova maturidade de runtime. | Baixa |
| Código atual vive em uma skill, não na arquitetura-alvo | `ROXY-ARCHITECTURE.md:155-157` — *"Isso **não** é a arquitetura-alvo; é a forma atual de carregar o skill."* | Alta |
| R2 Soul sem status de conclusão | `ROADMAP.md:46-54` — seção de capacidade, sem checkbox nem status | Média |
| R3 Memória não concluída | `ROADMAP.md:56-64` — seção de capacidade, sem checkbox nem status | Média |
| R4 Audit engine não concluído | `ROADMAP.md:66-74` — idem | Média |
| R5 Operação não concluída | `ROADMAP.md:76-84` — idem | Média |
| R6 SDK não concluído | `ROADMAP.md:86-93` — idem | Média |

`[OBSERVADO]` "System of Record" × "System of Intelligence" está escrito e é coerente: `ROXY-ARCHITECTURE.md:125-132` atribui ao Force CRM o registro dos dados e à ROXY a interpretação. A fronteira conceitual existe; a implementação da fronteira, não.

### 3.2 Runtime e ciclo de execução

`[VERIFICADO]` O contrato de turno é mínimo e não tem campo de contexto:

```ts
// src/runtime/agent-runtime.ts:20-25
export interface AgentTurnRequest {
  organizationId: string
  conversationId: string
  content: string
  identity: ComposedIdentity
}
```

O próprio arquivo proíbe ampliar: *"Nao adicionar campos (context/memory/skills/tools/metadata) sem uma decisao de produto registrada"* (`agent-runtime.ts:3-4`).

`[VERIFICADO]` A execução real é um `spawnSync('hermes', args, { timeout: 120000 })` — **síncrono e bloqueante** (`runtime/hermes-runtime-adapter.ts:283-300`, timeout em `:286`). Em um processo Node que atende webhooks, isso bloqueia o event loop por todo o turno.

`[VERIFICADO]` O resultado é a **última linha não vazia do stdout**, com fallback literal `'sem resposta'` (`:242-247`). `runChat` devolve `exitCode` (`:304`), mas `send()` **nunca o lê** (`:209-249`): uma falha do runtime retorna texto vazio como se fosse resposta bem-sucedida.

`[VERIFICADO]` O `sessionRef` é extraído do stderr por regex (`:231-238`) e guardado em `Map` em memória (`:46`). Reinício do processo perde a continuidade de todas as conversas.

### 3.3 Contexto e memória

`[VERIFICADO]` Nenhum contexto de CRM atravessa a fronteira. `send()` transmite `content` + `identity` (`:195,209-217`); `identity` é inerte por padrão (`agent-runtime.ts:14`). A documentação confirma a intenção: *"`DomainEvent.metadata.raw` existe, mas só é usado para forward ao Force CRM - nunca chega ao `HermesClient`"* (`ROXY-RUNTIME-CONTRACT.md:43`) `[DOCUMENTADO]`.

`[VERIFICADO]` Não há módulo de memória em `src/`; memória é interna ao Hermes, sob uma única `HERMES_HOME` (`hermes-runtime-adapter.ts:289`, `config.ts:28`).

### 3.4 Ferramentas e permissões

`[VERIFICADO]` Ferramentas são 100% do runtime, não da ROXY (`ROXY-RUNTIME-CONTRACT.md:46` `[DOCUMENTADO]`; contrato sem campo de tools em `agent-runtime.ts:20-36`).

`[VERIFICADO]` O Authorization Gate governa **uma única ferramenta**, `write_file`, com bound de caminhos sensíveis (`platform-policy/ratified.ts:8,15-29,38`). Ferramentas sem policy ratificada são **permitidas** (`authorization-gate/evaluate.ts:79-85`, reason code `no_ratified_policy_for_tool`). Portanto **não é** um mecanismo geral de autorização de ações de CRM.

`[VERIFICADO]` O gate é um hook `pre_tool_call` do Hermes (`.claude/skills/roxy-agent/hermes-plugins/roxy-authorization-gate/__init__.py:1`), com fallback HTTP em loopback `127.0.0.1` (`authorization-gate/loopback-server.ts:67,153`). Não é API de rede.

### 3.5 Persistência, idempotência e concorrência

| Capacidade | Estado | Evidência |
|---|---|---|
| Persistência de execuções | Ausente | `[OBSERVADO]` nenhum `CREATE TABLE`/`INSERT`/SQLite em `src/`; auditoria D12 aberta (`STATUS-UPDATE-2026-08-28-FASE3.md` §2) |
| Idempotência | Em memória, teto 500 | `[VERIFICADO]` `channels/zapi.ts:35,47,60-62` |
| Concorrência | Nenhum lock/fila | `[VERIFICADO]` `spawnSync` serializa por bloqueio |
| Retry de turno | Ausente | `[VERIFICADO]` `RETRY_DELAYS` só no `connect()` (`hermes-runtime-adapter.ts:19,93-94`) |
| Recuperação após crash | Nenhuma | `[VERIFICADO]` `Map` em memória (`:46,61,65`) |

### 3.6 Tenant e isolamento

`[VERIFICADO]` `organizationId` é uma variável de ambiente **por processo**, não por requisição (`config.ts:20-24,33`). Não há tabela de contas, nem seleção de tenant no contrato de turno.

`[VERIFICADO]` O canal WhatsApp tem uma única instância e uma allowlist global de remetentes, **fail-closed** quando vazia (`channels/zapi.ts:236-239`; config em `config.ts:39-40`).

`[OBSERVADO]` Consequência: a ROXY é **single-tenant por processo**. Servir N contas exigiria N processos com `HERMES_HOME` e allowlist distintos — o que o contrato classifica como decisão "FUTURA" (`ROXY-RUNTIME-CONTRACT.md:321` `[DOCUMENTADO]`).

### 3.7 Observabilidade

`[OBSERVADO]` 68 chamadas `console.*` em `RS` (`.claude/skills/roxy-agent/src`), em 8 arquivos: 55 `console.log` e 13 `console.error` (nenhum `warn`/`info`/`debug`). Critério: `grep -rnE 'console\.(log|error|warn|info|debug)\(' --include=*.ts` sobre `RS`; não há `*.test.ts` em `RS`, então incluir ou excluir testes não muda o total. Por arquivo: `index.ts` 30, `channels/zapi.ts` 25, `channels/index.ts` 4, `channels/telegram.ts` 3, `authorization-gate/mvp-execution-harness.ts` 2, `authorization-gate/mvp-production-bridge.ts` 2, `events/domain-event.ts` 1, `events/subscribers/force-crm-subscriber.ts` 1. Medido em 2026-10-20 na working tree da ROXY (`845ebf7` com modificações locais). A versão anterior deste ADR registrava 37; o valor não é reproduzível por esse critério e foi corrigido. Nenhum logger estruturado, nenhum tracing, nenhuma tabela de auditoria. O `identity_context` por turno está especificado (`ROXY-RUNTIME-CONTRACT.md:258-270`) mas **não é persistido** — não há escrita de auditoria em `src/`.

### 3.8 Divergências documento × código (registradas)

`[VERIFICADO]` A documentação da ROXY descreve um runtime que não existe mais. O código atual é `runtime/hermes-runtime-adapter.ts`, com `spawnSync` (`:283-300`); `hermes-client.ts` foi removido e não há `src/mcp/`. A conclusão substantiva do contrato — shell-out textual, sem estrutura — permanece válida; o mecanismo mudou.

| Documento da ROXY | Afirmação obsoleta | Estado verificado no código |
|---|---|---|
| `ROXY-RUNTIME-CONTRACT.md:26-27,298-311,317,334` | `execSync('hermes chat -q ...')`, `hermes-client.ts` | `spawnSync` em `runtime/hermes-runtime-adapter.ts:283-300`; arquivo citado inexistente |
| `ROXY-RUNTIME-CONTRACT.md:81-83` | parsing de stdout/sessão em `hermes-client.ts:101-121` | `send()` lê stdout e stderr (`hermes-runtime-adapter.ts:219-247`) |
| `ROXY-HERMES-BOUNDARY.md:41,52,57,76-78,127-131,157,275,299-337` | `execSync` e `mcp/hermes-client.ts` como fronteira atual | idem |
| `ROXY-HERMES-DELIVERY-STRATEGY.md:48,122-130,201,257` | `HermesClient.runChat` / `execSync` | idem |
| `ROXY-RUNTIME-CONTRACT.md:40` | `conversationId` "descartado" por `HermesClient`; bug de sessão global | `sessionRefs` indexado por `req.conversationId` (`:191,239`) e `--resume` por chamada (`:192`) |
| `ROXY-RUNTIME-CONTRACT.md:41-42` | Core Identity "não existe em código nenhum"; "nenhum conceito de organização no código" | `ComposedIdentity` (`agent-runtime.ts:7-11`), `EMPTY_IDENTITY` (`:14-18`) e `ROXY_ORGANIZATION_ID` (`config.ts:20-24`) existem; o Compiler continua ausente |
| `README.md:22` | "Fundação em bootstrap (R0 em andamento)" | `ROADMAP.md:12-18` marca R0 concluído; `:37-44` registra R1 satisfeito em 2026-08-06 |

`[OBSERVADO]` Nenhuma dessas divergências altera a conclusão deste ADR: a ROXY continua sem API de turno, sem tenancy por requisição e sem persistência de execução. Elas importam para não tratar como autoridade um documento que descreve outro runtime.

### 3.9 O que a ROXY faz bem

| Ativo | Evidência | Natureza |
|---|---|---|
| Decisão de autorização com `allow`/`deny`/`evaluation_failure` + `reason_code` + identidade | `authorization-gate/evaluate.ts:29-58,106-114` | **Padrão** reutilizável |
| Fail-closed em falha de avaliação | `evaluate.ts:46-58`; plugin `__init__.py:34` | **Padrão** reutilizável |
| Compiler puro, determinístico, com códigos de rejeição | `compiler/compile.ts:6-15,35` | **Padrão** reutilizável |
| Contrato mínimo de runtime que sobreviveu a dois runtimes | `runtime/agent-runtime.ts:20-36` | **Padrão** reutilizável |
| Fronteira System of Record × System of Intelligence | `ROXY-ARCHITECTURE.md:125-132` | **Padrão** reutilizável |

Nenhum desses itens é um componente executável contra o FORCECRM hoje. São decisões de desenho, não código importável — e a importação direta é inviável: os módulos usam extensões explícitas (`from './decider.ts'`) e o `tsconfig.json:11` do FORCECRM usa `moduleResolution: "bundler"` sem `allowImportingTsExtensions`.

---

## 4. Alternativas

- **A — Agente nativo:** o FORCECRM controla ciclo de vida, contexto, ferramentas e persistência.
- **B — ROXY como runtime:** o FORCECRM mantém dados e permissões; a execução do turno é delegada à ROXY.
- **C — Reutilização seletiva:** execução nativa, adotando apenas padrões da ROXY com benefício demonstrado e baixo acoplamento.

### 4.1 Comparação por critério

| Critério | A — Nativo | B — ROXY runtime | C — Seletivo |
|---|---|---|---|
| **Isolamento entre contas** | Atende. RLS + `is_account_member` (`017:511-517`), desde que `account_id` venha do servidor. Limitação: `messages` sem `account_id` exige join. `[Alta]` | **Não atende.** `organizationId` é env global (`config.ts:20-24`); sem tabela de contas; allowlist única (`zapi.ts:236-239`). `[Alta]` | Igual a A, com decisão explícita de autorização fail-closed. `[Alta]` |
| **Ciclo de vida da conversa** | Total: `conversations`, `messages`, `flow_runs` são do FORCECRM. `[Alta]` | Dividido: `sessionRef` em memória (`hermes-runtime-adapter.ts:46`), histórico no CRM, decisão na ROXY. Dois donos do mesmo estado. `[Alta]` | Igual a A. `[Alta]` |
| **Compatibilidade com Flows/Automations** | Compatível se a precedência for explícita (§6). `[Média]` | Incompatível: a ROXY não conhece Flows nem Automations; não há como suprimir gatilhos. `[Alta]` | Igual a A, com o padrão de decisão registrando o motivo da supressão. `[Média]` |
| **Idempotência/concorrência/recuperação** | Âncora existente (`insert_inbound_message`); padrão de índice parcial já usado (`017:337-340`). Falta `agent_runs`. `[Alta]` | **Não atende.** Dedupe em `Set` de 500 (`zapi.ts:35,47,60-62`); sem run store; sem lock; `send()` ignora `exitCode` (`:209-249`). `[Alta]` | Igual a A. `[Alta]` |
| **Contexto do CRM** | Acesso direto ao banco, sem serialização. `[Alta]` | **Bloqueado por contrato.** `AgentTurnRequest` não tem `context`; `agent-runtime.ts:3-4` proíbe adicionar sem decisão de produto. `[Alta]` | Igual a A. `[Alta]` |
| **Complexidade de implementação** | Média: migration + runner + contexto + cliente `fetch` + ferramentas + cron. `[Média]` | Alta: exige API de turno, tenancy por request, persistência, ferramentas e execução assíncrona — reescrever a ROXY antes de integrar. `[Alta]` | Média: A + portar dois padrões. `[Média]` |
| **Dependências e manutenção** | Uma stack; nenhuma dependência nova se o cliente for `fetch`. `[Alta]` | Quatro superfícies (Next, roxy-agent/Node, Hermes/Python, plugin do gate), com binário `hermes` invocado sem versão fixada (`:283`). `[Alta]` | Igual a A. `[Alta]` |
| **Observabilidade/auditoria** | A construir, no mesmo banco, consultável por SQL. `[Média]` | **Ausente:** `console.log` apenas; auditoria D12 aberta. `[Alta]` | A + formato de decisão da ROXY como schema. `[Média]` |
| **Testabilidade/evolução** | Forte: Vitest + PGlite, 34 arquivos. `[Alta]` | Dois sistemas + binário Python; sem teste de contrato entre eles. `[Média]` | Igual a A. `[Alta]` |
| **Risco de 2ª fonte de verdade** | Médio, mitigável obrigando as ferramentas a chamar as funções de domínio existentes. `[Média]` | **Alto:** o CRM registra, a ROXY decide e responde, sem transação comum. `[Alta]` | Médio, com o mesmo mitigador. `[Média]` |

### 4.2 Os quatro bloqueios objetivos de B

`[VERIFICADO]` B não perde por preferência; perde por quatro impedimentos independentes, cada um suficiente para inviabilizar produção:

1. **Não há API de turno.** As únicas portas são o webhook Z-API (`zapi.ts:87`) e o loopback do gate (`loopback-server.ts:153`).
2. **Não há tenancy por requisição.** `organizationId` é fixo por processo (`config.ts:20-24,33`).
3. **Não há persistência de execução.** `Map` em memória (`hermes-runtime-adapter.ts:46,61,65`); auditoria D12 aberta.
4. **A execução é síncrona e bloqueante.** `spawnSync` com timeout de 120 s (`:283-300`).

#### 4.2.1 O que nem A nem B resolve hoje: substrato de execução

`[OBSERVADO]` A escolha de A **não** cria, por si, execução durável. O FORCECRM também não tem fila, worker, outbox ou dispatcher de turno (§2.2). Hoje o webhook Meta responde `200` e deixa `processWebhook` como promessa em memória (`route.ts:247-252`); o webhook não-Meta aguarda o processamento inteiro antes de responder (`.../[provider]/.../route.ts:220`). Em nenhum dos dois existe recuperação após queda do processo.

Isso é um **quinto bloqueio de produção**, mas não é um bloqueio específico de B: afeta A e C igualmente. Ele é tratado como decisão própria em D15 e §6.6, e a escolha do substrato permanece aberta (Q10). Nenhuma fila, worker ou garantia de execução durável é afirmada aqui.

### 4.3 Por que C, e não A "puro"

A e C produzem o mesmo runtime. A diferença é disciplina: C compromete-se a **adotar explicitamente** os padrões que a ROXY já validou, em vez de reinventá-los. O custo é baixo (portar forma, não código) e o benefício é verificável (decisão fail-closed com reason codes, contrato de turno estável). C domina A por não deixar a decisão de autorização implícita.

---

## 5. Decisão

`[DECISÃO D1]` — **Alternativa C: agente nativo no FORCECRM, com reaproveitamento seletivo de padrões da ROXY. Nenhum código da ROXY é importado; nenhuma dependência de runtime da ROXY é criada.**

`[DECISÃO D2]` — **O agente é uma camada reativa de turno, não um terceiro motor de orquestração.** Ele não possui grafo, estado conversacional próprio, agendamento nem fila de espera próprios. Ele decide, dentro de um turno já persistido, se responde, com o quê, ou se entrega a um humano. `ADR-AUT-001` D1/D7 permanecem intactos: Automations e Flows continuam sendo os dois motores. **Precisão:** "não possui fila própria" não significa execução síncrona; o substrato de execução é decidido em D15 e não está implementado.

`[DECISÃO D3]` — **A precedência é Flows → agente → Automations** (§6). Flows continua avaliando primeiro e continua sendo quem decide `consumed`.

`[DECISÃO D4]` — **Consumo pelo agente suprime os gatilhos de conteúdo de Automations** para a mesma mensagem, com a mesma semântica de `flowConsumed`.

`[DECISÃO D5]` — **Invariante delimitada: para uma mesma mensagem de entrada, o agente e uma automação não produzem envio ambos.** A invariante cobre o par **agente × automação**. Ela **não** afirma exclusividade global entre automações: duas automações distintas ainda podem responder à mesma mensagem, porque o dedupe existente é uma janela de 60 s por automação e não uma constraint (§7.3).

`[DECISÃO D6]` — **A saída do agente não reentra no pipeline de entrada.** Ela é uma mensagem de saída normal (`sender_type='bot'`), nunca um evento que dispare Flows ou Automations. Isso preserva `SBD-001` D12 e fecha o ciclo `Agent → Flow → Automation → Agent`.

`[DECISÃO D7]` — **Fatos de negócio continuam no FORCECRM** (`SBD-001` D5/D8). Ferramentas do agente chamam as mesmas funções de domínio já usadas pelos motores — em especial `resolveAutomationDealWrite` (`src/lib/deals/status.ts:58`) e as implementações de envio (`src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts`) — em vez de SQL paralelo. `runStep` não é exportada (`engine.ts:465`); a extração é trabalho de implementação, não uma licença para duplicar invariantes.

`[DECISÃO D8]` — **`account_id` é resolvido no servidor e nunca aceito do modelo.** Toda ferramenta recebe o contexto de conta já validado; o modelo não tem parâmetro para escolher tenant. É a mesma propriedade de `src/lib/auth/api-context.ts:110-117` aplicada internamente.

`[DECISÃO D9]` — **A janela de 24 h limita o envio de texto livre, não a elegibilidade do agente.** Hoje ela é calculada apenas para a UI (`session-window.ts:9-21`, chamado em `message-thread.tsx:239`) e não é validada na rota de envio. O cálculo parte da **última mensagem do cliente** e considera expirado a partir de 24 h. Com mensagens mas nenhuma do cliente, o resultado é `expired: true`; com a lista **vazia**, é `expired: false` (§6.1). `[OBSERVADO]` Uma verificação de servidor para conversa sem nenhuma mensagem precisaria tratar esse caso explicitamente; essa escolha não é feita aqui (Q12). O agente não pode enviar texto livre com a janela fechada; nesse caso ele entrega a um humano ou não age (R-9). Template fora de janela está fora de escopo (Q5).

`[DECISÃO D10]` — **A habilitação é por conta, default desligada.** `beta_features` é por profile (`011:29`) e não serve como flag de tenant; a flag deve viver em `accounts`. Com a flag desligada, o comportamento é indistinguível do atual.

`[DECISÃO D11]` — **Toda ferramenta passa por uma decisão de autorização fail-closed** com `allow`/`deny`/`evaluation_failure` e `reason_code`, adotando a forma de `authorization-gate/evaluate.ts:29-58`. Falha de avaliação nega; nunca concede.

`[DECISÃO D12]` — **A ROXY permanece produto independente.** Este ADR decide apenas onde o agente do FORCECRM executa; não reposiciona a ROXY, não aposenta sua arquitetura, não cria acoplamento. A Rota C (`DIGITALL-...:75`) não é reaberta.

`[DECISÃO D13]` — **Nenhuma dependência nova de runtime é introduzida.** Cliente LLM por `fetch` nativo, configuração por variáveis de ambiente, sem SDK. O provider e o modelo não são decididos aqui.

`[DECISÃO D14]` — **Persistência de execução é pré-requisito do primeiro turno real.** Sem registro de run, passo, decisão e resultado, o agente não entra em produção — nem atrás de flag.

`[DECISÃO D15]` — **ACK rápido e execução durável são responsabilidades separadas — decisão proposta, não implementada.** O reconhecimento HTTP do webhook não pode ser o mecanismo de execução do turno: o ACK deve ocorrer **após a persistência mínima** que permite retomada e **não** deve esperar a chamada ao modelo; a execução do agente deve partir de um registro durável e idempotente, ancorado em `messages.id`. Isto é uma direção arquitetural, não uma descrição do presente: **não existe hoje fila, worker, outbox ou garantia de execução durável** (§2.2), e o substrato de execução **não é escolhido aqui** (Q10). A escolha do substrato é pré-requisito do primeiro turno real (P10), ao lado de D14.

---

## 6. Contrato de precedência

### 6.1 Definições

| Termo | Definição |
|---|---|
| **Turno** | Uma mensagem de entrada **já persistida** por `insert_inbound_message`, identificada por `messages.id`. O turno não é a requisição HTTP que a transportou; essa distinção é o fundamento de D15. |
| **`flowConsumed`** | Booleano já existente, devolvido por `dispatchInboundToFlows` (`flows/engine.ts:846-899`). `true` inclui avanço, início de run, handoff e duplicata ignorada; `false` inclui ausência de match, fallback `ignore` e exceção interna (`:888,897,1021`). |
| **`agentConsumed`** | Novo booleano. `true` somente se o agente (a) enviou ao menos uma mensagem, ou (b) executou `handoff_to_human`. Erro, recusa ou ausência de resposta ⇒ `false`. |
| **Run de flow ativa** | `flow_runs` com `status='active'` para o par **`(account_id, contact_id)`** — não para a "conversa" em abstrato. A constraint vigente é o índice parcial `idx_one_active_run_per_contact` **recriado em `017_account_sharing.sql:337-340`** sobre `(account_id, contact_id)`; a versão de `010_flows.sql:189-191` era `(user_id, contact_id)` e foi substituída. Consulta: `src/lib/flows/engine.ts:180-199`. Status: `010_flows.sql:165-172` e `068_flow_runs_merge_terminal_state.sql:15-24`. |
| **Handoff de Flow** | Efeito verificado em `flows/engine.ts:434-455`: grava `conversations.status='pending'`, grava `assigned_agent_id` **somente se** `config.assign_to` existir, registra evento `handoff` e encerra a run como `handed_off`. O fallback esgotado (`:1050-1061`) faz o mesmo **sem** atribuir ninguém. Handoff **não** envia mensagem por si e **não** prova que um humano assumiu; significa "retirado da automação e colocado na fila humana". |
| **Janela de 24 h** | Calculada a partir da **última mensagem `sender_type='customer'`**; expirada quando `hoursSince >= 24` (`session-window.ts:18-19`). Com mensagens e nenhuma `customer`, `expired: true` (`:16`); com lista **vazia**, `expired: false` e `remaining: ""` (`:10`; teste `session-window.test.ts:44-49`). Hoje é calculada apenas na UI (`message-thread.tsx:239`) e não é validada na rota de envio. |
| **Agente elegível (invocação)** | Flag da conta ligada **e** conversa sem `assigned_agent_id` (`075:61-62`) **e** sem run de flow ativa **e** mensagem não é eco do próprio negócio **e** não é duplicata. **A janela não entra aqui** — ver linha seguinte e Q12. |
| **Envio de texto livre autorizado** | Janela de 24 h aberta. Fechada ⇒ nenhum texto livre, mesmo que o agente seja invocado (R-9; D9). |
| **ACK** | Resposta HTTP ao provider. Não é execução: pode anteceder, coincidir ou suceder o processamento, e hoje difere entre os dois webhooks (§2.2). |

### 6.2 Ordem

`[OBSERVADO]` A ordem abaixo é **lógica**, não a ordem de uma única requisição. Hoje o webhook Meta responde `200` antes de `[1]` (`route.ts:247-252`); o webhook não-Meta responde somente depois de `[6]` (`.../[provider]/.../route.ts:220`). D15 separa ACK de execução, mas o substrato que realizaria essa separação **não existe** (Q10).

```
[1] persistir entrada (idempotente)
      │ duplicata → parar
      ▼
[2] Flows (await)  ──────────────► flowConsumed?
      │                                  │
      │                                  ├── true  → agente NÃO roda ──► [6]
      │                                  └── false → [3]
      ▼
[3] run de flow ativa? ── sim ──► agente NÃO roda ──► [6]
      │ não
      ▼
[4] agente elegível? ──── não ──► agente NÃO roda ──► [6]
      │ sim
      ▼
[5] agente decide ──► agentConsumed? ──► [6]

[6] Automations
      • gatilhos de conteúdo: suprimidos se flowConsumed OU agentConsumed
      • gatilhos de identidade: regra R-6
```

`[OBSERVADO]` Todo ramo em que o agente não roda, não é elegível ou não consome desemboca em **[6] Automations**; a única saída antecipada é a duplicata em [1]. [3] é a condição «sem run de flow ativa» de §6.1 e aparece separada apenas porque R-3 a trata como regra própria. Uma versão anterior deste diagrama encaminhava «agente elegível? não» a «agente decide»; isso contradizia §6.1 e R-4, e foi corrigido na rev. 1.2.

### 6.3 Regras

| # | Regra |
|---|---|
| **R-1** | Flows avalia primeiro, com `await`, e mantém a palavra final sobre `consumed`. Nada em `ADR-AUT-001` D4 muda para o par Flows × Automations. |
| **R-2** | Se `flowConsumed === true`, o agente não roda. A mensagem pertence ao flow. |
| **R-3** | Se existe run de flow `active` para o par `(account_id, contact_id)`, o agente não roda — mesmo quando `flowConsumed === false`. Um flow em `collect_input` é dono do diálogo; uma resposta livre do agente intercalaria com os prompts do flow. **Consequência explícita do fallback `ignore`:** `decideFallback` devolve `consumed: false` e mantém a run `active` (`engine.ts:1019-1021`). As automações podem responder; o agente **não**. Como a run continua ativa, todo inbound seguinte permanece bloqueado para o agente até a run avançar, encerrar ou ser varrida por `on_timeout_hours` (padrão 24 h) no cron `src/app/api/flows/cron/route.ts:84-92`. Nesse cenário, o agente pode ficar até 24 h sem atuar naquela conversa, por decisão do flow. |
| **R-4** | Agente só roda quando elegível (§6.1). Conversa atribuída a humano ⇒ agente inativo. **Lacuna registrada:** o handoff sem `assign_to` grava `status='pending'` e **nenhum** `assigned_agent_id` (`engine.ts:444-455`). R-4, como está, não exclui esse caso; Q11 registra a decisão pendente. |
| **R-5** | `agentConsumed === true` suprime `new_message_received` e `keyword_match` para aquela mensagem. `agentConsumed === false` não suprime nada. **A supressão é apenas agente × automação.** Ela não cria exclusividade entre duas automações (§7.3). |
| **R-6** | Gatilhos de identidade (`new_contact_created`, `first_inbound_message`) continuam disparando sempre, conforme `ADR-AUT-001` D4. **Para evitar saudação dupla:** se existir automação ativa com qualquer desses dois gatilhos, o agente **não é elegível para a primeira mensagem inbound do contato** — o onboarding determinístico tem primazia. A partir da segunda mensagem, o agente concorre normalmente. `[OBSERVADO]` A consulta "existe automação ativa com esse gatilho" não existe hoje; é trabalho de implementação. |
| **R-7** | A saída do agente é inserida como mensagem de saída (`sender_type='bot'`) e **nunca** é passada a `dispatchInboundToFlows` ou `runAutomationsForTrigger`. |
| **R-8** | Falha do agente antes de qualquer envio ⇒ `agentConsumed=false` e o fluxo determinístico segue. Falha depois de um envio ⇒ `agentConsumed=true` (o efeito já ocorreu), run marcada como falha, sem novo envio. |
| **R-9** | Janela de 24 h fechada ⇒ **nenhum envio de texto livre**, mesmo que o agente seja invocado. Se invocado, o agente só pode executar `handoff_to_human` ou nenhuma ação. Template fora de janela está fora de escopo (Q5). A janela limita o **envio**, não a invocação — Q12. |
| **R-10** | Flag desligada ⇒ nenhuma run, nenhuma chamada de modelo, nenhuma alteração observável em Flows ou Automations. |

### 6.4 O que muda em relação a `ADR-AUT-001` D4

Nada, para o par que D4 governa. D4 continua: Flows primeiro, consumo suprime conteúdo, identidade sempre dispara. Este ADR **insere um passo** entre Flows e Automations e define a regra de supressão do par **agente × Automations**. O passo é condicional à flag e à elegibilidade; com a flag desligada, a ordem executada é exatamente a atual.

### 6.5 `flow_runs.status='paused_by_agent'`: o que existe e o que este contrato não usa

`[VERIFICADO]` `flow_runs.status='paused_by_agent'` existe no CHECK (`010_flows.sql:170`; `068_flow_runs_merge_terminal_state.sql:21`) **e é escrito por código de produção**: `POST /api/whatsapp/send` (função `pauseFlowRunsOnAgentSend`, `src/app/api/whatsapp/send/route.ts`, chamada nos dois caminhos de provider) atualiza as runs `active` do par `(account_id, contact_id)` para `status='paused_by_agent'`, `ended_at=now()`, `end_reason='agent_replied'`, depois de um envio que liquidou como `sent` (ODI-001 §7, gate N-3). Não há outro escritor em `src/`; as demais ocorrências são tipo e rótulo (`src/lib/flows/types.ts:272`, `src/app/(dashboard)/flows/[id]/runs/page.tsx:84`) e fixtures de teste (`src/test/identity-merge.pglite.test.ts:191,1156`). A escrita existe desde `d0b50f4`. O único chamador da rota é a thread de inbox (`message-thread.tsx:462,526,611`).

`[OBSERVADO]` Semântica efetiva:

- "agent" nesse status é o **atendente humano** autenticado que enviou pela caixa de entrada, não o agente de IA deste ADR. Os envios de Flows e Automations (`sender_type='bot'`) usam `flows/meta-send.ts` e `automations/meta-send.ts` e não passam por essa rota.
- É **terminal**, apesar do nome: `ended_at` é preenchido e nenhum código reativa a run. O índice de unicidade restringe apenas runs `active` (`017_account_sharing.sql:337-340`).
- Seu efeito se limita a `flow_runs`: não grava `assigned_agent_id`, não altera `conversations.status`, não registra evento de handoff e não toca Automations.
- Dispara em qualquer envio humano bem-sucedido (texto, mídia ou template), com ou sem conversa atribuída.

`[CORREÇÃO rev. 1.2]` A versão anterior deste parágrafo afirmava que nenhum código de produção escreve o status; estava errada. Além disso, até a rev. 1.2 a escrita cobria **só o caminho Meta** da rota: o caminho não-Meta (Z-API/UAZAPI) não encerrava as runs, de modo que um flow em `collect_input` continuava consumindo a resposta do cliente depois de um humano ter respondido. Isso foi corrigido na rev. 1.2, com teste (§14).

`[DECISÃO preservada]` O contrato de precedência acima **continua sem depender** desse status, e a existência dele **não equivale a handoff de IA** nem resolve Q11: ele registra apenas "um humano respondeu e a run de flow terminou". Nenhuma verificação de elegibilidade do agente o lê, e este ADR não decide usá-lo como sinal de elegibilidade. `[OBSERVADO]` Consequência a considerar em Q11: como a resposta humana encerra a run mas não atribui a conversa (nem a rota nem os chamadores verificados gravam `assigned_agent_id`; a atribuição na thread é ação explícita, `message-thread.tsx:774`), R-3 e R-4, como escritos, não excluiriam o agente nas mensagens seguintes. Isso é lacuna de contrato, não decidida aqui.

### 6.6 ACK, execução durável e o que ainda não existe

`[DECISÃO D15]` A separação é arquitetural; o mecanismo, não.

| Dimensão | Decidido | Não decidido |
|---|---|---|
| ACK | Não espera a chamada ao modelo. Responde ao provider depois da persistência mínima que permite retomada. | Qual é exatamente essa persistência: a própria linha de `messages` ou um envelope de execução separado. |
| Execução | Parte de um registro durável, sobrevive à queda do processo e é idempotente por `messages.id`. | Substrato: fila, worker, cron com claim, outbox + dispatcher ou outro (Q10). |
| Ordem e concorrência | Um turno por mensagem; a serialização por conversa é requisito (§7.2, camada 7). | Mecanismo de lock, política de retry/backoff, limite de concorrência e semântica de DLQ. |
| Caminho não-Meta | Não pode continuar acoplando o ACK ao turno inteiro. | Como deixará de fazê-lo — o mesmo substrato ou outro. |
| Observabilidade | Run, passo, decisão e resultado persistidos (D14). | Formato, retenção e consultas. |

`[OBSERVADO]` **Nada disso está implementado.** O caminho Meta responde antes da persistência (`route.ts:247-252`); o não-Meta aguarda o processamento (`.../[provider]/.../route.ts:220`); não há fila, worker ou outbox no repositório.

`[QUESTÃO Q10]` — **Qual substrato de execução durável.** É pré-requisito do primeiro turno real (P10), não uma decisão que este ADR possa tomar por analogia. Nenhuma fila, worker ou garantia de execução é afirmada enquanto a escolha não for registrada em decisão própria.

---

## 7. Prevenção de resposta duplicada

### 7.1 Invariante

`[DECISÃO]` Para uma mesma mensagem de entrada, **o agente e uma automação não produzem envio ambos**. A invariante é **par a par** (agente × automação) e pressupõe que as camadas 2–8 de §7.2 existam; nenhuma delas existe hoje.

`[OBSERVADO]` A invariante **não** afirma que o sistema garante uma única resposta automática por mensagem. Duas automações distintas podem responder à mesma mensagem (§7.3). Também não há garantia de que o agente e uma automação não respondam quando a flag de supressão falhar entre a decisão e o envio — a camada 6 é requisito, não estado atual.

### 7.2 Camadas

| # | Camada | O que impede | Estado |
|---|---|---|---|
| 1 | Idempotência de entrada (`insert_inbound_message`, `034`/`035`) | Reprocessar a mesma mensagem | Existente |
| 2 | Flag única de decisão (`agentConsumed`) | Agente e Automação decidirem sem saber um do outro | A criar |
| 3 | Exclusão por flow ativo (R-3), chave `(account_id, contact_id)` | Agente intercalar em diálogo deterministicamente conduzido | A criar |
| 4 | Exclusão por atribuição humana (R-4) — cobre `assigned_agent_id`, **não** cobre handoff sem assignee (Q11) | Agente responder conversa que um humano assumiu | A criar |
| 5 | Unicidade de execução do agente por mensagem de entrada (`messages.id`) | Duas execuções para o mesmo turno (retry, worker concorrente) | A criar |
| 6 | Guarda de envio por turno | Segundo envio para o mesmo turno após retry/erro parcial | A criar |
| 7 | Serialização por conversa `(account_id, contact_id)` | Duas mensagens inbound simultâneas gerarem duas respostas fora de ordem | A criar |
| 8 | Não reentrada (R-7) | Loop agente → flow → automação → agente | A criar |

### 7.3 O que continua desprotegido

`[OBSERVADO]` Duas **automações** diferentes respondendo à mesma mensagem não é protegido por constraint: o dedupe de Automations é uma janela de 60 s em aplicação, por automação e por contato (`src/lib/automations/engine.ts:135-145`). Esse é um débito preexistente, **não introduzido pelo agente**, e não é corrigido aqui. É por isso que D5 e §7.1 são enunciados como par agente × automação, e não como exclusividade global.

`[OBSERVADO]` O rate limit é um `Map` por processo (`src/lib/rate-limit.ts:46`) e não protege concorrência entre instâncias. A serialização por conversa deve ser garantida no banco, não em memória.

---

## 8. Consequências

### 8.1 Positivas

- **Uma fonte de verdade.** Decisão, mensagem e estado conversacional no mesmo banco e na mesma transação quando necessário.
- **Isolamento preservado por construção.** RLS e `account_id` já são a fronteira; o agente não introduz um segundo modelo de tenancy.
- **Reutilização real.** Idempotência, settle, retry ledger e testes PGlite já existem.
- **Latência e concorrência.** Chamada LLM por `fetch` assíncrono, em vez de `spawnSync` de até 120 s. `[OBSERVADO]` "assíncrono" aqui significa não-bloqueante para o event loop; **não** significa durável nem desacoplado do processo. A durabilidade depende de D15/Q10 e não existe hoje.
- **Auditabilidade.** Run, passo, decisão e `reason_code` consultáveis por SQL, sem correlação entre processos.

### 8.2 Negativas

- O FORCECRM passa a ser dono de prompt, persona e versionamento — ônus que a ROXY já tinha começado a resolver com o Compiler.
- Não há portabilidade de identidade entre runtimes. Hoje isso não é requisito.
- Custo e operação de inferência passam a ser internos.
- Risco de reimplementar ações de domínio. Mitigado por D7, mas exige disciplina de revisão.

### 8.3 Neutras

- A ROXY continua evoluindo como produto independente. Uma integração futura por superfície controlada (`SBD-001` D6/A3) permanece possível — apenas não como runtime do agente do FORCECRM.
- O `Compiler` da ROXY não é portado. A ideia de identidade versionada é adotada como arquivo versionado, sem a ontologia Core/Operational/Policy.

---

## 9. Não decidido por este ADR

| # | Questão | Onde deve ser decidida |
|---|---|---|
| Q1 | Memória cognitiva de longo prazo e RAG | ADR próprio, após medir se o contexto transacional basta |
| Q2 | Billing e medição de custo de inferência por tenant | Decisão de produto |
| Q3 | Provider e modelo de LLM | Configuração, não arquitetura (D13) |
| Q4 | UI de configuração de persona e de supervisão de runs | Implementação |
| Q5 | Templates fora da janela de 24 h | Implementação, com decisão de produto |
| Q6 | Multi-agente, especialização por papel, roteamento entre agentes | Fora de escopo; sem evidência de necessidade |
| Q7 | Acoplamento de produto FORCECRM × ROXY (Rota C) | `DIGITALL-...:75,91` permanece vigente |
| Q8 | Forma de integração futura da ROXY (A3, eventos, MCP) | `SBD-001` D6–D13 |
| Q9 | Substituição de Flows ou Automations por agente | Explicitamente rejeitada; D2 |
| Q10 | Substrato de execução durável (fila, worker, cron com claim, outbox + dispatcher ou equivalente) | Decisão própria, registrada antes do primeiro turno real; bloqueia P10 e o gate §12 |
| Q11 | Handoff de flow sem assignee: qual sinal encerra a elegibilidade do agente quando `assigned_agent_id` permanece nulo | Decisão de produto/arquitetura; hoje a camada 4 de §7.2 só verifica `assigned_agent_id` |
| Q12 | Invocação do agente quando a janela de 24 h já fechou | Decisão de produto; a janela limita envio livre, não a invocação (§6.1) |
| Q13 | Limite de passos/iterações de ferramenta por turno do agente e o resultado ao excedê-lo | **Não decidido; não consta do gate §12.** `SBD-001` exigia um critério de terminação (`SBD-001` Q7). D6/R-7 eliminam a recursão entre motores e R-8 define o resultado de falha, mas nenhum fixa um limite de passos por execução. Nenhum valor é proposto aqui |

---

## 10. Condições para revisitar

A decisão deve ser reaberta se **qualquer** condição for comprovada em código, não em documento:

1. A ROXY expõe um `POST /turn` versionado, autenticado, com idempotency key e retorno estruturado (decisão + tool calls + usage).
2. A ROXY demonstra isolamento multi-tenant com teste que prove não vazamento entre duas organizações — dados, sessão, memória e credenciais.
3. A ROXY executa ferramentas de CRM sob contrato de autorização por conta, com fail-closed comprovado.
4. A ROXY substitui `spawnSync` por execução concorrente e assíncrona, com fila e lock persistentes.
5. Medição real mostra que o agente nativo não atinge o orçamento de latência/custo e a ROXY atinge — com p95 e custo por turno medidos.
6. O FORCECRM precisa do mesmo agente em múltiplos produtos/canais, onde a portabilidade de identidade tenha valor comercial concreto.

---

## 11. Pendências de verificação

| # | Pendência | Status | Como verificar |
|---|---|---|---|
| P1 | A ROXY está implantada em produção? Com que volume? | `[NÃO VERIFICADO]` | Perguntar ao responsável; inspecionar host de deploy |
| P2 | Qual versão do binário `hermes` roda? | `[NÃO VERIFICADO]` | `hermes --version` no host; hoje o adaptador invoca por nome, sem versão (`:283`) |
| P3 | Custo e latência reais por turno | `[NÃO VERIFICADO]` | Instrumentar runs no incremento de implementação |
| P4 | O gate será estendido a ferramentas de CRM? | `[NÃO VERIFICADO]` | Acompanhar `platform-policy/ratified.ts` e `ROADMAP.md` |
| P5 | Licenciamento de Hermes/OpenClaw para uso comercial embarcado | `[NÃO VERIFICADO]` | Leitura jurídica dos `LICENSE` |
| P6 | Retenção e tratamento de PII no prompt | `[NÃO VERIFICADO]` | Definir política antes do primeiro turno real; precedente em `flows/engine.ts:907-913` |
| P7 | `R2` (onde a ROXY executa) | `[NÃO VERIFICADO]` | Código mostra processo Node local; deploy não é verificável no repositório |
| P8 | `R4` (acesso da ROXY ao banco do FORCECRM) | `[NÃO VERIFICADO]` | Auditar credenciais do host; o código não contém cliente Supabase |
| P9 | `R9` (relação com Heimdall) | `[NÃO VERIFICADO]` | Declaração da contraparte; `ROXY-ARCHITECTURE.md` não a define |
| P10 | Substrato de execução durável escolhido e implementado | `[NÃO VERIFICADO]` | Nenhuma fila, worker ou outbox existe hoje; decisão Q10 precede o primeiro turno real |
| P11 | Frequência real de handoff sem assignee e de invocação com janela fechada | `[NÃO VERIFICADO]` | Medir em produção depois do gate; hoje são lacunas de contrato (Q11/Q12), não bugs observados |

`[OBSERVADO]` `R1`, `R3`, `R5`, `R6`, `R7`, `R8` e `R10` passam a ter resposta com evidência de código (§3) e estão refletidos em `SBD-001` §4.4.

---

## 12. Gate de implementação

Este ADR **não autoriza implementação**. Ele encerra a decisão de localização e o contrato de precedência.

Qualquer incremento de código exige autorização separada e deve satisfazer, no mínimo:

- flag por conta, default desligada, com comportamento idêntico ao atual quando desligada;
- idempotência ancorada em `insert_inbound_message`;
- serialização por conversa garantida no banco;
- janela de 24 h verificada antes de qualquer envio;
- decisão de ferramenta com `allow`/`deny`/`evaluation_failure` e `reason_code`;
- `account_id` resolvido no servidor, com teste explícito de tentativa de acesso cruzado;
- registro de run e passo antes do primeiro turno real (D14);
- substrato de execução durável escolhido e registrado em decisão própria (Q10), com ACK desacoplado do turno nos caminhos Meta e não-Meta (D15);
- comportamento definido para handoff sem assignee (Q11) e para invocação com janela fechada (Q12);
- nenhuma alteração em `src/lib/flows/` ou `src/lib/automations/` além da extração mecânica do dispatch, se necessária;
- nenhuma dependência de runtime da ROXY.

---

## 13. Índice de evidências

**FORCECRM**
- `src/app/api/whatsapp/webhook/route.ts:247-252,706,796,816,832,859` — ACK antes do processamento, persistência idempotente, Flows, `flowConsumed`, supressão, Automations
- `src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts:220` — caminho não-Meta aguarda o processamento inteiro
- `src/lib/whatsapp/inbound-processor.ts:325,347,367,376,392` — caminho não-Meta equivalente
- `supabase/migrations/034_messages_inbound_idempotency.sql`, `035_inbound_idempotency_rpcs.sql` — contrato de idempotência
- `supabase/migrations/010_flows.sql:165-172` — status de run; `017_account_sharing.sql:337-340` — `idx_one_active_run_per_contact` sobre `(account_id, contact_id)`
- `src/lib/flows/engine.ts:183-199,434-455,1019-1021,1050-1060` — run ativa, handoff, fallback `ignore`, fallback esgotado com handoff
- `src/lib/automations/engine.ts:91,135,465` — dispatcher, dedupe de 60 s, `runStep` privada
- `supabase/migrations/001_initial_schema.sql:163-166` — `messages` sem `account_id`; `sender_type` com `bot`
- `supabase/migrations/017_account_sharing.sql:511-517` — RLS de `messages` via `conversations`
- `supabase/migrations/075_conversations_assigned_agent_fk.sql:61-62` — FK de atribuição
- `supabase/migrations/011_profile_beta_features.sql:29` — flag por profile
- `src/lib/inbox/session-window.ts:9-21` — janela de 24 h
- `src/app/api/whatsapp/send/route.ts` — ausência de verificação de janela; `pauseFlowRunsOnAgentSend` (envio humano encerra runs de flow, §6.5)
- `src/app/api/whatsapp/send/route.test.ts` — testes do encerramento de runs nos caminhos Meta e não-Meta
- `src/lib/deals/status.ts:58` — `resolveAutomationDealWrite`
- `src/lib/flows/meta-send.ts:112,245,415`, `src/lib/automations/meta-send.ts:123` — `sender_type: 'bot'`
- `src/lib/rate-limit.ts:46` — `Map` por processo
- `tsconfig.json:11` — `moduleResolution: "bundler"` sem `allowImportingTsExtensions`

**ROXY** (`RS` = `.claude/skills/roxy-agent/src`)
- `README.md:22` — bootstrap
- `ROADMAP.md:56,66,76,86` — R3–R6 não concluídos
- `ROXY-ARCHITECTURE.md:125-132,155-157` — System of Record × Intelligence; código em skill
- `RS/runtime/agent-runtime.ts:3-4,14,20-25` — contrato mínimo e proibição de ampliar
- `RS/runtime/hermes-runtime-adapter.ts:19,46,61,65,209-249,283-300,304` — `spawnSync`, timeout, stdout, `exitCode` ignorado, `Map` em memória
- `RS/config.ts:20-24,28,33,39-40` — organização por env, `HERMES_HOME`, allowlist
- `RS/channels/zapi.ts:35,47,60-62,87,122,163,176-178,236-239` — dedupe em memória, webhook, secret, despacho do evento ao publisher (`:163`, `publisher.publish`), resposta direta (`:176-178`), allowlist; o `POST` ao `forwardUrl` está em `RS/events/subscribers/force-crm-subscriber.ts:19`, não em `zapi.ts`; o secret deixou de ser opcional e passou a fail-closed no startup (`zapi.ts:81-85`, §3.8)
- `RS/authorization-gate/evaluate.ts:29-58,76-84,106-114` — decisão e allow sem policy
- `RS/authorization-gate/loopback-server.ts:67,153` — loopback `127.0.0.1`
- `RS/platform-policy/ratified.ts:8,38,41` — `write_file` como única policy
- `RS/compiler/compile.ts:6-15,35` — pureza e determinismo
- `.claude/skills/roxy-agent/hermes-plugins/roxy-authorization-gate/__init__.py:1,34` — hook `pre_tool_call`, fail-closed
- `ROXY-RUNTIME-CONTRACT.md:26,43,46,321` — divergência `execSync`/`hermes-client.ts`; contexto que não chega; tools no runtime; isolamento "FUTURA"

**Documentos internos**
- `docs/adr/ADR-AUT-001-automations-flows-reconciliation.md:119,128` (numeração de `3301c77`; ver «Convenção de linhas») — D4 e D7
- `docs/architecture/SBD-001-forcecrm-roxy-boundary.md` §BLOQ-1 — bloqueio do lado ROXY
- `docs/checkpoints/CHECKPOINT-ROXY-COUNTERPART-BLOCKED.md` §6 — gate anterior e status parcial em 2026-10-20
- `docs/planning/DIGITALL-FORCE-INTELLIGENCE-DIRECTION-2026-08-08.md:75,91` — Rota C e adiamento da fronteira completa

---

## 14. Registro de revisão editorial

**Revisão 1.1 — 2026-10-20.** Revisão documental, sem alteração de código, migration ou configuração.

- Identidade documental fixada: `ADR-AI-001` = localização do agente nativo; `ADR-AI-002` = fronteira ampla de dados, ações, autoridade, tenant e billing, **reservado e não criado** (cabeçalho e nota de convenção).
- Correções de evidência: citações de `sender_type` de Flows/Automations estavam trocadas; índice de run ativa aponta para `017:337-340`, não `010:189`; linhas de `flows/engine.ts` e do caminho não-Meta corrigidas; `README.md`/`ROADMAP.md` da ROXY e a mudança de secret da Z-API registradas como divergência histórica (§3.8, §13).
- Precisão de contrato: D7 distingue conformidade de preservação literal; a invariante de §7.1 é apenas agente × automação; a exclusão por flow ativo usa `(account_id, contact_id)`; o fallback `ignore` retorna `consumed: false`; handoff sem assignee é lacuna registrada (Q11), não corrigida.
- Nova decisão **proposta D15** (§6.6): ACK e execução durável são separados como arquitetura; o substrato permanece não decidido (**Q10**) e é pré-requisito do primeiro turno real.
- Novas questões **Q10–Q12** e pendências **P10–P11**; P1–P9 e R2/R4/R9 permanecem `[NÃO VERIFICADO]`.
- Gate §12 reforçado: sem substrato durável, sem tratamento de Q11/Q12 e sem ACK desacoplado, nenhum turno real é autorizado.

Nenhuma decisão anterior foi reescrita. Onde o texto original usava `ADR-AI-001` para a fronteira ampla, foi inserida nota editorial apontando para `ADR-AI-002`; o histórico permanece legível.

**Revisão 1.2 — 2026-10-20.** Correção de achados de auditoria. Revisão técnica/editorial; **não** é aprovação arquitetural.

- **Estado (F11):** Status passou de «Aceito» para «Proposto». Não há registro de aprovação arquitetural; revisão técnica/editorial não é aprovação e nenhuma pessoa ou instância é apontada como aprovadora. D1–D15 são propostas até esse registro.
- **§6.5 (F1):** corrigida a afirmação de que nenhum código de produção grava `paused_by_agent`. A rota de envio grava; o status é terminal e se refere a atendente humano. Defeito real corrigido no código: o caminho não-Meta da rota não encerrava runs de flow. Correção em `src/app/api/whatsapp/send/route.ts` (helper `pauseFlowRunsOnAgentSend`, chamado nos dois caminhos), com testes em `route.test.ts` (envio Meta, envio Z-API, e envio não-Meta com falha, que **não** encerra a run). A existência do mecanismo não decide Q11 nem aprova handoff de IA.
- **§3.7 (F2):** contagem de `console.*` na ROXY corrigida de 37 para 68 (55 `log` + 13 `error`, 8 arquivos), com critério explícito.
- **§6.2 (F3):** diagrama corrigido; «agente elegível? não» segue para Automations, não para «agente decide».
- **Q13 (F4):** registrada a ausência de limite de passos por execução. Nenhum limite foi inventado; a atribuição de «R-8» como limite de passos em `SBD-001` foi corrigida lá.
- **§1 (F6):** citação de D7 completada com a ressalva «etapa posterior e não autorizada aqui», e a referência de linha corrigida (`:128`).
- **Convenção de linhas (F7):** referências a `ADR-AUT-001` padronizadas em `3301c77` (`:119` D4, `:128` D7). `ADR-AUT-001` não foi alterado.
- **Convenção de IDs (F8/F9):** `ADR-AI-001` = localização do agente; `ADR-AI-002` = fronteira ampla, reservado e não criado; `Qn` sempre qualificado entre documentos. Nenhuma renumeração.
- **§2.1/§6.1/D9 (F10):** semântica de `computeSessionInfo` corrigida: lista vazia retorna `expired: false`, e `expired: true` só ocorre com mensagens e nenhuma do cliente. Fixado por teste existente; comportamento não alterado. O índice (§13) passou a atribuir o `POST` ao `forwardUrl` a `force-crm-subscriber.ts:19`.
- **Inalterado:** Q10, Q11 e Q12 seguem não decididos; R2, R4, R9 e P1–P11 seguem `[NÃO VERIFICADO]`; o gate §12 segue fechado.

---

*Fim do ADR-AI-001 — decisão documental. Este ADR não altera código, migration ou configuração; a correção independente de `send/route.ts` está registrada em §14 (rev. 1.2).*
