# ADR-IDENTITY-BR-001 — Identidade Canônica de Telefone (Brasil)

| | |
|---|---|
| **Tipo** | ADR fundacional — precede e é pré-requisito de `ADR-CONTACT-MERGE-001` e da reescrita de `HOTFIX-001` |
| **Status** | **Congelado** — aprovado no Gate Arquitetural de refinamento em 2026-08-01. Ver cláusula de congelamento em §14. |
| **Histórico** | v1: consolidação inicial das três revisões independentes (§1) e definição de `canonical_br`. v2 (esta revisão): endereça 5 objeções de refinamento — evidência para exclusão do tronco 0 (§6.4), governança de `VALID_DDD` (Anexo A), coexistência formal `canonical_br`/`NonBR` (§6.6), idempotência e estabilidade temporal como propriedades formais (§8.1), reclassificação de indexabilidade como requisito derivado, não propriedade de identidade (§8.2). Nenhuma decisão de v1 foi revertida; três foram aprofundadas e uma (trunk 0) foi reexaminada e mantida por ausência de evidência, não por inércia. |
| **Origem** | Revisão independente de HOTFIX-001 por três modelos (DeepSeek, Nemotron, Ling); consolidação em §1 |
| **Autoridade** | Decide **exclusivamente**: o que é identidade de telefone, a relação de equivalência que a define, suas propriedades formais, os casos ambíguos e o comportamento fail-safe. **Não decide**: regra de sobrevivente em merge, algoritmo de fusão de contato/conversa/mensagem, DDL, nome de coluna/índice, RPC, rollout, backfill. Essas decisões pertencem a `ADR-CONTACT-MERGE-001` e à reescrita de `HOTFIX-001`, que devem referenciar este documento e não duplicá-lo. |
| **Baseline de código auditado** | `phone-utils.ts` (`normalizePhone`, `phonesMatch`, `phonesMatchStrict`, `phoneVariants`, `sendWithPhoneVariantRetry`); `dedupe.ts` (`findExistingContact`, `normalizeKey`, `isExactMatch`); migrações `022` (`phone_normalized`, `merge_duplicate_contacts()`), `029` (índice trigram em `phone_normalized`), `033` (`lead_attributions`, `first_attribution_id`, `attribution_id`), `034`/`035` (idempotência de inbound) |
| **Escopo de produção** | Somente documentação. Nenhuma linha de código, schema ou migration é produzida por este documento. |

---

## 1. Consolidação das três revisões (Fase 1)

As três revisões (DeepSeek, Nemotron, Ling) convergem, com vocabulário diferente, sobre o mesmo pequeno conjunto de decisões arquiteturais em aberto. Agrupadas (sem repetição de achados equivalentes):

| # | Decisão arquitetural única | Levantada por |
|---|---|---|
| D1 | A forma canônica de identidade BR não estava travada — apenas propriedades desejadas foram declaradas, o que admite ≥3 algoritmos distintos e igualmente conformes | DeepSeek B4, Nemotron B-3, Ling bloqueante-1 |
| D2 | O predicado único (invariante "SQL = JS") é incompatível com manter `phone_normalized` (dígitos exatos) como único artefato de storage — a classe de equivalência BR não é expressável nessa coluna | DeepSeek B2/I7, Ling bloqueante-2/item-12, Nemotron B-2/B-5 |
| D3 | Inferência de DDI omitido é ambígua sem um envelope fechado (comprimento + DDD válido) — do contrário colide com números de outros países | DeepSeek B4, Nemotron I-2, Ling bloqueante-1/item-10 |
| D4 | Equivalência entre assinante de 8 dígitos (legado) e 9 dígitos (atual) nunca foi decidida | Nemotron I-3, Ling item-6 |
| D5 | Reaproveitar `phoneVariants()` (genérico, multi-país, usado hoje só para retry de envio) na identidade canônica introduz o mesmo risco de colisão entre DDIs que a invariante de não-colisão proíbe | Ling item-6 |
| D6 | Transitividade da equivalência é exigida nos testes mas nunca foi declarada como invariante — contradição interna | DeepSeek I6 |
| D7 | "Identidade incerta" (fail-safe) não tinha lista fechada de condições — sem isso o fail-safe é subjetivo por implementação | Nemotron I-2, Ling item-8 |
| D8 | `phonesMatch` vs `phonesMatchStrict`: coexistência e escopo de cada uma não estavam resolvidos frente ao critério "um único predicado" | DeepSeek I1, Nemotron I-4, Ling item-14 |
| D9 | O predicado canônico precisa ser expressável como expressão indexável, ou o pré-filtro SQL regride para *seq scan* em produção | DeepSeek B5/I7, Ling bloqueante-2 |
| D10 | Determinismo exige função pura (sem I/O, sem estado, mesma saída sempre) — implícito em todas, nunca explicitado como critério verificável | DeepSeek/Nemotron/Ling, transversal |

Fora de escopo desta consolidação (pertencem a `ADR-CONTACT-MERGE-001`, não a este documento): regra de sobrevivente, fusão de conversas/mensagens/reações, colisão de `lead_attributions.origin_message_id`, `flow_runs` ativos, rollout por *feature flag*, backfill histórico, janela/RPO de rollback. Essas decisões dependem desta ADR estar congelada primeiro — é por isso que a ordem dos gates importa.

---

## 2. Objetivo

Definir, de forma única e determinística, o que significa "dois telefones identificam o mesmo assinante" para números brasileiros, de modo que qualquer implementador — em SQL ou em JS, hoje ou daqui a um ano — produza exatamente a mesma resposta para qualquer par de entradas, sem consultar os autores deste documento.

## 3. Escopo

- A relação de equivalência de identidade para números com Discagem Direta Internacional (DDI) brasileiro (`55`), explícito ou inferido dentro do envelope fechado definido em §7.
- A classificação formal de quando dois números **não** são equivalentes.
- As propriedades matemáticas obrigatórias da relação (reflexividade, simetria, transitividade, decidibilidade, determinismo).
- Os casos ambíguos e o comportamento fail-safe correspondente.
- Uma tabela normativa de exemplos, positivos e negativos, suficiente para eliminar interpretação divergente.
- A exigência de que a chave canônica seja expressável como expressão SQL indexável (sem prescrever a expressão, o índice ou a migração — isso é do HOTFIX derivado).

## 4. Fora de escopo

- Regra de contato/conversa/mensagem sobrevivente em um merge (`ADR-CONTACT-MERGE-001`).
- Algoritmo de fusão de dados relacionados (atribuições, tags, flows, automações) (`ADR-CONTACT-MERGE-001`).
- DDL, nome de coluna, tipo de índice, RPC, migração.
- Estratégia de rollout, *feature flag*, backfill, janela de rollback.
- Identidade de números **não** brasileiros: permanece **exclusivamente** igualdade exata de dígitos normalizados (comportamento atual de `phone_normalized`/`normalizePhone`) — este documento não estende, nem promete estender, equivalência fuzzy a nenhum outro país. Qualquer generalização futura é uma nova ADR.
- Uso de `phonesMatch`/`phonesMatchStrict`/`phoneVariants` fora do caminho de identidade (ex.: `sendWithPhoneVariantRetry` continua existindo para *retry* de envio — não é tocado por esta ADR).

## 5. Definição formal de identidade

**Identidade de telefone** é o resultado de uma função pura e total:

```
canonical_br(input: string) -> CanonicalKey | NonBR
```

onde `CanonicalKey` é uma string no formato fixo `55` + `DDD` (2 dígitos, pertencente ao conjunto fechado `VALID_DDD` — Anexo A) + `ASSINANTE` (8 dígitos se linha fixa, 9 dígitos se móvel, sempre começando por `9` quando móvel), e `NonBR` é um marcador que faz o número cair fora do domínio desta ADR (§6.4 e §9 governam esse caso — identidade passa a ser igualdade exata de dígitos, sem fusão fuzzy).

`canonical_br` é a **única** função de identidade admissível em qualquer caminho de código (webhook, formulário manual, import CSV, merge). Não existe uma segunda implementação "equivalente" em SQL e outra em JS — existe uma definição, aqui, materializada como uma função e como uma expressão SQL geradas a partir da mesma especificação (resolve D2, D8, D9 e a invariante "único predicado").

## 6. Definição de equivalência

Dois telefones `A` e `B` são **equivalentes** (mesma identidade) se e somente se `canonical_br(A) == canonical_br(B)` e ambos os resultados são `CanonicalKey` (não `NonBR`).

`canonical_br` é calculada em duas etapas, nesta ordem, sem exceção:

### 6.1 Normalização de dígitos

Remove tudo que não é dígito decimal (idêntico ao `normalizePhone` atual). Chame o resultado `digits`.

### 6.2 Resolução de DDI

1. Se `digits` começa com `55` **e** o restante, após remover o `55`, casa com o envelope de §6.3 (DDD válido + assinante válido) → DDI explícito confirmado. Prossegue com o restante.
2. Se `digits` **não** começa com `55`, mas o próprio `digits` (sem remover nada) casa inteiramente com o envelope de §6.3 → **DDI brasileiro inferido por omissão**. Prossegue com `digits` como DDD+assinante.
3. Em qualquer outro caso → `NonBR`. Isso inclui, sem exceção: números que começam com `55` mas cujo restante não casa com o envelope (não são reinterpretados de nenhuma outra forma); números que começam com um DDI explícito diferente de `55` reconhecido como tal (nunca são reinterpretados como BR); e qualquer entrada cujo comprimento não seja um dos previstos no envelope.

Um DDI explícito, uma vez identificado como não-`55` por um `+` ou por corresponder a um comprimento/prefixo E.164 reconhecido de outro país, **nunca** é reescrito para `55`. A inferência de DDI omitido (passo 2) só existe para preencher a ausência de DDI — nunca para sobrepor um DDI presente. Isso é o que impede a colisão descrita por todas as três revisões (`11987654321` não é "talvez outro país" — é testado estritamente contra o envelope BR; se casar, é BR; se não casar, cai em `NonBR`, nunca em uma adivinhação de outro país).

### 6.3 Envelope fechado DDD + assinante

Após a resolução de DDI, o restante (`DDD + assinante`) deve casar **exatamente** com uma destas duas formas, ou o número cai em `NonBR`:

| Forma | Comprimento total (DDD+assinante) | Regra |
|---|---|---|
| Móvel | 11 dígitos | `DDD ∈ VALID_DDD` (Anexo A); assinante = 9 dígitos, primeiro dígito `9` |
| Móvel legado (sem 9º dígito) | 10 dígitos | `DDD ∈ VALID_DDD`; assinante = 8 dígitos, primeiro dígito ∈ `{6,7,8,9}` |
| Fixo | 10 dígitos | `DDD ∈ VALID_DDD`; assinante = 8 dígitos, primeiro dígito ∈ `{2,3,4,5}` |

Note que "móvel legado" e "fixo" têm o mesmo comprimento total (10 dígitos) — são distinguidos apenas pelo primeiro dígito do assinante, que é o mesmo critério que a Anatel usa para o Plano de Numeração. Um assinante de 8 dígitos cujo primeiro dígito não está em `{2,3,4,5,6,7,8,9}` (ou seja, começa em `0` ou `1`) não casa com nenhuma forma → `NonBR`.

### 6.4 Canonicalização do assinante (regra do 9º dígito)

Resolve D4. A chave canônica **sempre** representa o assinante móvel com 9 dígitos:

- Se o assinante já tem 9 dígitos (começando por `9`) → usado como está.
- Se o assinante tem 8 dígitos e o primeiro dígito ∈ `{6,7,8,9}` (móvel legado) → um `9` é prefixado. `87654321` (DDD 11) e `987654321` (DDD 11) produzem a **mesma** `CanonicalKey`.
- Se o assinante tem 8 dígitos e o primeiro dígito ∈ `{2,3,4,5}` (fixo) → usado como está, **nunca** ganha um 9º dígito (linha fixa não tem essa migração).

Este é o único ponto de "inserção de dígito" permitido por esta ADR.

### 6.4.1 Exclusão do prefixo de tronco `0` — justificativa e evidência (revisão v2)

Decisão mantida: **não existe** inserção/remoção de prefixo de tronco `0` em `canonical_br`. Se um `0` aparecer entre o DDI e o DDD, ou antes do DDD sem DDI, o número não casa com nenhuma forma de §6.3 e cai em `NonBR` — permanece um contato distinto até prova em contrário.

Esta decisão foi reexaminada (não apenas mantida por inércia) contra a base de código auditada, à procura de evidência operacional de que números com tronco `0` realmente entram pelos canais do ForceCRM:

- **`phonesMatchStrict` já tolera tronco `0`, mas não há evidência de que isso resolve um caso brasileiro real.** A tolerância existe via `phoneVariants()` — cujo próprio teste de regressão (`phone-utils.test.ts:45-46,72`) documenta o caso motivador como **lituano** (`+370 063 949 836`, sandbox da Meta), não brasileiro. Nenhum teste, fixture de CSV (`parse-contact-csv.test.ts`) ou comentário de código no repositório associa tronco `0` a um número BR real.
- **Os três canais de entrada de telefone hoje auditados não produzem tronco `0` para o Brasil.** O `wa_id`/`msisdn` do webhook Meta chega em E.164 sem tronco; `parse-contact-csv.test.ts` só tem fixtures em formato `+1...` (E.164 puro, sem tronco); não há amostra de importação BR no repositório para inspecionar.
- **Nenhuma issue, comentário de migração ou registro em `CHANGELOG.md` menciona duplicata causada por tronco `0`.** O caso motivador documentado do HOTFIX (issue #212, citada em `dedupe.ts`) é sobre formato de pontuação/DDI, não sobre tronco doméstico.

Conclusão: **não há evidência operacional, apenas plausibilidade coloquial** (é comum brasileiros escreverem `(0xx11) 98765-4321` ao ditar um número, convenção herdada da discagem interurbana pré-DDI). Plausibilidade coloquial não é evidência de que esse formato chega aos quatro caminhos de identidade do sistema (webhook, formulário, CSV, merge) sem já ter sido normalizado a montante.

Por isso a decisão desta ADR é a que o princípio fail-safe de §9 já exige por padrão: **entrada não verificada não vira inferência especulativa** — a ausência de evidência resolve a favor de `NonBR`, não a favor de tolerância. Isto não é uma posição permanente:

- **Caminho de reabertura:** se surgir evidência operacional concreta — amostra real de `contacts.phone` com prefixo `0` sistemático em volume não-trivial, ticket de suporte relatando duplicata por esse motivo, ou log de import CSV com esse padrão — a revisão desta decisão é uma nova versão desta ADR (governada como qualquer mudança normativa, não uma tolerância silenciosa adicionada na implementação).
- **Verificação de baixo custo recomendada antes do Gate de `ADR-CONTACT-MERGE-001`:** uma consulta de auditoria (`SELECT phone FROM contacts WHERE phone ~ '^\+?550?\d{2}0\d{8,9}$' OR phone ~ '^0\d{10,11}$'` ou equivalente) contra a base real do ForceCRM, fora do escopo de produção desta ADR (é leitura, não decisão), para confirmar ou refutar a plausibilidade antes que `ADR-CONTACT-MERGE-001` dependa desta exclusão para backfill histórico.

Enquanto essa evidência não existir, `NonBR` para tronco `0` é a decisão vinculante.

### 6.5 `phoneVariants()` não é reutilizável aqui

Resolve D5. A função `phoneVariants()` existente (genérica, comprimentos de DDI 1/2/3, usada em `sendWithPhoneVariantRetry` para contornar sandbox da Meta) **não é, e não pode se tornar**, parte de `canonical_br`. São domínios diferentes: `phoneVariants` existe para *tentar variantes de envio* sem garantia de identidade; `canonical_br` existe para *decidir identidade* com garantia de não-colisão entre DDIs. Reaproveitar uma na outra reintroduziria exatamente o risco que "Isolamento de domínio" (§8.1) proíbe.

### 6.6 Coexistência entre `canonical_br` e a identidade padrão (`NonBR` → igualdade exata)

Esta ADR não define identidade apenas para números BR — define como a identidade BR **coexiste**, sem colisão, com a identidade exata que já cobre todo o resto do domínio (comportamento atual de `phone_normalized`/`normalizePhone`, mantido para números `NonBR` por §4). A função de identidade **global** do sistema, doravante vinculante para qualquer caminho de código, é:

```
identity(input: string) -> IdentityKey

identity(input) =
    canonical_br(input)         se canonical_br(input) ≠ NonBR
    normalizePhone(input)       caso contrário   (chave de igualdade exata — comportamento pré-existente)
```

Não são "dois sistemas paralelos que por acaso não colidem hoje" — é **uma única relação de equivalência sobre todo o domínio de strings de telefone**, particionada em duas sub-relações, com disjunção **demonstrável**, não apenas observada:

**Prova de disjunção.** Seja `K_BR` o conjunto de valores que `canonical_br` pode retornar como `CanonicalKey`, e seja `K_EXACT` o conjunto de chaves de fallback `normalizePhone(input)` para entradas onde `canonical_br(input) = NonBR`.

1. Por construção, `normalizePhone(input)` é apenas `digits(input)` — a mesma string de dígitos que `canonical_br` já examina em §6.1. Logo `identity(input)` no ramo `NonBR` é literalmente `digits(input)`.
2. Pela propriedade de idempotência (§8.1): `canonical_br(digits(input)) = canonical_br(input)`. Como `canonical_br(input) = NonBR` nesse ramo, segue que `canonical_br(digits(input)) = NonBR` também.
3. Ou seja: **toda chave de `K_EXACT`, se reapresentada a `canonical_br`, também resolve para `NonBR`** — nunca produz um valor de `K_BR`.
4. Inversamente, toda chave de `K_BR` é, por definição, um `CanonicalKey` — e por idempotência, `canonical_br` aplicada a ela retorna a si mesma (um `CanonicalKey`, nunca `NonBR`).

Logo nenhuma string pode pertencer a `K_BR` e a `K_EXACT` simultaneamente: se pertencesse a `K_BR`, `canonical_br` sobre ela devolveria `CanonicalKey` (passo 4); se pertencesse a `K_EXACT`, devolveria `NonBR` (passo 3). `K_BR ∩ K_EXACT = ∅`. **Não é necessário namespace, prefixo ou tag artificial para evitar colisão** — a disjunção decorre estruturalmente da totalidade e do determinismo de `canonical_br`, não de uma convenção de nomenclatura que poderia ser esquecida em uma reimplementação.

Consequência vinculante: `identity()` é uma relação de equivalência bem definida sobre **todo** o domínio de entrada (reflexiva, simétrica e transitiva — herda essas propriedades de `canonical_br` dentro de `K_BR` e da igualdade estrita de string dentro de `K_EXACT`, e a disjunção acima garante que não há transitividade cruzada espúria entre os dois ramos). Qualquer implementação que precise de uma única coluna/expressão de identidade (para índice único, por exemplo) pode usar `identity()` diretamente — a escolha de materializar isso como uma coluna, uma função armazenada, ou duas colunas com `COALESCE`, é decisão do HOTFIX derivado (§4), não desta ADR.

## 7. Definição de não equivalência

Dois telefones **não são equivalentes** quando:

1. `canonical_br(A) != canonical_br(B)` (DDDs diferentes, ou DDIs diferentes, ou assinantes diferentes após canonicalização).
2. Qualquer um dos dois resolve para `NonBR`. Números `NonBR` **nunca** são equivalentes entre si por esta ADR, mesmo que sejam dígito-a-dígito idênticos — igualdade exata de dígitos normalizados continua cobrindo esse caso (comportamento atual de `phone_normalized`), mas isso é igualdade, não a relação de equivalência fuzzy definida aqui.
3. Um DDI explícito não-`55` está presente — nunca é candidato a reinterpretação como BR, independentemente de "parecer" ter a forma de um número BR sem DDI (mata o cenário de colisão internacional levantado por todas as três revisões).
4. Os últimos N dígitos coincidem mas o DDD ou o DDI não — ou seja, `phonesMatch` (sufixo de 8 dígitos) **não é** e nunca foi uma relação de identidade; permanece proibida como base de fusão (ver §11).

## 8. Propriedades

Esta seção separa deliberadamente **propriedades formais da relação de identidade** (§8.1 — verdadeiras independentemente de onde/como `canonical_br` é executada) de **requisitos derivados de implementação** (§8.2 — restrições sobre a realizabilidade computacional da especificação em um motor de banco específico). A distinção importa: confundir as duas permitiria que uma restrição de engenharia (indexabilidade) fosse tratada como se definisse identidade — não define. Duas funções poderiam calcular exatamente a mesma relação de equivalência e diferir apenas em serem ou não expressáveis como expressão SQL imutável; isso não as tornaria "identidades diferentes", tornaria uma delas inadequada para um índice, o que é um problema de engenharia, não de significado.

### 8.1 Propriedades formais da relação de identidade

| Propriedade | Garantia |
|---|---|
| **Reflexividade** | `canonical_br(A) == canonical_br(A)` sempre, por construção (função pura). |
| **Simetria** | A relação é "mesma `CanonicalKey`" — simétrica por definição, não depende de qual dos dois números é avaliado primeiro. |
| **Transitividade** (resolve D6) | Garantida estruturalmente: a relação não é comparação par-a-par (`A~B` e `B~C` implicando `A~C` por regra transitiva ad-hoc), é **particionamento por valor de chave canônica**. Como `canonical_br` é uma função (uma entrada, uma saída), "equivalente" significa "mesma classe de equivalência", que é transitiva por definição matemática de partição. Não há como dois números produzirem a mesma chave que um terceiro e essa terceira não pertencer à mesma classe. |
| **Idempotência** (nova, revisão v2) | `canonical_br(canonical_br(A)) == canonical_br(A)` para todo `A` tal que `canonical_br(A) ≠ NonBR`. Prova: um `CanonicalKey` é, por construção, uma string que já começa com `55` e cujo restante já casa com o envelope de §6.3 na forma canônica de §6.4 (assinante móvel já com 9 dígitos iniciando em `9`, ou assinante fixo já com 8 dígitos). Reaplicar `canonical_br` a essa string: (a) §6.2 passo 1 casa imediatamente (`55` + restante que já satisfaz o envelope); (b) §6.4 não tem nada a transformar, pois o assinante já está na forma canônica. O resultado é a própria chave, sem alteração. Esta propriedade é o que torna `identity()` (§6.6) segura para reaplicação repetida — por exemplo, se um valor já normalizado for reprocessado por engano em um pipeline de backfill, o resultado não diverge. |
| **Estabilidade temporal** (nova, revisão v2) | Para uma versão fixa do Anexo A (`VALID_DDD`), `canonical_br(A)` produz o mesmo resultado em qualquer instante — não há dependência de relógio, fuso horário, feriado, ou qualquer estado mutável. Isso é necessário mas não suficiente para estabilidade *ao longo do tempo de vida do produto*: o Plano de Numeração da Anatel muda (novos DDDs são raramente emitidos; áreas são raramente desmembradas). Uma mudança no Anexo A é uma **mudança de versão da especificação**, não uma mudança de estado — e está sujeita à governança de §Anexo A.1. Uma `CanonicalKey` calculada sob a versão N do Anexo A não tem garantia de permanecer correta sob a versão N+1; qualquer consumidor que armazena `CanonicalKey` (índice, coluna gerada) herda a obrigação de re-canonicalização quando o Anexo A muda de versão — obrigação vinculante para o HOTFIX/backfill derivado, registrada aqui para que não seja esquecida, não implementada aqui. |
| **Decidibilidade** | `canonical_br` termina para toda entrada finita e retorna sempre `CanonicalKey` ou `NonBR` — nunca "indefinido" fora dos casos listados em §9, que são explicitamente `NonBR`. |
| **Determinismo** (resolve D10) | `canonical_br` é uma função pura: mesma entrada → mesma saída, sempre, sem depender de hora, locale, estado do banco, ordem de chamada, ou de qual caminho de código (webhook, formulário, import, merge) a invoca. Não faz I/O. `VALID_DDD` (Anexo A) é uma constante fechada, não uma consulta — ver estabilidade temporal acima para o que acontece quando essa constante muda de versão. |
| **Isolamento de domínio** | Não-BR nunca "vaza" para BR e vice-versa: um DDI explícito não-`55` nunca é candidato à inferência de §6.2 passo 2; um número que falha o envelope de §6.3 nunca é forçado a se encaixar. Formalizado e provado como disjunção `K_BR ∩ K_EXACT = ∅` em §6.6. |

### 8.2 Requisito derivado de implementação (não é propriedade formal)

| Requisito | Por que não é propriedade formal | Obrigação vinculante |
|---|---|---|
| **Indexabilidade** (resolve D9) | Reclassificada nesta revisão. Reflexividade, simetria, transitividade, idempotência, estabilidade temporal, decidibilidade e determinismo são verdadeiras sobre a função matemática `canonical_br` em si — não mudam se ela roda em Postgres, em uma função TypeScript, ou em papel. Indexabilidade **não** é assim: é uma afirmação sobre se **uma codificação específica** da especificação de §6 pode ser expressa como uma expressão SQL `IMMUTABLE` sobre `phone`, para virar coluna gerada ou índice de expressão em um motor de banco específico (Postgres). Duas implementações poderiam calcular exatamente a mesma relação de equivalência — uma via expressão SQL pura, outra via uma função que faz *lookup* em tabela auxiliar não indexável — sem que a relação de identidade mude; a segunda apenas seria inadequada para este requisito de performance. Misturar essa restrição de engenharia com as propriedades de §8.1 obscureceria que a *identidade* de dois números não depende de como o sistema a computa. | Ainda assim, **vinculante**: a especificação de §6 foi desenhada precisamente para ser realizável como expressão `IMMUTABLE` (sem *lookup* dinâmico, sem I/O — `VALID_DDD` como constante fechada, não tabela consultada em runtime). O HOTFIX derivado **deve** materializar `canonical_br` (e por extensão `identity()`, §6.6) de forma indexável; esta ADR não prescreve coluna gerada vs. índice de expressão vs. função indexada, mas proíbe qualquer materialização que force *seq scan* — isso reabriria D9/B5 das revisões originais. |

## 9. Casos ambíguos (fail-safe)

Resolve D7. Lista **fechada** — qualquer entrada que caia em um destes casos resolve para `NonBR`, e **nunca** é fundida por esta ADR (invariante de não-colisão prevalece sobre recall):

1. Comprimento de `digits` fora de `{10, 11, 12, 13}` (isto é, fora de DDD+assinante sem DDI, ou 55+DDD+assinante com DDI).
2. `DDD` (as duas posições relevantes, com ou sem `55` à frente) não pertence a `VALID_DDD` (Anexo A).
3. Assinante de 8 dígitos cujo primeiro dígito não está em `{2,3,4,5,6,7,8,9}`.
4. Assinante de 9 dígitos cujo primeiro dígito não é `9`.
5. Presença de um DDI explícito diferente de `55` (nunca reinterpretado — ver §6.2.3).
6. Qualquer dígito não numérico remanescente após a etapa de normalização que não seja removível por regra determinística (não deveria ocorrer após §6.1, listado por completude).
7. Entrada vazia ou nula.

Não existe um caso "incerto, mas funde mesmo assim". Fail-safe significa exclusivamente **não fundir** — nunca "fundir com log de aviso", nunca "fundir e deixar para revisão manual". A revisão manual, se existir, opera sobre contatos que permaneceram distintos, não sobre uma fusão já feita (isso preserva a invariante de não-colisão de forma absoluta, ao custo aceito de recall — números em formas verdadeiramente ambíguas continuam sendo dois contatos até prova em contrário).

## 10. Critérios de determinismo

Um algoritmo satisfaz esta ADR se e somente se, para o conjunto de exemplos do Anexo B (e qualquer entrada adicional construída pela mesma especificação):

1. É uma função total pura (sem exceções não tratadas, sem I/O) — testável por *property-based testing* sem mocks.
2. Produz exatamente as `CanonicalKey` ou `NonBR` listadas no Anexo B, sem exceção nem aproximação.
3. A mesma especificação, implementada independentemente em SQL e em TypeScript, produz o mesmo resultado para as mesmas 100% das entradas do Anexo B (critério de aceite mensurável: paridade de resultado em teste automatizado que roda os dois lados contra o mesmo fixture).
4. Não existe nenhuma entrada do Anexo B para a qual duas implementações conformes a este documento discordem — se existir, o documento (não a implementação) está incorreto e deve ser revisado antes do Gate.

## 11. Relação com `phonesMatch` / `phonesMatchStrict` (resolve D8)

- `canonical_br` (esta ADR) é a **única** função de identidade daqui em diante. Ela substitui `phonesMatchStrict` integralmente como base de decisão de identidade (webhook, `findExistingContact`, merge). `phonesMatchStrict` deve deixar de ser chamada em qualquer caminho de identidade; sua remoção ou não é decisão de implementação do HOTFIX derivado, não desta ADR — mas seu **uso** em identidade termina aqui.
- `phonesMatch` (sufixo de 8 dígitos) **não é**, e nunca foi, uma relação de identidade. Continua existindo exclusivamente para superfícies consultivas ("possível duplicata" no formulário) — nunca para decidir fusão, criação ou roteamento de mensagem. Esta ADR não a remove; apenas proíbe, de forma absoluta, seu uso em qualquer decisão coberta por "identidade".
- Qualquer código que hoje use `phonesMatch` ou `phonesMatchStrict` para decidir se dois telefones são "o mesmo contato" deve migrar para `canonical_br` — isso é obrigação vinculante para o HOTFIX derivado.

## 12. Tabela normativa de equivalência

`CC` = com DDI (`55` presente) · `SC` = sem DDI (inferido) · `L` = legado 8 dígitos.

### 12.1 Exemplos positivos (mesma `CanonicalKey`)

| # | Entrada A | Entrada B | `CanonicalKey` resultante | Motivo |
|---|---|---|---|---|
| P1 | `5511987654321` | `5511987654321` | `5511987654321` | Igualdade exata |
| P2 | `5511987654321` (CC) | `11987654321` (SC) | `5511987654321` | DDI omitido, envelope de 11 dígitos casa |
| P3 | `+55 11 98765-4321` | `551198765-4321` | `5511987654321` | Pontuação/formatação irrelevante após §6.1 |
| P4 | `11987654321` (móvel 9d) | `1187654321` (móvel legado, L) | `5511987654321` | Regra do 9º dígito (§6.4): `8`→prefixa `9` |
| P5 | `5521987654321` | `21987654321` | `5521987654321` | DDD 21 (RJ), mesmo padrão de P2 |
| P6 | `551133334444` (fixo) | `1133334444` | `551133334444` | Fixo 8 dígitos, sem inserção de 9º dígito |

### 12.2 Exemplos negativos (identidades diferentes ou `NonBR`)

| # | Entrada A | Entrada B | Resultado | Motivo |
|---|---|---|---|---|
| N1 | `5511987654321` | `5521987654321` | Chaves diferentes | DDDs diferentes (11 vs 21) — não fundir mesmo com assinante idêntico |
| N2 | `5511987654321` | `13511987654321`* | Chaves diferentes / `NonBR` | DDI explícito não-`55` presente em B (ex.: Lituânia `370`) nunca reinterpretado como BR |
| N3 | `11987654321` | `21987654321` | Chaves diferentes | Sufixo de 9 dígitos igual (`987654321`... não é o caso aqui, mas mesmo se fosse) — DDD diferente sempre vence; ilustra por que `phonesMatch` (sufixo) é proibida como identidade |
| N4 | `987654321` (9 dígitos, sem DDD) | `5511987654321` | `NonBR` para A | A tem 9 dígitos — fora do envelope de §6.3 (nenhuma forma prevê 9 dígitos sem DDD); fail-safe, não funde |
| N5 | `0111987654321` | `5511987654321` | `NonBR` para A | `0` antes do DDI/DDD não casa com nenhuma forma (§6.4) — número permanece distinto até revisão desta ADR |
| N6 | `1187654321` (assinante inicia com `1`) | qualquer | `NonBR` | Assinante 8 dígitos com 1º dígito `1` não está em `{2..9}` (§9.3) |
| N7 | `11988887777` | `011988887777` | `NonBR` para B | Tronco `0` antes do DDD não é aceito pelo envelope — B não casa com nenhuma forma; não são fundidos apesar de "parecerem" o mesmo número. Comportamento fail-safe explícito, não bug. |
| N8 | `5511987654321` | `551987654321`* | `NonBR` para B | B tem 12 dígitos (`55`+10) mas o restante após `55` (`1987654321`, 10 dígitos) não casa: nem DDD válido de 2 dígitos com assinante de 8 iniciando corretamente, nem a forma de 11; `NonBR` — nunca é "adivinhado" |
| N9 | `00987654321` | — | `NonBR` | DDD `00` não pertence a `VALID_DDD` (Anexo A) — nenhum DDD emitido pela Anatel começa em `0` |
| N10 | `5511987654321` | `5511887654321` | Chaves diferentes | Mesmo DDI/DDD, assinante realmente diferente (`9`87654321 vs `8`87654321) — dígitos diferem, não é o caso do 9º dígito de P4 |

*Nota: exemplos marcados com `*` usam comprimentos ilustrativos; a implementação de referência (HOTFIX derivado) deve gerar a tabela completa por *property-based testing* contra `VALID_DDD`, não apenas os casos aqui — esta tabela é o piso mínimo de não-ambiguidade, não o teto de cobertura.*

## Anexo A — `VALID_DDD` (conjunto fechado)

O conjunto de DDDs válidos é o Plano de Numeração vigente da Anatel — uma lista fechada, não derivada de heurística, e não deduzida do input. Nunca uma faixa numérica aproximada (`11..99`), porque a faixa aproximada admite DDDs nunca emitidos e reabre a ambiguidade que este documento fecha.

### Anexo A.1 — Fonte única de verdade e governança (revisão v2)

Resolve a lacuna apontada na revisão de refinamento: até esta revisão, o documento exigia "uma única lista" sem dizer onde ela mora nem quem pode mudá-la — o que deixaria a decisão de governança para a implementação, repetindo o erro estrutural que motivou esta ADR inteira. Fica travado:

1. **Fonte única de verdade.** `VALID_DDD` existe em **exatamente um** arquivo versionado no repositório (formato de dados, não código — ex.: `docs/reference/anatel-ddd.json` ou equivalente), citado por nome canônico neste documento a partir desta revisão. Toda expressão SQL (índice, coluna gerada, função `IMMUTABLE`) e toda função TypeScript que precisam do conjunto **derivam** dessa única fonte por geração automática (script determinístico versionado, ex. `scripts/generate-ddd-constants`) — nunca por duas listas mantidas manualmente em paralelo. Um teste de paridade (mesmo mecanismo do Anexo B — comparar o conjunto embutido em SQL contra o conjunto embutido em TS contra o arquivo-fonte) é obrigação vinculante do HOTFIX derivado, não opcional.
2. **Dono.** O papel que aprova mudanças no Anexo A é o mesmo que aprova esta ADR e suas revisões — hoje, quem preside o Gate Arquitetural do ForceCRM. Não há aprovação silenciosa por *pull request* de implementação: uma mudança em `VALID_DDD` é uma mudança **normativa**, não uma correção de dado.
3. **Origem factual exigida.** Toda entrada do arquivo-fonte deve ser rastreável a uma fonte oficial da Anatel (Plano Geral de Numeração / resoluções publicadas em anatel.gov.br) — não a memória, não a inferência do modelo que escreveu este documento, não a "faixa plausível". Este ADR não reproduz a lista completa dos ~67 códigos vigentes por não ter, nesta revisão, verificação linha-a-linha contra a fonte oficial primária; **o HOTFIX derivado que cria o arquivo-fonte é obrigado a citar a resolução/página oficial de onde cada código foi extraído**, não a copiar de memória.
4. **Versionamento e obrigação de re-canonicalização.** Cada alteração do arquivo-fonte (novo DDD emitido, desmembramento de área) incrementa uma versão explícita do Anexo A (ex.: `anatel-ddd.v{N}.json` ou campo `version` no próprio arquivo). Por §8.1 ("Estabilidade temporal"), uma mudança de versão invalida a garantia de estabilidade das `CanonicalKey` já calculadas sob a versão anterior — o HOTFIX/backfill derivado herda a obrigação de re-canonicalizar identidades armazenadas sempre que a versão muda. Esta ADR não define o mecanismo de backfill (isso é `ADR-CONTACT-MERGE-001`/HOTFIX); define apenas que a obrigação existe e não pode ser ignorada silenciosamente.
5. **Mudanças ao Anexo A não reabrem esta ADR.** Adicionar/remover um DDD é uma atualização de dado governada, versionada e rastreável (itens 1-4) — não uma revisão da especificação de `canonical_br` em si. Só uma mudança na *forma* da regra (ex.: mudar o comprimento do assinante, mudar a regra do 9º dígito) exige nova revisão desta ADR.

## Anexo B — Fixture de conformidade

O conjunto de pares do §12, formalizado como fixture de teste compartilhado (mesmo arquivo de dados, consumido por teste SQL e teste TypeScript), é o artefato mínimo de aceite do critério de determinismo (§10.3). Sua expansão (mais DDDs, mais formas) é responsabilidade do HOTFIX derivado, não desta ADR — mas nenhuma expansão pode remover ou enfraquecer os pares aqui listados sem nova revisão desta ADR.

---

## 13. Autovalidação

- **Existem duas implementações diferentes que ainda poderiam obedecer a este contrato?** Não: §6 define uma função total determinística passo a passo, sem parâmetro de design deixado em aberto; §10.3/10.4 tornam divergência entre implementações um critério de falha mensurável e testável.
- **Existe alguma decisão deixada para a implementação?** A materialização física (coluna gerada vs. índice de expressão, formato exato do arquivo de `VALID_DDD`) é deixada para o HOTFIX derivado **por design** — é decisão de schema/DDL, explicitamente fora de escopo (§4), não uma decisão de identidade. Nenhuma decisão sobre o que é identidade, equivalência ou fail-safe permanece aberta.
- **Existe alguma invariante impossível de garantir?** Não: todas as propriedades formais de §8.1 decorrem estruturalmente de `canonical_br` ser uma função pura, idempotente e total sobre um domínio fechado — não dependem de coordenação em runtime nem de estado externo. A única propriedade com dependência de tempo (estabilidade temporal) é qualificada explicitamente à versão do Anexo A, com obrigação de re-canonicalização amarrada à governança (Anexo A.1) — não é uma garantia "para sempre" disfarçada de garantia incondicional.
- **Existe algum critério de aceite impossível de medir?** Não: §10 define paridade de fixture testável automaticamente (Anexo B) como critério objetivo; a paridade de `VALID_DDD` entre SQL/TS/fonte (Anexo A.1) é o mesmo tipo de critério, mensurável por teste.
- **O contrato é suficiente para que outra equipe implemente sem consultar os autores?** Sim, para o que este documento cobre (identidade). Não cobre merge/fusão — isso é `ADR-CONTACT-MERGE-001`, próximo gate, explicitamente fora de escopo aqui (§4).

### 13.1 Resposta às 5 objeções da revisão de refinamento (v2)

| # | Objeção | Resolução nesta revisão |
|---|---|---|
| 1 | Tronco `0` — justificar com evidência operacional ou mudar a decisão | **Decisão mantida, não por inércia**: auditoria do repositório (testes, fixtures de CSV, `CHANGELOG.md`, issue motivadora) não encontrou nenhuma evidência de tronco `0` em dados BR reais — só o caso lituano de sandbox, que é outro domínio. Fail-safe (§9) resolve ausência de evidência a favor de `NonBR`, não de tolerância especulativa. Caminho de reabertura e verificação de baixo custo documentados em §6.4.1. |
| 2 | Governança e fonte única de `VALID_DDD` | Anexo A.1: arquivo único versionado, dono nomeado (quem preside o Gate), origem factual obrigatória (citação de resolução Anatel, não memória do modelo), versionamento com obrigação de re-canonicalização amarrada à estabilidade temporal (§8.1), e regra explícita de que atualização de dado não reabre a ADR mas mudança de forma da regra reabre. |
| 3 | Coexistência explícita `canonical_br` × `NonBR` (igualdade exata) | §6.6: função `identity()` global definida, com prova formal de disjunção `K_BR ∩ K_EXACT = ∅` derivada da idempotência — não por convenção de nomenclatura, por estrutura. |
| 4 | Idempotência e estabilidade temporal como propriedades formais | Adicionadas em §8.1 com prova (idempotência) e qualificação explícita de escopo (estabilidade temporal, condicionada à versão do Anexo A, amarrada à governança do item 2). |
| 5 | Indexabilidade: propriedade de identidade ou requisito de implementação? | Reclassificada para §8.2, com justificativa explícita da distinção (propriedade formal independe de motor de execução; indexabilidade é sobre realizabilidade de uma codificação específica em Postgres) — permanece vinculante, mas não é mais apresentada como se definisse o que é identidade. |

Nenhuma das cinco objeções permanece em aberto. Nenhuma decisão nova sobre merge, fusão, DDL ou rollout foi introduzida nesta revisão — todas as adições permanecem dentro do escopo de §3.

## 14. Cláusula de congelamento

Este ADR fica **congelado** até que uma evidência operacional concreta exija sua revisão. Novos casos de borda, preferências de implementação ou conveniência não são motivos suficientes para alterar a relação de equivalência.

Especificamente, **não constitui motivo válido para alterar `canonical_br`, `identity()` ou o Anexo A sem uma nova revisão formal desta ADR**:

- Um pedido de implementação do tipo "já que estamos mexendo nisso, vamos aproveitar e aceitar também esse outro formato" — isso é uma mudança de especificação disfarçada de conveniência de código, e deve abrir uma nova ADR (ou uma revisão numerada desta), nunca ser resolvida silenciosamente no `HOTFIX-001` derivado ou em `ADR-CONTACT-MERGE-001`.
- Um caso de borda descoberto durante a implementação que pareça razoável de cobrir (ex.: um formato de entrada não previsto no Anexo B) — se cai em `NonBR` pela especificação atual, permanece `NonBR`; o comportamento correto é reportar o caso, não ampliar a regra ad-hoc no código.
- Preferência de performance ou de estilo de código que altere a forma canônica, a ordem de resolução de DDI, ou a regra do 9º dígito, sem mudar o comportamento observável — mesmo uma refatoração "equivalente" da lógica é uma reimplementação da especificação e deve ser validada contra o Anexo B (§10.3), não assumida como segura por inspeção.

O único gatilho legítimo de revisão é evidência operacional concreta e verificável — nos mesmos termos exigidos em §6.4.1 para o tronco `0`: amostra real de dados, ticket de suporte, ou achado de auditoria (ex.: da consulta recomendada em §6.4.1) que demonstre que a especificação atual produz um resultado incorreto ou insuficiente em produção. Mudança de dado governada no Anexo A (novo DDD emitido pela Anatel, por Anexo A.1) não é uma exceção a esta cláusula — é o próprio mecanismo de governança já previsto, e segue seu processo próprio, não uma decisão ad-hoc de implementação.

Qualquer código, PR ou decisão de `HOTFIX-001`/`ADR-CONTACT-MERGE-001` que altere o comportamento de identidade sem uma revisão formal desta ADR está, por definição, fora de conformidade com o Gate — independentemente da justificativa técnica apresentada no momento.
