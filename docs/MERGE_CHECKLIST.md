# Merge Checklist — Rodadas 3, 4A, 4B

## Antes de Mergear

- [ ] Código revisado e aprovado (code review)
- [ ] Testes unitários passando (`npm test`)
- [ ] Migrations testadas em staging (ver `MIGRATION_TEST_PLAN.md`)
- [ ] Staging database com backup recente
- [ ] Rollback preparado: `git revert <SHA>` documentado
- [ ] CloudWatch ou logs acessíveis para monitorar

## PR #1 — Crash + Data Loss Fixes (10 issues)

### Merging
- [ ] Merge PR #1 em `main`
- [ ] CI/CD verde (tests passando)
- [ ] Staging redeploy automático verificado (app carrega)
- [ ] Teste manual: signup flow funciona
- [ ] Teste manual: login funciona

### Monitoring (24h)
- [ ] 0 usuários órfãos (consulta SQL)
- [ ] Invitations funcionando sem erros
- [ ] Automations disparando normalmente
- [ ] Nenhum erro novo nos logs

## PR #2 — Hardening + Architecture (4 features)

### Merging
- [ ] PR #1 estável por 24h+ (só mergear depois)
- [ ] PR #2 mergeado em `main`
- [ ] CI/CD verde
- [ ] Staging deploy verificado
- [ ] DLQ table criada (consulta SQL)
- [ ] `createAccountScopedClient` em uso nos endpoints principais

### Monitoring (6h)
- [ ] DLQ: 0-5 entradas pending (normal)
- [ ] fetchWithRetry funcionando (log de retries)
- [ ] Dedup não bloqueando automations legítimas

## Deploy Produção

- [ ] Ambos PRs estáveis em staging por 24h+
- [ ] Rollback SHA documentado
- [ ] CloudWatch aberto para monitorar
- [ ] PR #1 deployado primeiro
- [ ] Monitorar 2h
- [ ] PR #2 deployado depois
- [ ] Monitorar 1h

## Pós-Deploy (24h)

- [ ] 0 usuários órfãos
- [ ] Invitations funcionando
- [ ] DLQ vazio (0-5 entradas)
- [ ] Automations rodando
- [ ] Time notificado