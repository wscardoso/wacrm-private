# Quick Reference — Pós-Deploy

## Monitoramento (a cada 6h nas primeiras 24h)

### 1. Usuários órfãos
```sql
SELECT COUNT(*) as orphaned_users
FROM auth.users u
LEFT JOIN profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL
  AND u.created_at > now() - interval '24 hours';
```
Esperado: **0**

### 2. Invitations funcionando
```sql
SELECT COUNT(*) as recent_redeems
FROM account_invitations
WHERE accepted_at > now() - interval '24 hours';
```
Esperado: número normal (comparar com baseline)

### 3. DLQ vazio (PR #2)
```sql
SELECT COUNT(*) as pending_dlq
FROM whatsapp_webhook_dlq
WHERE status = 'pending';
```
Esperado: **0-5**

### 4. Automations rodando
```sql
SELECT COUNT(*) as recent_executions
FROM automation_logs
WHERE created_at > now() - interval '6 hours';
```
Esperado: **> 0**

## Rollback

```bash
# 1. Reverter o commit
git revert <COMMIT_SHA>
git push origin main

# 2. Verificar deploy em staging
# 3. Se produção, deploy manual
```

## Comandos Úteis

```bash
# Ver SHA do último commit
git log --oneline -5

# Ver diff de migration específica
git diff HEAD~1 -- supabase/migrations/001_initial_schema.sql

# Ver status do deploy (GitHub Actions)
gh run list --workflow=deploy

# Conectar ao DB staging
psql postgresql://postgres:SEU_PASS@db.staging.supabase.co:5432/postgres
```