# CHECKPOINT HOTFIX-001 — Implementação Aplicada (Post-Deploy Validado)

| | |
|---|---|
| **Tipo** | Checkpoint de estado implementado pós-deploy |
| **Estado** | **Implemented & Validated** — HOTFIX-001 concluído |
| **Data / Hora** | 2026-08-01 |
| **Ambiente** | Supabase `wa-crm` — projeto `uybjenopyvdmuixnhzqh` |
| **Commit de referência** | `95cdd45` (deploy readiness) + este commit de checkpoint |
| **Pré-condição** | Fase 4 aprovada — `SELECT count(*) FROM deals WHERE conversation_id IS NOT NULL` → **0** (bloqueio operacional encerrado) |

---

## 1. Migrations executadas (ordem preservada)

| # | Migration | Conteúdo |
|---|---|---|
| 064 | `identity_br_ddd_reference.sql` | Espelho `identity_br_valid_ddd` + 67 DDDs |
| 065 | `identity_br_functions.sql` | `canonical_br()` e `phone_identity()` IMMUTABLE |
| 066 | `contacts_phone_identity_column.sql` | Coluna gerada `contacts.phone_identity` STORED + `idx_contacts_phone_identity` |
| 067 | `identity_merge_provenance.sql` | Tabela `identity_merge_provenance` + 3 índices |
| 068 | `flow_runs_merge_terminal_state.sql` | CHECK de `flow_runs.status` + `superseded_by_identity_merge` |
| 069 | `identity_merge_group_lock.sql` | `identity_merge_group_lock()` advisory lock |
| 070 | `identity_merge_rpc.sql` | RPC `merge_identity_group()` + 5 helpers |
| 071 | `identity_merge_backfill_checkpoint.sql` | Tabela `identity_merge_backfill_checkpoint` + índice |
| 072 | `identity_merge_v2_flag.sql` | `accounts.identity_merge_v2_state` CHECK `('off','identity_v2','identity_v2_merge')` |

A migration **063 pertence à E2.1 e permanece fora deste deploy** (não executada).

## 2. Evidências da aplicação (read-only, service role, ambiente de produção)

| Objeto | Verificação | Resultado |
|---|---|---|
| `accounts.identity_merge_v2_state` | `GET /rest/v1/accounts?select=identity_merge_v2_state` | **HTTP 200** — coluna presente; 6 contas com `"off"` (default) |
| `contacts.phone_identity` | `GET /rest/v1/contacts?select=phone_identity` | **HTTP 200** — coluna gerada presente |
| `canonical_br()` | RPC `POST /rpc/canonical_br {"input":"11987654321"}` | **`5511987654321`** ✓ |
| `phone_identity()` | RPC `POST /rpc/phone_identity {"input":"11987654321"}` | **`5511987654321`** ✓ |
| `merge_identity_group()` | OpenAPI `/rpc/merge_identity_group` + no-op (conta inexistente `00000000-…`) | **HTTP 200**, `merge_run_id: null`, `loser_contact_ids: []` — executável, sem escrita |
| `identity_merge_group_lock()` | OpenAPI + chamada com args falsos | **HTTP 204** — executável |
| Helpers `_merge_group_messages/conversations/contacts/attributions/flow_runs` | OpenAPI | **5 presentes** |
| `identity_merge_provenance` (067) | `GET` | **HTTP 200**, 0 linhas |
| `identity_merge_backfill_checkpoint` (071) | `GET` | **HTTP 200**, 0 linhas |
| `identity_br_valid_ddd` (064) | `GET` | **HTTP 200**, **67 DDDs** |
| Índices (`idx_contacts_phone_identity`, `idx_identity_merge_checkpoint_pending`, `idx_identity_merge_prov_*`, `idx_identity_br_valid_ddd_version`) | criados pelas migrations aplicadas sem erro | presente |
| Erros de migração | aplicação sem erro | **nenhum** |

## 3. Validações executadas

- **Pré-deploy (Fase 4):** `deals.conversation_id IS NOT NULL` → 0 linhas → deploy autorizado sem revisão do ADR (`HOTFIX-001-DEPLOY-READINESS.md`).
- **Pós-deploy:** todos os objetos das migrations 064–072 presentes, funções executáveis com saída canônica correta, RPC de merge/lock compiladas e invocáveis (no-op seguro), dados do espelho DDD íntegros.
- **Suíte de validação (pré-deploy, não regressiva):** `99 arquivos / 1418 testes` verdes; G.2 `34/34`; `tsc --noEmit` e `eslint` limpos — sem alteração de código neste deploy.

## 4. Resultado final

**HOTFIX-001 implementado e validado no ambiente de produção.** Nenhum erro durante a aplicação; nenhuma inconsistência detectada nas consultas read-only. Estado inicial seguro: `identity_merge_v2_state = 'off'` em todas as contas (Estado 0, comportamento atual inalterado); nenhum grupo de backfill pendente; nenhum merge executado (`identity_merge_provenance` vazia).

## 5. Commits

| Commit | Conteúdo |
|---|---|
| `95cdd45` | `docs: record HOTFIX-001 deploy readiness registration` |
| *(este)* | `docs: record HOTFIX-001 implemented post-deploy checkpoint` |

---

*Confirmação de conclusão do HOTFIX-001. Migrations 064–072 aplicadas no Supabase, validações pós-deploy executadas, checkpoint registrado. Rollout de flag (`identity_v2` → `identity_v2_merge`) permanece fora deste escopo, conforme HOTFIX-001 Fase F.*
