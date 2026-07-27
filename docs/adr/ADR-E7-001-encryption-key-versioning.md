# ADR-E7-001 — Encryption Key Versioning & Rotation

| | |
|---|---|
| **Tipo** | Architecture Decision Record — governança de ciclo de vida de chaves; decide rotação, não formato |
| **Épico** | E7 — Encryption Key Versioning (`MASTER-ROADMAP.md` §7) |
| **Deriva de / reusa** | `ADR-CRYPTO-001` v2.0 (APPROVED FOR IMPLEMENTATION) — Key Ring (§5), KID (§4), capacidades (§5.1), invariantes I1–I14 (§10), princípios P1–P4 (§2) · `IMP-CRYPTO-001` RC1.3 §4.3 (compatibilidade futura já projetada) |
| **Status** | Proposto · pronto para novo Gate Arquitetural |
| **Versão** | RC1.1 — revisão cirúrgica pós-Gate Arquitetural #1 (NO-GO) |
| **Autoridade** | Decide **apenas** rotação, versionamento, estados de transição de chave, política de seleção/leitura durante coexistência de versões, rollback de designação de escrita e estratégia de migração de ciphertext. **Não decide, não altera e não reabre**: Envelope Format, Recognition Tree, AAD, KID como conceito, API pública `encrypt`/`decrypt`, Binding Context, ou qualquer invariante I1–I14. |
| **Baseline de código** | HEAD `e9a5527` — ADR-CRYPTO-001 e IMP-CRYPTO-001 RC1.3 implementados e encerrados (Phases 1–3.2, Implementation Completion Review fechada) |

---

## 0. Changelog

### 0.1 RC1.0 → RC1.1 (Gate Arquitetural #1 → revisão cirúrgica)

Gate Arquitetural #1 retornou **NO-GO**, com 1 achado CRITICAL e 4 achados HIGH. Esta revisão resolve exclusivamente esses 5 achados. Nenhuma decisão aprovada é reaberta; nenhuma seção não relacionada é alterada; `ADR-CRYPTO-001` e `IMP-CRYPTO-001` permanecem intocados.

| Achado | Severidade | Resolução em RC1.1 |
|---|---|---|
| C1 — Contradição sobre capacidade de leitura de `Retired` | CRITICAL | Resolvida por definição única: `Retired` é tecnicamente idêntico a `DecryptOnly` (Read ✔ / Write ✖) — `resolveKey()` sempre o resolve, sem exceção. A diferença entre os dois é exclusivamente administrativa/de auditoria, nunca de capacidade. §8 reescrito (§8.0, §8.1). |
| H1 — Grafo de transições não fechado | HIGH | §8.3 (nova) enumera toda transição válida com pré-condição, pós-condição e invariante mantida, e declara proibido todo par não listado. Inclui `Retired → Active` (T5), ausente na RC1.0, que fecha a lacuna do cenário de rollback tardio (§12). |
| H2 — Escopo de convergência indefinido | HIGH | §13.1 (nova): convergência total (I7) só é válida relativa a um Inventário de Superfícies de Ciphertext declarado e versionado, com composição mínima obrigatória enumerada (tabelas primárias, filas/retries, DLQ, jobs assíncronos, snapshots/backups, e superfícies futuras). |
| H3 — `Destroyed` dependia apenas de disciplina operacional | HIGH | §13.3 (nova): a transição `Retired → Destroyed` passa a exigir, como pré-condição estrutural, uma Convergence Attestation — artefato durável e consultável que distingue "destruído com prova" de "ausente por omissão". Mecanismo concreto é decisão de IMP futuro; o requisito de existência é decidido aqui. |
| H4 — Liberdade de algoritmo entre KIDs incompatível com `IMP-CRYPTO-001 §6.1` | HIGH | §15 e §16 corrigidos: liberdade de algoritmo restringida explicitamente à família AEAD compatível com o pseudocódigo normativo §6.1. Algoritmos fora dessa família são declarados fora do escopo deste ADR. |

Achados MEDIUM e LOW do Gate #1 (M1–M3, L1–L2) não são endereçados nesta revisão — fora do escopo desta rodada cirúrgica, por instrução explícita do requerente.

---

## 1. Contexto

`ADR-CRYPTO-001` define o contrato criptográfico permanente da plataforma: envelope autodescritivo, KID como identidade direta e imutável do material criptográfico, Key Ring como autoridade de resolução, e um regime de capacidades (`Active`, `DecryptOnly`, `Retired`, `Destroyed`) cujas **transições** são explicitamente delegadas a este documento (`ADR-CRYPTO-001 §5.1`: *"Este ADR define apenas as capacidades. As transições entre estados pertencem ao ADR-E7-001"*; `I7`: *"A verificação desse pré-requisito pertence ao ADR-E7-001"*).

A implementação atual (`IMP-CRYPTO-001` RC1.3, Phases 1–3.2, encerrada) materializa esse contrato com um Key Ring de três KIDs — `LEGACY_GCM`, `LEGACY_CBC` (ambos `DecryptOnly`) e `ACTIVE_V1` (`Active`) — todos derivados, direta ou via HKDF, de uma única `ENCRYPTION_KEY` de ambiente. Não existe hoje nenhum mecanismo para introduzir uma segunda chave `Active` independente, nem para transicionar um KID entre capacidades. `IMP-CRYPTO-001 §4.3` já reconheceu essa lacuna e projetou a interface para absorvê-la sem impacto: *"quando rotação de chave introduzir uma chave dedicada e provisionada independentemente para um futuro KID ativo, o passo de derivação é simplesmente substituído por material de chave direto na configuração do KeyRing — `resolveKey()`/`getWriteKey()` e todo código de call site são inafetados."*

Dois fatores tornam este o momento correto para decidir rotação:

- **Risco registrado e não exercitado.** `MASTER-ROADMAP.md §10, R4`: *"Rotação de `ENCRYPTION_KEY` derruba conexões"* — risco 🟠, aberto desde antes da existência do Key Ring, nunca testado em produção.
- **Novo segredo de maior raio de dano na fila.** `ADR-ATTR-002` (fronteira de credenciais de ad account, Proposto · pronto para Gate) decidiu deliberadamente herdar o débito de rotação em vez de resolvê-lo (`ADR-ATTR-002 §6`: *"ATTR-002 não depende de E7... Ship no modelo de chave global atual, E7-aware"*), registrando o débito como compartilhado, não como novo. Cada novo segredo que entra sob o regime de chave única sem rotação aumenta o custo da primeira rotação real.

## 2. Problema

**Como uma chave `Active` pode ser substituída por outra, com coexistência segura de múltiplas versões de material criptográfico, sem alterar o formato do envelope, sem que nenhum call site tome conhecimento do evento, e com garantia permanente de que todo ciphertext já emitido continue decifrável — dentro do modelo de KID já definido e congelado por `ADR-CRYPTO-001`?**

O problema tem três dimensões que o contrato atual delega mas não resolve:

- **P-1 — Seleção de escrita.** `ADR-CRYPTO-001 I4` exige exatamente uma chave `Active` por Key Ring a qualquer instante. Uma rotação é, por definição, uma transição entre dois estados que ambos satisfazem I4 — o "durante" dessa transição precisa de uma política explícita para nunca violar I4 nem criar ambiguidade sobre qual KID um `encrypt()` concorrente deve usar.
- **P-2 — Leitura durante coexistência.** Um envelope traz seu KID embutido (`ADR-CRYPTO-001 P1`); a leitura já é, por construção, independente de qual chave é `Active` no momento da leitura. O problema real não é técnico — é de **disciplina de rollout**: um KID precisa existir no Key Ring de toda instância em execução **antes** que qualquer instância possa emiti-lo, sob pena de `UNKNOWN_KID` (I12) em uma instância ainda não atualizada.
- **P-3 — Fim de vida de uma chave.** `ADR-CRYPTO-001 I7` proíbe a transição para `Destroyed` sem prova de que nenhum envelope persistido ainda depende da chave. Não existe hoje nenhum processo — nem mesmo um critério — para produzir essa prova.

## 3. Objetivos

1. Permitir a introdução de uma nova chave de escrita (`Active`) sem alterar nenhum call site de aplicação.
2. Permitir coexistência de múltiplas chaves de leitura (`Active` + N `DecryptOnly`) simultaneamente, resolvidas exclusivamente por KID.
3. Definir as transições de capacidade (`Active → DecryptOnly → Retired → Destroyed`) e suas precondições.
4. Definir uma política determinística de seleção de chave de escrita, sem ambiguidade e sem negociação em runtime.
5. Definir um processo de rotação operacionalmente seguro, com disciplina de rollout compatível com deploys incrementais (rolling deploy).
6. Definir um processo de rollback que nunca comprometa a legibilidade de dados já emitidos.
7. Definir uma estratégia de migração de ciphertext (convergência de KID antigo para novo) compatível com o padrão de "self-heal" já em produção.
8. Preservar integralmente `ADR-CRYPTO-001` — formato de envelope, Recognition Tree, AAD, Binding Context, API pública, invariantes I1–I14 — sem exceção.

## 4. Não objetivos

- **Não define nem altera** o Envelope Format, a serialização canônica (`ADR-CRYPTO-001 §3.1`), o AAD (`§3.1.3`/`§3.2`) ou a Recognition Tree (`§8.3`).
- **Não altera** a API pública `encrypt(data, bindingContext)` / `decrypt(token, bindingContext)`, nem a dupla de pares permanentes definida em `IMP-CRYPTO-001 §3.3`/`§4.1`.
- **Não decide** KMS, HSM ou BYOK — permanece evolução futura reconhecida por `ADR-CRYPTO-001 §12`, fora do escopo deste documento.
- **Não decide** política de rotação automática por tempo (TTL de chave) — ver §19-C (correção incidental de referência cruzada; RC1.0 apontava erroneamente para §17).
- **Não produz** plano de implementação (IMP), migration de banco de dados, nem código. Este documento é exclusivamente arquitetura, pronto para Gate.
- **Não reabre** nenhuma decisão de `ADR-CRYPTO-001` ou `IMP-CRYPTO-001` — todas as seções abaixo operam estritamente dentro dos limites já congelados.
- **Não decide** a mecânica de provisionamento de material de uma chave futura (derivação HKDF, geração aleatória, ou obtenção de um KMS/HSM externo) — isso é decisão de implementação (IMP-E7-001 futuro), não de arquitetura de rotação.

## 5. Requisitos funcionais

| # | Requisito |
|---|---|
| RF-1 | O Key Ring deve suportar a adição de um novo KID com capacidade `DecryptOnly` sem afetar a chave `Active` corrente. |
| RF-2 | O Key Ring deve suportar a promoção atômica de um KID `DecryptOnly` para `Active`, simultânea à rebaixa do `Active` corrente para `DecryptOnly`, preservando I4 em todo instante observável. |
| RF-3 | `resolveKey(kid)` deve continuar resolvendo qualquer KID presente no Key Ring, independentemente de sua capacidade, exceto `Destroyed`. |
| RF-4 | `getWriteKey()` deve continuar retornando exatamente uma chave, sempre a `Active` corrente, sem parâmetro de seleção. |
| RF-5 | Nenhuma função pública ou de call site deve receber, aceitar ou expor um parâmetro de versão, rotação ou geração de chave. |
| RF-6 | Deve existir uma transição documentada `DecryptOnly → Retired`, marcando uma chave como não mais necessária para leitura de dados correntes, mas ainda presente no Key Ring para leitura de dados residuais. |
| RF-7 | Deve existir uma transição documentada `Retired → Destroyed`, condicionada à prova de convergência (I7). |
| RF-8 | O rollback da designação de escrita (qual KID é `Active`) deve ser possível a qualquer momento sem afetar a legibilidade de nenhum envelope já persistido. |
| RF-9 | Deve existir uma estratégia de migração de ciphertext de um KID para outro que não exija indisponibilidade nem processamento síncrono bloqueante. |

## 6. Requisitos não funcionais

| # | Requisito |
|---|---|
| RNF-1 | **Zero mudança de call site.** Nenhum domínio consumidor (`whatsapp_config`, `ad_account_credentials`, ou domínio futuro) deve requerer alteração de código para se beneficiar de uma rotação. |
| RNF-2 | **Zero downtime.** Nenhuma etapa do processo de rotação exige parar de aceitar tráfego de leitura ou escrita. |
| RNF-3 | **Determinismo.** A seleção de chave de escrita nunca é probabilística, negociada em runtime, ou dependente de ordem de chegada de requisições. |
| RNF-4 | **Resolução O(1).** O crescimento do Key Ring (acúmulo de KIDs `DecryptOnly`/`Retired` ao longo do tempo) não deve degradar a complexidade de `resolveKey()`, que permanece um lookup direto (`ADR-CRYPTO-001 §4`: função total e determinística). |
| RNF-5 | **Auditabilidade.** Toda transição de capacidade de um KID é um evento distinguível (mesmo que o mecanismo de registro seja decisão de IMP futuro), nunca uma mudança silenciosa de configuração indistinguível de um erro operacional. |
| RNF-6 | **Independência de eixo.** A rotação de chave e o cutover de domínio (`IMP-CRYPTO-001 §6`, flags `FLAG_CANONICAL_WRITE_<DOMAIN>`) são eixos ortogonais — nenhum dos dois pressupõe ou modifica o estado do outro. |

## 7. Modelo de Key Ring durante rotação

O Key Ring permanece, durante e após qualquer rotação, a mesma estrutura definida em `ADR-CRYPTO-001 §5`: um conjunto de entradas `KID → Material Criptográfico`, com exatamente uma entrada `Active`. Rotação nunca substitui o Key Ring — apenas transiciona a capacidade de entradas dentro dele e adiciona novas entradas.

Estado ilustrativo durante uma rotação em andamento (`ACTIVE_V1` sendo substituída por `ACTIVE_V2`):

```
KID           Capacidade     Papel
─────────────────────────────────────────────────────────
LEGACY_GCM    DecryptOnly    Leitura de dados pré-ADR-CRYPTO-001
LEGACY_CBC    DecryptOnly    Leitura de dados pré-ADR-CRYPTO-001
ACTIVE_V1     DecryptOnly    Leitura de dados emitidos antes da rotação
ACTIVE_V2     Active         Escrita corrente + leitura de dados novos
```

Nenhum novo conceito é introduzido: `ACTIVE_V2` é um KID como qualquer outro — globalmente único, imutável, com resolução direta (`ADR-CRYPTO-001 §4`). O que muda é exclusivamente a **capacidade** atribuída a cada KID ao longo do tempo, dentro do vocabulário já definido em `§5.1`.

Em nenhum momento existe mais de uma chave `Active` (I4), e em nenhum momento uma chave deixa de resolver para leitura antes de ser comprovadamente segura fazê-lo (I7, §12 abaixo).

## 8. Estados das chaves

Os quatro estados são os já definidos em `ADR-CRYPTO-001 §5.1`. Este ADR não redefine capacidades — mas a RC1.0 continha uma contradição direta entre esta seção e §9/§10/§17 quanto à capacidade de leitura de `Retired`. As subseções abaixo eliminam essa contradição de forma definitiva; nenhuma outra leitura é válida a partir desta revisão.

### 8.0 Definição única — resolve Gate Arquitetural #1, achado C1

**`resolveKey(kid)` resolve uma chave `Retired` exatamente da mesma forma, e sob as mesmas condições, que resolve uma chave `DecryptOnly` — sempre, sem condição adicional, sem distinção de comportamento.** Não existe, e nunca existiu de forma bem definida, um "processo administrativo" separado do caminho normal de aplicação para leitura de dados sob uma chave `Retired`. A frase que sugeria o contrário na RC1.0 está revogada.

**Justificativa:** a garantia central deste ADR (RF-8, §12) é que nenhuma transição jamais reduz capacidade de leitura de dados já persistidos, exceto a transição terminal e irreversível para `Destroyed` (I7, T8 em §8.3). Permitir que `Retired` reduzisse capacidade de leitura — mesmo que apenas redirecionando para um "processo administrativo" nunca definido — criaria exatamente o risco que este ADR existe para eliminar: um estado intermediário, de baixa confiança, no qual dados potencialmente ainda existentes se tornam inacessíveis pelo caminho sancionado. Portanto `DecryptOnly` e `Retired` são, em capacidade técnica, **idênticos**.

| Estado | Read | Write | `resolveKey()` retorna? | `getWriteKey()` retorna? |
|---|---|---|---|---|
| **Active** | ✔ | ✔ | Sim | Sim — é a única entrada possível (I4) |
| **DecryptOnly** | ✔ | ✖ | Sim | Não |
| **Retired** | ✔ | ✖ | **Sim — idêntico a `DecryptOnly`** | Não |
| **Destroyed** | ✖ | ✖ | **Não — `UNKNOWN_KID`** | Não |

### 8.1 A diferença exata entre `DecryptOnly`, `Retired` e `Destroyed`

- **`DecryptOnly` vs `Retired` — nenhuma diferença de capacidade técnica.** A distinção é **exclusivamente administrativa**: `Retired` é uma declaração, registrada para fins de auditoria (RNF-5) e como pré-condição de processo (§13.3), de que uma chave é candidata a `Destroyed` porque uma convergência de **alta confiança** — qualitativa, não formal, não total — foi observada (critério distinto e estritamente mais fraco que o exigido para `Destroyed`, §13.1/§13.3). `Retired` não é consultado por nenhuma lógica de decisão de leitura — é metadado de ciclo de vida, não um estado funcional.
- **`Retired` vs `Destroyed` — a única diferença real do sistema.** `Destroyed` é a única transição que de fato remove capacidade de leitura (Read ✖) e é irreversível por construção (o material deixou de existir). `Retired` nunca remove capacidade e é sempre revertível (T7, §8.3).
- Em suma: existem, na prática, apenas **dois níveis de capacidade** — "legível" (`Active`, `DecryptOnly`, `Retired`, todos resolvidos por `resolveKey()`) e "não legível" (`Destroyed`, único estado terminal). `Retired` é um marcador dentro do primeiro nível, não um terceiro nível de capacidade.

### 8.2 Transições de entrada — visão geral (tabela formal completa em §8.3)

| Estado | Transição de entrada |
|---|---|
| **Active** | Promoção de `DecryptOnly` ou de `Retired` (§8.3) — ou provisionamento inicial de um Key Ring novo (caso único, fora do escopo de rotação) |
| **DecryptOnly** | Rebaixa de `Active` — ou registro inicial como legado (`LEGACY_GCM`/`LEGACY_CBC`) — ou reversão de `Retired` |
| **Retired** | Declaração administrativa a partir de `DecryptOnly`, com base em convergência de alta confiança |
| **Destroyed** | Convergence Attestation formal a partir de `Retired`, exclusivamente (I7, §13.3) — única transição irreversível |

### 8.3 Tabela formal de transições — resolve Gate Arquitetural #1, achado H1

Toda transição possível — permitida ou proibida — é enumerada abaixo. O conjunto é fechado: nenhum par (origem, destino) fora desta tabela é válido, e nenhuma transição depende de interpretação.

| # | Transição | Permitida? | Pré-condição | Pós-condição | Invariante mantida |
|---|---|---|---|---|---|
| T1 | `[provisionamento] → DecryptOnly` | Sim | Novo KID globalmente único (I3/I6); material provisionado; algoritmo declarado (`ADR-CRYPTO-001 §6`) | KID presente no Key Ring, Read ✔/Write ✖; resolvível por `resolveKey()`; nunca retornado por `getWriteKey()` | I2, I3, I6 |
| T2 | `[provisionamento] → Active` | Sim, **somente** para o KID inicial de um Key Ring recém-criado — nunca como resultado de rotação | Key Ring ainda não possui nenhuma entrada `Active` | Exatamente uma `Active` passa a existir | I4 |
| T3 | `DecryptOnly → Active` (promoção) | Sim | (a) KID já presente como `DecryptOnly` em 100% das instâncias em execução (rollout confirmado, §11 etapa 2); (b) exatamente uma `Active` existe imediatamente antes da transição | Este KID passa a `Active` (Read ✔/Write ✔); simultânea e atomicamente, a `Active` anterior passa a `DecryptOnly` (T4) | I4 — nunca zero, nunca duas `Active` observáveis |
| T4 | `Active → DecryptOnly` (rebaixa) | Sim, **exclusivamente como a outra metade da mesma operação atômica que T3** — nunca isolada | Idêntica a T3 | KID rebaixado passa a Read ✔/Write ✖; nunca mais retornado por `getWriteKey()` a partir deste ponto | I4, I5 |
| T5 | `Retired → Active` (reativação) | Sim | Idêntica a T3 — `Retired` e `DecryptOnly` têm capacidade técnica idêntica (§8.0), logo a mesma pré-condição de promoção se aplica | Idêntica a T3; marcador administrativo de `Retired` é removido pela promoção. Cobre explicitamente o cenário de rollback tardio, após a chave anterior já ter sido declarada `Retired` (§12) | I4, I6 — nenhuma nova identidade de KID é criada |
| T6 | `DecryptOnly → Retired` | Sim | Declaração administrativa de convergência de alta confiança — critério qualitativo, deliberadamente mais fraco que a pré-condição de T8 | Nenhuma mudança de capacidade (Read ✔/Write ✖ mantido); evento de auditoria registrado (RNF-5); KID passa a candidato de `Destroyed` | Nenhuma — transição puramente declarativa |
| T7 | `Retired → DecryptOnly` (reversão) | Sim | Nenhuma — reversível a qualquer momento, tipicamente por descoberta de dependência residual ou reavaliação operacional | Marcador administrativo removido; capacidade tecnicamente inalterada (já era Read ✔/Write ✖) | Nenhuma — transição puramente declarativa |
| T8 | `Retired → Destroyed` | Sim | Convergence Attestation formal e total emitida (I7, §13.3) — critério distinto e estritamente mais forte que a pré-condição de T6 | KID passa a Read ✖/Write ✖; irreversível; Attestation persistida e consultável (§13.3) | I7 |
| T9 | `Active → Retired` | **Proibida** | — | — | Uma chave `Active` ainda serve escrita corrente; declará-la candidata a destruição é incoerente antes de perder capacidade de escrita (T4) |
| T10 | `Active → Destroyed` | **Proibida** | — | — | Destruiria a única chave de escrita corrente, violando I4 e toda operação de `encrypt()` em curso |
| T11 | `DecryptOnly → Destroyed` (pulando `Retired`) | **Proibida** | — | — | `Destroyed` exige Convergence Attestation (T8), cuja emissão pressupõe a declaração prévia em `Retired` (T6) — não existe atalho |
| T12 | `Destroyed → *` (qualquer saída) | **Proibida** | — | — | `Destroyed` é terminal por construção — o material foi descartado; não há a que retornar |

Todo par (origem, destino) não listado é coberto implicitamente por T9–T12 ou é logicamente inexistente (uma transição de um estado para si mesmo não é uma transição).

## 9. Política de seleção de chave para escrita

`getWriteKey()` permanece, sem alteração de assinatura ou de contrato, a única fronteira pela qual qualquer código de aplicação obtém a chave de escrita corrente (`IMP-CRYPTO-001 §3.2`, restrição obrigatória desta sessão).

A política é: **`getWriteKey()` retorna, sempre e exclusivamente, a única entrada com capacidade `Active` no Key Ring corrente.**

- Não há seleção por prioridade, peso, round-robin ou qualquer critério dinâmico.
- Não há retorno de múltiplas chaves candidatas para escolha em call site.
- A existência de exatamente uma chave `Active` é uma invariante de **construção** do Key Ring (I4), não uma verificação em tempo de chamada — um Key Ring que viole I4 falha ao ser construído, nunca em uso (mesmo padrão já implementado para `MULTIPLE_ACTIVE_KEYS`/`NO_ACTIVE_KEY` na fundação atual).
- A transição de qual KID é `Active` (§10) é uma operação de **configuração**, aplicada como uma substituição atômica do Key Ring inteiro na inicialização de cada instância — nunca uma mutação em memória de um Key Ring já em uso. Isso preserva RNF-3 (determinismo): dentro do tempo de vida de um processo, a resposta de `getWriteKey()` é sempre a mesma.

## 10. Política de leitura durante múltiplas versões

`resolveKey(kid)` permanece, sem alteração, a única fronteira pela qual qualquer código de aplicação resolve material de leitura (`IMP-CRYPTO-001 §3.2`, restrição obrigatória).

A política é: **cada envelope carrega seu próprio KID (P1, `ADR-CRYPTO-001 §3`); `resolveKey()` resolve esse KID diretamente, sem considerar qual chave é `Active` no momento da leitura.**

Isso significa que a leitura nunca "sabe" que uma rotação está em andamento, aconteceu, ou está planejada — o mesmo caminho de código lê um envelope emitido há um ano sob `ACTIVE_V1` e um envelope emitido há um segundo sob `ACTIVE_V2`, com o mesmo custo e a mesma ausência de ramificação condicional. Este é o mecanismo central pelo qual RNF-1 (zero mudança de call site) é satisfeito: a coexistência de versões é inteiramente absorvida pelo Key Ring, nunca exposta.

A única falha possível na leitura é `UNKNOWN_KID` (I12) — que ocorre exclusivamente se uma instância tentar resolver um KID que ainda não foi adicionado à sua configuração de Key Ring. A prevenção dessa falha é inteiramente uma questão de **disciplina de rollout** (§11), não de política de resolução.

## 11. Processo de rotação

Rotação é sempre a introdução de uma **nova identidade de KID**, nunca a alteração do material referenciado por um KID existente — decisão estrutural obrigatória desta sessão ("KID continua sendo a identidade criptográfica") e consequência direta de `ADR-CRYPTO-001 §4`: KID é imutável, permanente, nunca reutilizado.

Processo, em etapas discretas e sequenciais:

1. **Provisionamento.** Um novo KID (ex. `ACTIVE_V2`) é definido com material criptográfico próprio e algoritmo declarado (`ADR-CRYPTO-001 §6` — algoritmo faz parte da identidade da chave). O mecanismo de provisionamento do material (derivação, geração, KMS) é decisão de implementação futura, fora do escopo deste ADR.
2. **Introdução como `DecryptOnly`.** O novo KID é adicionado ao Key Ring de configuração com capacidade `DecryptOnly` — nenhuma instância o utiliza para escrita ainda. Esta etapa é implantada (deploy de configuração) até atingir 100% das instâncias em execução, usando exatamente a mesma disciplina de confirmação de rollout já validada em `IMP-CRYPTO-001 §6` para o cutover de domínio (passo 3: *"Confirmar que a release atingiu 100% das instâncias em execução"*). Isso garante que toda instância seja capaz de **ler** o novo KID antes de qualquer instância poder **emiti-lo** — eliminando a única falha de disciplina relevante (P-2, §2).
3. **Promoção atômica.** Uma vez confirmado 100% de rollout da etapa 2, uma nova configuração de Key Ring é publicada em que o novo KID passa a `Active` e o KID anteriormente `Active` passa simultaneamente a `DecryptOnly` — a mesma substituição atômica de configuração (§9), nunca uma mutação incremental visível parcialmente.
4. **Escrita corrente.** A partir da propagação completa da etapa 3, todo `encrypt()`/`encryptWithBindingContext()` em qualquer domínio já cutover passa a produzir envelopes sob o novo KID — sem qualquer alteração de código, por construção (RF-4, RNF-1).
5. **Convergência (opcional, assíncrona).** Ciphertexts existentes sob o KID anterior permanecem válidos e legíveis indefinidamente (`DecryptOnly`) — não há obrigação temporal de reconverter. Convergência, se e quando decidida, segue a estratégia descrita em §13 (a referência a "§14" na RC1.0 era uma referência cruzada incorreta — correção incidental, não relacionada aos achados do Gate; §14 é "Compatibilidade com envelopes existentes", não a estratégia de migração).
6. **Fim de vida (opcional, tardio).** Uma vez atingida confiança operacional de que nenhum consumo de leitura corrente depende mais do KID anterior, ele pode ser declarado `Retired` (T6, §8.3) e, eventualmente, mediante Convergence Attestation formal (T8, §8.3, §13.3), `Destroyed` (I7).

Nenhuma etapa deste processo requer coordenação distribuída em tempo real, lock global, ou janela de indisponibilidade (RNF-2) — cada etapa é uma publicação de configuração seguida de uma janela de confirmação de rollout, o mesmo padrão operacional já em produção para cutover de domínio.

## 12. Processo de rollback

Rollback, neste contrato, significa exclusivamente **reverter qual KID é `Active`** — nunca remover a capacidade de leitura de um KID já introduzido.

- Se um defeito for descoberto na etapa 3 (§11) — por exemplo, o novo KID foi promovido a `Active` prematuramente, antes de 100% de rollout da etapa 2 — o rollback é publicar novamente a configuração anterior, restaurando o KID original como `Active`. Nenhum ciphertext já emitido sob o novo KID (se algum foi emitido) perde legibilidade: ele permanece resolvível porque o novo KID, mesmo revertido a `DecryptOnly`, nunca deixa de estar no Key Ring.
- **Esta é uma garantia estritamente mais forte que a do rollback de código** discutida em `IMP-CRYPTO-001 §12.2` (que proíbe reverter a capacidade de *leitura* de código para uma versão incapaz de interpretar o formato canônico). Aqui, rollback nunca remove capacidade de leitura de nada — ele apenas revoga capacidade de **escrita** de um KID, uma operação que, por construção (P1, envelope autodescritivo), não pode invalidar dados já persistidos.
- Rollback não tem prazo de expiração nem é uma operação de emergência distinta do processo normal — é a mesma operação de "promoção atômica" (§11, etapa 3), aplicada na direção inversa.
- Rollback nunca é aplicável a uma chave já `Destroyed` (irreversível por definição, §8, T12) — esta é a única transição sem caminho de volta, precisamente porque destrói a garantia de leitura, não apenas de escrita.
- **Rollback tardio — resolve Gate Arquitetural #1, achado H1.** Se um defeito só for descoberto depois que a chave anterior já tiver sido declarada `Retired` (§11, etapa 6), a reativação segue exatamente a mesma transição e pré-condição de uma promoção a partir de `DecryptOnly` (T5, §8.3) — não é um mecanismo especial de emergência, é a mesma operação de promoção (§9) aplicada a uma chave que, além disso, carrega um marcador administrativo, automaticamente removido pela própria promoção. Isso é possível porque `Retired` e `DecryptOnly` têm capacidade técnica idêntica (§8.0) — a reativação nunca depende de "restaurar" uma capacidade que, na verdade, nunca foi perdida.

## 13. Estratégia de migração (convergência de ciphertext)

Migração, neste contrato, refere-se exclusivamente à **convergência opcional de ciphertext** de um KID antigo para o KID `Active` corrente — nunca à migração de schema de banco de dados (fora de escopo desta sessão) e nunca obrigatória para a segurança do sistema (dados sob um KID `DecryptOnly` permanecem tão autenticados quanto sob `Active`; a única motivação para convergir é permitir eventual `Retired`/`Destroyed` do KID antigo).

### 13.1 Definição formal de convergência e escopo — resolve Gate Arquitetural #1, achado H2

**Convergência de um KID é total se, e somente se, nenhuma superfície de armazenamento operacional listada no Inventário de Superfícies de Ciphertext contém, ou pode voltar a conter — por exemplo, via redelivery, replay ou restauração —, um ciphertext resolvível por esse KID.**

O **Inventário de Superfícies de Ciphertext** é um artefato mantido (o mecanismo concreto de manutenção — onde vive, como é versionado, como é consultado — é decisão de IMP futuro) cuja composição mínima obrigatória, para qualquer declaração de convergência ser considerada válida, cobre no mínimo:

| Superfície | Exemplo no sistema atual | Por que precisa entrar no inventário |
|---|---|---|
| Tabelas primárias | `whatsapp_config`, `ad_account_credentials` | É onde o ciphertext vive em operação normal |
| Filas e mecanismos de retry | Outbound retry ledger / enqueue (épicos E4a/E4b, `MASTER-ROADMAP.md`) | Um payload de retry pode carregar ciphertext capturado antes da convergência e reenviado depois dela |
| Dead-letter queues (DLQ) | DLQ de E4b | Mensagens presas em DLQ podem permanecer não processadas por período indefinido, sobrevivendo à janela de convergência assumida por uma varredura pontual |
| Jobs assíncronos / eventos em trânsito | Job de enriquecimento (E6.0) que carregue token decifrado ou referência a ciphertext em progresso | Estado em voo no momento da varredura não é capturado por uma varredura de tabelas em repouso |
| Snapshots e backups | Backups de banco de dados | Um snapshot antigo restaurado após `Destroyed` reintroduziria ciphertext irrecuperável — o cenário exato que I7 existe para prevenir |
| Qualquer superfície futura introduzida por épico posterior | A determinar conforme o roadmap evolui | O inventário é um artefato vivo: todo épico que introduz armazenamento operacional de ciphertext (ou de dados que possam referenciá-lo) é obrigado a declarar sua entrada como parte da própria definição de pronto daquele épico — nunca descoberto retroativamente durante uma tentativa de `Destroyed` |

**Este ADR não define o mecanismo pelo qual o inventário é mantido, versionado ou consultado** — decisão de IMP futuro. **Este ADR define que tal inventário deve existir, ser exaustivo por declaração explícita — nunca por omissão —, e ser a única referência válida contra a qual "convergência total" (I7) pode ser avaliada.** Uma prova de convergência que não declare contra qual versão do inventário foi produzida não satisfaz I7 (ver §13.3).

### 13.2 Estratégias de convergência reconhecidas

Duas estratégias são reconhecidas; nenhuma é decidida como obrigatória neste ADR — a escolha por domínio é decisão de implementação futura:

- **Convergência preguiçosa (lazy, por leitura).** Ao decifrar com sucesso um envelope sob um KID que não é o `Active` corrente, o call site pode, opcionalmente, reescrever o valor sob o KID `Active`. Este padrão **já existe em produção** sob outra forma: o mecanismo de "self-heal" introduzido em `IMP-CRYPTO-001` Phase 2/3.2 (upgrade oportunista de formato legado para canônico em `webhook/route.ts`, `send/route.ts`, `config/route.ts`) é estruturalmente idêntico ao que a convergência de KID exigiria — a generalização de "legado → canônico" para "KID antigo → KID `Active`" é uma extensão natural do mesmo padrão, não um mecanismo novo.
- **Convergência administrativa (sweep em lote).** Um processo administrativo assíncrono identifica e reconverte ciphertexts residuais sob um KID `DecryptOnly`, sem depender de tráfego de leitura orgânico para alcançá-los. Necessário como complemento da convergência preguiçosa para produzir a prova de convergência total exigida por I7 antes de `Destroyed` — leitura oportunista sozinha não garante cobertura de 100% dos registros, e nenhuma das duas estratégias, isoladamente, cobre superfícies fora de tabelas (§13.1) sem extensão específica (ex.: drenar e reprocessar uma DLQ antes de considerá-la convergida).

Este ADR estabelece que **qualquer estratégia de convergência deve preservar o Binding Context original do registro sem alteração** — convergência de KID nunca é ocasião para recalcular ou reinterpretar o Binding Context de um recurso (essa decisão pertence exclusivamente ao domínio de negócio, nunca à camada de rotação).

### 13.3 Salvaguarda estrutural contra `Destroyed` prematuro — resolve Gate Arquitetural #1, achado H3

A RC1.0 deste ADR definia a pré-condição de `Destroyed` (I7) como inteiramente procedural: nenhuma diferença técnica existia entre uma chave formalmente destruída (com prova) e uma entrada de configuração removida por engano — ambas produziam `UNKNOWN_KID` de forma indistinguível. Isso tornava I7 inexequível como salvaguarda real, dependendo inteiramente de disciplina humana.

**Requisito arquitetural — decidido aqui; mecanismo concreto é decisão de IMP futuro:** a transição `Retired → Destroyed` (T8, §8.3) exige, como pré-condição **estrutural**, não apenas processual, a existência prévia de um artefato durável e consultável — a **Convergence Attestation** — satisfazendo:

1. **Persistência independente do Key Ring.** A Attestation não é um campo do Key Ring nem uma flag de configuração — é um registro em um sistema de registro durável, que sobrevive à remoção da entrada do KID da configuração ativa.
2. **Vínculo explícito ao KID e à versão do Inventário (§13.1).** A Attestation referencia o KID ao qual se aplica e a versão exata do Inventário de Superfícies de Ciphertext contra a qual a convergência foi avaliada — uma Attestation sem essa referência é inválida por definição.
3. **Distinguibilidade obrigatória.** Deve ser possível, a qualquer momento, diferenciar "KID ausente do Key Ring porque foi formalmente `Destroyed` (Attestation existe)" de "KID ausente do Key Ring por omissão operacional (Attestation não existe)" — consultando exclusivamente o registro de Attestations, independentemente do estado da configuração corrente.
4. **Imutabilidade.** Uma vez emitida, uma Attestation não é editável — apenas substituível por uma nova Attestation caso a convergência seja formalmente reavaliada. Isso não reverte um `Destroyed` já ocorrido (T12 permanece proibida); a imutabilidade protege a integridade do histórico de auditoria, não reabre a transição.

Este requisito transforma I7 de uma regra confiada exclusivamente à disciplina humana em uma pré-condição estruturalmente checável: um Key Ring, ou seu processo de governança, pode em princípio recusar-se a tratar uma entrada como `Destroyed` sem uma Attestation correspondente — mesmo que os mecanismos concretos dessa recusa (validação em deploy, auditoria periódica, ou outro) permaneçam decisão de IMP futuro.

## 14. Compatibilidade com envelopes existentes

Compatibilidade é total e não requer nenhuma ação sobre os envelopes já persistidos:

- Todo envelope canônico já emitido sob `ACTIVE_V1`, `LEGACY_GCM` ou `LEGACY_CBC` permanece decifrável indefinidamente, sem qualquer alteração de formato — o KID embutido em cada envelope (`ADR-CRYPTO-001 §3.1.1`) continua resolvendo para o mesmo material que resolvia antes de qualquer rotação, contanto que esse KID não tenha sido transicionado para `Destroyed`.
- Nenhum campo do envelope canônico (Version, KID, Algorithm Identifier, Nonce, Ciphertext, Authentication Tag) é reinterpretado, estendido ou versionado por este ADR. Rotação de chave é inteiramente uma propriedade do Key Ring, nunca do envelope.
- O Envelope Version (`0x01`) permanece semanticamente ligado ao **formato de serialização**, não ao **material de chave** — os dois eixos já são ortogonais em `ADR-CRYPTO-001` (Version identifica formato; KID identifica chave) e este ADR não introduz nenhum acoplamento entre eles (ver alternativa descartada, §19-E; correção incidental de referência cruzada).

## 15. Compatibilidade com ADR-CRYPTO-001

Este ADR opera estritamente dentro da autoridade que `ADR-CRYPTO-001` já lhe delegou, sem alterar nenhuma decisão daquele documento:

| Seção de `ADR-CRYPTO-001` | Como este ADR a preserva |
|---|---|
| §4 — KID (imutável, permanente, nunca reutilizado) | Rotação nunca reatribui o material de um KID existente; sempre introduz um novo KID |
| §5 — Key Ring (uma `Active`, N leitura) | Preservado em todo instante observável (I4); a transição é atômica, nunca um estado intermediário com zero ou duas chaves `Active` |
| §5.1 — Capacidades (delegação explícita) | Este ADR define exatamente o que foi delegado: as transições, não as capacidades em si |
| §6 — Algoritmo como identidade da chave | O par (KID, algoritmo) permanece imutável para cada KID individualmente (I9). **Restrição explícita — resolve Gate Arquitetural #1, achado H4:** um novo KID `Active` só pode declarar um algoritmo dentro da família AEAD compatível com o pseudocódigo normativo `IMP-CRYPTO-001 §6.1` (ver §16) — não há liberdade irrestrita de algoritmo entre KIDs sucessivos |
| I4 | Preservada por construção (§9) |
| I6 (KID nunca reutilizado) | Preservada por construção (§11 — rotação sempre introduz identidade nova) |
| I7 (precondição de `Destroyed`) | Este ADR define exatamente essa precondição (§13, prova de convergência total) — cumprindo a delegação explícita do texto de I7 |

Nenhuma seção de `ADR-CRYPTO-001` é reaberta, contestada ou modificada.

## 16. Compatibilidade com IMP-CRYPTO-001

- A interface implementada (`KeyRing`, `resolveKey(kid)`, `getWriteKey()`, `hasKID(kid)`) já é suficiente para este modelo sem alteração de assinatura — confirmado por `IMP-CRYPTO-001 §4.3`, escrito precisamente para esta eventualidade.
- O padrão de rollout em duas etapas (introduzir capacidade de leitura em 100% das instâncias antes de habilitar escrita) descrito em §11 é o mesmo padrão já implementado e validado em produção para o cutover de domínio (`IMP-CRYPTO-001 §6`, `FLAG_CANONICAL_WRITE_<DOMAIN>`) — este ADR reaplica esse padrão operacional ao eixo de rotação de chave, sem inventar um mecanismo novo.
- O eixo de rotação (qual KID é `Active`) e o eixo de cutover de domínio (se um domínio já escreve canonical) são independentes (RNF-6): um domínio ainda não cutover (escrevendo apenas formato legado) é inteiramente indiferente a qualquer rotação — ele simplesmente não invoca `getWriteKey()` até seu próprio cutover ocorrer. Nenhuma interação entre os dois eixos é criada por este ADR.
- O par `encrypt`/`decrypt` pré-cutover (legado, `IMP-CRYPTO-001 §3.3`) é inteiramente alheio a este ADR — nunca importa de `lib/crypto/`, nunca invoca o Key Ring, e portanto nunca é afetado por nenhuma rotação.
- **Restrição de família de algoritmo — resolve Gate Arquitetural #1, achado H4.** `IMP-CRYPTO-001 §6.1` é o pseudocódigo de referência normativo para toda operação de `encrypt`/`decrypt` sob envelope canônico, e é especificamente AEAD: as etapas obrigatórias 4 e 6 (`setAAD()`; obtenção da Authentication Tag via `getAuthTag()`) só existem em cifras AEAD — a implementação real já materializa essa suposição com os casts `as crypto.CipherGCM`/`DecipherGCM` em `encryption.ts`. Este ADR, portanto, **não concede liberdade irrestrita de algoritmo entre KIDs sucessivos**: uma nova chave `Active` deve usar um algoritmo AEAD compatível com essa sequência de 7 passos — na prática, variantes da família GCM. Um algoritmo fora dessa família é declarado **fora do escopo deste ADR**; sua introdução exigiria uma revisão de `IMP-CRYPTO-001 §6.1` — ou seja, reabertura da baseline congelada, não permitida nesta revisão nem implicitamente autorizada por este documento.

## 17. Invariantes preservados

Todos os catorze invariantes de `ADR-CRYPTO-001 §10` permanecem válidos, sem exceção, sob qualquer sequência de rotações permitida por este ADR:

| Invariante | Preservação sob rotação |
|---|---|
| I1 (um KID por envelope) | Inalterado — cada envelope grava o KID vigente no momento de sua emissão |
| I2 (KID → um material) | Preservado — um novo KID nunca reaponta para material de outro KID |
| I3 (KID único, pertence a um Key Ring) | Preservado — cada novo KID de rotação é único por construção (RF-1) |
| I4 (exatamente uma `Active`) | Preservado por construção em toda transição atômica (§9, §11) |
| I5 (`Active` também válida para leitura) | Preservado — toda `Active` nasce com capacidade Read+Write (§8) |
| I6 (KID nunca reutilizado) | Preservado — rotação nunca reintroduz um KID já aposentado, mesmo após `Destroyed` |
| I7 (precondição de `Destroyed`) | Definida por este ADR (§13) — não relaxada, apenas operacionalizada |
| I8 (Authentication Tag obrigatória) | Inalterado — nenhuma chave nova opera fora do regime de autenticação já definido |
| I9 (algoritmo do envelope == algoritmo do KID) | Preservado por KID, individualmente; liberdade de algoritmo entre KIDs sucessivos é restrita à família AEAD compatível com `IMP-CRYPTO-001 §6.1` (§15, §16) |
| I10 (versão desconhecida falha fechada) | Inalterado — rotação não introduz nova Envelope Version |
| I11 (algoritmo desconhecido falha fechada) | Inalterado |
| I12 (KID desconhecido falha fechada) | A única invariante operacionalmente relevante para disciplina de rollout (§11, etapa 2) — preservada, nunca contornada |
| I13 (unicidade de nonce por KID) | Preservada — cada novo KID inicia seu próprio espaço de nonce, sem herdar histórico de outro KID |
| I14 (AAD exato) | Inalterado — o AAD já inclui o KID como campo; rotação não modifica a construção do AAD |

## 18. Falhas consideradas

| Falha | Causa | Consequência sem mitigação | Mitigação decidida |
|---|---|---|---|
| Instância decifra `UNKNOWN_KID` durante rotação | Novo KID promovido a `Active` (etapa 3) antes de 100% de rollout da etapa 2 | Falha de leitura em instâncias desatualizadas para envelopes recém-emitidos | Confirmação obrigatória de 100% de rollout entre etapas 2 e 3 (§11), mesmo padrão de `IMP-CRYPTO-001 §6` |
| Duas chaves `Active` simultâneas | Publicação de configuração incorreta ou concorrente | Ambiguidade de escrita, violação de I4 | Construção do Key Ring falha (`MULTIPLE_ACTIVE_KEYS`) antes de qualquer uso — mesmo mecanismo já implementado |
| `Destroyed` prematuro | Convergência declarada sem prova real, ou prova real mas com escopo incompleto (superfície de armazenamento fora do inventário declarado — ex.: DLQ, snapshot) | Perda permanente e irrecuperável de dados sob esse KID | I7 exige Convergence Attestation formal, vinculada a uma versão específica do Inventário de Superfícies de Ciphertext (§13.1, §13.3); `Retired` (T6/T7, §8.3) permanece sempre reversível e nunca reduz capacidade de leitura (§8.0), absorvendo incerteza antes do ponto de não retorno |
| Confusão sobre capacidade de leitura de `Retired` (achado C1 do Gate #1) | Leitura da RC1.0 do documento, agora corrigida | Implementação bloqueia incorretamente a leitura de dados sob uma chave `Retired`, ou trata `Retired` como equivalente a `Destroyed` | §8.0 define identidade técnica explícita entre `DecryptOnly` e `Retired` — nenhuma leitura alternativa é possível a partir da RC1.1 |
| Colisão de identidade de KID | Geração de novo KID sem garantia de unicidade | Violação de I3/I6, potencial confusão de material | Requisito de unicidade sem coordenação distribuída já herdado de `ADR-CRYPTO-001 §4.1`; mecanismo concreto de geração é decisão de IMP futuro |
| Crescimento não controlado do Key Ring | KIDs nunca transicionados para `Retired`/`Destroyed` | Degradação operacional (não de performance, RNF-4, mas de auditabilidade e superfície de configuração) | Ciclo de vida completo definido (§8) até `Destroyed`; política de cadência de convergência é decisão de IMP futuro, não deste ADR |
| Confusão entre eixo de rotação e eixo de cutover de domínio | Implementador assume que rotação exige coordenação com `FLAG_CANONICAL_WRITE_<DOMAIN>` | Acoplamento acidental, complexidade desnecessária | RNF-6 declara os eixos independentes explicitamente |
| Reversão de rotação interpretada como violação de I6 | Confusão entre "KID nunca reutilizado" e "designação de `Active` revertida" | Rejeição incorreta de rollback legítimo | §12 esclarece: rollback nunca reintroduz um KID (I6 preservada); apenas revoga capacidade de escrita de um KID que nunca deixou de existir |

## 19. Alternativas descartadas

- **A. Reencriptação síncrona em massa no momento da rotação.** Rejeitada. Exigiria lock ou janela de indisponibilidade proporcional ao volume de dados, viola RNF-2 (zero downtime) e P4 (`ADR-CRYPTO-001`, evolução compatível sem quebra). A convergência preguiçosa/administrativa (§13) atinge o mesmo fim sem essas propriedades negativas.
- **B. Rotação in-place (reatribuir o material de um KID existente).** Rejeitada estruturalmente — não apenas operacionalmente. Violaria diretamente `ADR-CRYPTO-001 §4` (KID imutável, permanente) e I2/I3/I6, tornando o KID uma referência móvel em vez de uma identidade estável. Esta alternativa é incompatível com a restrição obrigatória desta sessão ("KID continua sendo a identidade criptográfica") e não é reconsiderável sem reabrir `ADR-CRYPTO-001`.
- **C. Rotação automática por tempo (TTL de chave, disparo por cron).** Rejeitada nesta versão do contrato. Introduz superfície de falha (rotação disparada sem operador ciente) e complexidade operacional sem necessidade comprovada — nenhum requisito de compliance ou incidente motiva rotação por prazo fixo hoje. Rotação permanece um evento deliberado e administrativo. Reavaliável em ADR futuro se um requisito de compliance o exigir.
- **D. Um Key Ring por domínio, em vez de um único Key Ring compartilhado.** Rejeitada. Contraria I3 (*"todo KID pertence exatamente a um Key Ring"*) sem necessidade — domínios já se diferenciam por Binding Context (`ADR-CRYPTO-001 §7`), não por Key Ring. Múltiplos Key Rings duplicariam superfície de configuração sem ganho de isolamento, já que cada KID é individualmente isolado por material.
- **E. Versionar o Envelope Format (byte de versão) para carregar informação de rotação.** Rejeitada. Confundiria dois eixos de evolução que `ADR-CRYPTO-001` já mantém ortogonais: Envelope Version identifica **formato de serialização** (P4); KID identifica **chave**. Acoplar rotação ao Envelope Version reabriria o Envelope Format — proibido nesta sessão e desnecessário, já que o KID já é suficiente para expressar rotação sem tocar o formato.
- **F. Expor parâmetro de versão/geração nas funções públicas (`encrypt(data, bc, keyVersion)`).** Rejeitada. Viola diretamente P3 (`ADR-CRYPTO-001`, encapsulamento — consumidores nunca manipulam KID) e a restrição obrigatória desta sessão ("nenhum call site deve conhecer detalhes de versionamento"). `getWriteKey()` já resolve a chave corrente sem que o chamador precise (ou possa) influenciar a escolha.

## 20. Impacto sobre domínios existentes

- **`whatsapp_config`** e **`ad_account_credentials`** (ambos com Phase 2/3.1/3.2 encerradas): zero alteração de código. `encryptWithBindingContext`/`decryptWithBindingContext` continuam chamando `getWriteKey()`/`resolveKey()` exatamente como hoje; uma rotação futura muda qual KID essas funções retornam, nunca a assinatura ou o comportamento observável pelo domínio.
- Ciphertexts já persistidos sob `ACTIVE_V1` permanecem legíveis indefinidamente após qualquer rotação futura, sem necessidade de reconversão para continuar funcionando (§14).
- O par legado `encrypt`/`decrypt` (ainda em uso como fallback gateado em 3 call sites, `IMP-CRYPTO-001 §0.4`) permanece inteiramente fora do alcance deste ADR — nunca consulta o Key Ring.

## 21. Impacto sobre futuros domínios

- Todo domínio futuro que adote `encryptWithBindingContext`/`decryptWithBindingContext` herda automaticamente a capacidade de rotação, sem custo de integração adicional — a mesma fronteira (`getWriteKey()`/`resolveKey()`) que os domínios atuais já usam.
- **`ad_account_credentials`** — referenciado por `ADR-ATTR-002 §6` como "E7-aware, não E7-dependente" — passa a ter, com este ADR, uma definição concreta de como sua dívida de rotação registrada será eventualmente resolvida, sem necessidade de reabrir `ADR-ATTR-002`.
- Nenhum domínio futuro precisa declarar, escolher ou negociar uma versão de chave — a opacidade total do KID para consumidores (P3) é preservada para qualquer novo domínio, tanto quanto para os existentes.

## 22. Riscos

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| RE-1 | Rollout de nova capacidade de leitura incompleto antes de promoção a `Active` | Baixa | Alto (falha de leitura para dados novos em instâncias desatualizadas) | Disciplina de confirmação de 100% de rollout obrigatória entre etapas (§11) |
| RE-2 | Declaração prematura de `Destroyed` | Baixa | Crítico (perda de dados irrecuperável) | I7 + Convergence Attestation estrutural obrigatória (§13.3) + Inventário de Superfícies de Ciphertext declarado e versionado (§13.1) + `Retired` sempre reversível via T7 (§8.3) |
| RE-3 | Acúmulo indefinido de KIDs `Retired` nunca `Destroyed` | Média | Baixo/Médio (superfície de configuração, auditabilidade) | Ciclo de vida completo definido; cadência é decisão operacional futura |
| RE-4 | Confusão operacional entre "rotação de chave" e "cutover de domínio" por um implementador futuro | Média | Médio | RNF-6 e §16 tornam a independência dos eixos explícita no contrato |
| RE-5 | Primeira rotação real da plataforma nunca exercitada antes de ser genuinamente necessária (ex. suspeita de comprometimento) | Média (até a primeira execução) | Alto | Fora do escopo deste ADR mitigar diretamente — decisão de produto/operação recomendar um exercício de rotação não emergencial após implementação, como validação do mecanismo (nota, não requisito normativo) |

## 23. Decisão arquitetural

| ID | Decisão |
|----|---------|
| E7-ADR-001 | Rotação de chave é sempre introdução de um novo KID; nunca reatribuição de material a um KID existente. |
| E7-ADR-002 | As transições de capacidade formam o grafo fechado definido em §8.3 (T1–T12): progressão predominante `Active → DecryptOnly → Retired → Destroyed`, com reversões explícitas `Retired → DecryptOnly` (T7) e `Retired → Active` (T5), e `Destroyed` como único estado terminal irreversível (T12). |
| E7-ADR-003 | `getWriteKey()` retorna, sempre e exclusivamente, a única entrada `Active` do Key Ring corrente — sem seleção dinâmica, sem parâmetro de versão. |
| E7-ADR-004 | `resolveKey(kid)` resolve qualquer KID presente no Key Ring (exceto `Destroyed`) independentemente da capacidade `Active` corrente — leitura nunca é sensível a rotação. |
| E7-ADR-005 | Promoção de um novo KID a `Active` exige confirmação prévia de 100% de rollout de sua disponibilidade como `DecryptOnly` em todas as instâncias — mesma disciplina já validada em `IMP-CRYPTO-001 §6`. |
| E7-ADR-006 | Rollback de rotação é a reversão da designação `Active`, nunca a remoção de capacidade de leitura de um KID — garantia mais forte que a de rollback de código (`IMP-CRYPTO-001 §12.2`). |
| E7-ADR-007 | `Destroyed` exige prova formal de convergência total (I7); nenhuma outra transição de capacidade requer prova equivalente. |
| E7-ADR-008 | Convergência de ciphertext é opcional, não obrigatória para segurança, e pode ser preguiçosa (leitura oportunista) e/ou administrativa (sweep em lote) — escolha por domínio é decisão de implementação futura. |
| E7-ADR-009 | Rotação de chave e cutover de domínio (`FLAG_CANONICAL_WRITE_<DOMAIN>`) são eixos ortogonais e independentes. |
| E7-ADR-010 | Nenhuma função pública ou call site pode receber, aceitar ou expor parâmetro relacionado a versão, geração ou identidade de chave — a opacidade de P3 (`ADR-CRYPTO-001`) é absoluta também sob rotação. |
| E7-ADR-011 | `DecryptOnly` e `Retired` possuem capacidade técnica idêntica (Read ✔/Write ✖); a diferença entre os dois é exclusivamente administrativa/de auditoria, nunca funcional (§8.0 — resolve Gate Arquitetural #1, achado C1). |
| E7-ADR-012 | Toda transição de estado é definida por pré-condição, pós-condição e invariante mantida, em uma tabela fechada (§8.3); nenhum par (origem, destino) fora dessa tabela é válido (resolve Gate Arquitetural #1, achado H1). |
| E7-ADR-013 | Convergência total (I7) só é avaliável contra um Inventário de Superfícies de Ciphertext declarado e versionado, cuja composição mínima cobre tabelas primárias, filas/retries, DLQ, jobs assíncronos e snapshots/backups (§13.1 — resolve Gate Arquitetural #1, achado H2). |
| E7-ADR-014 | A transição `Retired → Destroyed` exige uma Convergence Attestation — artefato durável, vinculado a KID e a versão de inventário, imutável e estruturalmente distinguível de omissão de configuração (§13.3 — resolve Gate Arquitetural #1, achado H3). |
| E7-ADR-015 | Um novo KID `Active` só pode declarar algoritmo dentro da família AEAD compatível com `IMP-CRYPTO-001 §6.1`; algoritmos fora dessa família são fora de escopo deste ADR (§15, §16 — resolve Gate Arquitetural #1, achado H4). |

---

## Conformidade

- **Nenhum contrato fechado reaberto.** `ADR-CRYPTO-001` (Envelope Format, Recognition Tree, AAD, KID, Binding Context, invariantes I1–I14) permanece integralmente como está — este ADR opera inteiramente dentro da delegação explícita de `§5.1` e `I7`. `IMP-CRYPTO-001` RC1.3 (API pública, pares de função, Phases 1–3.2) permanece integralmente como está.
- **Nenhum código, migration ou plano de implementação produzido** — decisão de arquitetura e fronteira apenas, pronta para IMP-E7-001 futuro.
- **Zero impacto de call site declarado e justificado estruturalmente** (§9, §10, §20, §21), não apenas prometido.
- **Todos os catorze invariantes de `ADR-CRYPTO-001` auditados individualmente e confirmados preservados** (§17).
- **RC1.1 — os 5 achados do Gate Arquitetural #1 (1 CRITICAL, 4 HIGH) foram resolvidos por definição única, sem ambiguidade remanescente** (§0, §8.0–§8.3, §13.1, §13.3, §15, §16). Nenhuma decisão de RC1.0 não relacionada aos achados foi alterada.

---

*Fim do ADR. Governança de ciclo de vida de chaves apenas — nenhum código, migration, ou plano de implementação foi produzido. RC1.1, pronto para novo Gate Arquitetural.*
