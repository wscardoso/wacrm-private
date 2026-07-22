# ADR-E4B-003 — Provider Idempotency & Delivery-Reconciliation Capability Contract

| | |
|---|---|
| **Tipo** | Architecture Decision Record — **contrato estrutural** (estrutura de abstração, não comportamento de runtime) |
| **Épico** | E4b — Async Recovery & Retry Orchestration |
| **Deriva de** | `ADR-E4B-002` §5 (itens 2, 5, 6), §6 (respostas 2, 3, 4), §9 — contraparte estrutural das decisões de política já congeladas · `DLB-001` §4.3 (agnosticismo), §5 (o provider declara), §8 e §10.1 (capability é contrato; default seguro), §7 (despacho único) · `ADR-MSG-001` D3 (o provider declara identidades/semântica), D6 (proibição de import direto) |
| **Resolve** | O **último bloqueador estrutural** de E4b: a materialização, na abstração do Provider, das capabilities e da responsabilidade de classificação que `ADR-E4B-002` decidiu como política mas não pôde executar sem tocar contrato fechado |
| **Status** | Proposto · pronto para Gate |
| **Autoridade** | **Não cria política nova, não altera decisão existente, não reabre contrato fechado.** Transforma em contrato estrutural exclusivamente o que `ADR-E4B-002` já decidiu. Decide **estrutura de abstração**, nunca comportamento de runtime — o comportamento é de `ADR-E4B-002` e `ARO-001`. |
| **Baseline de código** | HEAD `8057b22` |
| **Antecedentes** | `ADR-E4B-001` (Opção A) · `ADR-E4B-002` (política de ambiguidade, Alternativa E) |

---

## 1. Contexto

`ADR-E4B-002` decidiu a política oficial para a ambiguidade de entrega (Alternativa E — gated por capability): o comportamento sob ambiguidade depende do que o provider **declara**, consultado de forma agnóstica pelo domínio. Ao fazê-lo, `ADR-E4B-002` §5 item 5 e §9 constataram que a política **exige** duas coisas que hoje **não existem** na abstração e cuja materialização toca um contrato fechado — motivo pelo qual foram exiladas para este ADR:

1. **A abstração não declara capability alguma.** Verificado em `8057b22`: a interface do Provider expõe operações de envio, parsing de entrada e verificação de webhook, mas **nenhuma** declaração de idempotência ou de reconciliação. A capability que `ODI-001` §6.3 e `ARO-001` §11 pressupõem é hoje **implícita** — o anti-padrão que `DLB-001` §10.1 nomeou ("capability não é suposição otimista; é contrato").

2. **A abstração não tem canal para a classificação de desfecho.** `ADR-E4B-002` §5 item 6 decidiu que interpretar a resposta bruta do provider e distinguir **certeza-de-não-entrega** de **ambiguidade** é responsabilidade específica-de-provider e deve residir no **Provider Adapter**, que emite uma **classificação de domínio** consumida agnosticamente. Hoje não há esse canal: o resultado de envio carrega identidades (`DLB-001` §5), não uma classe de desfecho.

`ADR-E4B-002` §9 registrou que ambas são **alteração estrutural do Provider Abstraction** — contrato fechado por `DLB-001`, E1 e E2.1 — e, portanto, **ADR próprio**. Este é esse ADR.

**Nota sobre `DLB-001` §8/§9.** `DLB-001` §8 estabeleceu o *conceito* de negociação de capacidade e §9 previu um portador (`capabilities.ts`) que **nunca foi construído** (excluído de E4a). Logo, este ADR não estende um mecanismo existente: introduz o **primeiro** portador de capability da abstração. Isso é **implementação diferida de `DLB-001` §8**, não alteração de sua decisão — a decisão de que "capability é contrato" já era de `DLB-001`; aqui ela é materializada para dois novos eixos.

---

## 2. Problema

`ADR-E4B-002` deixou três exigências estruturais sem portador na abstração. Sem elas, a política congelada **não é implementável sem violar o agnosticismo** (`DLB-001` §4.3) — a única alternativa seria o domínio conhecer a identidade do provider.

- **P-1 — Capability de idempotência não declarável.** O caminho rápido ("provider deduplica reenvio → reenviar com a mesma chave é seguro") depende de saber, de forma abstrata, se o provider tem idempotência nativa. Sem declaração, o domínio teria de codificar `provider === 'meta'`.
- **P-2 — Capability de reconciliação não declarável, e com requisito de utilidade.** O caminho de reconciliação (`ADR-E4B-002` §5 item 2) só resolve a ambiguidade se a consulta puder ser feita por um identificador **possuído antes do envio** (correlação-cliente). A abstração não expressa nem a existência dessa capability nem seu requisito de utilidade.
- **P-3 — Classificação de desfecho não tem canal.** A distinção certeza-de-não-entrega × ambiguidade é específica-de-provider (`ADR-E4B-002` §5 item 6). Sem um canal na fronteira do adapter, essa semântica vazaria para o Failure Classifier, que passaria a interpretar respostas brutas de Meta/Z-API/UAZAPI — violando `DLB-001` §4.3.

O problema deste ADR é **exclusivamente estrutural**: dar portador contratual a P-1, P-2 e P-3, sem decidir nenhum comportamento (o comportamento já está em `ADR-E4B-002`).

---

## 3. Decisão

Este ADR fixa **três elementos de estrutura de abstração**. Nenhum descreve runtime; cada um é um *contrato de forma* que a camada de providers passa a honrar e o domínio a consumir.

### 3.1 A abstração do Provider passa a declarar um contrato de capabilities

A abstração ganha um **contrato de capabilities** — um conjunto de propriedades declaradas, consultáveis de forma abstrata pelo domínio, que descrevem **o que o provider garante**, não como o faz. É o portador que `DLB-001` §8 previu e §9 não materializou. Este ADR o institui para os eixos de E4b; sua forma é aditiva e não redefine as operações de envio, parsing ou verificação já existentes.

**Propriedade contratual:** o domínio decide caminhos consultando este contrato, nunca a identidade do provider. Este é o cumprimento estrutural de `DLB-001` §4.3.

### 3.2 Dois eixos de capability, **independentes**

O contrato de capabilities expressa **dois eixos distintos e ortogonais**, conforme `ADR-E4B-002` §6 resposta 3:

- **Native Idempotency** — o provider garante que um reenvio portando a mesma chave de idempotência (`ODI-001` §6.1, `= messages.id`) **não** produz segundo envio real. É a garantia que habilita o caminho rápido (reenvio cego seguro).
- **Delivery Reconciliation (por correlação-cliente)** — o provider garante que o estado de entrega de uma tentativa pode ser **consultado por um identificador possuído antes do envio** (correlação-cliente, `ODI-001` §6.1). É a garantia que habilita o caminho de reconciliar-antes-de-reenviar.

**Independência — normativa.** Os dois eixos são **ortogonais**: um provider pode ter um sem o outro, ambos, ou nenhum. O contrato **não** pode acoplá-los (ex.: derivar um do outro, ou expressá-los como um único grau). Acoplar reintroduziria suposição onde `ADR-E4B-002` exigiu declaração explícita.

**Requisito de utilidade da reconciliação — estrutural.** O eixo de reconciliação, para ser satisfeito, exige que a consulta seja por identificador **anterior ao envio**. Uma reconciliação consultável **apenas** por identificador retornado **depois** do envio (id do provider) **não satisfaz o contrato** — porque não cobre o cenário *crash-before-settle*, em que esse id é justamente o que se perdeu (`ADR-E4B-002` §5 item 2). Estruturalmente: o contrato de reconciliação é definido de modo que a declaração só seja **verdadeira** quando a consulta por correlação-cliente existir. Um provider sem isso declara o eixo como ausente. Este ADR fixa **o requisito**; não define a forma da consulta.

### 3.3 Default conservador — `false` por ausência

Toda capability **ausente, não declarada ou não verificada** vale, por contrato, o **valor mais conservador** — a garantia **não** existe. Estruturalmente:

- ausência de declaração ≡ capability `false`;
- declaração não verificada ≡ tratada como `false` até verificação (`DLB-001` §10.1);
- o domínio nunca infere uma capability de um sinal indireto; só a lê do contrato.

Isto materializa `DLB-001` §10.1 ("o custo de subutilizar uma capacidade é menor que o de presumir uma inexistente") no plano estrutural: a forma default da abstração é a segura. Adicionar um provider sem declarar nada o coloca automaticamente no caminho de bloqueio de `ADR-E4B-002` — seguro por construção.

### 3.4 A classificação de desfecho é responsabilidade exclusiva do Provider Adapter

O Provider Adapter — e **somente** ele — é responsável, na abstração, por:

1. **interpretar as respostas e erros específicos** do provider;
2. **distinguir certeza-de-não-entrega × ambiguidade** (`ADR-E4B-002` §2), aplicando a regra de fronteira "na ausência de certeza de não-entrega, é ambíguo";
3. **emitir a classificação de domínio** — o desfecho já traduzido para o vocabulário do domínio (`ambíguo | determinístico-transitório | determinístico-permanente`, `ADR-E4B-002` §5 itens 3 e 6);
4. **impedir o vazamento** de qualquer semântica específica-de-provider para além de sua própria fronteira.

**Espelhamento de `DLB-001` §5 — normativo.** Esta responsabilidade é a mesma forma que `DLB-001` §5 já deu à declaração de identidades: *o provider declara no vocabulário do domínio; o domínio consome sem conhecer o protocolo.* A classificação de desfecho é a segunda coisa que o adapter **declara**, ao lado das identidades. Não é mecanismo novo — é o mesmo padrão aplicado a um segundo objeto.

**Canal, não comportamento.** Este ADR institui o **canal** pelo qual a classe de domínio é emitida — estrutura. **Como** o adapter decide a classe para cada resposta concreta de Meta/Z-API/UAZAPI é interpretação específica que reside dentro do adapter e **não** é matéria deste ADR (nem de nenhum ADR — é implementação de adapter). O contrato fixa apenas que a classe **é emitida pelo adapter** e **consumida como classe**, nunca como resposta bruta.

### 3.5 O contrato consumido pelo domínio — agnosticismo total

Delivery Layer, Retry Engine, Scheduler e Failure Classifier consomem **apenas**:

- as **capabilities declaradas** (§3.2), para escolher caminho; e
- a **classe de domínio emitida** (§3.4), para classificar desfecho.

Nenhum deles lê a identidade do provider nem sua resposta bruta. O **único** ponto da abstração onde conhecimento específico-de-provider é legítimo é **dentro do adapter** — como já o são a declaração de identidade (`DLB-001` §5) e o despacho de `getProvider` (`DLB-001` §7). Fora do adapter, a semântica de provider **não existe**.

Este é o cumprimento estrutural do agnosticismo de `DLB-001` §4.3: não uma promessa de disciplina, mas uma forma de abstração em que o domínio **não tem** acesso ao que o violaria.

---

## 4. Extensibilidade

Um provider futuro (o 4º e seguintes) integra-se **exclusivamente** por dois atos, ambos confinados à camada de providers:

1. **declarar suas capabilities** (Native Idempotency e/ou Delivery Reconciliation, ou nenhuma — default `false`); e
2. **implementar seu adapter**, incluindo a emissão da classificação de domínio (§3.4).

**Nenhuma alteração** é exigida no Delivery Layer, Retry Engine, Scheduler, Failure Classifier, em `ARO-001`, em `ADR-E4B-002` ou neste ADR. O domínio já ramifica sobre capability e classe de domínio abstratas; um provider novo apenas preenche esses dois pontos. Este é o teste estrutural do agnosticismo (§3.5) e a resposta à pergunta de `ADR-E4B-002` §7: integrar provider = declarar capability + implementar adapter, nada mais.

---

## 5. Consequências arquiteturais

- **A abstração ganha um segundo objeto de declaração.** Antes, o adapter declarava identidades (`DLB-001` §5). Agora declara também capabilities (estáticas) e classe de desfecho (por tentativa). A abstração fica mais rica, mas o **padrão** é o mesmo — provider declara, domínio consome —, sem novo princípio.
- **A semântica de provider fica estruturalmente confinada.** Após este ADR, é impossível ao domínio agir sobre resposta bruta de provider: ele não a recebe. O agnosticismo deixa de depender de vigilância e passa a ser propriedade da forma.
- **O caminho seguro de `ARO-001` §11/§16 torna-se consumível.** A condição "segurança do reenvio assegurada" (`ARO-001` §11) passa a ter um portador concreto: a leitura das capabilities. O bloqueador §23-C, decidido em política por `ADR-E4B-002`, ganha aqui sua base estrutural.
- **Assimetria entre providers é expressa como dado, não como código.** Meta declara Native Idempotency; Z-API/UAZAPI declaram ambos os eixos ausentes (default `false`) até verificação. A diferença de capacidade vive na declaração, não em ramos condicionais do domínio — e reverte-se por re-declaração, sem tocar contrato.
- **Verificação é pré-condição de declaração positiva.** Coerente com `DLB-001` §10.1: declarar uma capability `true` sem verificá-la é violação de contrato; enquanto não verificada, vale `false`. Isto vale inclusive para a premissa de idempotência nativa da Meta — declarada, mas sujeita a verificação.

---

## 6. Impacto sobre os contratos existentes

| Contrato / componente | Impacto | Reabre? |
|---|---|---|
| **ADR-MSG-001** | D3 ("o provider declara") é o **fundamento** do contrato de capabilities e da classificação pelo adapter; D6 (sem import direto) preservado — a semântica fica no adapter. Nenhuma decisão tocada. | **Não** |
| **ODI-001** | A `idempotency_key = messages.id` (§6.1) é o **identificador de correlação-cliente** que o eixo de reconciliação (§3.2) exige e que o eixo de idempotência propaga (§6.3). Consumo, não alteração. | **Não** |
| **DLB-001** | **Materializa** §8 (capability é contrato) e §9 (portador previsto, nunca construído) para dois eixos novos; espelha §5 (provider declara) para a classe de desfecho; cumpre §4.3 (agnosticismo) e §10.1 (default seguro) no plano estrutural. Implementação diferida de decisões de `DLB-001`, **não** alteração delas. | **Não** |
| **ADR-E4B-001** | Sem contato estrutural — Opção A (estados, `failed` terminal, 048 inalterada) intacta. | **Não** |
| **ADR-E4B-002** | **Contraparte estrutural.** Materializa §5 itens 2/5/6 e §6 respostas 2/3/4. **Não altera** a política nem o texto de `ADR-E4B-002` (restrição respeitada). | **Não** |
| **ARO-001** | Torna consumível a condição de `ARO-001` §11/§16; nenhuma cláusula de ARO-001 é alterada por este ADR. A atualização de ARO-001 para v3 (ponteiro de §23-C) permanece tarefa própria, já prevista em `ADR-E4B-002` §10. | **Não** por este ADR |
| **Provider Abstraction** | **Alteração estrutural aditiva** — o objeto deste ADR: contrato de capabilities + canal de classe de desfecho. Não redefine operações existentes. | É o próprio escopo |
| **EIS-001** | Sem contato. | **Não** |

---

## 7. Necessidade de atualização de outros ADRs

- **`ADR-E4B-002`:** **nenhuma** atualização exigida por este ADR (restrição do escopo respeitada). E4B-002 já previu e delegou tudo o que aqui se materializa.
- **`ARO-001` → v3:** permanece necessária, mas **já prevista por `ADR-E4B-002` §10** — registrar §23-C como decidido e concretizar §11/§16/§7. Este ADR fornece a base estrutural que a v3 referenciará; não a executa nem a antecipa.
- **`DLB-001`, `ODI-001`, `ADR-MSG-001`:** **nenhuma** — todos consumidos, nenhum alterado.
- **Taxonomia `ARO-001` §23-A:** permanece o portador da taxonomia concreta de erros; este ADR fixa apenas que a **classe de domínio** é o que atravessa a fronteira, não os erros brutos que a originam.

---

## 8. Conformidade

- **Nenhuma política nova.** Todo comportamento referenciado (caminhos gated, bloqueio da classe ambígua, árvore de decisão do classifier) é de `ADR-E4B-002`; este ADR só dá **forma** ao que os habilita.
- **Nenhum contrato fechado reaberto.** `ADR-MSG-001`, `ODI-001`, `DLB-001`, `EIS-001`, `ADR-E4B-001`, `ADR-E4B-002` intactos — todos consumidos.
- **Nenhum runtime decidido.** O ADR fixa estrutura de abstração (capabilities declaráveis; canal de classe de desfecho; confinamento da semântica ao adapter). Não decide quando, quanto ou como se reenvia — isso é `ADR-E4B-002` e `ARO-001`.
- **Restrições honradas.** Sem código, TypeScript, interfaces concretas, nomes de propriedade, arquivos, migrations, testes ou discussão de implementação. Os dois eixos e a responsabilidade do adapter são descritos como **propriedades de contrato**, não como artefatos.
- **Separação política × estrutura preservada.** `ADR-E4B-002` = política (o quê e quando). `ADR-E4B-003` = estrutura (que forma a abstração assume para tornar a política consumível de forma agnóstica). Sem sobreposição.

---

## 9. Encerramento do último bloqueador estrutural

`ADR-E4B-002` §9 nomeou este ADR como **o último bloqueador estrutural antes da implementação de E4b**. Com este contrato:

- **§23-B** (Opção A) — resolvido por `ADR-E4B-001`;
- **§23-C** (ambiguidade sem idempotência nativa) — resolvido em **política** por `ADR-E4B-002` e em **estrutura** por este ADR;
- a base estrutural que `ARO-001` §11/§16 consome está **materializada como contrato**.

Resta, antes do código, apenas a **atualização documental** já prevista — `ARO-001` v3 (ponteiro de §23-C, `ADR-E4B-002` §10) —, que é registro, não decisão. Concluída ela, **E4b está liberado para a fase de implementação** pelo fluxo disciplinado (documento → gate → implementação → review → promotion gate → commit → push), sem nenhum bloqueador arquitetural pendente.

---

*Fim do ADR. Estrutura de abstração apenas — nenhum comportamento de runtime, código, interface, nome, arquivo, migration ou teste foi decidido. Este ADR é a contraparte estrutural de `ADR-E4B-002` e o último bloqueador estrutural de E4b.*
