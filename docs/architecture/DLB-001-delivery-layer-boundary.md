# DLB-001 — Delivery Layer Boundary Contract

| | |
|---|---|
| **Tipo** | Contrato derivado (design document) |
| **Deriva de** | `ADR-MSG-001 v4` — **D3** (contrato de provider), **D3.b** (seleção de provider), **D6** (proibição de import direto), **D4** (envio como processo) · `DN-001` (D-1, D-2, D-3) |
| **Épico consumidor** | E1 — Delivery Layer & Provider Boundary |
| **Status** | Proposto |
| **Autoridade** | Não altera decisão do ADR. `EIS-001` permanece fechado; este documento é seu pré-requisito, não sua revisão. |
| **Baseline de código** | HEAD `c8f1585` |

---

## 1. Escopo

### 1.1 O que este contrato especifica

A **camada de entrega** (`src/lib/whatsapp/delivery/`): sua responsabilidade, sua fronteira com rota e adaptador, e as quatro propriedades que `DN-001` estabeleceu como pré-requisito de E2.0 —

1. dono único da criação de mensagens de saída;
2. canal de declaração de identidades pelo provider;
3. localização da fronteira transacional da persistência;
4. divisão de responsabilidades entre *route*, *provider adapter* e *delivery layer*.

Especifica ainda o escopo original de E1: unificação dos quatro call-sites, negociação de capacidade, adoção de `MetaProvider.parseInboundMessage` e verificação automática de D6.

### 1.2 O que este contrato não especifica

- **Estrutura de armazenamento das identidades** — `EIS-001` §3.
- **Assinatura concreta da operação de liquidação, sua migration e seu RPC** — contrato de E2.0. Este documento fixa onde a fronteira vive e quem a chama; não a implementa.
- **persist-before-send, transição por falha e idempotência de reenvio** — E4a. Este documento é desenhado para não obstruí-los (§6.3), sem antecipá-los.
- **Resolução de conexão** (D3.a) e **retenção de variante desconhecida** (D3) — contratos próprios, ainda não escritos.
- **`parseEvents` e o ciclo de status** — E2.1.

### 1.3 Rastreabilidade

Cláusula sem citação de decisão do ADR é design livre e está marcada **[SPEC]** — revisável sem reabrir o ADR.

---

## 2. Problema

Verificado no baseline:

**2.1 — A abstração não é load-bearing.** Quatro call-sites importam a API concreta da Meta: `automations/meta-send.ts:1`, `flows/meta-send.ts:9`, `broadcast/route.ts:3`, `react/route.ts:3`. `send/route.ts:248-345` já ramifica corretamente e é o único que respeita a abstração.

**2.2 — A criação de mensagem de saída não tem dono.** Ocorre em quatro lugares: `send/route.ts:314` (não-Meta) e `:487` (Meta), `broadcast/route.ts:232`, `automations/meta-send.ts:152`, `flows/meta-send.ts:126`.

**2.3 — Não há canal para declarar identidade no envio.** `SendResult` é `{ messageId: string }` (`providers/types.ts`).

**2.4 — Não há fronteira transacional no envio.** `send/route.ts:314` executa insert direto; o cliente supabase-js não emite transação multi-statement.

`DN-001` §4 estabelece que 2.2, 2.3 e 2.4 são o mesmo achado: **a criação de mensagem de saída não tem dono único.** Este contrato lhe dá dono.

---

## 3. Decisão estrutural — a camada de entrega

**Autorizado por D6**, que nomeia a camada de entrega como uma das duas únicas autorizadas a conhecer detalhes de provider.

A camada de entrega é o **proprietário único da operação de saída**. Ela é responsável, e é a única responsável, por:

1. resolver a conexão e obter o adaptador correspondente (via D3.b);
2. negociar capacidade e recusar explicitamente o que o provider não suporta;
3. invocar o adaptador;
4. receber as identidades declaradas;
5. persistir mensagem e identidades sob fronteira transacional única.

Nenhuma dessas responsabilidades pertence à rota, e nenhuma pertence ao adaptador.

---

## 4. Divisão de responsabilidades

### 4.1 Route

**É transporte.** Autentica, autoriza, valida entrada, traduz erro em resposta HTTP, e delega.

**Não pode:** criar mensagem, escolher provider, instanciar adaptador, persistir identidade, interpretar resultado de provider.

Após E1, `send/route.ts`, `broadcast/route.ts` e `react/route.ts` não conhecem provider algum.

### 4.2 Provider adapter

**Traduz entre o protocolo do provider e o vocabulário do domínio.** Envia, interpreta payload de entrada e **declara identidades** (D3).

**Não pode:** persistir, conhecer banco, conhecer conexão além da configuração que recebe, decidir correlação. D3 é explícito: *o provider declara identidades; o domínio resolve por busca.*

### 4.3 Delivery layer

**É o domínio da saída.** Executa as cinco responsabilidades de §3.

**Não pode:** conhecer HTTP, autenticar, autorizar. Recebe contexto já autorizado pela rota.

### 4.4 Identity layer

`src/lib/whatsapp/identity/` (`EIS-001` §4) resolve mensagem a partir de valor. **É consultada pela camada de entrega; não a executa.** Não persiste mensagem e não conhece provider.

---

## 5. Canal de declaração de identidades — resolve D-1

**Autorizado por D3 e `DN-001` D-1.**

`SendResult` evolui para transportar, além do identificador primário, o conjunto de identidades declaradas pelo adaptador, no sentido de D2. Introduz-se `ExternalIdentity` com espécie e valor, alinhado ao registro de espécies de `EIS-001` §3.3.

### 5.1 Regra de consistência — normativa

**O identificador primário devolvido em `SendResult` deve ser o valor de exatamente uma das identidades declaradas.** Não pode ser valor não declarado, nem valor ausente do conjunto.

Fundamento: o defeito R16 consiste em o campo primário receber um valor (`zaapId`) que os callbacks não referenciam. A regra não impede sozinha a escolha errada, mas torna a divergência verificável por asserção sobre o próprio tipo, e é a contrapartida em código do critério 10 de `EIS-001`.

### 5.2 Declaração parcial

Identidade ausente é omitida, nunca preenchida com valor vazio (D3). Uma mensagem pode legitimamente ter uma única identidade.

### 5.3 Alcance em E1

E1 **estabelece o canal** e faz os três adaptadores o utilizarem. A correção de qual valor a Z-API declara como primário, e a persistência dessas identidades, pertencem a E2.0 (`EIS-001` §6.1). E1 entrega o canal vazio e correto; E2.0 o preenche.

---

## 6. Fronteira transacional — resolve D-3

**Autorizado por `EIS-001` §5.2 e por `DN-001` D-3.**

### 6.1 Natureza

Uma operação `SECURITY DEFINER` no banco, no regime de `insert_inbound_message` (035): `REVOKE ALL FROM PUBLIC`, `SET search_path = public`, escrita exclusivamente server-side, sem policy de escrita para cliente (`EIS-001` §3.5). O corpo único da função é a transação.

Não há transação distribuída entre banco e provider, e o desenho não pretende haver — é a razão de D4 modelar o envio como progressão de estados e não como operação atômica.

### 6.2 Operação de liquidação

Registra num único ato o resultado de uma tentativa de envio: o estado resultante da mensagem e as identidades declaradas. **Ou grava tudo, ou não grava nada.**

Falha ao gravar identidade invalida a operação inteira. Não há degradação graciosa em que a mensagem é gravada e a identidade omitida (`EIS-001` §5.2).

### 6.3 Compatibilidade com E4a — antecipação de forma, não de escopo

D4 estabelece a progressão *intenção → tentativa → resultado → estado*, cuja implementação pertence a E4a. O desenho evita retrabalho:

- **Em E2.0** — a liquidação é chamada uma vez, após o retorno do provider, criando a mensagem já liquidada com suas identidades. Comportamento observável idêntico ao atual.
- **Em E4a** — acrescenta-se **à frente** dela a criação da intenção, e a liquidação passa a transicionar mensagem existente em vez de criá-la.

A operação é desenhada desde já para aceitar os dois modos, de forma que **E4a acrescente etapa anterior sem reescrever a liquidação**.

E2.0 **não** implementa persist-before-send, **não** implementa transição por falha e **não** implementa idempotência de reenvio. Tudo isso permanece em E4a.

### 6.4 Relação com o invariante A

O gate de efeitos colaterais do invariante A governa o caminho de **entrada** (`inbound-processor.ts:324`). O caminho de saída não possui gate equivalente — é o achado **N-3**, aberto em `ADR-MSG-001` §11.

A liquidação **não o resolve e não o presume**. Quando N-3 for decidido, ela é o ponto natural de aplicação, e nada neste desenho deve criar obstáculo a isso.

### 6.5 Localização

A liquidação é invocada **exclusivamente pela camada de entrega**. Não pela rota (é domínio, não transporte), não pelo adaptador (que não conhece persistência), não pela camada de identidade (que resolve, não persiste).

A assinatura concreta, a migration e o RPC pertencem ao contrato de E2.0.

---

## 7. Seleção de provider — D3.b

**Ponto de despacho único e nomeado**, única autoridade do sistema para a correspondência entre conexão e adaptador. Nenhum módulo instancia adaptador diretamente; nenhum mantém correspondência própria. Adicionar um provider significa registrá-lo nesse ponto, e nada mais.

`getProvider` (`providers/index.ts`) é o candidato natural e já existe — E1 o promove a autoridade única em vez de criar mecanismo novo. **[SPEC]**

---

## 8. Negociação de capacidade

**Autorizado por `ADR-MSG-001` §8.1.**

O adaptador declara quais operações suporta. Operação não suportada produz **erro tipado**, nunca ausência silenciosa e nunca falha opaca.

Isto não conflita com o consumo seguro de variante desconhecida (D3): **capacidade ausente no envio falha ruidosamente; variante desconhecida na entrada é retida sem interromper o lote.** São objetos distintos.

Consequência aceita: falhas hoje invisíveis passam a ser visíveis, e o volume aparente de erro aumenta no curto prazo. É o resultado pretendido.

**Pendência D6 do roadmap:** se providers não-oficiais suportam equivalente a template é questão em aberto e condiciona a matriz de capacidade. Não deve ser presumida.

---

## 9. Escopo de alteração

**Novos**

| Arquivo | Conteúdo |
|---|---|
| `src/lib/whatsapp/delivery/sender.ts` | Operação de saída; ponto único de §3 |
| `src/lib/whatsapp/delivery/capabilities.ts` | Negociação de capacidade e erro tipado |
| `src/lib/whatsapp/providers/no-direct-meta-import.arch.test.ts` | Verificação de D6 |

**Modificados**

| Arquivo | Mudança |
|---|---|
| `src/lib/whatsapp/providers/types.ts` | `SendResult` + `ExternalIdentity` (§5) |
| `src/lib/whatsapp/providers/{meta,zapi,uazapi}.ts` | Passam a declarar identidades pelo canal novo |
| `src/lib/whatsapp/providers/index.ts` | Promovido a autoridade única (§7) |
| `src/lib/automations/meta-send.ts` | Renomear para `engine-send.ts`; passa pela camada de entrega |
| `src/lib/flows/meta-send.ts` | Idem |
| `src/app/api/whatsapp/send/route.ts` | Ambos os ramos passam pela camada de entrega |
| `src/app/api/whatsapp/broadcast/route.ts` | Idem |
| `src/app/api/whatsapp/react/route.ts` | Idem |
| `src/app/api/whatsapp/webhook/route.ts` | Passa a usar `MetaProvider.parseInboundMessage` |
| `eslint.config.mjs` | Proibição de import de `meta-api` fora de `providers/` e `delivery/` |

**Nota:** `automations/meta-send.ts:45` já exporta `engineSendText`, apesar do nome do arquivo. Parte da renomeação já está feita.

**Protegido — não tocar**

```
src/lib/whatsapp/inbound-processor.ts:324   (gate do invariante A — preservar verbatim)
supabase/migrations/001–046                 (histórico fechado — só ADICIONAR)
src/lib/contacts/*                          (P2.1 fechado)
```

---

## 10. Critérios de aceitação

1. `from '@/lib/whatsapp/meta-api'` aparece somente em `src/lib/whatsapp/providers/**` e `src/lib/whatsapp/delivery/**`, verificado por lint **e** por teste de arquitetura.
2. Nenhuma rota instancia adaptador de provider; todas delegam à camada de entrega.
3. A criação de mensagem de saída ocorre em **exatamente um** lugar do código — pré-condição do critério 1 de `EIS-001` (`DN-001` D-2).
4. Matriz `{meta,zapi,uazapi} × {texto,mídia,template,reação}`: cada célula envia, ou falha com erro tipado. **Nenhuma célula pode ficar indefinida** — ver §10.1.
5. Broadcast em conta Z-API envia de fato.
6. Reaction em conta uazapi envia ou falha com erro legível — nunca 500 opaco.
7. `SendResult` carrega identidades declaradas, e o identificador primário é valor de exatamente uma delas (§5.1), verificado nos três adaptadores.
8. O webhook Meta usa `MetaProvider.parseInboundMessage`; o parser inline é removido.
9. Suíte Meta 100% verde **antes** de qualquer alteração e depois dela — critério de regressão do caminho em produção.
10. `tsc --noEmit`, `vitest run` e `next build` verdes.

---

### 10.1 D6 — pendência de fechamento de E1

**Capacidade não é suposição otimista; é contrato.** Se o provider não declara capacidade, o sistema falha de forma tipada (§8). Disso decorre a posição da matriz enquanto D6 do roadmap não tiver evidência documental:

```
template × meta     → supported            (modelo WABA/HSM)
template × zapi     → unsupported (pending provider verification)
template × uazapi   → unsupported (pending provider verification)
```

`unsupported (pending provider verification)` é estado **declarado**, não omissão: a célula existe na matriz, o comportamento é falha tipada, e o teste a verifica. O que permanece aberto é se a declaração está correta, não qual é o comportamento.

Fundamento provisório: template HSM é objeto da WABA — pré-aprovado pela Meta, com categoria, ciclo de aprovação e cobrança por conversa. Providers baseados em biblioteca não-oficial conectam-se por *Linked Devices* fora da WABA, e endpoints que chamam de "template" entregam mensagens estruturadas com botões, que não são o mesmo objeto. O caminho de template do ForceCRM depende de `waba_id`, submissão, sincronização e status de aprovação — nada disso existe em provider não-oficial. A busca pública não produziu evidência conclusiva, e o `AUD-001` §4.2 já classificara a alegação contrária como duvidosa.

**Efeito no ciclo de E1:** D6 **não bloqueia o início** de E1. **Bloqueia o seu fechamento** — E1 não pode ser declarado concluído com a matriz do critério 4 em aberto. A verificação nas contas Z-API e uazapi é pré-requisito de conclusão, não de partida.

Se a verificação demonstrar suporte real em algum provider, a célula muda de `unsupported` para `supported` e o teste correspondente passa a exercitar o envio. O custo dessa direção é uma capacidade temporariamente subutilizada. O custo da direção oposta — presumir suporte inexistente — é envio quebrado em produção.

---

## 11. Riscos

| Risco | Severidade | Mitigação |
|---|---|---|
| Regressão no caminho Meta — é o que está em produção | **Alta** | Assinatura preservada atrás da camada de entrega; suíte Meta verde antes de tocar; verificação manual antes de publicar |
| Remoção acidental do gate do invariante A | **Média** | `inbound-processor.ts:324` declarado protegido em §9 |
| Camada de entrega absorver escopo de E4a | **Média** | §6.3 delimita: E1 e E2.0 não implementam persist-before-send |
| Dispersão residual da seleção de provider | **Média** | §7 + critérios 1 e 2 |
| Matriz de capacidade presumida sem verificar providers não-oficiais | **Média** | §8; pendência D6 do roadmap |

---

## 12. Dependências

**Bloqueia:** E2.0 (`DN-001` D-2 — precedência dura registrada em `MASTER-ROADMAP` §8.1).

**Bloqueado por:** nada. `ADR-MSG-001` foi promovido a `Aceito` em 2026-07-21 (ADR §13), com D1 ratificada e N-3 reclassificado como risco aberto não-bloqueante. **E1 está liberado para implementação.**

**Pendência de fechamento (não de início):** D6 do roadmap — capacidade de template em providers não-oficiais (§10.1).

**Abertas, sem efeito sobre E1:** N-3 (dedup de efeitos na saída, reclassificado como risco não-bloqueante em `ADR-MSG-001` §12) · resolução de conexão (D3.a) · retenção de variante desconhecida (D3).
