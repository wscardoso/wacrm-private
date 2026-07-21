# DN-001 — Pré-condições de implementação do EIS-001

| | |
|---|---|
| **Tipo** | Nota de decisão |
| **Deriva de** | `ADR-MSG-001 v4` (D2, D3, D4, invariante A) · `EIS-001` (§5.2, §6, §8 critério 1) |
| **Status** | **Aprovada** |
| **Efeito** | Registra três decisões que condicionam o início da implementação de E2.0 |
| **Autoridade** | Não altera decisão do ADR nem cláusula do EIS-001, que permanece **fechado**. Registra pré-condições descobertas na preparação da implementação. |
| **Baseline de código** | HEAD `c8f1585` |

---

## Contexto

O EIS-001 foi aprovado e fechado para implementação. O levantamento dos arquivos a alterar, feito contra o baseline, revelou três lacunas entre o contrato e o código real. Nenhuma invalida o EIS-001; todas condicionam quando e como ele pode ser executado.

As três convergem para o mesmo ponto arquitetural, registrado em §4.

---

## D-1 — O canal de declaração de identidade no caminho de saída não tinha dono

### Achado

`SendResult` é hoje `{ messageId: string }` (`src/lib/whatsapp/providers/types.ts`). O EIS-001 §6 exige que o adaptador Z-API declare **duas** identidades no envio, e o tipo não tem onde carregá-las.

O EIS-001 §1.2 exclui do seu escopo o contrato da operação de interpretação de payload, remetendo-o a E1 — mas essa operação pertence ao caminho de **entrada**. A declaração de identidade no caminho de **saída** não estava atribuída a nenhum contrato.

### Decisão

`SendResult` evolui para transportar identidades declaradas. A alteração integra a **preparação necessária de E2.0** e não é intromissão em E1.

Forma normativa mínima:

- `SendResult` passa a carregar, além do identificador primário, o conjunto de identidades declaradas pelo adaptador, no sentido de `ADR-MSG-001` D2.
- Introduz-se um tipo `ExternalIdentity` com espécie e valor, alinhado ao registro de espécies do EIS-001 §3.3.
- **Regra de consistência:** o identificador primário devolvido em `SendResult` **deve ser o valor de exatamente uma das identidades declaradas**. Não pode ser valor não declarado, nem valor ausente do conjunto.

### Fundamento da regra de consistência

Ela torna o defeito R16 estruturalmente impossível. O bug original consiste em o campo primário receber um valor (`zaapId`) que os callbacks não referenciam. Exigir que o primário pertença ao conjunto declarado não impede sozinho a escolha errada, mas torna a divergência verificável por asserção sobre o próprio tipo — e é a contrapartida em código do critério 10 do EIS-001, que verifica o valor persistido.

### Escopo

Alteração de tipo e dos três adaptadores. Não altera a semântica de `messages.message_id`, preservada por `ADR-MSG-001` D2.

---

## D-2 — O critério 1 do EIS-001 não é satisfazível dentro de E2.0 isolado

### Achado

O critério 1 exige que **toda** mensagem criada após E2.0 possua ao menos uma identidade, na mesma transação de sua criação.

Mensagens de saída são criadas hoje em quatro lugares distintos, verificados no baseline:

| Local | Linha |
|---|---|
| `src/app/api/whatsapp/send/route.ts` | 314 (ramo não-Meta), 487 (ramo Meta) |
| `src/app/api/whatsapp/broadcast/route.ts` | 232 |
| `src/lib/automations/meta-send.ts` | 152 |
| `src/lib/flows/meta-send.ts` | 126 |

Os três últimos são exatamente os call-sites que E1 unifica sob a camada de entrega (`ADR-MSG-001` §2.1, D6).

Sem E1, restam duas saídas, ambas ruins: violar o critério 1, ou fazer E2.0 invadir o escopo de E1 tocando os quatro lugares.

### Decisão

**E1 é pré-requisito duro de E2.0**, por necessidade e não por preferência. A ordenação do roadmap — E1 → E2.0 → E2.1 — passa a ter fundamento normativo registrado, e não apenas de conveniência de sequenciamento.

O critério 1 do EIS-001 **permanece inalterado**. Ele é satisfazível assim que existir caminho unificado de criação, que é precisamente o que E1 entrega. Não há reescopo; há ordenação.

### Consequência sobre a precedência crítica

`ADR-MSG-001` §6.2 já estabelece que a Etapa 2 (identidade) precede obrigatoriamente a Etapa 3 (status), sob pena de dano silencioso. Esta nota acrescenta que a Etapa 1 (fronteira) precede obrigatoriamente a Etapa 2. A cadeia completa de precedências duras passa a ser:

```
E1  →  E2.0  →  E2.1
```

Nenhuma delas admite inversão.

### Registro da dependência

O MASTER ROADMAP v1.1 não possui artefato versionado no repositório neste momento. Até que possua, **esta nota é a fonte da dependência E1 → E2.0**. Quando o roadmap for persistido, o grafo de §8 daquele documento deve refletir esta precedência e citar DN-001.

---

## D-3 — O caminho de saída não possui atomicidade equivalente à do inbound

### Achado

O EIS-001 §5.2 exige que identidade e mensagem sejam persistidas na mesma transação. No caminho de entrada isso já é possível: `insert_inbound_message` (migration 035) é `SECURITY DEFINER` e constitui a fronteira transacional.

No caminho de saída não há equivalente — `send/route.ts:314` executa insert direto pelo cliente. O cliente supabase-js não emite transação multi-statement, de modo que **a atomicidade exigida por §5.2 é inalcançável no caminho de saída sem uma fronteira transacional própria**.

Sem ela, uma falha ao gravar identidade deixaria mensagem persistida sem capacidade de correlação — estado que §5.2 proíbe expressamente.

### Decisão — desenho do mecanismo

**Fronteira transacional.** Uma operação `SECURITY DEFINER` no banco, no mesmo regime de 035: `REVOKE ALL FROM PUBLIC`, `SET search_path = public`, escrita exclusivamente server-side, sem policy de escrita para cliente (EIS-001 §3.5). O corpo único da função é a transação; não há transação distribuída entre banco e provider, e o desenho não pretende haver.

**Operação de liquidação (*settlement*).** A operação registra, num único ato, o resultado de uma tentativa de envio: o estado resultante da mensagem e o conjunto de identidades declaradas pelo adaptador. Ou grava tudo, ou não grava nada.

**Compatibilidade deliberada com D4.** `ADR-MSG-001` D4 estabelece a progressão *intenção → tentativa → resultado → estado*, e sua implementação pertence a E4a, posterior a E2.0. O desenho evita retrabalho por uma escolha explícita:

- Em **E2.0**, a liquidação é chamada uma vez, após o retorno do provider, criando a mensagem já liquidada com suas identidades. O comportamento observável permanece o atual — persistência após envio.
- Em **E4a**, acrescenta-se **à frente** dela a criação da intenção, e a liquidação passa a transicionar uma mensagem que já existe em vez de criá-la.

A operação de liquidação é desenhada desde já para aceitar os dois modos, de forma que **E4a acrescente uma etapa anterior sem reescrever a liquidação**. Isto é antecipação de forma, não absorção de escopo: E2.0 não implementa persist-before-send, não implementa transição de estado por falha e não implementa idempotência de reenvio — tudo isso permanece em E4a.

**Idempotência.** A liquidação obedece ao EIS-001 §5.5: repetição da mesma tripla `(connection_ref, kind, value)` para a mesma mensagem é no-op; para mensagem diferente é conflito e falha ruidosamente.

**Relação com o invariante A.** O gate de efeitos colaterais do invariante A governa o caminho de **entrada**. O caminho de saída não possui, hoje, gate equivalente — é o achado **N-3**, registrado em aberto no `ADR-MSG-001` §11 e §12. A liquidação **não o resolve e não o presume**. Quando N-3 for decidido, ela é o ponto natural de aplicação do gate, e o desenho não deve criar obstáculo a isso.

### Decisão — localização arquitetural

O mecanismo reside na **camada de entrega** — `src/lib/whatsapp/delivery/` —, criada por E1 e uma das duas únicas camadas autorizadas por `ADR-MSG-001` D6 a conhecer detalhes de provider.

Não reside:

- **Na rota.** A rota é transporte. Persistência de mensagem de saída é concern de domínio, e mantê-la na rota é o que produziu a dispersão em quatro lugares descrita em D-2.
- **No adaptador de provider.** O adaptador declara identidades e não conhece persistência. Inverter isso violaria a divisão de responsabilidade normativa de D3: *o provider declara, o domínio resolve*.
- **Na camada de identidade** (`src/lib/whatsapp/identity/`, EIS-001 §4). Aquela camada resolve identidade a partir de valor; ela é consultada pela liquidação, não a executa.

---

## 4. Convergência das três decisões

D-1, D-2 e D-3 são o mesmo achado observado por três ângulos: **a criação de mensagem de saída não tem dono único.**

- D-1 é a ausência de canal para declarar identidade nesse caminho.
- D-2 é a dispersão desse caminho por quatro locais.
- D-3 é a ausência de fronteira transacional nele.

A resposta é única e já estava decidida no ADR: **a camada de entrega criada por E1 é o proprietário único da criação de mensagem de saída** — e, por consequência, da declaração de identidade, da liquidação transacional e, quando N-3 for decidido, do gate de efeitos.

Esta convergência é o fundamento real de D-2. E1 não precede E2.0 por conveniência de cronograma; precede porque **E2.0 não tem onde escrever até que E1 exista**.

---

## 5. Efeitos sobre documentos vigentes

| Documento | Efeito |
|---|---|
| `ADR-MSG-001 v4` | **Nenhuma alteração.** Nenhuma decisão foi alterada, ampliada ou reinterpretada. D-3 aplica D4 e a localização deriva de D6 |
| `EIS-001` | **Nenhuma alteração.** Permanece fechado. O critério 1 é preservado na íntegra; D-2 é ordenação, não reescopo |
| MASTER ROADMAP v1.1 | Precedência E1 → E2.0 passa a ser dura. Sem artefato versionado; esta nota é a fonte até que exista |

---

## 6. Pré-condições para iniciar a implementação

1. **E1 concluído**, entregando o caminho unificado de criação de mensagem de saída na camada de entrega.
2. **`SendResult` evoluído** conforme D-1, com a regra de consistência do identificador primário.
3. **Operação de liquidação especificada** em contrato de implementação de E2.0, conforme o desenho de D-3.

Enquanto as três não estiverem satisfeitas, **nenhuma alteração de código de E2.0 deve ser iniciada**.

---

## 7. Pendências que permanecem abertas

1. **N-3** — deduplicação de efeitos no caminho de saída (`ADR-MSG-001` §11). A liquidação de D-3 é o ponto natural de aplicação quando for decidido.
2. **Convivência `delivered` / `received`** — as três consequências normativas de `ADR-MSG-001` §7 seguem sem portador documental. Devem entrar no contrato de E2.0 antes de E2.1.
3. **Persistência do MASTER ROADMAP** como artefato versionado, para que o grafo de dependências tenha fonte no repositório.
4. **Retenção de variante de evento não reconhecida** (`ADR-MSG-001` D3) — contrato derivado ainda não escrito.
