# CHECKPOINT — Feature A: corrida no round-robin de atribuição de leads

## Resumo executivo

A distribuição round-robin de leads (passo `assign_conversation`, modo
`round_robin`) lia e regravava seu cursor em **duas idas separadas ao
banco**. Duas atribuições concorrentes para a **mesma conta** liam o
mesmo cursor, escolhiam o **mesmo** agente e a segunda escrita apenas
reescrevia o valor da primeira: o cursor avançava uma posição para duas
atribuições e a rotação deixava de ser equitativa. A correção move a
rotação inteira para **uma RPC atômica** no Postgres, que serializa por
conta com `SELECT ... FOR UPDATE`. Mesmo precedente de `007`/`012`
(`increment_*_execution_count`): onde havia read-modify-write no app,
passa a haver chamada SQL atômica.

| Campo | Valor |
|---|---|
| SHA-base | `721c512979683e2c56a33a48f38f56809c997768` (`main`, contém `f7498d1`/`080`) |
| Worktree | worktree isolada `feat-a-round-robin-race` (branch homônima) |
| Escopo | apenas a corrida de distribuição. Não toca "negócio perdido", `departments`/filas/SLA nem o dispatcher de `conversation_assigned` |
| Migration | `081_lead_round_robin_atomic.sql` — **preparada, NÃO aplicada** |
| Estado | código + testes locais; **commitado localmente, sem push/deploy** |

## O problema (evidência)

`src/lib/automations/engine.ts` (base `721c512`, linhas 557-583):

1. `SELECT user_id FROM profiles WHERE account_id = … AND account_role IN (…) ORDER BY user_id` — lista de elegíveis;
2. `SELECT last_assigned_user_id FROM account_lead_routing WHERE account_id = …` — leitura do cursor;
3. cálculo do próximo **no cliente**: `(findIndex(last) + 1) % len`;
4. `UPSERT account_lead_routing SET last_assigned_user_id = <próximo>` — escrita.

Entre (2) e (4) não há lock: duas execuções concorrentes da mesma conta
intercalam (2), obtêm o mesmo `last_assigned_user_id`, calculam o mesmo
`<próximo>` em (3) e (4) apenas reescreve o mesmo valor.

## A estratégia

Uma função por conta que faz a rotação completa dentro de uma transação,
em `supabase/migrations/081_lead_round_robin_atomic.sql`:

- monta os elegíveis (`profiles.account_role IN ('owner','admin','agent')`,
  ordem `user_id ASC` — preserva a ordem determinística anterior e **não**
  usa a coluna legada `profiles.role`);
- sem elegível → retorna `NULL` **sem criar/avançar cursor**;
- `INSERT … ON CONFLICT (account_id) DO NOTHING` garante a linha de cursor;
- `SELECT … FOR UPDATE` locka a linha do **cursor daquela conta** — a
  leitura subsequente nunca é obsoleta; contas distintas não se bloqueiam;
- calcula a próxima posição (equivalente a `findIndex` + `(i+1)%len`,
  inclusive "cursor desconhecido/ausente → primeiro membro") e regrava;
- devolve o `user_id` escolhido.

Segurança: `SECURITY DEFINER SET search_path = public`, `OWNER TO postgres`,
`EXECUTE` revogado de `PUBLIC`/`anon`/`authenticated` e concedido **só** a
`service_role` (espelha `007`/`012`; a `080` já revogou o DML de
`account_lead_routing` de `authenticated`).

O engine passa a fazer **uma** chamada `db.rpc('assign_next_lead_agent',
{ p_account_id })`. Falha da RPC **sobe** (`throw`) e marca o run como
`failed` — não há degradação silenciosa, que é justamente como o bug
original se escondeu.

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `supabase/migrations/081_lead_round_robin_atomic.sql` | novo — RPC atômica + grants |
| `src/lib/automations/engine.ts` | `assign_conversation`/`round_robin` → 1 RPC atômica; erro propagado |
| `src/lib/automations/engine.funnel.test.ts` | contrato do engine: 1 RPC, sem read-then-upsert, `NULL` → "no agent resolved", erro → run `failed`, modo `specific` intacto |
| `src/test/lead-round-robin-atomic.pglite.test.ts` | novo — migration 081 real em PGlite: rotação, isolamento por conta, ausência de elegíveis, cursor obsoleto/cross-account, a corrida (padrão antigo colide × função não), privilégios |

## Evidências de teste (executado, local)

| Comando | Resultado |
|---|---|
| `npx vitest run src/lib/automations/engine.funnel.test.ts src/test/lead-round-robin-atomic.pglite.test.ts` | **28/28 passam** (2 arquivos) |
| `npx vitest run src/lib/automations` | **49/49 passam** (4 arquivos) |
| `npx vitest run --no-file-parallelism src/test` | **403/403 passam** (31 arquivos, inclui o novo) |
| `npx tsc --noEmit` | limpo |
| `npx eslint <arquivos alterados>` | 0 erros, 0 avisos |

### Nota de baseline (honestidade sobre o que falhou)

O `npx vitest run` completo (paralelo) falha **19 arquivos** — quase todos
`*.pglite.test.ts` — por `Worker exited unexpectedly` (esgotamento de
recursos ao subir muitos PGlite em paralelo nesta máquina). O mesmo
conjunto de 19 falhas ocorre **idêntico no repositório de base, sem
nenhuma alteração** (`main` em `721c512`) e **não** reproduz com
`--no-file-parallelism` (todos verdes). Portanto as 19 falhas são
**pré-existentes/ambientais**, não desta mudança.

## Limitações (não validado)

- **Concorrência real não medida.** PGlite é single-connection: o caso
  concorrente é **modelado por interleaving** (mesmo método de
  `outbound-retry-ledger.pglite.test.ts`). O teste estabelece o contrato
  SQL (rotação sob `SELECT … FOR UPDATE`, dentro da função) e prova que o
  padrão antigo colide e a função não; a serialização do lock é garantia
  do Postgres, não medida aqui.
- **Nada foi aplicado nem executado em produção** — sem `db push`, sem
  deploy, sem push.
- A `081` não foi rodada em Postgres remoto; foi carregada verbatim em
  PGlite.

## Migration e ordem de integração

1. Pré-requisito: `080` aplicada (tabela `account_lead_routing`) — a `081` depende dela.
2. Aplicar `081` **antes** (ou junto de) o deploy deste código: o engine
   novo exige a função. A `081` é aditiva e idempotente — aplicá-la antes
   do código é inofensivo (nada a chama até o deploy).
3. Se o PostgREST não recarregar o schema sozinho para a função nova,
   `NOTIFY pgrst, 'reload schema';`.

## Handoff

- Branch local `feat-a-round-robin-race` (base `721c512`) — sem push.
- Diff: 2 arquivos modificados + 2 novos (1 migration, 1 teste).
- Nada em `.claude/`, `AGENTS.md`, `CLAUDE.md` foi tocado.
