# ADR-MSG-001 — Messaging Core & Provider Boundary

| | |
|---|---|
| **Status** | **Proposto — aguardando aprovação arquitetural** |
| **Versão** | **v4** — consolidação das correções convergentes das revisões de 2026-07-21 (ver §12) |
| **Épico** | E0 (MASTER ROADMAP v1.1, §7) |
| **Snapshot auditado** | HEAD `c8f1585`, working tree limpa |
| **Fonte da verdade** | `MASTER-ROADMAP v1.1` |
| **Arquiteto** | Claude/Opus · **Revisão adversarial:** GPT 5.5, Nemetron · **Revisão arquitetural:** duas rodadas, sendo a segunda por leitura cruzada |
| **Supersede** | Nada. **Precede e condiciona:** E1, E2.0, E2.1, E3, E4a, E4b |
| **Contrato derivado emitido** | `docs/architecture/EIS-001-external-identity-storage.md` (D2/D3) |
| **Decisão de produto pendente vinculada** | D1 (§15 do roadmap) — ratificação de `Connection` como unidade |

---

## 1. Contexto

O ForceCRM deriva do template open-source WACRM e é operado pela Digitall Force para si e para clientes de tráfego pago. O produto é dono do inbox WhatsApp desses clientes, e a comunicação é o núcleo do valor entregue.

O sistema possui hoje três adaptadores de provider — Meta (oficial), Z-API e uazapi — declarados em `src/lib/whatsapp/providers/` e commitados com testes. A camada de tenant (RLS em 33 tabelas, isolamento por `is_account_member`) e a camada de platform (`can_access_account`, contexto auditado em `/act`) são maduras e não são objeto deste ADR.

A auditoria consolidada `AUD-001` reuniu quatro análises independentes (Claude, DeepSeek, HY3, GPT 5.5) e produziu 22 achados. Três foram fechados desde então: idempotência de inbound (C4, migrations 034/035), autenticação do webhook não-Meta (C7, migration 036) e rate-limiting (C15). Dezenove permanecem abertos, entre eles os quatro classificados como críticos.

A recomendação convergente das quatro auditorias — reforçada pela leitura mais profunda da GPT 5.5 — foi que um ADR de messaging core precederia qualquer correção. **Esse ADR nunca foi escrito.** O item nº 1 do plano de remediação permaneceu vazio enquanto correções pontuais avançavam. Este documento o preenche.

O roadmap v1.1 arbitrou, contra o código, todas as decisões que este ADR formaliza. Nada aqui é novo em relação ao roadmap; este documento apenas lhes dá forma normativa e as torna citáveis por contratos de implementação.

---

## 2. Problema

### 2.1 A abstração de provider existe no design e não existe no runtime

`send/route.ts` ramifica corretamente entre Meta e não-Meta através de `getProvider()`. Nenhum outro caminho de envio o faz. Quatro call-sites importam a API concreta da Meta diretamente: os motores de automations e flows (via os arquivos nomeados `meta-send.ts`), a rota de broadcast e a rota de reactions.

A consequência é observável e está em produção: um workspace configurado em Z-API ou uazapi recebe mensagens — o webhook não-Meta funciona e é seguro — mas não consegue disparar automação, executar broadcast ou registrar reaction. A falha não é comunicada; ela simplesmente não acontece.

### 2.2 O estado da mensagem não fecha o ciclo fora da Meta

A rota de webhook não-Meta processa exclusivamente mensagens de entrada. Não há tratamento de eventos de status. Toda mensagem enviada por provider não-Meta permanece indefinidamente no estado `sent`, sem transição para `delivered` ou `read`, e sem possibilidade de transição para `failed`.

### 2.3 A identidade externa da mensagem não é modelável por um único campo

A tabela `messages` guarda um campo textual de identificador externo — funcionalmente um *external id*, apenas mal nomeado — e a idempotência de inbound (034) opera sobre ele com um índice único parcial.

O adaptador Z-API, no momento do envio, resolve esse identificador escolhendo entre dois valores distintos que o provider retorna: um identificador interno do próprio Z-API e um identificador do nível WhatsApp. A escolha atual privilegia o identificador interno. Os callbacks de status, porém, referenciam o identificador do nível WhatsApp. O adaptador de inbound, no mesmo arquivo, também lê o identificador do nível WhatsApp.

**O código está inconsistente consigo mesmo.** O efeito hoje é latente porque §2.2 mantém o status não-Meta desligado. No instante em que o status for ligado, a correlação falhará em todas as mensagens Z-API, silenciosamente — mensagens enviadas com sucesso jamais encontrarão seus próprios eventos de status.

Corrigir a precedência da escolha não resolve o problema, apenas troca qual identificador é perdido. **A mensagem tem legitimamente mais de uma identidade externa no mesmo fluxo, e o modelo atual só admite uma.**

Este achado não consta de nenhuma das quatro auditorias do `AUD-001`. Foi identificado durante a arbitragem da revisão adversarial do roadmap v1.0 e está registrado como **R16**.

### 2.4 A conexão não existe como entidade

A configuração de WhatsApp está atrelada à conta por uma restrição de unicidade que permite exatamente uma conexão por workspace. Um cliente não pode operar dois números, e não pode migrar de provider sem janela de indisponibilidade.

O efeito estrutural é mais profundo que a limitação funcional: **não existe uma unidade à qual ancorar identidade externa, capacidades de provider, credenciais ou escopo de conversa.** Toda a informação de integração está dispersa entre a conta e uma configuração singular. Enquanto for assim, qualquer correção de status, dedup ou broadcast será construída sobre `conta → configuração → provider` e refeita quando a segunda conexão existir.

Há um efeito adicional, hoje mascarado pela unicidade: **enquanto existe uma conexão por conta, identificar de qual conexão um evento de webhook procede é trivial.** Com N conexões por conta, deixa de ser — e o problema passa a pertencer à fronteira de provider, não a cada rota isoladamente. Isso vale para **todos** os caminhos de entrada, inclusive o oficial. Ver D3.a e §7.

### 2.5 O problema-raiz

Os quatro sintomas acima não são independentes. Eles compartilham uma causa única: **não existe um domínio de messaging independente de provider, nem uma unidade de integração à qual ancorá-lo.**

Corrigir os sintomas isoladamente é possível e produz alívio imediato. Também produz retrabalho garantido, porque cada correção assume o modelo que precisa mudar. Este ADR existe para impedir esse retrabalho.

---

## 3. Decisão

Sete decisões normativas. Todas foram arbitradas contra o código no roadmap v1.1 e não são reabertas por este documento.

> **Estrutura de dependência — D1 é premissa, não par.**
> As sete decisões não têm o mesmo peso estrutural. **D2, D3.a, D5 e a Etapa 5 derivam de D1 e não subsistem à sua rejeição** — todas caracterizam algo por conexão, e sem a conexão como entidade perdem o seu termo constitutivo.
> **D3 quanto ao contrato de eventos, D4, D6 e D7 são independentes de D1** e permanecem válidas isoladamente: dizem respeito à fronteira de provider, ao modelo de envio e ao ciclo de vida da mensagem, nenhum dos quais pressupõe multiplicidade de conexões.
> Consequência para aprovação: rejeitar D1 não remove uma decisão de sete — remove o fundamento de quatro, e reduz este ADR ao subconjunto independente. É por isso que a ratificação de D1 (§11) bloqueia a promoção do documento inteiro, e não apenas de uma de suas partes.

### D1 — `Connection` é a unidade de integração

A entidade central do domínio de messaging passa a ser a **conexão**, não a conta e não o provider.

`provider` é uma **propriedade** da conexão, não um eixo de modelagem. Credenciais, capacidades, identidade externa e escopo de conversa ancoram-se na conexão. A conta possui conexões; a conexão possui mensagens e conversas.

A configuração de WhatsApp existente passa à condição de **legado**, mantida durante a transição por uma camada de compatibilidade de leitura, e não recebe funcionalidade nova.

> *Racional:* é a única decisão que resolve §2.4 e §2.5 simultaneamente, e é pré-condição das demais. Sustentada após revisão adversarial: nenhuma das críticas a atingiu, e o achado R16 a reforça — o identificador ambíguo do Z-API é precisamente um sintoma de identidade sem âncora de conexão.

### D2 — A identidade externa de uma mensagem é um **conjunto**, não um campo

Uma mensagem possui N identidades externas. Cada identidade é caracterizada por sua **conexão de origem**, uma **espécie** (`provider_message_id`, `provider_status_id`, `wamid` — conjunto extensível) e um **valor**.

O domínio **nunca** pergunta "qual é o identificador desta mensagem?". Pergunta **"que mensagem responde por este valor?"**, e obtém a resposta por resolução direta, de forma idêntica para qualquer provider.

O campo textual hoje existente em `messages` **permanece** como identidade primária de exibição e como base do índice de idempotência de inbound. Ele não é removido, não é renomeado e não muda de semântica.

**Semântica da identidade declarada.** Uma identidade declarada por um provider é uma **asserção de correlação**: o provider afirma que eventos futuros que referenciarem aquele valor, naquela conexão, dizem respeito àquela mensagem. Essa asserção tem alcance delimitado e o ADR o declara explicitamente:

- **Garante** correlação dentro do escopo da conexão de origem.
- **Não garante** unicidade global entre providers, entre conexões, nem estabilidade perpétua do valor no provider.
- **Não garante** que o provider venha a referenciá-la — a declaração de uma identidade não obriga o provider a usá-la, e é exatamente por isso que o conjunto admite N elementos: declara-se tudo o que se conhece, porque não se sabe de antemão o que será referenciado.

**O conjunto é mecanismo de correlação do domínio, não metadado descritivo.** É a estrutura sobre a qual a resolução acontece, e dela dependem a idempotência do ciclo de status e a integridade do vínculo entre mensagem e seus eventos. Perder um elemento do conjunto é perder capacidade de correlação — não é perder informação acessória. Esta distinção é normativa: nenhum contrato derivado pode tratar o conjunto como enriquecimento opcional.

**Estado transitório da ancoragem.** A ancoragem em conexão é constitutiva da caracterização e **provisória na sequência de migração**. Até que D1 esteja implementada (Etapa 5), a identidade existe com a ancoragem pendente, e a unicidade efetiva permanece garantida pelo **invariante B**. A conclusão de D1 promove a ancoragem a obrigatória e transfere a garantia de unicidade para o escopo da conexão. **Nenhum estado intermediário admite identidade sem invariante B vigente** — a ancoragem pode estar pendente; a unicidade, nunca.

A forma de armazenamento dessas identidades é decisão de contrato de épico, não deste ADR. O que este ADR fixa é a **cardinalidade** (N por mensagem), a **caracterização** (conexão, espécie, valor), o **modo de acesso** (resolução por valor, nunca leitura por campo), o **alcance das garantias** e o **regime transitório da ancoragem**.

> *Racional:* substitui a formulação `(connection_id, external_id)` da v1.0 do roadmap. Um par único força o adaptador a escolher entre identificadores igualmente legítimos — e hoje escolhe errado (§2.3). Um conjunto elimina a escolha em vez de arbitrá-la, e absorve o próximo provider que introduzir um quarto identificador sem alteração de modelo.

### D3 — O contrato do provider emite eventos que **declaram** identidades

A interface de provider expõe uma operação única de interpretação de payload que retorna uma **sequência de eventos canônicos**: mensagem de entrada, status de mensagem, reação e status de conexão.

**O contrato é extensível, não fechado.** Esta escolha é única e vale para todo o documento; não há tipagem fechada em nenhum ponto do modelo de eventos. *Extensível* tem significado normativo preciso e bidirecional:

- **Adição de variante é aditiva.** Um tipo de evento novo é introduzido sem alteração da interface e sem tocar adaptadores que não o emitem.
- **Consumo de variante desconhecida é seguro.** Todo consumidor deve prosseguir diante de variante que não reconhece, sem erro e sem interromper o processamento das demais variantes do mesmo lote. Um adaptador atualizado à frente do domínio não pode derrubar o processamento.

**O consumo seguro é não-destrutivo.** *Prosseguir* significa **não processar**, e não significa **descartar**. Variante não reconhecida não é interpretada e **não é perdida**: permanece recuperável para processamento posterior, quando o domínio a reconhecer. A propriedade de não-perda é decisão deste ADR; a forma de retenção é matéria de contrato derivado.

Esta cláusula é o que torna a extensibilidade segura. Sem ela, a mesma decisão que permite ao adaptador evoluir à frente do domínio abriria um caminho de perda silenciosa de evento — inclusive de mensagem de entrada — contradizendo a postura de garantia que o restante do documento assume.

Cada evento carrega o **conjunto de identidades externas que o provider conhece naquele momento**, no sentido estabelecido por D2. Identidades ausentes são omitidas; nunca são preenchidas com valor vazio.

A divisão de responsabilidade é normativa: **o provider declara identidades; o domínio resolve por busca.** O provider não descreve *como* correlacionar, e o domínio não interpreta estruturas de correlação específicas de provider.

**Dois mecanismos integram a fronteira de provider e são declarados obrigatórios por este ADR:**

**D3.a — Resolução de conexão.** Todo evento recebido por endpoint público deve ser atribuído a exatamente uma conexão **antes** de qualquer interpretação de domínio. A resolução é responsabilidade da fronteira de provider, não de cada rota.

O alcance é **universal e sem exceção por provider**: aplica-se ao caminho oficial e aos não-oficiais igualmente. Enquanto vigorar a unicidade de conexão por conta, a resolução é trivial em todos eles, e a implementação atual do endpoint não-Meta já a satisfaz (invariante C). Com N conexões por conta, ela deixa de ser trivial **em todos os caminhos**, e passa a ser o primeiro passo obrigatório de todo caminho de entrada. Evento que não resolva para conexão conhecida **não entra no domínio** — e a resposta dessa recusa obedece ao invariante C, que é o modelo de referência inclusive para os endpoints que hoje não o implementam.

Este ADR fixa a obrigatoriedade, a posição no fluxo, o alcance universal e a propriedade de unicidade da resolução. **Não fixa o mecanismo pelo qual ela ocorre** — isso é contrato de épico.

**D3.b — Seleção de provider.** A obtenção de um adaptador a partir de uma conexão ocorre por um **ponto de despacho único e nomeado**, que é a única autoridade do sistema para essa correspondência. Nenhum módulo instancia adaptador diretamente, e nenhum módulo mantém correspondência própria entre conexão e provider. Adicionar um provider ao sistema significa registrá-lo nesse ponto — e nada mais.

Este ADR fixa a existência do ponto único, sua exclusividade e a propriedade de que a adição de provider seja localizada. **Não fixa o mecanismo de registro, de injeção ou de instanciação** — isso é contrato de épico.

> *Racional:* preserva a fronteira em ambas as direções. D3.a e D3.b existem aqui porque ambos são propriedades da fronteira, não da rota nem do adaptador: dispersá-los reproduziria, em nova forma, exatamente o defeito de §2.1 — a decisão sobre provider tomada em quatro lugares diferentes. Ver §5, alternativas rejeitadas A3, A6, A8 e A9.

### D4 — O envio é um processo com estados explícitos, não uma chamada

O caminho de saída deixa de ser "chamar o provider e, em caso de sucesso, registrar". Passa a ser modelado como progressão declarada: **intenção de mensagem → tentativa de entrega → resultado do provider → estado da mensagem.**

Consequência normativa direta: a mensagem é **persistida antes** da chamada ao provider, e o resultado da chamada **transiciona** seu estado. Uma falha de envio é um estado observável, nunca uma ausência de registro.

> *Racional:* base de dados e provider são sistemas externos entre si, sem transação distribuída. Qualquer modelo que trate o envio como operação atômica perde informação em toda falha parcial.

### D5 — A conversa é escopada por conexão

A chave de identidade de conversa passa a considerar conta, **conexão** e contato.

Um mesmo contato alcançado por duas conexões distintas do mesmo workspace constitui, por padrão, **duas conversas**.

> *Racional:* decorrência necessária de D1. A pergunta de produto sobre se esse padrão deve admitir exceção (unificação de visão para o operador) permanece registrada como **D5 no §15 do roadmap** e **não é decidida aqui** — este ADR fixa a chave estrutural, não a apresentação.

### D6 — Proibição de importação direta de API concreta de provider

Nenhum módulo fora da camada de providers e da camada de entrega pode importar a API concreta de um provider específico.

A proibição é **enforçada em dois níveis**: regra de lint e teste de arquitetura. A duplicidade é intencional — lint é contornável por configuração local; teste falha na CI.

D3.b é o complemento positivo desta proibição: D6 declara o que nenhum módulo pode fazer; D3.b declara o único lugar onde a correspondência entre conexão e provider é legítima.

> *Racional:* a fronteira que não é verificada automaticamente erode. Os quatro call-sites de §2.1 são a demonstração empírica disso dentro deste próprio repositório.

### D7 — Mensagem de entrada nasce `received`

O estado inicial de uma mensagem recebida é `received`, não `delivered`.

`delivered` descreve um evento de ciclo de vida de mensagem **enviada** — a confirmação de que ela alcançou o destinatário. Aplicá-lo a uma mensagem recebida é uma conflação semântica que impede distinguir, em consulta, o que foi recebido do que foi entregue.

O conjunto canônico de estados é ampliado para admitir `received` e `pending` além dos já existentes.

**Escopo da monotonicidade.** Este ADR fixa duas propriedades do ciclo de vida e nada além delas: o **estado inicial** de mensagem de entrada, e a **monotonicidade do eixo de progresso de entrega** — ao longo desse eixo, um estado posterior não regride por evento tardio ou fora de ordem.

A monotonicidade governa a **progressão normal**. **Estados terminais de exceção não pertencem a esse eixo e obedecem a regra própria** — sua admissibilidade, as condições sob as quais interrompem a progressão e o que ocorre com eventos de progresso recebidos após um terminal são matéria do contrato derivado. O ADR registra a existência da distinção entre progressão e exceção, e delega a normatização de ambas.

**A normatização completa das transições admissíveis é delegada a contrato derivado**, e sua ausência aqui é deliberada: uma tabela de transições é artefato de design, revisada e versionada em cadência distinta da deste documento.

**O tratamento do acervo histórico não é decidido por este ADR.** Permanece como **D4 no §15 do roadmap**, a ser resolvido como operação reversível e independente. A ampliação do conjunto de estados é aditiva e não pressupõe essa decisão. As consequências de leitura durante a convivência entre acervo e mensagens novas estão em §7.

---

## 4. Invariantes

Distinção normativa: as decisões de §3 descrevem o estado a alcançar. Os invariantes abaixo descrevem propriedades **já vigentes, corretas e testadas** do sistema.

**Nenhum épico derivado deste ADR pode removê-los, reimplementá-los ou contorná-los.** Um implementador que os leia como trabalho a fazer reescreverá caminho saudável e reintroduzirá defeito já resolvido. Esta seção existe precisamente para impedir isso — a v1.0 do roadmap listava o invariante A como decisão nova, e essa foi a correção mais importante trazida pela revisão adversarial.

### Invariante A — Deduplicação de persistência é distinta de deduplicação de efeitos

A inserção idempotente de mensagem de entrada sinaliza ao chamador se a linha foi de fato criada ou se já existia. O processador de entrada **aborta todos os efeitos colaterais** — atualização de conversa, contagem de não-lidas, disparo de flows e automations — quando a linha já existia.

*Evidência:* migration 035 (`insert_inbound_message` … `RETURNING id`), `src/lib/whatsapp/inbound-processor.ts:324`.

*Regra:* todo caminho de entrada novo, para qualquer provider, replica esse gate. Persistência idempotente sem gate de efeitos **não satisfaz** este invariante: a reentrega continuaria duplicando disparos de automação.

### Invariante B — Idempotência de entrada por índice único parcial

A unicidade de mensagem de entrada é garantida no banco, por índice parcial restrito a mensagens originadas do contato.

*Evidência:* migration 034 — `idx_messages_conv_msgid_customer` sobre `(conversation_id, message_id)`, parcial em `sender_type = 'customer' AND message_id IS NOT NULL AND message_id <> ''`.

*Regra:* pode ser **ampliada** para incorporar a conexão quando D1 for implementada. Nunca removida, nunca relaxada, nunca substituída por verificação em camada de aplicação. É este invariante que garante a unicidade durante o regime transitório de ancoragem declarado em D2.

### Invariante C — Contrato de autenticação do webhook não-Meta

O endpoint público de webhook não-Meta resolve a conexão em tempo constante por identificador indexado, compara segredos por hash em tempo constante, responde com resposta idêntica a toda falha de autenticação — sem oráculo de enumeração — e consome cota de rate-limit inclusive nas falhas.

*Evidência:* migration 036; `src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts`.

*Regra:* é o **modelo de referência** para qualquer endpoint público, existente ou novo. Nenhum endpoint derivado deste ADR pode oferecer garantia inferior. É também a instância vigente de D3.a: a resolução de conexão que ele já realiza é a que D3.a generaliza, torna obrigatória para todo caminho de entrada e estende aos caminhos que hoje não a implementam.

### Invariante D — Direção é derivada, não armazenada

A direção da mensagem é determinada pelo tipo de remetente, já restrito a um conjunto fechado de valores.

*Evidência:* migration 001 — `messages.sender_type` com `CHECK (sender_type IN ('customer','agent','bot'))`.

*Regra:* **não criar coluna de direção.** A crítica adversarial que pressupunha essa necessidade partia de leitura imprecisa do schema; a informação já existe, normalizada.

---

## 5. Alternativas rejeitadas

**A1 — Corrigir os sintomas sem modelo (manter `conta → configuração → provider`).**
Rejeitada. É a alternativa de menor custo imediato e maior custo total. Cada correção de status, dedup, broadcast e identidade assume o modelo de conexão única; todas seriam refeitas na segunda conexão. Foi a recomendação explícita contra a qual as quatro auditorias convergiram.

**A2 — Identidade externa como par único `(conexão, identificador)`.**
Rejeitada. Formulação da v1.0 deste roadmap, revista após arbitragem no código. Um par único obriga o adaptador a eleger um identificador quando o provider oferece dois igualmente legítimos — que é exatamente a origem de R16. Corrigir a eleição troca qual informação se perde, sem resolver a causa.

**A3 — `CorrelationDescriptor` no evento de provider.**
Rejeitada, com reconhecimento de que o instinto que a motivou está correto: correlação é conhecimento do provider e não deve contaminar o domínio. O mecanismo, porém, produz o efeito oposto — o domínio passa a **interpretar** uma estrutura de correlação, e cada provider novo pode introduzir formato que o domínio precise compreender. Isso inverte o acoplamento em vez de removê-lo. D2 combinada com D3 obtém o mesmo objetivo com o domínio executando apenas resolução por valor.

**A4 — Três colunas de identificador (`provider_message_id`, `provider_status_id`, identidade interna).**
Rejeitada. Resolve o caso Z-API e quebra no primeiro provider que introduzir um quarto identificador, exigindo alteração de schema a cada integração nova. É A2 com aritmética diferente.

**A5 — Criar coluna de direção em `messages`.**
Rejeitada por redundância. Ver invariante D.

**A6 — Enriquecer o contrato com operações separadas por tipo de evento (`parseStatus`, `parseReaction`, …).**
Rejeitada. Cada tipo de evento novo exigiria alteração da interface e de todos os adaptadores existentes, inclusive os que não o suportam. O contrato extensível de D3 admite variante nova sem tocar implementações alheias, e suas cláusulas de consumo seguro e não-destrutivo garantem que adaptador atualizado à frente do domínio não quebre o processamento nem perca evento.

**A7 — Tratar mensagem de entrada como `delivered`.**
Rejeitada por conflação semântica. Ver D7.

**A8 — Contrato de eventos estritamente fechado.**
Rejeitada. Um contrato fechado obrigaria a atualização simultânea de todos os consumidores a cada tipo de evento novo, e tornaria a introdução de qualquer variante uma mudança acoplada — reintroduzindo, na dimensão temporal, o problema que A6 apresenta na dimensão estrutural. A extensibilidade de D3 é a alternativa adotada; seu custo são as obrigações de consumo seguro e não-destrutivo, declaradas normativas precisamente porque são o que torna a extensibilidade segura.

**A9 — Resolução de conexão e seleção de provider resolvidas caso a caso, em cada rota.**
Rejeitada. É o estado atual generalizado. Enquanto há uma conexão por conta, a dispersão é invisível; com N conexões, cada rota passa a conter sua própria versão da mesma decisão — que é a forma exata do defeito de §2.1. D3.a e D3.b existem para impedir a recorrência.

**A10 — Isentar o caminho Meta da resolução de conexão.**
Rejeitada. Produziria um sistema com multi-conexão para os providers não-oficiais e conexão única para o oficial — que é o provider primário do produto. A universalidade de D3.a não admite exceção por provider; o que admite gradação é o **momento** em que a resolução deixa de ser trivial, e esse momento é o mesmo para todos: a Etapa 5. Ver §7.

---

## 6. Migração

Estratégia em prosa. Sequenciamento, pré-condições e critérios de reversibilidade — **sem artefatos de implementação**, que pertencem aos contratos dos épicos derivados.

### 6.1 Princípio de sequenciamento

A migração obedece a uma regra única: **correção de comportamento precede correção de estrutura, e ambas precedem migração de dados.**

Corrigir estrutura sobre comportamento incorreto propaga o defeito para o modelo novo. Migrar dados sobre estrutura instável torna o rollback impraticável.

### 6.2 Ordem normativa

**Etapa 1 — Fronteira (D3, D3.b, D6).** Unificação do caminho de envio sob a camada de entrega, estabelecimento do ponto único de seleção de provider, e migração dos quatro call-sites diretos. Sem alteração de schema e sem produção de dado novo. **Integralmente reversível por reversão de commit.**

**Etapa 2 — Identidade (D2, D7 parcial).** Introdução da estrutura de identidades como conjunto, ampliação do conjunto canônico de estados, e correção da inconsistência do adaptador Z-API descrita em §2.3. Estruturalmente aditiva.

Esta etapa opera sob o **regime transitório de ancoragem** declarado em D2: as identidades existem com a ancoragem em conexão pendente, e a unicidade é garantida pelo invariante B até que a Etapa 5 promova a ancoragem a obrigatória.

**Reversibilidade assimétrica — atenção normativa.** A reversão do código desta etapa é possível; a reversão dos **dados que ela produz, não**. A partir do primeiro evento processado sob a correção do adaptador Z-API, existirão mensagens cuja identidade primária foi gravada sob a semântica nova, convivendo com mensagens gravadas sob a semântica anterior. Reverter o código não reescreve o já persistido: produz um acervo com duas semânticas e nenhum código que reconheça a mais recente.

Consequência: **a reversão desta etapa, após qualquer tráfego real, exige decisão explícita sobre o acervo produzido no intervalo** — não é operação de rollback simples. O plano de reversão desta etapa é elaborado antes de sua ativação, e não depois. Ver §6.4.

**Esta etapa é bloqueante e não admite inversão.** Habilitar o ciclo de status antes dela produz falha de correlação silenciosa em todas as mensagens Z-API. É a única precedência deste ADR cuja violação causa dano sem sinal.

**Etapa 3 — Ciclo de vida (D7).** Despacho de eventos de status, com monotonicidade sobre o eixo de progresso e regra própria para estados terminais de exceção, ambas normatizadas pelo contrato derivado previsto em D7. Nenhuma alteração estrutural adicional. Reversível por reversão de commit quanto ao código; os estados transicionados no intervalo permanecem, e a consideração de §6.4 se aplica.

**Etapa 4 — Entrega (D4).** Persistência anterior à chamada de provider, transição de estado por resultado, e proteção contra duplicação em reenvio. Mesma condição de reversibilidade da Etapa 3.

**Etapa 5 — Conexões (D1, D3.a plena, D5).** Introdução da entidade de conexão, ancoragem das mensagens e conversas a ela, promoção da ancoragem das identidades da Etapa 2 a obrigatória, e generalização da resolução de conexão para o caso multi-conexão **em todos os caminhos de entrada, inclusive o oficial**.

Esta é a única etapa que migra dados em volume e a única cujo rollback exige plano prévio escrito. Sua execução é faseada internamente: criação da estrutura, transporte de dados a partir do legado, adição de referências em estado opcional, transporte, e só então promoção a obrigatórias com as restrições de unicidade definitivas. **Nenhuma dessas fases pode ser colapsada em passo único.**

### 6.3 Pré-condições de execução

Nenhuma etapa inicia sem que a anterior tenha suíte verde e revisão por agente distinto do implementador. A Etapa 5 exige, adicionalmente, ensaio prévio sobre cópia de produção e plano de reversão escrito **antes** do início. A Etapa 2 exige plano de tratamento do acervo produzido no intervalo, pela razão declarada em §6.2.

### 6.4 Reversibilidade

A distinção que governa esta seção: **reversão de código e reversão de dados são operações distintas, e a possibilidade da primeira não implica a da segunda.**

- **Etapa 1** — reversível em ambos os sentidos. Não produz dado novo.
- **Etapas 2, 3 e 4** — código reversível; **dados produzidos no intervalo, não.** Cada uma altera a semântica do que é persistido. Sua reversão, após tráfego real, é decisão sobre acervo, não reversão de commit.
- **Etapa 5** — irreversível. O que impõe a exigência de ensaio prévio, e é o motivo de ela ser deliberadamente a última.

O tratamento do acervo histórico de estados de mensagem de entrada (D7) é operação **separada, posterior e independentemente reversível**, condicionada à decisão D4 do roadmap. Não integra nenhuma das cinco etapas.

---

## 7. Compatibilidade

**Provider Meta — Etapas 1 a 4.** Nenhuma mudança de comportamento observável. É o caminho em produção e o critério de regressão dessas etapas. Sua suíte deve estar verde antes de qualquer alteração e permanecer verde depois.

**Provider Meta — Etapa 5.** A isenção acima **não se estende a esta etapa**. Na Etapa 5, o caminho Meta está sujeito a D3.a como qualquer outro endpoint público: a atribuição de evento a conexão passa a ser requerida também nele, porque a multiplicidade de conexões torna a atribuição não-trivial em todos os caminhos simultaneamente (§2.4).

O critério de regressão é preservado no que é externamente verificável e explicitamente suspenso no que é interno: **mantém-se a ausência de mudança externamente observável; não se mantém a ausência de mudança interna.** A alternativa — isentar o provider oficial — foi considerada e rejeitada (A10): produziria multi-conexão parcial, disponível apenas para os providers não-oficiais.

**Provider uazapi.** Suas identidades são consistentes entre envio e entrada. A declaração de identidades de D3 é, para ele, estritamente aditiva.

**Provider Z-API.** Único provider com mudança de comportamento nas Etapas 1 a 4: passa a persistir como identidade primária o identificador do nível WhatsApp — que é o referenciado pelos callbacks — e a declarar ambas as identidades conhecidas. **É correção de defeito, não quebra de contrato.** As mensagens gravadas antes da correção mantêm a identidade anterior; ver §6.2, Etapa 2.

**Convivência de estados durante e após a Etapa 2.** Enquanto a decisão D4 do roadmap não for resolvida, o acervo conterá **duas populações de mensagens de entrada**: as anteriores, gravadas como `delivered`, e as posteriores, gravadas como `received`. As duas descrevem o mesmo fato do mundo.

Consequências normativas dessa convivência, vigentes até que D4 seja resolvida:

- **Nenhuma leitura pode assumir que `received` identifica exaustivamente as mensagens de entrada.** Consulta que precise de completude sobre entrada qualifica-se pela direção — que é derivada do tipo de remetente (invariante D) e é confiável em ambas as populações — e não pelo estado.
- **Nenhuma leitura pode assumir que `delivered` identifica exclusivamente mensagens enviadas** enquanto o acervo anterior não for tratado.
- **Toda superfície que apresente estado ao operador deve produzir leitura equivalente para as duas populações.** A distinção é artefato de transição e não deve ser visível como inconsistência de produto.
- A ambiguidade é **temporária por construção e eliminável por decisão única** (D4). Enquanto persistir, é responsabilidade dos contratos derivados declarar como cada consulta se qualifica.

**Identidade primária de exibição.** O campo textual existente em `messages` mantém posição, semântica e papel no índice de idempotência. Consumidores atuais não são afetados.

**Configuração de WhatsApp legada.** Preservada com leitura por camada de compatibilidade durante e após a Etapa 5. Não recebe funcionalidade nova. Sua remoção é decisão futura, fora do escopo deste ADR.

**Isolamento de tenant.** Nenhuma decisão deste ADR altera política de RLS existente. A ancoragem de mensagens à conta na Etapa 5 **fortalece** o isolamento — substitui verificação por junção por verificação direta — e nenhuma etapa pode enfraquecê-lo.

**Fronteira de platform.** Intocada. `can_access_account` e o contexto auditado não são objeto deste ADR.

**Público externo.** A API pública possui um único endpoint, que não expõe mensagens. Nenhuma etapa produz quebra de contrato externo.

---

## 8. Consequências

### 8.1 Consequências aceitas

**O caminho de envio ganha uma indireção.** Toda operação de saída passa pela camada de entrega e pelo ponto único de seleção de provider. Custo de legibilidade aceito em troca da fronteira verificável de D6.

**A identidade de mensagem exige resolução, não leitura direta.** Consultas que hoje leem um campo passam, nos caminhos de correlação, a resolver contra um conjunto. Custo de acesso aceito; a alternativa é perda de capacidade de correlação.

**Todo consumidor de eventos carrega duas obrigações permanentes:** prosseguir diante de variante desconhecida e não descartá-la. É o preço da extensibilidade de D3, e é permanente, não transitório.

**O caminho Meta perde a isenção de mudança na Etapa 5.** Consequência de A10 e da universalidade de D3.a. Aceita porque a alternativa é multi-conexão parcial.

**Capacidade ausente passa a falhar explicitamente.** Um provider sem suporte a determinada operação produz erro tipado, não ausência silenciosa. **Isso torna visíveis falhas que hoje são invisíveis** — o volume aparente de erro aumentará no curto prazo. É o resultado pretendido, não regressão. Note-se que isto não conflita com o consumo seguro de D3: capacidade ausente no **envio** falha ruidosamente; variante desconhecida na **entrada** é retida sem interromper o lote. São objetos distintos.

**Um contato pode ter mais de uma conversa.** Decorrência de D5. Tem impacto de apresentação, cuja resolução é decisão de produto (D5 do roadmap), não deste ADR.

**A partir da Etapa 2, o acervo passa a conter duas semânticas até que D4 seja resolvida.** Consequência declarada em §7 e aceita como transitória.

**A ancoragem de identidade permanece pendente entre as Etapas 2 e 5.** Consequência declarada em D2 e limitada pelo invariante B.

**A Etapa 5 é irreversível e onerosa.** Aceita porque é a única que resolve §2.4, e adiada ao máximo para que ocorra sobre código já estabilizado.

### 8.2 Consequências desejadas

Paridade funcional entre providers deixa de ser aspiração e passa a ser propriedade verificada por matriz de teste. O ciclo de vida da mensagem fecha em qualquer provider. Falha de envio torna-se observável ao operador. Um workspace passa a poder operar múltiplos números — **em qualquer provider, inclusive o oficial** — e a migrar de provider sem indisponibilidade. Adicionar um provider passa a ser operação localizada em um ponto único. Nenhum evento se perde por desatualização do domínio em relação ao adaptador. A fronteira de provider passa a ser mantida por verificação automática, não por disciplina.

### 8.3 Consequências negativas assumidas

O tempo até a primeira correção visível aumenta — este ADR é trabalho que não entrega funcionalidade. É o custo deliberado de não pagar o retrabalho descrito em A1.

A coexistência entre a configuração legada e a entidade de conexão introduz período de duplicidade conceitual entre as Etapas 1 e 5. Assumido e limitado pela sequência.

A convivência de duas semânticas de estado entre a Etapa 2 e a resolução de D4 introduz obrigação de qualificação em consultas sobre entrada. Assumida, declarada em §7, e eliminável por decisão única.

A obrigação de retenção não-destrutiva de variante desconhecida tem custo permanente. Assumida como preço da extensibilidade segura.

---

## 9. Riscos

Riscos **desta decisão** e da sua execução. A matriz completa do produto permanece em §10 do roadmap.

| Risco | Origem | Severidade | Mitigação |
|---|---|---|---|
| **Habilitar o ciclo de status antes da correção de identidade** — falha de correlação em 100% das mensagens Z-API, sem sinal | R16 / §2.3 | **Crítica** | Precedência normativa da Etapa 2 sobre a Etapa 3 (§6.2). Teste de regressão que **deve falhar** contra o código atual |
| **Regressão no caminho Meta** — é o que está em produção | Etapas 1 e 4 | **Alta** | Suíte Meta verde antes de tocar; assinatura preservada atrás da camada de entrega; verificação manual antes de publicar |
| **Etapa 5 executada com o caminho Meta isento** — multi-conexão parcial, indisponível no provider primário | §7 / A10 | **Alta** | Isenção delimitada às Etapas 1–4 em §7; alternativa registrada e rejeitada em A10 |
| **Perda ou corrupção de dados na Etapa 5** | Migração estrutural | **Alta** | Faseamento obrigatório sem colapso de passos; ensaio em cópia de produção; plano de reversão escrito previamente; conferência de contagem antes e depois |
| **Reversão da Etapa 2 tratada como rollback simples** — acervo com duas semânticas e código que só reconhece uma | §6.2 / §6.4 | **Alta** | Assimetria declarada normativamente; plano de tratamento de acervo elaborado **antes** da ativação |
| **Consumo seguro implementado como descarte** — perda silenciosa de evento por desatualização do domínio | D3 | **Alta** | Cláusula de não-destrutividade normativa em D3 |
| **Leitura que assume `received` como exaustivo de entrada** durante a convivência | §7 | **Média** | Regra de qualificação por direção declarada em §7 |
| **Remoção acidental do gate de efeitos colaterais** | Invariante A | **Média** | Registro normativo em §4; teste de reentrega que verifica linha única **e** disparo único |
| **Dispersão da seleção de provider ou da resolução de conexão** — recorrência de §2.1 em nova forma | D3.a / D3.b | **Média** | Ponto único normativo; D6 verificado por lint e teste de arquitetura |
| **Identidade tratada como metadado opcional** por contrato derivado | D2 | **Média** | Semântica de correlação declarada normativamente em D2 |
| **ADR aprovado e não seguido** — correções pontuais retomam fora da sequência | Processo | **Média** | Todo contrato de épico cita a decisão que o autoriza |
| **Interpretação de invariante como trabalho novo** | Leitura | **Média** | §4 é normativa e citada por todo contrato derivado |

---

## 10. Estado final esperado

Quando as cinco etapas estiverem concluídas, as afirmações abaixo serão verdadeiras e verificáveis:

**Fronteira.** Nenhum módulo fora das camadas de provider e de entrega referencia a API concreta de um provider específico, e essa propriedade é verificada automaticamente na integração contínua.

**Despacho.** A correspondência entre conexão e provider existe em exatamente um ponto do sistema. Adicionar um provider é operação localizada nesse ponto.

**Atribuição.** Todo evento recebido por endpoint público — oficial ou não-oficial, sem exceção — é atribuído a exatamente uma conexão antes de entrar no domínio, ou é recusado sob as garantias do invariante C.

**Paridade.** Toda operação de saída — texto, mídia, template, reação — funciona em todo provider que a suporte, e produz erro tipado e legível em todo provider que não a suporte. Nenhuma operação falha em silêncio.

**Identidade.** Uma mensagem possui todas as identidades externas que seu provider conhece, cada uma ancorada em sua conexão de origem. Qualquer valor recebido de qualquer provider resolve para a mensagem correta por operação única e agnóstica.

**Ciclo de vida.** Toda mensagem, em qualquer provider, transita por estados reais, segundo transições normatizadas pelo contrato derivado previsto em D7. A progressão de entrega é monotônica; estados terminais de exceção obedecem a regra própria. Mensagem recebida nasce `received`.

**Entrega.** Mensagem é persistida antes da chamada ao provider. Falha de envio é estado observável no inbox. Reenvio não duplica.

**Conexão.** Um workspace opera N conexões, em qualquer provider. Cada mensagem e cada conversa estão ancoradas em uma conexão e na conta. O isolamento de tenant é verificado diretamente, sem junção.

**Idempotência.** Reentrega de mensagem de entrada não cria linha duplicada **e não dispara efeito colateral duplicado** — em qualquer provider, por qualquer caminho.

**Extensibilidade.** Um tipo de evento novo é introduzido sem alteração da interface; nenhum consumidor desatualizado é derrubado por variante que não reconhece, e nenhuma variante não reconhecida é perdida.

**Legado.** A configuração singular de WhatsApp permanece legível por compatibilidade e não recebe funcionalidade nova.

**Rastreabilidade.** Todo épico derivado cita a decisão deste ADR que o autoriza. O que não estiver ancorado aqui não entra no escopo.

---

## 11. Registro de aprovação

| Item | Estado |
|---|---|
| Decisões D1–D7 formalizadas (D3 com elementos D3.a e D3.b) | ✅ |
| Estrutura de dependência declarada (D1 como premissa) | ✅ |
| Invariantes A–D registrados como vigentes | ✅ |
| Alternativas rejeitadas com racional (A1–A10) | ✅ |
| Estratégia de migração sequenciada, com reversibilidade declarada por etapa | ✅ |
| Compatibilidade declarada por provider, por etapa e por convivência de estados | ✅ |
| Riscos de execução mapeados | ✅ |
| **Ratificação de D1 por Weyner** (D1, §15 do roadmap) | ⬜ **pendente** |
| **Achado N-3 — deduplicação de efeitos no caminho de saída** | ⬜ **aberto, ver §12** |
| **Promoção a `Aceito`** | ⬜ **bloqueada pelos itens acima** |

**Contratos derivados previstos por este ADR:**

| Contrato | Deriva de | Estado |
|---|---|---|
| `EIS-001 — External Identity Storage Specification` | D2, D3 | **Aprovado** — `docs/architecture/EIS-001-external-identity-storage.md` |
| Normatização das transições da máquina de estados e da regra de estados terminais | D7 | Não escrito |
| Mecanismo de resolução de conexão | D3.a | Não escrito |
| Mecanismo de registro e seleção de provider | D3.b | Não escrito |
| Retenção de variante de evento não reconhecida | D3 | Não escrito |

Este ADR **não decide**: o destino do ADR-ATTR-001 (D3 do roadmap), o tratamento do acervo histórico de estados (D4), a apresentação de conversas multi-conexão (D5), a paridade de templates em providers não-oficiais (D6), a convergência entre os dois motores de automação (ADR-AUT-001) ou o processo de migração em produção (D7).

---

## 12. Registro de revisão — v3 → v4

### Alterações aplicadas

| # | Correção | Onde |
|---|---|---|
| **1** | Inconsistência D2 × sequência de migração — regime transitório de ancoragem declarado, com invariante B garantindo unicidade no intervalo | **D2** (bloco "Estado transitório"); invariante B; §6.2 Etapas 2 e 5; §8.1 |
| **2** | Monotonicidade delimitada ao eixo de progresso; estados terminais de exceção com regra própria, delegada | **D7** (bloco "Escopo da monotonicidade"); §6.2 Etapa 3; §10 |
| **3** | D1 declarada premissa das decisões dependentes, com o subconjunto independente identificado | **§3**, bloco introdutório |
| **4** | Compatibilidade Meta resolvida — isenção delimitada às Etapas 1–4; D3.a aplica-se ao caminho oficial na Etapa 5 | **§7** (Meta desdobrado em dois blocos); D3.a (alcance universal); §2.4; **A10** nova; §6.2 Etapa 5; §8.1, §8.2; risco novo em §9; §10 |
| **5** | Semântica do conjunto de identidades — o que a declaração garante e o que não garante; conjunto como mecanismo de correlação, não metadado | **D2** (bloco "Semântica da identidade declarada"); risco novo em §9 |
| **6** | Ambiguidade fechado × extensível eliminada — modelo único, declarado explicitamente como não-fechado | **D3** (primeira cláusula); **A6** e **A8** realinhadas |
| **7** | "Ignorar" definido — não processar, sem perder | **D3** (bloco "consumo seguro é não-destrutivo"); §8.1, §8.3; risco novo em §9; §10 |

### Achado aberto, não aplicado

**N-3 — deduplicação de efeitos no caminho de saída.** O invariante A estabelece que persistência idempotente e deduplicação de efeitos são problemas distintos, e o faz apenas para o caminho de entrada. D4 cria um caminho de saída com estado intermediário retomável e efeitos colaterais reais (pausa de flow, contadores de broadcast, marcação de resposta). §10 garante que *"reenvio não duplica"* sem dizer se a garantia alcança a mensagem apenas ou também os efeitos.

Classificado como **omissão arquitetural** na segunda revisão. Não aplicado por estar fora da lista de correções autorizadas na consolidação da v4. A correção seria uma frase no invariante A estendendo o princípio ao caminho de saída, sem prescrever mecanismo.

### Pendências de forma, registradas e não executadas

Três achados de classificação *design derivado* / *governança* permanecem no documento por não constarem da lista autorizada: as pré-condições de execução de **§6.3**, as mitigações operacionais em **§9**, e o checklist de **§11**. As duas revisões arquiteturais recomendaram removê-los do ADR por serem estratégia operacional. A pendência fica registrada; a remoção é subtração, e subtrair fora de escopo autorizado é tão indevido quanto acrescentar.
