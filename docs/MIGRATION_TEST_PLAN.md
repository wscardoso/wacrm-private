# Migration Test Plan — PR #1

## Migrations Afetadas

| Migration | Mudança | Risco |
|-----------|---------|-------|
| `001_initial_schema.sql` | Removido `EXCEPTION WHEN OTHERS` em `handle_new_user()` | **Médio** — trigger de signup |
| `017_account_sharing.sql` | Removido `EXCEPTION WHEN OTHERS` (backport do 001) | **Médio** — mesmo trigger |
| `019_invitation_rpcs.sql` | Adicionado checks de `deals` e `flow_runs` | **Médio** — transação de redeem |

## Teste 1: Migration 001 (handle_new_user)

```
Arquivo: supabase/tests/test_migration_001_handle_new_user.sql
```

### Procedimento

1. Conectar ao staging DB:
```bash
psql postgresql://postgres:SEU_PASS@db.staging.supabase.co:5432/postgres
```

2. Executar o script de teste:
```bash
psql ... < supabase/tests/test_migration_001_handle_new_user.sql
```

3. Resultado esperado:
```
test_result
-----------
PASS: profile created
```

Se falhar: **NÃO MERGEAR** — debugar migration 001.

## Teste 2: Signup Flow (Manual)

1. Acessar https://staging.wacrm.app
2. Clicar "Sign Up"
3. Criar conta com email `teste-rodada-001@example.com` / senha segura
4. Verificar:
   - [ ] Autenticação bem-sucedida
   - [ ] Dashboard abriu
   - [ ] Email aparece em Settings → Profile

## Teste 3: Verificar Profiles no DB

```sql
SELECT u.email, u.created_at, p.user_id, p.account_id
FROM auth.users u
LEFT JOIN profiles p ON p.user_id = u.id
WHERE u.email = 'teste-rodada-001@example.com';
```

Esperado: `account_id` NOT NULL.
Se NULL: **CRÍTICO** — migration 001 quebrou.

## Teste 4: Redeem Invitation (019)

1. Criar convite em Settings → Members
2. Copiar link
3. Logout, abrir link em janela anônima
4. Completar signup
5. Verificar:
   - [ ] Entrou na conta correta
   - [ ] Deals preservados (se existiam)
   - [ ] Flow runs preservados

## Rollback

Se qualquer teste falhar:

```bash
git revert <SHA_DO_COMMIT>
git push origin main
```

O deploy staging automático fará rollback da migration.