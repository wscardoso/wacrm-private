# Rodadas 3, 4A, 4B — Summary

## O Que Foi Feito

14 issues corrigidos em 3 rodadas de revisão de código, focando em segurança de dados,
resiliência e prevenção de crashes.

## Rodada 3 — 5 Fixes CRÍTICO+HIGH

| # | Issue | Arquivo | Tipo |
|---|------|---------|------|
| 1 | `verifyMetaWebhookSignature` args invertidos | `providers/meta.ts:143` | Bug |
| 2 | `resumePendingExecution` sem checar `is_active` | `automations/engine.ts:166` | Data integrity |
| 3 | `ENCRYPTION_KEY` sem validação — crash enigmático | `encryption.ts:29` | Crash |
| 4 | `touchLastUsed` sem `.catch()` — unhandled rejection | `api-context.ts:108` | Crash |
| 5 | `meta-api.ts` sem `AbortSignal` + sem guard em `data.messages[0].id` | `meta-api.ts` | Latent crash |

## Rodada 4A — 5 Fixes DATA LOSS + CRASH

| # | Issue | Arquivo | Tipo |
|---|------|---------|------|
| 6 | `retryOnError` sem `.catch()` — unhandled rejection | `inbound-processor.ts:361` | Crash |
| 7 | `redeem_invitation()` sem checar `deals`/`flow_runs` — data loss | migration `019` | Data loss |
| 8 | `handle_new_user()` engole erros — usuário órfão | migration `001` + `017` | Data loss |
| 9 | `send/route.ts` sem content-length guard | `send/route.ts:67` | Segurança |
| 10 | `POST /api/automations/engine` sem rate limit | `automations/engine/route.ts` | Segurança |

## Rodada 4B — 4 Features HARDENING + ARQUITETURA

| # | Feature | Arquivos | Descrição |
|---|---------|----------|-----------|
| 11 | `fetchWithRetry` — retry 429/503/504 com exponential backoff | `meta-api.ts` | Resiliência |
| 12 | `createAccountScopedClient()` — tenancy wrapper | `account-client.ts` | Segurança |
| 13 | Dedup automations — 60s window | `automations/engine.ts` | Data integrity |
| 14 | Dead-letter queue — `whatsapp_webhook_dlq` | migration `031` | Resiliência |

## Arquivos Modificados/Criados

### Modificados (12)
- `src/lib/whatsapp/providers/meta.ts`
- `src/lib/automations/engine.ts`
- `src/lib/whatsapp/encryption.ts`
- `src/lib/auth/api-context.ts`
- `src/lib/whatsapp/meta-api.ts`
- `src/lib/whatsapp/inbound-processor.ts`
- `src/app/api/whatsapp/send/route.ts`
- `src/app/api/automations/engine/route.ts`
- `supabase/migrations/001_initial_schema.sql`
- `supabase/migrations/017_account_sharing.sql`
- `supabase/migrations/019_invitation_rpcs.sql`

### Criados (3)
- `src/lib/auth/account-client.ts`
- `supabase/migrations/031_webhook_dlq.sql`
- `supabase/tests/test_migration_001_handle_new_user.sql`

## Estrutura dos PRs

### PR #1: Crash + Data Loss Fixes (10 issues)
**Risco: Médio** | Prioridade máxima

Contém: issues 1-10 (Rodadas 3 + 4A)
Inclui: 3 migrations SQL que exigem `supabase migration up`

### PR #2: Hardening + Architecture (4 features)
**Risco: Baixo-Médio** | Feature

Contém: issues 11-14 (Rodada 4B)
Inclui: 1 migration SQL (DLQ), novo módulo `account-client.ts`

## Ordem de Merge

```
PR #1 → validar 1-2 dias em staging → PR #2 → deploy prod
```