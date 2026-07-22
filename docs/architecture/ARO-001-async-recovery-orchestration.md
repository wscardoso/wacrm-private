# ARO-001 — Async Recovery & Retry Orchestration Contract

| | |
|---|---|
| **Tipo** | Contrato derivado (design document) — **fase de arquitetura, sem código** |
| **Deriva de** | `ADR-MSG-001 v4` — **D4** (envio como processo de estados), **D7** (monotonicidade + estados terminais de exceção), **invariante A** (dedup de persistência ≠ dedup de efeitos) · `ODI-001 v3` §4, §5, §6, §9, §14 (fronteira E4a→E4b, idempotency-key, recuperabilidade C3) · `DLB-001` §6 (fronteira transacional e liquidação) · `ADR-E4B-001` (Opção A — falha reenviável permanece `sending`) · `ADR-E4B-002` (política de recuperação de ambiguidade, capability-gated) · `ADR-E4B-003` (contrato estrutural de capability do Provider) |
| **Épico consumidor** | E4b — Async Reliability (Recovery / Retry Orchestration) |
| **Resolve** | **R10** (DLQ morta + monitor falso-positivo) · **risco 4 de ODI-001** (intenção presa em estado pré-envio) · reprocesso assíncrono de saída (`MASTER-ROADMAP` §7) · **§23-B** e **§23-C** (bloqueadores de início, ver §20/§23) |
| **Status** | **v3** — consolida `ADR-E4B-001`, `ADR-E4B-002` e `ADR-E4B-003` no contrato de arquitetura de E4b. Ver §26 (registro de revisão v2→v3). Histórico: Gate v2 **APPROVED WITH MINOR CHANGES** (§25). |
| **Autoridade** | **Não altera** decisão do ADR nem cláusula de `ODI-001`, `DLB-001` ou `EIS-001`, que permanecem fechados. Consome a idempotency-key, os estados, a liquidação que E4a entregou, e o contrato de capabilities de `ADR-E4B-003`. **§23-B e §23-C, antes candidatos a ADR, estão resolvidos** por `ADR-E4B-001` e por `ADR-E4B-002`/`ADR-E4B-003` respectivamente (§20, §23). Onde a arquitetura tocar uma fronteira ainda fechada, o ponto continua sendo elevado a candidato a ADR, não decidido aqui. |
| **Baseline de código** | HEAD `8057b22` |

---

## 1. Objetivo do épico

Dar **orquestração de recuperação e reenvio** ao caminho de saída: decidir **quando** uma tentativa de entrega é repetida, **quantas vezes**, **com que espaçamento**, **por quanto tempo**, e **para onde vai** uma intenção que esgota suas tentativas ou nunca se liquida.

E4a (`ODI-001`) tornou o envio um processo de estados e garantiu que **um retry não duplica** (idempotency-key + compare-and-set). E4a **não** decide se, quando ou como o retry ocorre. ARO-001 fecha exatamente essa lacuna, e apenas ela: transforma a **recuperabilidade** que E4a deixou disponível em **recuperação efetivamente executada**.

**Uma frase:** E4a garantiu que retry é *seguro*; ARO-001 define quando retry *acontece* e o que fazer quando ele *não resolve*.

---

## 2. Problema que será resolvido

Verificado no baseline `8057b22`.

**2.1 — Intenção presa em `sending` não tem quem a recupere.** `ODI-001` §4 estabelece que uma intenção criada antes da chamada ao provider deixa a mensagem em estado pré-envio (`sending`) recuperável. Um processo que morre entre `createIntent` (`settlement.ts`) e `settleMessage` deixa a linha em `sending` **para sempre** — não há sweeper, cron ou fila que a reprocesse. É o **risco 4 de ODI-001**, explicitamente deixado para E4b (`ODI-001` §13, §14).

**2.2 — Falha transitória vira terminal imediatamente.** Em `sender.ts`, o bloco `catch` liquida a intenção como `failed` em **qualquer** exceção do provider (timeout, 429, 5xx, erro de rede). Como `failed` é estado **terminal** (`ODI-001` §3, §8), uma falha meramente transitória é hoje indistinguível de uma rejeição definitiva do provider, e **nenhuma** delas é reenviada automaticamente. O sistema tem a chave que torna o retry seguro (§6 de ODI-001) e **não a usa**.

**2.3 — A DLQ existe e está morta.** `whatsapp_webhook_dlq` (migration 031) foi criada com `retry_count`, `last_retry_at`, `status ∈ (pending, resolved, abandoned)` e RPC de enfileiramento — mas nunca foi ligada a um drenador. É o achado **R10** (`MASTER-ROADMAP` §9): DLQ morta + monitor de `QUICK_REFERENCE` que reporta "DLQ vazia" como saúde quando na verdade nada a alimenta. Nota: 031 é DLQ do caminho de **entrada** (webhook); ARO-001 trata a confiabilidade do caminho de **saída**, e **reusa o padrão**, não a tabela.

**2.4 — Raiz comum.** O caminho de saída tornou-se um processo de estados (D4), mas ninguém **conduz** esse processo ao longo do tempo. Falta o componente temporal: a peça que observa intenções não-terminais, decide o próximo passo e o executa fora do request original.

---

## 3. Motivação

- **Integridade prometida, não entregue.** E4a prometeu recuperabilidade (`ODI-001` §4, C3). Sem E4b, essa promessa é apenas potencial: a linha existe em `sending`, mas nada a resolve. A dívida é a diferença entre "a mensagem não se perde" e "a mensagem chega".
- **Falhas transitórias são a maioria das falhas de rede.** 429 e 5xx de provider são recuperáveis por natureza. Tratá-las como terminais transfere ao operador um trabalho que a máquina deveria fazer, e degrada a taxa de entrega real sem necessidade.
- **A chave já está no lugar.** `idempotency_key = messages.id` (migration 048) foi desenhada precisamente para que E4b reenvie com a **mesma** chave sem risco de double-send (`ODI-001` §6.1, §14). O custo de construção do retry já foi pago em E4a; E4b só o ativa.
- **R10 é uma falsa sensação de segurança.** Um monitor que reporta verde sobre uma DLQ morta é pior que nenhum monitor. Fechar E4b corrige o wiring **e** a documentação do monitor.

---

## 4. Escopo

### 4.1 O que este contrato especifica

1. A **taxonomia de resultado de tentativa** que decide o que é reenviável e o que é terminal (transitório × permanente) — no nível de *propriedade*, com a classificação concreta elevada a ADR (§23-A).
2. O **registro de reprocesso de saída** (retry ledger / outbound DLQ): a estrutura que guarda tentativa, contagem, próximo horário, último erro e estado de reprocesso de uma intenção não-terminal.
3. A **política de retry**: teto de tentativas, condição de reenvio, condição de desistência.
4. O **scheduler**: o mecanismo temporal que drena intenções devidas, reusando o padrão de cron já vigente no repositório.
5. O **backoff**: o espaçamento entre tentativas.
6. O **TTL**: o horizonte máximo de vida de uma intenção não-liquidada.
7. A **DLQ de saída**: o destino terminal de uma intenção que esgota tentativas ou é classificada como permanente, e sua superfície para intervenção.
8. O **recovery de intenções `sending` órfãs** (crash antes da liquidação).
9. A **relação com `failed`** — o que E4b faz, e o que **não** faz, com o estado terminal de exceção que E4a define.

### 4.2 O que este contrato não especifica

- A **implementação** de qualquer um dos itens acima — este é um documento de arquitetura. Não há código, patch, migration escrita nem teste neste épico até o Gate Arquitetural aprovar o documento.
- A **reescrita da liquidação** (`settle_outbound_message`, migration 048). ARO-001 **consome** o RPC como está; não o altera (§10, §23-B).
- A **máquina de estados canônica** (E2.1 / D7). ARO-001 consome os estados; propor um **novo** estado intermediário reabre E2.1 e é candidato a ADR (§23-D), não decisão deste documento.
- A **política de reenvio pelo operador** (botão "reenviar" no inbox). É interação de produto (`ODI-001` §8), não orquestração assíncrona.
- **Broadcast delivery em lote** como orquestração própria. Broadcast permaneceu na camada provider (E1) sem intent/settlement por decisão arquitetural própria; trazê-lo para o ciclo de intenção→liquidação→retry é épico ou ADR à parte (§23-E), não escopo de ARO-001.
- **Multi-conexão / `connections`** (E3). ARO-001 opera sobre `connection_ref` no regime transitório de `EIS-001` §3.2, sem alteração semântica.
- O **caminho de entrada** (`inbound-processor.ts`, `whatsapp_webhook_dlq`). ARO-001 espelha o *padrão* de 031, não toca a tabela nem o fluxo de entrada.

### 4.3 Rastreabilidade

Cláusula sem citação de decisão do ADR ou de contrato fechado é design livre e está marcada **[SPEC]** — revisável sem reabrir o ADR.

---

## 5. Não objetivos

1. **Não** reabrir a semântica de `failed` como estado terminal (D7, `ODI-001` §3). A questão de falhas transitórias permanecerem em estado não-terminal foi **decidida por `ADR-E4B-001`** (Opção A: transitório permanece `sending`, `failed` permanece terminal) — não é redefinição unilateral aqui.
2. **Não** implementar transação distribuída banco↔provider. D4 já a rejeitou; ARO-001 herda a rejeição.
3. **Não** garantir *exactly-once delivery* de ponta a ponta. A garantia é **at-least-once com dedup de dano** (idempotency-key + compare-and-set): a mesma intenção pode ser tentada N vezes, mas produz **um** envio efetivo onde o provider suporta idempotência nativa, e é objeto de reconciliação onde não suporta (§23-C).
4. **Não** substituir o monitoramento por observabilidade estruturada (correlation IDs, logs) — isso é E13. ARO-001 corrige o wiring da DLQ e o monitor falso-positivo de R10; não constrói a plataforma de observabilidade.
5. **Não** absorver a marcação de resposta, pausa de Flow ou contadores de Broadcast. Esses efeitos são governados pelo gate de N-3 (`ODI-001` §7), condicionados a `outcome === 'sent'`. ARO-001 **preserva** esse gate: um retry que finalmente liquide `sent` dispara os efeitos **uma vez**; um retry que dê `noop` não os dispara.

---

## 6. Responsabilidades do E4b

| # | Responsabilidade | Fronteira |
|---|---|---|
| R-1 | Classificar o resultado de uma tentativa de entrega como **reenviável** ou **terminal** | A *propriedade* é de ARO-001; a *taxonomia concreta* por provider é ADR (§23-A) |
| R-2 | Persistir o estado de reprocesso de uma intenção não-liquidada (tentativas, próximo horário, último erro) | Tabela nova, escopo próprio de E4b, aditiva |
| R-3 | Decidir **quando** cada intenção devida é reprocessada | Scheduler (§12), reusando o padrão de cron vigente |
| R-4 | Reexecutar a entrega de uma intenção **existente**, com a **mesma** idempotency-key, sem criar nova intenção | Consome `provider.send` + `settle_outbound_message`; **não** chama `createIntent` de novo (§10) |
| R-5 | Recuperar intenções `sending` órfãs (crash antes da liquidação) | §16 |
| R-6 | Encerrar em DLQ intenções que esgotam tentativas ou excedem TTL | §14, §15 |
| R-7 | Corrigir o wiring da DLQ e o monitor falso-positivo de R10 | §15 |
| R-8 | Preservar o gate de efeitos de saída (N-3) através de todos os reenvios | Herdado de `ODI-001` §7 (§5.5 acima) |

E4b **não** é responsável por: criar a intenção (é da camada de entrega, `DLB-001` §3), definir os estados (E2.1), executar os efeitos colaterais (domínios Flow/Broadcast), nem escolher provider (`getProvider`, `DLB-001` §7).

---

## 7. Componentes previstos

Nomes são **[SPEC]** — indicativos, sujeitos a nomeação final na implementação. O que é contratual é a *responsabilidade*, não o identificador.

| Componente | Papel | Análogo existente (padrão a reusar) |
|---|---|---|
| **Outbound retry ledger** (tabela nova) | Guarda, por intenção não-terminal: referência à mensagem (`= idempotency_key = messages.id`), `attempt_count`, `next_attempt_at`, `last_error`, `classification`, `status ∈ (pending, retrying, delivered, dead)` | `whatsapp_webhook_dlq` (031) — mesma forma, caminho de saída |
| **Failure classifier** | **Árvore de decisão** (`ADR-E4B-002` §5 item 3): primeiro determina se o desfecho é conhecido (certeza de não-entrega) ou **ambíguo**; só sobre desfecho conhecido aplica `reenviável | permanente`. Consome a **classe de domínio** já emitida pelo Provider Adapter (`ADR-E4B-003` §3.4) — nunca a resposta bruta do provider. **Função de domínio** consultada a partir de dois pontos — a tentativa **síncrona** (dentro da fronteira da camada de entrega, no resultado do envio original) e o **scheduler** (nas tentativas subsequentes). É consumida por ambos, **não pertence exclusivamente a nenhum** e reside dentro do domínio de saída (`DLB-001` §3). A taxonomia concreta de erros por provider permanece §23-A — este componente consome a classe já traduzida, não os erros brutos que a originam | `ADR-E4B-002` §5 item 3 (árvore de decisão); `ADR-E4B-003` §3.4 (canal da classe); taxonomia de erro concreta ainda §23-A |
| **Retry scheduler / drainer** | Rota drenada por cron: seleciona intenções `next_attempt_at <= now()`, reivindica (claim-as-lock), reexecuta entrega | `automations/cron`, `flows/cron` + `automation_pending_executions` (006) |
| **Orphan sweeper** | Localiza intenções `sending` além de um limiar sem registro no ledger e as enfileira | — (novo; §16) |
| **Backoff policy** | Calcula `next_attempt_at` a partir de `attempt_count` | — (novo; §13) |
| **DLQ surface** | Consulta/visão das intenções em `dead` para operação | Monitor de `QUICK_REFERENCE` (corrigir, §15) |
| **Settlement (existente)** | `settle_outbound_message` (048) — **inalterado** | Reuso puro (§10) |

**Migration:** E4b introduz **uma** migration aditiva (a tabela do ledger e seus índices parciais, no padrão de 031). Não altera 001–048. Se a orquestração exigir um estado intermediário em `messages.status`, isso é decisão separada (§23-D) e **não** entra sem ADR.

---

## 8. Fluxo arquitetural completo

### 8.1 Caminho feliz (inalterado por E4b)

```
createIntent (sending) → provider.send → settle(sent)  → outcome=sent  → efeitos N-3
```

Nenhuma mudança. E4b só entra quando o caminho feliz **não** se completa.

### 8.2 Caminho com falha reenviável (o que E4b acrescenta)

```
createIntent (sending) → provider.send ✗ (timeout/429/5xx)
        │
        ▼
  classifier → REENVIÁVEL
        │
        ▼
  enfileira no retry ledger (attempt_count=1, next_attempt_at = agora + backoff)
  intenção permanece em 'sending'         ◄── NÃO liquida 'failed' terminal
        │
        ▼  (scheduler, quando devido)
  claim → provider.send (mesma idempotency-key) → settle(...)
        │
        ├── outcome=sent   → ledger: delivered ; efeitos N-3 disparam UMA vez
        ├── outcome=noop   → ledger: delivered ; efeitos NÃO disparam (já liquidada)
        └── falha de novo  → classifier → REENVIÁVEL e attempt<teto e idade<TTL?
                                 ├── sim  → re-enfileira (backoff maior)
                                 └── não  → settle(failed) + ledger: dead (DLQ)
```

### 8.3 Caminho com falha permanente

```
provider.send ✗ (número inválido, 4xx definitivo)
        │
        ▼
  classifier → PERMANENTE → settle(failed) + ledger: dead   (sem retry)
```

### 8.4 Caminho de órfã (crash antes da liquidação)

```
createIntent (sending) → [processo morre] → linha presa em 'sending'
        │
        ▼  (orphan sweeper, idade > limiar, sem entrada no ledger)
  enfileira no ledger  → tratado como 8.2, com a ressalva de reconciliação (§16, §23-C)
```

**Observação de fronteira:** em 8.2, a decisão de **manter a intenção em `sending`** em vez de liquidá-la `failed` no primeiro erro é a mudança de comportamento que E4b introduz sobre o `catch` atual de `sender.ts`. Ela **não** contradiz `ODI-001` — que fixa `failed` como terminal *quando alcançado*, não que toda exceção deva alcançá-lo imediatamente — e foi **decidida por `ADR-E4B-001`** (Opção A, decisão consolidada), que ratificou manter a intenção em `sending`; `failed` permanece terminal.

---

## 9. Estados envolvidos

### 9.1 Estados de `messages.status` (consumidos, não redefinidos)

Conjunto canônico vigente (`001` + E2.1): `sending · sent · delivered · read · failed`. ARO-001 **consome**:

- **`sending`** — intenção não-liquidada. É o estado sobre o qual o retry e o sweeper operam. Compare-and-set de 048 só transiciona **a partir de** `sending`.
- **`sent`** — estado-alvo de sucesso. Uma vez alcançado, `noop` protege contra reescrita.
- **`failed`** — terminal de exceção (D7). E4b o alcança **apenas** ao desistir (teto/TTL/permanente), nunca como primeira reação a uma falha reenviável.

**ARO-001 não adiciona estado a `messages.status`.** Toda a máquina de retry vive no **ledger**, não na coluna de status da mensagem. Se um estado intermediário na mensagem se mostrar necessário, é §23-D (ADR), não este contrato.

**Consequência arquitetural do `sending` prolongado.** Como o retry vive no ledger e a mensagem só alcança um terminal na desistência (§8.2, §14, §17), uma intenção pode **permanecer em `sending` — estado não-terminal — por toda a janela de retry**, isto é, até o teto de tentativas, o TTL, ou uma resolução (`sent`/`failed`) o que ocorrer primeiro. Essa janela pode ser longa (backoff exponencial + TTL). ARO-001 **não altera** essa decisão — ela é a contrapartida direta de não liquidar `failed` no primeiro erro (§8.2, §23-B) e de o ledger, não a coluna de status, ser o portador do processo (§9.2). Registra-se apenas a consequência: durante essa janela a mensagem é observável em estado não-terminal. A **apresentação** dessa condição (como o inbox renderiza um `sending` prolongado) é interação de produto (`ODI-001` §8), fora do escopo de E4b; o que é arquitetural, e fica aqui declarado, é que o estado não-terminal persiste legitimamente por toda a janela.

### 9.2 Estados do retry ledger (novos, escopo próprio de E4b)

Espelham 031: `pending` (aguardando drenagem) · `retrying` (reivindicada por um drenador — claim-as-lock) · `delivered` (liquidada `sent`/`noop`, encerrada) · `dead` (DLQ — esgotou tentativas, excedeu TTL, ou permanente).

A separação é deliberada: **o status da mensagem descreve o fato do mundo** (foi enviada?); **o status do ledger descreve o processo de reprocesso** (estamos tentando?). São eixos distintos — a mesma lição do invariante A (persistência ≠ efeitos) aplicada a mensagem ≠ orquestração.

---

## 10. Integração com o Settlement existente

**Normativo.** ARO-001 **consome** `settle_outbound_message` (migration 048) **sem alteração**.

1. **Reenvio não cria intenção.** A intenção já existe (foi criada por `createIntent` no envio original, ou é uma órfã já presente). Um reenvio vai **direto** a `provider.send` + `settleMessage` sobre a **mesma** `messages.id`. Chamar `createIntent` de novo violaria a PK e a unicidade de `idempotency_key` — é proibido (R-4).
2. **A liquidação continua sendo a única fronteira transacional.** E4b nunca escreve `status` terminal diretamente na tabela `messages`; sempre via RPC. Compare-and-set (048) garante que, de N reenvios concorrentes ou tardios, exatamente um transiciona.
3. **`noop` é resultado esperado e benigno.** Um reenvio que encontre a mensagem já `sent` (ex.: callback do provider chegou entre tentativas) recebe `outcome=noop`. E4b trata `noop` como **sucesso do ponto de vista da orquestração** (ledger → `delivered`) e **não** dispara efeitos (`ODI-001` §7).
4. **`SettlementResult` é o sinal de controle do loop.** `sent` → encerra `delivered` + efeitos; `noop` → encerra `delivered` sem efeitos; `failed` → só é solicitado por E4b na desistência (§8.3, teto/TTL). O gate de N-3 (`outcome === 'sent'`) é preservado intacto através de todos os reenvios.
5. **Requisito de hardening herdado:** `sent` exige `provider_message_id` não-nulo (048). Um reenvio que "suceda" sem id de provider é rejeitado pela RPC — E4b trata a rejeição como falha reenviável, não como sucesso.

6. **Reconciliação entre ledger e mensagem — eixos que podem divergir.** O status da mensagem (fato do mundo) e o status do ledger (processo de reprocesso) são eixos distintos (§9.2) e podem, transitoriamente, divergir. O comportamento arquitetural esperado em cada caso:
   - **Liquidação conclui antes da atualização do ledger** (mensagem já `sent`/`failed`, ledger ainda `retrying`/`pending`): a **liquidação é a fonte de verdade**. Uma varredura subsequente que encontre uma intenção já resolvida no eixo da mensagem encerra o ledger de acordo (`delivered` para `sent`/`noop`; `dead` para `failed`) — sem novo `provider.send`. A intenção resolvida **não** é reprocessada. Observação: enquanto o ledger permanecer nessa divergência, ele é redundante com a mensagem, nunca contraditório — a mensagem manda.
   - **Callback de status resolve a intenção antes de um retry** (a via de status de E2.1 transiciona a intenção para fora de `sending` enquanto E4b a mantinha enfileirada): E4b trata o desfecho como **resolução terminal do ponto de vista da orquestração** e encerra o ledger (`delivered`), sem reenviar. A intenção deixou de estar em `sending`; o compare-and-set (048) já garante que nenhum reenvio a re-transicionaria.
   - **O retry encontra uma intenção já resolvida** (o reenvio é executado mas a mensagem já não está em `sending`): a liquidação retorna `noop`; o ledger é encerrado `delivered` e os efeitos N-3 **não** disparam (`ODI-001` §7). Este é o desfecho benigno esperado — porém sujeito à ressalva de §11 (o `provider.send` que precede o `noop` pode ter tocado a rede; a segurança desse toque em provider sem idempotência nativa é a dependência de §23-C).

   Em todos os três casos, **a mensagem (liquidação, 048) é a autoridade; o ledger é reconciliado a ela, nunca o contrário.** E4b não reescreve estado terminal para forçar coerência — apenas encerra o ledger conforme o estado já liquidado.

**Consequência:** E4b não adiciona nenhuma superfície de escrita de estado terminal. A integridade de `ODI-001` §5/§9 permanece sendo a única autoridade de transição. E4b apenas **decide quando invocar** essa autoridade, e **o que fazer entre invocações**.

---

## 11. Política de retry

**[SPEC]**, derivada de D4 e da fronteira de `ODI-001` §6.

- **Condição de reenvio:** resultado classificado como **reenviável** (§6 R-1, §23-A) **e** `attempt_count < teto` **e** `idade_da_intenção < TTL` **e** a segurança do reenvio determinada pela política capability-gated de `ADR-E4B-002` §5, consumindo o contrato de capabilities de `ADR-E4B-003` (**§23-C, resolvido**): provider com **Native Idempotency** declarada → reenvio direto com a mesma `idempotency_key`; provider com **Delivery Reconciliation** declarada (por correlação-cliente) → reconciliar antes de reenviar a classe ambígua; provider sem nenhuma das duas (Z-API, UAZAPI, hoje) → a classe ambígua **não** é reenviada automaticamente, permanece `sending` até o TTL (§14) e então liquida `failed`/`dead`. Falha **determinística** permanece reenviável independentemente de capability (`ADR-E4B-002` §2).
- **Ambiguidade de entrega — mesma classe arquitetural em todo o caminho de retry.** A ambiguidade tratada em §16 para a **órfã** (o processo pode ter enviado antes de morrer) **não é exclusiva da órfã**: um **timeout** ou qualquer **falha ambígua** durante uma tentativa ordinária (§8.2) tem a mesma natureza — a requisição pode ter alcançado o provider e sucedido, com a resposta perdida. Em provider com **idempotência nativa** (Meta), a mesma `idempotency_key` resolve no lado do provider e o reenvio é seguro. Em provider **sem** idempotência nativa (Z-API, uazapi — `DLB-001` §8), o reenvio de uma intenção sob resultado ambíguo arrisca double-send, **quer a intenção seja órfã, quer seja uma tentativa comum que deu timeout**. Portanto o guarda de §16 é **geral**: toda decisão de reenvio sob ambiguidade segue a **mesma** política capability-gated (**§23-C, resolvido por `ADR-E4B-002`/`ADR-E4B-003`**) em ambos os caminhos — idempotência nativa reenvia, reconciliação reconcilia, nenhuma bloqueia.
- **Nota sobre o alcance das proteções existentes.** O `compare-and-set` (048) e o `claim-as-lock` (§12) protegem a **transição no banco** e a **corrida entre drenadores concorrentes** — não o reenvio **sequencial** na rede. Como `provider.send` **precede** o `noop` (o `noop` só é conhecido após chamar o provider e liquidar), essas proteções não impedem, por si sós, um segundo envio efetivo na rede em provider sem chave nativa. É por isso que a política capability-gated de §23-C (`ADR-E4B-002`/`ADR-E4B-003`) é necessária além delas.
- **Teto de tentativas:** um máximo finito e configurável de tentativas por intenção. Esgotado o teto → DLQ (`dead`) + liquidação `failed`.
- **Unidade de idempotência:** toda tentativa da mesma intenção usa a **mesma** `idempotency_key` (`= messages.id`, 048). Isto é o que torna o reenvio seguro (`ODI-001` C3) e é a razão de a política poder existir sem risco de double-send onde o provider suporta a chave nativamente.
- **Ordem de avaliação:** classificação **antes** de contagem — uma falha permanente vai direto à DLQ mesmo com `attempt_count = 0`; nunca se "gasta" tentativas contra um erro definitivo.
- **Idempotência da própria política:** reprocessar a mesma linha do ledger duas vezes (drenadores concorrentes) não pode produzir duas tentativas simultâneas — o `claim-as-lock` (§12) serializa.

O que ARO-001 fixa são as **propriedades** (finitude, classificação-antes-de-contagem, chave estável, política idempotente). Os **valores concretos** (teto = N, TTL = T, curva de backoff) são parâmetros de operação, ajustáveis sem reabrir o contrato.

---

## 12. Scheduler

**[SPEC]** — reusa o padrão já vigente no repositório; **não** inventa mecanismo novo.

- **Padrão adotado:** o de `automation_pending_executions` (006) drenado por `src/app/api/automations/cron` e `src/app/api/flows/cron`: uma rota HTTP acionada por **Vercel Cron / pinger externo**, protegida por **segredo compartilhado em header** (análogo a `AUTOMATION_CRON_SECRET`), que seleciona linhas devidas (`next_attempt_at <= now()`, `status = 'pending'`), **reivindica** cada uma com um `UPDATE ... WHERE status = 'pending'` (claim-as-lock, evita processamento duplo entre invocações sobrepostas), processa em lote limitado, e devolve contagem.
- **Por que reusar:** o padrão já está em produção, é conhecido, e mantém a fronteira limpa. Introduzir `pg_cron` ou um worker dedicado seria expansão de escopo e é **candidato a ADR** (§23-F), não default.
- **Seleção:** índice parcial `WHERE status = 'pending'` ordenado por `next_attempt_at`, no molde dos índices de 031 e 006.
- **Garantia de não-duplicação:** a serialização vem de duas camadas — o claim-as-lock no ledger **e** o compare-and-set na liquidação (048). Mesmo que dois drenadores reivindiquem a mesma linha por corrida, apenas um liquida; o outro recebe `noop`.

**Fronteira:** ARO-001 especifica a **forma** do scheduler (rota drenada, autenticada por segredo, claim-as-lock, lote limitado). A cadência exata do cron e o limite de lote são operação.

---

## 13. Backoff

**[SPEC]**.

- **Curva:** exponencial com **jitter**, com um teto por passo (o intervalo não cresce indefinidamente). Jitter evita *thundering herd* quando muitas intenções falham na mesma janela (ex.: provider fora do ar).
- **Persistência:** o próximo horário é **materializado** em `next_attempt_at` no ledger, não recalculado a cada varredura. O scheduler seleciona por `next_attempt_at <= now()`; a curva é aplicada **na hora de re-enfileirar**, a partir de `attempt_count`.
- **Interação com TTL:** o backoff nunca agenda uma tentativa além do horizonte de TTL (§14). Se a próxima tentativa cairia depois do TTL, a intenção vai à DLQ em vez de ser reagendada.
- **Provider-awareness (fronteira):** honrar `Retry-After` de um 429 é refinamento desejável, mas depende da taxonomia de erro por provider (§23-A). O default de ARO-001 é a curva cega; o respeito a sinais do provider é aditivo e não bloqueia o Gate.

---

## 14. TTL

**[SPEC]** — resolve a metade "não pode ficar preso para sempre" do risco 4 de ODI-001.

- **Definição:** todo intento não-liquidado tem um **horizonte máximo de vida** medido a partir da criação da intenção. Além dele, a intenção **não** é mais reenviada, independentemente de `attempt_count`.
- **Efeito ao expirar:** liquidação `failed` (via 048) + ledger → `dead`. A mensagem passa a ser visível como falha no inbox (`ODI-001` §8), e a intenção sai do ciclo de retry.
- **Função dupla:** o TTL **limita o custo** do retry (nenhuma intenção tenta para sempre) **e limita a janela de ambiguidade** de uma órfã (§16) — uma órfã além do TTL é encerrada, não reconciliada indefinidamente.
- **Relação com o teto:** teto e TTL são **cortes independentes** — o que ocorrer primeiro encerra. Teto limita *número* de tentativas; TTL limita *idade*. Uma intenção com backoff longo pode expirar por TTL antes de esgotar o teto.

---

## 15. Dead Letter Queue (DLQ)

**[SPEC]** — resolve **R10** (wiring + monitor).

- **Natureza:** a DLQ de saída é o estado terminal `dead` do retry ledger — não uma tabela separada. Uma intenção entra em `dead` quando: (a) esgota o teto de tentativas; (b) excede o TTL; ou (c) é classificada como falha permanente.
- **Correspondência com a mensagem:** uma intenção em `dead` corresponde a uma mensagem `failed` (via 048). O ledger explica **por que** falhou (último erro, contagem, classificação); a mensagem mostra **que** falhou (inbox).
- **Reuso de padrão, não de tabela:** o molde é `whatsapp_webhook_dlq` (031) — `retry_count`/`attempt_count`, `last_retry_at`/`last_error`, `status` com estado de abandono. ARO-001 aplica o **mesmo padrão** ao caminho de saída, com tabela própria; **não** reaproveita a tabela de entrada.
- **Correção do monitor (R10):** o monitor de `QUICK_REFERENCE` que reporta "DLQ vazia = saudável" é falso-positivo porque a DLQ de webhook nunca foi alimentada. E4b (a) liga o drenador ao ledger de saída e (b) corrige a documentação do monitor para distinguir "vazia porque saudável" de "vazia porque morta". A correção documental é parte do fechamento de R10, não item cosmético.
- **Superfície de intervenção:** uma visão consultável das intenções `dead` (por conta, por janela). Reenvio manual a partir da DLQ é **interação de produto** — fica na fronteira com o botão "reenviar" do operador (`ODI-001` §8) e **não** é escopo de ARO-001 além de expor a fila.

---

## 16. Recovery de mensagens "sending"

**[SPEC]** — a metade "tem que ser recuperada" do risco 4 de ODI-001.

- **O alvo:** linhas em `sending` que **não** têm entrada ativa no retry ledger e cuja idade excede um limiar — intenções cujo processo morreu entre `createIntent` e `settleMessage`. Por construção (`ODI-001` §4), elas existem; por construção, nada as move.
- **A ação:** o **orphan sweeper** as localiza e as enfileira no ledger, de onde seguem o fluxo 8.2.
- **A ressalva crítica — ambiguidade de órfã.** Uma órfã em `sending` é **indistinguível** entre dois casos: (i) o processo morreu **antes** da chamada ao provider — reenviar é seguro e necessário; (ii) o processo morreu **depois** da chamada, mas antes da liquidação — o provider **pode já ter enviado**, e reenviar arrisca double-send. **Resolvido por `ADR-E4B-002` §5 item 2 (Alternativa E) e estruturado por `ADR-E4B-003` §3.1–§3.3 (contrato de capabilities, default conservador `false`)** — o sweeper decide consultando a capability declarada do provider, nunca sua identidade:
  - Onde o provider declara **Native Idempotency** (`ADR-E4B-003` §3.2) — Meta, sujeita a verificação (`DLB-001` §10.1) —, a mesma `idempotency_key` propagada resolve a ambiguidade no lado do provider: reenviar é seguro (`ODI-001` §6, C3).
  - Onde o provider declara **Delivery Reconciliation** por correlação-cliente (`ADR-E4B-003` §3.2) — nenhum hoje —, reconcilia-se antes de reenviar: consulta pelo identificador possuído antes do envio (`= idempotency_key`, `ODI-001` §6.1); reenvia-se apenas se confirmado não-enviado (`ADR-E4B-002` §5 item 2).
  - Onde o provider **não** declara nenhuma das duas (Z-API, UAZAPI, hoje — `DLB-001` §8, matriz de capacidade), a ambiguidade **não** é reenviada automaticamente: a órfã permanece `sending` até o TTL (§14), então liquida `failed` (via 048) + ledger `dead`, exposta ao operador (`ODI-001` §8).
- **Bound superior:** o TTL (§14) garante que nenhuma órfã fica em `sending` além do horizonte — expirada, é encerrada `failed`/`dead` mesmo sem reconciliação.

---

## 17. Recovery de mensagens "failed"

**Normativo — fronteira deliberada.**

`failed` é **terminal** (D7, `ODI-001` §3, §8). ARO-001 **não** reabre automaticamente mensagens `failed`. Consequências:

1. **E4b nunca faz retry de uma mensagem que já está `failed`.** O compare-and-set de 048 nem permitiria (só transiciona de `sending`). O retry de E4b opera sobre intenções que **ainda não** alcançaram um terminal — i.e., que permanecem em `sending` no ledger (§8.2). Uma falha reenviável **não é liquidada `failed`**; é isso que a mantém elegível.
2. **`failed` alcançado é decisão de desistência, não de recuperação.** Uma mensagem chega a `failed` por: falha permanente (§8.3), esgotamento de teto, ou TTL. Em todos os casos, E4b **decidiu parar**. Não há auto-recuperação a partir daí.
3. **A partir de `failed`, a via é o operador.** Reenvio de uma mensagem `failed` é o botão "reenviar" do inbox (`ODI-001` §8) — produto, não orquestração assíncrona. Arquiteturalmente, um reenvio manual criaria uma **nova intenção** (nova `messages.id`, nova `idempotency_key`), não reabriria a antiga.
4. **Contraste com §16.** Órfã em `sending` = E4b recupera (nunca chegou a terminal). Mensagem em `failed` = E4b não recupera (já é terminal por decisão). A distinção é a linha que separa "processo interrompido" de "processo concluído com falha".

> **Tensão resolvida por `ADR-E4B-001`.** O ponto §17.1 estava condicionado a §23-B. O Gate ratificou a **Opção A**: falha transitória **não** liquida `failed` e **não** é reaberta — permanece `sending`, conduzida pelo ledger, exatamente o default que este documento já descrevia. `D7` não foi tocado; `settle_outbound_message` (048) permanece inalterada. Avaliação de impacto completa em `ADR-E4B-001` §4–§8.

---

## 18. Critérios de aceitação

*(Definidos para o épico; a verificação concreta pertence à fase de implementação, posterior ao Gate.)*

1. Uma intenção cujo `provider.send` falha com erro **reenviável** **não** é liquidada `failed` na primeira falha; entra no retry ledger em `pending` e a mensagem permanece `sending`.
2. Uma intenção cujo `provider.send` falha com erro **permanente** é liquidada `failed` + `dead` **sem** consumir tentativas.
3. O scheduler drena intenções devidas (`next_attempt_at <= now()`), reivindica cada uma (claim-as-lock) e reexecuta a entrega **sem** chamar `createIntent`.
4. Todo reenvio usa a **mesma** `idempotency_key` (`= messages.id`) da intenção original.
5. Um reenvio que resulte em `outcome = sent` encerra o ledger como `delivered` e dispara os efeitos N-3 **exatamente uma vez**.
6. Um reenvio que resulte em `outcome = noop` encerra o ledger como `delivered` e **não** dispara efeitos.
7. Esgotado o teto de tentativas, a intenção é liquidada `failed` + `dead` e visível no inbox.
8. Excedido o TTL, a intenção é encerrada `failed` + `dead` mesmo com tentativas restantes.
9. Uma intenção presa em `sending` além do limiar, sem entrada no ledger, é detectada pelo sweeper e enfileirada (recovery do risco 4).
10. Uma órfã em provider **sem** idempotência nativa **não** é reenviada cegamente — conforme o comportamento definido por `ADR-E4B-002` (bloqueio da classe ambígua em provider sem idempotência nativa) e consumido por esta versão do ARO.
11. Dois drenadores concorrentes sobre a mesma linha do ledger produzem **uma** tentativa (claim-as-lock) e, via compare-and-set, **uma** transição.
12. O monitor de DLQ distingue "vazia saudável" de "morta" (correção de R10).
13. Nenhuma escrita de estado terminal ocorre fora de `settle_outbound_message` (048 inalterada).
14. Caminho Meta sem regressão observável — suíte Meta verde antes e depois.
15. `tsc --noEmit`, `vitest run`, `next build` verdes (na fase de implementação).

---

## 19. Riscos

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| 1 | **Double-send sob entrega ambígua em provider sem idempotência nativa** — **não restrito a órfãs.** Abrange (a) a órfã (crash antes da liquidação, §16) **e** (b) toda tentativa ordinária de retry após **timeout ou falha ambígua** (§8.2, §11): em ambos, a requisição pode ter sucedido com a resposta perdida, e o reenvio na rede duplica. É a **mesma classe arquitetural** (§11) | **Alta** | A mitigação segue a **política consolidada em `ADR-E4B-002`**, que governa a segurança do reenvio em **ambos** os caminhos; §11 condiciona a reenviabilidade a essa política; o sweeper não reprocessa órfãs em provider sem idempotência nativa (bloqueio da classe ambígua); `compare-and-set`/`claim-as-lock` não cobrem o reenvio sequencial na rede (§11); TTL limita a janela |
| 2 | **E4b redefinir a semântica de `failed`** ao manter transitórios em `sending` | **Alta** | Decisão **consolidada em `ADR-E4B-001`** (Opção A): transitório permanece `sending`, `failed` permanece terminal; nenhuma alteração de D7 |
| 3 | **Retry storm** — provider fora do ar gera reprocesso em massa simultâneo | **Média** | Backoff exponencial **com jitter** (§13); lote limitado no drenador; TTL corta a cauda |
| 4 | **Loop infinito de reprocesso** — intenção nunca liquida nem morre | **Média** | Teto de tentativas **e** TTL como cortes independentes (§11, §14) |
| 5 | **Processamento duplo entre drenadores** concorrentes | **Média** | Claim-as-lock (§12) + compare-and-set (048); critério 11 |
| 6 | **Classificação errada de erro** — permanente tratado como transitório (gasta tentativas) ou vice-versa (não reenvia recuperável) | **Média** | Taxonomia explícita em §23-A; classificação-antes-de-contagem (§11) |
| 7 | **Reabrir `settle_outbound_message`** por conveniência de retry | **Média** | §10 normativo: RPC inalterada; toda escrita terminal via 048 |
| 8 | **Escopo vazar para broadcast/observabilidade** | **Média** | §4.2 e §22 declaram fora; §23-E remete broadcast a épico próprio |
| 9 | **Regressão no caminho Meta** — E4b altera o `catch` de `sender.ts` | **Média** | Suíte Meta verde antes/depois; mudança isolada ao ramo de falha |

---

## 20. Dependências

**Bloqueado por:**

- **E4a / ODI-001** — a idempotency-key (048), a liquidação em modo-2 e o estado `sending` recuperável. **Fechado** (`8057b22`). É a pré-condição dura: sem a chave estável, o retry não é seguro (`ODI-001` §14, C3).
- **E2.1** — a máquina de estados canônica que ARO-001 consome. **Fechado**.
- **E1 / DLB-001** — a camada de entrega, dona da criação de intenção e da seleção de provider. **Vigente**.

**Decidido — não bloqueia mais o início:**

- **§23-B (transitório × terminal)** — **resolvido por `ADR-E4B-001`** (Opção A: falha reenviável permanece `sending`; ledger conduz até `sent`/`failed`; `failed` terminal, nunca revertido; 048 inalterada).
- **§23-C (segurança de reenvio sob ambiguidade em provider sem idempotência nativa)** — **resolvido em política por `ADR-E4B-002`** (Alternativa E, capability-gated: Native Idempotency → reenvia; Delivery Reconciliation → reconcilia; nenhuma → bloqueia a classe ambígua até TTL) **e em estrutura por `ADR-E4B-003`** (contrato de capabilities na abstração do Provider, default conservador `false`).

**Depende de decisão (não de código) — candidato a ADR restante:**

- **Bloqueador de fechamento (não de início):**
  - **§23-A (taxonomia de erro)** — necessária para a precisão da classificação (§11), refinável durante a implementação; bloqueia o *fechamento* do épico, não o início.
- Os demais (§23-D, §23-E, §23-F) só se ativam sob condição e não estão no caminho de início.

**Nenhum bloqueador arquitetural de início permanece.** Com `ADR-E4B-001` (§23-B) e `ADR-E4B-002`/`ADR-E4B-003` (§23-C) fechados, a implementação de E4b está liberada para iniciar pelo fluxo disciplinado (documento → gate → implementação → review → promotion gate → commit → push).

**Bloqueia:** nada no grafo P0/P1 depende diretamente de E4b. E3 (Connections) coabita — o `connection_ref` no ledger acompanha o re-pointing de `EIS-001` §3.2 sem alteração semântica.

**Coabitação:** **não** rodar E4b em paralelo a alterações do caminho de saída de outros épicos — ambos tocam `sender.ts` e a liquidação. Sequencial mantém a fronteira limpa (mesma recomendação de `ODI-001` §14).

---

## 21. Limites do épico

1. **Um objetivo arquitetural:** conduzir intenções não-terminais ao longo do tempo até liquidação ou DLQ. Cada commit de E4b fecha exatamente esse objetivo — nada mais.
2. **Uma migration aditiva:** o retry ledger. `001–048` intocadas. Estado intermediário em `messages.status` **só** com ADR (§23-D).
3. **Zero reescrita de contrato fechado:** `settle_outbound_message` (048), `ODI-001`, `DLB-001`, `EIS-001`, `ADR-MSG-001` permanecem verbatim. Onde a arquitetura os tange, o ponto é elevado a §23.
4. **Reuso de padrões existentes:** cron (006), DLQ (031). Nenhum mecanismo de infraestrutura novo (worker, `pg_cron`, fila externa) sem ADR (§23-F).
5. **Fronteira com produto preservada:** reenvio manual pelo operador e apresentação no inbox são `ODI-001` §8, não E4b.

---

## 22. Itens explicitamente fora do escopo

- **Reescrita ou extensão de `settle_outbound_message`** (§10, §23-B remete a decisão, não a reescrita).
- **Novo estado em `messages.status`** (§9.1; §23-D se necessário).
- **Reabertura automática de mensagens `failed`** (§17).
- **Broadcast como ciclo intent→settle→retry** (§23-E; permanece na camada provider).
- **Botão "reenviar" do operador / apresentação no inbox** (produto; `ODI-001` §8).
- **Observabilidade estruturada** — correlation IDs, logs (E13). ARO-001 só corrige o wiring/monitor de R10 (§15).
- **Multi-conexão / tabela `connections`** (E3).
- **`whatsapp_webhook_dlq` e o caminho de entrada** (031; ARO-001 reusa o *padrão*, não a tabela).
- **`exactly-once delivery` de ponta a ponta** (§5.3; a garantia é at-least-once com dedup de dano).
- **`pg_cron` / worker dedicado** como scheduler (§12; §23-F se proposto).
- **Reconciliação por consulta de status ao provider** para órfãs (fica dentro de §23-C como opção, não é implementada aqui).

---

## 23. Decisões que devem virar ADRs separados

Pontos que, se decididos, **ampliam escopo** ou **tangem uma fronteira fechada**. Nenhum é resolvido neste documento; cada um é levado ao Gate como candidato a ADR próprio.

| ID | Decisão | Por que é ADR (não [SPEC] livre) | Bloqueia |
|---|---|---|---|
| **§23-A** | **Taxonomia de erro por provider** — quais respostas/exceções de Meta, Z-API e uazapi são *reenviáveis* e quais são *permanentes* | Toca a matriz de capacidade de `DLB-001` §8 e o contrato de cada adaptador; classificação errada causa double-send ou perda silenciosa | Precisão da política (§11); não bloqueia o início |
| **§23-B** | **Transitório mantém `sending` vs. liquida `failed` e reabre** — onde vive uma falha reenviável antes de virar terminal | Tange a semântica terminal de `failed` (D7, `ODI-001` §3) e diverge do mapeamento de `ODI-001` §5. O default de ARO-001 (manter `sending`) precisa de ratificação, pois altera o `catch` de `sender.ts` | **Resolvido por `ADR-E4B-001`** (Opção A ratificada) — não bloqueia mais o início (§17, §20) |
| **§23-C** | **Segurança de reenvio sob ambiguidade em provider sem idempotência nativa** — consulta de status, janela de espera, ou aceitação de risco para Z-API/uazapi | Sem decisão, o reenvio arrisca double-send tanto na órfã (§16) quanto em toda tentativa ordinária sob timeout/ambiguidade (§8.2, §11) — mesma classe; a resolução depende de capacidades de provider fora do contrato atual | **Resolvido em política por `ADR-E4B-002`** e **em estrutura por `ADR-E4B-003`** — não bloqueia mais o início (§16, §11, §20) |
| **§23-D** | **Estado intermediário em `messages.status`** (ex.: `retry_scheduled`) — se o ledger não bastar | Reabre a máquina de estados canônica (E2.1 / D7) | Bloqueia apenas se o ledger se mostrar insuficiente |
| **§23-E** | **Broadcast no ciclo intent→settle→retry** — trazer envio em lote para a orquestração de saída | Broadcast ficou na camada provider por decisão própria (E1); integrá-lo é épico/ADR à parte | Fora de E4b por construção |
| **§23-F** | **Mecanismo de scheduler alternativo** — `pg_cron` ou worker dedicado em vez do cron-drain HTTP | Substitui infraestrutura vigente (006); decisão de plataforma | Só se o cron-drain se mostrar insuficiente |

**Regra de ouro do épico:** se a implementação de E4b se vir obrigada a decidir qualquer item acima para prosseguir, ela **para** e o item vira ADR antes de qualquer código — repetindo o fluxo `documento → gate → implementação → review → promotion gate → commit → push`.

---

## 24. Conformidade com contratos fechados

| Cláusula | Como ARO-001 a honra |
|---|---|
| D4 — envio como processo de estados | §8, §9 — E4b conduz o processo no tempo, não o redefine |
| D7 — `failed` terminal, monotonicidade | §17 — não reabre `failed`; a exceção foi **resolvida por `ADR-E4B-001`** (Opção A), com `failed` permanecendo terminal |
| Invariante A / N-3 (`ODI-001` §7) | §5.5, §10.4 — gate de efeitos preservado; `outcome === 'sent'` dispara uma vez através de reenvios |
| `ODI-001` §4, C3 — recuperabilidade via idempotency-key | §11, §16 — retry reusa `messages.id`; recuperação segura onde há idempotência nativa |
| `ODI-001` §5/§9 — liquidação e compare-and-set | §10 — RPC 048 inalterada; única autoridade de transição |
| `DLB-001` §3, §7 — dono da criação, seleção de provider | §6, §10 — E4b não cria intenção nem escolhe provider |
| `DLB-001` §8 — matriz de capacidade | §16, §23-A, §23-C — idempotência nativa por provider governa a segurança do reenvio |

**Nenhuma decisão de `ADR-MSG-001`, `ODI-001`, `DLB-001` ou `EIS-001` foi alterada, ampliada ou reinterpretada.** Cláusulas **[SPEC]** — revisáveis sem reabrir o ADR: taxonomia (§23-A remete), política de retry (§11), scheduler (§12), backoff (§13), TTL (§14), forma da DLQ (§15), sweeper (§16).

---

## 25. Registro de revisão — v1 → v2

Consolidação após o **Gate Arquitetural** (veredito **APPROVED WITH MINOR CHANGES**). Seis emendas incorporadas, **exclusivamente** as aprovadas pelo Gate. Nenhuma introduz conceito, componente ou ADR novo; nenhuma altera escopo, limites ou responsabilidades existentes; nenhuma reabre contrato fechado. As mudanças são de *conditioning* e *explicitação*.

| # | Emenda aprovada | Natureza | Cláusulas |
|---|---|---|---|
| **1** | **Generalização da proteção contra ambiguidade de entrega.** A ambiguidade tratada para a órfã (§16) é a **mesma classe arquitetural** que a de um retry ordinário após timeout/falha ambígua em provider sem idempotência nativa. Registrada a responsabilidade e a dependência de §23-C em ambos os caminhos; solução **não** definida. | Conditioning + explicitação de fronteira | §11 (condição de reenvio + nota de alcance das proteções); §19 risco 1; §20; §23-C |
| **2** | **Reclassificação de §23-B.** Deixa de ser "decisão de gate" e passa a **bloqueador de início da implementação** — a 1ª ramificação do fluxo principal §8.2 depende dele. Dependências do épico atualizadas. | Reclassificação de dependência | §20; tabela §23 (coluna "Bloqueia") |
| **3** | **Expansão do registro de riscos.** O risco de double-send deixa de ser restrito à órfã e passa a abranger retries após timeout/falhas ambíguas em provider sem idempotência nativa. | Explicitação de risco | §19 risco 1 |
| **4** | **Responsabilidade do Failure Classifier explicitada.** Declarado como **função de domínio** reutilizada pela tentativa síncrona (camada de entrega) e pelo scheduler, sem dono exclusivo, dentro do domínio de saída. | Explicitação de responsabilidade | §7 |
| **5** | **Reconciliação ledger ↔ mensagem explicitada.** Comportamento arquitetural esperado quando a liquidação conclui antes da atualização do ledger, quando um callback de status resolve a intenção antes de um retry, e quando o retry encontra a intenção já resolvida. Liquidação (048) é a autoridade; ledger é reconciliado a ela. | Explicitação de comportamento | §10.6 |
| **6** | **Consequência do `sending` prolongado explicitada.** Registrado que uma intenção pode permanecer em estado não-terminal por toda a janela de retry. Decisão **não** alterada; apenas documentada a consequência. | Explicitação de consequência | §9.1 |

**Fora de v2, por disciplina de escopo:** nenhum candidato a ADR (§23) foi convertido em decisão; nenhum novo foi criado. As três decisões que o Gate destacou como prévias à implementação (§23-A refino de fechamento; §23-B e §23-C bloqueadores de início) permanecem candidatas a ADR e são o ponto de partida da próxima fase.

---

## 26. Registro de revisão — v2 → v3

Consolidação **exclusivamente documental**: incorpora as decisões já congeladas em `ADR-E4B-001`, `ADR-E4B-002` e `ADR-E4B-003`, todas aprovadas em Gate próprio. **Nenhuma decisão nova, nenhuma alteração de escopo, nenhuma reinterpretação de ADR.** Atualizados apenas os trechos já apontados por `ADR-E4B-002` §10 (§7, §11, §16, §23-C) e o trecho apontado por `ADR-E4B-001` §9 (§17, §20, §23-B) — mesma natureza de atualização, ambos previstos pelos próprios ADRs que resolvem.

| # | Origem | Incorporação | Cláusulas |
|---|---|---|---|
| **1** | `ADR-E4B-001` (§23-B) | Falha reenviável **permanece `sending`**; `failed` é terminal, alcançado uma única vez, nunca revertido; `settle_outbound_message` (048) inalterada. A "tensão registrada" de §17 é fechada por remissão à avaliação de impacto do ADR. | §17 (tensão → resolvida); §20 (§23-B: decidido); §23 (linha §23-B: resolvida) |
| **2** | `ADR-E4B-002` (§23-C, política) | A segurança do reenvio sob ambiguidade passa a ser **capability-gated**: Native Idempotency → reenvio direto; Delivery Reconciliation (por correlação-cliente) → reconciliar antes de reenviar; nenhuma capability → classe ambígua não reenviada automaticamente, permanece `sending` até o TTL, então `failed`/`dead`. Falha determinística permanece reenviável independentemente de capability. | §11 (condição de reenvio, nota de alcance das proteções); §16 (recovery de órfã, três ramos por capability); §20 (§23-C: decidido); §23 (linha §23-C: resolvida em política) |
| **3** | `ADR-E4B-002` (árvore de decisão do classifier) | O Failure Classifier passa a **árvore de decisão**: primeiro desfecho conhecido × ambíguo, só então transitório × permanente sobre desfecho conhecido. A órfã é ambígua por construção. | §7 (componente Failure classifier) |
| **4** | `ADR-E4B-003` (contrato estrutural de capability) | O Provider passa a declarar duas capabilities independentes — **Native Idempotency** e **Delivery Reconciliation** (por correlação-cliente, com requisito de utilidade: só conta se consultável por identificador possuído antes do envio) —, com default conservador `false`. A classificação de desfecho (ambíguo \| determinístico-transitório \| determinístico-permanente) é emitida exclusivamente pelo Provider Adapter e consumida como classe de domínio, nunca como resposta bruta. | §7 (canal da classe, referência ao adapter); §11 (consumo do contrato de capabilities); §16 (sweeper consulta capability, não identidade) |

**Fora de v3, por disciplina de escopo:** nenhuma seção além de §7, §11, §16, §17, §20 e §23 foi alterada. §1–§6, §8–§10, §12–§15, §18–§19, §21–§22, §24–§25 permanecem **verbatim** — nenhuma responsabilidade, componente, critério de aceitação, risco ou limite de épico foi tocado. `ADR-MSG-001`, `DLB-001`, `ODI-001` e `EIS-001` permanecem fechados e não reabertos por esta revisão — todas as três incorporações são consumo, não alteração, como os próprios ADRs de origem já estabelecem em suas seções de conformidade.

**Estado resultante:** `§23-B` e `§23-C`, os dois bloqueadores de início de E4b, estão **decididos**. `§23-A` permanece como bloqueador de *fechamento* (não de início), refinável durante a implementação. Nenhum bloqueador arquitetural de início resta — E4b está liberado para a fase de implementação pelo fluxo disciplinado (documento → gate → implementação → review → promotion gate → commit → push).

---

*Fim do documento — **v3 consolidada, pronta para Gate Arquitetural**. Incorpora `ADR-E4B-001`, `ADR-E4B-002` e `ADR-E4B-003`, todos já aprovados em Gate próprio. Nenhuma decisão nova; nenhum escopo alterado; nenhum contrato fechado reaberto. Nenhum código, interface, patch, migration ou teste foi produzido por esta revisão.*
