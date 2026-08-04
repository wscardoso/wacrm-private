# HOTFIX-001 — Plano de Implementação da Identidade Canônica e Merge de Contatos

| | |
|---|---|
| **Tipo** | Plano de implementação — consome dois ADRs congelados como autoridade semântica exclusiva |
| **Status** | Revisado pós-Gate — correções de implementação/redação aplicadas (CRÍTICO-1, CRÍTICO-2, ALTO-1–3, MÉDIO, BAIXO); nenhuma decisão semântica alterada. Ver changelog ao final do documento. Para novo Gate de Implementação. |
| **Depende de (congelados, não reinterpretáveis)** | `ADR-IDENTITY-BR-001` §14 · `ADR-CONTACT-MERGE-001` §14 |
| **Autoridade** | Decide **exclusivamente** matéria operacional: sequenciamento (Fase A), DDL (Fase B), RPCs (Fase C), fluxo transacional (Fase D), backfill (Fase E), rollout (Fase F), testes (Fase G). |
| **Proibição vinculante** | Este documento **não** decide, reabre, ajusta ou "esclarece" nenhuma questão de: o que é identidade de telefone, a relação de equivalência, casos ambíguos/fail-safe (`ADR-IDENTITY-BR-001`); ou quem sobrevive a um merge, regras de reconciliação de campo, o que pode/não pode desaparecer, invariantes de não-perda (`ADR-CONTACT-MERGE-001`). Toda vez que uma decisão de implementação parecer exigir uma escolha semântica, a resposta correta é citar o parágrafo do ADR correspondente como autoridade, nunca inventar um comportamento. |
| **Baseline de código auditado** | `022_contact_phone_dedup.sql`, `029_perf_indexes.sql`, `033_lead_attribution.sql`, `034_messages_inbound_idempotency.sql`, `035_inbound_idempotency_rpcs.sql`, `009_message_actions.sql`, `010_flows.sql`, `phone-utils.ts`, `dedupe.ts`. Próxima migration livre no repositório: `064`. |
| **Escopo de produção** | Este documento é o plano. As migrations, RPCs e scripts nele descritos ainda **não** existem no repositório e devem ser criados como artefatos separados durante a execução deste HOTFIX, um por Fase. |

---

## 0. Como ler este documento

Cada decisão abaixo é rotulada com a proveniência que a autoriza:

- **[IDENT §x]** — decorre diretamente de `ADR-IDENTITY-BR-001`, seção x. Citado, não reinterpretado.
- **[MERGE §x]** — decorre diretamente de `ADR-CONTACT-MERGE-001`, seção x. Citado, não reinterpretado.
- **[HOTFIX]** — decisão puramente operacional, de responsabilidade exclusiva deste documento (sequenciamento, nome de coluna/índice/RPC, formato de batch, mecanismo de flag, etc.), tomada dentro do espaço de liberdade que os dois ADRs deixaram explicitamente aberto (DDL, migração, rollout, testes, observabilidade, recuperação operacional).

Qualquer revisor que encontrar, neste documento, uma frase que pareça alterar "quem funde com quem" ou "o que é o mesmo telefone" deve tratá-la como defeito de redação deste HOTFIX, não como uma nova decisão — e reportá-la para correção, referenciando o parágrafo do ADR que ela deveria ter citado em vez de reinventar.

## 1. Escopo

### 1.1 Decide

- **Fase A** — ordem de migrations, ordem de alterações de código, estratégia de rollback, mecanismo de *feature flag*, sequência de deploy.
- **Fase B** — DDL: colunas, índices, constraints, enums, triggers necessários para materializar `canonical_br`/`identity()` (IDENT) e as regras de merge (MERGE) de forma indexável e executável.
- **Fase C** — assinatura, contrato e composição das RPCs que executam o merge.
- **Fase D** — o fluxo transacional exato (BEGIN…COMMIT) que implementa a ordenação já exigida por `ADR-CONTACT-MERGE-001` §3.6/§4.5/§6.2/§9.2.
- **Fase E** — como migrar o histórico existente: batches, checkpoint, resume, timeout, retry.
- **Fase F** — rollout: *feature flag*, canário, monitoramento, métricas, abort, rollback.
- **Fase G** — testes: *property-based*, integração, fixtures, concorrência, *race conditions*.

### 1.2 Não decide

- O que é identidade de telefone, `canonical_br`, `identity()`, `VALID_DDD`, fail-safe — **[IDENT, integral]**.
- Regra de sobrevivente, reconciliação de campo, o que pode/não pode desaparecer, invariantes, critérios de aceite semânticos — **[MERGE, integral]**.

---

## Fase A — Sequenciamento Operacional

### A.1 Ordem das migrations

Numeração sequencial a partir de `064` (próxima livre). Cada migration é idempotente (`IF NOT EXISTS` / `CREATE OR REPLACE`), seguindo a convenção já estabelecida em `022`/`034`.

| # | Migration | Conteúdo | Depende de |
|---|---|---|---|
| `064` | `identity_br_ddd_reference.sql` | Carrega `VALID_DDD` (Anexo A do IDENT) como tabela de referência a partir do arquivo-fonte versionado — **[IDENT Anexo A.1]** | — |
| `065` | `identity_br_functions.sql` | Funções `canonical_br(text)` e `phone_identity(text)` (`IMMUTABLE`, sem I/O) — **[IDENT §5, §6, §8.1, §8.2]** | `064` |
| `066` | `contacts_phone_identity_column.sql` | Coluna gerada `contacts.phone_identity`, índice de expressão — **[IDENT §8.2]** | `065` |
| `067` | `identity_merge_provenance.sql` | Tabela de proveniência de merge — **[MERGE §3.3]** | — |
| `068` | `flow_runs_merge_terminal_state.sql` | Novo valor de `status` distinguível para runs ativos não-sobreviventes — **[MERGE §7.2]** | — |
| `069` | `identity_merge_group_lock.sql` | Função de *advisory lock* por grupo de merge — **[HOTFIX, ver D.1]** | `066` |
| `070` | `identity_merge_rpc.sql` | `merge_identity_group()` e helpers internos — **[MERGE, integral; ver Fase C/D]** | `066`–`069` |
| `071` | `identity_merge_backfill_checkpoint.sql` | Tabela de checkpoint do backfill — **[HOTFIX, ver Fase E]** | `070` |

Nenhuma migration desta lista roda o merge em massa automaticamente (diferente de `022`, que rodava `merge_duplicate_contacts()` inline). O backfill é um processo separado e controlado (Fase E) — decisão operacional justificada em A.4.

### A.2 Ordem das alterações de código de aplicação

1. Publicar `docs/reference/anatel-ddd.json` e o gerador `scripts/generate-ddd-constants` — fonte única de verdade **[IDENT Anexo A.1.1]**.
2. Gerar `src/lib/whatsapp/phone-identity.ts` (`canonicalBr`, `phoneIdentity`) a partir da mesma especificação usada pela função SQL — paridade obrigatória por teste (Fase G.1).
3. Migrar todo caminho que hoje decide "é o mesmo contato?" (`findExistingContact`, webhook de criação de contato, import CSV) de `phonesMatchStrict`/`phone_normalized` para `phoneIdentity()` — **[IDENT §11]** — atrás da *feature flag* `identity_merge_v2` (F.1).
4. Remover o **uso** de `phonesMatchStrict` em caminhos de identidade (a função em si pode continuar existindo até decisão de limpeza; sua remoção física não é decisão deste HOTFIX) — **[IDENT §11]**.
5. Não remover `phonesMatch` nem `phoneVariants()`/`sendWithPhoneVariantRetry` — permanecem fora deste escopo — **[IDENT §4, §6.5, §11]**.

### A.3 Rollback

Distinção operacional que este HOTFIX precisa deixar explícita porque os ADRs não a fazem (matéria de recuperação, corretamente fora do escopo deles):

| Camada | É reversível? | Mecanismo |
|---|---|---|
| DDL das migrations `064`–`071` | Sim, por migration reversa (`DROP`/`ALTER`), enquanto nenhum merge foi executado sob o novo esquema. | Migration de rollback dedicada por migration acima, mantida junto ao commit que a introduz. |
| *Feature flag* `identity_merge_v2` desligada | Sim, imediato. | Volta o caminho de identidade para `phonesMatchStrict`/`phone_normalized`; **não desfaz** merges já executados. |
| Um `merge_identity_group()` já commitado | **Não, por aplicação.** | `ADR-CONTACT-MERGE-001` §3.6/§4.5/§6.2 exige que a remoção de perdedores só ocorra depois que nenhuma linha os referencia — a proveniência (§3.3) permite **auditar** o que foi fundido, não reconstruir automaticamente o estado anterior (isso recriaria linhas com novos `id`, violando I4/I7 de forma irreversível na direção oposta). A única reversão de um merge já commitado é restauração de infraestrutura (PITR) dentro da janela de retenção do provedor gerenciado, executada fora deste sistema. |

Consequência vinculante para a Fase F: como o merge não é desfazível pela aplicação, o *gate* de canário (F.3) precisa ser conservador — validar exaustivamente em amostra pequena antes de qualquer expansão, porque "abortar" depois de um lote processado significa **parar de processar mais grupos**, não reverter os já processados.

### A.4 Feature flag

Um único registro de flag por conta, `identity_merge_v2_enabled` (armazenado em `accounts` ou na tabela de flags já existente no projeto — mecanismo de flags é reaproveitado, não criado por este HOTFIX), materializado exatamente como F.1 descreve: **dois sub-estados dentro do mesmo registro** (dois campos, ou dois valores de um mesmo campo enumerado), nunca duas flags independentes que possam ser ligadas separadamente. Não é um booleano — um booleano não conseguiria representar os três estados operacionais abaixo. O registro controla **duas** coisas atadas (nunca independentes, para não recriar o cenário "flag por caminho" que as três revisões originais marcaram como bloqueante de rollout):

1. Qual função de identidade os caminhos de escrita (`findExistingContact`, webhook, import) usam: `phoneIdentity()` (on) vs. comportamento legado (off).
2. Se `merge_identity_group()` pode ser invocada automaticamente quando um caminho de escrita detecta uma colisão de grupo (on) ou apenas o backfill controlado pode invocá-la (off, mesmo com identidade v2 já ativa para leitura/dedupe preventivo).

Isso dá três estados operacionais válidos, e apenas três — nenhum estado "meio migrado" por caminho de código:

- **Estado 0 (flag off):** comportamento atual, sem alteração.
- **Estado 1 (flag on, merge automático off):** novos contatos já são deduplicados na escrita por `phoneIdentity()` (menos duplicatas novas); grupos pré-existentes só são fundidos pelo backfill controlado (Fase E), nunca por um webhook.
- **Estado 2 (flag on, merge automático on):** comportamento final — qualquer caminho que detecte colisão de grupo invoca `merge_identity_group()` inline, sob o mesmo *advisory lock* que o backfill usa (D.1), então não há corrida entre os dois.

**Correção — corrida em Estado 1.** O objetivo declarado do Estado 1 ("novos contatos já são deduplicados na escrita") só se sustenta se o próprio caminho de escrita for serializado por identidade — sem isso, duas inserções quase simultâneas do mesmo `phone_identity` novo (ex.: duas entregas de webhook próximas) podem passar ambas pela checagem de existência antes de qualquer uma commitar, criando exatamente a duplicata que o Estado 1 existe para evitar (o índice de B.3 não é `UNIQUE` neste estado — F.5 só promove a `UNIQUE` depois do backfill). Por isso, **em ambos os Estados 1 e 2**, o caminho de escrita em tempo real chama `identity_merge_group_lock(account_id, phone_identity)` (B.6) como primeira instrução da sua própria transação, antes de checar existência/inserir o contato — e só então, exclusivamente no Estado 2, decide também chamar `merge_identity_group()`. O Estado 1 usa a mesma trava, mas nunca invoca o merge; ver C.4 para o detalhamento por chamador.

### A.5 Deploy

Ordem de deploy por Estado, cada um um gate humano explícito antes de avançar para o próximo:

1. Deploy das migrations `064`–`071` (Estado 0 ainda, flag off — puro DDL aditivo, sem mudança de comportamento observável).
2. Deploy do código de aplicação com a flag lida mas o *default* off (Estado 0 continua).
3. Ativar `identity_merge_v2_enabled` para a conta canário → Estado 1 (F.3).
4. Rodar backfill controlado (Fase E) para a conta canário.
5. Promover a conta canário para Estado 2.
6. Expandir Estado 1 → Estado 2 por conta, seguindo o canário de F.3–F.4.

### A.6 Re-canonicalização operacional (Anexo A.1.4)

**[IDENT Anexo A.1.4]** obriga: toda mudança de versão de `VALID_DDD` invalida a garantia de estabilidade das `CanonicalKey` já calculadas sob a versão anterior, e "o HOTFIX/backfill derivado herda a obrigação de re-canonicalizar identidades armazenadas sempre que a versão muda". Este HOTFIX operacionaliza essa obrigação (matéria que os ADRs deixam explicitamente para cá) da seguinte forma, executada **apenas** quando `docs/reference/anatel-ddd.json` recebe uma nova `version` (nunca em operação de rotina):

1. **Atualizar a fonte.** `docs/reference/anatel-ddd.json` recebe a nova entrada/remoção com `source_ref` citando a resolução Anatel (**[IDENT Anexo A.1.3]**) e `version` incrementada.
2. **Regenerar os três artefatos derivados**, pelo mesmo `scripts/generate-ddd-constants` (**[IDENT Anexo A.1.1]**), na mesma migration/commit: (a) as linhas-espelho de `identity_br_valid_ddd` (B.1); (b) o array literal `VALID_DDD` embutido no corpo de `canonical_br()` (B.2), via `CREATE OR REPLACE FUNCTION`; (c) a constante TypeScript equivalente. O teste de paridade de G.1 falha o build se qualquer um dos três divergir do arquivo-fonte.
3. **Demover o índice `UNIQUE` antes de re-canonicalizar contas já promovidas por F.5 (ALTO-4).** Uma conta que já concluiu o backfill e foi promovida (F.5) opera sob `UNIQUE (account_id, phone_identity) WHERE phone_identity <> ''`. Uma mudança de versão do Anexo A pode fazer dois contatos antes distintos passarem a compartilhar a mesma `CanonicalKey` — exatamente a colisão que a nova versão do Anexo A torna legítima e que o merge existe para consolidar. Sob a constraint promovida, porém, o `UPDATE` do passo 4 falharia na primeira linha colidente, e a colisão não poderia sequer ser **descoberta** (E.3.1 só enxerga grupos depois que `phone_identity` foi recalculada) — um impasse: não se re-canonicaliza sob a constraint, e não se remove a constraint depois de já ter falhado. Por isso, sempre que ao menos uma conta já houver sido promovida, a sequência obrigatória é:
   1. Demover o índice ao estado não-único de B.3, pelo inverso exato do procedimento de F.5 e com o mesmo mecanismo sem lock exclusivo prolongado: `CREATE INDEX CONCURRENTLY idx_contacts_phone_identity_tmp ON contacts (account_id, phone_identity) WHERE phone_identity <> '';` → `DROP INDEX CONCURRENTLY idx_contacts_phone_identity;` → `ALTER INDEX idx_contacts_phone_identity_tmp RENAME TO idx_contacts_phone_identity;`.
   2. Executar os passos 4 e 5 abaixo (re-canonicalização + redescoberta + backfill dos novos grupos), conta a conta, para todas as contas.
   3. Repromover pelo procedimento inalterado de F.5, sob o mesmo critério de entrada de lá (zero `'failed'` no backfill), depois que 3.2 tiver concluído para todas as contas. A janela entre 3.1 e 3.3 é a única em que as contas já promovidas operam sem a garantia física de I1 — durante ela, a invariante continua protegida pelo *advisory lock* do caminho de escrita (B.6/C.4.2, ativo em Estados 1 e 2) e verificável pelo job de auditoria de F.4, exatamente como já era antes da primeira promoção.
   Como o índice de B.3/F.5 é **um único objeto físico** (`contacts (account_id, phone_identity)`, particionado logicamente por `account_id` mas não por objeto), a demoção de 3.1 e a repromoção de 3.3 são operações globais, não por conta: a campanha de re-canonicalização de uma mudança de versão do Anexo A roda **inteiramente dentro de uma única janela de demoção**, cobrindo todas as contas antes da repromoção. Se nenhuma conta houver sido promovida ainda (índice ainda no estado não-único de B.3), este passo 3 inteiro é dispensado — não há constraint a demover.
4. **Re-canonicalizar o armazenado.** Como `contacts.phone_identity` é `GENERATED ... STORED` (B.3), o Postgres **não** recalcula linhas existentes quando `phone_identity()`/`canonical_br()` são substituídas por `CREATE OR REPLACE FUNCTION` — apenas novas escritas passam a usar a função nova. Por isso, uma mudança de versão do Anexo A dispara um job de re-canonicalização que força a reavaliação da coluna gerada para toda linha de `contacts`, reaproveitando o mesmo mecanismo de lote/checkpoint/retomada da Fase E (E.1–E.3), mas com unidade de trabalho `account_id` (não grupo de identidade) e ação `UPDATE contacts SET phone = phone WHERE account_id = $1` em lotes (um *no-op* de valor que força o Postgres a reavaliar a expressão gerada da linha, sem reescrever `phone`).
5. **Reabrir a descoberta de grupos.** Depois da re-canonicalização de uma conta, sua descoberta de grupos (E.3.1) é reexecutada — uma mudança de Anexo A pode criar novas colisões (dois números antes `NonBR` e distintos, agora ambos `CanonicalKey` iguais) ou desfazer colisões antigas de forma inerte (grupos já fundidos não se desfazem — fusões passadas são irreversíveis, A.3). Novos grupos entram no backfill normal (Fase E).
6. **Não reabre o Gate de identidade.** Por **[IDENT Anexo A.1.5]**, esta operação é mudança de dado governada, não uma revisão de `canonical_br`/`identity()` — o procedimento acima é inteiramente operacional (Fase A) e nunca decide se um novo DDD é válido, apenas propaga uma decisão já tomada pelo dono do Anexo A.

A ordem 3.1 → (4 → 5 → backfill, conta a conta) → 3.3 é obrigatória e não pode ser rearranjada: re-canonicalizar antes de demover falha por violação de unicidade; repromover antes de o backfill dos novos grupos concluir falha por duplicata remanescente (e é precisamente o que o critério de entrada de F.5 já barra). Nada disto altera a promoção gradual do rollout — o gradualismo de F.5 governa **quando cada conta ganha a garantia física** pela primeira vez; este passo 3 governa **como essa garantia é suspensa e restaurada** durante um evento raro de mudança de versão do Anexo A, mantendo intactos os Estados 0/1/2 da flag (A.4) e todos os critérios de canário e abort de F.3/F.6.

---

## Fase B — DDL

### B.1 Anexo A materializado — `VALID_DDD`

**[IDENT Anexo A.1]**: fonte única, versionada, com origem factual rastreável, nunca duas listas mantidas em paralelo. **[IDENT §8.2]** exige adicionalmente que a materialização usada por `canonical_br()` seja `IMMUTABLE`, "sem *lookup* dinâmico, sem I/O — `VALID_DDD` como constante fechada, não tabela consultada em runtime".

**Correção de inconsistência (CRÍTICO-1).** A versão anterior deste documento sugeria que `canonical_br()` consultaria `identity_br_valid_ddd` em tempo de execução — isso é incompatível com `IMMUTABLE` (uma função que lê outra tabela do banco é, no melhor caso, `STABLE`, nunca `IMMUTABLE`, e Postgres não impede a criação mas o comportamento sob índice de expressão/coluna gerada fica indefinido em cenários de alteração concorrente da tabela lida) e com a proibição explícita de *lookup* dinâmico do Anexo A.1. A materialização correta, que este documento agora fixa, tem **duas partes com papéis distintos e não intercambiáveis**:

1. **`identity_br_valid_ddd` — espelho de auditoria, nunca consultado por `canonical_br()`.** Existe exclusivamente para leitura humana/operacional (dashboards, auditoria, `SELECT` manual para conferir a versão vigente) e como o registro versionado que `scripts/generate-ddd-constants` usa para *gerar* o array literal de B.2. Nenhuma função `IMMUTABLE` faz `SELECT` sobre ela.
2. **O array `VALID_DDD` embutido como constante literal no corpo de `canonical_br()`** — a única forma que a função efetivamente consulta, e por isso a única exigida por §8.2. Ver B.2.

```sql
-- 064_identity_br_ddd_reference.sql
-- ESPELHO/AUDITORIA — nunca lido por canonical_br()/phone_identity(). Ver B.2.
CREATE TABLE IF NOT EXISTS identity_br_valid_ddd (
  ddd        CHAR(2) PRIMARY KEY,
  uf         CHAR(2) NOT NULL,
  source_ref TEXT NOT NULL,      -- citação da resolução/página oficial da Anatel [IDENT Anexo A.1.3]
  version    INTEGER NOT NULL    -- versão do Anexo A vigente no momento da carga [IDENT Anexo A.1.4]
);

CREATE INDEX IF NOT EXISTS idx_identity_br_valid_ddd_version
  ON identity_br_valid_ddd (version);
```

- Populada por `scripts/generate-ddd-constants` a partir de `docs/reference/anatel-ddd.json` (arquivo-fonte único, formato de dados) — o mesmo script gera, na mesma execução: (a) as linhas desta tabela-espelho; (b) o array literal embutido no corpo SQL de `canonical_br()` (B.2); (c) a constante TypeScript. Um teste de paridade (Fase G.1) compara os três contra o JSON-fonte — nunca a tabela contra a função em runtime, porque a função nunca lê a tabela.
- `version` é incrementada apenas por uma mudança de dado governada — **[IDENT Anexo A.1.5]**: isso não reabre `ADR-IDENTITY-BR-001`. O procedimento de propagação dessa mudança para o array embutido e para o dado já armazenado é A.6 (re-canonicalização).

### B.2 Funções de identidade

```sql
-- 065_identity_br_functions.sql
-- Gerada por scripts/generate-ddd-constants a partir de docs/reference/anatel-ddd.json
-- (versão embutida no comentário abaixo por rastreabilidade; ver A.6 para o
-- procedimento de regeneração quando a versão muda).
CREATE OR REPLACE FUNCTION canonical_br(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE               -- exigido por [IDENT §8.2]: sem I/O, sem lookup dinâmico
PARALLEL SAFE
AS $$
  -- Implementa §5–§9 de ADR-IDENTITY-BR-001, passo a passo (normalização,
  -- resolução de DDI, envelope DDD+assinante, canonicalização do 9º dígito).
  -- Retorna a CanonicalKey ou NULL (NonBR).
  --
  -- CRÍTICO: o envelope de §6.3 testa o DDD contra um ARRAY LITERAL gerado
  -- (constante embutida no corpo desta função, ex.:
  --   ddd = ANY (ARRAY['11','12','13', ...(~67 códigos)... ,'99']::text[])
  -- ), NUNCA contra uma subquery em identity_br_valid_ddd (B.1). Um SELECT
  -- sobre outra tabela tornaria a função, no melhor caso, STABLE — não
  -- IMMUTABLE — e violaria [IDENT §8.2] diretamente. A tabela B.1 é
  -- espelho/auditoria; o array acima é a única forma que esta função lê
  -- VALID_DDD. Regenerar este corpo (CREATE OR REPLACE) é o único
  -- mecanismo de atualização — nunca uma edição manual do array.
  --
  -- Corpo omitido deste plano: é a MESMA especificação de IDENT §6,
  -- não uma reinterpretação — a implementação concreta é revisada
  -- contra o Anexo B (fixture) no Gate de Fase G, não neste documento.
$$;

CREATE OR REPLACE FUNCTION phone_identity(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  -- identity() de [IDENT §6.6]: canonical_br(input) quando não-NULL,
  -- senão regexp_replace(input, '\D', '', 'g') (o mesmo predicado de
  -- phone_normalized em 022) como igualdade exata de fallback.
  SELECT COALESCE(canonical_br(input), regexp_replace(input, '\D', '', 'g'));
$$;
```

`NonBR` é representado como SQL `NULL` dentro de `canonical_br` (decisão de tipagem, não de semântica — `NULL` já é o marcador natural de "sem chave canônica" em Postgres) para que `phone_identity()` degrade para `COALESCE`. A equivalente TypeScript usa um marcador de união (`CanonicalKey | null`), mantendo a mesma correspondência 1:1 que o teste de paridade de Fase G.1 valida.

### B.3 Coluna e índice de identidade em `contacts`

```sql
-- 066_contacts_phone_identity_column.sql
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS phone_identity TEXT
  GENERATED ALWAYS AS (phone_identity(phone)) STORED;

CREATE INDEX IF NOT EXISTS idx_contacts_phone_identity
  ON contacts (account_id, phone_identity)
  WHERE phone_identity <> '';
```

- `phone_normalized` (`022`) **não é removida** — continua sendo a base do `NonBR`/`K_EXACT` de `identity()` (é literalmente o que `phone_identity()` calcula no ramo `COALESCE`) e do índice trigram de `029` usado por buscas textuais. Removê-la é fora de escopo — decisão de limpeza futura, não deste HOTFIX.
- Índice **não** é `UNIQUE`: ao contrário de `022`, que assumia que duplicatas já estavam resolvidas antes de criar o índice único, aqui a coluna é criada **antes** do backfill (Fase E) rodar sobre o histórico — um índice único quebraria a criação da coluna em qualquer conta com duplicatas de identidade pré-existentes. A unicidade de `(account_id, phone_identity)` só se torna um índice `UNIQUE` **depois** que o backfill daquela conta chega a zero grupos ativos — passo explícito de F.5 (procedimento corrigido lá, sem lock exclusivo).

**Estratégia operacional para o `ADD COLUMN ... GENERATED ... STORED` (ALTO-2).** Em Postgres, adicionar uma coluna gerada `STORED` exige reescrita completa da tabela (Postgres precisa calcular e persistir o valor para toda linha existente), independentemente de a coluna ser `NULL`-ável — não existe variante "instantânea" equivalente a um `ADD COLUMN` com default constante. Para `contacts`, isso significa uma janela de bloqueio `ACCESS EXCLUSIVE` proporcional ao tamanho da tabela. Este HOTFIX fixa o procedimento:

1. **Medir antes de migrar.** A migration `066` é precedida por uma consulta operacional (`SELECT count(*) FROM contacts`, rodada manualmente, fora da migration) registrada no *runbook* de deploy — não incorporada ao SQL da migration, que permanece idempotente e sem efeito colateral de medição.
2. **Tabela pequena/média (abaixo de um limiar operacional, ex. 500k linhas):** aplicar `066` diretamente durante a janela de deploy padrão (A.5 passo 1), com `lock_timeout` explícito (`SET lock_timeout = '5s'` antes do `ALTER TABLE`, dentro da própria migration) para que, se outra transação já segura um lock conflitante em `contacts`, a migration falhe rápido e de forma visível em vez de enfileirar um bloqueio silencioso e prolongado atrás dela.
3. **Tabela grande (acima do limiar):** `066` é destacada da lista de deploy contínuo (A.5) e executada em uma janela de manutenção anunciada, com monitoramento ativo de duração e de réplicas (a reescrita gera WAL proporcional ao tamanho da tabela — acompanhar *replication lag* durante a execução). Não existe, dentro do escopo deste HOTFIX, um caminho "online" alternativo para uma coluna `GENERATED STORED` sem trocar a coluna gerada por um trigger `BEFORE INSERT/UPDATE` equivalente — essa troca é uma mudança de arquitetura de dados fora do que esta rodada de correção pode alterar (a instrução do Gate veda mudança de arquitetura); se o volume real de `contacts` tornar a janela de manutenção inaceitável, a decisão de adotar a variante por trigger é matéria para uma revisão futura deste HOTFIX, não desta correção.
4. Em qualquer um dos dois casos, o passo é executado **antes** de qualquer conta ser promovida a Estado 1 (A.5) — nenhuma conta opera sob identidade v2 com a coluna ausente.

### B.4 Proveniência do merge

**[MERGE §3.3]**: obrigatória, conteúdo mínimo fixado pelo ADR; formato é decisão deste HOTFIX.

```sql
-- 067_identity_merge_provenance.sql
CREATE TABLE IF NOT EXISTS identity_merge_provenance (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  survivor_contact_id UUID NOT NULL,   -- não FK: o contato pode, em tese, ser
                                        -- removido por fluxo alheio no futuro;
                                        -- a proveniência não pode desaparecer
                                        -- com ele (seria perda de auditoria)
  loser_contact_id  UUID NOT NULL,
  loser_phone_raw   TEXT NOT NULL,     -- [MERGE §3.3] "o id e o phone cru de cada perdedor"
  phone_identity    TEXT NOT NULL,     -- [MERGE §3.3] "o valor de identity(phone) que agrupou o conjunto"
  merged_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  merge_run_id      UUID NOT NULL      -- correlaciona todas as linhas de um único merge_identity_group()
);

CREATE INDEX IF NOT EXISTS idx_identity_merge_prov_survivor
  ON identity_merge_provenance (survivor_contact_id);
CREATE INDEX IF NOT EXISTS idx_identity_merge_prov_run
  ON identity_merge_provenance (merge_run_id);
CREATE INDEX IF NOT EXISTS idx_identity_merge_prov_account
  ON identity_merge_provenance (account_id, merged_at DESC);   -- endurecimento: suporta a auditoria manual por conta de F.3.3 sem varredura completa
```

Critério de aceite A6 de `ADR-CONTACT-MERGE-001` §11 ("para todo contato removido, existe registro de proveniência") é verificado diretamente sobre esta tabela em Fase G.2.

### B.5 Estado terminal distinguível para `flow_runs`

**[MERGE §7.2]**: "o token concreto ... são materialização — DDL ... propriedade do HOTFIX derivado."

```sql
-- 068_flow_runs_merge_terminal_state.sql
ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_status_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_status_check
  CHECK (status IN (
    'active', 'completed', 'handed_off', 'timed_out',
    'paused_by_agent', 'failed',
    'superseded_by_identity_merge'   -- novo — distinguível de toda terminação natural [MERGE §7.2(d)]
  ));
```

`end_reason` para este estado segue o formato `'identity_merge:<merge_run_id>:<survivor_flow_run_id>'` — inclui o `id` do run que sobreviveu como ativo, exigido por **[MERGE §7.2.4]**. Junto com `end_reason`, `ended_at` **é sempre gravado** com o instante do merge — o mesmo `NOW()` transacional usado no restante de `merge_identity_group()` (D.1), não um `NOW()` recalculado por uma chamada separada — exigido explicitamente por **[MERGE §7.2.4]**: "`ended_at` recebe o instante do merge". Nenhum run transicionado para `'superseded_by_identity_merge'` pode ficar com `ended_at IS NULL` — critério de aceite A8 (**[MERGE §11]**) inclui esse campo na verificação, e G.2 testa isso explicitamente.

### B.6 *Advisory lock* de grupo

Corrige a versão anterior, que deixava a trava como comentário/convenção não executável. A trava é uma função SQL real, para que a aplicação e a RPC de merge usem exatamente a mesma lógica de *hashing* — nenhuma delas inlina `hashtext(...)` diretamente, eliminando o risco de divergência de chave entre os dois lados:

```sql
-- 069_identity_merge_group_lock.sql
CREATE OR REPLACE FUNCTION identity_merge_group_lock(
  p_account_id UUID,
  p_phone_identity TEXT
) RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
  -- pg_advisory_xact_lock: liberado automaticamente no COMMIT/ROLLBACK da
  -- transação corrente — nunca precisa de "unlock" explícito, o que
  -- eliminaria qualquer risco de trava presa por um caminho de erro.
  -- Reentrante dentro da mesma transação: se merge_identity_group() a
  -- chamar novamente após o caminho de escrita já tê-la adquirido na
  -- mesma transação, o segundo pedido é um no-op seguro (mesma sessão,
  -- mesma chave) — nunca um deadlock consigo mesma.
  SELECT pg_advisory_xact_lock(hashtext(p_account_id::text || ':' || p_phone_identity));
$$;

REVOKE ALL ON FUNCTION identity_merge_group_lock(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_merge_group_lock(UUID, TEXT) TO service_role;
```

Chamada por dois lugares (nunca por um terceiro caminho que reimplemente a chave):

1. `merge_identity_group()`, como passo 1 do esqueleto (D.1) — sempre, em ambos os Estados 1 e 2 em que a RPC é invocada.
2. O caminho de escrita em tempo real (C.4.2), como primeira instrução da sua transação, em **ambos** os Estados 1 e 2 (A.4, correção "corrida em Estado 1") — mesmo quando esse caminho não vai chamar `merge_identity_group()` (Estado 1), a trava ainda serializa a checagem de existência + inserção contra qualquer outro escritor da mesma identidade.

---

## Fase C — RPCs

### C.1 Por que uma única RPC de entrada, não três

O enunciado do gate lista, como exemplo, tanto três RPCs separadas (`merge_duplicate_contacts()`, `merge_duplicate_conversations()`, `merge_duplicate_messages()`) quanto uma única (`merge_identity_group()`). A escolha entre essas formas **é** decisão de implementação (Fase C) — mas não é livre: `ADR-CONTACT-MERGE-001` §9.2 exige que o merge de um grupo seja **uma transação única**, sem estado intermediário observável. Três RPCs `SECURITY DEFINER` chamadas separadamente pela aplicação seriam três transações independentes por padrão (cada `CALL`/`SELECT` de função top-level committa com a transação do chamador, e nada impede o chamador de não envolvê-las na mesma transação) — isso violaria §9.2 estruturalmente, não por bug de implementação, mas por forma.

**Decisão [HOTFIX]:** uma única RPC pública `merge_identity_group()`, que internamente chama funções auxiliares **não expostas** (`SECURITY DEFINER`, mas sem `GRANT` a nenhuma role de aplicação) para cada fase de dados — preservando a separação de responsabilidades do pedido (uma função por fase de dados) sem abrir uma janela de atomicidade quebrada.

### C.2 Assinatura

```sql
CREATE OR REPLACE FUNCTION merge_identity_group(
  p_account_id UUID,
  p_phone_identity TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$ ... $$;
```

- **Entrada:** o grupo é identificado por `(account_id, phone_identity)` — a mesma chave de particionamento de **[MERGE §2.5]**. A RPC recarrega os membros do grupo no início da transação (nunca recebe uma lista de `id` do chamador), para que o cálculo de sobrevivente sempre reflita o estado transacional corrente (evita "TOCTOU" entre a detecção do grupo pelo chamador e a execução do merge).
- **Saída:** um `JSONB` de resumo — `{ merge_run_id, survivor_contact_id, loser_contact_ids[], conversations_merged, messages_collapsed, reactions_collapsed, attributions_repointed, flow_runs_superseded }` — usado por Fase E (checkpoint/log) e Fase F (métricas). Formato de saída é puramente operacional.
- **No-op seguro:** se o grupo recarregado tem ≤1 membro (já fundido por uma chamada concorrente, ou nunca teve duplicata), a função retorna imediatamente com `loser_contact_ids: []` — é a mesma consequência que a idempotência de **[MERGE §9.1]** já exige, apenas tornada uma saída explícita em vez de um `RAISE`.

### C.3 Funções auxiliares internas (chamadas apenas por `merge_identity_group`, dentro da mesma transação)

Todas com `SECURITY DEFINER` e `SET search_path = public` (mesmo padrão de C.2/B.6 — endurecimento contra sequestro de `search_path`, sem impacto de comportamento), e sem `GRANT EXECUTE` para nenhuma role de aplicação (idêntico ao parágrafo abaixo da tabela).

**Correção de ambiguidade (CRÍTICO-2) — nenhum helper remove `contacts` nem `conversations`.** A versão anterior desta tabela listava "remoção" como parte da responsabilidade de `_merge_group_contacts(...)`, o que contradizia a ordem exigida por `ADR-CONTACT-MERGE-001` §3.6/§4.5/§9.2 e o próprio esqueleto de D.1. Fica corrigido:

| Função | Fase de dados | Referência semântica |
|---|---|---|
| `_merge_group_contacts(...)` | §3.1–§3.5 (fill-gap de campos escalares, campos próprios, gravação de proveniência; re-apontamento de `contact_notes`, `deals` e `broadcast_recipients` — as três tabelas de §3.4 que não são alcançadas por nenhum outro helper, ver D.1 passo 13a; colapso de `contact_tags`/`contact_custom_values` por §3.5). **Não remove nenhuma linha de `contacts`.** | **[MERGE §3.1–§3.5]** |
| `_merge_group_conversations(...)` | §4.1–§4.5 (eleição de sobrevivente, reconciliação de campos, `unread_count`, consolidação de **todos** os dependentes de `C_L` — incluindo o re-apontamento de `message_reactions.conversation_id`, ver D.1 passo 8b). **Não remove nenhuma linha de `conversations`.** | **[MERGE §4]** |
| `_merge_group_messages(...)` | §5 completo (colapso por `message_id`, reações por ator, `reply_to_message_id`, `last_prompt_message_id`). Remove as mensagens não-guardiãs de cada grupo de colapso — a única das cinco funções que remove linhas, porque §5.3 exige que a remoção de cada duplicata ocorra imediatamente após consolidar seus próprios dependentes, linha a linha, não como um passo em lote ao final de uma fase de grupo. | **[MERGE §5]** |
| `_merge_group_attributions(...)` | §6.1–§6.2 (re-apontamento de `lead_attributions.contact_id` — distinto do re-apontamento de `.conversation_id`, já feito por `_merge_group_conversations` no passo 8c de D.1), §6.3 (`first_attribution_id`/`first_source_channel`). **Não remove nenhuma linha.** | **[MERGE §6]** |
| `_merge_group_flow_runs(...)` | §7.1 (re-apontamento de `contact_id` em `automation_logs`, `automation_pending_executions`, `flow_runs` não-ativos — distinto do re-apontamento de `flow_runs.conversation_id`, já feito por `_merge_group_conversations` no passo 8d), §7.2 (colisão de ativos por `ORDEM_R`, transição para `'superseded_by_identity_merge'` com `ended_at`/`end_reason`). **Não remove nenhuma linha.** | **[MERGE §7]** |

A remoção de `C_L` (conversas perdedoras) e de `L` (contatos perdedores) **nunca é delegada a um helper** — é emitida diretamente pelo corpo de `merge_identity_group()`, nos passos 9 e 14 de D.1 respectivamente. Isso não é estilo: é o que garante que a condição "nenhuma linha remanescente referencia o que será removido" (§3.6, §4.5) seja verificada na mesma função e no mesmo escopo transacional que emite o `DELETE`, sem uma segunda chamada de função entre a verificação e a ação onde um novo re-apontamento poderia, em teoria, ainda não ter sido *commitado* dentro da mesma transação (não é um risco real dado que tudo roda na mesma transação — mas a regra elimina a necessidade de raciocinar sobre isso caso a caso).

Nenhuma das cinco funções recebe `GRANT EXECUTE` para `authenticated`/`anon`/`service_role` diretamente — apenas `merge_identity_group()` é chamável, e apenas por `service_role` (mesmo padrão de `dedupe_inbound_messages()` em `034`).

### C.4 Chamadores

1. **Backfill controlado** (Fase E) — chama `identity_merge_group_lock()` (B.6) implicitamente via `merge_identity_group()` (que a invoca como seu próprio passo 1), uma vez por grupo, dentro do seu próprio loop de batch.
2. **Caminho de escrita em tempo real** — em **ambos** os Estados 1 e 2 (A.4), chama `identity_merge_group_lock(account_id, phone_identity)` (B.6) como primeira instrução da sua transação, antes de checar existência/inserir o contato. A partir daí os dois estados divergem: no Estado 1, a transação segue e commita sem chamar `merge_identity_group()` (a trava apenas serializa a checagem+inserção contra outros escritores da mesma identidade — corrige a corrida descrita em A.4); no Estado 2, se a checagem sob a trava revelar `|grupo| ≥ 2`, chama `merge_identity_group()` de forma síncrona antes de prosseguir — como já está sob a mesma trava (adquirida no passo anterior desta própria transação), a chamada de `merge_identity_group()` reentra na trava (B.6, nota de reentrância) sem custo adicional e sem corrida possível entre os dois chamadores.

---

## Fase D — Fluxo Transacional

### D.1 Esqueleto de `merge_identity_group()`

**Correção de ambiguidade (CRÍTICO-2).** A versão anterior deste esqueleto comprimia a remoção de `C_L` (conversas perdedoras) dentro do passo "Message merge" e nunca mostrava explicitamente onde `C_L` é removida nem o re-apontamento de `message_reactions.conversation_id` (M13) — deixando a ordem de remoção ambígua. A versão abaixo expande os mesmos 13 passos em 15, sem reordenar nada que os ADRs já fixam, apenas tornando cada sub-passo de §3.6/§4.5/§6.2/§7 explícito e nomeando, para cada `DELETE`, exatamente quais passos anteriores precisam estar completos.

```sql
BEGIN;  -- implícito: corpo de função PL/pgSQL SECURITY DEFINER roda em uma
        -- transação já aberta pelo chamador, ou abre a sua se chamada via
        -- SELECT autônomo — ambos satisfazem [MERGE §9.2] desde que nenhum
        -- COMMIT intermediário ocorra dentro do corpo, o que este desenho
        -- garante por não conter nenhum.

  -- 1. Serialização do grupo via identity_merge_group_lock() (B.6) — evita
  --    que duas chamadas concorrentes (webhook + backfill, ou dois
  --    webhooks) processem o MESMO grupo simultaneamente. [HOTFIX — não há
  --    regra equivalente nos ADRs porque eles assumem execução serializada
  --    por construção; a concorrência é realidade operacional, não
  --    semântica.] Reentrante se o chamador (C.4.2) já a detém.
  PERFORM identity_merge_group_lock(p_account_id, p_phone_identity);

  -- 2. Recarrega o grupo sob o lock. [MERGE §2.5]
  --    Se |grupo| <= 1: retorna no-op (ver C.2).

  -- 3. Elege o sobrevivente por ORDEM_H. [MERGE §2.2]
  --    (contact locking: SELECT ... FOR UPDATE nas linhas do grupo,
  --    ordenado por id, para excluir qualquer escritor concorrente
  --    fora desta RPC durante o merge — nenhum outro caminho de
  --    código deve UPDATE/DELETE contacts fora desta função quando a
  --    flag Estado 2 está ativa; enquanto Estado 1, o backfill é o
  --    único escritor de merge, então o FOR UPDATE é defesa em
  --    profundidade, não a única barreira.)

  -- 4. Lock das conversas do grupo (FOR UPDATE), mesmo objetivo.

  -- 5. gera merge_run_id := gen_random_uuid()

  -- 6. _merge_group_contacts() — [MERGE §3.1–§3.3, SEM §3.6]:
  --    fill-gap de campos escalares; campos próprios (phone imutável);
  --    proveniência (INSERT identity_merge_provenance) — [MERGE §3.3].
  --    O restante de §3.4/§3.5 desta mesma função ocorre nos passos
  --    13a/13b (a ordenação interna é livre dentro de §3.4 — o ADR só
  --    exige que TUDO preceda a remoção de L no passo 14).
  --    NÃO remove nenhuma linha de contacts (C.3).

  -- 7. _merge_group_conversations() — [MERGE §4.1–§4.4, SEM §4.5-remoção]:
  --    re-apontamento de contact_id (parte de §3.4) seguido IMEDIATAMENTE
  --    da fusão de conversas colidentes — "uma única operação lógica
  --    indivisível" [MERGE §3.4]. Sobrevivente por ORDEM_H [MERGE §4.2],
  --    reconciliação de campos [MERGE §4.3], unread_count [MERGE §4.4].
  --    NÃO remove nenhuma linha de conversations (C.3).

  -- 8. _merge_group_conversations() (continuação) — consolidação dos
  --    dependentes de C_L, na ordem exigida por [MERGE §4.5], ANTES de
  --    qualquer remoção de conversa:
  --      8a. messages.conversation_id repontado para c_s        [§4.5.1]
  --      8b. message_reactions.conversation_id repontado p/ c_s [§4.5.2, M13]
  --          -- distinto do colapso de reactions por message_id, que só
  --          -- ocorre no passo 10 (mensagens já todas em c_s).
  --      8c. lead_attributions.conversation_id repontado p/ c_s [§4.5.3, M12]
  --          -- distinto do re-apontamento de .contact_id, que é o passo 11.
  --      8d. flow_runs.conversation_id repontado para c_s       [§4.5.4]

  -- 9. Remoção de C_L — [MERGE §4.5, "Somente após 1–4 [8a-8d], as
  --    conversas de C_L são removidas"]. Emitida DIRETAMENTE por
  --    merge_identity_group() (nunca por um helper — C.3), somente agora,
  --    com 7 e 8a-8d completos e nenhuma linha remanescente referenciando
  --    qualquer membro de C_L:
  --      DELETE FROM conversations WHERE id = ANY(losing_conversation_ids);
  --    (CASCADE de message_reactions/lead_attributions em conversations
  --    não dispara sobre dado vivo porque 8b/8c já re-apontaram tudo.)

  -- 10. _merge_group_messages() — [MERGE §5 completo]: colapso por
  --     message_id entre as mensagens agora todas em c_s [§5.2]; reações
  --     por ator [§5.3–§5.4]; repointa reply_to_message_id e
  --     last_prompt_message_id [§5.3, M14]. Remove as mensagens
  --     não-guardiãs linha a linha, dentro desta mesma função — é a única
  --     das cinco funções de C.3 que remove dado, porque §5.3 exige a
  --     consolidação de dependentes imediatamente antes de CADA remoção
  --     individual, não como um lote ao fim de uma fase de grupo.

  -- 11. _merge_group_attributions() — [MERGE §6.1–§6.2]: re-aponta
  --     lead_attributions.contact_id (distinto de .conversation_id, já
  --     feito no passo 8c) ANTES de qualquer remoção de contacts [§6.2];
  --     calcula first_attribution_id/first_source_channel [§6.3].
  --     NÃO remove nenhuma linha.

  -- 12. _merge_group_flow_runs() — [MERGE §7]: re-aponta contact_id em
  --     automation_logs, automation_pending_executions, flow_runs
  --     não-ativos [§7.1] (distinto do re-apontamento de
  --     flow_runs.conversation_id, já feito no passo 8d); resolve colisão
  --     de flow_runs ativos por ORDEM_R, transiciona não-sobreviventes
  --     para 'superseded_by_identity_merge' com ended_at := (o NOW()
  --     transacional desta chamada) e end_reason com o merge_run_id e o
  --     id do run sobrevivente [§7.2, B.5]. NÃO remove nenhuma linha.

  -- 13. Restante das tabelas dependentes de contacts, ambas as metades
  --     dentro de _merge_group_contacts() (ou função dedicada
  --     equivalente) — nenhuma remove contacts:
  --
  --      13a. Re-apontamento integral, sem colisão possível — [MERGE §3.4]:
  --             UPDATE contact_notes        SET contact_id = s WHERE contact_id = ANY(L);
  --             UPDATE deals                SET contact_id = s WHERE contact_id = ANY(L);
  --             UPDATE broadcast_recipients SET contact_id = s WHERE contact_id = ANY(L);
  --           Estas são as três tabelas de §3.4 que nenhum outro passo
  --           alcança (conversations = passo 7; lead_attributions =
  --           passo 11; automation_logs / automation_pending_executions /
  --           flow_runs = passo 12). Nenhuma possui constraint de
  --           unicidade envolvendo contact_id, logo o re-apontamento é
  --           integral e livre de conflito [MERGE §3.4].
  --           OBRIGATÓRIO, não otimização: broadcast_recipients.contact_id
  --           é NOT NULL sem anulação em cascata (001) — omitir este
  --           passo faz o DELETE do passo 14 falhar por integridade
  --           referencial [MERGE §3.4, observação vinculante]. Para
  --           contact_notes e deals, omiti-lo romperia o vínculo exigido
  --           por [MERGE §8.2] e violaria I2 (§10).
  --
  --      13b. Tabelas com colisão de unicidade por contato — [MERGE §3.5]:
  --             contact_tags (UNIQUE(contact_id, tag_id)),
  --             contact_custom_values (UNIQUE(contact_id, custom_field_id)).
  --           União por chave, uma linha por tag/campo, pela regra de
  --           §3.5 — o colapso das linhas excedentes é permitido por
  --           §8.3 (mesma associação lógica), e não toca contacts.

  -- 14. Remoção de L (contatos perdedores) — [MERGE §3.6: "Somente após
  --     §3.1–§3.5, §4, §5, §6 e §7 terem sido integralmente aplicados"].
  --     Emitida DIRETAMENTE por merge_identity_group() (nunca por um
  --     helper — C.3), somente agora, com 6-13 completos e nenhuma linha
  --     remanescente referenciando qualquer membro de L:
  --       DELETE FROM contacts WHERE id = ANY(loser_contact_ids);
  --     (CASCADE em conversations/message_reactions/lead_attributions
  --     não dispara sobre dado vivo — conversations já foi tratada no
  --     passo 9, e o que restava referenciando contacts foi re-apontado
  --     nos passos 6-13.)

  -- 15. Monta e retorna o JSONB de resumo (C.2).

COMMIT;  -- implícito — nenhum ponto de falha parcial observável entre 1 e 15
```

A numeração 6→14 **é** a ordem normativa dos próprios ADRs (§3.6, §4.5, §6.2 exigem exatamente essa precedência para que nenhum `ON DELETE CASCADE`/`SET NULL` atinja dado vivo); este HOTFIX não está escolhendo uma ordem, está transcrevendo — agora sem ambiguidade sobre onde cada `DELETE` ocorre — a única ordem que os ADRs permitem para uma função PL/pgSQL de passo único. Em particular: `C_L` é removida no passo 9, **antes** do colapso de mensagens por `message_id` (passo 10) — porque §4.5 não exige que o colapso de conteúdo (§5) já tenha ocorrido para remover a conversa perdedora, apenas que seus dependentes diretos (8a-8d) já tenham sido re-apontados; `L` é removida por último (passo 14), depois de literalmente tudo o mais.

**Cobertura completa das oito tabelas de `[MERGE §3.4]`** — verificação de correspondência 1:1 entre a lista fechada do ADR e os passos acima, para que nenhuma volte a ficar sem caminho de execução:

| Tabela de `[MERGE §3.4]` | Passo de D.1 |
|---|---|
| `conversations` | 7 (re-aponta `contact_id` + funde) |
| `contact_notes` | 13a |
| `deals` | 13a |
| `broadcast_recipients` | 13a |
| `automation_logs` | 12 |
| `automation_pending_executions` | 12 |
| `lead_attributions` | 8c (`conversation_id`) + 11 (`contact_id`) |
| `flow_runs` | 8d (`conversation_id`) + 12 (`contact_id`) |

As duas tabelas de `[MERGE §3.5]` (`contact_tags`, `contact_custom_values`) são cobertas pelo passo 13b. Toda tabela que referencia `contacts` segundo os ADRs tem, portanto, exatamente um passo responsável, e todos precedem o passo 14.

### D.2 Por que o *advisory lock* não é uma decisão semântica

`ADR-CONTACT-MERGE-001` §9.3 prova independência de ordem **assumindo** que operações sobre grupos disjuntos não se sobrepõem no tempo. Isso é verdade para grupos *diferentes* (disjuntos por partição, §2.5) — mas duas chamadas simultâneas para o **mesmo** grupo (ex.: dois webhooks quase simultâneos do mesmo novo contato duplicado) não são "grupos diferentes", são a mesma transação lógica disputada por dois processos. O *advisory lock* de D.1 (via `identity_merge_group_lock()`, B.6) serializa exatamente esse caso — é infraestrutura de concorrência, não uma regra sobre quem sobrevive (essa continua sendo, sempre, `ORDEM_H`/`ORDEM_R`, decidida depois que o lock é obtido e o grupo é relido). A mesma função é usada pelo caminho de escrita em tempo real (C.4.2) para que a chave de trava nunca divirja entre os dois chamadores.

---

## Fase E — Backfill

### E.1 Unidade de trabalho

Um **grupo de merge ativo** (`(account_id, phone_identity)` com ≥2 contatos) é a unidade atômica de backfill — nunca uma linha, nunca uma conta inteira. Isso mantém cada chamada de `merge_identity_group()` pequena e independentemente reexecutável.

### E.2 Checkpoint

```sql
-- 071_identity_merge_backfill_checkpoint.sql
CREATE TABLE IF NOT EXISTS identity_merge_backfill_checkpoint (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_identity  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  merge_run_id    UUID,               -- preenchido quando status = 'done'
  claimed_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, phone_identity)
);

CREATE INDEX IF NOT EXISTS idx_identity_merge_checkpoint_pending
  ON identity_merge_backfill_checkpoint (account_id, status)
  WHERE status IN ('pending', 'failed');
```

### E.3 Algoritmo do runner (`scripts/backfill-identity-merge.mjs`)

1. **Descoberta (uma vez por conta, no início do backfill daquela conta):**
   ```sql
   INSERT INTO identity_merge_backfill_checkpoint (account_id, phone_identity)
   SELECT account_id, phone_identity
   FROM contacts
   WHERE account_id = $1 AND phone_identity <> ''
   GROUP BY account_id, phone_identity
   HAVING count(*) > 1
   ON CONFLICT (account_id, phone_identity) DO NOTHING;
   ```
2. **Reclamação de *leases* expirados (ALTO-1 — parte do algoritmo operacional, não apenas dos testes de G.4.5).** Antes de cada claim de batch, o runner primeiro devolve ao pool qualquer grupo preso em `'in_progress'` além de um limiar configurável `LEASE_TIMEOUT_SECONDS` (default 300s — deve exceder confortavelmente o teto de duração de um merge normal, ver E.3.4 sobre timeout dinâmico):
   ```sql
   UPDATE identity_merge_backfill_checkpoint
   SET status = 'pending', claimed_at = NULL
   WHERE status = 'in_progress'
     AND claimed_at < NOW() - (interval '1 second' * $LEASE_TIMEOUT_SECONDS);
   ```
   Isso cobre tanto a morte do processo do runner (`kill -9`, crash) quanto uma chamada de `merge_identity_group()` que ficou presa além do esperado sem que a própria conexão tenha caído — sem essa reclamação, um `'in_progress'` órfão fica invisível a qualquer claim futuro (a claim query do passo 3 só considera `'pending'`/`'failed'`) e o grupo nunca é reprocessado nem sinalizado.
3. **Claim de batch** (tamanho configurável, default 50 grupos): `UPDATE ... SET status='in_progress', claimed_at=NOW() WHERE id IN (SELECT id FROM identity_merge_backfill_checkpoint WHERE account_id=$1 AND status IN ('pending','failed') AND attempts < 5 AND updated_at < NOW() - backoff_delay(attempts) ORDER BY updated_at ASC LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`. `FOR UPDATE SKIP LOCKED` torna seguro rodar múltiplos workers em paralelo sobre a mesma conta sem coordenação externa. `backoff_delay(attempts)` é *exponential backoff* com teto (endurecimento BAIXO): `LEAST(2^attempts * 10s, 300s)` — um grupo que acabou de falhar não é reclamado imediatamente pelo próximo ciclo do mesmo worker (ou de outro), dando tempo para causas transitórias (contenção de lock, timeout de rede) se dissiparem.
4. **Para cada grupo do batch**, o runner primeiro dimensiona o grupo (consulta de baixo custo — contagem de mensagens/conversas dos contatos candidatos) e deriva um `statement_timeout` **por chamada**, não um valor fixo global (correção ALTO-3, ver E.3.5), então chama `merge_identity_group(account_id, phone_identity)` sob esse timeout:
   - sucesso → `status='done'`, grava `merge_run_id`, `updated_at=NOW()`;
   - erro → `status='failed'`, `attempts += 1`, `last_error` gravado; grupo elegível para retry (respeitando o backoff do passo 3) até `attempts < 5`, depois fica preso em `'failed'` para triagem manual (nunca deletado — o checkpoint em si é auditoria de backfill).
5. **Timeout configurável por tamanho de grupo (ALTO-3 — substitui o valor fixo de 30s da versão anterior).** Um timeout fixo global tem duas falhas: é curto demais para grupos genuinamente grandes (histórico de anos de conversa) e longo demais como piso para grupos triviais, atrasando a detecção de um problema real. Em vez disso:
   - `statement_timeout` por chamada = `LEAST(GREATEST(base_timeout, coef * estimated_row_count), hard_ceiling)`, com `base_timeout` (ex. 5s), `coef` (ex. 2ms por linha estimada — mensagens + reações + conversas do grupo) e `hard_ceiling` (ex. 120s) configuráveis por variável de ambiente do runner, nunca hardcoded na RPC (a RPC em si não define `statement_timeout` — quem chama define via `SET LOCAL statement_timeout` na mesma transação antes de invocar `merge_identity_group()`).
   - **Grupos acima do `hard_ceiling` estimado** não são forçados a caber em uma transação mais longa nem, inversamente, divididos em múltiplas transações — dividir violaria a atomicidade de **[MERGE §9.2]** diretamente. Em vez disso, o runner marca o grupo com um `last_error` distinto (`'exceeds_single_transaction_ceiling'`, sem incrementar `attempts` da forma usual) e o exclui do backfill de rotina, sinalizando-o para uma **janela de manutenção agendada** onde um operador roda o mesmo `merge_identity_group()`, para aquele grupo específico, com um `hard_ceiling` maior aceito explicitamente (mesma RPC, mesma transação única — apenas um teto de tempo maior, autorizado manualmente, nunca quebrado em passos).
6. **Resume**: como o progresso vive inteiramente em `identity_merge_backfill_checkpoint` (não em memória do processo), matar e reiniciar o runner a qualquer momento retoma exatamente de onde parou — nenhum grupo `'done'` é reprocessado; grupos `'in_progress'` órfãos são recuperados pelo passo 2 antes do próximo claim; nenhum `'pending'`/`'failed'` é perdido.
7. **Conclusão por conta**: quando não resta nenhuma linha `'pending'`/`'failed'` com `attempts < 5` para a conta (e nenhum grupo pendente de janela de manutenção do passo 5), o runner reporta a contagem de `'failed'` remanescentes (deve ser 0 no caminho feliz) — esse é o sinal para F.5 (promoção a índice `UNIQUE`).

### E.4 Retry e *poison groups*

Um grupo que falha 5 vezes (por erro, não por exceder o teto de tamanho do passo E.3.5, que tem seu próprio caminho) é um sinal de dado real fora do previsto pelos ADRs (não deveria acontecer, já que `ADR-CONTACT-MERGE-001` §13 afirma não haver decisão dependente de código) — tratado como incidente de triagem manual, não como bug de retry. O runner nunca aumenta `attempts` além de 5 automaticamente; um operador precisa resetar `status='pending', attempts=0` explicitamente após investigar. O *backoff* exponencial do passo E.3.3 evita que essas 5 tentativas se esgotem em segundos contra a mesma causa transitória, sem exigir intervenção humana para falhas passageiras.

---

## Fase F — Rollout

### F.1 Mecanismo de *feature flag*

Reaproveita o mecanismo de flags já existente no projeto (por conta) — este HOTFIX não introduz um novo sistema de flags, apenas a flag `identity_merge_v2_enabled` descrita em A.4, com os dois sub-estados (identidade v2 para leitura/escrita vs. merge automático) codificados como dois campos ou dois valores do mesmo registro de flag, não duas flags independentes — para impedir exatamente a combinação "flag por caminho" que DeepSeek I2 / Nemotron I-1 / Ling 3/11 marcaram como bloqueante nas revisões originais (matéria hoje corretamente deferida a este HOTFIX por `ADR-CONTACT-MERGE-001` §12.5).

### F.2 Pré-requisito de canário

Antes de ativar a flag para qualquer conta real, rodar a suíte completa de Fase G (incluindo os 15 cenários de **[MERGE §11.1]**) contra um ambiente com um *snapshot* anonimizado de dados de produção — não apenas fixtures sintéticas — para expor formatos de `phone` reais que os ADRs não previram (isso não é reabrir a especificação: se um formato real cair em `NonBR`, o comportamento correto já está definido — permanece `NonBR`, **[IDENT §9]** — o objetivo do teste é confirmar que a implementação obedece, não decidir o que ela deveria fazer).

### F.3 Canário

1. Uma conta interna (ambiente de staging da equipe, não cliente) primeiro.
2. Uma conta cliente de baixo volume, com consentimento/aviso operacional prévio.
3. Critério de promoção do canário: backfill daquela conta chega a zero `'failed'` (E.3.7), todas as métricas de F.4 dentro do esperado por 48h de operação em Estado 2, e nenhuma divergência encontrada em auditoria manual de uma amostra dos grupos fundidos (comparar `identity_merge_provenance` com o estado real).

### F.4 Monitoramento e métricas

Emitidas por `merge_identity_group()` (via o `JSONB` de retorno, logado pelo chamador) e pelo runner de backfill:

| Métrica | Uso |
|---|---|
| `merges_total` / `merges_failed_total` | Volume e taxa de erro por conta |
| `conversations_merged_total`, `messages_collapsed_total`, `reactions_collapsed_total` | Confere ordem de grandeza esperada (nenhum pico anômalo de colapso) |
| `flow_runs_superseded_total` | Sinaliza se runs ativos de cliente estão sendo interrompidos por merge com frequência incomum — merece revisão de produto, não é um bug técnico |
| Duração de `merge_identity_group()` (p50/p95/p99), por faixa de tamanho estimado de grupo | Calibra os coeficientes do timeout dinâmico (E.3.5) e detecta grupos se aproximando do `hard_ceiling` antes de estourá-lo |
| Contagem de grupos marcados `'exceeds_single_transaction_ceiling'` (E.3.5) | Fila de trabalho para a próxima janela de manutenção — não deve crescer sem ação |
| `identity_merge_backfill_checkpoint` por `status` | Progresso do backfill em tempo real, por conta |
| **A3/A5 de [MERGE §11]** como *job* periódico de auditoria pós-merge | Recalcula as seis métricas de §8.5 e `COUNT(lead_attributions)` sobre contas já migradas; alerta se divergirem — é a verificação contínua de que a implementação **continua** obedecendo à semântica, não uma reavaliação da semântica |

### F.5 Promoção ao índice `UNIQUE`

Depois que uma conta conclui o backfill (E.3.7) e opera em Estado 2 sem `'failed'` por um período de observação (mesmo critério de F.3.3), o índice de B.3 é promovido a `UNIQUE`.

**Procedimento correto (ALTO-2, parte 2 — corrige a versão anterior, que não especificava o mecanismo e correria o risco de um `CREATE UNIQUE INDEX` simples, que toma um lock que bloqueia escritas em `contacts` pela duração da construção do índice).** Executado como script operacional fora da lista de migrations de A.1 (assim como já indicado ali), porque `CONCURRENTLY` não pode rodar dentro do bloco transacional padrão de uma migration:

```sql
-- 1. Constrói o índice único SEM bloquear escritores — permite falhas
--    de linhas conflitantes sem abortar o índice inteiro de imediato;
--    se falhar (ainda existir duplicata — não deveria, dado o critério
--    de entrada acima, mas o CONCURRENTLY é a rede de segurança), o
--    índice fica INVALID e é dropado e re-tentado, sem nunca ter
--    bloqueado uma escrita sequer.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_phone_identity_uniq
  ON contacts (account_id, phone_identity)
  WHERE phone_identity <> '';

-- 2. Confirma validade antes de prosseguir (consulta de verificação,
--    não uma instrução DDL): SELECT indisvalid FROM pg_index WHERE
--    indexrelid = 'idx_contacts_phone_identity_uniq'::regclass;
--    Se indisvalid = true, o índice está corrompido/incompleto — DROP
--    e reinício do procedimento, nunca promoção ao passo 3.

-- 3. Substitui o índice não-único de B.3 pelo único, também sem lock
--    exclusivo prolongado (DROP CONCURRENTLY libera o antigo antes de
--    qualquer leitor precisar dele novamente, já que o novo já está
--    ativo desde o passo 1):
DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_phone_identity;
ALTER INDEX idx_contacts_phone_identity_uniq RENAME TO idx_contacts_phone_identity;
```

Executado por conta (ou em lote, se o critério de entrada for satisfeito por várias contas ao mesmo tempo) — nunca uma única promoção global, para que uma conta ainda em backfill não bloqueie a promoção de outra já pronta. A partir da promoção bem-sucedida, o próprio Postgres garante **[MERGE I1]** ("não existem dois contatos na mesma conta com o mesmo `identity(phone)` não-vazio") como constraint física para aquela conta, não apenas como invariante verificada por auditoria.

### F.6 Abort

Abortar o rollout de uma conta específica = desligar `identity_merge_v2_enabled` para ela (A.4, Estado 2 → Estado 0). Isso interrompe **novos** merges automáticos e o backfill daquela conta imediatamente (o runner do E.3 checa a flag a cada claim de batch); não desfaz merges já commitados (A.3). Nenhum "abort global" apaga a tabela de proveniência ou o checkpoint — ambos são histórico permanente, mesmo após decisão de abortar.

---

## Fase G — Testes

### G.1 *Property-based* — paridade de identidade

- Fixture única (Anexo B de `ADR-IDENTITY-BR-001` + expansão por *property-based testing* sobre `identity_br_valid_ddd`) consumida por um teste que roda `canonical_br()` (SQL, via PGlite ou banco real) e `canonicalBr()` (TypeScript) sobre as mesmas entradas e compara resultado byte a byte — critério de aceite §10.3/§10.4 do IDENT, tornado executável.
- Teste de paridade separado para `identity_br_valid_ddd` vs. a constante TS vs. `docs/reference/anatel-ddd.json` (Anexo A.1.1).

### G.2 Integração — cenários de merge

Os 15 cenários de **[MERGE §11.1]** são o piso mínimo, cada um implementado como um teste de integração contra Postgres real (PGlite, mesmo padrão de `034`/`035`), verificando após `merge_identity_group()`:

- I1–I8 de **[MERGE §10]** diretamente (queries de verificação já especificadas na coluna "Verificação" daquela tabela);
- A1–A11 de **[MERGE §11]**, incluindo A6 (proveniência) contra `identity_merge_provenance`, A7 (`ended_at`/`created_at` — B.5) e A8 (estado terminal distinguível) contra `flow_runs.status = 'superseded_by_identity_merge'`.

**Correção (MÉDIO) — cobertura concreta de A1, A2 e A10.** As três eram citadas apenas por referência na versão anterior; como testam propriedades *entre execuções* (não apenas o estado pós-merge de uma única chamada), cada uma exige um desenho de teste próprio, fixado aqui:

- **A1 (idempotência, `M(M(x)) = M(x)`):** para cada um dos 15 cenários e para cada fixture gerado pela suíte *property-based* (G.1), o teste salva o dump completo após a primeira chamada de `merge_identity_group()`, chama a RPC uma segunda vez sobre o mesmo `(account_id, phone_identity)` (agora um grupo unitário), e compara o dump — deve retornar o no-op de C.2 (`loser_contact_ids: []`) e o dump deve ser byte-a-byte idêntico ao da primeira execução.
- **A2 (independência de ordem):** a mesma suíte de fixtures é executada três vezes sobre o mesmo estado inicial, variando apenas a ordem de processamento dos grupos — ordem de descoberta (E.3.1), ordem inversa, e ordem aleatória com múltiplos workers concorrentes reais disputando `FOR UPDATE SKIP LOCKED` (E.3.3) — e os três dumps finais são comparados entre si.
- **A10 (duas implementações independentes produzem o mesmo dump):** como este HOTFIX não constrói duas RPCs de produção, a segunda implementação é um verificador **fora do caminho de produção**, `scripts/verify-merge-dump.ts`, que recalcula o estado esperado pós-merge diretamente a partir da especificação de `ADR-CONTACT-MERGE-001` (sobrevivente por `ORDEM_H`/`ORDEM_R`, fill-gap, reconciliação de `unread_count`/`first_attribution_id`, etc.) sobre um dump **pré-merge**, sem chamar `merge_identity_group()` nem qualquer função SQL deste HOTFIX. O CI executa esse verificador sobre cada um dos 15 cenários e sobre os fixtures de G.1, e compara sua saída com o dump real produzido pela RPC — qualquer divergência é falha de build. Isto satisfaz o critério A10 sem exigir uma segunda RPC de produção mantida em paralelo (o que criaria, por si, um risco de divergência operacional que os ADRs não previram).

### G.3 Fixtures

Fixtures de banco (não apenas de função pura) para os 15 cenários — contatos, conversas, mensagens, reações, atribuições e flow_runs pré-populados reproduzindo cada cenário, versionados junto ao teste (mesmo diretório dos testes de `034`/`035`).

### G.4 Concorrência e *race conditions*

Cenários adicionais, específicos deste HOTFIX (não estão nos 15 de MERGE porque concorrência é matéria de implementação, não de semântica):

1. **Duas chamadas simultâneas ao mesmo grupo** (dois workers de backfill, ou webhook + backfill) — verifica que o *advisory lock* (D.1/D.2) serializa e a segunda chamada observa um grupo já unitário (no-op de C.2), nunca um erro nem um merge duplicado.
2. **Novo contato duplicado inserido durante o backfill de uma conta** — verifica que a descoberta de E.3.1, reexecutada, encontra o novo grupo, e que o `INSERT ... ON CONFLICT DO NOTHING` não perde o registro de checkpoint.
3. **Webhook concorrente durante um merge em andamento (Estado 2)** — uma mensagem inbound chega para um dos perdedores exatamente durante a janela entre o lock (D.1 passo 1) e o commit; verifica que o webhook, ao tentar escrever, também precisa do mesmo *advisory lock* antes de decidir "contato existe?" (ou aguarda o lock, ou — se implementado como tentativa não-bloqueante — falha de forma segura e reentra via retry do provedor, nunca escreve em uma linha de contato que está prestes a ser removida).
4. **Falha no meio de `merge_identity_group()`** (ex.: o `statement_timeout` dinâmico de E.3.5 disparando) — verifica que a transação inteira reverte (nenhum passo de 6–14 do esqueleto D.1 fica parcialmente aplicado) e que o checkpoint correspondente é marcado `'failed'` para retry, nunca `'done'` parcial.
5. **`kill -9` do runner de backfill entre duas chamadas de RPC** — verifica resume (E.3.6) e, especificamente, o mecanismo de *lease timeout* que agora é parte do algoritmo operacional (E.3.2), não apenas deste teste: grupos já `'done'` não são retocados; o grupo que estava `'in_progress'` no momento da morte permanece assim até `identity_merge_backfill_checkpoint.claimed_at` ultrapassar `LEASE_TIMEOUT_SECONDS`, quando a query de E.3.2 o devolve a `'pending'` — o teste avança um relógio simulado (ou usa um `LEASE_TIMEOUT_SECONDS` reduzido no ambiente de teste) e confirma que o grupo é reclamado e reprocessado com sucesso, sem intervenção manual.
6. **Backoff em ação (E.3.3)** — um grupo falha propositalmente (fixture que viola uma pré-condição de infraestrutura, não de semântica — ex. conexão simulada indisponível) e o teste confirma que o próximo claim não o reclama antes do intervalo de `backoff_delay(attempts)`, e que `attempts` para de crescer em `5` (E.4).

---

## Gate — a pergunta muda

Até `ADR-IDENTITY-BR-001` e `ADR-CONTACT-MERGE-001`, o Gate Arquitetural perguntava: **"a semântica está correta?"** — e essa pergunta está **fechada**, congelada em ambos os documentos (§14 de cada um).

A partir deste HOTFIX, o Gate de Implementação pergunta algo estruturalmente diferente: **"esta implementação executa exatamente a semântica congelada?"** — uma pergunta sobre fidelidade de tradução (Fases B–D), sobre operação segura em escala e ao longo do tempo (Fases A, E), sobre segurança de exposição gradual (Fase F), e sobre cobertura verificável (Fase G). Nenhuma resposta a essa segunda pergunta pode legitimamente alterar a resposta à primeira. Se, durante a implementação, uma decisão de merge ou de identidade parecer "inadequada" na prática, o caminho correto é abrir uma nova revisão do ADR correspondente pelo mecanismo de reabertura que ele mesmo define (`ADR-IDENTITY-BR-001` §14, `ADR-CONTACT-MERGE-001` §14) — nunca ajustar o comportamento silenciosamente neste documento ou no código que o implementa.

## Autovalidação

- **Este documento decide alguma questão de identidade ou de sobrevivência em merge?** Não — toda decisão de "o que" é citada com **[IDENT §x]**/**[MERGE §x]**; toda decisão original deste documento é rotulada **[HOTFIX]** e versa exclusivamente sobre sequenciamento, materialização física, concorrência, operação e verificação.
- **Alguma Fase depende de uma Fase posterior (dependência circular)?** Não: A depende apenas dos ADRs; B depende de A (nomes/ordem); C depende de B (schema); D depende de C (assinatura); E depende de D (RPC pronta); F depende de E (backfill pronto); G testa A–F, sem alimentar nenhuma decisão de volta às Fases anteriores além de falhas de implementação (nunca falhas de semântica, que não são deste documento para corrigir).
- **Existe algum passo do fluxo transacional (Fase D) que reordene o que os ADRs já fixaram?** Não — D.1 numera 6→14 na mesma ordem que `ADR-CONTACT-MERGE-001` §3.6/§4.5/§6.2/§9.2 exige (agora com a remoção de `C_L` e `L` como passos explícitos e separados, corrigindo a ambiguidade apontada no Gate); a única adição é o *advisory lock* (passo 1), que é concorrência, matéria ausente da modelagem dos ADRs por não ser semântica.
- **O rollback é honesto sobre o que é e não é reversível?** Sim — A.3 declara explicitamente que merges commitados não são desfeitos pela aplicação, e por quê (a alternativa violaria I4/I7 na direção oposta), em vez de prometer um "undo" que os invariantes dos ADRs tornam impossível.
- **Os 15 cenários mínimos de `ADR-CONTACT-MERGE-001` §11.1 estão cobertos?** Sim, listados integralmente em G.2 por referência direta, sem reformulação.
- **Esta revisão pós-Gate alterou alguma decisão de `ADR-IDENTITY-BR-001` ou `ADR-CONTACT-MERGE-001`?** Não. Toda alteração do changelog abaixo é rotulada **[HOTFIX]** por construção — nenhuma toca em quem sobrevive a um merge, o que é identidade, o que pode ou não desaparecer, ou qualquer invariante de §8/§10 de MERGE ou §6/§8/§9 de IDENT. Onde uma correção tocou um trecho que citava um ADR (ex. D.1, C.3), a mudança foi na exposição/ordenação da citação, nunca no conteúdo citado.

## Changelog — Revisão Pós-Gate

| Alteração | Localização | Achado do Gate resolvido |
|---|---|---|
| `identity_br_valid_ddd` reclassificada como espelho/auditoria; `canonical_br()` passa a usar array literal embutido, nunca subquery em runtime | B.1, B.2 | **CRÍTICO-1** |
| Procedimento de re-canonicalização operacionalizado (regeneração dos 3 artefatos + reavaliação forçada da coluna gerada + reabertura de descoberta de grupos) | Nova A.6 | **CRÍTICO-1** (Anexo A.1.4) |
| Tabela de helpers reescrita: `_merge_group_contacts`/`_merge_group_conversations` explicitamente não removem linhas; remoção de `C_L`/`L` só ocorre em `merge_identity_group()` | C.3 | **CRÍTICO-2** |
| Esqueleto D.1 expandido de 13 para 15 passos: passo 8 (8a-8d) consolida dependentes de `C_L` incluindo `message_reactions.conversation_id`; passo 9 remove `C_L`; passo 14 remove `L`, cada um com pré-condição explícita | D.1 | **CRÍTICO-2** |
| Reclamação de *lease* expirado incorporada como passo 2 do algoritmo do runner (antes só existia como teste) | E.3.2 | **ALTO-1** |
| Estratégia de rewrite para `ADD COLUMN ... GENERATED STORED` (medição prévia, `lock_timeout`, limiar tabela grande/pequena, janela de manutenção) | B.3 | **ALTO-2** |
| Promoção do índice a `UNIQUE` reescrita para `CREATE UNIQUE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY` / rename, por conta | F.5 | **ALTO-2** |
| Timeout fixo (30s) substituído por `statement_timeout` dinâmico por tamanho estimado de grupo, com teto rígido e desvio para janela de manutenção acima do teto (nunca divisão de transação) | E.3.4–E.3.5 | **ALTO-3** |
| `ended_at` explicitamente exigido junto com `end_reason` na transição de `flow_runs` | B.5, D.1 passo 12 | MÉDIO |
| `identity_merge_group_lock()` promovida de comentário a função real, usada por RPC e aplicação | B.6 | MÉDIO |
| Caminho de escrita em tempo real passa a adquirir a trava também no Estado 1 (não só no Estado 2), corrigindo a corrida que o próprio Estado 1 existia para evitar | A.4, C.4 | MÉDIO ("corrida Estado 1") |
| Cobertura concreta de A1 (reexecução), A2 (permutação de ordem) e A10 (verificador TS independente fora do caminho de produção) | G.2 | MÉDIO |
| `SET search_path = public` explicitado para todos os helpers de C.3 | C.3 | BAIXO |
| *Backoff* exponencial com teto incorporado ao claim de batch e à narrativa de retry | E.3.3, E.4 | BAIXO |
| Índice `(account_id, merged_at)` adicionado a `identity_merge_provenance` | B.4 | BAIXO |
| Cenário de teste de *backoff* adicionado à suíte de concorrência | G.4.6 | BAIXO (decorrente) |

### Rodada 2 — Gate Final

| Alteração | Localização | Achado do Gate resolvido |
|---|---|---|
| `contact_notes`, `deals` e `broadcast_recipients` re-apontados em um passo explícito (13a), com a justificativa de obrigatoriedade de `broadcast_recipients` (`NOT NULL` sem anulação); §3.5 separado em 13b; passo 6 reescopado para §3.1–§3.3 para eliminar a sobreposição | D.1 passos 6, 13a, 13b; C.3 (linha de `_merge_group_contacts`) | **CRÍTICO-3** |
| Tabela de correspondência 1:1 entre as oito tabelas de `[MERGE §3.4]` e os passos de D.1 responsáveis por cada uma | D.1 (após o bloco de código) | **CRÍTICO-3** (verificabilidade) |
| Passo de demoção/repromoção do índice `UNIQUE` incorporado à re-canonicalização, com a ordem obrigatória e a natureza global do objeto de índice explicitadas | A.6 passo 3 (itens 3.1–3.3), renumerando os antigos 3–5 para 4–6 | **ALTO-4** |
| Descrição da flag corrigida de "única flag booleana" para "registro único com dois sub-estados", alinhando A.4 ao mecanismo real já descrito em F.1 | A.4 (parágrafo de abertura) | **MÉDIO** (inconsistência A.4 × F.1) |

**Confirmação final:** nenhuma correção acima alterou, reinterpretou, ajustou ou "esclareceu" qualquer decisão de `ADR-IDENTITY-BR-001` ou `ADR-CONTACT-MERGE-001`. Toda mudança é rotulada **[HOTFIX]** e permanece dentro do espaço de sequenciamento, DDL, RPCs, fluxo transacional, backfill, rollout e testes que os dois ADRs deixam explicitamente para este documento decidir. Nenhuma fase foi renumerada, nenhum contrato público (`merge_identity_group(p_account_id, p_phone_identity) RETURNS JSONB`) mudou de assinatura, e a estrutura geral (Fases A–G + Gate + Autovalidação) permanece a mesma da versão anterior.
