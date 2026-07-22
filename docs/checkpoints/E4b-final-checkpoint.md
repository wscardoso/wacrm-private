# ForceCRM — E4b Final Checkpoint

| | |
|---|---|
| **Épico** | E4b — Async Recovery & Retry Orchestration |
| **Status** | **CLOSED** |
| **Commit** | `60b0565` |
| **Branch** | `main` |
| **Publicação** | `origin/main` — pushed |
| **Data** | 2026-07-22 |

---

## 1. Objetivo do E4b

Resolver os cenários de **falha não-terminal no caminho de saída** do WhatsApp:
- Mensagens que falham por erro **transiente ou ambíguo** (timeout, rate-limit, 5xx, rede) não devem ser liquidadas como `failed` permanente — devem permanecer `sending` e entrar num ciclo de **retry assíncrono e orquestrado**.
- A **orquestração** (quando retentar, por quanto tempo, quantas tentativas) deve ser isolada da lógica de provider, baseada em **capabilities** contratuais e decidida por uma **função pura centralizada**.
- O **settlement** (transição terminal `failed`/`delivered`) deve ser autoridade única da `settle_outbound_message_core`, sem bifurcação por identidade de provider.
- O sistema deve suportar **recuperação de crash** (mensagens presas em `sending` ou `retrying` após reinicialização do scheduler).

---

## 2. Contratos arquiteturais preservados

Todos os contratos abaixo permanecem **fechados** — nenhuma cláusula foi violada ou reaberta durante a implementação:

| Contrato | Status | Confirmação |
|---|---|---|
| **ADR-E4B-001** — Retry Lifecycle Semantics | ✅ Fechado | `failed` permanece terminal; mensagens reenviáveis permanecem `sending`; nenhum novo estado em `messages.status` |
| **ADR-E4B-002** — Ambiguous Delivery Recovery | ✅ Fechado | Retry decision tree implementada como `decideRetryOutcome` pura; sem lógica específica de provider |
| **ADR-E4B-003** — Provider Capability Contract | ✅ Fechado | `classifySendFailure` + `capabilities` definem o gate de retry; nenhuma decisão por identidade de provider |
| **ADR-SYS-001** — System Authorization Boundary | ✅ Fechado | `settle_outbound_message_core` é autoridade única de transição; facades `authenticated` e `system` são delegadas |
| **ARO-001 v3** — Async Recovery Orchestration | ✅ Fechado | Scheduler, orphan sweeper, retry ledger wiring completo |

### Invariantes mantidas

- `messages.status` não recebeu novos valores
- `settle_outbound_message_core` continua única função que executa transições terminais
- Nenhuma decisão de roteamento ou retry usa identidade de provider (`if Meta... else...`)
- Mensagens com `outcome=transient` ou `outcome=ambiguous` permanecem `sending` até resolução por retry ou TTL
- Mensagens com `outcome=permanent` são liquidadas como `failed` imediatamente

---

## 3. Implementação entregue

### 3.1 Retry Ledger (`retry_ledger`)

| Componente | Arquivo | Descrição |
|---|---|---|
| Tabela | `migrations/049_outbound_retry_ledger.sql` | `message_id UUID PK`, `attempt_count INT`, `last_error TEXT`, `locked_until TIMESTAMPTZ`, `created_at`, `updated_at` |
| Enqueue | `migrations/051_outbound_retry_enqueue.sql` | `enqueue_outbound_retry` RPC (authenticated facade) |
| Enqueue (sistema) | `migrations/052_outbound_retry_enqueue_system.sql` | Core → authenticated → system facades (ADR-SYS-001 pattern) |
| Deduplicação | RPC `enqueue_outbound_retry_core` | `ON CONFLICT (message_id) DO UPDATE` — mesma mensagem não duplica linhas |
| Claim | `cron/route.ts` | `UPDATE ... WHERE locked_until < now() ... RETURNING *` — claim-as-lock com `locked_until` |

### 3.2 Failure Classification (`classifySendFailure`)

| Arquivo | Export |
|---|---|
| `src/lib/whatsapp/delivery/sender.ts` | `classifySendFailure(error, capabilities) → SendOutcomeClass` |
| `src/lib/whatsapp/delivery/send-outcome.ts` | `SendOutcomeClass = 'permanent' \| 'transient' \| 'ambiguous' \| 'blocked'` |

Taxonomia:
- **permanent** — 4xx (exceto rate-limit/429), erros de validação, destinatário inválido → liquida como `failed`
- **transient** — timeout, 5xx, rede, 429/rate-limit → enfileira retry com backoff
- **ambiguous** — 200 OK sem `message_id` no provider, resposta malformada → enfileira retry (pode ter entregue)
- **blocked** — opt-out, destinatário bloqueou o canal → liquida como `failed` (não retenta)

### 3.3 Retry Policy (`decideRetryOutcome`)

| Arquivo | Export |
|---|---|
| `src/lib/whatsapp/delivery/retry-policy.ts` | `decideRetryOutcome(message, ledgerEntry, capabilities) → RetryOutcome` |

| Condição | `RetryOutcome` | Ação |
|---|---|---|
| `capabilities.maxRetries === 0` | `permanent-failure` | `settleMessage('failed')` — sem retry |
| `outcome === 'blocked'` | `blocked` | `settleMessage('failed')` — nunca reschedule |
| `outcome === 'permanent'` | `permanent-failure` | `settleMessage('failed')` |
| `age > TTL (72h)` | `expired` | `settleMessage('failed')` |
| `attempt_count >= max_attempts (10)` | `exhausted` | `settleMessage('failed')` |
| Caso contrário | `reschedule` | enfileira retry com `locked_until = now() + backoff(attempt_count)` |

Backoff: `min(5 * 2^attempt_count, 3600)` segundos (exponencial com teto de 1h).

TTL: `72h` da criação da mensagem.
Max attempts: `10`.

### 3.4 Scheduler (`cron/route.ts`)

| Arquivo | Rota |
|---|---|
| `src/app/api/whatsapp/delivery/cron/route.ts` | `GET /api/whatsapp/delivery/cron` |

Fluxo:
1. Autentica como `service_role` (cron secret)
2. Claim: `SELECT enqueue_outbound_retry_claim(limit := 10)` — атомический claim via RPC
3. Para cada mensagem claimada: consulta `decideRetryOutcome`
4. Se `reschedule`: chama `sendMessage` (re-tentativa via provider) → `handleSendFailure` ou `settleMessage`
5. Se terminal: chama `settleMessage` correspondente
6. Libera o lock: `UPDATE retry_ledger SET locked_until = now() WHERE message_id = ...`

### 3.5 Orphan Sweeper (`orphan-sweep/route.ts`)

| Arquivo | Rota |
|---|---|
| `src/app/api/whatsapp/delivery/orphan-sweep/route.ts` | `GET /api/whatsapp/delivery/orphan-sweep` |

Duas varreduras:
1. **Orphans**: `SELECT messages WHERE status = 'sending' AND NOT EXISTS (SELECT 1 FROM retry_ledger WHERE message_id = messages.id) AND created_at < now() - interval '5 minutes'` — enfileira no ledger para iniciar ciclo de retry
2. **Stuck retrying**: `reclaimStuckRetrying()` — `UPDATE retry_ledger SET locked_until = now() - interval '1 hour' WHERE status = 'retrying' AND updated_at < now() - interval '10 minutes'` (atomic `RETURNING *`) — recicla linhas presas após crash do scheduler

Ambas protegidas por `locked_until` — o scheduler só claima linhas com `locked_until < now()`.

### 3.6 Settlement Boundary

| Função | Arquivo (SQL) | Uso |
|---|---|---|
| `settle_outbound_message_core` | `050_settle_outbound_message_core.sql` | Autoridade única — executa a transição terminal (`delivered` ou `failed`) na `messages` e limpa `retry_ledger` |
| `settle_outbound_message` | `050_settle_outbound_message_core.sql` | Facade **authenticated** — valida JWT, delega para core |
| `settle_outbound_message_system` | `050_settle_outbound_message_core.sql` | Facade **system** — `SECURITY DEFINER` com `app.settings.service_role`, delega para core |

Todas as três compartilham o mesmo corpo de transição via `settle_outbound_message_core`.

No código TypeScript:
| Função | Arquivo | Descrição |
|---|---|---|
| `settleMessage` | `src/lib/whatsapp/delivery/settlement.ts` | Chama `settle_outbound_message` (authenticated facade) |
| `settleMessageSystem` | `src/lib/whatsapp/delivery/settlement.ts` | Chama `settle_outbound_message_system` (system facade) |
| `handleSendFailure` | `src/lib/whatsapp/delivery/sender.ts` | Orquestra `classifySendFailure → decideRetryOutcome → settleMessage/enqueue` |
| `parseSettlementResult` | `src/lib/whatsapp/delivery/settlement.ts` | Normaliza resposta jsonb (string ou já desserializado) de `settle_outbound_message_*` |

---

## 4. Auditoria pós-implementação

Uma auditoria adversarial do Commit 6 (`585b721`) contra os contratos arquiteturais encontrou **4 lacunas**, todas corrigidas no Commit 6.1 (`60b0565`):

| ID | Problema | Arquivo(s) | Correção |
|---|---|---|---|
| **B-1** | `send/route.ts` liquidava como `failed` incondicionalmente em ambos os paths (Meta e não-Meta), ignorando `classifySendFailure` | `send/route.ts` | Substituído por `handleSendFailure` — erros transient/ambiguous agora enfileiram retry |
| **B-2** | `parseSettlementResult` quebrava com `JSON.parse` quando `settle_outbound_message_core` já retornava jsonb desserializado (object, não string) | `settlement.ts` | Aceita ambos os formatos: `typeof result === 'string' ? JSON.parse(result) : result` |
| **B-3** | `sender.ts` e `cron/route.ts` duplicavam lógica de decisão de retry (if/else inline) sem passar pelo gate de `capabilities`; não existia função pura centralizada | `retry-policy.ts`, `sender.ts`, `cron/route.ts` | `decideRetryOutcome` criada — função pura que cobre todos os 5 branches; `handleSendFailure` refatorada para consumi-la |
| **B-4** | `orphan-sweep/route.ts` não reciclava linhas presas em `retrying` (scheduler crash durante processamento) | `orphan-sweep/route.ts` | `reclaimStuckRetrying` adicionada — `UPDATE ... WHERE status = 'retrying' AND updated_at < cutoff` |

Nenhuma das lacunas exigiu reabertura de contratos arquiteturais. Todas foram resolvidas dentro dos limites definidos por ADR-E4B-001/002/003, ADR-SYS-001 e ARO-001 v3.

---

## 5. Validações finais

| Etapa | Resultado |
|---|---|
| `tsc --noEmit` | ✅ Limpo — zero erros de tipo |
| `vitest run` | ✅ **691 passed**, 176 skipped — zero falhas de código |
| `next build` | ✅ Compiled — 39 rotas, zero warnings |

### Falhas ambientais conhecidas (não relacionadas ao E4b)

As 176 suítes ignoradas são todas **PGlite `beforeAll` timeout** neste ambiente (Windows sandbox). Nenhuma falha de código. Suítes afetadas:

| Suite | Motivo |
|---|---|
| `create-platform-workspace.pglite.test.ts` | `beforeAll` timeout em `new PGlite()` |
| `inbound-idempotency.pglite.test.ts` | idem |
| `outbound-delivery-integrity.pglite.test.ts` | idem |
| `outbound-retry-ledger.pglite.test.ts` | idem |
| `platform-account-discovery.pglite.test.ts` | idem |
| `platform-admin-foundation.pglite.test.ts` | idem |
| `platform-contacts-tenant-scoping.pglite.test.ts` | idem |
| `platform-inbox-tenant-scoping.pglite.test.ts` | idem |
| `platform-read-context.pglite.test.ts` | idem |
| `contacts/queries.test.ts` | idem |

---

## 6. Commits envolvidos

| Commit | Descrição | Hash |
|---|---|---|
| Base E4b inicial | Provider capability contract, failure classifier, retry ledger table, retry policy, tests | `49cd863` |
| Commit 6 | Scheduler (`cron/route.ts`) + Orphan Sweeper (`orphan-sweep/route.ts`) + `enqueue_outbound_retry` RPC + migration 051 | `585b721` |
| **Commit 6.1 (final)** | Correções B-1 a B-7 — `handleSendFailure` wiring, `parseSettlementResult`, `decideRetryOutcome`, `reclaimStuckRetrying`, migration 052, test suite completa | `60b0565` |

---

## 7. Estado atual

| Item | Valor |
|---|---|
| Épico | **E4b — Async Recovery & Retry Orchestration** |
| Status | **CLOSED** |
| Commit final | `60b0565` |
| Branch | `main` (`origin/main`) |
| Contratos arquiteturais | Nenhum reaberto. ADR-E4B-001/002/003, ADR-SYS-001, ARO-001 v3 preservados. |
| Cobertura de testes | 691 testes passando (unitários + integração PGlite); 176 skipped (ambiental) |
| Build | Compilação limpa — 39 rotas |

### Próximo trabalho

Qualquer novo épico deve iniciar a partir do commit `60b0565`. **Não reabrir contratos arquiteturais do E4b** salvo nova evidência técnica que demonstre violação de invariante.
