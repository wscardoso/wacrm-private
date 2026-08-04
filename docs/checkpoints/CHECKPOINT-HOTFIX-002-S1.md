# HOTFIX-002 — Fechamento S1

## Resumo executivo

S1 confirmado e corrigido. A vulnerabilidade de auto-escalada de tenant via `profiles_update` foi eliminada com `REVOKE INSERT, UPDATE ON profiles FROM authenticated` seguido de `GRANT UPDATE (full_name, avatar_url) ON profiles TO authenticated`.

## Root cause

A policy `profiles_update` (017_account_sharing.sql:624-626) utilizava `USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id)`, que apenas verificava autoria da linha sem restringir `account_id` nem `account_role`. Qualquer usuário autenticado podia PATCH sua própria linha para assumir `owner` de qualquer outra conta, tendo acesso total a dados alheios.

## Correção

**Migration:** `supabase/migrations/074_profiles_tenant_escalation_fix.sql`

- `REVOKE INSERT, UPDATE ON profiles FROM authenticated` — remove o privilégio de tabela inteiro concedido pelo bootstrap do Supabase
- `GRANT UPDATE (full_name, avatar_url) ON profiles TO authenticated` — re-concede apenas as duas colunas de autoatendimento
- `COMMENT ON COLUMN` para `account_id` e `account_role` documentando que são graváveis somente via SECURITY DEFINER

## Abordagem descartada

Revoke apenas de coluna (`REVOKE UPDATE (account_id, account_role) ON profiles FROM authenticated`). **Motivo:** privilégio de coluna em PostgreSQL é aditivo sobre o grant de tabela — `authenticated` já detém `UPDATE` de tabela inteira do bootstrap do Supabase (`GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated`). Revogar o privilégio de coluna não revoga o grant de tabela. A única abordagem correta é revogar o grant de tabela e re-conceder seletivamente por coluna.

## Evidências

| Evidência | Arquivo | Linha | Descrição |
|-----------|---------|-------|-----------|
| Política vulnerável | `supabase/migrations/017_account_sharing.sql` | 624-626 | `profiles_update` — sem restrição de tenant |
| Política `profiles_select` | `supabase/migrations/017_account_sharing.sql` | 622-623 | `USING (auth.uid() = user_id OR is_account_member(account_id))` |
| Política `profiles_insert` | `supabase/migrations/017_account_sharing.sql` | 627-628 | `WITH CHECK (auth.uid() = user_id)` |
| `is_account_member` | `supabase/migrations/017_account_sharing.sql` | 136-164 | SECURITY DEFINER — fonte de verdade para isolamento |
| handle_new_user | `supabase/migrations/001_initial_schema.sql` | 381 | SECURITY DEFINER — cria profiles com INSERT |
| handle_new_user (017) | `supabase/migrations/017_account_sharing.sql` | 669-672 | SECURITY DEFINER — idem |
| set_member_role | `supabase/migrations/018_account_member_rpcs.sql` | 42 | SECURITY DEFINER — grava account_role |
| remove_account_member | `supabase/migrations/018_account_member_rpcs.sql` | 131 | SECURITY DEFINER — re-atribui profile |
| transfer_account_ownership | `supabase/migrations/018_account_member_rpcs.sql` | 221 | SECURITY DEFINER — transfere ownership |
| redeem_invitation | `supabase/migrations/019_invitation_rpcs.sql` | 48, 129 | SECURITY DEFINER — move profile entre contas |
| provision_workspace | `supabase/migrations/043_workspace_provision_with_owner.sql` | 55 | SECURITY DEFINER |
| workspace_owner_integrity | `supabase/migrations/045_workspace_owner_integrity.sql` | 53 | SECURITY DEFINER — INSERT/UPDATE profiles ON CONFLICT |
| Correcao 074 REVOKE | `supabase/migrations/074_profiles_tenant_escalation_fix.sql` | 85 | `REVOKE INSERT, UPDATE ON profiles FROM authenticated` |
| Correcao 074 GRANT | `supabase/migrations/074_profiles_tenant_escalation_fix.sql` | 92 | `GRANT UPDATE (full_name, avatar_url) ON profiles TO authenticated` |
| Client-side UPDATE | `src/components/settings/profile-form.tsx` | 147-153 | Só grava `full_name` e `avatar_url` |
| beta_features — somente leitura | `src/hooks/use-auth.tsx` | 134 | Apenas leitura; sem UPDATE client-side |
| Teste exploit pré-correção | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 190-209 | UPDATE com account_id/account_role funciona pré-074 |
| Teste account_id bloqueado | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 222-231 | `permission denied for table profiles` |
| Teste account_role bloqueado | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 233-242 | `permission denied for table profiles` |
| Teste statement misto | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 244-256 | full_name + account_id + account_role falha por inteiro |
| Teste fluxo legítimo | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 271-285 | full_name e avatar_url continuam graváveis |
| Teste RPC privilegiada | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 287-306 | set_member_role() funciona dentro da própria conta |
| Teste sem SET ROLE | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 308-317 | POSTGRES/OWNER grava account_role — REVOKE não afeta |
| Teste cadeia fechada | `src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 319-324 | authenticated NÃO lê mais contatos da conta-vítima |

## Estado

### Antes (pré-074)

- account_id protegido: ❌ Não
- account_role protegido: ❌ Não
- full_name legítimo funciona: ✅ Sim
- avatar_url legítimo funciona: ✅ Sim
- INSERT client-side em profiles: ❌ Nunca existiu
- set_member_role() RPC: ✅ Sim
- remove_account_member() RPC: ✅ Sim
- transfer_account_ownership() RPC: ✅ Sim
- redeem_invitation() RPC: ✅ Sim
- provision_workspace() RPC: ✅ Sim
- Suíte completa: 1446 testes passando

### Depois (pós-074)

- account_id protegido: ✅ Sim
- account_role protegido: ✅ Sim
- full_name legítimo funciona: ✅ Sim
- avatar_url legítimo funciona: ✅ Sim
- INSERT client-side em profiles: ❌ Continua bloqueado
- set_member_role() RPC: ✅ Sim
- remove_account_member() RPC: ✅ Sim
- transfer_account_ownership() RPC: ✅ Sim
- redeem_invitation() RPC: ✅ Sim
- provision_workspace() RPC: ✅ Sim
- Suíte completa: 1457 testes passando (+11 do novo gate)

## Validação executada

| Comando | Resultado | Exit |
|---------|-----------|------|
| `npx vitest run src/test/gate2-profiles-tenant-escalation.pglite.test.ts` | 11/11 passed | 0 |
| `npx tsc --noEmit` | sem erros | 0 |
| `npx eslint . --max-warnings=9999` | 0 erros, 13 warnings pré-existentes | 0 |
| `npx vitest run --no-file-parallelism` | 1457 passing (104 arquivos) | 0 |

## Cenários do teste (confirmados)

1. **Exploit antes da correção** — UPDATE profiles SET account_id=..., account_role='owner' funciona sobre schema pré-074; consequência (leitura de contacts da conta-vítima) provada
2. **account_id bloqueado** — permission denied for table profiles
3. **account_role bloqueado** — idem
4. **Statement misto** — full_name + account_id + account_role falha por inteiro; full_name confirmado inalterado
5. **Fluxo legítimo** — full_name e avatar_url continuam graváveis
6. **RPC privilegiada** — set_member_role() (SECURITY DEFINER) continua funcionando dentro da própria conta
7. **Sessão sem SET ROLE** — equivalente a service_role/postgres; REVOKE atinge só o grantee `authenticated`
8. **Cadeia fechada** — authenticated NÃO lê mais contatos da conta-vítima (nunca virou membro dela)
9. **INSERT bloqueado** — authenticated não consegue INSERT em profiles
10. **Self-service name** — authenticated continua editando full_name
11. **Self-service avatar** — authenticated continua editando avatar_url

## Restrições

- Não criar novas tabelas
- Não alterar modelo de autorização
- Não mudar is_account_member()
- Não mover lógica para aplicação
- Não remover RLS
- Não criar bypass

## Critério de sucesso

- [x] migration revisada
- [x] schema profiles confirmado
- [x] grants confirmados
- [x] teste exploit falha
- [x] self-service continua funcionando
- [x] RPCs continuam funcionando
- [x] suíte completa passa
- [x] checkpoint criado
- [x] auditoria independente aprova

## Próximo passo

Liberar `git push` e subsequente deploy após aprovação deste checkpoint.