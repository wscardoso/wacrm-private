# ADR-E4B-002 — Ambiguous Delivery Recovery Without Native Provider Idempotency

| | |
|---|---|
| **Tipo** | Architecture Decision Record |
| **Épico** | E4b — Async Recovery & Retry Orchestration |
| **Deriva de** | `ARO-001 v2` §11, §16, §19, §23-C (bloqueador de início) · `ODI-001 v3` §6, §6.3 · `DLB-001` §8, §10.1, §4.3 · `ADR-MSG-001` D3, D4, D6 |
| **Resolve** | `ARO-001` §23-C — bloqueador de início da implementação de E4b |
| **Status** | Aprovado no Gate (**APPROVE WITH CHANGES**) · **rev. pós-Gate** — as quatro mudanças obrigatórias incorporadas (ver §15). Decisão (Alternativa E) inalterada. |
| **Autoridade** | Decide **política**. Não altera decisão de `ADR-MSG-001`, `ODI-001`, `DLB-001`, `EIS-001`, `E4a`, `E2.1`, `E1`. Onde a política exige alteração **estrutural** do Provider Abstraction, isso é registrado como **ADR próprio** (§9, §12), não decidido aqui. |
| **Baseline de código** | HEAD `8057b22` |
| **Antecedente** | ADR-E4B-001 (Opção A ratificada: falha reenviável permanece `sending`; ledger conduz a `sent`/`failed`; `failed` terminal; `settle_outbound_message` 048 inalterada) |

---

## 1. Contexto

E4a (`ODI-001`) tornou o envio um processo de estados e garantiu que **um retry não duplica** — via `idempotency_key = messages.id` (migration 048) e compare-and-set. ADR-E4B-001 ratificou a Opção A: uma falha reenviável **permanece em `sending`** e o retry ledger a conduz até um terminal.

`ODI-001` §6.3 declarou explicitamente o limite dessa garantia:

> *"Onde o provider suporta chave de idempotência nativa, ela é propagada. Onde não suporta, a chave governa a decisão local de reenvio antes de contatar o provider."*

E `ARO-001` §11/§16/§23-C elevou o ponto não resolvido: a **decisão local** de reenviar "antes de contatar o provider" pressupõe que o processo **saiba** se o provider já entregou. Em uma classe inteira de cenários, ele **não sabe**.

**Estado atual do Provider Abstraction (verificado em `8057b22`).** A interface `WhatsAppProvider` (`src/lib/whatsapp/providers/types.ts`) **não declara capability alguma** — nem de operação, nem de idempotência. `getProvider` (`index.ts`) despacha por `provider: 'meta' | 'zapi' | 'uazapi'`, mas nenhum ponto do sistema expressa, de forma consultável e agnóstica, se um provider deduplica reenvios. A capacidade de idempotência que `ODI-001` §6.3 e `ARO-001` §11 pressupõem é hoje **implícita** — exatamente o anti-padrão que `DLB-001` §8/§10.1 nomeou: *"capability não é suposição otimista; é contrato."*

---

## 2. Problema

**Classe arquitetural única: "não sabemos se o provider entregou."**

Cenários que a compõem:

- timeout durante `provider.send()`;
- perda da resposta HTTP após a requisição chegar ao provider;
- crash entre `provider.send()` e `settleMessage()`;
- interrupção do processo após o envio mas antes da liquidação (a órfã de `ARO-001` §16).

Todos partilham a mesma propriedade: **a requisição pode ter alcançado o provider e sucedido, com a confirmação perdida.** Não há, localmente, como distinguir "não enviou" de "enviou e não soubemos".

**A assimetria por provider:**

- **Com idempotência nativa (Meta, pela premissa de `ODI-001`/ADR-E4B-001):** reenviar com a mesma `idempotency_key` é seguro — o provider deduplica o segundo envio. A ambiguidade é resolvida **no lado do provider**.
- **Sem idempotência nativa (Z-API, UAZAPI):** um novo `provider.send()` produz um **segundo envio real**. Reenviar sob ambiguidade **reintroduz o defeito C18** que E4a fechou — para 2 dos 3 providers.

**A pergunta oficial:** qual deve ser o comportamento da plataforma quando existe ambiguidade de entrega em providers sem idempotência nativa?

**Distinção que o problema exige (e que a taxonomia de `ARO-001` §23-A ainda não carrega):** nem toda falha é ambígua.

**Definição normativa da classe determinística.** Uma falha é **determinística** se, e somente se, há **certeza arquitetural de que nenhuma entrega ocorreu** — o processo tem garantia de que a mensagem não foi aceita nem processada pelo provider em grau algum. A definição **não** depende de o erro ser "tipado" nem de ter ocorrido "antes do despacho": depende **exclusivamente** da certeza de não-entrega. Exemplos que a satisfazem: recusa de conexão antes de a requisição partir; `ProviderUnsupportedError` (a operação nunca foi tentada); rejeição de validação que comprovadamente antecede qualquer processamento no provider.

**Definição normativa da classe ambígua — por exclusão.** **Toda** situação em que o provider **possa** ter aceitado ou processado a mensagem antes da falha pertence **obrigatoriamente** à classe **ambígua**: timeout (após ou durante o envio), perda da resposta HTTP, 5xx e qualquer resposta de erro emitida **depois** de a requisição ter sido aceita para processamento ("aceito-e-errou"), crash entre `provider.send()` e `settleMessage()`, e a órfã em geral. A regra de fronteira é: **na ausência de certeza de não-entrega, a falha é ambígua.** Um erro ser "tipado" não o torna determinístico — um 5xx é um erro tipado e é ambíguo, porque o provider pode ter despachado antes de falhar.

Só a classe **ambígua** é objeto deste ADR. Falha **determinística** permanece reenviável com segurança mesmo sem idempotência nativa, porque a certeza de não-entrega elimina o risco de double-send.

---

## 3. Alternativas avaliadas

### A. Retry imediato, aceitando o risco residual de double-send

Reenvia sob ambiguidade sem nenhuma salvaguarda para providers não-nativos.

### B. Impor janela de espera antes do retry

Aguarda um intervalo antes de reenviar, na expectativa de que uma confirmação tardia (callback de status) chegue nesse meio-tempo.

### C. Exigir reconciliação prévia com o provider

Antes de qualquer novo envio, consulta o provider ("esta mensagem foi enviada?") e só reenvia se a resposta for negativa.

### D. Bloquear o retry automático da classe ambígua nesses providers

Enquanto não existir mecanismo confiável de reconciliação, uma intenção que caia na classe ambígua em provider sem idempotência nativa **não** é reenviada automaticamente; envelhece por TTL até terminal `failed` e é exposta ao operador (resend manual, `ODI-001` §8).

### E. Política decidida por capability (composta)

A decisão **não é uniforme**; é função de uma capability declarada pelo provider:

- provider declara **idempotência nativa** → reenvio com a mesma chave (caminho já vigente, Meta);
- provider declara **reconciliação de entrega confiável** → caminho C (reconciliar-antes-de-reenviar) para a classe ambígua;
- provider declara **nenhuma das duas** → caminho D (bloquear a classe ambígua) como default seguro;
- em todos os casos, **falha determinística permanece reenviável** — o bloqueio incide **apenas** sobre a classe ambígua.

O default de qualquer capability **ausente ou não verificada é `false`** (o mais seguro), no princípio de `DLB-001` §10.1.

---

## 4. Trade-offs

| Alt. | Preserva "reenvio não duplica" (C18) | Resolve a ambiguidade | Preserva agnosticismo do Delivery Layer | Custo | Veredito |
|---|---|---|---|---|---|
| **A** | ❌ Reintroduz C18 em Z-API/UAZAPI | Não — ignora | Sim | Double-send real em produção | **Rejeitada** — anula a garantia central de E4a |
| **B** | ❌ Após a espera ainda não se sabe | Não — só reduz probabilidade de sobreposição temporal | Sim | Latência sem segurança | **Rejeitada como solução isolada** — heurística de tempo não é prova de entrega; útil só combinada com C |
| **C** | ✅ Se a consulta for confiável | Sim — **onde há mecanismo** | Sim, se a consulta for uma capability declarada | Depende de o provider expor consulta confiável **e** de haver handle de correlação sobrevivente | **Correta onde viável** — mas a viabilidade é ela própria uma capability; inviável para a órfã crash-before-settle sem handle |
| **D** | ✅ Absolutamente | Não resolve — **evita** o dano não resolvendo | Sim, se o gatilho for capability, não identidade de provider | Regressão de capacidade: sem recuperação automática da classe ambígua em Z-API/UAZAPI | **Default seguro** — honesto, alinhado a `DLB-001` §10.1 |
| **E** | ✅ Por construção | Sim onde há capability; evita onde não há | ✅ **Sim — o branch é sobre capability, não sobre provider** | Exige tornar a idempotência/reconciliação capabilities **explícitas** na abstração | **Recomendada** — subsume A/B/C/D sob um gatilho declarado |

**Notas de trade-off que decidem:**

- **B não é solução.** Uma janela de espera não converte "não sei" em "sei" — apenas adia o "não sei". Sua única função legítima é dar tempo a um callback de status (`ARO-001` §10.6): valiosa **dentro** de C/E, nula sozinha.
- **C tem um limite duro na órfã.** Para reconciliar por id de provider é preciso ter capturado esse id — mas no crash-before-settle o id **é justamente o que se perdeu**. Reconciliação por id só cobre o subconjunto em que o id foi persistido antes do crash. Reconciliação por correlação cliente (recipiente+conteúdo+janela, ou token ecoado) depende de o provider oferecê-la — outra capability. Logo C é **condicional**, não universal.
- **D paga o preço de `DLB-001` §10.1 e o paga do lado certo.** O mesmo raciocínio de assimetria de custo que `DLB-001` usou para templates: *"o custo de subutilizar uma capacidade é menor que o de presumir uma capacidade inexistente."* Presumir idempotência inexistente = double-send em produção; bloquear a classe ambígua = recuperação manual. A direção segura é bloquear.

---

## 5. Decisão recomendada

**Alternativa E — política de recuperação de ambiguidade decidida por capability declarada**, com **D como default seguro** e **C como caminho ativado onde houver capability de reconciliação**.

Especificamente:

1. **A recuperação sob ambiguidade é gated por capability, não uniforme.** O comportamento é função do que o provider **declara**, consultado de forma **agnóstica** pelo Delivery Layer / classifier / scheduler.

2. **Três caminhos, um gatilho:**
   - **Idempotência nativa declarada** (Meta) → reenvio com a mesma `idempotency_key` (048). Comportamento já vigente por `ODI-001` §6; este ADR o confirma como o caminho da capability presente.
   - **Reconciliação de entrega declarada** → antes de reenviar a classe ambígua, reconciliar; reenviar apenas se confirmado não-enviado. (Nenhum provider declara isso hoje.) **Requisito de utilidade — normativo:** a reconciliação só resolve a ambiguidade se puder ser consultada por um **identificador disponível antes do envio** (correlação do cliente — ex.: `messages.id`, que `ODI-001` §6.1 já grava com a intenção). Uma reconciliação que só permita lookup por um **identificador retornado depois do envio** (id do provider) **não** resolve o cenário **crash-before-settle** — nesse cenário esse id é justamente o que se perdeu — e, portanto, **não satisfaz o requisito deste ADR**: um provider nessa condição é tratado como se **não** tivesse a capability (cai no caminho de bloqueio). O ADR **apenas registra o requisito arquitetural**; não define a interface da consulta.
   - **Nenhuma das duas** (Z-API, UAZAPI hoje) → **a classe ambígua não é reenviada automaticamente**; a intenção permanece `sending` até o TTL de `ARO-001` §14, então liquida `failed` (via 048) + ledger `dead` com razão registrada, e é exposta ao operador (`ODI-001` §8).

3. **O bloqueio incide apenas sobre a classe ambígua**, e a classificação é uma **árvore de decisão**, não dois eixos independentes. `ambíguo × determinístico` e `reenviável × permanente` **não** são eixos paralelos: o rótulo transitório/permanente só é confiável sobre um desfecho **conhecido**. A ordem é normativa:
   - **Passo 1 — o desfecho é conhecido?** Determina-se primeiro se há certeza de não-entrega (determinística) ou não (ambígua), conforme §2. Este passo **precede** e **condiciona** o seguinte.
   - **Passo 2 — só quando determinístico:** aplica-se transitório × permanente para decidir reenvio/desistência. Sobre um desfecho **ambíguo**, o rótulo transitório/permanente **não** é aplicado — a ambiguidade domina e encaminha a intenção à política gated por capability (idempotência → reenvia; reconciliação → reconcilia; nenhuma → bloqueia).
   
   **A órfã (crash-before-settle) é, por construção, uma falha ambígua.** Não há desfecho a inspecionar — o processo morreu antes da liquidação —, logo ela nunca passa pela classificação computada: entra diretamente no Passo 1 como ambígua (ausência de desfecho ≡ ausência de certeza de não-entrega). É o caso de ambiguidade máxima.
   
   Este ADR **declara a árvore e a dominância da ambiguidade**; a taxonomia concreta de erros permanece `ARO-001` §23-A, e a interpretação específica-de-provider pertence ao Provider Adapter (§5 item 6).

4. **Default seguro por construção.** Toda capability ausente, desconhecida ou não verificada assume o valor mais conservador (`false`). Adicionar um provider novo é seguro por omissão — ele cai no caminho D até declarar e **verificar** o contrário (`DLB-001` §10.1).

5. **A decisão exige tornar a capability explícita na abstração.** Hoje ela é implícita (§1). Uma capability que governa uma ramificação de segurança **precisa ser contrato**, não suposição. **Isto constitui alteração estrutural do Provider Abstraction e é registrado como ADR próprio** (§9, §12) — este ADR **não** o executa, apenas o torna pré-requisito.

6. **A interpretação específica-de-provider pertence ao Provider Adapter; o restante do sistema consome apenas a classificação de domínio.** Decidir se uma resposta bruta significa certeza-de-não-entrega (determinística) ou ambiguidade é **semântica específica de cada provider** — um 5xx de um provider e de outro não significam necessariamente o mesmo. Portanto, pertencem ao **Provider Adapter**:
   - interpretar as respostas e erros específicos do provider;
   - distinguir **certeza de não-entrega** versus **ambiguidade** (§2);
   - emitir a **classificação de domínio** (`ambíguo | determinístico-transitório | determinístico-permanente`).
   
   **Delivery Layer, Retry Engine, Scheduler e Failure Classifier permanecem completamente agnósticos ao provider** e consomem **apenas** a classificação de domínio já emitida pelo adapter — nunca a identidade do provider nem sua resposta bruta. Este é o mesmo princípio de `DLB-001` §5 (o provider declara; o domínio consome). É o **único** ponto onde conhecimento de provider é legítimo, e fica confinado ao adapter, como já o é a declaração de identidade e o despacho de `getProvider` (`DLB-001` §7). **Esta responsabilidade será formalizada em ADR-E4B-003**, junto ao contrato de capability (§9); este ADR **apenas a registra**, não a executa nem define interface.

---

## 6. Respostas às perguntas do Gate

**1. A decisão é uniforme para todos os providers ou depende de capabilities?**
**Depende de capabilities.** Não é uniforme. Um único gatilho declarado (idempotência nativa / reconciliação / nenhuma) seleciona entre três caminhos. Uniformizar seria ou inseguro (A/B para todos) ou desnecessariamente restritivo (D para Meta).

**2. A capacidade de idempotência deve passar a fazer parte explícita do contrato do Provider Abstraction?**
**Sim.** É a correção do defeito arquitetural de §1: uma capability que decide segurança de reenvio não pode permanecer implícita. `DLB-001` §8/§10.1 já estabelece o princípio — capability é contrato. Torná-la explícita é o que permite ao Delivery Layer decidir sem conhecer a identidade do provider (resposta 4).

**3. Existe necessidade de um novo capability (ex.: `supportsNativeIdempotency` / `supportsDeliveryReconciliation`)?**
**Sim, e são dois eixos distintos, não um.** *Idempotência nativa de envio* (dedup no provider — caminho rápido) e *reconciliação de entrega* (consulta-antes-de-reenviar) são capacidades diferentes; um provider pode ter uma sem a outra. A abstração precisa expressar **ambas**, ambas com default `false`. Os nomes concretos são decisão do ADR estrutural (§9); o que este ADR fixa é a **existência de dois eixos** e seu default seguro.

**4. A solução preserva o princípio de que o Delivery Layer permanece agnóstico ao provider?**
**Sim — e é justamente a capability explícita, somada à classificação emitida pelo adapter, que o preserva.** O Delivery Layer, o Retry Engine, o scheduler e o Failure Classifier ramificam sobre a **capability declarada** (`provider.<capability>`) e consomem a **classificação de domínio** já emitida pelo adapter — nunca sobre `provider === 'zapi'` nem sobre a resposta bruta do provider. Codificar "se Z-API/UAZAPI, bloquear" **violaria** `DLB-001` §4.3; ler uma propriedade abstrata e uma classe de domínio **preserva** a agnosticidade. **O único ponto onde conhecimento de provider é inevitável — interpretar a resposta bruta para distinguir certeza-de-não-entrega de ambiguidade — fica confinado ao Provider Adapter** (§5 item 6), como já ocorre com a declaração de identidade (`DLB-001` §5) e o despacho de `getProvider` (`DLB-001` §7). Sem a capability e a classificação na fronteira do adapter, a única forma de implementar a política seria o Delivery Layer conhecer a identidade do provider; por isso a extensão da abstração (§9) não é só compatível com a agnosticidade — é sua **condição**.

---

## 7. Consequências arquiteturais

- **Assimetria de capacidade oficial e honesta.** Meta recupera automaticamente sob ambiguidade; Z-API/UAZAPI não, até declararem+verificarem reconciliação. É uma regressão declarada, no molde de `DLB-001` §10.1 (template), aceita como o lado seguro da assimetria de custo.
- **A classe ambígua ganha um destino terminal nomeado.** No retry ledger, uma intenção ambígua em provider não-capaz encerra em `dead` (`ARO-001` §15) com **razão registrada** ("ambígua, provider sem idempotência/reconciliação"). Não é componente novo — é uma razão de classificação sobre o estado terminal existente.
- **TTL assume papel de fronteira dura** para a classe bloqueada: como ela não pode reenviar, é o TTL (`ARO-001` §14) que a leva a `failed`. O papel do TTL, já previsto, é reforçado — não ampliado.
- **O classifier passa a ser uma árvore de decisão** (§5 item 3): primeiro determina desfecho conhecido × ambíguo; só sobre desfecho conhecido aplica transitório × permanente. Continua sendo a função de domínio de `ARO-001` §7 — sem novo componente —, porém **consome a classe de domínio emitida pelo adapter** (§5 item 6), não a resposta bruta do provider.
- **Extensibilidade sem novo contrato.** Se, no futuro, uma reconciliação confiável for construída para Z-API/UAZAPI, a capability vira `true` e o caminho C ativa — **sem** tocar este ADR nem o Delivery Layer. A política é estável; só a declaração do provider muda.
- **O DLQ é a superfície de decisão do operador** para a classe bloqueada — resend manual cria nova intenção (nova `messages.id`/`idempotency_key`), como `ARO-001` §17 já define. Sem duplicação, porque é decisão humana informada.

---

## 8. Impacto sobre os contratos existentes

| Contrato / componente | Impacto | Reabre? |
|---|---|---|
| **ADR-MSG-001** | D3 ("o provider declara") **fundamenta** a capability explícita; D4 (envio como processo) e D6 (sem import direto) intactos. A extensão é no espírito de D3. | **Não** |
| **ODI-001** | **Operacionaliza** §6.3 ("onde não suporta, a chave governa a decisão local") — preenche o gap que ODI-001 delegou a E4b. `idempotency_key = messages.id` (§6.1) permanece o handle de correlação. Nada alterado. | **Não** |
| **DLB-001** | Estende o **conceito de capability** de §8 com um novo eixo (idempotência/reconciliação), sob o princípio de §10.1 (default seguro) e preservando §4.3 (agnosticismo). Como DLB-001 é fechado, a materialização da nova capability na abstração é **ADR próprio** (§9). | **Não** — novo ADR, não emenda |
| **ARO-001** | **Resolve §23-C.** Requer atualização (§10): §23-C de "bloqueador aberto" → "decidido por ADR-E4B-002"; §11 concretiza "segurança assegurada"; §16 recebe a política da órfã; classifier §7 ganha o eixo ambíguo. | Atualização de ponteiro, **não** reabertura |
| **Provider Abstraction** | Alteração **estrutural**: a interface passa a declarar capabilities de idempotência/reconciliação. **Constitui novo ADR** (§9, §12). | Sim — via ADR próprio |
| **Meta** | Declara idempotência nativa `true` (a **verificar**, `DLB-001` §10.1). Caminho rápido. | — |
| **Z-API / UAZAPI** | Declaram ambas `false` (default seguro) até verificação. Classe ambígua bloqueada; falha determinística ainda reenvia. | — |
| **Retry ledger** | Ganha razão de terminação "ambígua bloqueada" sobre o estado `dead` existente. Sem estrutura nova. | Não |
| **Scheduler** | Não re-dirige intenção ambígua em provider não-capaz; consulta a capability de forma abstrata. Sem mecanismo novo. | Não |
| **TTL** | Fronteira dura da classe bloqueada. Papel reforçado. | Não |
| **DLQ** | Superfície do operador para a classe bloqueada, com razão. Sem estrutura nova. | Não |

---

## 9. Alteração estrutural do Provider Abstraction — registro explícito

Conforme a restrição do Gate: **a decisão exige alteração estrutural do Provider Abstraction** (a interface `WhatsAppProvider` passa a declarar capabilities de idempotência e reconciliação). Como o Provider Abstraction é contrato fechado (`DLB-001`, E1, E2.1), **essa alteração não é executada neste ADR** e **constitui um ADR próprio**:

> **ADR-E4B-003 — Provider Idempotency & Delivery-Reconciliation Capability Contract** *(a escrever)* — materializa na abstração: (a) os dois eixos de capability (idempotência nativa; reconciliação por correlação-cliente, §5 item 2), com default seguro; e (b) a **responsabilidade do adapter de emitir a classificação de domínio** (`ambíguo | determinístico-transitório | determinístico-permanente`, §5 item 6). Base em `DLB-001` §5/§8/§10.1 e D3. É a **contraparte estrutural** desta decisão de política.

**Sequência de bloqueio:** a implementação de E4b **só pode iniciar após ADR-E4B-003**, porque o caminho seguro de `ARO-001` §11/§16 consome a capability declarada — e implementá-lo sem a capability na abstração violaria a agnosticidade (resposta 4). ADR-E4B-002 (política) desbloqueia §23-C **no plano da decisão**; ADR-E4B-003 (contrato de capability) é o último bloqueador estrutural antes do código.

---

## 10. Necessidade de atualização do ARO-001

**Sim — atualização, não reabertura. Recomenda-se ARO-001 v3**, contendo exclusivamente:

1. **§23-C:** de candidato/bloqueador **aberto** → **decidido por ADR-E4B-002** (política E, capability-gated).
2. **§11:** a cláusula "segurança do reenvio … assegurada (§23-C)" passa a apontar para a política concreta (idempotência nativa → reenvia; reconciliação → reconcilia; nenhuma → bloqueia classe ambígua).
3. **§16:** o recovery da órfã em provider não-capaz é o caminho D (bloqueio + TTL), não reenvio cego.
4. **§7 / §23-A:** o Failure Classifier passa a **árvore de decisão** (desfecho conhecido × ambíguo primeiro; transitório × permanente só sobre determinístico), consumindo a classe emitida pelo adapter. A determinação de ambiguidade é **pré-requisito de início** (segurança-crítico), não refino de fechamento; sua porção específica-de-provider é formalizada em **ADR-E4B-003** (§5 item 6, §9), e a taxonomia de erros restante permanece §23-A.
5. **§23-C** permanece candidato a ADR apenas no sentido histórico — agora **satisfeito** por E4B-002 + E4B-003.

Nenhum limite, escopo ou responsabilidade de ARO-001 muda. É registro de que o bloqueador foi decidido.

---

## 11. Riscos da própria decisão

| # | Risco | Mitigação |
|---|---|---|
| 1 | Assimetria percebida como "Z-API/UAZAPI é inferior" | É declarada e reversível: construir reconciliação flipa a capability. Documentada como custo seguro (`DLB-001` §10.1) |
| 2 | Classificar como determinística uma falha na verdade ambígua (e reenviar indevidamente) | Determinística significa **exclusivamente certeza de não-entrega** (§2); na ausência dessa certeza a falha é ambígua por regra de fronteira. A classificação é emitida pelo adapter e o default sob dúvida é **ambíguo** (o conservador). Regra fixada em §2 e §5 itens 3 e 6 |
| 3 | "Idempotência nativa da Meta" presumida sem verificar | `DLB-001` §10.1: capability declarada **e verificada**; enquanto não verificada, default `false` (Meta cairia em D — subutilização segura, não double-send) |
| 4 | Reconciliação (C) implementada de forma não-confiável e tratada como confiável | A capability de reconciliação só é `true` sob verificação; consulta não-confiável mantém `false` → caminho D |
| 5 | Fragmentação de ADRs (002 política + 003 estrutura) | Separação deliberada: política e contrato de abstração são decisões distintas; 003 é contido e rápido |

---

## 12. Se a decisão exige alteração estrutural do Provider Abstraction — é novo ADR?

**Sim, explicitamente.** Registrado em §9: a materialização das capabilities na interface `WhatsAppProvider` é **ADR-E4B-003**, porque toca um contrato fechado (Provider Abstraction / `DLB-001`). ADR-E4B-002 decide a **política** e **declara o requisito**; não modifica a abstração.

---

## 13. Conformidade

- **Nenhum contrato fechado reaberto.** ADR-MSG-001, ODI-001, DLB-001, EIS-001, E4a, E2.1, E1 intactos. A extensão da abstração é ADR próprio (§9), não emenda a fechado.
- **Nenhum código, migration, teste ou nome de arquivo de implementação** produzido.
- **Opção A (ADR-E4B-001) preservada:** falha reenviável permanece `sending`; a classe ambígua bloqueada também permanece `sending` até o TTL; `failed` terminal; 048 inalterada.
- **Agnosticismo do Delivery Layer preservado** e, de fato, **reforçado** (resposta 4).

---

## 14. Veredito do Gate

**APPROVE WITH CHANGES.**

A decisão de política (Alternativa E — capability-gated, D como default seguro, C onde houver reconciliação) é **aprovada**. A aprovação está condicionada às seguintes mudanças, todas **arquiteturais** e **fora deste ADR**:

1. **Abrir ADR-E4B-003** (Provider Idempotency & Delivery-Reconciliation Capability Contract) — a contraparte estrutural que materializa os dois eixos de capability na abstração, com default seguro. **Último bloqueador estrutural antes da implementação de E4b** (§9).
2. **Atualizar ARO-001 para v3** registrando §23-C como decidido e concretizando §11/§16/§7 conforme §10 — atualização de ponteiro, sem reabertura.
3. **Estender o eixo do Failure Classifier** (ambíguo × determinístico) na taxonomia §23-A quando esta for escrita — declarado aqui como requisito.

Com E4B-002 aprovado e E4B-003 mais o ARO-001 v3 concluídos, **os bloqueadores de início de E4b (§23-B via ADR-E4B-001; §23-C via ADR-E4B-002) estão resolvidos** e o épico fica liberado para a fase de implementação pelo fluxo disciplinado (documento → gate → implementação → review → promotion gate → commit → push).

---

## 15. Registro de revisão — pós-Gate

Gate encerrado com **APPROVE WITH CHANGES**. Quatro mudanças arquiteturais obrigatórias incorporadas, **exclusivamente** elas. A decisão (Alternativa E — política gated por capability) e o escopo do ADR **não** foram alterados. Nenhum contrato fechado reaberto; nenhuma interface, código ou ADR-E4B-003 produzido.

| # | Mudança obrigatória | Cláusulas |
|---|---|---|
| **1** | **Classe determinística refundada em certeza de não-entrega.** Deixa de depender de "erro tipado"/"pré-despacho". Toda situação em que o provider possa ter aceitado/processado antes da falha (5xx, timeout após aceitação, perda de resposta, aceito-e-errou) é **obrigatoriamente ambígua**. | §2 (definições normativas); §11 risco 2 |
| **2** | **Classifier como árvore de decisão.** Primeiro determina desfecho conhecido × ambíguo; só então aplica transitório × permanente. Órfã (crash-before-settle) é ambígua por construção. Não são mais dois eixos independentes. | §5 item 3; §7; §10.4 |
| **3** | **Reconciliação refinada.** Só resolve a ambiguidade se consultável por identificador disponível **antes** do envio (correlação-cliente, ex.: `messages.id`). Lookup apenas por id retornado pós-envio não cobre crash-before-settle e não satisfaz o requisito — provider nessa condição é tratado como sem a capability. Requisito registrado, interface não definida. | §5 item 2 |
| **4** | **Responsabilidade do Provider Adapter delimitada.** Interpretar respostas específicas, distinguir certeza-de-não-entrega × ambiguidade e emitir a classificação de domínio pertencem ao **adapter**. Delivery Layer, Retry Engine, Scheduler e Failure Classifier permanecem agnósticos e consomem só a classe de domínio. Formalização em **ADR-E4B-003**. | §5 item 6; §6 resposta 4; §9 |

**Consequência da incorporação:** com a classificação de ambiguidade agora definida por certeza-de-não-entrega, emitida pelo adapter e consumida agnosticamente, o gate de bloqueio/reenvio de §5 fica seguro por construção — fechando o vetor de double-send por 5xx mal-classificado que o Gate apontou. §23-C do `ARO-001` é resolvido **definitivamente** por esta revisão, condicionada às entregas já listadas (§14): ADR-E4B-003 e ARO-001 v3.

---

*Fim do ADR. Nenhum código, migration, teste, interface ou estrutura de arquivo de implementação foi produzido. A alteração estrutural do Provider Abstraction e a responsabilidade de classificação do adapter estão registradas como ADR-E4B-003, a escrever.*
