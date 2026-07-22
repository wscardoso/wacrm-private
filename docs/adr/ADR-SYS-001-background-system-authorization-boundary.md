# ADR-SYS-001 — Background System Authorization Boundary

| | |
|---|---|
| **Tipo** | Architecture Decision Record — documental, sem código |
| **Escopo** | Sistêmico — **não é um ADR de E4b.** Antecede e é consumido por E4b (bloqueia o Commit 6 do scheduler), mas sua causa e seu impacto principal já existiam antes de E4b (automations, flows). |
| **Deriva de** | `ODI-001 v3` §5/§9 (liquidação como autoridade transacional única) · `DLB-001` §3/§4.3/§5/§7/§8/§10.1 · `ADR-MSG-001` D3/D4/D6 · achado de leitura registrado no relatório de dependências (análise somente leitura, HEAD `8057b22` + Commits 1–5 de E4b não commitados) |
| **Resolve** | A fronteira de autorização para **atores de sistema** (processos sem sessão humana) que precisam invocar operações transacionais hoje protegidas por checagem de `auth.uid()` |
| **Status** | Proposto · pronto para Gate |
| **Autoridade** | Decide **apenas** a fronteira de autorização para atores de sistema. **Não decide** implementação, não decide migration, não decide nenhum aspecto de retry/scheduler de E4b. Onde a decisão recomendada aqui tocar `settle_outbound_message`, essa alteração concreta é trabalho de um ADR/commit de implementação **posterior e próprio** — este documento apenas escolhe entre as alternativas de fronteira. |
| **Baseline de código** | HEAD `8057b22` |

---

## 1. Contexto

`ODI-001` (E4a) estabeleceu `settle_outbound_message` (migration 048) como a **única fronteira transacional** de liquidação de saída — `SECURITY DEFINER`, compare-and-set, com uma checagem de autorização:

```sql
IF NOT (is_account_member(v_account_id) OR can_access_account(v_account_id)) THEN
  RAISE EXCEPTION 'settle_outbound_message: not authorized for account %', v_account_id;
END IF;
```

`is_account_member` (017) e `can_access_account`/`is_platform_operator_for` (037) dependem **exclusivamente** de `auth.uid()`. A `GRANT EXECUTE` da função é **só para `authenticated`** — nenhuma migration posterior amplia isso. Este desenho é correto e suficiente para o caminho para o qual `ODI-001` foi escrito: uma requisição de usuário autenticado (`src/app/api/whatsapp/send/route.ts`, via `createClient()` com sessão real de cookies).

**O que `ODI-001` não previu:** processos **sem sessão humana** já invocam essa mesma função. `src/lib/automations/meta-send.ts` e `src/lib/flows/meta-send.ts` (código de E1, fechado, commit `78bd7cd`) chamam `settleMessage(db, ...)` com `db = supabaseAdmin()` — um cliente de service-role, sem impersonar usuário, onde `auth.uid()` é `NULL`. Pela leitura literal do SQL, essa chamada não deveria ter grant nem passar na checagem interna.

**Precedente já existente, do lado de entrada.** O projeto já resolveu exatamente este problema uma vez — só que para o caminho de entrada. `insert_inbound_message` (035), chamada por `webhook/route.ts` e `inbound-processor.ts` via `supabaseAdmin()`, segue o padrão oposto:

```sql
REVOKE ALL ON FUNCTION insert_inbound_message(...) FROM PUBLIC;
REVOKE ALL ON FUNCTION insert_inbound_message(...) FROM anon;
REVOKE ALL ON FUNCTION insert_inbound_message(...) FROM authenticated;
GRANT EXECUTE ON FUNCTION insert_inbound_message(...) TO service_role;
```

Sem checagem de `auth.uid()` — a autorização é delegada inteiramente à fronteira já validada antes de chegar à RPC (segredo do webhook, verificado na rota). O projeto tem, portanto, **dois modelos de autorização em uso simultâneo e não-declarados como tal**: um para ator humano (via `auth.uid()`), outro para ator de sistema (via `service_role` + fronteira externa). `settle_outbound_message` nunca recebeu o segundo modelo.

**Por que isto chega a E4b agora, sem ser um problema de E4b.** O Commit 6 de E4b (scheduler + orphan sweeper) precisa, pela primeira vez dentro do próprio épico, invocar liquidação a partir de um processo sem sessão — exatamente o padrão que `automations`/`flows` já usam. Isso tornou visível uma porta que já estava (provavelmente) destrancada incorretamente, não criou uma nova.

---

## 2. Problema

**Qual é a fronteira de autorização legítima para um ator de sistema invocar uma operação transacional protegida — em particular `settle_outbound_message` — quando não há `auth.uid()` disponível?**

Três consumidores concretos dependem da resposta:

1. `automations/meta-send.ts` — já em produção, hoje.
2. `flows/meta-send.ts` — já em produção, hoje.
3. O scheduler/orphan sweeper de `ARO-001` (E4b, ainda não implementado) — bloqueado por esta decisão.

---

## 3. Restrições

1. **`settle_outbound_message` não pode ser reaberto por conveniência.** Qualquer alteração nela é uma decisão explícita, avaliada como tal — não uma correção incidental.
2. **Nenhuma migration, nenhum código.** Este ADR decide a fronteira; a execução concreta é trabalho posterior.
3. **Nenhuma decisão de retry, scheduler ou qualquer conteúdo de `ARO-001`/`ADR-E4B-00x`.** Este documento é ortogonal a E4b — apenas o desbloqueia.
4. **Coerência com o princípio já estabelecido em `DLB-001` §10.1** ("o custo de subutilizar uma capacidade é menor que o de presumir uma inexistente") — a alternativa escolhida deve preferir o lado seguro sob incerteza.
5. **Coerência com `ODI-001` §5/§9** — liquidação como autoridade única. Qualquer alternativa que resulte em duas *lógicas de transição* independentes (em vez de duas *portas de entrada* para a mesma lógica) enfraquece essa garantia e deve ser rejeitada ou corrigida antes de aprovação.

---

## 4. Alternativas avaliadas

### A. RPC específica para operações de sistema, autorizada só para `service_role`

Nova função `SECURITY DEFINER`, sem checagem de `auth.uid()`, `GRANT EXECUTE` apenas para `service_role` (`REVOKE` de `authenticated`/`anon`/`PUBLIC`) — exatamente o molde de `insert_inbound_message`. A lógica de transição (compare-and-set, hardening de `provider_message_id`, gravação de identidades) seria fatorada numa função interna comum, chamada por **ambas** as portas — a existente (`settle_outbound_message`, para `authenticated`) e a nova (para `service_role`) — preservando uma única autoridade de transição sob duas fachadas de autorização distintas.

### B. Alterar RPCs existentes para reconhecer ator de sistema explicitamente

Modificar `settle_outbound_message` para aceitar uma segunda via de autorização (ex.: checar `current_setting('request.jwt.claim.role', true) = 'service_role'` como alternativa a `is_account_member`/`can_access_account`), numa única função.

### C. Modelo de usuário de serviço / impersonação controlada

Ou (i) criar um perfil "sistema" real, associado como membro de cada conta (ou de uma conta especial), para que `auth.uid()` resolva a um valor legítimo; ou (ii) mintar tokens de impersonação de curta duração para um usuário real da conta antes de cada liquidação de sistema, de modo que a chamada ocorra "como se" esse usuário a tivesse feito.

---

## 5. Trade-offs

| | A — RPC de sistema dedicada | B — Alterar RPC existente | C — Usuário de serviço / impersonação |
|---|---|---|---|
| Toca `settle_outbound_message` | **Não** | **Sim** — reabre o contrato mais protegido do épico | Não (na variante de perfil-membro, se a checagem de `auth.uid()` resolver de verdade) |
| Precedente no próprio projeto | **Sim** — `insert_inbound_message` (035), já em produção | Não há precedente de checagem híbrida numa RPC de liquidação | Não há precedente de impersonação no projeto |
| Escopo de superfície de risco se a chave de service-role vazar | Afeta as operações que a nova RPC expõe — superfície nova, mas isolada | Afeta **a mesma** RPC que todo envio de usuário usa — um erro na lógica híbrida degrada o caminho principal | Variante perfil: superfície ampla (membro de toda conta); variante impersonação: superfície por token, mas token pode ser reusado se vazar |
| Autoridade única de transição (`ODI-001` §5/§9) | Preservada, **se** a lógica de transição for fatorada numa função interna comum às duas portas (exigido, ver §7) | Preservada por construção (uma função só) | Preservada (usa a RPC existente sem alteração) |
| Custo operacional recorrente | Baixo — chamada de RPC direta, sem passo extra | Baixo | **Alto** na variante de impersonação (round-trip à Admin API por liquidação, gestão de expiração/renovação de token); médio na variante de perfil-membro (manutenção de linhas de associação sintéticas) |
| Clareza semântica de auditoria | Alta — a ação é registrada como "sistema", sem fingir ser humana | Média — mistura dois modelos de autorização na mesma função, mais difícil de auditar isoladamente | Baixa na variante de impersonação — a ação fica atribuída a um usuário que não a realizou; ambígua com `messages.sender_type` (`'bot'`/`'agent'`), que já expressa "quem" de forma correta e não-humana |
| Risco de regressão no caminho de usuário (`send/route.ts`) | Nenhum — caminho intocado | Presente — qualquer bug na nova ramificação é um bug na única porta que todo envio de usuário usa | Nenhum |
| Alinhamento com `DLB-001` §10.1 (lado seguro sob incerteza) | Alto — nova porta é estritamente aditiva, escopo mínimo | Baixo — amplia a superfície da porta mais sensível do sistema | Médio — depende da variante |

---

## 6. Decisão recomendada

**Alternativa A — RPC de liquidação específica para atores de sistema, autorizada só para `service_role`, no molde de `insert_inbound_message`**, com uma condição estrutural obrigatória (não-negociável, ver §7): a lógica de transição deve ser fatorada numa função interna única, chamada por ambas as portas de entrada — a existente (`authenticated`) e a nova (`service_role`) — para que a "autoridade única de transição" de `ODI-001` §5/§9 permaneça verdadeira em espírito, não apenas em nome.

**Por que não B:** reabrir `settle_outbound_message` para acomodar uma checagem híbrida é a única alternativa que amplia o risco sobre a porta que **todo** envio de usuário já usa hoje, sem regressão. É também a única que mistura dois modelos de autorização — humano e sistêmico — dentro da mesma função, o que dificulta auditoria e viola o espírito de `DLB-001` §10.1 (preferir o lado que menos expande superfície sob incerteza).

**Por que não C:** ambas as variantes introduzem custo operacional ou complexidade de dados sem precedente no projeto, para resolver um problema que a Alternativa A já resolve com um padrão comprovado (`insert_inbound_message`) e sem tocar `settle_outbound_message`. A variante de impersonação, adicionalmente, produz uma trilha de auditoria enganosa — atribuir a um usuário real uma ação que um processo de sistema executou.

---

## 7. Requisito estrutural da decisão (vinculante para a implementação futura)

A nova RPC de sistema **não pode duplicar** a lógica de compare-and-set/hardening de `settle_outbound_message` de forma independente — isso criaria, na prática, duas autoridades de transição divergentes, contradizendo `ODI-001` §5/§9. A implementação futura (fora deste ADR) deve fatorar a lógica de transição numa função interna comum, com as duas RPCs públicas (`authenticated` e `service_role`) como fachadas de autorização distintas sobre a mesma autoridade. Este ADR **fixa esse requisito**; não define a assinatura ou o nome da função interna — isso é decisão de implementação.

---

## 8. Impacto em `settle_outbound_message`

**Nenhuma alteração ao texto ou à assinatura da função existente.** Ela permanece, verbatim, a porta de autorização para `authenticated` — o caminho de `send/route.ts` não muda em nada. O que muda é que ela deixa de ser a **única** porta: passa a ser uma de duas fachadas sobre a mesma autoridade de transição (§7). `ODI-001` não é reaberto — é honrado com mais precisão (a autoridade única de transição estava, na prática, sendo contornada pelos callers de automations/flows; a Alternativa A remove esse contorno).

## 9. Impacto em automations/flows

`src/lib/automations/meta-send.ts` e `src/lib/flows/meta-send.ts` passam a ter uma RPC legítima para chamar em vez de `settle_outbound_message` via `supabaseAdmin()`. Isto **corrige**, não introduz, uma condição que — pela leitura literal do SQL — já deveria estar falhando hoje nesses dois arquivos. A migração desses call-sites para a nova RPC é trabalho de implementação, fora deste ADR.

## 10. Impacto no scheduler de E4b

O Commit 6 (scheduler + orphan sweeper) permanece **bloqueado** até a Alternativa A ser implementada (migration + código, em um ADR/commit de implementação próprio, subsequente a este). Uma vez implementada, o scheduler consome a nova RPC de sistema exatamente como consumiria `settle_outbound_message` hoje — a troca é de qual porta chamar, não de nenhuma lógica de `ARO-001`. Nenhuma cláusula de `ARO-001`, `ADR-E4B-001`, `ADR-E4B-002` ou `ADR-E4B-003` é alterada por esta decisão.

## 11. Compatibilidade com `ODI-001` e `DLB-001`

| Contrato | Compatibilidade |
|---|---|
| `ODI-001` §5/§9 (liquidação como autoridade única) | Preservada **condicionalmente** ao requisito de §7 (função interna comum). Sem esse requisito, a Alternativa A violaria esta cláusula — é por isso que o requisito é vinculante, não uma sugestão. |
| `ODI-001` §10 ("Protegido — não tocar") | Honrado — `settle_outbound_message` não é alterada. |
| `DLB-001` §4.3 (agnosticismo) | Sem contato — esta decisão é sobre autorização de infraestrutura, não sobre conhecimento de provider. |
| `DLB-001` §5 (provider declara, domínio consome) | Sem contato. |
| `DLB-001` §8/§10.1 (capability é contrato; default seguro) | O padrão espelhado (`service_role`-only, sem inferência) é a aplicação do mesmo princípio de default conservador a um problema de autorização, não de capability de provider — mesma disciplina, domínio diferente. |
| `ADR-MSG-001` D3/D4/D6 | Sem contato. |

**Nenhuma decisão de `ODI-001`, `DLB-001` ou `ADR-MSG-001` é alterada, ampliada ou reinterpretada.**

---

## 12. Riscos

| # | Risco | Mitigação |
|---|---|---|
| 1 | A função interna comum (§7) não ser de fato compartilhada na implementação, criando duas autoridades de transição divergentes | Requisito estrutural declarado como vinculante (§7); a implementação futura deve ser revisada especificamente quanto a isso antes do Gate de implementação |
| 2 | `GRANT ... TO service_role` sem `auth.uid()` remove qualquer escopo de conta *dentro da RPC* — a responsabilidade de não liquidar a mensagem errada passa a ser inteiramente do código chamador | Mesmo modelo de confiança já aceito para `insert_inbound_message` e para todo uso de `supabaseAdmin()` no projeto (comentário already existente: "Never expose this client to browser code or pass it to untrusted callers") — não é um risco novo, é o risco já assumido tornado consistente |
| 3 | Automations/flows continuarem quebrados até a implementação da Alternativa A ocorrer | Fora do controle deste ADR — é motivação para priorizar a implementação, não uma razão para mudar a decisão |

---

## 13. Conformidade

- **Nenhum código, migration, teste, interface ou nome de arquivo de implementação produzido.**
- **Nenhuma decisão de retry, scheduler, backoff, TTL ou qualquer conteúdo de `ARO-001`/`ADR-E4B-001/002/003` tomada aqui.**
- **`settle_outbound_message` permanece verbatim.**
- Decide exclusivamente a fronteira de autorização para atores de sistema.

---

## 14. Recomendação de Gate

**APPROVE** da Alternativa A, condicionado ao requisito estrutural de §7 (função interna de transição compartilhada) sendo tratado como vinculante — não uma sugestão — em qualquer ADR/commit de implementação subsequente.

Pós-aprovação, dois itens ficam pendentes, ambos fora deste documento:
1. Um ADR/documento de implementação próprio para a nova RPC de sistema (nome, assinatura, migration) — só então código.
2. Migração dos call-sites de `automations/meta-send.ts` e `flows/meta-send.ts` para a nova RPC — trabalho separado, fora de E4b.

O Commit 6 de E4b permanece bloqueado até o item 1 acima ser implementado.

---

*Fim do ADR. Nenhum código, migration, ou decisão de retry/scheduler foi produzida. Documento pronto para Gate Arquitetural.*
