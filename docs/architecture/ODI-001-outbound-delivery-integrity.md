# ODI-001 — Outbound Delivery Integrity Contract

| | |
|---|---|
| **Tipo** | Contrato derivado (design document) |
| **Deriva de** | `ADR-MSG-001 v4` — **D4** (envio como processo de estados), **invariante A** (dedup de persistência ≠ dedup de efeitos) · `DLB-001` §6 (fronteira transacional e liquidação) · `EIS-001` §5 (atomicidade da escrita de saída) |
| **Épico consumidor** | E4a — Outbound Delivery Integrity |
| **Resolve** | C17 (falha de envio invisível) · C18 (double-send em retry) · **N-3** (dedup de efeitos no caminho de saída) |
| **Status** | Proposto · **v3** — incorpora revisão adversarial de 2026-07-21 (ver §15) |
| **Autoridade** | Não altera decisão do ADR nem cláusula de `DLB-001`/`EIS-001`, que permanecem fechados. Executa D4 sobre a fronteira que E1 entregou. |
| **Baseline de código** | HEAD `313cff5` |

---

## 1. Escopo

### 1.1 O que este contrato especifica

A **integridade do caminho de saída**: a progressão de estados de uma mensagem enviada, a persistência anterior à chamada do provider, a operação de liquidação em modo de transição, a idempotência do envio e o gate de deduplicação de efeitos colaterais de saída (N-3).

### 1.2 O que este contrato não especifica

- **DLQ e reprocesso assíncrono** — é **E4b**. ODI-001 garante que o retry não *duplique*; a orquestração de *quando* o retry ocorre e o reprocesso de intenções presas pertencem a E4b.
- **Política de retry completa** — backoff, teto de tentativas, TTL. A idempotency-key (§6) impede o dano do retry; a orquestração é de E4b.
- **Entidade `connections` e multi-conexão** — é **E3**. ODI-001 opera sobre a conexão única vigente e sobre `connection_ref` no regime transitório de `EIS-001` §3.2.
- **Normatização das transições da máquina de estados** — é produto de **E2.1** (delegado por D7). ODI-001 **consome** esse conjunto de estados; não o redefine. Ver §3 e a dependência declarada em §14.
- **Convivência `delivered`/`received`** — pendência herdada sem portador documental; não é deste épico.
- **Qualquer alteração no caminho de entrada** (`inbound-processor.ts`, invariante A). ODI-001 **espelha** o gate no lado de saída; não toca o de entrada.
- **Reabertura de `DLB-001` ou `EIS-001`.** ODI-001 consome a liquidação de `DLB-001 §6.2` no modo-2 que ela já previu.

### 1.3 Rastreabilidade

Cláusula sem citação de decisão do ADR é design livre e está marcada **[SPEC]** — revisável sem reabrir o ADR.

---

## 2. Problema

Verificado no baseline `313cff5`.

**2.1 — C17: a mensagem só existe se o envio deu certo.** Em `src/app/api/whatsapp/send/route.ts`, a persistência ocorre **depois** do retorno do provider. Se o provider falha, não há linha — a mensagem que o operador tentou enviar **não aparece no inbox** em estado algum. Falha de envio é ausência, não estado.

**2.2 — C18: retry sem idempotência.** A chamada ao provider não carrega chave de idempotência. Um timeout ou 429 seguido de retry pode produzir **dois envios reais** da mesma mensagem, porque o provider não tem como reconhecer a segunda tentativa como repetição da primeira.

**2.3 — N-3: o gate de efeitos existe só na entrada.** `inbound-processor.ts:324` aborta efeitos colaterais em reentrega de mensagem de entrada (invariante A). O caminho de **saída não tem equivalente**: uma retomada ou reenvio pode re-disparar pausa de flow e incremento de contador de broadcast. `ADR-MSG-001 §12` atribuiu a resolução de N-3 a este épico.

**2.4 — Raiz comum.** Os três são o mesmo defeito: **o envio é tratado como uma chamada atômica, não como um processo.** D4 já decidiu que não é — base de dados e provider são sistemas externos sem transação distribuída. ODI-001 materializa D4.

---

## 3. Máquina de estados de saída — consumida, não definida

**Fonte:** normatização de transições de E2.1, delegada por D7. **ODI-001 não redefine o conjunto de estados; declara como o usa.**

A progressão de saída percorre, sobre o eixo monotônico de D7:

```
intenção → tentativa → resultado → estado terminal de progresso | estado terminal de exceção
```

Traduzida para os estados canônicos:

```
(intenção)  pending  →  sending  →  sent  →  delivered  →  read     [progresso, monotônico]
                                    ↘ failed                          [exceção — regra própria, D7]
```

**Regras que ODI-001 fixa sobre esse consumo:**

1. **A intenção nasce em estado pré-envio** (`pending`/`sending`, conforme a normatização de E2.1). O estado exato é o que E2.1 definir; ODI-001 exige apenas que exista um estado **anterior à confirmação do provider** e que ele seja persistido antes da chamada (§4).
2. **`failed` é estado terminal de exceção**, sujeito à regra própria de D7 — não pertence ao eixo monotônico e pode ser alcançado a partir de qualquer estado pré-terminal de progresso.
3. **A transição é condicional ao estado atual, nunca incondicional** (§9).

**Dependência dura registrada:** o `CHECK` de `messages.status` no baseline `313cff5` ainda é o original de 001 e **não contém `received`/`pending`**. ODI-001 pressupõe que E2.1 tenha ampliado esse conjunto antes da implementação de E4a. Se, no momento da execução, a ampliação não estiver no schema, ela é pré-condição de E4a e não trabalho de E4a — ver §14.

---

## 4. Persistência anterior ao envio — resolve C17

**Autorizado por D4.**

A mensagem de saída é **criada como intenção antes** da chamada ao provider, em estado pré-envio. A criação é responsabilidade da **camada de entrega** (`DLB-001` §3), único proprietário da criação de mensagem de saída.

Consequência normativa: **toda tentativa de envio tem uma linha desde o primeiro instante.** Sucesso a transiciona; falha a transiciona; um processo que morre no meio a deixa em estado pré-envio recuperável (§9, e reprocesso em E4b). Em nenhum caminho a mensagem deixa de existir.

**Origem da recuperabilidade segura (C3).** A recuperação de uma intenção interrompida é segura por causa da **idempotency-key** (§6), não da granularidade entre estados pré-envio. Um processo que morre depois da chamada ao provider mas antes da liquidação deixa a mensagem num estado pré-envio indistinguível do de uma que morreu antes da chamada; o que torna o reenvio seguro apesar disso é a chave estável — E4b reenvia com a mesma chave sem risco de double-send. Por isso a idempotency-key é pré-requisito de E4b (§14), e por isso a recuperabilidade **não** depende de `pending` e `sending` serem estados distintos.

Isto substitui o comportamento atual de "inserir após sucesso" (§2.1). A mudança é de ordem, não de local: a persistência continua na camada de entrega, apenas **antes** em vez de **depois**.

---

## 5. Liquidação em modo de transição — modo-2 de DLB-001 §6.3

**Autorizado por `DLB-001` §6.3, que desenhou a liquidação para este uso.**

A operação de liquidação de `DLB-001` §6.2 — `SECURITY DEFINER`, transacional, que grava estado resultante e identidades declaradas num único ato — passa a operar em **modo-2**:

- **Modo-1 (E2.0, vigente):** cria a mensagem já liquidada com suas identidades.
- **Modo-2 (E4a, este contrato):** **transiciona** a intenção já existente — criada em §4 — para o estado resultante, anexando as identidades declaradas pelo provider.

`DLB-001` §6.3 exige que E4a **acrescente a etapa de intenção à frente da liquidação, sem reescrevê-la.** ODI-001 honra isso: a liquidação recebe agora uma mensagem que já existe, e a transiciona em vez de criá-la. A atomicidade de `EIS-001` §5.2 é preservada — estado e identidades num único ato, ou nada.

**Sucesso** → transição para o estado de confirmação (`sent`) + identidades; liquidação retorna `outcome = 'sent'`.
**Falha** → transição para `failed` (§8), sem identidades de sucesso; liquidação retorna `outcome = 'failed'`.
**Já no estado-alvo** → nenhuma transição; liquidação retorna `outcome = 'noop'`.

### 5.1 SettlementResult — retorno explícito da liquidação

**Parte da interface contratual da liquidação.** A operação de liquidação não retorna apenas o identificador da mensagem: retorna **qual transição esta invocação efetuou**, ou que nenhuma foi efetuada. Um único booleano é insuficiente — uma transição para `failed` também é uma transição efetiva, e o gate de efeitos de sucesso (§7) não pode disparar sobre ela.

```
SettlementResult = { messageId, outcome }
  outcome = 'sent'    → esta invocação transicionou a intenção para `sent`   (sucesso efetivo)
  outcome = 'failed'  → esta invocação transicionou a intenção para `failed` (falha efetiva)
  outcome = 'noop'    → a mensagem já estava no estado-alvo (retomada, reenvio, concorrência)
```

Este retorno é **o mecanismo que viabiliza o gate de N-3** (§7) e a resolução de concorrência (§9). Sem ele, o chamador não tem como distinguir sucesso efetivo, falha efetiva e repetição — e o gate de efeitos seria indecidível ou dispararia efeitos de sucesso sobre uma falha. `outcome` é o análogo, no caminho de saída, do `wasInserted` do invariante A no caminho de entrada (`inbound-processor.ts:324`), com a distinção necessária entre os dois estados terminais que a saída possui e a entrada não.

A forma concreta do tipo é decisão de implementação; as **propriedades** — a liquidação sinaliza qual estado terminal aplicou, ou nenhum — são contratuais e não podem ser omitidas.

**Extensão aditiva, exclusiva do modo-2 (C2).** `SettlementResult` é acréscimo ao **modo-2** da liquidação, autorizado por `DLB-001` §6.3, que previu que E4a estenderia a liquidação sem reescrevê-la. Não redefine a assinatura atribuída a E2.0 por `DLB-001` §6.5: os chamadores em **modo-1** (criação, E2.0) permanecem compatíveis e ignoram o campo `outcome`. Nenhuma decisão de `DLB-001` ou `EIS-001` é alterada.

---

## 6. Idempotência do envio — resolve C18

**[SPEC]** derivado de D4.

Cada tentativa de envio carrega uma **chave de idempotência** que identifica unicamente a intenção. A chave:

1. É **derivada da intenção**, não do momento da chamada — de modo que um retry da mesma intenção produza a **mesma** chave. Uma chave que varia a cada tentativa não impede double-send.
2. É **única por intenção** — de modo que intenções distintas nunca colidam. Uma chave que colide suprime envio legítimo.
3. Onde o provider suporta chave de idempotência nativa, ela é propagada. Onde não suporta, a chave governa a decisão local de reenvio antes de contatar o provider.

### 6.1 Ciclo de vida — a chave pertence à intenção

**Normativo.** A idempotency-key é **criada junto com a intenção** (§4), no mesmo ato e antes de qualquer chamada ao provider, e é **propriedade persistida da intenção** — não um valor recalculado a cada tentativa.

Consequência sob concorrência e retomada: toda tentativa que se refira àquela intenção — primeira chamada, retry após timeout, retomada por outro processo — **lê a mesma chave já gravada**, em vez de derivá-la de novo. Isso remove a ambiguidade de duas derivações concorrentes produzirem chaves divergentes para a mesma intenção. A chave nasce com a linha e vive com ela.

**Armazenamento (B2).** A idempotency-key é persistida como **coluna da própria mensagem** (`messages`), gravada no ato de criação da intenção (§4). Essa migration é **escopo próprio de ODI-001** — aditiva, idempotente, independente da ampliação do `CHECK` de status herdada de E2.1 (§3, §14). É a razão de a chave poder ser relida em vez de recalculada: ela reside na mesma linha que a tentativa de envio referencia. A derivação do valor é decisão de implementação dentro deste contrato; **o local de persistência é contratual** e está fixado aqui.

O que ODI-001 fixa são três propriedades — estabilidade sob retry, unicidade entre intenções, **criação atômica com a intenção** — e o local de armazenamento acima.

**Fronteira com E4b:** a idempotency-key impede o *dano* do retry (double-send). Ela **não** decide *quando* retry ocorre — isso é E4b. ODI-001 garante que, se um retry acontecer, ele não duplica.

---

## 7. Gate de deduplicação de efeitos de saída — resolve N-3

**Autorizado por `ADR-MSG-001` §12, que atribuiu N-3 a este épico, e modelado sobre o invariante A.**

O caminho de saída passa a ter um gate de efeitos colaterais **espelhando o do caminho de entrada** (`inbound-processor.ts:324`).

**Requisito de simetria — normativo.** O gate de saída deve ter a **mesma forma** do gate de entrada, não um mecanismo divergente. O invariante A estabelece: a persistência sinaliza se a linha foi de fato transicionada por *esta* operação ou se já estava no estado-alvo; os efeitos colaterais disparam **apenas** quando a transição foi efetiva.

O sinal é o `SettlementResult.outcome` de §5.1. O gate é a regra: **os efeitos de saída disparam se e somente se `outcome === 'sent'`.** Uma transição para `failed` (`outcome === 'failed'`) e uma repetição (`outcome === 'noop'`) **não** disparam os efeitos de sucesso.

Aplicado aos efeitos de saída reais — **pausa de Flow e contador de Broadcast** —, cada um dispara uma única vez, na transição efetiva para `sent`. Uma retomada, um reenvio ou uma liquidação que encontre a mensagem já em `sent` (`outcome === 'noop'`) não os re-dispara.

> **Fronteira de enumeração (B1).** "Marcação de resposta" **não** é efeito de saída: `flagBroadcastReplyIfAny` (`inbound-processor.ts:105,:343`) marca um destinatário de broadcast como `replied` quando o **cliente envia uma mensagem de entrada**, e já é governada pelo gate do invariante A no caminho de entrada. Não pertence a este contrato e foi removida da enumeração. ODI-001 não move esse efeito para a saída.

**O que este contrato NÃO especifica — fronteira deliberada.** ODI-001 fixa a *propriedade* (efeitos disparam uma vez, na transição efetiva para `sent`) e o *sinal* que a viabiliza (`SettlementResult.outcome`). Não especifica **onde** cada efeito de saída é executado, nem atribui a execução de pausa de Flow ou contadores de Broadcast a nenhuma camada em particular — esses efeitos são de domínio próprio (Flow, Broadcast) e continuam onde já residem. ODI-001 apenas exige que, onde quer que disparem, sejam **condicionados a `outcome === 'sent'`**. A camada de entrega produz o sinal; ela não passa a ser dona dos efeitos.

**Distinção que o contrato preserva:** dedup de persistência (a mensagem não vira duas linhas) já é garantida pela liquidação transacional. Dedup de **efeitos** (os efeitos não disparam duas vezes) é o que N-3 acrescenta. São problemas distintos — é a lição registrada no invariante A e a razão de ele existir.

---

## 8. Visibilidade de falha — completa C17

**Autorizado por D4 e pela regra de estados terminais de D7.**

`failed` é estado **terminal observável no inbox**. O operador vê a mensagem que falhou ao ser enviada, em estado de falha explícito, com informação suficiente para decidir reenvio.

Isto fecha C17: a falha deixa de ser ausência de linha e passa a ser presença de estado. A renderização no inbox é parte do escopo de E4a; a política de reenvio pelo operador não é (é interação de produto, não integridade de fluxo).

---

## 9. Concorrência

**[SPEC]** derivado de `DLB-001` §6.1.

Duas tentativas simultâneas de enviar a mesma intenção não podem produzir duas transições. A transição de estado é **condicional ao estado atual** (compare-and-set semântico), não incondicional: transiciona-se `sending → sent` apenas se o estado ainda for `sending`. A liquidação `SECURITY DEFINER` transacional de `DLB-001` §6.1 é a fronteira onde essa condição é avaliada atomicamente.

Consequência: de duas liquidações concorrentes da mesma intenção, exatamente uma efetua a transição; a outra encontra o estado já alterado e é no-op — o que, por §7, também significa que os efeitos colaterais disparam uma única vez.

---

## 10. Escopo de alteração

**Modificados**

| Arquivo | Mudança |
|---|---|
| `src/lib/whatsapp/delivery/sender.ts` | Cria a intenção antes da chamada (§4); invoca a liquidação em modo-2 (§5); **produz e propaga o `SettlementResult`** (§5.1) |
| `src/lib/whatsapp/delivery/` (liquidação) | Modo-2: transição condicional em vez de criação; retorna `SettlementResult` (§5, §5.1, §9) |
| `src/app/api/whatsapp/send/route.ts` | Deixa de inserir após sucesso; delega o ciclo à camada de entrega |
| Sítios de efeito de saída (pausa de Flow, contador de Broadcast), **onde já residem** | Passam a condicionar o efeito a `SettlementResult.outcome === 'sent'` (§7). Nenhum efeito é movido para a camada de entrega. Marcação de resposta **não** entra — é efeito de entrada (B1) |
| Caminho de envio dos engines (`engine-send`) e broadcast, **na medida em que já passam pela camada de entrega após E1** | Consomem o ciclo de intenção→liquidação; não reimplementam |
| Inbox (renderização) | Estado `failed` visível (§8) |

**Novos**

| Arquivo | Conteúdo |
|---|---|
| Migration aditiva — idempotency-key | Coluna de idempotency-key em `messages` (§6.1). **Escopo próprio de ODI-001**, idempotente, aditiva, independente de E2.1 |
| Migration aditiva — estados | **Somente se** E2.1 não tiver ampliado o `CHECK` de `messages.status` para conter os estados pré-envio (§3, §14). Herdada de E2.1, não é trabalho de E4a |
| Testes de integridade de saída | Critérios de §11 |

**Protegido — não tocar**

```
src/lib/whatsapp/inbound-processor.ts:324   (gate de entrada — espelhar, nunca alterar)
supabase/migrations/001–047                 (histórico fechado — só ADICIONAR)
```

ODI-001 não amplia a lista de arquivos além do caminho de saída. Nenhuma refatoração fora do épico.

---

## 11. Critérios de aceitação

1. Toda tentativa de envio cria uma linha de mensagem **antes** da chamada ao provider, em estado pré-envio.
2. Provider retorna erro → a linha existe em `failed`, visível no inbox (C17).
3. Provider retorna sucesso → a linha transiciona para `sent` com as identidades declaradas, num único ato (liquidação modo-2), e a liquidação retorna `outcome = 'sent'`.
3a. Liquidação que encontra a mensagem já em `sent` retorna `outcome = 'noop'` e não reescreve identidades (§5.1).
3b. Transição para `failed` retorna `outcome = 'failed'` e **não** dispara efeitos de sucesso (§7, A1).
4. Um processo interrompido entre a criação da intenção e a liquidação deixa a mensagem em estado pré-envio **recuperável**, nunca perdida.
5. Retry com a **mesma** intenção usa a **mesma** idempotency-key e produz **um** envio real (C18).
6. Duas intenções distintas nunca compartilham idempotency-key.
7. Reenvio ou liquidação repetida de mensagem já em `sent` **não re-dispara** efeitos colaterais — flow não repausa, contador de broadcast não reincrementa (N-3). Verificado pelo disparo condicionado a `SettlementResult.outcome === 'sent'` (§7). *(Marcação de resposta não consta: é efeito de entrada — B1, §7.)*
8. O gate de efeitos de saída tem a **mesma forma** do gate de entrada (`inbound-processor.ts:324`) — efeito condicionado ao sinal de transição efetiva para o estado de sucesso —, verificado por inspeção estrutural.
8a. A idempotency-key é criada com a intenção, **persistida na linha da mensagem** e relida — não recalculada — em toda tentativa subsequente (§6.1).
9. Duas liquidações concorrentes da mesma intenção produzem exatamente uma transição e um disparo de efeitos (§9).
10. **Caminho Meta sem regressão observável** — suíte Meta verde antes e depois.
11. `tsc --noEmit`, `vitest run`, `next build` verdes.

---

## 12. Conformidade com o ADR

| Cláusula do ADR | Como este documento a cumpre |
|---|---|
| D4 — envio como processo de estados | §3, §4, §5, §8 |
| D4 — persistir antes, transicionar por resultado | §4, §5 |
| Invariante A — dedup de persistência ≠ de efeitos | §7, gate de saída espelhando o de entrada; `SettlementResult.outcome` (§5.1) é o análogo de `wasInserted`, com a distinção entre os dois estados terminais que a saída possui |
| D7 — monotonicidade + estados terminais de exceção | §3, `failed` fora do eixo monotônico |
| `DLB-001` §6.2/§6.3 — liquidação, modo-2 | §5 |
| `DLB-001` §6.4 — ponto reservado para o gate | §7 |
| `EIS-001` §5.2 — atomicidade estado+identidades | §5 |

**Nenhuma decisão do ADR foi alterada, ampliada ou reinterpretada.** Cláusulas **[SPEC]** — revisáveis sem reabrir o ADR: idempotency-key, seu ciclo de vida e seu armazenamento (§6, §6.1), forma do `SettlementResult` (§5.1), condicionalidade da transição (§9).

---

## 13. Riscos

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| 1 | Regressão no caminho Meta em produção — E4a altera a ordem de persistência de todo envio | **Alta** | Suíte Meta verde antes e depois; assinatura preservada atrás da liquidação (`DLB-001` §6.3); smoke manual antes do push |
| 2 | E4a absorver escopo de E4b (reprocesso, orquestração de retry) | **Média** | Fronteira declarada em §1.2, §6 e §8: E4a garante não-duplicação, E4b garante reprocesso |
| 3 | Gate de saída implementado por forma divergente do invariante A | **Média** | Requisito de simetria normativo (§7); critério 8 verifica por inspeção estrutural |
| 4 | Intenção presa em estado pré-envio se o processo morre antes da liquidação | **Média** | §4 exige estado recuperável; a recuperação é de E4b — E4a não a resolve, mas não cria beco sem saída |
| 5 | Idempotency-key mal derivada — colisão suprime envio; variação permite double-send | **Média** | Duas propriedades fixadas em §6; critérios 5 e 6 testam os dois modos de falha |
| 6 | Transição incondicional sob concorrência | **Média** | Compare-and-set na liquidação transacional (§9); critério 9 |

---

## 14. Dependências

**Bloqueado por:**

- **E2.1** — a máquina de estados de saída que ODI-001 consome (§3). **Pré-condição verificável:** o `CHECK` de `messages.status` deve conter os estados pré-envio antes da implementação de E4a. No baseline `313cff5` ele **não os contém** — o `CHECK` é ainda o original de 001. Se E2.1 não tiver ampliado o `CHECK` no momento da execução, essa ampliação é pré-requisito de E4a, herdado de E2.1, e não trabalho de E4a.
- **E1** — a camada de entrega, proprietária da criação de mensagem de saída (`DLB-001`). Vigente.
- **E2.0** — a liquidação em modo-1 e o canal de identidades (`EIS-001`, `DLB-001` §5). Vigente.

**Bloqueia:** E4b — o reprocesso assíncrono consome os estados e a idempotency-key que ODI-001 define. A recuperação segura de intenções interrompidas depende dessa chave (§4, C3), não da granularidade de estados pré-envio.

**Não bloqueia, mas coabita:** E3 — quando `connection_ref` for promovido a `connections.id`, o caminho de saída acompanha o re-pointing sem alteração semântica (`EIS-001` §3.2).

**Recomendação de sequência.** E4b **não** deve correr em paralelo a E4a, embora esteja tecnicamente desbloqueado desde E2.1: ambos tocam o caminho de saída, e E4b consome os estados que E4a define. Sequencial `E4a → E4b` mantém a fronteira limpa. O ponto de atrito é o risco 4 — a intenção presa, que E4a deixa recuperável e E4b recupera.

---

## 15. Registro de revisão — v1 → v2

### Correções incorporadas

| # | Achado | Onde |
|---|---|---|
| **1** | **`SettlementResult` — retorno explícito da liquidação.** O mecanismo pelo qual a liquidação informa se a transição foi efetivamente aplicada passa a ser parte da interface contratual. É ele que viabiliza o gate de N-3 e a resolução de concorrência — sem ele, o gate seria indecidível. | **§5.1** (novo); §7 (sinal nomeado); §9; §10; §11 critérios 3, 3a, 7, 8; §12 |
| **2** | **Ciclo de vida da idempotency-key.** A chave é declarada explicitamente como pertencente à intenção e criada junto com ela, no mesmo ato e antes de qualquer chamada — removendo a ambiguidade de duas derivações concorrentes produzirem chaves divergentes. | **§6.1** (novo); §11 critério 8a; §12 |

### Pontos avaliados e não incorporados

Dois pontos foram levantados na revisão como bloqueadores e **não procedem como contradições do contrato** — decorrem de interpretações possíveis do texto, agora fechadas por redação, sem mudança de substância.

| Ponto | Por que não é bloqueador | Redação ajustada |
|---|---|---|
| *"A migration condicional de §3/§10 redefine a máquina de estados."* | Confunde **materialização de schema** com **autoridade normativa**. A máquina de estados é definida por E2.1 (delegado por D7); ODI-001 a **consome**. A migration condicional apenas materializa no schema o `CHECK` que E2.1 já normatizou, **se** ele ainda não estiver aplicado (§14). Materializar não é redefinir. | §3 e §14 já diziam "consome, não define"; nenhuma alteração de substância necessária |
| *"O contrato atribui efeitos de Flow/Broadcast à Delivery Layer."* | Assume um **local de execução do gate** que o contrato não especificava. ODI-001 fixa a *propriedade* (efeito dispara uma vez) e o *sinal* (`SettlementResult`), não onde cada efeito roda. A leitura vinha da linha de §10 que dizia a `sender.ts` "aplica o gate de efeitos". | **§7** (bloco "O que este contrato NÃO especifica"); **§10** (linha reescrita: efeitos permanecem onde residem, apenas condicionados a `transitioned`) |

Ambos os ajustes são de **clareza de fronteira**, não de decisão. Nenhuma cláusula normativa mudou de conteúdo; o que mudou foi o fechamento de duas leituras que o texto v1 permitia.

---

### v2 → v3 — revisão adversarial arbitrada no código

Cinco emendas. Nenhuma reabre `ADR-MSG-001`, `DLB-001` ou `EIS-001`; nenhuma amplia escopo ou introduz decisão nova. Todas fecham lacunas internas ou fronteiras mal-explicitadas.

| Achado | Sev. | Correção | Cláusulas |
|---|---|---|---|
| **A1** | Bloqueador | `SettlementResult` deixa de ser `{transitioned: boolean}` e passa a `{messageId, outcome ∈ 'sent'\|'failed'\|'noop'}`. O gate de N-3 dispara **se e somente se `outcome === 'sent'`** — nunca em `failed`, nunca em `noop`. Elimina a ambiguidade em que uma transição de falha dispararia efeitos de sucesso. | §5.1, §5, §7, §12; critérios 3, 3a, 3b, 7, 8 |
| **B1** | Alto | "Marcação de resposta" removida da enumeração de efeitos de saída. `flagBroadcastReplyIfAny` é efeito de **entrada** (`inbound-processor.ts:105,:343`), já governado pelo invariante A. Nenhuma responsabilidade movida entre domínios — apenas correção da enumeração. | §7, §10; critério 7 |
| **B2** | Alto | Armazenamento da idempotency-key declarado: **coluna em `messages`**, migration de escopo próprio de ODI-001, aditiva, independente da migration de estados herdada de E2.1. | §6.1, §10; critério 8a |
| **C2** | Médio | `SettlementResult` declarado como extensão **aditiva exclusiva do modo-2**; modo-1 (E2.0) permanece compatível e ignora `outcome`. Não redefine a assinatura atribuída a E2.0 por `DLB-001` §6.5. | §5.1 |
| **C3** | Médio | Recuperabilidade de intenção interrompida declarada como dependente da **idempotency-key**, não da granularidade `pending`/`sending`. | §4, §14 |

**Achado D1** (o `CHECK` de status não contém `pending` no baseline) permanece registrado em §14 como dependência de E2.1 — não é achado novo e não exigiu emenda.
