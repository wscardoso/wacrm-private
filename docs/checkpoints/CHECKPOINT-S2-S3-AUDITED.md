# S2/S3 — Registro de achados de segurança auditados (sem correção)

## Resumo executivo

Registro rastreável dos dois achados de segurança **já identificados nas auditorias anteriores, mas sem artefato formal no repositório**. S1 possui `CHECKPOINT-HOTFIX-002-S1.md`; S2 e S3 não possuíam checkpoint próprio — esta é a formalização, **sem corrigir o código**. A correção fica bloqueada até decisão explícita.

Referenciado por: `docs/planning/RECONCILIACAO-FINAL-CHATPRO-2026-08-07.md` §S2/S3 e `docs/planning/ANALISE-COMPETITIVA-CHATPRO-2026-08-07.md`.

## S2 — Buckets públicos `chat-media` / `flow-media` sem controle de acesso na leitura

### Estado

Os dois buckets de mídia são **públicos** (`public = TRUE`) e possuem policy de `SELECT` **aberta a todos** (`USING (bucket_id = '...')`, sem restrição de membro de conta). A leitura é pública por decisão documentada (a Meta precisa buscar a URL sem credenciais), mas isso expõe **toda mídia de todas as contas** a qualquer pessoa que possua a URL — e as URLs são devolvidas ao cliente via `getPublicUrl()` no momento do upload.

### Evidências

| Evidência | Arquivo | Linha | Descrição |
|-----------|---------|-------|-----------|
| Bucket `flow-media` público | `supabase/migrations/016_flow_media.sql` | 57-63 | `INSERT INTO storage.buckets ... public = TRUE` |
| Bucket `chat-media` público | `supabase/migrations/023_chat_media.sql` | 38-42 | `INSERT INTO storage.buckets ... public = TRUE` |
| Policy SELECT pública — flow-media | `supabase/migrations/016_flow_media.sql` | 87-90 | `"Flow media is publicly readable" FOR SELECT USING (bucket_id = 'flow-media')` |
| Policy SELECT pública — chat-media | `supabase/migrations/023_chat_media.sql` | 83-86 | `"Chat media is publicly readable" FOR SELECT USING (bucket_id = 'chat-media')` |
| Reads declarados públicos por design | `supabase/migrations/020_account_sharing_followups.sql` | 60-61 | `Reads stay public (the bucket is public so Meta can fetch media URLs without credentials)` |
| URLs públicas devolvidas ao cliente | `src/lib/storage/upload-media.ts` | 113-115 | `supabase.storage.from(bucket).getPublicUrl(path)` |
| Consumidor — inbox composer | `src/components/inbox/message-composer.tsx` | 248, 286 | `uploadAccountMedia(CHAT_MEDIA_BUCKET, file)` → `publicUrl` |
| Consumidor — flow builder | `src/components/flows/forms/node-config-form.tsx` | 908 | `uploadAccountMedia(FLOW_MEDIA_BUCKET, file)` → `publicUrl` |
| Consumidor — template manager | `src/components/settings/template-manager.tsx` | 474 | `uploadAccountMedia('chat-media', file)` → `publicUrl` |

### Impacto

Qualquer pessoa com a URL de um objeto (ou capaz de inferir a convenção de caminho `account-<uuid>/<timestamp>-<basename>`) lê a mídia **de qualquer tenant**. As policies de escrita (`INSERT`/`UPDATE`/`DELETE`) são corretamente account-scoped; o gap é exclusivamente na **leitura**, que nunca checa `is_account_member`.

### Observação de escopo

O bucket `avatars` (migration 008) segue o mesmo padrão de `public = TRUE` — avatar é deliberadamente público e não faz parte deste achado. S2 cobre somente `chat-media` e `flow-media`.

## S3 — `_bcast_bump` (SECURITY DEFINER) sem REVOKE, execução aberta a PUBLIC

### Estado

`_bcast_bump` é `SECURITY DEFINER` e **não possui nenhum `REVOKE ALL ... FROM PUBLIC`** — ao contrário do padrão estabelecido no próprio repositório (migrations 007 e 012 revogam de `PUBLIC`/`anon`/`authenticated` e concedem apenas a `service_role`). Em PostgreSQL, `EXECUTE` em função é **concedido a `PUBLIC` por padrão**; sem `REVOKE`, qualquer role — incluindo `anon` e `authenticated` — pode invocá-la diretamente via PostgREST/SQL.

Por ser `SECURITY DEFINER SET search_path = public`, a função executa como o definidor (owner de migração = `postgres`, superuser), **ignorando RLS**. Um chamador arbitrário pode executar `UPDATE broadcasts SET <col> = GREATEST(0, <col> + delta) WHERE id = bid` contra qualquer broadcast, corrompendo contadores (`sent_count`/`delivered_count`/`read_count`/`replied_count`/`failed_count`) de qualquer tenant. O `format('%I', col)` aceita coluna arbitrária do `broadcasts`, o que amplia a superfície para além dos contadores.

### Evidências

| Evidência | Arquivo | Linha | Descrição |
|-----------|---------|-------|-----------|
| Definição da função | `supabase/migrations/005_broadcast_counts_incremental.sql` | 36-44 | `CREATE OR REPLACE FUNCTION public._bcast_bump(...) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public` — sem REVOKE/GRANT |
| Padrão correto do repo (contraste) | `supabase/migrations/007_automations_increment_counter.sql` | 32-35 | `REVOKE ALL ON FUNCTION ... FROM PUBLIC/anon/authenticated` + `GRANT EXECUTE ... TO service_role` |
| Padrão correto do repo (contraste) | `supabase/migrations/012_flows_increment_counter.sql` | 33-36 | Idem para `increment_flow_execution_count` |
| Chamadas legítimas (trigger) | `supabase/migrations/005_broadcast_counts_incremental.sql` | 72, 80, 91, 94 | `PERFORM _bcast_bump(...)` dentro do trigger — único consumidor legítimo |
| Verificação de ausência | `grep _bcast_bump` em `supabase/migrations/*.sql` | — | Apenas 005 referencia a função; **nenhum REVOKE** em qualquer migration |

### Impacto

Corrupção de integridade de contadores de broadcast por chamada arbitrária, com execução privilegiada (superuser) e **sem checagem de tenant**. Não é exfiltração de dados, mas é uma função `SECURITY DEFINER` mutável exposta a `PUBLIC` — exatamente a classe que o projeto já decidiu bloquear em 007/012/034/048/050/052/056.

## Não corrigido (escopo desta sessão)

- **S2:** não alterar `public = TRUE` nem as policies de leitura. Correção candidata (bloqueada até decisão): trocar leitura para URL assinada (`createSignedUrl`) ou policy de SELECT por `is_account_member`, com tratamento para a exigência "Meta busca URL sem credenciais" (ex.: link de envio resolvido server-side com token efêmero).
- **S3:** não adicionar `REVOKE`/`GRANT` a 005. Correção candidata (bloqueada até decisão): `REVOKE ALL ON FUNCTION public._bcast_bump(UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;` + `GRANT EXECUTE TO service_role;` — mesmo molde de 007/012. Aplicar também a `recompute_broadcast_counts(UUID)` (005:107-129), que é `SECURITY DEFINER` no mesmo arquivo e tem a mesma exposição.

## Próximo passo

Decidir se S2/S3 entram na fila de correção (proposta: P0 na matriz de prioridades do roadmap) e, se sim, liberar o item de implementação. Este checkpoint é somente o registro auditável.
