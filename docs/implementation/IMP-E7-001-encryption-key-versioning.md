# IMP-E7-001 — Implementation Plan: Encryption Key Versioning & Rotation

## 0. Metadata

| | |
|---|---|
| **Status** | Draft — pronto para Gate de Implementation Plan |
| **Baseline arquitetural** | `ADR-E7-001` RC1.1 — Gate Arquitetural #2: **GO** (sem condições) |
| **Referências** | `ADR-CRYPTO-001` v2.0 (APPROVED FOR IMPLEMENTATION) · `IMP-CRYPTO-001` RC1.3 (Phases 1–3.2 encerradas, Implementation Completion Review fechada) · `ADR-E7-001` RC1.1 (§0–§23) |
| **Dependências** | Nenhuma bloqueante. E7 é independente da cadeia de precedência de messaging (`MASTER-ROADMAP.md` §8.4) e pode avançar em paralelo a qualquer outro épico. |
| **Escopo** | Transformar as decisões de `ADR-E7-001` RC1.1 em uma sequência executável de implementação. Não inclui a execução de uma rotação real em produção, nem qualquer decisão de produto sobre quando rotacionar — este IMP entrega a **capacidade**, não o evento. |
| **Owner** | Platform Architecture |

---

## 1. Objetivo

Ao final da implementação deste plano, a plataforma deve ser capaz de:

1. Introduzir um novo KID de escrita (`Active`) e promovê-lo através do processo de rotação (`ADR-E7-001 §11`), sem qualquer alteração em nenhum call site de domínio.
2. Ler, simultaneamente e sem ramificação de código, envelopes produzidos sob qualquer KID presente no Key Ring (exceto `Destroyed`).
3. Declarar uma chave `Retired` e, eventualmente, `Destroyed`, seguindo exatamente a máquina de estados formal do `ADR-E7-001 §8.3` (T1–T12), com a Convergence Attestation (`§13.3`) como pré-condição estrutural de `Destroyed`.
4. Reverter (rollback) uma promoção de KID a qualquer momento — inclusive tardiamente, após declaração de `Retired` (T5) — sem jamais perder capacidade de leitura de dado já persistido.
5. Convergir ciphertext de um KID antigo para o KID `Active` corrente, de forma oportunista e/ou administrativa, sem alterar Binding Context.

O resultado é uma capacidade de infraestrutura permanente, disponível para qualquer domínio presente ou futuro que use `encryptWithBindingContext`/`decryptWithBindingContext` — não uma rotação específica já executada.

## 2. Não objetivos

- **Não executa** uma rotação de chave em produção. Este plano entrega a capacidade; a decisão operacional de quando rotacionar é de produto/operação, fora deste documento.
- **Não decide** onde o registro de governança (declarações `Retired`, Convergence Attestations) é persistido — essa é uma decisão pontual de implementação, tomada em um checkpoint explícito antes da Fase 3 (§5), não neste documento.
- **Não altera** nenhuma API pública. `encrypt`, `decrypt`, `encryptWithBindingContext`, `decryptWithBindingContext`, `isLegacyFormat` permanecem com assinatura e contrato idênticos aos de `IMP-CRYPTO-001 §4.1`.
- **Não altera** `envelope.ts` — serialização canônica, AAD, Recognition Tree permanecem exatamente como estão desde a Phase 1 de `IMP-CRYPTO-001`.
- **Não altera** a classe `KeyRing` em `keyring.ts` — sua API (`resolve`, `getWriteKey`, `hasKID`, construtor com validação de `MULTIPLE_ACTIVE_KEYS`/`NO_ACTIVE_KEY`/`DUPLICATE_KID`) já satisfaz as invariantes I1–I14 e as transições T1–T4 do `ADR-E7-001 §8.3` sem modificação (ver §3, §4).
- **Não introduz** o estado `Retired` nem `Destroyed` como valores do tipo `KeyCapacity` de `keyring.ts`. Por decisão do próprio `ADR-E7-001 §8.1` ("`Retired` não é consultado por nenhuma lógica de decisão de leitura — é metadado de ciclo de vida, não um estado funcional"), `Retired` vive inteiramente fora do Key Ring, em uma camada de governança separada (Fase 3). `Destroyed` continua sendo, tecnicamente, a ausência de uma entrada na configuração do Key Ring — como já é hoje — gated por uma pré-condição procedural (Attestation) externa ao Key Ring.
- **Não migra** nenhum domínio existente (`whatsapp_config`, `ad_account_credentials`). RNF-1 do ADR garante zero impacto de call site — nenhuma migração de domínio é necessária nem produzida por este plano.
- **Não cria** nenhum ADR novo, nem reabre `ADR-E7-001`, `ADR-CRYPTO-001` ou `IMP-CRYPTO-001`.
- **Não propõe** migration de banco de dados nem schema concreto neste documento. Onde uma decisão de armazenamento é necessária (governança de `Retired`/Attestation, Inventário de Superfícies), este plano declara um checkpoint de decisão explícito em vez de prescrever um schema.

## 3. Baseline existente (componentes congelados)

Os componentes abaixo são tratados como **congelados** para todo este plano — nenhuma fase os reabre ou modifica além do estritamente delegado por `ADR-E7-001`:

| Componente | Estado congelado | O que este IMP pode tocar |
|---|---|---|
| `ADR-CRYPTO-001` | APPROVED FOR IMPLEMENTATION, v2.0 | Nada. Fonte de verdade para Envelope Format, KID, Key Ring (capacidades), Binding Context, I1–I14. |
| `IMP-CRYPTO-001` RC1.3 | Phases 1–3.2 encerradas; Implementation Completion Review fechada | Nada. Fonte de verdade para a API pública (`encrypt`/`decrypt`/`encryptWithBindingContext`/`decryptWithBindingContext`), pseudocódigo normativo §6.1 (AEAD), e o padrão de rollout em duas etapas que este plano reaplica (nunca reinventa). |
| `ADR-E7-001` RC1.1 | GO no Gate Arquitetural #2 | Nada. Fonte de verdade para a máquina de estados (T1–T12), Convergence Attestation, Inventário de Superfícies, restrição de família de algoritmo (AEAD). |
| `src/lib/crypto/envelope.ts` | Byte-idêntico desde `f3cf5a1` (Phase 1) | Nada. Nenhuma fase deste plano toca este arquivo. |
| `src/lib/crypto/keyring.ts` | Classe `KeyRing` e `createDefaultKeyRing()` | A **classe `KeyRing`** já implementa T1–T4 (RF-1/RF-2, I4) sem alteração necessária — ver §4.1. Apenas `createDefaultKeyRing()` (a função de fábrica que hoje hardcoda 3 KIDs fixos) é candidata a extensão controlada na Fase 1. |
| `src/lib/whatsapp/encryption.ts` | `encrypt`/`decrypt`/`isLegacyFormat` (par legado) + `encryptWithBindingContext`/`decryptWithBindingContext` | Nenhuma fase deste plano altera este arquivo. Ambos os pares já chamam `getWriteKey()`/`resolveKey()` exclusivamente — a fronteira que este plano usa, nunca contorna (RNF-1 do ADR). |

## 4. Modelo de implementação

### 4.1 O que já está pronto vs. o que continua sendo responsabilidade operacional

**O que a classe `KeyRing` existente já suporta — validação estrutural, não orquestração de transição:**
- aceita um array de `KeyMaterial` com capacidade `'Active' | 'DecryptOnly'`, validando corretamente qualquer estado individualmente alcançável por T1–T4;
- rejeita múltiplas entradas `Active` (`MULTIPLE_ACTIVE_KEYS`) e ausência de `Active` (`NO_ACTIVE_KEY`) na construção — garantindo I4 em todo `KeyRing` construído;
- rejeita KIDs duplicados (`DUPLICATE_KID`) — garantindo I3/I6;
- resolve qualquer KID presente via `resolve(kid)`, falha fechada (`UNKNOWN_KID`) para ausentes — garantindo I12.

Isso é validação de **estado**, não execução de **transição**. A classe não expõe (nem precisa expor) nenhum método de promoção/rebaixa — não há `promote()`/`demote()`. Cada instância de `KeyRing` é imutável desde a construção; ela apenas confirma que um determinado conjunto de entradas é internamente consistente (I3/I4/I6/I12), seja esse conjunto o "antes" ou o "depois" de uma rotação.

**O que continua sendo responsabilidade operacional — não coberto pela classe, não dispensado por este plano:**
- o rollout completo de um novo KID como `DecryptOnly` até 100% das instâncias em execução (`ADR-E7-001 §11`, etapa 2) — a classe não sabe, e não pode saber, se essa distribuição já ocorreu;
- a confirmação de que essa distribuição atingiu 100% antes de qualquer promoção — a pré-condição de T3, que é inteiramente um processo de deploy/observabilidade, nunca uma verificação em tempo de execução dentro do `KeyRing`;
- a promoção atômica em si (T3/T4): na prática, a substituição de uma instância de `KeyRing` por outra, reconstruída com as capacidades já trocadas, na inicialização de cada processo (`ADR-E7-001 §9`) — não uma mutação de uma instância existente;
- o rollback (reverter qual configuração está em uso) — mesmo mecanismo de reconstrução, na direção inversa.

A Fase 2 (§5) é responsável por essa orquestração operacional integralmente; nada nela está "já resolvido" pela existência da classe `KeyRing`.

**Conclusão de design:** a introdução de um segundo (ou N-ésimo) KID `Active`/`DecryptOnly` é, mecanicamente, apenas a construção de um `KeyRing` com mais entradas — e isso não exige nenhuma mudança na classe `KeyRing`. O único ponto de extensão de código é `createDefaultKeyRing()`, que hoje constrói exatamente 3 entradas fixas (`LEGACY_GCM`, `LEGACY_CBC`, `ACTIVE_V1`) a partir de uma única variável de ambiente. A disciplina de rollout e a orquestração da transição em si, por outro lado, não têm nenhum equivalente em código hoje e são inteiramente objeto da Fase 2.

### 4.2 Armazenamento de múltiplos KIDs

`createDefaultKeyRing()` passa a construir o array de `KeyMaterial` a partir de uma configuração extensível (mecanismo concreto — variável de ambiente estruturada, arquivo de configuração, ou outro — decisão de Fase 1, não deste nível de plano), em vez do conjunto fixo hardcoded. A forma final da configuração deve satisfazer, no mínimo:

- suportar um número arbitrário de entradas `DecryptOnly`;
- suportar exatamente uma entrada `Active` (validado pela própria classe `KeyRing`, já existente);
- preservar `LEGACY_GCM`/`LEGACY_CBC` como entradas sempre presentes e `DecryptOnly` (nunca removidas por este plano — `ADR-CRYPTO-001 §8.1`).

### 4.3 Seleção de chave de escrita

Inalterada. `getWriteKey()` continua retornando a única entrada `Active` — comportamento já implementado, exigido por T3/T4/RF-4/E7-ADR-003. Nenhuma fase deste plano toca essa função.

### 4.4 Resolução de chave de leitura

Inalterada. `resolveKey(kid)` continua resolvendo qualquer KID presente — comportamento já implementado, exigido por T3/T5/T6/T7/RF-3/E7-ADR-004. Nenhuma fase deste plano toca essa função.

### 4.5 Estados `Active`/`DecryptOnly`/`Retired`/`Destroyed`

| Estado | Onde vive tecnicamente | Fase que o introduz |
|---|---|---|
| `Active` | `KeyCapacity` em `keyring.ts` (já existe) | — (baseline) |
| `DecryptOnly` | `KeyCapacity` em `keyring.ts` (já existe) | — (baseline) |
| `Retired` | **Fora de `keyring.ts`** — camada de governança nova, puramente declarativa (`ADR-E7-001 §8.1`: capacidade tecnicamente idêntica a `DecryptOnly`) | Fase 3 |
| `Destroyed` | Ausência da entrada na configuração do Key Ring (já é assim hoje, implicitamente) + Convergence Attestation como pré-condição procedural externa | Fase 5 |

Nenhum novo valor é adicionado ao tipo `KeyCapacity`. Isso não é uma simplificação indevida do modelo do ADR — é a leitura correta de `§8.0`/`§8.1`: como `Retired` e `DecryptOnly` são tecnicamente idênticos, e `Destroyed` já é observável hoje como "KID ausente", a máquina de estados de quatro estados do ADR mapeia para dois níveis técnicos (`presente` / `ausente`) mais uma camada declarativa de governança — exatamente como o ADR já descreve em §8.1 ("existem, na prática, apenas dois níveis de capacidade").

## 5. Sequência de fases

Cada fase é pequena, auditável, e não avança para a próxima sem seus critérios de aceite satisfeitos e testes obrigatórios verdes.

### Fase 1 — Key Ring configurável (fundação, sem mudança de comportamento)

- **Objetivo:** tornar `createDefaultKeyRing()` capaz de construir um `KeyRing` com um número arbitrário de KIDs, preservando exatamente o comportamento atual quando nenhum KID adicional é configurado.
- **Arquivos esperados:** `src/lib/crypto/keyring.ts` (apenas a função de fábrica).
- **Mudanças permitidas:** extensão da lógica de construção de `createDefaultKeyRing()`; nenhuma mudança na classe `KeyRing`; nenhuma mudança de assinatura pública.
- **Mudanças proibidas:** alterar `resolve()`, `getWriteKey()`, `hasKID()`; alterar `envelope.ts`; alterar `encryption.ts`; alterar qualquer domínio consumidor; introduzir `'Retired'`/`'Destroyed'` em `KeyCapacity`.
- **Testes obrigatórios:** comportamento atual (3 KIDs fixos) preservado byte a byte quando nenhuma configuração adicional é fornecida; construção com um 4º KID de teste (`DecryptOnly`) resolve corretamente; construção com um 4º KID de teste promovido a `Active` (e `ACTIVE_V1` rebaixada) resolve corretamente; nenhuma regressão em `keyring.test.ts`/`encryption.test.ts`/`canonical-fixtures.test.ts` existentes.
- **Critério de aceite:** é possível, em ambiente de teste, construir um `KeyRing` com mais de um KID `DecryptOnly` além dos dois legados, sem qualquer alteração em `encryption.ts` ou em qualquer call site.

### Fase 2 — Processo de rotação (rollout completo, ambiente controlado)

- **Objetivo:** exercitar de ponta a ponta o processo do `ADR-E7-001 §11` (T1 → T3/T4) em ambiente de teste/staging: provisionamento, introdução como `DecryptOnly`, confirmação de rollout, promoção atômica.
- **Arquivos esperados:** nenhum arquivo de código de aplicação (a Fase 1 já entregou a capacidade). Este é um exercício operacional/de configuração, com testes de integração que o simulam.
- **Mudanças permitidas:** teste de integração que simula as etapas 1–4 do `ADR-E7-001 §11`; documentação operacional de como confirmar 100% de rollout (reaplicando o mesmo padrão já usado para `FLAG_CANONICAL_WRITE_<DOMAIN>` em `IMP-CRYPTO-001 §6`).
- **Mudanças proibidas:** qualquer atalho que promova um KID a `Active` sem a pré-condição de 100% de rollout como `DecryptOnly` (violaria T3); qualquer alteração de call site de domínio.
- **Testes obrigatórios:** simulação de rollout parcial (KID novo presente em algumas "instâncias" simuladas, ausente em outras) confirma `UNKNOWN_KID` apenas nas instâncias desatualizadas — nunca corrompe dado, nunca falha silenciosamente; após rollout completo simulado, leitura de dado gravado sob o KID antigo e sob o novo funciona identicamente, sem branch de código (RNF-1); rollback (§12 do ADR) simulado — reverter a promoção não afeta legibilidade de nenhum dado.
- **Critério de aceite:** um teste de integração automatizado reproduz uma rotação completa (T1→T3/T4) e um rollback, ambos sem tocar `encryption.ts` nem nenhum domínio.

### Fase 3 — Governança: `Retired` e reversões (T5, T6, T7)

**Checkpoint obrigatório antes desta fase (decisão de implementação, não de arquitetura):** definir onde o registro de declarações `Retired`/reversões é persistido. Esta decisão é pontual e local a esta fase — análoga ao checkpoint pré-Fase-3 de `IMP-CRYPTO-001 RC1.3 §0.3` (fórmula de Binding Context) — e não reabre `ADR-E7-001`. Nenhuma migration é proposta neste documento; a decisão de armazenamento concreta é produzida como parte da execução desta fase, não antes dela.

- **Objetivo:** implementar o registro de eventos `Retired` (T6), sua reversão (T7) e a reativação (T5), como camada de governança **externa** ao Key Ring — nunca consultada por `resolveKey()`/`getWriteKey()`.
- **Arquivos esperados:** novo módulo de governança (local e nome definidos no checkpoint acima); nenhuma alteração em `keyring.ts`, `envelope.ts` ou `encryption.ts`.
- **Mudanças permitidas:** registro append-only de eventos de ciclo de vida (KID, evento, timestamp, ator) — RNF-5 (auditabilidade); leitura desse registro para fins de relatório/auditoria.
- **Mudanças proibidas:** qualquer condicional em `resolveKey()`/`getWriteKey()` baseada em `Retired` (violaria §8.0 do ADR — capacidade técnica idêntica a `DecryptOnly`); qualquer schema de banco criado sem o checkpoint acima ter sido explicitamente concluído.
- **Testes obrigatórios:** declarar um KID `Retired` não altera nenhum resultado observável de `decryptWithBindingContext()` para dados sob esse KID (antes/depois idênticos); reversão (T7) e reativação (T5, incluindo o cenário de rollback tardio do `ADR-E7-001 §12`) preservam leitura idêntica; o registro de governança é consultável independentemente do estado do Key Ring.
- **Critério de aceite:** um KID declarado `Retired` continua decifrando dados de teste de ponta a ponta, exatamente como antes da declaração; a reativação (T5) restaura a capacidade de escrita sem qualquer efeito colateral em outros KIDs.

### Fase 4 — Convergência e Inventário de Superfícies de Ciphertext

- **Objetivo:** implementar as duas estratégias de convergência reconhecidas pelo `ADR-E7-001 §13.2` (preguiçosa e administrativa) para pelo menos um domínio, e formalizar o Inventário de Superfícies de Ciphertext (`§13.1`) como artefato mantido.
- **Arquivos esperados:** extensão do padrão de self-heal já existente (`IMP-CRYPTO-001` Phase 2/3.2 — ex. `webhook/route.ts`, `send/route.ts`, `config/route.ts`) para também convergir KID-antigo→KID-corrente, não apenas legado→canônico; novo artefato de Inventário (formato definido na execução da fase, cobrindo no mínimo as superfícies já enumeradas no `ADR-E7-001 §13.1`: tabelas primárias, filas/retries, DLQ, jobs assíncronos, snapshots/backups).
- **Mudanças permitidas:** extensão do self-heal existente; criação/manutenção do Inventário como artefato de documentação/configuração viva.
- **Mudanças proibidas:** qualquer alteração do Binding Context de um registro durante convergência (`§13.2` do ADR, obrigatório); tornar convergência uma pré-condição bloqueante de qualquer leitura (deve permanecer sempre best-effort/assíncrona, RNF-2).
- **Testes obrigatórios:** convergência preguiçosa preserva plaintext e Binding Context idênticos antes/depois; uma varredura administrativa de teste cobre 100% de uma tabela de teste; o Inventário lista corretamente todas as superfícies conhecidas no momento da execução da fase.
- **Critério de aceite:** pelo menos um domínio demonstra, em ambiente de teste, convergência de um ciphertext do KID N-1 para o KID N sem intervenção manual por registro individual.

### Fase 5 — `Destroyed`: Convergence Attestation e transição terminal

- **Objetivo:** implementar a Convergence Attestation (`ADR-E7-001 §13.3`) como pré-condição estrutural de T8, e a transição `Retired → Destroyed`.
- **Arquivos esperados:** extensão do módulo de governança da Fase 3 com o registro de Attestation. Nenhuma remoção de código do Key Ring — "destruir" continua sendo remover a entrada da configuração ativa, já suportado desde sempre.
- **Mudanças permitidas:** emissão de Attestation vinculada a KID + versão do Inventário (Fase 4), satisfazendo as 4 propriedades do `ADR-E7-001 §13.3` (persistência independente, vínculo a KID+inventário, distinguibilidade obrigatória, imutabilidade); um mecanismo de validação (concreto, definido na execução da fase) que recusa remover um KID da configuração sem Attestation correspondente.
- **Mudanças proibidas:** qualquer transição que pule `Retired` (T11, proibida pelo ADR); remoção de configuração de um KID sem Attestation válida.
- **Testes obrigatórios:** tentativa de remover um KID sem Attestation é recusada pelo mecanismo de validação; com Attestation válida, o KID passa a produzir `UNKNOWN_KID` e nenhum outro KID é afetado; uma Attestation sem vínculo a uma versão do Inventário é rejeitada como inválida (`§13.3` item 2).
- **Critério de aceite:** um KID de teste, com Attestation emitida e validada, transiciona para `Destroyed` sem afetar nenhum outro KID nem nenhum domínio; uma tentativa de "destruir" um KID sem Attestation é estruturalmente impedida, não apenas desaconselhada.

## 6. Rollout

| Etapa do `ADR-E7-001` | Fase deste IMP | Observação |
|---|---|---|
| Adicionar nova chave (T1) | Fase 1 (capacidade) + Fase 2 (execução) | Key Ring já suporta N `DecryptOnly`; Fase 1 só remove o hardcode de 3 entradas fixas |
| Distribuição (100% rollout como `DecryptOnly`) | Fase 2 | Reaplica o mesmo padrão de confirmação de rollout de `IMP-CRYPTO-001 §6` |
| Leitura com múltiplas versões | Já funciona hoje — `resolveKey()` não muda | Verificado nas Fases 1 e 2 via teste, não implementado de novo |
| Ativação de escrita (promoção T3/T4) | Fase 2 | Substituição atômica de configuração, nunca mutação incremental em memória |
| Convergência | Fase 4 | Estende o self-heal já existente; nunca obrigatória, nunca bloqueante |
| Attestation | Fase 5 | Pré-condição estrutural de `Destroyed`; checkpoint de armazenamento resolvido no início da Fase 3 (compartilhado com o registro de `Retired`) |
| `Destroyed` | Fase 5 | KID removido da configuração ativa, gated por Attestation válida |

## 7. Compatibilidade

- **Envelopes existentes continuam lendo.** Nenhuma fase altera `envelope.ts`, o Recognition Tree, ou o formato do envelope canônico. Todo ciphertext já persistido sob `LEGACY_GCM`, `LEGACY_CBC` ou `ACTIVE_V1` permanece decifrável exatamente como hoje, em todas as 5 fases.
- **Binding Context permanece igual.** Nenhuma fase toca `buildAAD()` nem qualquer chamador de `encryptWithBindingContext`/`decryptWithBindingContext`. A Fase 4 (convergência) reforça explicitamente a proibição de alterar Binding Context durante reescrita.
- **Call sites não conhecem versionamento.** Em nenhuma fase um domínio (`whatsapp_config`, `ad_account_credentials`, ou futuro) recebe, aceita ou precisa inspecionar KID, versão ou capacidade — a fronteira `getWriteKey()`/`resolveKey()` absorve tudo, exatamente como já ocorre hoje.
- **Nenhum domínio precisa migrar manualmente.** Uma vez que a Fase 1 e a Fase 2 estejam concluídas, qualquer rotação futura é transparente para todo domínio já cutover — não há uma "migração de domínio para E7" análoga à migração de domínio para Binding Context feita em `IMP-CRYPTO-001` Phase 3.1/3.2. RNF-1 do ADR é a garantia; este plano não introduz nenhuma exceção a ela.

## 8. Testes obrigatórios

Lista consolidada — cada item mapeado à fase onde é introduzido, mas todos devem permanecer verdes em toda fase subsequente (regressão contínua):

| Teste | Fase de origem | Cobre |
|---|---|---|
| Coexistência de ≥3 KIDs simultâneos (2 legados + 1 novo) | Fase 1 | RF-1, I3 |
| Decrypt com chave antiga após promoção de uma nova | Fase 2 | T4, RNF-1 |
| Encrypt com nova chave após promoção | Fase 2 | T3, RF-4 |
| Rollback (reversão de promoção, dado já emitido permanece legível) | Fase 2 | RF-8, §12 do ADR |
| Leitura de dado sob KID `Retired` (idêntica a `DecryptOnly`) | Fase 3 | §8.0 do ADR — não regressão do achado C1 |
| Rollback tardio (reativação T5 após `Retired`) | Fase 3 | T5, cenário de rollback tardio do §12 |
| Rejeição de `Destroyed` sem Convergence Attestation | Fase 5 | T8, T11, §13.3 |
| Convergence Attestation vinculada a KID + versão de Inventário | Fase 5 | §13.3 item 2 |
| Múltiplas rotações consecutivas (v1→v2→v3→v4) sem crescimento de complexidade em `resolveKey()` | Fase 2 (regressão obrigatória a cada fase subsequente) | RNF-4, "Futuras rotações" do Gate #1 (objetivo 10) |
| Corpus de fixtures congeladas (`canonical-fixtures.test.ts`, já existente) permanece decifrável após toda fase | Todas | Backstop de fix-forward, `IMP-CRYPTO-001 §12.2`/§7.1 |

## 9. Riscos

Herdados exclusivamente do `ADR-E7-001 §22` — nenhum risco novo introduzido por este plano de implementação:

| Risco (ADR) | Fase mais exposta | Mitigação neste IMP |
|---|---|---|
| RE-1 — Rollout de leitura incompleto antes de promoção | Fase 2 | Teste obrigatório de rollout parcial simulado (§5, Fase 2) |
| RE-2 — Declaração prematura de `Destroyed` | Fase 5 | Attestation estrutural obrigatória (§5, Fase 5); teste de rejeição sem Attestation |
| RE-3 — Acúmulo indefinido de KIDs `Retired` nunca `Destroyed` | Fase 3/5 | Fora do escopo deste plano mitigar a cadência operacional — o ADR já defere isso a decisão futura; este IMP só garante que a transição para `Destroyed` está disponível quando decidida |
| RE-4 — Confusão entre rotação e cutover de domínio | Todas | Nenhuma fase deste plano introduz acoplamento entre `FLAG_CANONICAL_WRITE_<DOMAIN>` e qualquer mecanismo de rotação — verificado em cada fase como critério de "mudanças proibidas" |
| RE-5 — Primeira rotação real nunca exercitada antes de necessária | Fase 2 | A Fase 2 entrega o exercício de rotação em ambiente de teste/staging como parte de seus critérios de aceite — não substitui uma decisão futura de executar em produção, mas reduz o risco de a primeira execução real ser também a primeira execução observada |

## 10. Critérios de conclusão

E7 é considerado **terminado** (capacidade entregue, não uma rotação específica executada) quando:

1. Todas as 5 fases (§5) têm seus critérios de aceite satisfeitos e testes obrigatórios (§8) verdes, sem regressão em nenhuma suíte pré-existente (`envelope.test.ts`, `keyring.test.ts`, `encryption.test.ts`, `canonical-fixtures.test.ts`, e toda a suíte de domínio de `IMP-CRYPTO-001`).
2. Uma rotação completa (T1→T3/T4), um rollback, uma declaração `Retired` com reversão, e uma transição `Destroyed` gated por Attestation foram todos demonstrados de ponta a ponta em ambiente de teste/staging — não apenas unitariamente.
3. Nenhuma alteração foi feita em `envelope.ts`, na API pública de `encryption.ts`, ou em qualquer call site de domínio, em nenhuma fase — verificável por diff.
4. O checkpoint de decisão de armazenamento de governança (Fase 3) foi concluído e documentado, sem ter reaberto `ADR-E7-001`.
5. `tsc --noEmit` limpo e suíte completa verde a cada fase, seguindo o mesmo gate de CI já em uso (`IMP-CRYPTO-001 §7.6`).

A execução de uma rotação real em produção, a cadência de convergência/retirada de chaves antigas, e a decisão de quando exercitar `Destroyed` pela primeira vez permanecem decisões operacionais posteriores a este IMP — não critérios de conclusão dele.

---

*Fim do documento. Plano de implementação apenas — nenhuma decisão arquitetural nova, nenhum código, nenhuma migration produzidos. Pronto para Gate de Implementation Plan.*
