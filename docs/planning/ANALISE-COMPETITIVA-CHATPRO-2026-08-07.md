# Análise Competitiva — ChatPro vs. ForceCRM/WACRM

**Data:** 2026-08-07 · **Autor:** Sonnet (Cowork) · **Baseline WACRM:** `docs/MASTER-ROADMAP.md` v1.5 (HEAD `26e5d39` + S1 hotfix `2a6061e`) · **Fonte ChatPro:** navegação ao vivo, sessão logada (W2A Telecom), `app.chatpro.com.br`

---

## 1. Contexto e método

O ChatPro é uma plataforma brasileira de atendimento omnichannel via WhatsApp, madura e comercialmente estabelecida (multi-tenant, cobrança por conta). Não é um concorrente direto no *North Star* do ForceCRM — atribuição de anúncios Click-to-WhatsApp (CTWA) via Meta oficial, ver `ADR-ATTR-001` — mas é o concorrente correto para medir **profundidade operacional de atendimento**, que é exatamente onde o MASTER-ROADMAP admite lacunas totais: *"Ausentes por completo: billing, notifications, tasks, search global, AI, webhooks de saída, onboarding, export, observabilidade estruturada"* (§2.3).

Este documento cobre o que foi navegado ao vivo (Analytics/Reports, Chat/Inbox, Copiloto IA, Agenda, Chatbot builder visual, upsell de IA, Widgets, Desenvolvedor/webhooks) e infere o restante do menu de configurações (Respostas Rápidas, Departamentos, Usuários, Contatos, Etiquetas, Motivos de Finalização, Jornada de Trabalho, Pagamento) a partir de rótulos e da estrutura do produto — essa parte está marcada `[I]` (inferido) e não `[C]` (confirmado por navegação), na mesma convenção de confiança do MASTER-ROADMAP.

A regra que segui: **não recomendar nada que ignore os ADRs e débitos já registrados no repo.** Cada item do roadmap abaixo referencia o épico, ADR ou débito (C1–C21, R16) que ele toca.

---

## 2. Inventário de funcionalidades do ChatPro `[C]` = confirmado ao vivo

### 2.1 Atendimento (core)
- Inbox unificado multi-canal: WhatsApp não-oficial (QR/Baileys-like), WhatsApp Oficial (Cloud API), Facebook, Instagram — tudo na mesma fila.
- Roteamento por fila/departamento com mecânica de "assumir" conversa (take-over) — um atendente pega a conversa da fila, ela some da fila para os demais.
- Motivos de Finalização — encerramento de atendimento é um evento tipado (não um simples "fechar"), permitindo relatório de "por que a conversa terminou".
- Jornada de Trabalho — escala/horário de disponibilidade do atendente, provavelmente usado para roteamento (não atende fora do horário) e SLA.

### 2.2 IA
- Copiloto: painel lateral de IA que sugere resposta ao atendente humano dentro da conversa — assistência, não automação plena. Distinto do chatbot.
- Chatbot treinável com IA: além do builder visual determinístico, existe uma camada de IA que pode ser treinada (provavelmente RAG sobre uma base de conhecimento) e assumir a conversa, com handoff humano↔IA.
- Transcrição de áudio recebido.
- Múltiplas personas de IA configuráveis.
- Página de upsell dedicada "Inteligência Artificial" — sinaliza que é um add-on comercial separado, não incluído no plano base.

### 2.3 Automação — Chatbot builder
- Editor visual em grafo (React Flow) — nó a nó, incluindo um nó **"Requisição externa"** (chamada HTTP/webhook de saída a partir de dentro do fluxo, com resposta injetável no fluxo).

### 2.4 Widgets (site → WhatsApp)
- Gerador de botão embutível para site externo ("Chamar no WhatsApp"), com:
  - Posição (canto inferior direito/esquerdo), cor, texto customizáveis.
  - **Ação personalizada no clique**: Nenhuma / Transferir para Departamento / Menu do chatbot — ou seja, o clique já entra roteado na fila certa ou já dispara um fluxo específico.
  - Implícito (padrão do mercado, não confirmado por clique): contagem de cliques por widget.

### 2.5 Agenda
- Módulo de calendário/agendamento completo, integrado ao atendimento (provavelmente para marcar retorno de contato ou compromisso vinculado a uma conversa).

### 2.6 Desenvolvedor
- Webhook de saída configurável por conta (`Webhook url` + `Versão do webhook`, atualmente v1) — eventos de atendimento e mensagens entregues ao sistema do cliente. Documentação própria linkada.

### 2.7 Outros (menu, não navegado a fundo — `[I]`)
- Respostas Rápidas (canned responses / atalhos de texto).
- Departamentos (unidades de roteamento, prováveis donos de fila e SLA).
- Usuários (gestão de agentes, provavelmente com papéis).
- Contatos (CRM básico de contato, provavelmente ficha unificada de conversas).
- Etiquetas (tags livres em contato/conversa).
- Pagamento (cobrança do próprio ChatPro, não relevante ao gap).
- Analytics/Reports — dashboard de métricas de atendimento (SLA, volume, tempo de resposta) — navegado, existe mas não detalhado neste documento.

---

## 3. Estado real do ForceCRM/WACRM (baseline `[C]`, `docs/MASTER-ROADMAP.md` §2.3)

Resumo do que já está maduro, para não recomendar reconstruir o que existe:

- **Contatos, inbox, pipelines, broadcasts, automations, flows, templates Meta, API keys, settings**: completos member-side, RLS em 33 tabelas.
- **Provider abstraction (E1)**: concluída — `send/route.ts`, `broadcast/route.ts`, `flows/meta-send.ts`, `automations/meta-send.ts` já despacham via `getProvider()`, Meta/Z-API/uazapi. Nenhum caminho de envio importa `meta-api` diretamente.
- **Automations e Flows**: dois motores paralelos, ambos funcionais, ambos **Meta-only** hoje (débito de convergência documentado, não resolvido).
- **E2.1 (Status canônico)**: em andamento, é o único elo aberto da cadeia dura E1→E2.0→E2.1 — mensagens em provider não-Meta são enviadas e retentadas corretamente, mas `delivered`/`read` nunca chegam de volta.
- **North Star (CTWA)**: `ADR-ATTR-001`/`002` Aceitos, captura em produção, enriquecimento (E6.0) testado; UI de relatório de attribution planejada para E12 (ainda não construída).
- **Ausentes por completo, confirmado por grep negativo no roadmap**: billing, notifications, tasks, search global, **IA**, **webhooks de saída**, onboarding, export, observabilidade estruturada.
- **Platform (superadmin)**: read-heavy/write-thin — falta settings, UI de operadores, auditoria, suspensão de workspace.
- **S1 (RLS tenant escalation via `profiles`)**: fechado nesta sessão anterior (migration 074), confirmado em produção.

---

## 4. Gap analysis

Legenda de esforço: **P** (pequeno, dias) · **M** (médio, 1–3 sprints) · **G** (grande, épico novo).
Legenda de impacto comercial: 🔴 alto · 🟡 médio · 🟢 baixo/nicho.

| # | Funcionalidade ChatPro | Existe no WACRM? | Esforço | Impacto | Nota arquitetural |
|---|---|---|---|---|---|
| 1 | Webhook de saída configurável por conta | **Não** — roadmap confirma "webhooks de saída" ausente | P–M | 🔴 | Não depende de nenhum épico aberto. É infraestrutura pura: tabela `outbound_webhooks(account_id, url, version, secret)` + fila de eventos + dispatcher assíncrono. Pode reusar o padrão de fila que já existe para DLQ de inbound (`enqueue_webhook_dlq`, hoje morto — dá para herdar o desenho, não o código morto). |
| 2 | Widget de site com roteamento no clique (departamento/bot) | **Não**, mas é o vizinho arquitetural mais próximo do North Star | M | 🔴 | Isto é o ADR-ATTR-001 de trás para frente: CTWA capta clique **pago** (anúncio Meta); o Widget capta clique **orgânico** (site próprio). Mesmo pipeline de "clique → conversa atribuída → automação de boas-vindas" pode ser generalizado para as duas origens — ver §5.1. |
| 3 | Departamentos / filas com take-over | **Parcial** — `assigned_agent_id` existe mas sem FK (C21) e sem conceito de fila/departamento | M | 🔴 | Hoje a atribuição é direta pessoa→conversa. Falta a camada intermediária "fila pertence a departamento, departamento tem agentes, conversa entra na fila antes de ser assumida". Não é reescrita, é uma tabela nova (`departments`) + FK em `conversations` + policy RLS adicional. |
| 4 | Motivos de finalização tipados | **Não** — fechamento de conversa hoje não é um evento estruturado | P | 🟡 | Enum + coluna em `conversations` no fechamento. Baixo esforço, alto valor de relatório (permite responder "por que perdemos esse cliente" sem parsing de texto livre). |
| 5 | Respostas rápidas (canned responses) | **Não confirmado no roadmap como existente** | P | 🟡 | Feature isolada, sem dependência de outros épicos. |
| 6 | Etiquetas/tags em contato e conversa | **Não confirmado** — Contacts é "completo" mas roadmap não menciona tags | P | 🟡 | Idem — baixo acoplamento. |
| 7 | Copiloto IA (agente humano + sugestão de IA) | **Não** — "IA" está na lista de ausentes totais | G | 🔴 | Este é o item mais visionário e o mais alinhado ao que o usuário pediu ("tão bom quanto o ChatPro"). Ver §5.2 — não é um botão, é uma nova fronteira arquitetural (LLM com acesso a contexto de conversa + guardrails de tenant). |
| 8 | Chatbot com IA treinável (RAG) + handoff humano↔IA | **Não** — WACRM tem só o motor determinístico (Flows, React Flow) | G | 🟡 | Convergente com #7. Cuidado: WACRM já tem *dois* motores de automação (Automations + Flows) sem convergência documentada — adicionar um terceiro motor (IA) sem resolver essa dívida primeiro é o erro mais fácil de cometer aqui. Ver §5.3. |
| 9 | Transcrição de áudio | **Não** | P–M | 🟢 | Isolado, plugável via API externa (Whisper/equivalente) sobre `media_url` já existente em `messages`. Não é arquitetura, é uma integração. |
| 10 | Agenda/calendário de compromissos | **Não** — "tasks" está na lista de ausentes | M | 🟡 | Não é CTWA-crítico, mas é retenção: operações que dependem de follow-up agendado (funerárias, clínicas — nicho real do WACRM se for o caso) sentem falta disso. |
| 11 | Jornada de trabalho (disponibilidade do agente) | **Não** | P–M | 🟢 | Pode nascer junto com #3 (departamentos), como atributo do agente dentro do departamento. |
| 12 | Analytics/reports de atendimento | **Parcial** — "Dashboard funcional; Reporting inexistente" no roadmap | M | 🔴 | Este cruza direto com E12 (UI de attribution report), já planejado. Vale desenhar como **um único módulo de reporting**, não dois — CTWA attribution e SLA/atendimento são views do mesmo motor de agregação. |
| 13 | Multi-canal (Facebook/Instagram) | **Não** — WACRM é WhatsApp-only por decisão (Meta-only para o North Star) | G | 🟢 | **Não recomendo perseguir isto.** Diverge do North Star (`ADR-ATTR-001` é explicitamente sobre atribuição de anúncio *para WhatsApp*). Adicionar canais sem crescer o attribution model junto dilui o produto sem reforçar o diferencial. |

---

## 5. Onde ser visionário sem trair a arquitetura

### 5.1 Unificar Widget de site com o motor de atribuição CTWA

O ChatPro trata "botão no site" e "anúncio Meta" como coisas diferentes porque ele não tem attribution engine — é só um gerador de link. O WACRM tem o contrário: um attribution engine sério (E6.0, `ADR-ATTR-001/002`) mas só para anúncios pagos.

A ideia visionária correta aqui não é "copiar o widget do ChatPro". É construir o widget **como um segundo produtor de eventos para o mesmo pipeline de atribuição já existente** — clique orgânico no site vira uma "origem" no mesmo modelo de dados que já resolve clique de anúncio pago. Isso dá ao ForceCRM algo que o ChatPro não tem e provavelmente não vai construir tão cedo: **um único relatório que mostra, lado a lado, quanto veio de anúncio pago (CTWA) vs. quanto veio do site (orgânico)**, sem duplicar lógica de atribuição.

Pré-requisito real: `E12` (UI de attribution report) precisa nascer desenhado para múltiplas origens desde o início, não só Meta Ads — isso é uma decisão de escopo a tomar *antes* de escrever a primeira linha de E12, custo zero se decidido agora, custo de retrabalho se decidido depois.

### 5.2 Copiloto de IA — não é feature, é uma nova camada de confiança de tenant

Antes de qualquer chamada a um LLM externo, a pergunta que o repo já sabe fazer bem (RLS, `is_account_member`, migration 074 fresca na memória) precisa ser respondida para IA: **que contexto de conversa cruza a fronteira do tenant quando vai para o provedor de IA, e quem audita isso?** O ChatPro claramente já resolveu isso (tem múltiplas personas, handoff, e é add-on pago — ou seja, cobrança por uso de IA por tenant também é modelo a copiar).

Recomendação de sequência, não de feature isolada:
1. Um novo ADR (`ADR-AI-001`) definindo fronteira de dados enviados a LLM externo, retenção, e billing por tenant — antes de qualquer UI.
2. MVP de Copiloto (sugestão de resposta, não automação) — menor superfície de risco, maior valor percebido imediato, e testa a fronteira de dados em produção com humano no loop antes de soltar IA autônoma.
3. Só depois, avaliar se o Chatbot com IA treinável entra como uma terceira opção dentro do Flows existente ou como motor novo — decisão que depende de #5.3.

### 5.3 Resolver a dívida dos dois motores de automação antes de adicionar um terceiro

O roadmap já registra, sem ambiguidade: *"Automations & Flows — dois motores paralelos, ambos funcionais, ambos Meta-only. Nenhum documento explica se são complementares ou se um substitui o outro."* Se o Chatbot IA do ChatPro vira meta para o WACRM, o caminho errado é adicionar um terceiro motor de automação em cima de uma dívida de dois motores não resolvida — isso triplica a superfície de manutenção em vez de dobrá-la.

Antes de IA generativa em fluxo, o retorno mais alto por esforço é: escrever o ADR que decide Automations vs. Flows (convergência ou papéis distintos e documentados), e — já que ambos são Meta-only hoje — estendê-los para a provider abstraction (E1) que o resto do sistema já tem. Isso paga dívida antiga e prepara o terreno para IA entrar como um terceiro "tipo de nó" dentro de UM motor, não como motor #3.

### 5.4 Departamentos como base de tudo, não como feature isolada

Motivos de finalização (#4), jornada de trabalho (#11), analytics de atendimento (#12) e o roteamento do widget (#2) **todos** dependem de um conceito de "departamento/fila" que hoje não existe. Recomendo construir `departments` primeiro, como fundação — não como item #3 isolado da tabela acima — porque adiar isso significa retrabalhar #4, #11, #12 e #2 quando o conceito finalmente for criado.

---

## 6. Roadmap proposto

**Curto prazo (baixo risco, alto retorno, sem novo ADR necessário — pode entrar em paralelo com E2.1)**
1. Motivos de finalização tipados (#4).
2. Respostas rápidas (#5).
3. Etiquetas em contato/conversa (#6).
4. Webhook de saída configurável (#1) — reaproveita o desenho de fila que já existe para DLQ.

**Médio prazo (depende de um ADR curto + schema novo, mas nenhum épico aberto bloqueia)**
5. `departments` como fundação (§5.4) — desbloqueia #3, #11.
6. Motivos de finalização + departamentos alimentando um primeiro Analytics/reports real (#12), desenhado desde o início como o mesmo motor que vai alimentar E12 (§5.1).
7. Transcrição de áudio (#9) — integração isolada, pode entrar a qualquer momento sem esperar o resto.

**Alinhado ao North Star, mas requer decisão de escopo primeiro**
8. Widget de site unificado ao attribution engine (#2 + §5.1) — só depois que E12 tiver o desenho multi-origem decidido.

**Longo prazo / visionário (cada um é um épico com ADR próprio)**
9. `ADR-AI-001` + Copiloto de IA MVP (§5.2).
10. Resolução da dívida Automations vs. Flows + extensão para provider abstraction (§5.3) — pré-requisito para Chatbot IA treinável.
11. Chatbot IA treinável com handoff humano↔IA — só após #9 e #10.

**Deliberadamente fora de escopo**
12. Multi-canal (Facebook/Instagram, #13) — diverge do North Star de atribuição CTWA-para-WhatsApp; revisitar apenas se o North Star mudar por decisão explícita, não por pressão de paridade de features.

---

## 7. Resumo para decisão

O ChatPro ganha do WACRM em **profundidade operacional de atendimento** (departamentos, IA, agenda, webhooks) porque o WACRM investiu esse tempo em algo que o ChatPro não tem: um motor de atribuição de anúncio real, com ADRs aceitos e código em produção. Isso não é atraso, é escolha de escopo diferente — o risco real não é "não ser tão bom quanto o ChatPro", é copiar features do ChatPro sem aproveitar a vantagem estrutural que o attribution engine já dá (§5.1), ou empilhar IA em cima de uma dívida de automação não resolvida (§5.3).

A ordem recomendada acima entrega paridade nos itens de baixo risco primeiro (curto prazo), sem tocar em nenhum ADR ou épico aberto, e reserva os itens visionários (IA, widget unificado) para depois que as fundações que os tornam diferenciados — não apenas equivalentes — estejam no lugar.
