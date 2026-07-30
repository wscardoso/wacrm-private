# CHECKPOINT E2.1-RC1 — Correção de Processamento Canônico de Status

| | |
|---|---|
| **Épico** | E2.1 — Canonical Message Status |
| **Tipo** | Checkpoint de fechamento de ciclo de correção |
| **Estado** | **Fechado** — ciclo de correção concluído e publicado |
| **Commit de referência** | `319694f41716b62646538b068605a75a0b779f22` |
| **Data** | 2026-07-30 |
| **Escopo** | 7 arquivos de produção e teste — correção de bloqueadores B1/B2/B3/B5 sem ativação operacional |

---

## 1. Resumo executivo

E2.1-RC1 é o ciclo de correção decorrente da auditoria adversarial da Fase 1 de E2.1. Seu objetivo é corrigir os quatro bloqueadores identificados sem alterar contratos aprovados (ADR-MSG-STATUS-001, EIS-001) e sem ativar o fluxo operacional de ingestão.

**Resultado.** Os quatro bloqueadores foram corrigidos, testados e publicados. O handler canônico de status existe, compila, e passa a suíte de validação — mas não recebe eventos em produção porque rota, adapters e migration permanecem fora deste ciclo.

---

## 2. Origem das decisões de correção

- **B2** possui adjudicação formal registrada em `docs/architecture/E2.1-RC1-canonical-status-adjudication.md`, cujo cabeçalho declara explicitamente "Resolve: B2".
- **B1**, **B3** e **B5** foram identificados durante a auditoria adversarial do plano E2.1-RC1 e validados durante a revisão de implementação.
- Não existe artefato versionado anterior que adjudique B1, B3 e B5 individualmente, como existe para B2. Este checkpoint registra a **consolidação do estado implementado** para esses três itens — não substitui nem simula uma adjudicação arquitetural anterior que nunca foi produzida como documento próprio.

---

## 3. Escopo entregue

| Arquivo | Natureza | Justificativa |
|---|---|---|
| `docs/architecture/EIS-001-external-identity-storage.md` | Errata | Inclusão da errata §4.3 — alcance efetivo da restrição "à conexão" |
| `src/lib/message/status.ts` | Dependência estrutural | `evaluateTransition` e `isCanonicalStatus` são importados por `status-handler.ts`. Sem este arquivo o RC1 não compila |
| `src/lib/message/status.test.ts` | Teste da dependência | Acompanha `status.ts` por governança de testes — 57 testes unitários da matriz D6 |
| `src/lib/message/resolve-by-external-id.ts` | Implementação RC1 | Correção B3/B5 — resolução determinística com isolamento de conta |
| `src/lib/message/resolve-by-external-id.test.ts` | Teste RC1 | Cobertura B3/B5 — identidade ambígua, isolamento cross-account, fallback |
| `src/lib/whatsapp/status-handler.ts` | Implementação RC1 | Correção B1/B2 — direção inbound/outbound, CAS com retry e reavaliação |
| `src/lib/whatsapp/status-handler.test.ts` | Teste RC1 | Cobertura B1/B2 — T-1 a T-5, concorrência real via `Promise.all` |

`status.ts` foi incluído como **dependência estrutural mínima** para compilação e validação. A adjudicação original (§5.2) não previa a inclusão de `status.ts` no escopo explícito — o arquivo consta na tabela de arquivos proibidos de §5.2, sem ressalva. Durante o fechamento do commit, foi tomada uma **decisão adicional**, externa à adjudicação original, de fechamento mínimo do grafo de dependências: `status.ts` foi incluído porque era dependência executável necessária para compilação e validação do RC1 (sem ele, `status-handler.ts` não compila). Esta é uma **decisão de fechamento de dependência**, registrada aqui pela primeira vez — não uma interpretação retroativa da adjudicação original, que não a autoriza nem a antecipa. O arquivo não foi alterado (diff vazio contra HEAD), mas isso resolve apenas a questão de conteúdo, não a de inclusão no escopo.

---

## 4. Bloqueadores resolvidos

### B1 — Direção inbound/outbound

- `sender_type` é validado em `handleCanonicalStatusEvent` antes de qualquer transição.
- Mensagens com `sender_type` fora de `['agent', 'bot']` são rejeitadas com sinal N2.
- `evaluateTransition` permanece função pura de dois status — a direção não entra na matriz D6.
- A rejeição produz registro observável (`console.warn`), nunca descarte silencioso.

### B2 — Concorrência no CAS

- CAS perdido (zero linhas afetadas) dispara releitura do estado atual e reavaliação pela matriz D6.
- Laço limitado a `MAX_CAS_ATTEMPTS = 3` — operacional, não arquitetural.
- Orçamento exaurido produz `unapplied` com registro observável — nunca descarte ou laço infinito.
- `updated_at` **não foi reintroduzido**. Fundamentos registrados na adjudicação §4: não resolve B2, não é exigido por contrato, e adicionar migration estaria fora do escopo.

### B3 — Resolução ambígua por identidade externa

- `resolveMessageByExternalId` usa `distinct.size` para verificar se identidades de kinds diferentes apontam para a mesma mensagem.
- Múltiplas mensagens → `null` (nunca escolha arbitrária por ordem de retorno do banco).
- Ambiguidade produz `console.warn` — observável.
- A pendência arquitetural de `kind` (CHECKPOINT-E2.1-RC1-ARCHITECTURAL-PENDENCIES.md) foi respeitada: a implementação não decide precedência entre espécies.

### B5 — Isolamento do fallback

- Fallback escopa por `conversations!inner(account_id)` — restrito à conta.
- Equivalência a escopo por conexão documentada na errata EIS-001 §4.3, sob `UNIQUE(account_id)`.
- Teste T-6 verifica que duas contas com o mesmo `messages.message_id` não se cruzam.

---

## 5. Decisões congeladas

| Decisão | Status | Fundamentação |
|---|---|---|
| CAS retry/re-read é a estratégia oficial do RC1 | ✅ Congelada | Adjudicação §3. Implementada como laço com releitura a cada tentativa |
| `updated_at` não faz parte desta correção | ✅ Congelada | Adjudicação §4 coluna rejeitada: não resolve B2, não é exigida por contrato |
| Migration 063 permanece fora do RC1 | ✅ Congelada | Adjudicação §5.2. Migration é código de schema sem consumidor no RC1 — será entrada no ciclo de ativação |
| `status.ts` foi incluído no commit RC1 por decisão posterior de fechamento mínimo do grafo de dependências, registrada neste checkpoint | ✅ Congelada | Decisão de fechamento de dependência: inclusão por necessidade de compilação, não por expansão de mérito. Não decorre da adjudicação original (§5.2), que não a previa |
| EIS-001 §4.3 recebeu errata | ✅ Congelada | Errata registra equivalência `account_id` ≈ `connection_ref` sob `UNIQUE(account_id)` e obrigação de estreitar em E3 |
| `unapplied` é outcome válido do handler | ✅ Congelada (implícita) | Representa evento válido que exauriu orçamento sem escrita. Não é sinal D8 — é categoria própria, documentada no código como handler-level |

---

## 6. Itens explicitamente fora do RC1

| Item | Razão da exclusão |
|---|---|
| `src/app/api/whatsapp/webhook/[provider]/.../route.ts` | Rota não-Meta excluída por decisão de mérito na adjudicação §5.2 |
| `src/lib/whatsapp/providers/meta.ts` | Adapter Meta — fora do escopo RC1 (adjudicação §5.2) |
| `src/lib/whatsapp/providers/zapi.ts` | Adapter Z-API — fora do escopo RC1 |
| `src/lib/whatsapp/providers/uazapi.ts` | Adapter uazapi — fora do escopo RC1 |
| `src/lib/whatsapp/providers/types.ts` | Interface WhatsAppProvider — fora do escopo RC1 |
| `src/lib/whatsapp/providers/webhook-auth.test.ts` | Teste de adapter — fora do escopo RC1 |
| `src/lib/whatsapp/providers/dc-discovery.test.ts` | Teste D-C — pertence ao ciclo de ativação |
| `src/lib/whatsapp/providers/parse-status.test.ts` | Teste D9 — pertence ao ciclo de ativação |
| `supabase/migrations/063_messages_status_canonical.sql` | Migration — excluída por decisão de mérito (adjudicação §4, §5.2) |
| `scripts/rotate-zapi-webhook.mjs` | Script operacional — sem relação com E2.1 |
| `.claude/settings.json` | Configuração local — excluída de todos os commits por acordo prévio |

---

## 7. Estado dos testes

| Suíte | Arquivo | Cenários | Cobertura |
|---|---|---|---|
| Matriz D6 (unitário) | `src/lib/message/status.test.ts` | 57 testes | Transições T1–T6, progressLevel, admissibilidade, inadmissibilidade, noop |
| Resolução (integração) | `src/lib/message/resolve-by-external-id.test.ts` | 16 testes | B3 (ambiguidade), B5 (isolamento), precedência identidade/fallback, erro de consulta |
| Handler (integração) | `src/lib/whatsapp/status-handler.test.ts` | 20 testes | B1 (direção), B2 (CAS T-1..T-5), D8 (N1/N2/N3), D6 sem concorrência |

**Total: 93 testes.**

**Validação realizada:**
- Cada teste obrigatório da adjudicação §6 (T-1 a T-6) foi implementado e passa.
- T-5 reproduz corrida real com `Promise.all` sobre `handleCanonicalStatusEvent`.
- PostgREST fake aplica filtros reais sobre tabelas em memória — verifica comportamento, não implementação.
- Testes falhariam contra a Fase 1 (baseline `1b92a1f`): direção não verificada, CAS sem retry, resolução sem tratamento de ambiguidade.

---

## 8. Pendências para próximo ciclo — E2.1 Activation Gate

O ciclo de ativação (E2.1-Activation) deve endereçar:

| Item | Depende de |
|---|---|
| Integração da rota webhook (status-first dispatch D-C) | Decisão arquitetural sobre escopo expandido |
| Ativação dos adapters D9 (parseStatusEvent em Meta, Z-API, uazapi) | Captura de payload real de Z-API e uazapi (pré-condição 1 do CHECKPOINT-E2.1) |
| Entrada da migration 063 (CHECK aditivo para `pending` e `received`) | Nenhuma — migration já escrita |
| Validação com payloads reais de providers | Ambiente com instância de cada provider conectada |
| Decisão sobre observabilidade persistente D8 (tabela DLQ vs superfície própria) | Decisão do Product Owner |
| Inclusão de `dc-discovery.test.ts` e `parse-status.test.ts` no repositório | Dependente da ativação dos adapters |

---

## 9. Regra de continuidade

**E2.1-RC1 corrige semântica e segurança do processamento de status. Não ativa ainda o caminho operacional de ingestão.**

O handler existe, compila, e passa 93 testes de validação. Em produção, nenhum evento de status o alcança — a rota webhook e os adaptadores não estão neste commit. Esta inércia é intencional e documentada.

A ativação operacional exige ciclo próprio (E2.1-Activation), com adjudicação arquitetural independente, autorização de escopo expandido, e captura de payload real de providers.

---

*Ciclo E2.1-RC1 encerrado. Nenhum ADR existente foi alterado. Nenhum contrato aprovado foi reaberto. A migration 063, os adaptadores e a rota webhook permanecem no working tree para o ciclo de ativação futuro.*
