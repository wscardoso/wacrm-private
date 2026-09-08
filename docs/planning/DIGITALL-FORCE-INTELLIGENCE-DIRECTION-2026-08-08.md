# Digitall Force Intelligence — Product & Architecture Direction

**Status:** documento estratégico, não é ADR. Registra direção e critérios, não trava arquitetura.
**Data:** 2026-08-08
**Origem:** sessão de brainstorming (skill `product-brainstorming`), consolidando ChatPro/Eva IA/Secretária Eva/Chatwoot como benchmark, board de planejamento, protótipo Meta Connect, e auditoria ao vivo do ForceCRM em produção.
**Participantes do processo:** Weyner (PO), ChatGPT (Architect — autor original da estrutura deste documento e da Rota C), Claude (esta sessão — pesquisa, verificação de código, consolidação).

---

## 0. A dor que originou esta sessão

Weyner faz gestão de tráfego pago para clínicas de saúde eletiva (odontologia como foco principal; estética, médico e nutricionista como nichos adjacentes com o mesmo formato de funil). A dor real, nas palavras dele: **"não sei exatamente qual anúncio vende."** Isso não é desconfiança do dado — é a ausência de uma régua depois do clique. O ForceCRM já resolveu "de qual campanha veio o lead" (`lead_attributions`); nunca resolveu "esse lead virou receita, e quanto." Essa distinção orienta todo o resto do documento.

A lista de perguntas que definem sucesso, no vocabulário do próprio Weyner: quantos leads entraram por campanha, quantos agendaram, quantos fecharam, qual o ticket médio, qual plataforma vendeu mais, qual criativo trouxe mais vendas, qual a idade do público, qual o faturamento, qual o CPL, qual o ROAS. Essas dez perguntas são niche-agnostic — valem para odonto, estética, médico ou nutricionista igualmente. O que muda entre nichos é a **qualificação** (perguntas, corte de ticket, linguagem, regras de publicidade), não a **régua de sucesso**.

---

## 1. O que o FORCECRM é

Sistema de registro (system of record) multi-tenant para gestão comercial via WhatsApp: caixa de entrada, contatos, funil de vendas (`New Lead → Qualified → Proposal Sent → Negotiation → Won`, com KPIs de ticket médio/valor do funil/ganhos/perdidos já construídos), automações e fluxos, transmissões, e atribuição de origem de lead (`lead_attributions`, enum multi-canal por decisão do ADR-ATTR-001).

Estado verificado em código nesta sessão (não por memória, por leitura direta):

- **Abstração de provider já é multi-canal** (Meta oficial, Z-API, uazapi) tanto em Automations quanto em Flows, via `getProvider()` (`src/lib/automations/meta-send.ts`, `src/lib/flows/meta-send.ts`). O rótulo "Meta-only" que circulava no roadmap está desatualizado — o nome do arquivo (`meta-send.ts`) é resquício histórico, não reflete o comportamento.
- **`lead_attributions` não tem FK para `deals`.** Esta é a única peça estrutural realmente faltando para responder as 4 perguntas comerciais da lista acima (agendou / fechou / ticket médio / faturamento). Prioridade nº1 técnica deste documento.
- **Fundação de supervisão cross-tenant já existe e é bem desenhada** (migrations 037/038/039): `is_platform_operator()`, `is_platform_operator_for(account_id)`, RPC `list_platform_operator_accounts()` — `SECURITY DEFINER`, filtrado estritamente por `auth.uid()`, sem bypass via `service_role` solto, com RLS estendida via essas funções e mutações privilegiadas auditadas. Essa é a base técnica sobre a qual a "Digitall Force Intelligence" deve ser construída — não uma infraestrutura nova.
- Automações têm modelo pronto ("Lead Qualifier" nativo) parado, sem nenhuma automação configurada em produção ainda.

## 2. O que a Roxy é hoje

Produto independente, não uma camada do FORCECRM — "System of Intelligence" vs. o "System of Record" do FORCECRM (ADR-000 e ROXY-VISION.md do próprio repo da Roxy, `C:\Users\weyne\Workspace\roxy agent`).

- Motor cognitivo real: **Hermes** (`NousResearch/hermes-agent`), invocado via shell-out (`hermes chat -q`). Confirmado: é um agente de CLI/TUI com loop de aprendizado próprio (cria e refina skills a partir da experiência, persiste conhecimento entre sessões), múltiplos backends de modelo trocáveis, sem lock-in. Não resolve identidade-em-conversa — isso é responsabilidade da camada de integração da própria Roxy.
- **OpenClaw** é ancestral de composição, não o runtime atual — framework de assistente pessoal multi-canal de operador único, sem paralelo direto conhecido com o problema de atribuição de identidade em conversa.
- Roda local (Node), sem daemon/container. Não acessa Supabase hoje (visão histórica de acesso direto em `wacrm-private`/SOUL.md existe mas a própria Roxy rejeita como contradição).
- Independente de Heimdall.
- Single-tenant hoje — `organization_id` existe só como spec futura. Billing inexistente nos dois lados.
- **Interface real com o FORCECRM (I3):** a Roxy consome a rota de webhook de provider de WhatsApp já existente do FORCECRM — não é um contrato desenhado, ela se apresenta como mais um provider.

### RISCO-3 — o achado mais importante da reconciliação Roxy×FORCECRM

Confirmado em produção, não é teórico: teste ao vivo em 2026-08-06, Weyner mandou mensagem, a Roxy respondeu no WhatsApp real, e o FORCECRM nunca registrou essa resposta — a caixa de entrada mostrou a conversa como expirada. **O FORCECRM fica cego para o que a Roxy faz.** Viola diretamente D8 do SBD-001 (Roxy deveria só solicitar ação, não executar direto).

Segurança relacionada: o webhook da Roxy tem secret opcional (autenticação pulada se ausente), e o secret do FORCECRM aparece em log de texto claro da Roxy — recomendação de rotação e enforcement de auth, independente do timeline deste documento.

**Correção proposta, com referência de design concreta:** o padrão "Agent Bot" do Chatwoot (open-source, confirmado no schema real dos docs deles, não por suposição):

- Entidade própria `agent_bots` (id, nome, `outgoing_url`, token de acesso independente — nunca reusa secret de provider).
- Campo `sender_type` na mensagem, distinguindo `AgentBot` de `User` (humano) de `Contact` (cliente) — resolve a atribuição.
- Conversa pode ter `assignee_agent_bot_id` — a Roxy vira responsável formal e visível pela conversa, em vez de silêncio que expira.
- Handoff explícito (evento `CONVERSATION_BOT_HANDOFF`) quando a Roxy repassa para humano — mesmo espírito do contrato de precedência já formalizado no ADR-AUT-001 entre Automations e Flows (reaproveitar a mesma linguagem de "quem manda agora").

Isso é uma correção pequena e paralela à Rota C (não depende de decidir acoplamento definitivo) — recomenda-se tratar como stopgap a ser feito em paralelo ao amadurecimento dos dois produtos, não como item que espera o documento de arquitetura final.

## 3. O que queremos que a Roxy possa se tornar

Não precisa ser "uma plataforma" agora — pode continuar sendo o projeto de agente/inteligência em desenvolvimento, com a arquitetura de produto final nascendo depois. Direção que já emergiu nesta sessão (não decisão travada): **FORCECRM = sistema operacional comercial; Roxy = inteligência/agente que opera sobre o sistema** — mas essa relação não precisa ser congelada hoje (ver seção 8).

## 4. O que os benchmarks demonstram

Quatro produtos analisados ao vivo nesta sessão (Chrome, com evidência, não suposição):

- **Eva IA** (`evasolutions.com.br`): plataforma horizontal — CRM próprio (Neural Sales), campanhas, calendário com IA, clonagem de voz, multichat, e IA de tráfego pago separada (Iaads). Planos R$499–1.990/mês (confirmado idêntico em proposta PDF de dez/2025 endereçada à Digitall Force — **tentaram recrutar Weyner tanto como cliente quanto como revendedor**; decisão tomada: não revender — margem mínima, não é aumento de valor sobre o que já é feito, e revenda entrega exatamente as duas coisas que não podem ser terceirizadas: atribuição de receita própria e diferenciação vertical).
- **Secretária Eva** (`secretariaeva.com.br`): sub-marca vertical da mesma empresa, focada em clínicas de estética — "atende, qualifica e agenda". Prova de mercado real e publicada: +300 clínicas, +5.000 procedimentos vendidos, +R$5 milhões em vendas, +40% de conversão. Preço por volume de atendimento (R$497/100, R$697/300, R$997/500 por mês), mesma feature list nos três planos — diferente da precificação por feature da Eva IA mãe. Referência direta de como precificar se "Digitall Force Intelligence" virar oferta própria ao cliente. Sinal de janela de mercado: se já foram de plataforma genérica para clínica de estética, odontologia é candidato óbvio a próximo nicho deles.
- **ChatPro** (`app.chatpro.com.br`, tenant W2A Telecom): confirmado ao vivo que toda a camada de "analytics" deles é operacional (Total de Atendimentos, tempo médio de espera/atendimento, avaliação, atendimentos por agente/departamento) — zero ROAS, zero ticket médio, zero ligação com campanha. Categoria diferente da "Digitall Force Intelligence", não grau de maturidade diferente da mesma categoria — não perseguir feature parity nesse eixo. O "Copiloto" deles é IA pull (humano pede ajuda), oposto da Roxy, que é push (age sozinha) — eixo de escolha de produto, não detalhe de implementação.
- **Chatwoot** (open-source, referência de arquitetura, não adoção): ver seção 2 — padrão Agent Bot é a peça mais valiosa trazida por este benchmark.

## 5. O que queremos superar

- ChatPro/Eva/Secretária Eva vendem ferramenta por cliente. Nenhum deles agrega inteligência entre clientes de uma mesma agência — "Digitall Force Intelligence" pode oferecer isso: benchmark real entre clínicas do mesmo nicho ("clínicas como a sua fecham X%, com ticket Y") como ferramenta de prospecção, não só de operação. Moat de dado, não de feature.
- Nenhum benchmark resolve atribuição de receita ponta a ponta (anúncio → lead → agendamento → venda → ticket). É a lacuna estrutural central do FORCECRM (seção 1) e o eixo em que "ser o melhor do nicho" pode se sustentar.

## 6. O que permanece independente (Rota C)

FORCECRM e Roxy são produtos/sistemas desenvolvidos em paralelo, capazes de operar independentemente, sem congelar agora uma fronteira de acoplamento definitiva. Consistente com o que o próprio ADR-AUT-001 já havia decidido (onde a IA entra como motor foi explicitamente adiado, não respondido, para evitar travar 4 loci concorrentes de orquestração). Rota C aplica o mesmo princípio um nível acima, no produto inteiro.

- **FORCECRM primeiro:** roadmap segue até virar produto sólido — CRM, WhatsApp, automações, campanhas, dados, segurança, multi-tenancy. "Pronto o suficiente" tem critério concreto definido nesta sessão (não "CRM completo" em abstrato, que é alvo sem fim): **atribuição lead→receita fechada** (a FK) **+ automação captura o funil pré-clique** (o trigger do quiz).
- **Roxy em paralelo:** continua evoluindo SOUL, arquitetura cognitiva, memória, ferramentas, comportamento.
- **RISCO-3 não espera a Rota C se resolver** — é vazamento ativo em produção, stopgap independente da decisão de acoplamento (seção 2).

## 7. O que pode ser integrado futuramente

- Onde a Roxy vive no ecossistema; como identifica empresa/cliente; como recebe contexto; quais dados pode consultar; quais ações pode executar; como registra suas ações (parcialmente adiantado pela correção de RISCO-3, seção 2); se capacidades específicas serão feature do FORCECRM, da Roxy, ou de ambos; modelo comercial; cobrança (tipo Chat Pro/Eva); branding e identidade por cliente.
- "Digitall Force Intelligence" como marca guarda-chuva comercial, com FORCECRM e Roxy como motores internos — leitura mais provável hoje (Weyner: "transformar todo o conhecimento em um Digitall Force Intelligent"), a confirmar formalmente antes de fechar nomenclatura em qualquer artefato público.
- UI de módulos em cards (inspirada no launcher do app NVIDIA) para a tela de supervisão de tenants — não é só estética: declara visualmente que "Digitall Force Intelligence" é composta de módulos (Funil, Scoring, Automações, Quiz builder, Dashboard agregado), o que ajuda a decidir o que vira módulo novo vs. feature de módulo existente conforme o produto cresce. Nota de design para quando a tela de supervisão for revisitada — não é prioridade de build agora.

## 8. O que deliberadamente não será decidido agora

- Onde a Roxy "mora" na casa inteira do ecossistema.
- Se "Digitall Force Intelligence" é só marca comercial (arquitetura permanece FORCECRM + Roxy desacoplados) ou se implica unificação técnica real — Weyner sinalizou a primeira leitura, mas não fechou.
- ADR-AI-001 formal (data/action/authority/tenant/billing boundaries) — não abandonado, só não transformado em contrato arquitetural até a maturidade dos dois produtos permitir.
- Escopo de "saúde eletiva" como categoria (odonto + estética + médico + nutricionista) vs. foco estreito em odontologia — mesmo formato de funil confirmado, mas parâmetros diferem (ticket, regras de publicidade CFO/CFM/CFN, linguagem); decisão de ambição de marca ainda em aberto.

## 9. Quais decisões precisam esperar a maturidade dos dois produtos

Decidimos o acoplamento FORCECRM×Roxy quando, simultaneamente:

1. FORCECRM tiver atribuição lead→receita fechada (FK `lead_attributions → deals` implementada e em uso real, não só schema).
2. RISCO-3 estiver corrigido (Roxy como Agent Bot formal, não impostora de webhook).
3. Roxy tiver identidade/tenant real (hoje é single-tenant; `organization_id` é spec, não implementação).
4. Automações nativas do FORCECRM (Lead Qualifier e afins) estiverem de fato em uso em produção, não só disponíveis.

Sem essas quatro condições, qualquer decisão de acoplamento é prematura por falta de dado real para decidir sobre — não por falta de vontade.

## 10. Critérios objetivos para desenhar a integração no futuro

- **Dado, não opinião:** a decisão de onde a IA entra deve ser guiada por telemetria real de uso (quantas conversas a Roxy já resolve sozinha, quanto tempo economiza, taxa de handoff) — não disponível hoje porque RISCO-3 impede medir isso corretamente. Corrigir RISCO-3 é, portanto, pré-requisito de dado, não só de segurança.
- **Sinal de mercado como gatilho de velocidade, não de decisão:** o movimento da Eva IA (horizontal → vertical estética → possivelmente próximo nicho) é argumento para acelerar a Roxy odonto especificamente, mas não para pular as quatro condições da seção 9.
- **Precedência como padrão já estabelecido:** qualquer novo ator de orquestração (Roxy incluída) segue o mesmo contrato de precedência/handoff formalizado no ADR-AUT-001, evitando reabrir a mesma discussão em cada novo componente.

---

## Anexo A — Próximos passos técnicos concretos (não bloqueiam este documento)

1. Migration: FK `lead_attributions.deal_id → deals.id` (ou equivalente), permitindo nulo até automação de criação de deal existir.
2. Automação: gatilho de palavra-chave/evento (`lead_quiz_submitted` e/ou "agendamento confirmado") criando o `deal` automaticamente no funil — sem isso, a FK não tem o que ligar, porque negócio não nasce sozinho hoje.
3. Novo trigger de automação `lead_quiz_submitted` + endpoint de webhook de entrada dedicado (não reusar rota de provider WhatsApp) para o quiz (`dental-sparkle-quiz.lovable.app`, 7 perguntas já validadas: Necessidade × 2, ticket/escopo, Disposição/urgência, FIT geográfico, logística, capacidade financeira — captura Nome+WhatsApp no fim).
4. RPC de agregação cross-tenant estendendo a fundação 037/039 (`is_platform_operator_for`) para leads/score/ticket por tenant/campanha — não infraestrutura nova.
5. Ativar o automation nativo "Lead Qualifier" em produção como teste mais barato da hipótese de scoring, antes de qualquer build novo.
6. Correção RISCO-3 (Agent Bot pattern, seção 2) — paralelo, não bloqueante.
7. Migrar os KPIs já validados manualmente no protótipo Meta Connect (Total Leads, Ad Spend, ROAS, Taxa de Conversão, faixas de score Fervendo/Quente/Morno/Frio) para dentro do ForceCRM, aposentando a grade de lançamento manual quando a captura automática estiver no ar.

## Anexo B — Itens levantados e conscientemente não aprofundados nesta sessão

- LTV/retenção (paciente volta, indica outros) — funil de hoje mede só primeira venda.
- Canais fora do WhatsApp (telefone, presencial) — podem estar subcontando fechamento sem que nenhuma ferramenta hoje perceba.
- Performance por atendente humano da clínica (não só por campanha) — gargalo real possivelmente maior que qualidade do anúncio.
- Produtização de "Digitall Force Intelligence" como relatório vendável ao cliente (nova linha de receita), não só painel interno.
