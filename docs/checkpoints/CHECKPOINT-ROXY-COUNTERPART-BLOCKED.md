# CHECKPOINT — ROXY Counterpart Blocked

**Data:** 2026-08-08 · **Tipo:** Gate documental — congela o estado da fronteira FORCECRM × ROXY, sem código associado.
**Baseline adotado:** `docs/architecture/SBD-001-forcecrm-roxy-boundary.md` (lado FORCECRM, verificado sem erro factual pela auditoria comparativa).
**Fonte secundária de achados (não autoridade):** `docs/architecture/FORCECRM-ROXY-BOUNDARY.md`.
**Deriva de:** `docs/adr/ADR-AUT-001-automations-flows-reconciliation.md` D7 (deferiu a localização de IA a esta reconciliação) · auditoria comparativa read-only desta sessão (sem artefato próprio — resultado registrado no chat, não em arquivo).

---

## 1. Estado atual

`SBD-001` é o baseline do lado FORCECRM: 13 responsabilidades (F1–F13) verificadas contra código, source of truth por classe de estado definido, três modelos de autorização (A1/A2/A3) documentados, dois riscos registrados e não corrigidos (RISCO-1, RISCO-2). Não é alterado por este checkpoint.

`FORCECRM-ROXY-BOUNDARY.md` permanece no repositório como fonte secundária. Não é fundido, não é promovido, não é reescrito aqui. Contém quatro afirmações factualmente inválidas (§2) e uma classificação sem evidência suficiente (§2), já identificadas pela auditoria comparativa.

## 2. O que está confirmado

- FORCECRM é o sistema transacional completo — contatos, conversas, mensagens, deals, contas, orquestração (Automations/Flows), credenciais de provider, attribution.
- ROXY **não existe neste repositório** — zero código, schema, teste, rota ou documento arquitetural.
- **Zero infraestrutura de IA/LLM** no FORCECRM — nenhuma dependência, nenhuma tabela de memória/embedding.
- **Nenhuma interface FORCECRM ↔ ROXY existe hoje** — nem webhook, nem API de dados, nem fila, nem MCP, nem tool call.
- A única superfície externa utilizável hoje é `GET /api/v1/me` (identidade da conta + escopos da chave, nada de negócio).
- Automations e Flows permanecem os dois motores do FORCECRM; IA não é motor #3 (`ADR-AUT-001` D1/D7, não reaberto).
- A precedência de entrada Flows→Automations (`ADR-AUT-001` D4) não é reaberta.

### Deltas válidos de `FORCECRM-ROXY-BOUNDARY.md`, registrados (não incorporados ao baseline nesta etapa)

1. Q10 — LLM próprio/self-hosted vs. provider externo (privacidade, custo, latência, compliance).
2. Q12 — destino das cinco superfícies hoje mortas (`http_fetch`, `manual`, `conversation_assigned`, `tag_added`, `time_based`) quando/se IA entrar.
3. Enquadramento mais concreto do modelo de deploy (same-process / sidecar / serviço separado / edge function).
4. `hermes-parser@0.25.1` como dependência dev-transitiva (`package-lock.json:6320,7164`) — ausente do baseline original.
5. Três âncoras adicionais verificadas em `ADR-AUT-001` (`:113`, `:128`, `:167`), corretas.
6. Matriz comparativa Automations × Flows × integração cognitiva futura em 8 dimensões (modelo de execução, estado, disparo, precedência, provider, decisão, resultado, superfícies mortas) — formato mais legível que a prosa equivalente do baseline.

### Afirmações invalidadas de `FORCECRM-ROXY-BOUNDARY.md`

| Afirmação | Motivo |
|---|---|
| `tracking_links` como tabela existente | Não existe em nenhuma migration (001–075); só especificada como P2 não construída em `ADR-ATTR-001 §3.4` |
| `account_members` como tabela existente | Não existe; tenancy real é `profiles` + `account_invitations` |
| `whatsapp_templates` como tabela existente | Não existe; nome real é `message_templates` (`001_initial_schema.sql:211`) |
| Webhook Meta com 1038 linhas | Contagem real: 1115 linhas (`wc -l src/app/api/whatsapp/webhook/route.ts`) |
| **ROXY = "camada cognitiva / agent runtime"** | Não sustentada pela evidência disponível. `ADR-AUT-001:128` (citado como evidência) diz que a localização de IA permanece **em aberto** — não atribui a ROXY um papel específico |

## 3. O que está desconhecido

Nada sobre a arquitetura de ROXY é conhecido a partir deste repositório. `R1`–`R10` (questionário de `SBD-001` §4.3) permanecem sem resposta:

| # | Pergunta |
|---|---|
| R1 | ROXY é um produto com tenants próprios, ou uma camada a serviço do FORCECRM? |
| R2 | Onde ROXY executa — processo próprio, VPS, serverless, dentro do runtime do FORCECRM? |
| R3 | ROXY possui estado persistente próprio? Em que armazenamento? |
| R4 | ROXY tem, ou pretende ter, acesso direto ao Postgres/Supabase do FORCECRM? |
| R5 | Como ROXY recebe contexto — payload empurrado, consulta puxada, leitura direta? |
| R6 | Como ROXY devolve ação — resposta síncrona, callback, escrita direta? |
| R7 | Existe API ou protocolo explícito de ROXY, versionado? |
| R8 | ROXY conhece conceitos internos do FORCECRM (`account_id`, `flow_runs`, `current_node_key`, `settle_outbound_message`)? |
| R9 | Qual a relação real de ROXY com Heimdall — sucessora, generalização, sistema independente? |
| R10 | ROXY é por conta (tenant) ou uma instância única servindo todas? |

## 4. Regra de não-inferência

> **Ausência de ROXY no repositório significa somente que não há evidência de ROXY neste repositório. Não autoriza concluir que ROXY não existe fora dele.**

> **Ausência de OpenClaw no repositório não significa inexistência do projeto OpenClaw** — ele existe como projeto OSS externo, citado em `heimdall/SKILL.md:8`.

> **Nenhum atributo arquitetural de ROXY deve ser inferido a partir de Hermes, OpenClaw, Heimdall ou qualquer outro sistema externo.** `SBD-001 D13` já rejeita explicitamente `Hermes = ROXY`, `OpenClaw = ROXY` e `ROXY = Hermes + OpenClaw` — esta regra permanece em vigor e não é reaberta aqui.

## 5. Gate D7 — enquadramento

`SBD-001 D7` não é alterado. Registra-se aqui apenas o enquadramento correto, para uso na etapa seguinte:

> O FORCECRM pode estabelecer unilateralmente sua própria fronteira: **não concede acesso direto ao seu Postgres a um agente externo. Efeitos sobre o domínio devem ocorrer através de superfícies controladas e autorizadas pelo FORCECRM.**

Isso define exclusivamente o que o FORCECRM concede e recusa — é a metade da fronteira que o FORCECRM tem autoridade para decidir sozinho (`SBD-001 BLOQ-1`). **A forma como ROXY consumirá essa fronteira permanece desconhecida até R4/R7 serem respondidas pela contraparte.** Este checkpoint não transforma essa distinção em nova arquitetura, não altera `SBD-001`, e não emite, revoga ou altera credencial alguma.

## 6. Condição de saída — `ADR-AI-001` permanece BLOCKED

Motivos, todos vigentes simultaneamente:

- R1–R10 não respondidas.
- Natureza de ROXY desconhecida (produto vs. camada).
- Runtime/deployment desconhecido.
- Memória/estado desconhecidos.
- Protocolo de integração desconhecido.
- Modelo de autonomia (copiloto vs. autônomo) desconhecido.
- Relação com Heimdall desconhecida (R9) — determina se `RISCO-1` (precedente de acesso direto ao banco no ecossistema) é herdado ou não.
- Modelo de tenant de ROXY desconhecido (R10).
- Modelo de billing de IA por tenant desconhecido (`SBD-001 Q8`).
- Nenhuma interface de integração utilizável existe hoje além de `GET /api/v1/me`.

**Nenhuma dessas questões é resolvida por inferência.** `ADR-AI-001` não pode ser escrito com rigor equivalente ao resto deste repositório (que exige ADR congelado antes de código — `ADR-MSG-001`, E0) enquanto a metade ROXY da fronteira permanecer vazia.

**Nenhuma implementação de IA, agent runtime, copilot, MCP, event bus ou motor de orquestração novo está autorizada antes do desbloqueio deste gate.**

## 7. Condição objetiva de desbloqueio

Fornecer, para cada uma de R1–R10, uma resposta rastreável (documento de arquitetura de ROXY, ou declaração explícita de quem detém essa decisão) — não é necessário resolver todas de uma vez, mas `R4` e `R9` são as duas que a `SBD-001 §8.4` identifica como bloqueantes de qualquer emissão de credencial. A partir daí, `ADR-AI-001` pode ser iniciado usando `SBD-001` como base e os seis deltas de `FORCECRM-ROXY-BOUNDARY.md` (§2 acima) como material complementar já verificado.
