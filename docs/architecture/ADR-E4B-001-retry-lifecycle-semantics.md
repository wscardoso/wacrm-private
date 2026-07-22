# ADR-E4B-001 — Retry Lifecycle Semantics

| | |
|---|---|
| **Tipo** | ADR — decisão candidata elevada por `ARO-001 v2` §23-B |
| **Deriva de** | `ADR-MSG-001 v4` D7 (monotonicidade, estados terminais de exceção) · `ODI-001 v3` §3, §5, §8, §9 (semântica de `failed`, liquidação, compare-and-set) · `ARO-001 v2` §8.2, §9.1, §17, §20, §23-B |
| **Épico consumidor** | E4b — Async Recovery & Retry Orchestration |
| **Resolve** | `ARO-001` §23-B — bloqueador de início da implementação |
| **Status** | Proposto para Gate |
| **Autoridade** | Decide §23-B. Não reabre `ADR-MSG-001`, `ODI-001` ou `DLB-001` — a decisão recomendada, abaixo, é construída precisamente para **não** exigir isso. Se o Gate preferir a opção que exigiria reabertura, essa reabertura é registrada como dependência de ADR próprio, não incorporada aqui. |
| **Baseline de código** | HEAD `8057b22` |

---

## 1. Contexto

`ODI-001` (E4a, fechado) tornou o envio um processo de estados: a intenção é persistida antes da chamada ao provider (`sending`), e a liquidação (`settle_outbound_message`, migration 048) transiciona para `sent` ou `failed` de forma transacional, compare-and-set, **apenas a partir de `sending`**. `failed` é definido como estado terminal de exceção (D7) — fora do eixo monotônico, alcançável de qualquer estado pré-terminal, e observável no inbox (`ODI-001` §8).

O comportamento atual de `sender.ts` liquida `failed` em **qualquer** exceção do `provider.send()` — timeout, 429, 5xx ou rejeição definitiva são tratados de forma idêntica. Isso cumpriu o objetivo de E4a (C17: falha vira estado, não ausência), mas não distingue falha transitória de falha permanente, porque essa distinção não era escopo de E4a.

`ARO-001` (aprovado no Gate como contrato de arquitetura, v2, nenhum código produzido) foi desenhado assumindo, como **default declarado**, que uma falha reenviável **não** liquida `failed` — a intenção permanece em `sending`, e o retry ledger conduz as tentativas (§8.2, §9.1). O próprio `ARO-001` §17 registra essa escolha como uma **tensão não resolvida** e a eleva a `§23-B`, marcando-a como **bloqueador de início da implementação**: a primeira ramificação do fluxo principal (§8.2) depende diretamente desta decisão.

Este ADR decide `§23-B`.

---

## 2. Problema arquitetural

Quando `provider.send()` falha com uma condição classificada como transitória/reenviável, qual é o estado da intenção entre o momento da falha e a resolução final (sucesso ou desistência definitiva)?

Duas respostas mutuamente exclusivas:

- **Opção A** — a intenção permanece em `messages.status = 'sending'`; o retry ledger (componente próprio de E4b, `ARO-001` §7, §9.2) conduz as tentativas fora da coluna de status até `sent` ou `failed` terminal.
- **Opção B** — a intenção é liquidada `failed` imediatamente (comportamento atual de `sender.ts`, inalterado), e um mecanismo de retry a **reabre** posteriormente para nova tentativa.

A decisão não é cosmética: ela determina se E4b opera **inteiramente dentro** da liquidação existente (048, inalterada) ou se precisa de uma **nova operação** — reabertura de estado terminal — que não existe em nenhum contrato fechado hoje.

---

## 3. Opções consideradas

### Opção A — permanece em `sending`; ledger conduz

O retry ledger (tabela nova, aditiva, escopo de E4b) registra tentativa, contagem, próximo horário e último erro. A coluna `messages.status` só é escrita pela liquidação (048), e só alcança um terminal (`sent`/`failed`) quando a orquestração **decide parar** — sucesso, esgotamento de teto, TTL, ou falha classificada como permanente. Isso é exatamente o que `ARO-001` já descreve em §8.2, §9.1 e §17, e o que suas tabelas de responsabilidades (R-1 a R-8) e critérios de aceitação (1, 2) pressupõem.

### Opção B — liquida `failed`; reabertura posterior

`sender.ts` mantém o `catch` atual sem alteração — toda exceção liquida `failed` via 048. Um mecanismo de retry, ao decidir reenviar, precisaria **reverter** esse terminal: transicionar a mensagem de `failed` de volta para um estado pré-envio, ou produzir uma nova tentativa vinculada à mesma intenção original.

---

## 4. Avaliação de impacto

### 4.1 `ADR-MSG-001` D7 — monotonicidade e estados terminais

D7 define `failed` como terminal de exceção, alcançável de qualquer estado pré-terminal — mas **não** prevê o caminho inverso. Nenhuma cláusula do ADR autoriza sair de `failed`. "Terminal" que pode ser desfeito não é terminal; é apenas mais um estado intermediário com um nome enganoso.

- **Opção A** não toca D7. `failed` continua sendo alcançado uma única vez, como decisão de desistência (`ARO-001` §17.2). O eixo monotônico e a regra de exceção permanecem exatamente como escritos.
- **Opção B** exige que `failed` deixe de ser terminal na prática, mesmo que o texto de D7 não mude — uma reabertura é uma transição de saída de um estado que D7 declara terminal. Isso é uma **alteração de fato** da semântica de D7, ainda que não seja uma alteração do texto. Sob a restrição deste ADR, isso não pode ser incorporado silenciosamente: exigiria um ADR próprio para reabrir D7.

### 4.2 `ODI-001` — significado de `failed`, recuperabilidade, liquidação como autoridade

- **Significado de `failed` (§8).** `ODI-001` desenhou `failed` como sinal para o operador agir — "informação suficiente para decidir reenvio". Sob Opção B, o operador veria `failed` para toda falha transitória (a maioria das falhas de rede, por `ARO-001` §3), inclusive as que o sistema já está prestes a resolver sozinho — sinal ruidoso, oscilante (`failed` → `sent` minutos depois), que esvazia o propósito do estado. Sob Opção A, `failed` só aparece quando a orquestração de fato desistiu — o sinal permanece confiável.
- **Recuperabilidade (§4, C3).** `ODI-001` já projetou a recuperabilidade como propriedade de uma intenção em estado **pré-envio**, garantida pela idempotency-key, não por granularidade de estados. Opção A **realiza** exatamente essa promessa: a intenção recuperável (`sending`) é reprocessada com a mesma chave. Opção B contradiz a premissa: recuperar a partir de `failed` não é "recuperar uma intenção pré-envio", é reverter uma decisão já tomada.
- **Liquidação como autoridade única (§5, §9).** A liquidação (048) só transiciona **a partir de** `sending` — é o próprio compare-and-set que a torna segura sob concorrência. Opção B precisa de uma transição `failed → sending` (ou equivalente) que **não existe** em 048 e que a RPC, como escrita, rejeitaria (`IF v_current_status != 'sending' THEN RETURN noop`). Viabilizar Opção B exige reabrir 048 — contrato explicitamente fechado (`ODI-001` §10 "Protegido — não tocar"; `ARO-001` §10, §21.2 "048 inalterada").

### 4.3 `DLB-001` — fronteira Delivery Layer / Provider Layer

Nenhuma das opções desloca a criação de intenção ou a seleção de provider — ambas permanecem na camada de entrega (`DLB-001` §3, §7), inalterado em ambos os casos.

A diferença está em quem seria dono de uma operação de "reabertura", caso a Opção B fosse escolhida: `DLB-001` não atribui essa responsabilidade a nenhuma camada, porque essa operação não existe no modelo atual. Introduzi-la sob Opção B criaria uma responsabilidade nova, sem dono declarado — uma lacuna de fronteira que teria de ser resolvida por ADR próprio antes de qualquer implementação. Opção A não introduz nenhuma responsabilidade nova de fronteira: o ledger é propriedade de E4b (`ARO-001` §7), a liquidação continua exclusiva da camada de entrega.

### 4.4 `ARO-001` — retry ledger, scheduler, DLQ, critérios de aceitação

- **Opção A é o default já escrito em `ARO-001` v2.** §8.2 (fluxo de falha reenviável), §9.1 ("ARO-001 não adiciona estado a `messages.status`... uma intenção pode permanecer em `sending`... por toda a janela de retry"), §17 (não reabre `failed` automaticamente) e os critérios de aceitação 1 e 2 já descrevem exatamente este comportamento. Ratificar Opção A **não exige nenhuma reescrita estrutural** de `ARO-001` — apenas fechar o status de `§23-B` de "candidato" para "resolvido por este ADR" (§6 abaixo).
- **Opção B exigiria reescrever `ARO-001` de forma substancial**, tocando um documento já aprovado no Gate (v2, congelado): §8.2 (o fluxo principal inverte — liquida antes, reabre depois), §9.1 (a consequência do `sending` prolongado deixa de existir), §17 inteiro (que hoje afirma o oposto: "E4b nunca faz retry de uma mensagem que já está `failed`"), os critérios de aceitação 1 e 2, e a tabela de riscos (§19, risco 2, que já identifica "E4b redefinir a semântica de `failed`" como risco de severidade **Alta**). Além disso, Opção B quebraria o modelo de idempotency-key 1:1 por intenção (`ODI-001` §6.1): reabrir `failed` para nova tentativa, sem tocar 048, só é possível criando uma **nova** linha de mensagem com **novo** `messages.id` — o que produz uma **nova** `idempotency_key`, contradizendo a garantia de que "toda tentativa da mesma intenção usa a mesma idempotency_key" (`ARO-001` §11, `ODI-001` §6.1).

### 4.5 `sender.ts` — comportamento atual do `catch` e mudança necessária

Comportamento atual (verificado em `deliverText`/`deliverMedia`/`deliverTemplate`):

```ts
try {
  const result = await provider.sendText(sendArgs)
  return settleMessage(supabase, intent.id, 'sent', ...)
} catch {
  return settleMessage(supabase, intent.id, 'failed', meta.connectionRef, [])
}
```

- **Sob Opção A**, o `catch` deixa de liquidar `failed` incondicionalmente. Passa a consultar o **failure classifier** (`ARO-001` §7, R-1; taxonomia concreta em `§23-A`, ainda não decidida) antes de decidir:
  - classificação **permanente** → comportamento atual preservado, liquida `failed` (sem consumir tentativa, `ARO-001` §11 "classificação antes de contagem");
  - classificação **reenviável** → **não** chama `settleMessage`; enfileira no retry ledger. A mensagem permanece em `sending` — estado já gravado por `createIntent`, nenhuma escrita adicional em `messages` é necessária neste ponto.
  Esta é uma mudança **aditiva e isolada ao ramo de falha** — o caminho feliz (`try`) e a chamada a `settleMessage('failed', ...)` no ramo permanente não mudam de forma; apenas ganham uma condição antes de disparar.
- **Sob Opção B**, o `catch` de `sender.ts` **não precisaria mudar** — mas o custo é deslocado inteiramente para um componente novo, ainda inexistente em qualquer contrato, que reabre `failed`. Esse componente não tem fronteira definida (§4.3) e não pode ser construído sem tocar 048 (§4.2) ou quebrar a unicidade de idempotency-key (§4.4).

**Conclusão da avaliação de impacto:** Opção A é estritamente aditiva sobre contratos fechados — zero alteração de D7, zero alteração de 048, zero responsabilidade nova sem dono. Opção B não é uma escolha isolada: ela arrasta consigo a reabertura de pelo menos um contrato fechado (D7 de fato, 048 na prática) ou a quebra de uma garantia já publicada (idempotency-key 1:1), nenhuma das quais pode ser absorvida silenciosamente sob as restrições deste ADR.

---

## 5. Trade-offs

| | Opção A — permanece `sending` | Opção B — liquida `failed`, reabre depois |
|---|---|---|
| Toca D7 | Não | Sim, de fato (mesmo sem mudar o texto) |
| Toca `settle_outbound_message` (048) | Não | Sim — CAS só parte de `sending`; reabrir exige nova transição não coberta pela RPC |
| Preserva idempotency-key 1:1 por intenção (`ODI-001` §6.1) | Sim | Não, sem workaround que quebra a garantia (nova linha = nova chave) |
| Sinal de `failed` para o operador | Confiável — só aparece na desistência | Ruidoso — falha transitória comum aparece e depois "some" |
| Exige rewrite de `ARO-001` (aprovado, congelado) | Não — já é o default descrito | Sim — §8.2, §9.1, §17, critérios 1-2, risco 2 |
| Nova responsabilidade de fronteira sem dono (`DLB-001`) | Não | Sim — "reabertura" não tem camada atribuída |
| Mudança em `sender.ts` | Aditiva, isolada ao `catch`, condicionada ao classifier (§23-A) | Nenhuma no `catch`; custo deslocado para componente novo sem contrato |
| Consequência aceita | Intenção pode permanecer em estado não-terminal por toda a janela de retry (já documentado em `ARO-001` §9.1) | — |
| Dependência de decisão adicional | `§23-A` (taxonomia) para precisão da classificação — não bloqueia o início | Reabertura de D7 e/ou 048 — bloqueia o início de qualquer forma |

---

## 6. Decisão recomendada

**Opção A.** A intenção permanece em `messages.status = 'sending'` sob falha reenviável; o retry ledger conduz as tentativas até `sent` ou `failed` terminal. `failed` continua sendo alcançado uma única vez, como decisão de desistência — nunca como primeira reação a uma falha transitória, e nunca revertido.

Esta não é uma decisão nova: é a **ratificação formal** do default que `ARO-001 v2` já descreve em §8.2, §9.1 e §17, fechando o único ponto que aquele documento deixou como tensão registrada.

**Nenhuma cláusula de `ADR-MSG-001`, `ODI-001` ou `DLB-001` é alterada, ampliada ou reinterpretada por esta decisão.** Opção A foi selecionada precisamente porque não exige isso.

---

## 7. Consequências

1. `sender.ts` — o `catch` de `deliverText`/`deliverMedia`/`deliverTemplate` ganha um passo de classificação antes de decidir entre `settleMessage('failed', ...)` (falha permanente) e enfileiramento no retry ledger sem liquidação (falha reenviável). Mudança aditiva, isolada ao ramo de falha, não implementada por este ADR (documento de arquitetura — §8, restrições).
2. O retry ledger, o scheduler e o failure classifier seguem como especificados em `ARO-001` §7–§16, sem alteração.
3. `failed` continua terminal, alcançado uma única vez, por: falha permanente, esgotamento de teto, ou TTL (`ARO-001` §17, inalterado por este ADR).
4. Uma intenção pode permanecer em `sending` — estado não-terminal — por toda a janela de retry (backoff × teto, cortada por TTL). Esta consequência já estava documentada em `ARO-001` §9.1; este ADR não a introduz, apenas a confirma como decorrência da decisão agora ratificada.
5. **Implementação de `sender.ts` permanece bloqueada** — não por este ADR, mas por `§23-C` (segurança de reenvio sob ambiguidade em provider sem idempotência nativa), que `ARO-001` §20 já classifica como bloqueador de início independente deste. A resolução de `§23-B` remove um bloqueador; `§23-C` permanece.

---

## 8. Impacto nos contratos existentes

| Contrato | Impacto |
|---|---|
| `ADR-MSG-001` (D7) | Nenhum. Não reaberto, não reinterpretado. |
| `ODI-001` (§3, §5, §8, §9) | Nenhum. `failed` continua com o significado, a liquidação continua com a autoridade, exatamente como fechados. |
| `DLB-001` | Nenhum. Nenhuma responsabilidade de fronteira nova é criada. |
| Migration 048 (`settle_outbound_message`) | Nenhum. RPC permanece inalterada — a decisão foi construída para não exigir tocá-la. |

Nenhum contrato fechado precisa ser declarado como dependência de reabertura, porque a opção recomendada não gera essa necessidade — condição explícita das restrições deste ADR.

---

## 9. Necessidade de atualização em `ARO-001`

**Sim, mas apenas de status — não de conteúdo estrutural.** Recomenda-se uma emenda v3, estritamente administrativa:

- **§23, linha `§23-B`:** marcar como **RESOLVIDO por `ADR-E4B-001`, Opção A**, em vez de "candidato a ADR" na tabela de decisões pendentes.
- **§17, "Tensão registrada":** substituir a nota de tensão aberta por uma remissão a este ADR como decisão fechada — o texto normativo de §17 (itens 1–4) **não muda**, porque já descrevia Opção A; apenas deixa de estar sob tensão.
- **§20, "Bloqueado por... §23-B":** mover de "bloqueador de início" para resolvido; `§23-C` permanece como o único bloqueador de início remanescente.

Nenhuma outra seção de `ARO-001` (§8.2, §9.1, §9.2, §10, §11, §16, critérios de aceitação, tabela de riscos) exige alteração de conteúdo — todas já foram escritas assumindo Opção A como default.

---

## 10. Recomendação de Gate

**APPROVE.**

Fundamento: a opção recomendada (A) é estritamente aditiva sobre todos os contratos fechados avaliados, já é o default descrito e congelado em `ARO-001 v2`, e sua alternativa (B) foi demonstrada, por avaliação de impacto e não por preferência, como incompatível com pelo menos um contrato fechado (o compare-and-set de 048, que só transiciona a partir de `sending`) e com uma garantia já publicada (idempotency-key 1:1, `ODI-001` §6.1) — sem caminho de incorporação silenciosa sob as restrições declaradas para este ADR.

Ação requerida pós-Gate: emenda administrativa v3 em `ARO-001` (§9, acima) fechando `§23-B`. `§23-C` permanece como o próximo bloqueador de início a decidir antes de qualquer implementação em `sender.ts`.

Nenhum código, patch, migration ou teste foi produzido por este ADR.
