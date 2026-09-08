# SBD-001 — Fronteira de Sistemas: FORCECRM × ROXY

| | |
|---|---|
| **Tipo** | Documento de fronteira arquitetural (System Boundary Document) — documental, **sem código associado**. Não é ADR: não decide implementação, decide apenas onde termina um sistema e começa o outro. |
| **Escopo** | A superfície entre o FORCECRM (este repositório) e a camada ROXY. Cobre responsabilidades, source of truth, interfaces, tenancy, autoridade de ação e a relação com Automations/Flows. |
| **Deriva de** | `docs/adr/ADR-AUT-001-automations-flows-reconciliation.md` (§ Autoridade, D7, §9, §11) — que **deferiu explicitamente** a localização concreta de IA para esta reconciliação · `docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md:90` · `docs/MASTER-ROADMAP.md:93,156,382` |
| **Resolve** | A pergunta "onde termina o FORCECRM e onde começa o ROXY?", até o limite que a evidência disponível sustenta. |
| **Não resolve** | `ADR-AI-001`. Este documento produz **insumos** para ele. |
| **Status** | Parcial — **lado FORCECRM completo e evidenciado; lado ROXY sem evidência disponível** (ver §4 e §BLOQ-1). Requer complemento quando a arquitetura ROXY for fornecida. |
| **Baseline de código** | HEAD `2a6061e`, working tree com as pendências não commitadas listadas em §15. |
| **Convenção de caminho** | `docs/architecture/<CÓDIGO>-NNN-<slug>.md`, seguindo `DLB-001-delivery-layer-boundary.md`, `ODI-001-outbound-delivery-integrity.md`, `ARO-001-async-recovery-orchestration.md`. `SBD` = System Boundary Document. |

---

## 0. Nota de método e legenda de evidência

Toda afirmação neste documento carrega uma classificação. Elas **não são intercambiáveis** — a distinção entre o que roda e o que foi escrito como intenção é o principal valor deste documento.

| Marca | Significado |
|---|---|
| `[IMPLEMENTADO]` | Existe código em execução. Citado com `arquivo:linha`. |
| `[DOCUMENTADO]` | Existe decisão escrita em ADR/roadmap/doc do repositório. Pode ou não ter código. |
| `[PREVISTO]` | Aparece apenas como roadmap/intenção futura. **Não existe código.** |
| `[OBSERVADO]` | Constatação factual da investigação (inclusive constatação de ausência), sem ser decisão nem código. |
| `[DECISÃO]` | Decisão de fronteira tomada por este documento. |
| `[QUESTÃO]` | Deliberadamente não decidido — insumo para `ADR-AI-001`. |
| `[RISCO]` | Risco arquitetural registrado. **Não corrigido aqui.** |

**Ausência de evidência é registrada como ausência**, nunca preenchida por inferência. Onde não havia material, este documento diz que não havia.

**Armadilha de investigação registrada, para quem repetir esta auditoria:** `grep -i roxy` é inútil neste repositório — casa com "p**roxy**". Todos os aparentes acertos em `.env.local`, `.env.local.example:55` e `.next/**` são esse falso positivo. Use `grep -iE '\broxy\b'`.

---

## 1. Objetivo

`ADR-AUT-001` fechou a fronteira entre os dois motores de orquestração do FORCECRM (Automations × Flows) e, na sua linha de autoridade, registrou explicitamente o que **não** decidia:

> *"**Não decide** onde IA entra (deferido a FORCECRM × ROXY)"* — `ADR-AUT-001:10` `[DOCUMENTADO]`

E na lista de fora de escopo:

> *"- `ADR-AI-001`. / - Reconciliação de fronteiras FORCECRM × ROXY."* — `ADR-AUT-001:192-193` `[DOCUMENTADO]`

Esta é a consequência arquitetural direta daquela decisão. Antes de decidir **como** IA funciona (`ADR-AI-001`), é preciso decidir **de quem ela é** — e, sobretudo, o que ela pode tocar.

A urgência não é teórica. O `RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md:90` registra o motivo concreto `[DOCUMENTADO]`:

> *"`ADR-AI-001` (fronteiras data/ação/autoridade/tenant/billing) — **e agora precisa reconciliar com a Roxy-agent**, que já está em desenvolvimento paralelo, antes de ser escrito no vácuo."*

Um segundo sistema está sendo construído em paralelo contra o mesmo domínio de negócio. Sem fronteira escrita, os dois convergem por acidente — tipicamente pelo caminho de menor resistência, que é o acesso direto ao banco. §8 e §RISCO-1 mostram que esse caminho não é hipotético: **já existe precedente executando no ecossistema.**

---

## 2. Sistemas envolvidos

### 2.1 FORCECRM `[IMPLEMENTADO]`

Este repositório (`wacrm`). Next.js 16 + Supabase (Postgres + Auth), multi-tenant por `account_id`, com RLS. É um produto de CRM operacional para WhatsApp: inbox compartilhada, contatos, pipelines, broadcast, automações e flows. Fonte: `README.md:1-45`.

Estado da IA dentro dele, por evidência dupla e negativa `[OBSERVADO]`:

- `docs/MASTER-ROADMAP.md:93` — *"**Ausentes por completo** `[C, grep negativo]`: billing, notifications, tasks, search global, **AI**, webhooks de saída, onboarding, export, observabilidade estruturada."*
- `docs/MASTER-ROADMAP.md:156` — linha `Billing · Notifications · Tasks · Search · **AI** · Onboarding` → *"sem evidência — pós-MVP"*.
- `docs/MASTER-ROADMAP.md:382` — *"Não requisitos até decisão explícita: ... **IA**, webhooks de saída ..."*
- Verificação independente nesta auditoria: `package.json` **não contém nenhuma dependência de LLM ou de runtime de agente** — zero ocorrências de `anthropic`, `openai`, `langchain`, `ai-sdk`, `mcp`, `model`.

**O FORCECRM não tem IA. Não parcialmente, não em stub: zero superfície.** Isso é um dado de fronteira favorável — não há nada para desfazer, migrar ou reconciliar do lado do CRM.

### 2.2 ROXY `[OBSERVADO — SEM EVIDÊNCIA]`

**Não existe nenhum documento de arquitetura de ROXY acessível a esta auditoria.**

Busca com limite de palavra (`\broxy\b`) em `docs/`, `src/`, `supabase/`, na raiz do repositório e em todos os projetos irmãos de `c:\Users\weyne\Claude\Projects\` (`heimdall`, `ForgeSkill`, `MCP Force Tráfego Supremo`, `Projeto NotebookLM`). Não existem `ROXY-VISION.md`, `ROXY-ARCHITECTURE.md`, nem `SOUL.md` de ROXY.

A totalidade do material sobre ROXY neste repositório são **três referências prospectivas**, todas escritas de dentro do FORCECRM, nenhuma descrevendo ROXY:

| # | Local | Conteúdo integral |
|---|---|---|
| 1 | `docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md:90` | *"precisa reconciliar com a Roxy-agent, que já está em desenvolvimento paralelo"* |
| 2 | `docs/adr/ADR-AUT-001-...:10` | *"Não decide onde IA entra (deferido a FORCECRM × ROXY)"* |
| 3 | `docs/adr/ADR-AUT-001-...:193` | *"Reconciliação de fronteiras FORCECRM × ROXY"* (item de fora de escopo) |

Delas se extrai exatamente o seguinte, e nada além:

- ROXY é referida como **"Roxy-agent"** — vocabulário de agente, não de aplicação `[OBSERVADO]`.
- Está **em desenvolvimento paralelo**, fora deste repositório `[OBSERVADO]`.
- É considerada a **destinatária natural da responsabilidade de IA**, pelos autores do `ADR-AUT-001` `[OBSERVADO]`.

**Nenhuma das seguintes perguntas do escopo desta etapa pôde ser respondida:** onde ROXY roda; que estado possui; que ferramentas usa; como recebe contexto; como devolve ações; se há API/protocolo explícito; se depende do banco do FORCECRM; se depende do runtime do FORCECRM; se ROXY conhece internals do FORCECRM.

Consequência de método: **§4 deste documento é uma seção deliberadamente vazia de afirmações positivas.** Ela contém um questionário, não uma arquitetura. Ver `§BLOQ-1`.

### 2.3 Ecossistema adjacente `[OBSERVADO]` — não é ROXY

A investigação encontrou, fora deste repositório, sistemas do mesmo ecossistema ("DigitalLForce"). **Nenhum deles é ROXY, e nenhum é citado aqui como se fosse.** Estão registrados por duas razões legítimas: um deles (Heimdall) é o **precedente arquitetural observável** mais próximo do que ROXY tende a ser, e é a origem factual dos nomes Hermes e OpenClaw (§11).

| Sistema | O que é | Relação com o FORCECRM |
|---|---|---|
| **Heimdall** (`Projects/heimdall`) | Agente de qualificação de leads para um cliente final (Oral Unic). Python + FastAPI, orquestrado por n8n, WhatsApp via Z-API, persiste em Supabase. Descrito como *"primeiro agente real do ecossistema DigitalLForce"* — `heimdall/README.md:1-4`. | **Nenhuma. Não integra com o FORCECRM.** Não referencia este repositório, não consome sua API. É um sistema paralelo com esquema próprio. |
| **SkillForge / ForgeSkill** (`Projects/ForgeSkill`) | Plataforma de engenharia de Skills — descobre, analisa, compara, compõe e publica Skills para agentes de IA. *"Não é um diretório, nem um marketplace... é um motor de engenharia de Skills"* — `ForgeSkill/README.md:1-8`. | **Nenhuma.** Ferramenta de meta-nível (catálogo/composição), não runtime de produto. |
| **Hermes**, **OpenClaw** | Projetos OSS externos, de terceiros. Ver §11. | **Nenhuma.** Zero ocorrências em `src/`, `supabase/`, `package.json`. |

Colisão de nomes registrada, para evitar confusão futura `[OBSERVADO]`: `docs/checkpoints/GATE-EVIDENCE-E2.1-ACTIVATION-2026-08-03.md:18` usa *"Hermes Agent"* para designar o **auditor externo** que executou as auditorias de 2026-08-03. Esse uso **não tem relação** com o `NousResearch/hermes-agent` de §11. São dois referentes distintos com o mesmo nome.

---

## 3. Responsabilidades do FORCECRM `[IMPLEMENTADO]`

Lista objetiva, cada item verificado contra código nesta auditoria.

| # | Responsabilidade | Evidência |
|---|---|---|
| F1 | **Tenancy e identidade de conta.** `accounts`, `profiles`, papéis (`owner`/`admin`/`agent`/`viewer`), convites, transferência de propriedade. | `src/lib/auth/`, `src/app/api/account/**`, migrations `017`, `073`, `074` |
| F2 | **Autorização e RLS.** `is_account_member()`, `can_access_account()`, `is_platform_operator_for()`, políticas por tabela. | `ADR-SYS-001 §1`; migrations `017`, `037`, `073`, `074` |
| F3 | **Contatos e identidade canônica de telefone.** Deduplicação, merge com proveniência, referência DDD BR. | `src/lib/contacts/`, migrations `064`–`072`, `ADR-IDENTITY-BR-001`, `ADR-CONTACT-MERGE-001` |
| F4 | **Conversas e mensagens.** Estado da conversa, atribuição de agente, status canônico de mensagem, ledger de entrega. | `src/lib/inbox/`, `src/lib/message/`, migrations `047`–`052`, `063`, `075`; `ADR-MSG-001`, `ADR-MSG-STATUS-001` |
| F5 | **Integração com providers de WhatsApp.** Abstração `getProvider()` (Meta / Z-API / uazapi), credenciais cifradas por conta, webhooks de entrada autenticados. | `src/lib/whatsapp/providers/`, `ADR-MSG-001 D3.b`, `DLB-001`, `ADR-E4B-003` |
| F6 | **Integridade de entrega de saída.** Liquidação transacional única (`settle_outbound_message`), retry ledger, recuperação de órfãos. | `ODI-001`, `ARO-001`, `ADR-E4B-001/002`, migration `048` |
| F7 | **Automations** — árvore de ações reativa a evento discreto. | `src/lib/automations/`, `ADR-AUT-001 D1` |
| F8 | **Flows** — máquina de estados conversacional multi-turno, persistida por contato. | `src/lib/flows/`, `ADR-AUT-001 D1` |
| F9 | **Precedência de entrada.** Flows avalia primeiro (awaited); consumo suprime gatilhos de conteúdo de Automations; gatilhos de identidade disparam sempre. | `ADR-AUT-001 D4`; `src/app/api/whatsapp/webhook/route.ts:758-840`; `src/lib/whatsapp/inbound-processor.ts:360-393` |
| F10 | **Broadcast / campanhas** com templates aprovados e rastreio por destinatário. | `src/app/api/whatsapp/broadcast/route.ts`, `src/lib/broadcast-status.ts` |
| F11 | **Attribution e enriquecimento** de origem de lead. | `E6.0`, `ADR-ATTR-001/002`, migrations `033`, `055`, `056` |
| F12 | **Criptografia de credenciais** por conta, com versionamento de chave. | `src/lib/crypto/`, `ADR-CRYPTO-001`, `ADR-E7-001`, migration `057` |
| F13 | **API pública `/api/v1`** — autenticação por chave de conta, escopos, rate limit, envelope de resposta. Ver §7 para o estado real (groundwork). | `src/lib/auth/api-context.ts`, `src/lib/api-keys/`, `docs/public-api.md` |

`[DECISÃO D1]` — **Todas as 13 responsabilidades acima permanecem integralmente do FORCECRM.** Nenhuma é transferida, compartilhada ou espelhada em ROXY por este documento.

---

## 4. Responsabilidades do ROXY

### 4.1 Estado `[OBSERVADO]`

**Não determinável com a evidência disponível.** Esta seção não afirma nada positivo sobre ROXY porque não há material do qual derivar afirmação. Ver §2.2 e `§BLOQ-1`.

O escopo desta etapa instruía explicitamente a **não assumir previamente** que ROXY é CRM, banco de dados, engine de automação, substituto do ForceCRM, provider de WhatsApp, chatbot ou plataforma genérica de agentes — e a derivar isso do material existente. **O material existente é vazio. Portanto nenhuma dessas hipóteses é afirmada nem descartada aqui.**

### 4.2 O único enunciado sustentável hoje

`[DECISÃO D2]` — **Por eliminação evidenciada, e não por atribuição:** a responsabilidade cognitiva/IA **não está no FORCECRM**, e o FORCECRM **não a reivindica**. Isso está triplamente registrado (`MASTER-ROADMAP.md:93,156,382`), confirmado por ausência total de dependências de LLM em `package.json`, e a intenção de alocá-la a ROXY está escrita em `ADR-AUT-001:10`.

Isto é um enunciado sobre o **FORCECRM**, não sobre ROXY. Ele diz de quem a IA *não* é. Que ROXY seja de fato a dona — e com que forma — depende da arquitetura ROXY, que não foi fornecida.

### 4.3 Questionário de fronteira — o que ROXY precisa responder

Este é o produto útil desta seção. Nenhuma destas perguntas pode ser respondida pelo lado FORCECRM, e **todas bloqueiam o `ADR-AI-001`**.

| # | Pergunta | Por que é fronteira, não detalhe |
|---|---|---|
| R1 | ROXY é um **produto** com seus próprios tenants/clientes, ou uma **camada** a serviço do FORCECRM? | Define se há um segundo modelo de tenancy a reconciliar (§8) ou apenas um consumidor da API. |
| R2 | Onde ROXY **executa**? Processo próprio, VPS, serverless, dentro do runtime Next.js do FORCECRM? | Se compartilhar runtime, a fronteira é de módulo (fraca). Se for processo separado, é de rede (forte, preferível). |
| R3 | ROXY possui **estado persistente próprio**? Em que armazenamento? | Determina §6. Sem isso não é possível dizer quem é source of truth de memória cognitiva. |
| R4 | ROXY tem, ou pretende ter, **acesso direto ao Postgres/Supabase do FORCECRM**? | **A pergunta mais crítica do documento.** Determina se a RLS do FORCECRM continua sendo fronteira de segurança ou vira decoração. Ver §RISCO-1. |
| R5 | Como ROXY **recebe contexto** — payload empurrado, consulta puxada, ou leitura direta? | Empurrado/puxado por API mantém encapsulamento; leitura direta o destrói. |
| R6 | Como ROXY **devolve ação** — resposta síncrona, callback, escrita direta? | Define se o FORCECRM mantém o ponto de controle sobre efeitos no seu domínio. |
| R7 | Existe **API ou protocolo explícito** de ROXY, versionado? | Sem contrato versionado, a fronteira não é aplicável na prática. |
| R8 | ROXY conhece conceitos internos do FORCECRM (`account_id`, `flow_runs`, `current_node_key`, `settle_outbound_message`)? | Se conhecer os que deveriam ser encapsulados, a fronteira já vazou no design. |
| R9 | Qual a relação real de ROXY com **Heimdall** — sucessora, generalização, sistema independente? | Heimdall é o único precedente observável (§2.3). Se ROXY herda sua arquitetura, herda também §RISCO-1. |
| R10 | ROXY é **por conta (tenant)** ou uma instância única servindo todas? | Define isolamento de memória cognitiva entre clientes — risco de vazamento entre tenants. |

---

## 5. Responsabilidades compartilhadas

`[DECISÃO D3]` — **Nenhuma responsabilidade compartilhada é estabelecida por este documento.**

Não por omissão, mas por princípio e por falta de base: estabelecer compartilhamento exige conhecer os dois lados, e um deles não foi fornecido (§4.1). Além disso, responsabilidade compartilhada é a forma mais cara de fronteira — cria ambiguidade de dono, de ordem e de recuperação de falha. Só deve ser criada contra necessidade demonstrada, nunca por antecipação.

Um único candidato apareceu na investigação, e é registrado como **risco, não como responsabilidade compartilhada** `[OBSERVADO]`:

> `heimdall/PROVENANCE.md:15` — `| dados | Supabase | **hub central do ecossistema DigitalLForce** |`

Existe, portanto, uma intenção escrita de que o Supabase seja um hub compartilhado entre sistemas do ecossistema. Se essa intenção for aplicada ao banco do FORCECRM, ela transforma o banco em superfície de integração compartilhada. Ver §RISCO-1 e §8.4.

---

## 6. Source of truth por classe de estado

`[DECISÃO D4]` — Source of truth é atribuído **por classe de estado**, não por sistema. Nenhum dos dois lados é declarado dono de tudo.

| Classe de estado | Exemplos | Autoridade | Marca |
|---|---|---|---|
| **Identidade de tenant** | `accounts`, `profiles`, papéis, convites | **FORCECRM** | `[IMPLEMENTADO]` — `src/lib/auth/`, migrations `017`/`073`/`074` |
| **Identidade de contato** | `contacts`, telefone canônico, merges | **FORCECRM** | `[IMPLEMENTADO]` — migrations `064`–`072` |
| **Conversas e mensagens** | `conversations`, `messages`, status canônico | **FORCECRM** | `[IMPLEMENTADO]` — `ODI-001`, `ADR-MSG-STATUS-001`, migration `063` |
| **Estado comercial** | `deals`, pipelines, estágios | **FORCECRM** | `[IMPLEMENTADO]` |
| **Estado conversacional de flow** | `flow_runs.current_node_key`, `flow_run_events` | **FORCECRM** | `[IMPLEMENTADO]` — `ADR-AUT-001 §2.2`; unicidade garantida por índice parcial `idx_one_active_run_per_contact` |
| **Credenciais de provider** | `whatsapp_config` cifrado, versionamento de chave | **FORCECRM** | `[IMPLEMENTADO]` — `ADR-CRYPTO-001`, `ADR-E7-001` |
| **Autorização / política** | RLS, escopos de chave de API | **FORCECRM** | `[IMPLEMENTADO]` — §8 |
| **Memória cognitiva** | contexto de agente, histórico cognitivo, preferências inferidas, conhecimento recuperado, embeddings | **NÃO DECIDIDO** | `[QUESTÃO Q1]` — não existe em lugar nenhum hoje. `[OBSERVADO]`: zero tabelas de memória/embedding em `supabase/migrations/` (001–075); zero dependências de LLM em `package.json`. Depende de R3/R10. |
| **Política/persona do agente** | prompts, tom de voz, script | **NÃO DECIDIDO** | `[QUESTÃO Q2]` — precedente do ecossistema mantém isso **fora** do banco, em arquivo versionado (`ForgeSkill/heimdall/SOUL.md`). É precedente, não decisão. |
| **Decisão do agente** | por que respondeu X, qual ação escolheu | **NÃO DECIDIDO** | `[QUESTÃO Q3]` — mas ver `[DECISÃO D5]` abaixo. |

`[DECISÃO D5]` — **O resultado operacional de qualquer ação cognitiva é estado do FORCECRM, independentemente de onde a decisão foi tomada.** Se uma decisão de ROXY resulta em mensagem enviada, tag aplicada ou deal criado, o registro autoritativo desse fato é do FORCECRM — porque é ele que mantém a integridade transacional dessas entidades (`ODI-001 §5/§9`: liquidação como autoridade transacional única). ROXY pode reter o *raciocínio*; não retém o *fato de negócio*.

Esta é a decisão que impede a divergência mais cara possível: dois sistemas com versões conflitantes do que aconteceu com um cliente.

---

## 7. Interfaces FORCECRM ↔ ROXY

`[OBSERVADO]` — **Nenhuma interface entre FORCECRM e ROXY existe hoje.** Zero. A tabela abaixo é o inventário de **superfícies que existem no FORCECRM e que uma integração poderia usar**, classificadas pelo seu estado real. Nenhuma foi construída para ROXY, e nenhuma é inventada aqui.

### 7.1 Implementadas

| Interface | Origem | Destino | Estado | Evidência |
|---|---|---|---|---|
| **I1** — `GET /api/v1/me` | Externo | FORCECRM | `[IMPLEMENTADO]` — **é o único endpoint `/api/v1` que existe.** Só devolve identidade da conta e escopos da chave. Nenhum dado de negócio. | `src/app/api/v1/me/route.ts:20-31`; `docs/public-api.md:8-13` |
| **I2** — passo `send_webhook` de Automation | FORCECRM | Externo | `[IMPLEMENTADO]` — `POST` para URL arbitrária configurada pelo usuário. **É a única saída HTTP do domínio para destino arbitrário**; todas as demais chamadas externas em `src/` são endpoints fixos de provider (`meta-api.ts`, `providers/zapi.ts`, `providers/uazapi.ts`, `graph-api-client.ts`). | `src/lib/automations/engine.ts:555-565` |
| **I3** — webhooks de entrada de provider | Provider | FORCECRM | `[IMPLEMENTADO]` — dois caminhos: Meta (`webhook/route.ts`) e não-Meta autenticado por segredo em URL com comparação em tempo constante. **Fronteira de provider, não de agente.** | `src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts:19-38` |

**Sobre I2** `[RISCO-2]`: a validação exige apenas que a URL seja sintaticamente válida e use `http`/`https` (`src/lib/automations/validate.ts:118-133`). O `POST` não é assinado, não tem HMAC nem allowlist de destino, e o corpo default é o contexto inteiro da automação (`engine.ts:559: body = cfg.body_template ? interpolate(...) : JSON.stringify(args.context)`). Se ROXY for chamada por aqui, o receptor **não tem como verificar que a chamada veio do FORCECRM**, e o `http:` permitido admite destino em texto claro. Registrado; **não corrigido neste documento** (corrigir seria alterar Automations, explicitamente fora de escopo).

### 7.2 Previstas — documentadas, sem código

| Interface | Origem | Destino | Estado | Evidência |
|---|---|---|---|---|
| **P1** — endpoints de dados `/api/v1` (`messages`, `contacts`, `conversations`, `broadcasts`) | Externo | FORCECRM | `[PREVISTO]` — listados no roadmap da API pública; **nenhum implementado**. | `docs/public-api.md` §Roadmap |
| **P2** — webhooks de evento de saída | FORCECRM | Externo | `[PREVISTO]` — *"Outbound event webhooks (so automations can react to inbound messages)"*. Confirmado ausente: `MASTER-ROADMAP.md:93` lista "webhooks de saída" entre os **ausentes por completo**. Planejado como E14 em `RECONCILIACAO-FINAL:84`. | `docs/public-api.md` §Roadmap |
| **P3** — nó de flow `http_fetch` | FORCECRM (Flow) | Externo | `[PREVISTO]` — **superfície morta**: permitida pelo CHECK de `node_type` em `010_flows.sql:127` e configurável, mas o switch de execução não tem nenhum branch que a trate. Um flow com esse nó **trava**. | `ADR-AUT-001 §2.6`; `src/lib/flows/engine.ts:464`; `src/lib/flows/types.ts:184` |

`[OBSERVADO]` **P3 é a observação mais relevante desta seção.** O nó `http_fetch` é exatamente a costura onde um passo cognitivo dentro de uma conversa se encaixaria — chamar um serviço externo no meio de um flow e usar a resposta. Ele já foi imaginado, já está no schema, e nunca foi construído. Isto **não é uma decisão de que IA deva entrar por ali** — é o registro de que o seam existe e está vago. Ver `[QUESTÃO Q5]`.

### 7.3 Inexistentes

`[OBSERVADO]` — verificados por busca direta, **não existem em nenhuma forma** (nem código, nem schema, nem roadmap): **MCP**, **event bus**, integração **Telegram**, protocolo de **tool call**, dispatcher autônomo, qualquer conexão direta ROXY→banco do FORCECRM.

Nenhum destes é criado, projetado ou recomendado por este documento.

---

## 8. Segurança e tenancy

Esta é a fronteira que mais importa, porque é a única cuja violação não é reversível por refatoração.

### 8.1 Modelos de autorização em uso `[IMPLEMENTADO]`

O FORCECRM opera hoje **três** modelos distintos. Os dois primeiros foram formalizados em `ADR-SYS-001 §1`, que os identificou como *"dois modelos de autorização em uso simultâneo e não-declarados como tal"*.

| # | Ator | Mecanismo | Onde a autorização acontece |
|---|---|---|---|
| **A1** | Humano (dashboard) | Sessão Supabase por cookie → `auth.uid()` | **No banco.** RLS + `is_account_member()`/`can_access_account()`. |
| **A2** | Sistema (automations, flows, cron, sweepers) | Cliente `service_role`, `auth.uid()` é `NULL` | **Fora do banco.** Delegada à fronteira já validada antes da RPC — p.ex. o segredo do webhook, verificado na rota. Padrão explícito em `insert_inbound_message` (migration `035`): `REVOKE ... FROM authenticated; GRANT EXECUTE ... TO service_role;` — `ADR-SYS-001 §1`. |
| **A3** | Máquina externa (API pública) | `Authorization: Bearer wacrm_live_…` → hash SHA-256 → linha de chave → `account_id` fixo | **Na aplicação.** `src/lib/auth/api-context.ts:80-118`. |

### 8.2 A propriedade que sustenta A3 `[IMPLEMENTADO]`

`src/lib/auth/api-context.ts:22-27`, no cabeçalho do módulo:

> *"Why a service-role client: an API caller has no Supabase session, so there's no `auth.uid()` for RLS to match. The key lookup itself establishes the account; from there every downstream query MUST be explicitly filtered by `ctx.accountId`... **The key never escalates past its own account because the account is fixed at lookup time.**"*

O ponto de fronteira: **em A3 a RLS não está protegendo nada** — o cliente é `service_role`, que a contorna. O isolamento de tenant é sustentado por **disciplina de aplicação**: filtrar toda query por `ctx.accountId`. Isso é seguro porque `account_id` vem da linha da chave e não de entrada do chamador (`api-context.ts:114`), mas é uma garantia de código, não de banco.

Escopos disponíveis `[IMPLEMENTADO]` — `src/lib/api-keys/scopes.ts:16-23`: `messages:send`, `messages:read`, `contacts:read`, `contacts:write`, `conversations:read`, `broadcasts:send`. A autorização é *scopes-only*, independente do papel de quem criou a chave; a criação é restrita a admin+ (`scopes.ts:3-8`).

`[OBSERVADO]` **Nenhum endpoint exige escopo hoje**, porque nenhum endpoint de dados existe (§7.2/P1). Os seis escopos estão definidos e não consumidos. O modelo de capacidade está pronto; a superfície que ele governaria, não.

### 8.3 Fronteira para ROXY

`[DECISÃO D6]` — **O FORCECRM não estende nenhuma confiança implícita a ROXY.** Qualquer acesso de ROXY ao domínio do FORCECRM é acesso de máquina externa e cai em **A3**: chave de API, ligada a exatamente uma conta, portando escopos explícitos. Não é criado modelo A4 para agentes, não é criado token especial, não é concedida isenção.

Consequências diretas, sustentadas por `api-context.ts:110-117`:
- ROXY **não escolhe** o `account_id` em que opera. Ele é fixado no lookup da chave. Um chamador não pode se mover entre tenants — não porque seja proibido, mas porque não há parâmetro por onde pedir.
- ROXY não pode fazer o que seus escopos não permitem, independentemente do papel de quem emitiu a chave.
- Revogação é operação do FORCECRM, unilateral, efetiva na requisição seguinte (`docs/public-api.md` §Revoking a key).

`[DECISÃO D7]` — **ROXY não recebe acesso direto ao Postgres/Supabase do FORCECRM.** Acesso direto colocaria ROXY em A2 (`service_role`, RLS contornada) sem a propriedade que torna A2 legítimo: em A2 a autorização é delegada a *uma fronteira já validada antes da chamada* (`ADR-SYS-001 §1`). Um agente externo não tem essa fronteira anterior — ele **é** a fronteira. Concedê-lo `service_role` não delega autorização: elimina-a, e com ela o isolamento de tenant de todas as contas simultaneamente.

Esta decisão é sustentada por `ADR-SYS-001` e por `api-context.ts:22-27`, que já resolveram exatamente este problema para o caso da API pública. **Não altera nenhuma RLS, não cria policy, não cria token** — apenas registra que a porta existente é a correta e que abrir outra seria regressão.

### 8.4 `[RISCO-1]` — precedente de acesso direto ao banco no ecossistema

Este é o risco mais sério identificado nesta auditoria, e é registrado como risco **precisamente porque não pôde ser descartado**.

Status: evidência externa a este repositório — reconfirmada por leitura direta em 2026-08-07 (verificação de higiene pós-gate) contra `c:\Users\weyne\Claude\Projects\heimdall` e `c:\Users\weyne\Claude\Projects\ForgeSkill`, ambos presentes e acessíveis no workspace desta sessão. As três citações de `main.py` (linhas 157/168/182) e o conteúdo textual de `PROVENANCE.md`/`SOUL.md` conferem; duas âncoras de linha citadas na versão anterior estavam incorretas por 1–3 linhas e foram corrigidas nesta revisão (`PROVENANCE.md:16→15`, `SOUL.md:22→19`) — a substância das citações não muda. Nenhuma verificação foi feita sobre o runtime de produção de Heimdall (só o código-fonte declarado); a ressalva já registrada abaixo sobre `SUPABASE_URL` injetado em deploy permanece válida e não confirmável a partir do código. **Não se afirma, e não se afirmou antes, que Heimdall acessa dados do FORCECRM** — a substância do risco é o padrão arquitetural precedente (agente com escrita direta a banco), não uma alegação sobre o banco do FORCECRM especificamente.

**Fato observado:** Heimdall — o *"primeiro agente real do ecossistema"* — **escreve diretamente em tabelas Supabase**, sem passar por API alguma:

```python
supabase.table("leads").insert(payload).execute()          # heimdall/scripts/main.py:157
supabase.table("conversations").insert({...}).execute()    # heimdall/scripts/main.py:168
supabase.table("journey_events").insert({...}).execute()   # heimdall/scripts/main.py:182
```

Nenhuma dessas escritas carrega `account_id`. O cliente é criado com `SUPABASE_KEY` de ambiente, sem impersonação de usuário (`main.py:19-26`).

**O que isso significa e o que não significa:**

- `[OBSERVADO]` Existe, no ecossistema, um agente em produção cujo padrão de acesso a dados é escrita direta em banco, sem tenancy.
- `[OBSERVADO]` Existe intenção escrita de que o Supabase seja *"hub central do ecossistema DigitalLForce"* (`heimdall/PROVENANCE.md:15`).
- `[OBSERVADO]` **Nenhum sistema do ecossistema adjacente aponta hoje para o projeto Supabase do FORCECRM.** Verificado: o FORCECRM usa o projeto `uybjenopyvdmuixnhzqh` (`wacrm/.env.local`); o único outro host Supabase real configurado no ecossistema é `zuoqmxmovywrnqmzhmvc` (`ForgeSkill/.env`) — **projeto distinto**. Corroborado pela incompatibilidade de esquema: o de Heimdall (`leads`, `journey_events`, e uma `conversations` chaveada por `lead_id` sem `account_id`) não é o do FORCECRM (`conversations` com `account_id`, `contact_id`, `assigned_agent_id`) — nomes de tabela colidentes, bancos diferentes.
- `[OBSERVADO — RESSALVA]` **Heimdall não tem arquivo `.env` no repositório**, portanto seu `SUPABASE_URL` de runtime é injetado no deploy (VPS) e não é verificável a partir do código. A conclusão acima é forte para o estado configurado observável, mas **não é uma garantia sobre o runtime de Heimdall.**
- **O que NÃO é afirmado:** que Heimdall acessa dados do FORCECRM. Não há evidência disso, e Heimdall não referencia este repositório de forma alguma.

**Por que continua sendo risco de fronteira, mesmo com bancos distintos:** o padrão arquitetural precedente do ecossistema para "agente + dados" é acesso direto ao banco. Se ROXY herdar esse padrão (`[QUESTÃO R9]`) e for apontada ao banco do FORCECRM (`[QUESTÃO R4]`), toda a fronteira das §§6 e 8 é contornada em silêncio — sem erro, sem log, sem falha visível. A RLS não seria violada; seria simplesmente irrelevante, porque `service_role` a contorna por definição.

**Ação registrada, não executada:** `R4` e `R9` do questionário de §4.3 devem ser respondidas **antes** de qualquer credencial de banco ser emitida para ROXY. Este documento não emite, revoga nem altera credencial alguma.

---

## 9. Ações e autoridade

`[DECISÃO D8]` — **ROXY não executa efeitos diretamente no domínio do FORCECRM. Ela os solicita através de uma superfície controlada.**

A superfície controlada é A3 (§8.3): chave de conta + escopo. Isso segue de D7 (sem acesso direto ao banco) e de D5 (o fato de negócio é do FORCECRM): se o registro autoritativo é do FORCECRM, a escrita tem que passar pelo FORCECRM, onde vivem as invariantes de integridade — `settle_outbound_message` como autoridade transacional única (`ODI-001 §5/§9`), unicidade de run ativa por contato, identidade canônica de telefone.

Um agente que escrevesse direto contornaria essas invariantes sem sequer saber que existem.

### 9.1 Classificação de ações

| Classe | Exemplos | Superfície hoje | Estado |
|---|---|---|---|
| **Leitura** | ler contatos, conversas, mensagens | escopos `contacts:read`, `conversations:read`, `messages:read` definidos; endpoints não existem | `[PREVISTO]` — §7.2/P1 |
| **Envio de mensagem** | enviar WhatsApp ao contato | escopo `messages:send` definido; `POST /api/v1/messages` não existe | `[PREVISTO]` |
| **Ação de domínio** | criar/atualizar contato, criar deal, aplicar tag | `contacts:write` definido; deals e tags **não têm escopo algum** | `[PREVISTO]` / lacuna |
| **Alteração de estado operacional** | atribuir conversa, fechar conversa, mudar estágio | **nenhum escopo existe** | `[QUESTÃO Q4]` |
| **Automação** | criar/ativar automation ou flow | **nenhum escopo existe** | `[QUESTÃO Q4]` |
| **Administração** | gerenciar membros, papéis, credenciais de provider, chaves de API | **nenhum escopo existe, e nenhum deve existir** | ver D9 |

`[DECISÃO D9]` — **A classe administrativa permanece fora de qualquer superfície acessível a agente.** Gestão de membros, papéis, propriedade de conta, credenciais de provider e emissão/revogação de chaves de API são operações de humano autenticado (A1). Um agente capaz de emitir chaves de API pode ampliar a própria autoridade — o que anula a fronteira inteira e a torna não-auditável. Esta decisão não requer código: é o estado atual (`src/app/api/account/**` exige sessão), e é registrada aqui para que permaneça uma decisão em vez de um acidente.

`[QUESTÃO Q4]` — Se ações de estado operacional e de automação devem ser expostas por escopo, e com que granularidade, é decisão do `ADR-AI-001`. Este documento apenas registra que **hoje não há escopo para elas** e que criar um é decisão de fronteira, não detalhe de implementação.

---

## 10. Automations / Flows / ROXY

O escopo desta etapa nomeou o risco a evitar. Vale repeti-lo literalmente:

```
Automation → Agent → Flow → Automation → Agent
```

Uma cadeia sem fronteira, na qual nenhum ponto detém a decisão e nenhum detém o estado. É o modo de falha característico de sistemas onde uma camada cognitiva é adicionada a um orquestrador existente sem que se decida qual dos dois manda.

### 10.1 Alinhamento com `ADR-AUT-001` — não contradito

| `ADR-AUT-001` | Este documento |
|---|---|
| D1 — Automations e Flows permanecem dois motores distintos e complementares | Preservado. ROXY não é um terceiro motor. |
| D2 — `getProvider()` pertence à camada de entrega, não aos motores | Preservado e estendido: ROXY também não é dona dela (D11). |
| D3 — `engineSendBase` é alvo de extração futuro, não infraestrutura atual | Intocado. |
| D4 — contrato de precedência Flows-primeiro é decisão formal | Preservado. ROXY não se insere nessa precedência (D10). |
| D6 — round-robin permanece dívida documentada | Intocado. Não implementado aqui. |
| D7/§9 — IA fora de escopo, deferida a esta reconciliação | É o que esta seção atende, sem exceder. |

### 10.2 Decisões de fronteira

`[DECISÃO D10]` — **ROXY não substitui, não absorve e não se torna Automations ou Flows; e Automations e Flows não se tornam agentes.** Automations continua sendo árvore de ações sobre evento discreto; Flows continua sendo máquina de estados conversacional com posição persistida em `flow_runs.current_node_key`. Nenhum dos dois adquire capacidade cognitiva, e ROXY não adquire as garantias deles (dedup, unicidade de run ativa, precedência de entrada).

`[DECISÃO D11]` — **A propriedade do provider não muda.** `getProvider()` permanece da camada de entrega (`ADR-AUT-001 D2`, `ADR-MSG-001 D3.b`). ROXY **não fala com Meta, Z-API ou uazapi em nome de uma conta do FORCECRM.** As credenciais de provider são cifradas por conta e vinculadas a contexto (`ADR-CRYPTO-001`, `whatsappConfigBindingContext`); expô-las a um sistema externo eliminaria essa vinculação. Se ROXY precisa que uma mensagem chegue ao cliente, ela pede ao FORCECRM (D8).

`[DECISÃO D12]` — **A precedência de entrada de `ADR-AUT-001 D4` não é reaberta.** Flows continua avaliando primeiro e continua sendo quem decide `consumed`. Nenhuma reentrada de ROXY para dentro do pipeline de entrada é estabelecida por este documento. Concretamente: este documento **não** cria um caminho em que uma resposta de ROXY seja reinjetada como mensagem de entrada — que é precisamente o mecanismo pelo qual a cadeia recursiva acima se fecharia.

### 10.3 O que fica em aberto

`[QUESTÃO Q5]` — **Como e onde um passo cognitivo se insere na execução, se é que se insere.** Três formas são estruturalmente possíveis contra o código de hoje, e o `ADR-AI-001` deve escolher entre elas com critério explícito:

1. **Nó dentro de um Flow** — o seam `http_fetch` já existe no schema e está morto (§7.2/P3). O estado permanece em `flow_runs`; ROXY responderia sem reter posição conversacional.
2. **Passo dentro de uma Automation** — `send_webhook` já executa (§7.1/I2), mas é fire-and-forget: o motor não consome resposta (`engine.ts:565` devolve só o código HTTP). Consumir resposta exigiria alterar Automations, hoje fora de escopo.
3. **Consumidor externo da API pública** — ROXY observa e age por A3, sem se inserir no pipeline de entrada. É a forma que mais preserva as fronteiras deste documento, e a que mais depende de P1/P2 (não implementados).

`[QUESTÃO Q6]` — **Quem detém a decisão quando um agente e uma regra determinística discordam** sobre a mesma mensagem. `ADR-AUT-001 D4` resolveu o caso Flows × Automations com supressão seletiva por classe de gatilho. O análogo para ROXY não existe e **não é decidido aqui** — decidi-lo exigiria conhecer a forma escolhida em Q5.

`[QUESTÃO Q7]` — **Terminação e limite de recursão.** Qualquer forma escolhida em Q5 precisa de um critério de parada explícito. Registrado como requisito obrigatório do `ADR-AI-001`, não como desenho.

---

## 11. Hermes / OpenClaw

`[OBSERVADO]` — **Nem Hermes nem OpenClaw têm qualquer relação com o FORCECRM.** Zero ocorrências em `src/`, `supabase/` ou `package.json`. Não são dependência, não são runtime, não são camada.

Ambos aparecem no ecossistema por um caminho específico e documentado: são **projetos OSS de terceiros, catalogados pelo SkillForge e usados como fontes de composição do Heimdall**.

| Componente | O que é | Papel documentado | Classificação |
|---|---|---|---|
| **Hermes** | `NousResearch/hermes-agent` — agente OSS auto-melhorável, memória persistente, multi-plataforma. Catalogado pelo SkillForge com score 8.4/10. Fonte: `heimdall/NousResearch-hermes-agent.md:1-8` | *"padrão conversacional"* de Heimdall — `ForgeSkill/heimdall/SOUL.md:19`. Origem do objetivo, *"base no maior score geral"* — `heimdall/PROVENANCE.md:11` | **Referência arquitetural / fonte de composição.** Não é dependência do FORCECRM. |
| **OpenClaw** | `openclaw/openclaw` — projeto OSS externo | *"motor"* de Heimdall — `ForgeSkill/heimdall/SOUL.md:19`. Origem da arquitetura, *"melhor arquitetura entre as fontes (7/10)"* — `heimdall/PROVENANCE.md:13` | **Referência arquitetural / fonte de composição.** Não é dependência do FORCECRM. |

Evidência consolidadora — `heimdall/SKILL.md:8`:

> *"Skill composta pelo SkillForge a partir de: NousResearch/hermes-agent, openclaw/openclaw."*

`[DECISÃO D13]` — **Nenhuma das equações abaixo é adotada:** `Hermes = ROXY`, `OpenClaw = ROXY`, `ROXY = Hermes + OpenClaw`. A evidência disponível liga Hermes e OpenClaw a **Heimdall**, não a ROXY. Se ROXY compartilha essa linhagem, isso é fato a ser fornecido pela arquitetura ROXY (`[QUESTÃO R9]`), não inferido daqui.

**Nenhuma dependência nova é introduzida. Nenhum desses projetos é instalado, alterado ou referenciado por código.**

---

## 12. Decisões

Somente decisões sustentadas por evidência apresentada acima.

| # | Decisão | Base |
|---|---|---|
| **D1** | As 13 responsabilidades de §3 permanecem integralmente do FORCECRM. | §3, evidência de código |
| **D2** | A responsabilidade cognitiva/IA não está no FORCECRM e não é reivindicada por ele. Enunciado sobre o FORCECRM, não sobre ROXY. | `MASTER-ROADMAP:93,156,382`; `package.json` sem deps de LLM; `ADR-AUT-001:10` |
| **D3** | Nenhuma responsabilidade compartilhada é estabelecida. | §5 |
| **D4** | Source of truth é atribuído por classe de estado, não por sistema. | §6 |
| **D5** | O resultado operacional de qualquer ação cognitiva é estado do FORCECRM, onde quer que a decisão tenha sido tomada. | `ODI-001 §5/§9` |
| **D6** | ROXY não recebe confiança implícita; acessa como máquina externa via A3 (chave de conta + escopo). | `api-context.ts:80-118`; `scopes.ts:16-23` |
| **D7** | ROXY não recebe acesso direto ao Postgres/Supabase do FORCECRM. | `ADR-SYS-001 §1`; `api-context.ts:22-27` |
| **D8** | ROXY solicita efeitos por superfície controlada; não os executa diretamente. | D5 + D7 |
| **D9** | A classe administrativa permanece fora de qualquer superfície acessível a agente. | §9.1; estado atual de `src/app/api/account/**` |
| **D10** | ROXY não substitui nem se torna Automations/Flows; Automations/Flows não se tornam agentes. | `ADR-AUT-001 D1` |
| **D11** | A propriedade do provider não muda; ROXY não fala com providers em nome de uma conta. | `ADR-AUT-001 D2`; `ADR-MSG-001 D3.b`; `ADR-CRYPTO-001` |
| **D12** | A precedência de entrada de `ADR-AUT-001 D4` não é reaberta; nenhuma reentrada de ROXY no pipeline de entrada é criada. | `ADR-AUT-001 D4` |
| **D13** | `Hermes = ROXY`, `OpenClaw = ROXY` e `ROXY = Hermes + OpenClaw` são todas rejeitadas por falta de base. | §11 |

**Riscos registrados, não corrigidos:** `RISCO-1` (precedente de acesso direto ao banco no ecossistema, §8.4) · `RISCO-2` (`send_webhook` sem assinatura, sem allowlist, `http:` permitido, §7.1).

---

## 13. Questões deferidas para o ADR-AI-001

Nenhuma destas é decidida aqui. Todas são pré-requisito dele.

**Do lado ROXY — bloqueantes (§4.3):** `R1` natureza (produto vs. camada) · `R2` onde executa · `R3` estado próprio · **`R4` acesso direto ao banco do FORCECRM** · `R5` como recebe contexto · `R6` como devolve ação · `R7` API/protocolo versionado · `R8` conhecimento de internals do FORCECRM · `R9` relação com Heimdall · `R10` por tenant ou instância única.

**De fronteira, decidíveis assim que R1–R10 existirem:**

| # | Questão | Origem |
|---|---|---|
| **Q1** | Onde vive a memória cognitiva e quem é seu source of truth. Hoje não existe em lugar nenhum (zero tabelas em `001`–`075`). | §6 |
| **Q2** | Onde vive a persona/política do agente. Precedente do ecossistema a mantém fora do banco. | §6 |
| **Q3** | Se a decisão do agente (o raciocínio) é persistida, onde, e por quanto tempo. | §6 |
| **Q4** | Se ações de estado operacional e de automação ganham escopo de API, e com que granularidade. | §9.1 |
| **Q5** | Como e onde um passo cognitivo se insere na execução — nó de Flow (`http_fetch`), passo de Automation, ou consumidor externo da API. | §10.3 |
| **Q6** | Quem detém a decisão quando agente e regra determinística discordam sobre a mesma mensagem. | §10.3 |
| **Q7** | Critério de terminação e limite de recursão da forma escolhida em Q5. | §10.3 |
| **Q8** | Billing e atribuição de custo de inferência por tenant. Levantado em `RECONCILIACAO-FINAL:90` ("data/ação/autoridade/tenant/billing"); os quatro primeiros são tratados aqui, **billing não é**. | §1 |
| **Q9** | Como `RISCO-2` é fechado se `send_webhook` (I2) vier a ser o transporte para ROXY — assinatura, allowlist, obrigatoriedade de `https:`. | §7.1 |

**Dependências de implementação, não de decisão** (não bloqueiam o `ADR-AI-001`, mas bloqueiam qualquer integração real): P1 (endpoints de dados `/api/v1`) e P2 (webhooks de saída / E14) não existem. Hoje, **a superfície utilizável por ROXY é `GET /api/v1/me`** — identidade e nada mais.

---

## 14. Fora de escopo

Explicitamente **não** produzidos, alterados ou decididos por este documento:

- `ADR-AI-001` — **não criado.** Este documento produz insumos para ele.
- Implementação de IA, agent runtime, copilot, agent loop, tool registry, planner, memory engine, model router, AI gateway, dispatcher autônomo.
- Event bus. MCP. Qualquer nova camada de orchestration. Qualquer motor novo.
- Alterações em Automations (`src/lib/automations/`) ou Flows (`src/lib/flows/`) — inclusive `RISCO-2` e a superfície morta `http_fetch`, ambos registrados e deixados intactos.
- Alterações em RLS, policies, `is_account_member()`, emissão de tokens ou credenciais.
- Alterações de schema ou migrations.
- `departments`, filas, SLA, take-over, round-robin real (permanece dívida por `ADR-AUT-001 D6`).
- Correção de S2 ou S3.
- Extração de `engineSendBase`; unificação do dispatch de precedência.
- Deploy, migration de produção, commit, push.

---

## 15. Estado do working tree no momento desta redação

Registrado para rastreabilidade; nenhum destes itens é alterado por este documento.

- **Modificado:** `docs/MASTER-ROADMAP.md` (não commitado — correção da etapa anterior).
- **Não rastreados:** `.claude/settings.json`, `audit.ps1`, `docs/adr/ADR-AUT-001-automations-flows-reconciliation.md`, `docs/checkpoints/CHECKPOINT-S2-S3-AUDITED.md`, `docs/planning/ANALISE-COMPETITIVA-CHATPRO-2026-08-07.md`, `docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md`, `src/test/c21-assigned-agent-fk.pglite.test.ts`, `supabase/migrations/075_conversations_assigned_agent_fk.sql`.

Como `ADR-AUT-001` ainda não está commitado, este documento cita um artefato presente apenas no working tree — coerente com a mesma condição registrada em `ADR-AUT-001:11`.

---

## BLOQ-1 — Bloqueio registrado

**A §4 deste documento não pôde ser preenchida com evidência.** Não existe arquitetura de ROXY acessível (§2.2). O documento foi escrito assim mesmo, por decisão explícita, porque o lado FORCECRM é integralmente determinável e as decisões D1–D13 são sustentáveis sem conhecer ROXY — todas são enunciados sobre **o que o FORCECRM concede e o que não concede**, que é precisamente a metade da fronteira que o FORCECRM tem autoridade para decidir sozinho.

**O que este bloqueio impede:** responder R1–R10; portanto responder Q1–Q7; portanto escrever o `ADR-AI-001`.

**Condição de saída:** fornecer a arquitetura de ROXY — ou, no mínimo, respostas a R1–R10 — e complementar a §4 deste documento antes de iniciar o `ADR-AI-001`.

---

## Apêndice — evidências citadas

**Fronteira de autorização e tenancy**
- `src/lib/auth/api-context.ts:22-27` — por que `service_role` na API pública; tenancy por disciplina de aplicação
- `src/lib/auth/api-context.ts:80-118` — `requireApiKey`: bearer → hash → rate limit → escopo → contexto de conta
- `src/lib/auth/api-context.ts:110-117` — `accountId` fixado na linha da chave, não em entrada do chamador
- `src/lib/api-keys/scopes.ts:3-8` — autorização *scopes-only*, independente do papel do criador
- `src/lib/api-keys/scopes.ts:16-23` — os seis escopos existentes
- `docs/adr/ADR-SYS-001-background-system-authorization-boundary.md:§1` — os dois modelos de autorização não-declarados; padrão `service_role` de `insert_inbound_message` (035)

**Interfaces**
- `src/app/api/v1/me/route.ts:20-31` — único endpoint `/api/v1` implementado
- `docs/public-api.md` §Roadmap — P1 e P2, previstos
- `src/lib/automations/engine.ts:555-565` — `send_webhook`, única saída HTTP para destino arbitrário
- `src/lib/automations/validate.ts:118-133` — validação de `send_webhook`: só sintaxe de URL e protocolo `http`/`https`
- `src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts:19-38` — contrato de autenticação do webhook de entrada não-Meta
- `src/lib/flows/engine.ts:464`, `src/lib/flows/types.ts:184`, `supabase/migrations/010_flows.sql:127` — `http_fetch` no schema, sem handler

**Ausência de IA no FORCECRM**
- `docs/MASTER-ROADMAP.md:93` — *"Ausentes por completo [C, grep negativo]: ... AI, webhooks de saída ..."*
- `docs/MASTER-ROADMAP.md:156` — AI *"sem evidência — pós-MVP"*
- `docs/MASTER-ROADMAP.md:382` — AI entre os não-requisitos
- `package.json` — zero dependências de LLM/agente (verificado nesta auditoria)
- `supabase/migrations/` (001–075) — zero tabelas de memória cognitiva ou embedding

**Origem da questão**
- `docs/adr/ADR-AUT-001-...:10` — deferimento explícito da localização de IA a FORCECRM × ROXY
- `docs/adr/ADR-AUT-001-...:192-193` — `ADR-AI-001` e esta reconciliação fora do escopo daquele ADR
- `docs/adr/ADR-AUT-001-...:D1,D2,D4,D6` — decisões preservadas por §10.1
- `docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md:90` — Roxy-agent em desenvolvimento paralelo

**Ecossistema adjacente (fora deste repositório, leitura somente)**
- `heimdall/README.md:1-4` — Heimdall como primeiro agente real do ecossistema
- `heimdall/scripts/main.py:19-26,157,168,182` — cliente Supabase de ambiente; escritas diretas sem `account_id`
- `heimdall/PROVENANCE.md:11-16` — origens de composição; Supabase como *"hub central do ecossistema"*
- `wacrm/.env.local` (`uybjenopyvdmuixnhzqh`) × `ForgeSkill/.env` (`zuoqmxmovywrnqmzhmvc`) — projetos Supabase distintos; Heimdall sem `.env` versionado
- `heimdall/SKILL.md:8` — Heimdall composto a partir de `hermes-agent` e `openclaw`
- `ForgeSkill/heimdall/SOUL.md:19` — *"Base técnica: OpenClaw (motor) + Hermes (padrão conversacional)"*
- `heimdall/NousResearch-hermes-agent.md:1-8` — ficha de catálogo de Hermes no SkillForge
- `ForgeSkill/README.md:1-8` — SkillForge como motor de engenharia de Skills
- `docs/checkpoints/GATE-EVIDENCE-E2.1-ACTIVATION-2026-08-03.md:18` — colisão de nome: *"Hermes Agent"* como auditor externo
