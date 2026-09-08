# FORCECRM x ROXY Boundary Reconciliation v1.0

**Versão:** 1.0 · **Data:** 2026-08-07 · **Status:** Documento de fronteira (não ADR) · **Baseline de código:** HEAD 2a6061e

---

## 1. Objetivo

Este documento estabelece explicitamente **onde termina o FORCECRM e onde começa o ROXY**, respondendo à questão deixada em aberto pelo ADR-AUT-001 (D7) e pela reconciliação competitiva de 2026-08-07 (§5.3, item 9).

O ADR-AUT-001 decidiu:
- Automations e Flows permanecem dois motores distintos do ForceCRM.
- **IA não entra como terceiro motor** nessa decisão.
- A localização concreta de qualquer capacidade de IA (nó dentro de Flows, capacidade de Automations, ou algo distinto) permanece **deliberadamente em aberto** até a reconciliação FORCECRM × ROXY.

Este documento **não cria ADR-AI-001**. Produz os insumos necessários para que o ADR-AI-001 possa ser escrito posteriormente com fronteira clara.

---

## 2. Sistemas Envolvidos

| Sistema | Estado no Repositório | Natureza |
|---------|----------------------|----------|
| **FORCECRM** (produto/SaaS, fork do WACRM) | **Implementado e em produção** — ~60 arquivos de teste, 43 tabelas com RLS, 74 RPCs, webhook Meta monolítico de 1038 loc, provider abstraction (getProvider()), Automations, Flows, Broadcasts, Attribution (CTWA), Platform/Superadmin | CRM transacional multi-tenant sobre WhatsApp Business |
| **ROXY** | **Não existe no código** — apenas referenciado em ADR-AUT-001:10,128,167,193 e RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md:90 como Roxy-agent em desenvolvimento paralelo | Camada cognitiva/agent runtime (a definir) |
| **Hermes** | Apenas dependência hermes-parser (React Native) + referência a auditoria externa Hermes Agent (GATE-EVIDENCE-E2.1-ACTIVATION-2026-08-03.md:18) | Parser JS / auditor externo — não é runtime do ForceCRM |
| **OpenClaw** | **Nenhuma ocorrência** no repositório | Não aplicável |


---

## 3. Responsabilidades do FORCECRM

Baseado em evidência de código (src/, supabase/migrations/, docs/MASTER-ROADMAP.md, ADRs aceitos):

### 3.1 Domínio Transacional (Source of Truth)
- Contatos — contacts, contact_tags, tags (migrations 001, 017, 025, 040)
- Conversas — conversations, assigned_agent_id (FK adicionada em migration 075, test c21-assigned-agent-fk.pglite.test.ts)
- Mensagens — messages com sender_type CHECK (customer,agent,bot), status CHECK (sending,sent,delivered,read,failed), message_external_ids (migration 047, EIS-001)
- Deals/Pipelines — deals, pipeline_stages (migration 001, 017)
- Accounts/Workspaces/Membership — accounts, profiles, account_members (migrations 017–021, 041–046)

### 3.2 Comunicação WhatsApp
- Inbox — realtime via Supabase Realtime (inbound-processor.ts, webhook/route.ts)
- Providers — getProvider() abstraction para Meta, Z-API, uazapi (src/lib/whatsapp/providers/, ADR-MSG-001, DLB-001)
- Templates Meta — CRUD completo, sync, aprovação (8 arquivos de teste)
- Broadcasts — provider-agnósticos via getProvider() (broadcast/route.ts:32,177)
- Mídia — proxy autenticado Meta (/api/whatsapp/media/{mediaId}), URL direta não-Meta (mediaRefIsUrl)

### 3.3 Orquestração (Dois Motores)
- Automations — árvore de ações reativas a evento discreto (src/lib/automations/, automations + automation_steps + automation_logs + automation_pending_executions)
- Flows — máquina de estados conversacional multi-turno (src/lib/flows/, flows + flow_nodes + flow_runs + flow_run_events)
- Precedência — Flows avalia primeiro (síncrono, await); consumo suprime gatilhos de conteúdo de Automations; gatilhos de identidade disparam sempre (ADR-AUT-001 D4, webhook/route.ts:758-840, inbound-processor.ts:360-393)

### 3.4 Atribuição & Identidade
- CTWA Attribution — captura (lead_attributions), enriquecimento via Marketing API (E6.0, ADR-ATTR-001/002 Aceitos)
- External Identity — ExternalIdentity + message_external_ids para correlação multi-provider (EIS-001, migration 047)

### 3.5 Segurança & Tenancy
- RLS em 43 tabelas, scope account_id via is_account_member()
- Platform/Superadmin — contexto /act/[accountId] read-only, RPCs SECURITY DEFINER com autorização role=admin AND is_active + can_access_account()
- Criptografia — AES-256-GCM com key_version + re-encrypt (E7, ADR-CRYPTO-001, ADR-E7-001)

### 3.6 APIs & Integração
- Public API v1 — scaffold (/api/v1/me)
- Webhooks de entrada — Meta (/api/whatsapp/webhook), não-Meta (/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret])
- Webhooks de saída — ausentes (gap identificado, item #1 da análise ChatPro)

---

## 4. Responsabilidades do ROXY

Evidência direta no repositório: NENHUMA.

O ROXY não possui:
- Código em src/
- Migrations em supabase/migrations/
- Testes em src/test/
- Documentação arquitetural própria (não existe ROXY-VISION.md, ROXY-ARCHITECTURE.md, SOUL.md)
- Schema de banco
- API routes
- Componentes UI

### 4.1 Referências Documentais Encontradas

| Documento | Referência | Classificação |
|-----------|------------|---------------|
| ADR-AUT-001:10 | deferido a FORCECRM × ROXY | Decisão de escopo — IA não decidida aqui |
| ADR-AUT-001:128 | localização concreta de qualquer capacidade de IA... permanece deliberadamente em aberto até a reconciliação de fronteiras FORCECRM × ROXY | Decisão de fronteira — ROXY é candidato a hospedar IA |
| ADR-AUT-001:167 | nenhuma arquitetura de IA, ADR-AI-001, ou documento FORCECRM × Roxy é criado aqui | Confirmação de fora de escopo |
| ADR-AUT-001:193 | Reconciliação de fronteiras FORCECRM × ROXY | Item fora de escopo explícito |
| RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md:90 | precisa reconciliar com a Roxy-agent, que já está em desenvolvimento paralelo | Observação externa — afirma desenvolvimento paralelo fora deste repo |

### 4.2 Classificação Arquitetural do ROXY (Inferida das Referências)

| Atributo | Classificação | Evidência |
|----------|---------------|-----------|
| Papel | Camada cognitiva / agent runtime | ADR-AUT-001 D7: localização concreta de qualquer capacidade de IA |
| Onde roda | Não decidido — fora do repo ForceCRM | Nenhum código, nenhuma configuração de deploy |
| Estado próprio | Não decidido — pode ter memória cognitiva separada | ADR-AUT-001 não define |
| Ferramentas | Não decidido — LLM providers, tool calling, memory | RECONCILIACAO-FINAL menciona Roxy-agent em desenvolvimento paralelo |
| Como recebe contexto | Não decidido — interface ForceCRM → ROXY não existe | Nenhuma interface implementada |
| Como devolve ações | Não decidido — interface ROXY → ForceCRM não existe | Nenhuma interface implementada |
| API/Protocolo explícito | Não existe | Grep negativo |
| Dependência direta do banco ForceCRM | Não existe | Nenhum código ROXY no repo |
| Dependência direta do runtime ForceCRM | Não existe | Nenhum código ROXY no repo |
| ForceCRM conhece ROXY | Não — apenas menção em ADR/comentário | ADR-AUT-001 cita ROXY como fronteira futura |
| ROXY conhece internos do ForceCRM | Não aplicável — ROXY não existe no repo | — |

---

## 5. Responsabilidades Compartilhadas

Nenhuma responsabilidade compartilhada existe hoje.

| Classe de Responsabilidade | Status | Observação |
|---------------------------|--------|------------|
| Dados transacionais | ForceCRM exclusivo | ROXY não acessa Supabase |
| Orquestração (Automations/Flows) | ForceCRM exclusivo | ADR-AUT-001 D1: dois motores do ForceCRM |
| Provider abstraction | ForceCRM exclusivo | getProvider() em src/lib/whatsapp/providers/ |
| Identidade/Autorização/Tenancy | ForceCRM exclusivo | RLS, RPCs, Platform context |
| IA/Cognição | AINDA NÃO DECIDIDO | Deferido a ADR-AI-001 após esta reconciliação |

---

## 6. Source of Truth — Tabela por Classe de Estado

| Classe de Estado | Source of Truth | ForceCRM | ROXY | Observação |
|------------------|-----------------|----------|------|------------|
| Contatos | ForceCRM (contacts) | ✅ Owner | ❌ | RLS por account_id |
| Conversas | ForceCRM (conversations) | ✅ Owner | ❌ | assigned_agent_id FK (mig 075) |
| Mensagens | ForceCRM (messages + message_external_ids) | ✅ Owner | ❌ | sender_type, status, identidades externas |
| Deals/Pipelines | ForceCRM (deals, pipeline_stages) | ✅ Owner | ❌ | |
| Accounts/Workspaces/Users | ForceCRM (accounts, profiles) | ✅ Owner | ❌ | Platform context /act/[accountId] |
| Automation definitions | ForceCRM (automations, automation_steps) | ✅ Owner | ❌ | |
| Flow definitions | ForceCRM (flows, flow_nodes) | ✅ Owner | ❌ | |
| Flow runtime state | ForceCRM (flow_runs, flow_run_events) | ✅ Owner | ❌ | current_node_key por contato |
| Automation logs | ForceCRM (automation_logs, automation_pending_executions) | ✅ Owner | ❌ | |
| WhatsApp config/tokens | ForceCRM (whatsapp_config ciphertext) | ✅ Owner | ❌ | Criptografia AES-256-GCM key_version |
| Lead Attribution | ForceCRM (lead_attributions, tracking_links) | ✅ Owner | ❌ | ADR-ATTR-001/002 |
| Templates Meta | ForceCRM (whatsapp_templates) | ✅ Owner | ❌ | Sync com WABA |
| Memória cognitiva (contexto de agente, histórico inferido, preferências) | AINDA NÃO DECIDIDO | ❓ | ❓ | Questão para ADR-AI-001 |
| Memória de interação (chat history para LLM) | AINDA NÃO DECIDIDO | ❓ (tem messages) | ❓ | ForceCRM tem histórico bruto; ROXY pode precisar versão processada |
| Conhecimento recuperado (RAG) | AINDA NÃO DECIDIDO | ❌ | ❓ | ForceCRM não tem RAG hoje |

---

## 7. Interfaces FORCECRM ↔ ROXY

Nenhuma interface implementada existe hoje.

| Interface | Origem | Destino | Estado | Detalhes |
|-----------|--------|---------|--------|----------|
| Webhook HTTP | ForceCRM | ROXY | PREVISTO | Não implementado. ADR-AUT-001 não define. |
| HTTP API (REST/gRPC) | ForceCRM | ROXY | PREVISTO | Não implementado. |
| Eventos/Message Queue | ForceCRM | ROXY | PREVISTO | Padrão de ledger+cron existe (E4b, ARO-001), mas não estendido para ROXY. |
| Tool Calls / Function Calling | ROXY | ForceCRM | PREVISTO | Não implementado. ROXY não existe. |
| MCP (Model Context Protocol) | ROXY | ForceCRM | PREVISTO | Não implementado. Menção apenas em escopo futuro. |
| Telegram / Z-API bridge | ForceCRM | ROXY | NÃO APLICÁVEL | ForceCRM já tem providers diretos. |
| Persistência compartilhada (Supabase) | — | — | NÃO | ROXY não acessa banco ForceCRM. |
| Callbacks / Webhooks de resposta | ROXY | ForceCRM | PREVISTO | Não implementado. |

Evidência: Grep por roxy, mcp, tool.call, function.call, agent.runtime no src/ — zero resultados.

---

## 8. Segurança e Tenancy

### 8.1 Fronteira Atual (ForceCRM only)
- Autenticação: Supabase Auth (@supabase/ssr), session cookies, middleware CSP/rate-limit
- Autorização: RLS em 43 tabelas via is_account_member(account_id); RPCs SECURITY DEFINER com can_access_account() + role=admin AND is_active
- Tenancy: account_id em todas as tabelas de domínio; Platform context /act/[accountId] para superadmin read-only
- Segredos: whatsapp_config.access_token/verify_token/waba_id como ciphertext AES-256-GCM por tenant; ENCRYPTION_KEY com versionamento (E7)

### 8.2 Questões para ROXY (Não Resolvidas)

| Questão | Status | Risco se Não Endereçado |
|---------|--------|-------------------------|
| Quem autentica chamadas ForceCRM → ROXY? | ABERTA | ROXY exposto sem auth |
| Quem autoriza acesso a tenant no ROXY? | ABERTA | Vazamento cross-tenant |
| ROXY conhece account_id? | ABERTA | ROXY precisa de tenant context para isolamento |
| ROXY aplica RLS? | ABERTA — ROXY não tem acesso ao Supabase ForceCRM | Se ROXY acessar banco direto, quebra isolamento |
| ForceCRM deveria intermediar acesso ROXY → dados? | ABERTA — Recomendado por encapsulamento | ROXY acoplando a schema interno do ForceCRM |
| Billing/medição de uso de IA por tenant? | ABERTA — ChatPro cobra IA como add-on (ANALISE-COMPETITIVA §2.2) | Sem modelo de cobrança de IA |

Evidência: ADR-SYS-001 (authorization boundary), ADR-CRYPTO-001, ADR-E7-001, migration 074 (S1 tenant escalation fix), CHECKPOINT-FORCECRM-SECRET-ROTATION.md.

---

## 9. Ações e Autoridade — O que Cada Lado Pode Fazer

| Ação | ForceCRM | ROXY | Classificação | Evidência |
|------|----------|------|---------------|-----------|
| Leitura de contatos/conversas/mensagens | ✅ Owner (RLS) | ❓ PREVISTO | Leitura | ForceCRM é source of truth |
| Criação/atualização de contatos | ✅ Owner | ❓ PREVISTO | Ação de domínio | Apenas ForceCRM hoje |
| Envio de mensagem WhatsApp | ✅ Owner (getProvider()) | ❓ PREVISTO | Envio de mensagem | send/route.ts, broadcast/route.ts, engines |
| Alteração de estado conversa (assign, close, tag) | ✅ Owner | ❓ PREVISTO | Alteração de estado | message-thread.tsx:760-776, automations assign_conversation |
| Execução de Automation step | ✅ Owner (runAutomationsForTrigger) | ❌ | Automação | Fire-and-forget, 2 call-sites |
| Execução de Flow node | ✅ Owner (dispatchInboundToFlows) | ❌ | Automação | Awaited, síncrono |
| Disparo de webhook de saída | ❌ Ausente | ❓ PREVISTO | Integração | Gap identificado (#1 ChatPro) |
| Chamada a LLM externo | ❌ Não existe | ❓ PREVISTO | Ação cognitiva | Zero infraestrutura LLM no repo |
| Leitura/escrita memória cognitiva | ❌ Não existe | ❓ PREVISTO | Memória | Não definido |
| Tool calling (ações no domínio via LLM) | ❌ Não existe | ❓ PREVISTO | Ação de domínio | Não definido |
| Administração de tenant (criar, suspender, rotacionar secrets) | ✅ Platform/Superadmin | ❌ | Administração | RPCs SECURITY DEFINER platform-only |

Princípio arquitetural inferido: ROXY não deve executar diretamente efeitos no domínio do ForceCRM. Efeitos no domínio (criar mensagem, atribuir conversa, disparar automação) devem passar por superfície controlada do ForceCRM (API routes, RPCs, webhook interno) — não por acesso direto ao banco ou RPCs internos. Isso preserva:
- RLS/tenancy
- Auditoria (platform_audit_log)
- Idempotência (ODI-001, DLB-001)
- Precedência Automations/Flows (ADR-AUT-001 D4)

---

## 10. Automations / Flows / ROXY — Fronteira Explícita

| Dimensão | Automations (ForceCRM) | Flows (ForceCRM) | ROXY (Futuro) |
|----------|------------------------|------------------|---------------|
| Modelo de execução | Árvore de ações reativas a evento discreto | Máquina de estados conversacional multi-turno persistida | Agent loop / planner / tool calling (a definir) |
| Estado | Sem estado entre invocações (além de contacts/conversations) | flow_runs.current_node_key por contato (suspensão/retomada) | Memória cognitiva / context window (a definir) |
| Disparo | runAutomationsForTrigger (fire-and-forget) — 4 triggers: new_message_received, keyword_match, new_contact_created, first_inbound_message | dispatchInboundToFlows (awaited, síncrono) — triggers: keyword, first_inbound_message, manual | Não definido — pode ser event-driven, schedule, ou tool call |
| Precedência | Segunda — roda após Flows; gatilhos de conteúdo suprimidos se Flow consumiu | Primeira — avalia sempre primeiro; fallback ignore cede para Automations | Não definido — deve respeitar precedência existente |
| Provider | getProvider() — camada de entrega | getProvider() — camada de entrega | Não deve reimplementar — deve usar superfície ForceCRM |
| Decisão | Regras condicionais (Yes/No branches) | Navegação de grafo + input do cliente | LLM-based reasoning / planning (a definir) |
| Resultado operacional | Mensagens, tags, deals, assign, wait | Mensagens, collect_input, handoff to agent, http_fetch (morto) | Ações no domínio via superfície controlada |
| Superfícies mortas | conversation_assigned, tag_added, time_based (configuráveis, sem dispatcher) | http_fetch node, manual trigger (configuráveis, sem handler/start) | Não aplicar — ROXY não herda dívida |

Conflito a evitar (registrado em RECONCILIACAO-FINAL §5.3):
Automation → Agent → Flow → Automation → Agent
sem fronteira clara. Regra: ROXY não substitui Automations/Flows. Automations/Flows não se tornam agentes. IA entra como capacidade (nó, tool, ou camada distinta), não como motor #3.

---

## 11. Hermes / OpenClaw — Papel Arquitetural

| Componente | Relacionamento Real | Classificação |
|------------|---------------------|---------------|
| Hermes (hermes-parser) | Dependência de build/dev (React Native/JS parsing) | Dependência — package-lock.json:6320,7157-7171 |
| Hermes Agent (auditoria) | Auditor externo executado contra clone do repo | Auditoria externa — GATE-EVIDENCE-E2.1-ACTIVATION-2026-08-03.md:18 |
| OpenClaw | Nenhuma ocorrência no repositório | Não existe |

NÃO HÁ RELACIONAMENTO ARQUITETURAL entre ROXY e Hermes/OpenClaw. Não trate:
- Hermes = ROXY ❌
- OpenClaw = ROXY ❌
- ROXY = Hermes + OpenClaw ❌

---

## 12. Decisões Sustentadas pela Evidência

| # | Decisão | Fundamento |
|---|---------|------------|
| D1 | ForceCRM é o sistema transacional completo e source of truth para todos os dados de negócio, identidade, tenancy, orquestração (Automations/Flows), comunicação WhatsApp. | Código implementado, testado, em produção (src/, supabase/migrations/, ADRs aceitos). |
| D2 | ROXY não existe no repositório ForceCRM. Não há código, schema, API, testes, nem documentação arquitetural própria. | Grep/glob negativo em todo o repo. |
| D3 | A fronteira FORCECRM × ROXY não está implementada — nenhuma interface existe (webhook, API, eventos, MCP, tool calls, persistência compartilhada). | Grep negativo por roxy, mcp, tool.call, function.call, agent.runtime. |
| D4 | Automations e Flows permanecem motores do ForceCRM (ADR-AUT-001 D1). ROXY não os substitui; IA não vira motor #3 (ADR-AUT-001 D7). | ADR-AUT-001 decisões D1, D7. |
| D5 | ROXY, se/quando existir, deve acessar o domínio ForceCRM apenas através de superfície controlada (API routes, RPCs, webhooks internos) — não via banco direto nem RPCs internos. | Princípio de encapsulamento, RLS, auditoria, idempotência, precedência (ADR-SYS-001, ODI-001, DLB-001, ADR-AUT-001 D4). |
| D6 | Source of truth para dados transacionais permanece no ForceCRM. Memória cognitiva, histórico processado para LLM, conhecimento RAG — ainda não decidido (questão para ADR-AI-001). | ForceCRM tem messages bruto; ROXY pode precisar versão processada. |
| D7 | Segurança/tenancy: ForceCRM é autoridade. ROXY não conhece account_id nem aplica RLS hoje. Qualquer integração futura deve preservar isolamento de tenant. | ADR-SYS-001, ADR-CRYPTO-001, migration 074, CHECKPOINT-FORCECRM-SECRET-ROTATION. |
| D8 | Hermes/OpenClaw não são parte da arquitetura ForceCRM/ROXY. São dependência de build e auditoria externa, respectivamente. | Evidência direta em package-lock e checkpoint de auditoria. |

---

## 13. Questões Deferidas para ADR-AI-001

As seguintes questões não são decididas aqui e devem alimentar o futuro ADR-AI-001:

| # | Questão | Contexto |
|---|---------|----------|
| Q1 | Onde a IA reside arquiteturalmente? Nó dentro de Flows, capacidade de Automations, camada distinta (ROXY), ou híbrido? | ADR-AUT-001 D7 deixou explicitamente em aberto. |
| Q2 | ROXY é um serviço separado (deploy próprio) ou biblioteca vinculada ao ForceCRM? | Afeta latência, tenancy, versionamento, deploy. |
| Q3 | Qual o modelo de memória cognitiva? ForceCRM messages bruto → ROXY processa, ou ROXY mantém store próprio (vector DB, graph)? | Impacta source of truth, sync, custos. |
| Q4 | Como ROXY recebe contexto de conversa? Push (webhook/evento) ou pull (API)? | Define acoplamento temporal e confiabilidade. |
| Q5 | Como ROXY devolve ações ao ForceCRM? Tool calls via API controlada, webhooks de resposta, ou message queue? | Define superfície de integração e autoridade. |
| Q6 | ROXY tem autoridade para executar efeitos no domínio (enviar msg, assign, tag) ou apenas sugere (copiloto)? | Copiloto = humano no loop (menor risco); autônomo = superfície controlada obrigatória. |
| Q7 | Como funciona tenancy no ROXY? account_id propagado em cada chamada? Token scoped? Contexto implícito? | Crítico para isolamento (ChatPro cobra IA por tenant). |
| Q8 | Billing/medição de uso de IA por tenant? | Modelo comercial (ChatPro: add-on pago). |
| Q9 | Qual o protocolo de integração? REST, gRPC, MCP, WebSocket, message queue? | Define contratos, versionamento, observabilidade. |
| Q10 | ROXY usa LLM próprio (auto-hospedado) ou providers externos (OpenAI, Anthropic)? | Afeta privacidade, custo, latência, compliance. |
| Q11 | Como evitar ciclos Automation → ROXY → Flow → Automation? | Requer contrato de precedência estendido (ADR-AUT-001 D4). |
| Q12 | O que acontece com superfícies mortas de Automations/Flows quando IA entra? | http_fetch, manual, conversation_assigned, tag_added, time_based — IA pode preencher ou não. |

---

## 14. Fora de Escopo (Explícito)

Este documento não faz e não decide:

- ❌ ADR-AI-001 — não criado aqui.
- ❌ Implementação de IA / agent runtime / copilot / chatbot.
- ❌ Event bus / message queue / MCP / nova camada de orchestration.
- ❌ Alterações no engine de Automations (além do já decidido em ADR-AUT-001).
- ❌ Alterações no engine de Flows (além do já decidido em ADR-AUT-001).
- ❌ Alterações em RLS / policies / schema / migrations.
- ❌ Implementação de departments / filas / round-robin real / SLA / take-over.
- ❌ Correção de S2/S3 (buckets públicos, _bcast_bump sem REVOKE) — checkpoint pendente.
- ❌ Deploy / migration de produção / commit / push.
- ❌ Webhooks de saída (gap #1 ChatPro — item separado).
- ❌ Widget de site / Fonte B orgânica (ADR-ATTR-001 P2 — item separado).
- ❌ E2.1 Status Canônico (próxima épica oficial — Fase 1 pendente).
- ❌ E3 Connections / multi-conexão.
- ❌ E8 Integridade Referencial (C16, C19, C20, C21).
- ❌ E11 Public API v1 Resources.
- ❌ E12 Reporting & Export (desbloqueado, não iniciado).
- ❌ E13 Observabilidade.

---

## 15. Evidências — Referências arquivo:linha

| Afirmação | Classificação | Arquivo:Linha |
|-----------|---------------|---------------|
| ADR-AUT-001 defere IA a FORCECRM × ROXY | DECISÃO | docs/adr/ADR-AUT-001-automations-flows-reconciliation.md:10,128,167,193 |
| Automations e Flows são dois motores do ForceCRM | IMPLEMENTADO | docs/adr/ADR-AUT-001-automations-flows-reconciliation.md:113 (D1) |
| Precedência Flows → Automations implementada | IMPLEMENTADO | src/app/api/whatsapp/webhook/route.ts:758-840, src/lib/whatsapp/inbound-processor.ts:360-393 |
| getProvider() em Automations e Flows | IMPLEMENTADO | src/lib/automations/meta-send.ts:104, src/lib/flows/meta-send.ts:97,229,400 |
| ROXY não existe no código (grep negativo) | OBSERVADO | grep -r roxy src/ supabase/ --include=*.ts --include=*.tsx --include=*.sql |
| Hermes apenas como dependência hermes-parser | IMPLEMENTADO | package-lock.json:6320,7157-7171 |
| Hermes Agent = auditoria externa | DOCUMENTADO | docs/checkpoints/GATE-EVIDENCE-E2.1-ACTIVATION-2026-08-03.md:18 |
| OpenClaw: zero ocorrências | OBSERVADO | grep -r OpenClaw . |
| Zero infraestrutura LLM/IA no repo | OBSERVADO | grep -r openai src/ --include=*.ts --include=*.tsx |
| ForceCRM = WACRM em transformação | DOCUMENTADO | docs/MASTER-ROADMAP.md:50, SKILL.md:9 |
| 43 tabelas com RLS, 74 RPCs | IMPLEMENTADO | docs/MASTER-ROADMAP.md:65 |
| assigned_agent_id FK em migration 075 | IMPLEMENTADO | supabase/migrations/075_conversations_assigned_agent_fk.sql, src/test/c21-assigned-agent-fk.pglite.test.ts |
| message_external_ids para identidade multi-provider | IMPLEMENTADO | supabase/migrations/047_..., docs/architecture/EIS-001-external-identity-storage.md |
| ChatPro tem Copiloto IA + Chatbot treinável + Widget | DOCUMENTADO | docs/planning/ANALISE-COMPETITIVA-CHATPRO-2026-08-07.md:25-30,32-39 |
| RECONCILIACAO-FINAL cita Roxy-agent em desenvolvimento paralelo | DOCUMENTADO | docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md:90 |

---

## 16. Validação

### 16.1 Comandos Executados

`ash
# Estado do git
git status --short
git diff --stat
git log -5 --oneline

# Busca por ROXY
grep -r ROXY --include=*.md --include=*.ts --include=*.tsx .

# Busca por Hermes/OpenClaw
grep -r Hermes --include=*.md --include=*.ts --include=*.tsx .

# Busca por IA/LLM/Agent/Copilot no código
grep -r openai src/ --include=*.ts --include=*.tsx

# Verificação de arquitetura docs
ls docs/architecture/
ls docs/adr/
ls docs/planning/
`

### 16.2 Resultados

- Git status: Apenas docs/MASTER-ROADMAP.md modificado (7 ins, 7 del) + arquivos novos de checkpoints/ADR/test/migration (untracked). Nenhuma alteração de código de produção.
- ROXY: Zero ocorrências em código (src/, supabase/). Apenas 4 referências em documentação (ADR-AUT-001 + RECONCILIACAO-FINAL).
- Hermes: Apenas hermes-parser dependency + menção a Hermes Agent auditoria.
- OpenClaw: Zero ocorrências.
- IA/LLM: Zero infraestrutura no src/. Todas ocorrências de agent = papel humano (support agent).
- Documentos lidos: ADR-AUT-001, MASTER-ROADMAP v1.5, RECONCILIACAO-FINAL, ANALISE-COMPETITIVA-CHATPRO, SKILL.md, ADRs aceitos.

### 16.3 Conformidade com Restrições

| Restrição | Cumprida? | Evidência |
|-----------|-----------|-----------|
| Não criar ADR-AI-001 | ✅ | Documento é boundary doc, não ADR |
| Não implementar IA | ✅ | Apenas documentação |
| Não criar agent runtime | ✅ | Apenas documentação |
| Não criar copilot | ✅ | Apenas documentação |
| Não criar event bus | ✅ | Apenas documentação |
| Não criar MCP | ✅ | Apenas documentação |
| Não alterar Automations | ✅ | Apenas documentação |
| Não alterar Flows | ✅ | Apenas documentação |
| Não alterar RLS | ✅ | Apenas documentação |
| Não alterar schema | ✅ | Apenas documentação |
| Não implementar departments | ✅ | Apenas documentação |
| Não implementar round-robin | ✅ | Apenas documentação |
| Não corrigir S2/S3 | ✅ | Apenas documentação |
| Não deploy/migration produção | ✅ | Apenas documentação |
| Não commit/push | ✅ | Working tree intacta |

---

## 17. Working Tree — Estado Final

| Arquivo | Status |
|---------|--------|
| docs/architecture/FORCECRM-ROXY-BOUNDARY.md | CREATED (este documento) |
| docs/MASTER-ROADMAP.md | MODIFIED (pré-existente, não alterado por esta etapa) |
| docs/adr/ADR-AUT-001-automations-flows-reconciliation.md | UNCHANGED (pré-existente) |
| docs/checkpoints/CHECKPOINT-S2-S3-AUDITED.md | UNCHANGED |
| docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md | UNCHANGED |
| docs/planning/ANALISE-COMPETITIVA-CHATPRO-2026-08-07.md | UNCHANGED |
| src/test/c21-assigned-agent-fk.pglite.test.ts | UNCHANGED |
| supabase/migrations/075_conversations_assigned_agent_fk.sql | UNCHANGED |
| .claude/settings.json | UNCHANGED |
| audit.ps1 | UNCHANGED |

Nenhum arquivo de código (src/, supabase/migrations/ exceto o pré-existente 075) foi modificado.

---

## 18. Escopo Confirmado — Checklist Final

| Item | Confirmado |
|------|------------|
| ADR-AI-001 não criado | ✅ |
| IA não implementada | ✅ |
| Agent runtime não criado | ✅ |
| Copilot não criado | ✅ |
| Event bus não criado | ✅ |
| MCP não criado | ✅ |
| Nova camada de orchestration não criada | ✅ |
| Automations não alteradas | ✅ |
| Flows não alterados | ✅ |
| RLS não alterado | ✅ |
| Schema não alterado | ✅ |
| Departments não implementados | ✅ |
| Round-robin não implementado | ✅ |
| S2 não corrigido | ✅ |
| S3 não corrigido | ✅ |
| Produção não alterada | ✅ |
| Commit não realizado | ✅ |
| Push não realizado | ✅ |

---

## 19. Bloqueios / Dúvidas

| # | Bloqueio/Dúvida | Impacto |
|---|-----------------|---------|
| B1 | ROXY em desenvolvimento paralelo (RECONCILIACAO-FINAL:90) não tem visibilidade neste repo. Não há contrato, API, nem ponto de contato técnico documentado. | ADR-AI-001 não pode definir interface sem contraparte. |
| B2 | Não há decisão sobre deploy do ROXY (same process, sidecar, separate service, edge function). | Afeta latência, tenancy, segredos, observabilidade. |
| B3 | Modelo comercial de IA por tenant não definido (ChatPro cobra add-on). | Bloqueia billing/medição em ADR-AI-001. |

---

## 20. Próximo Passo

PARAR E AGUARDAR REVISÃO HUMANA antes de produzir ADR-AI-001.

A revisão deve validar:
1. A fronteira documentada reflete corretamente o estado atual (ForceCRM implementado, ROXY inexistente no repo).
2. As questões deferidas (Q1–Q12) são o conjunto correto para alimentar ADR-AI-001.
3. Os bloqueios (B1–B3) são comunicados à contraparte ROXY (se existir) ou ao decisor de produto.
4. Nenhuma decisão implícita foi vazada para fora do escopo (ver §14).

---

*Fim do documento — FORCECRM × ROXY Boundary Reconciliation v1.0*
