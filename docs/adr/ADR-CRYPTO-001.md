# ADR-CRYPTO-001 — Cryptographic Envelope Contract

**Versão:** 2.0
**Status:** APPROVED FOR IMPLEMENTATION
**Tipo:** Architecture Decision Record
**Owner:** Platform Architecture
**Relacionado a:** ADR-ATTR-001, ADR-ATTR-002, E6.0
**Pré-requisito para:** ADR-E7-001 (Encryption Key Rotation)

---

## 1. Objetivo

Este ADR define o contrato criptográfico permanente da plataforma ForceCRM.

Seu propósito é estabelecer como dados criptografados são representados, autenticados, identificados e resolvidos, independentemente da tecnologia de gerenciamento de chaves adotada no futuro.

Este documento define exclusivamente a camada criptográfica.

Não define:
- rotação;
- convergência;
- rollback;
- migração;
- KMS;
- HSM;
- BYOK.

---

## 2. Princípios Arquiteturais

### P1. Envelope Autodescritivo

Todo artefato criptográfico deve conter todas as informações necessárias para sua interpretação criptográfica.

A resolução nunca dependerá de inferência baseada em configuração externa.

### P2. Resolução Determinística

A chave de descriptografia deve ser conhecida antes da tentativa de descriptografia.

É proibido:
- tentativa sequencial de múltiplas chaves;
- brute force sobre o Key Ring;
- fallback implícito.

Unknown KID resulta em falha fechada.

### P3. Encapsulamento

Consumidores nunca manipulam:
- algoritmo;
- versão;
- KID;
- nonce;
- authentication tag;
- serialização do envelope.

Consumidores apenas transportam um token opaco.

### P4. Evolução Compatível

Novas versões do envelope poderão coexistir com versões anteriores.

Versões desconhecidas devem falhar de forma fechada.

Nunca haverá interpretação heurística.

---

## 3. Crypto Envelope

O Crypto Envelope é a unidade lógica persistida.

Seu formato lógico é composto pelos seguintes campos obrigatórios:

| Campo | Obrigatório |
|---|---|
| Envelope Version | Sim |
| Key Identifier (KID) | Sim |
| Algorithm Identifier | Sim |
| Nonce / IV | Sim |
| Ciphertext | Sim |
| Authentication Tag | Sim |

---

### 3.1 Canonical Serialization

Todo envelope canônico possui uma representação binária única, independente de linguagem ou plataforma.

Implementações independentes DEVEM produzir exatamente os mesmos bytes para os mesmos valores lógicos.

A serialização é parte do contrato.

#### 3.1.1 Formato

O envelope canônico é serializado como uma sequência de campos com prefixo de comprimento, na ordem fixa abaixo.

Todos os inteiros estão em network byte order (big-endian).

| Ordem | Campo | Codificação |
|-------|-------|-------------|
| 1 | Envelope Version | 1 byte (`uint8`) |
| 2 | KID | 2 bytes (`uint16`) de comprimento + N bytes UTF-8 |
| 3 | Algorithm Identifier | 2 bytes (`uint16`) de comprimento + N bytes UTF-8 |
| 4 | Nonce / IV | 1 byte (`uint8`) de comprimento + N bytes |
| 5 | Ciphertext | 4 bytes (`uint32`) de comprimento + N bytes |
| 6 | Authentication Tag | 1 byte (`uint8`) de comprimento + N bytes |

#### 3.1.2 Propriedades

- **Determinística:** mesmos campos lógicos produzem os mesmos bytes, independentemente da implementação.
- **Auto delimitada:** cada campo é parseável individualmente via prefixo de comprimento.
- **Injetiva:** a serialização é bijetiva no conjunto de envelopes válidos — dois envelopes distintos nunca possuem a mesma representação canônica.
- **Extensível:** versões futuras do envelope podem introduzir novos campos ao final da sequência, preservando compatibilidade com parsers capazes de ignorar campos desconhecidos.

#### 3.1.3 AAD Canônico

O Additional Authenticated Data (AAD) do AES-GCM é construído a partir da serialização canônica dos campos do cabeçalho, acrescidos do Binding Context:

```
AAD_bytes =
    Serialized(Envelope Version)     -- 1 byte, o próprio valor
    || Serialized(KID)               -- [2B len][valor]
    || Serialized(Algorithm ID)      -- [2B len][valor]
    || Serialized(Nonce / IV)        -- [1B len][valor]
    || Serialized(Binding Context)   -- [2B len][valor]
```

Onde `Serialized(campo)` segue exatamente a codificação da tabela na Seção 3.1.1.

A ordem dos campos no AAD é idêntica à ordem no envelope, com o Binding Context ao final.

Esta construção garante que duas implementações independentes produzam o mesmo AAD para os mesmos valores de cabeçalho e Binding Context.

#### 3.1.4 Disjunção com Formatos Legados

O primeiro byte da serialização canônica (Envelope Version = `0x01` para a versão 1) é mutuamente exclusivo com os primeiros bytes dos formatos legados definidos na Seção 8.

A função de reconhecimento entre formatos (Seção 8.3) deve ser consultada antes de qualquer tentativa de parsing como envelope canônico — um envelope cujo primeiro byte seja `0x01` é canônico; um envelope cujo primeiro byte esteja no intervalo hexadecimal ASCII é legado. Esta precedência é normativa.

---

### 3.2 Header Authentication

O cabeçalho inteiro do envelope faz parte obrigatória do AAD.

O AAD canônico (conforme Seção 3.1.3) inclui:

- Envelope Version
- KID
- Algorithm Identifier
- Nonce / IV
- Binding Context

Qualquer alteração em qualquer desses campos invalida a Authentication Tag.

Portanto:
- não existe troca de algoritmo;
- não existe troca de versão;
- não existe troca de KID;
- não existe troca de nonce;
- não existe substituição de Binding Context;
- sem detecção criptográfica.

AAD deixa de ser opcional.

Passa a ser requisito fundamental do contrato.

Exceção: envelopes legados (anteriores a este contrato) não possuem AAD. Ver Seção 8.

---

## 4. Key Identifier (KID)

O KID identifica unicamente o mecanismo criptográfico responsável pela resolução do envelope.

Características:
- opaco para consumidores;
- imutável;
- permanente;
- nunca reutilizado;
- globalmente único.

Cada KID é globalmente único. Não existem dois KIDs distintos que referenciem o mesmo material criptográfico, nem o mesmo KID em dois contextos diferentes.

A resolução KID → Material Criptográfico é direta: dado o KID, o Key Ring produz o material criptográfico correspondente. Não existe etapa intermediária de resolução por escopo (Key Ring, tenant, ou outro).

KID → Material Criptográfico é uma função total e determinística dentro do Key Ring.

A semântica de resolução permanece inalterada para qualquer estratégia futura de provisionamento de chaves: o KID é sempre o identificador direto do material criptográfico.

---

### 4.1 Geração

O mecanismo de geração deve garantir unicidade sem coordenação distribuída.

Após aposentado, um KID jamais poderá ser reutilizado.

---

## 5. Key Ring

O Key Ring é a autoridade de resolução criptográfica: implementa a função total KID → Material Criptográfico para todo KID conhecido.

Cada Key Ring possui exatamente uma chave de escrita.

Pode possuir múltiplas chaves de leitura.

---

### 5.1 Capacidades

| Estado | Read | Write |
|--------|------|-------|
| Active | ✔ | ✔ |
| DecryptOnly | ✔ | ✖ |
| Retired | ✖ | ✖ |
| Destroyed | ✖ | ✖ |

Este ADR define apenas as capacidades.

As transições entre estados pertencem ao ADR-E7-001.

---

## 6. Algoritmos

Cada chave possui exatamente um algoritmo associado.

O algoritmo faz parte da identidade da chave.

O campo Algorithm Identifier do envelope deve corresponder exatamente ao algoritmo registrado para o KID.

Qualquer divergência resulta em falha fechada.

---

## 7. Binding Context

O Binding Context é um identificador canônico do recurso protegido, utilizado para vincular criptograficamente o ciphertext ao seu contexto lógico.

### 7.1 Representação Canônica

O Binding Context é uma sequência opaca de bytes, semânticamente opaca para consumidores de domínio.

Sua representação canônica na serialização é:

- **Prefixo de comprimento:** 2 bytes, `uint16` big-endian (máximo 65535).
- **Valor:** bytes opacos.

A representação completa no AAD é: `[2 bytes length][N bytes value]`.

### 7.2 Obrigatoriedade

O Binding Context é **obrigatório** em toda operação de `encrypt` de envelope canônico e **deve** ser fornecido pela infraestrutura da plataforma.

Consumidores de domínio nunca constroem, interpretam ou inspecionam o Binding Context.

O Binding Context é **verificado** em toda operação de `decrypt` de envelope canônico através do AAD: qualquer divergência entre o Binding Context do `encrypt` e o do `decrypt` resulta em falha de autenticação (tag mismatch).

Para envelopes legados, o Binding Context é aceito mas **não verificado** criptograficamente (ver Seção 8).

### 7.3 Participação no AAD

O Binding Context ocupa a posição final na construção do AAD canônico:

```
AAD_bytes = Serialized(Version) || Serialized(KID) || Serialized(Algorithm) || Serialized(Nonce) || Serialized(BindingContext)
```

Esta posição final garante que:
- a substituição de envelopes entre recursos distintos é detectada;
- a implementação pode computar o AAD incrementalmente, pois o Binding Context é conhecido apenas no momento da operação.

### 7.4 Binding Context Vazio

Binding Context de comprimento zero (vazio) é permitido e representa a ausência de vínculo com recurso específico.

Neste caso, o AAD é composto exclusivamente pelo cabeçalho serializado, e a proteção contra substituição entre recursos não se aplica.

Binding Context vazio não é equivalente a omitir o Binding Context: a serialização canônica do AAD inclui o prefixo de comprimento zero (`[0x00, 0x00]`), preservando a estrutura canônica.

---

## 8. Legacy Compatibility

Todo envelope produzido antes da adoção deste contrato pertence ao perfil Legacy.

O perfil Legacy é definido formalmente com KIDs explícitos, regras determinísticas de reconhecimento, resolução e autenticação.

### 8.1 Legacy KIDs

O perfil Legacy define dois KIDs sentinela reservados, um para cada algoritmo legado reconhecido:

| KID | Algorithm Identifier | Capacidade |
|-----|---------------------|------------|
| `LEGACY_GCM` | `AES-256-GCM` | DecryptOnly |
| `LEGACY_CBC` | `AES-256-CBC` | DecryptOnly |

Cada KID obedece integralmente ao contrato global (I2, I6, I9): KID → material criptográfico → algoritmo único. Nenhuma exceção aos invariantes é criada.

Inicialmente, ambos os KIDs resolvem para o mesmo material criptográfico subjacente (a chave única anterior ao E7). Cada KID, no entanto, mantém identidade independente no Key Ring, permitindo rotação futura distinta por algoritmo. A independência de identidade é condição necessária para que a evolução futura (rotação, substituição de algoritmo) possa tratar cada KID separadamente sem redefinir o contrato.

Estes KIDs são conhecidos a priori pela plataforma e devem permanecer no Key Ring enquanto existirem envelopes legados pendentes de migração.

### 8.2 Legacy Envelope Formats

O envelope legado é textual, não binário:

| Algoritmo | Formato |
|-----------|---------|
| AES-256-GCM | `<iv-hex>:<ct-hex>:<tag-hex>` |
| AES-256-CBC | `<iv-hex>:<ct-hex>` |

Onde cada componente é codificado em hexadecimal minúsculo, sem padding.

### 8.3 Função de Reconhecimento (Recognition Tree)

A determinação do formato de um ciphertext persistido segue uma árvore determinística de três níveis, aplicada na seguinte ordem:

**1. Tentativa de envelope canônico.**
Se o primeiro byte do ciphertext persistido for igual a `0x01` (Envelope Version = 1), o envelope é **canônico** e deve ser processado exclusivamente conforme Seção 3.1. Se o parsing canônico falhar (cabeçalho inválido, campos corrompidos, tag inválida), o resultado é **Invalid Envelope** — nunca há fallback para formato legado.

**2. Reconhecimento de formatos Legacy explicitamente suportados.**
Se o primeiro byte NÃO for `0x01`, o sistema deve verificar os padrões legados na seguinte ordem:
- Padrão `<iv-hex>:<ct-hex>:<tag-hex>` (duas seções `:`) → **Legacy GCM**.
- Padrão `<iv-hex>:<ct-hex>` (uma seção `:`) → **Legacy CBC**.

Cada seção hexadecimal deve conter exclusivamente caracteres hexadecimais (`0-9`, `a-f`, `A-F`). Caracteres maiúsculos (`A-F`) devem ser normalizados para minúsculos antes da validação do padrão. A contagem de seções separadas por `:` é a propriedade observável que determina o formato.

**3. Falha fechada.**
Se o primeiro byte não for `0x01` e nenhum padrão legado for reconhecido → **Invalid Envelope** → falha fechada (I10, I12).

**Restrição normativa de precedência:** a tentativa de formato canônico (nível 1) tem precedência absoluta sobre o reconhecimento legado (nível 2). Implementações que invertam a ordem ou apliquem reconhecimento paralelo violam o contrato.

### 8.4 Disjunção entre Serialização Canônica e Formatos Legacy

A distinção entre as classes de formato no primeiro byte é garantida por disjunção de intervalos:

- Canônico v1: primeiro byte `0x01`.
- Legacy: primeiro byte sempre um caractere hexadecimal minúsculo (`0x30`–`0x39` dígitos, `0x61`–`0x66` letras `a`–`f`).

Os intervalos são mutuamente exclusivos. Esta disjunção é parte do contrato:

> Versões futuras do envelope canônico JAMAIS utilizarão bytes de versão que colidam com o intervalo hexadecimal ASCII (`0x30`–`0x39`, `0x61`–`0x66`), nem com bytes de versão de versões anteriores do formato canônico.

### 8.5 Resolução

| Formato detectado | KID | Algorithm Identifier |
|-------------------|-----|---------------------|
| Legacy GCM (`iv:ct:tag`) | `LEGACY_GCM` | `AES-256-GCM` |
| Legacy CBC (`iv:ct`) | `LEGACY_CBC` | `AES-256-CBC` |

A resolução é determinística e não-heurística: o padrão observável (contagem de seções `:`) determina univocamente o KID, e o KID determina univocamente o algoritmo (I9).

### 8.6 Regime de Autenticação

Envelopes legados foram cifrados **sem** a proteção de AAD canônico definido neste contrato.

O contrato reconhece esta limitação arquitetural e estabelece regime dual:

- **Envelopes canônicos:** AAD obrigatório (cabeçalho + Binding Context), conforme Seções 3.1.3 e 3.2.
- **Envelopes legados:** autenticados exclusivamente via Authentication Tag GCM (para `LEGACY_GCM`) ou via mecanismo original CBC (para `LEGACY_CBC`). AAD não é verificado para envelopes legados.

Esta assimetria é um fato arquitetural da migração. A proteção completa por AAD para dados legados será alcançada quando o dado for recifrado (lazy migration ou processo administrativo de convergência).

### 8.7 Binding Context em Envelopes Legados

A operação `decrypt` de um envelope legado **aceita** o Binding Context fornecido, mas **não o verifica** criptograficamente, pois o envelope original não incluiu AAD.

A verificação de binding para dados legados é uma limitação conhecida e documentada. Consumidores que exigem garantia de binding devem assegurar que os dados estejam no formato canônico (recifrados).

---

## 9. Contrato Público

Consumidores recebem apenas duas operações:

```
encrypt(data, bindingContext)
decrypt(token, bindingContext)
```

Onde:
- `token` é um envelope opaco;
- `bindingContext` é fornecido pela infraestrutura, não interpretado pelo domínio.

Consumidores:
- nunca parseiam o envelope;
- nunca restringem seu tamanho;
- nunca dependem de seu formato interno.

---

## 10. Invariantes

### I1

Todo envelope possui exatamente um KID.

### I2

Todo KID referencia exatamente um material criptográfico.

### I3

Todo KID é globalmente único e pertence exatamente a um Key Ring.

A função KID → Material Criptográfico é total e determinística no contexto de um Key Ring. Não existe resolução por escopo intermediário.

### I4

Existe exatamente uma chave Active por Key Ring.

### I5

Toda chave Active também é válida para leitura.

### I6

Nenhum KID poderá ser reutilizado.

### I7

Uma chave somente poderá transitar para Destroyed após comprovação de inexistência de envelopes persistidos que ainda dependam dela.

A verificação desse pré-requisito pertence ao ADR-E7-001.

### I8

Todo envelope canônico e todo envelope Legacy GCM contém Authentication Tag.

Toda operação de descriptografia desses envelopes deve verificar obrigatoriamente essa tag.

Envelopes Legacy CBC (`iv:ct`) não possuem Authentication Tag. Operam sob regime de autenticação reduzido (mecanismo original CBC, conforme Seção 8.6). A ausência de tag neste formato é um fato arquitetural da migração, não uma violação de I8.

Falhas de verificação de tag resultam em erro irrecuperável.

### I9

O algoritmo do envelope deve coincidir exatamente com o algoritmo do KID.

### I10

Envelope Version desconhecida resulta em falha fechada.

### I11

Algorithm Identifier desconhecido resulta em falha fechada.

### I12

Unknown KID resulta em falha fechada.

### I13 — Unicidade de Nonce/IV

Para cada KID, todas as operações de `encrypt` produzem Nonces/IVs distintos.

Esta é uma propriedade contratual obrigatória. A implementação é livre para determinar o mecanismo de geração (contador monotônico, geração aleatória com verificação, ou outro), desde que a unicidade do par (KID, Nonce/IV) seja garantida durante todo o ciclo de vida operacional do KID.

A violação desta invariante compromete a segurança do AES-GCM e constitui falha crítica de segurança.

### I14

O AAD deve ser exatamente a serialização canônica definida na Seção 3.1.3, contendo:

- Envelope Version
- KID
- Algorithm Identifier
- Nonce/IV
- Binding Context

---

## 11. Segurança

Este contrato protege contra:
- key confusion;
- algorithm confusion;
- downgrade;
- envelope tampering;
- substituição entre recursos protegidos;
- fallback implícito;
- brute force de resolução.

Metadados (Version, KID e Algorithm Identifier) permanecem em claro por definição do envelope autodescritivo, mas devem ser semanticamente opacos para consumidores e nunca codificar informações de tenant, ambiente ou domínio de negócio.

A assimetria de segurança entre envelopes canônicos (com AAD) e envelopes legados (sem AAD) é um risco aceito documentado. Envelopes legados permanecem autenticados via Authentication Tag (GCM) ou mecanismo CBC original; a proteção adicional por Binding Context aplica-se exclusivamente a envelopes canônicos.

---

## 12. Evolução

O contrato permite evolução futura para:
- KMS;
- HSM;
- BYOK;
- DEK/KEK.

Essas evoluções não alteram a interface pública da camada criptográfica.

Caso uma futura versão utilize material adicional (como uma DEK encapsulada), esse material será incorporado ao envelope por meio do mecanismo de versionamento, preservando a semântica do KID como identificador do mecanismo primário de resolução criptográfica.

---

## 13. Fora do Escopo

Este ADR não define:
- rotação;
- rollback;
- convergência;
- batch migration;
- lazy migration;
- governança operacional de chaves;
- políticas de rotação;
- KMS;
- HSM;
- BYOK.

Esses temas pertencem ao ADR-E7-001 ou a ADRs futuros.

---

## 14. Critérios de Aceitação

O contrato será considerado implementável quando:

1. Todo envelope canônico produzido a partir deste contrato utilizar a serialização canônica definida na Seção 3.1. Envelopes legados são regidos por formato próprio (Seção 8) e não precisam ser recifrados.
2. Todo cabeçalho de envelope canônico estiver autenticado via AAD (Seções 3.1.3 e 3.2).
3. Toda resolução ocorrer exclusivamente por KID. Legacy KIDs (`LEGACY_GCM`, `LEGACY_CBC`) são resolvidos deterministicamente conforme Seção 8.5.
4. Unknown Version, Unknown KID e Unknown Algorithm resultarem em falha fechada.
5. Cada Key Ring possuir exatamente uma chave Active para escrita.
6. Consumidores permanecerem totalmente desacoplados da representação criptográfica.
7. O Binding Context impedir substituição válida entre recursos distintos para envelopes canônicos.
8. A camada suportar evolução futura sem quebra de contratos públicos.

---

## Architectural Decisions

| ID | Decisão |
|----|---------|
| CRYPTO-ADR-001 | Introduzir Crypto Envelope autodescritivo como contrato oficial de persistência criptográfica. |
| CRYPTO-ADR-002 | Tornar a serialização do envelope canônica, determinística e auto delimitada. |
| CRYPTO-ADR-003 | Tornar obrigatória a autenticação criptográfica do cabeçalho por AAD, com exceção documentada para envelopes legados. |
| CRYPTO-ADR-004 | Resolver chaves exclusivamente por KID, com falha fechada para identificadores desconhecidos. |
| CRYPTO-ADR-005 | Formalizar o Key Ring como autoridade de resolução, com uma única chave Active por Key Ring. |
| CRYPTO-ADR-006 | Vincular rigidamente KID e algoritmo criptográfico. |
| CRYPTO-ADR-007 | Introduzir Binding Context opaco para impedir substituição entre recursos distintos sem expor detalhes aos consumidores. |
| CRYPTO-ADR-008 | Formalizar os Legacy KIDs (`LEGACY_GCM`, `LEGACY_CBC`) como mecanismo de compatibilidade retroativa com Recognition Tree determinística. |
| CRYPTO-ADR-009 | Garantir unicidade de Nonce/IV por KID e rejeição determinística de versões, algoritmos ou KIDs desconhecidos. |

---

## Parecer do Arquiteto Principal

**Status:** APPROVED FOR IMPLEMENTATION

O ADR-CRYPTO-001 foi aprovado no Final Gate Arquitetural.

O contrato criptográfico está formalizado nos seguintes termos:
- serialização canônica determinística em nível de bytes (Seção 3.1);
- KID globalmente único com resolução direta (Seção 4);
- AAD obrigatório para envelopes canônicos (Seção 3.2);
- Binding Context com representação canônica, obrigatoriedade e participação explícita no AAD (Seção 7);
- Dois Legacy KIDs independentes (`LEGACY_GCM`, `LEGACY_CBC`) com Recognition Tree determinística de três níveis (Seção 8);
- invariantes formais (Seção 10) que garantem key confusion, algorithm confusion, downgrade e envelope tampering detection;
- compatibilidade retroativa integral sem migração imediata de dados existentes.

Este documento substitui as definições criptográficas anteriores e é a fonte de verdade para o ADR-E7-001 (Encryption Key Rotation) e para toda implementação futura da camada criptográfica da plataforma.
