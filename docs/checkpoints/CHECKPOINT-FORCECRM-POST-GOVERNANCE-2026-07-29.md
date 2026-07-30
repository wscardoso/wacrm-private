# CHECKPOINT — ForceCRM · Transição de Governança

| | |
|---|---|
| **Data** | 2026-07-29 |
| **Tipo** | Checkpoint de transição de governança — registro de estado e de processo |
| **Natureza** | **Somente registro.** Nenhum ADR promovido, nenhum contrato alterado, nenhuma inconsistência resolvida, nenhuma decisão arquitetural criada |
| **Arquivo criado por** | WORK ORDER `CHECKPOINT-FORCECRM-POST-GOVERNANCE-2026-07-29` |
| **Escopo autorizado** | Exclusivamente este arquivo |

> **Como ler este documento.** Ele existe para que uma sessão futura retome o trabalho sem depender da memória de nenhuma conversa. Tudo em §1 e §2 é fato verificado contra o repositório no momento indicado. §3 a §6 registram princípios, papéis e planejamento **declarados pelo Product Owner** na ordem de trabalho que originou este checkpoint — são registro de decisão de processo, não achados de auditoria.

---

## 1. Estado atual do repositório

Inventário executado em **2026-07-29, 23:19–23:20**.

### 1.1 Git

| Item | Valor |
|---|---|
| Branch | `main` |
| HEAD | `9ed4502e7658feb65b1e72ff5413262c26bb33bb` |
| `origin/main` | `9ed4502e7658feb65b1e72ff5413262c26bb33bb` |
| Sincronização | Idêntico após `git fetch` — sem *ahead* nem *behind* |
| Stash | Vazio |
| Merge / rebase / cherry-pick | Nenhum ativo |
| Conflitos | Nenhum marcador em `src/`, `docs/`, `supabase/` |
| Working tree | 21 entradas — 12 modificadas, 9 não rastreadas |

Últimos três commits publicados:

```
9ed4502 docs: finalize group B operational validation
6354b1d docs: approve E2.1 canonical message status contract
3fccfae docs: reconcile master roadmap with repository state
```

### 1.2 Alterações não commitadas

**Modificadas (12)**

```
docs/MASTER-ROADMAP.md
docs/adr/ADR-ATTR-001-lead-attribution.md
docs/adr/ADR-ATTR-002-per-tenant-ad-account-credentials.md
docs/adr/ADR-MSG-STATUS-001.md
docs/architecture/E6.0-attribution-enrichment-marketing-api.md
docs/checkpoints/CHECKPOINT-ROADMAP-RECONCILIATION.md
src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts
src/lib/whatsapp/providers/meta.ts
src/lib/whatsapp/providers/types.ts
src/lib/whatsapp/providers/uazapi.ts
src/lib/whatsapp/providers/webhook-auth.test.ts
src/lib/whatsapp/providers/zapi.ts
```

**Não rastreadas (9)**

```
docs/checkpoints/CHECKPOINT-E6-FINAL.md
docs/checkpoints/E6.0-final-checkpoint.md
src/lib/message/                       (status.ts, status.test.ts, resolve-by-external-id.ts)
src/lib/whatsapp/status-handler.ts
src/lib/whatsapp/providers/dc-discovery.test.ts
src/lib/whatsapp/providers/parse-status.test.ts
supabase/migrations/063_messages_status_canonical.sql
.claude/settings.json                  (fora de escopo — 2026-07-23)
scripts/rotate-zapi-webhook.mjs        (fora de escopo — ferramenta operacional local)
```

O conteúdo não commitado corresponde, em termos gerais, a dois blocos: a **Fase 1 de E2.1** (implementação de status canônico, com migration e testes) e a **reconciliação documental de E6 e E2.1**. Nenhum dos dois foi commitado.

### 1.3 Arquivos fora de escopo conhecidos

- `.claude/settings.json` — configuração local de harness, não versionada por decisão anterior.
- `scripts/rotate-zapi-webhook.mjs` — script operacional descartável, mantido local por decisão anterior.

### 1.4 Estado operacional

| Verificação | Resultado |
|---|---|
| Tipagem — `npx tsc --noEmit` | **0 erros** |
| Testes — `src/lib/message` + `src/lib/whatsapp` | **393 aprovados / 393**, 28 arquivos |
| Conflitos de merge | Nenhum |

**Nota de método sobre a suíte completa.** Em execuções anteriores desta sessão, `vitest run` sem restrição apresentou falhas do tipo *"Worker exited unexpectedly"* em arquivos PGlite, com contagem variável entre execuções (11 a 14 arquivos). Executada em série (`--no-file-parallelism`), a suíte completa passou integralmente: **1334/1334, 95 arquivos**. Um experimento de controle — remover e restaurar a migration `063` — produziu falhas em ambos os casos, indicando **contenção de recurso pré-existente**, não regressão. Registro para que uma sessão futura não interprete o modo paralelo como quebra.

### 1.5 Escrita concorrente observada

Houve atividade de escrita neste repositório por processo distinto do que executou este inventário. Registro apenas o que é verificável por *timestamp* de arquivo. **A autoria não foi estabelecida e não é atribuída aqui.**

| Janela | Arquivos | Observação |
|---|---|---|
| 15:02–15:14 | Fase 1 inicial de E2.1; ADRs de Attribution; contrato de E6.0 | — |
| 15:34–15:40 | Correções da Fase 1 de E2.1; migration `063`; testes | — |
| 16:04–16:05 | `CHECKPOINT-E6-FINAL.md`; addendum §9 de `CHECKPOINT-ROADMAP-RECONCILIATION.md` | — |
| 17:10–17:11 | Cabeçalho de `ADR-MSG-STATUS-001`; §17/R1–R2 do `MASTER-ROADMAP` | — |
| **22:16:07** | `ADR-E7-001` — campo Status alterado para "Aceito" | Ver §2.1 |
| **22:47:59 – 22:48:03** | `ADR-E4B-001`, `ADR-E4B-003`, `ADR-SYS-001` — campo Status alterado para "Aceito" | Três arquivos em **4 segundos**. Ver §2.2 |
| **22:59:35 – 22:59:42** | Os mesmos quatro contratos — revertidos | Quatro arquivos em **7 segundos** |

**Estabilidade no momento deste registro:** última escrita às 22:59:42; inventário às 23:19. Aproximadamente **20 minutos sem atividade**. A reversão está completa e coerente — os quatro contratos são byte-a-byte idênticos ao commitado em `9ed4502` (`git diff` vazio para os quatro).

---

## 2. Histórico factual da sessão de governança

### 2.1 Caso `ADR-E7-001`

**Fatos verificados:**

1. `MASTER-ROADMAP.md:12` (changelog v1.3) afirma: *"`ADR-CRYPTO-001` v2.0 e **`ADR-E7-001` RC1.1 congelados**"*.
2. `ADR-E7-001`, campo Status: **"Proposto · pronto para novo Gate Arquitetural"**.
3. `ADR-E7-001` §0.1 registra que o **Gate Arquitetural #1 retornou NO-GO** (1 achado CRITICAL, 4 HIGH) e que a revisão RC1.1 resolve exatamente esses cinco achados. A linha final do documento repete: *"RC1.1, pronto para novo Gate Arquitetural"*.
4. **Nenhum registro de Gate Arquitetural #2** existe no ADR.
5. `E7-final-checkpoint.md` registra a **épica** como `CLOSED` (commit `d443ac0`), fechando o `IMP-E7-001` — a capacidade de rotação entregue. **Não contém registro de Gate do ADR.** O próprio checkpoint reforça a separação, ao instruir: *"Do not propose or start implementation of any feature without a new ADR and Gate approval."*
6. Existe alegação explícita de aprovação no histórico: o commit `d94674c` tem por assunto **`docs(adr): approve ADR-E7-001 RC1.1 + IMP-E7-001 implementation plan`**. A inspeção mostrou que esse commit **cria** o ADR (390 linhas) e o IMP (215 linhas), e que o campo Status que ele introduz é literalmente `Proposto · pronto para novo Gate Arquitetural`. O corpo da mensagem descreve as resoluções de RC1.1, mas **não registra veredito de gate** — sem GO/NO-GO, sem revisor, sem critérios avaliados.

**Conclusão da auditoria:**

> **Gate alegado sem evidência formal suficiente.**

Não foi possível concluir "gate inexistente", porque há alegação explícita de aprovação em dois lugares (o changelog do roadmap e o assunto do commit `d94674c`). Não foi possível concluir "gate registrado", porque nenhum artefato contém o veredito.

**Tentativa de sincronização e reversão:** em 22:16:07 o campo Status de `ADR-E7-001` foi alterado para "Aceito", com justificativa afirmando que *"a auditoria encontrou evidência suficiente de que o Gate Arquitetural #2 foi aprovado"* — afirmação que **contradiz a conclusão registrada acima**. A alteração foi **revertida às 22:59:35**. O arquivo está hoje idêntico ao commitado.

**Nenhuma promoção definitiva permaneceu sem validação adequada.**

**Princípio extraído:**

> Mensagem de commit, fechamento de épica ou implementação concluída não substituem registro de Gate.

### 2.2 Caso `ADR-E4B-001` / `ADR-E4B-003` / `ADR-SYS-001`

**Fatos verificados:**

1. Em 22:47:59–22:48:03 — intervalo de **4 segundos** — os três contratos tiveram o campo Status alterado de "Proposto" para **"Aceito"**, com texto de justificativa idêntico entre eles.
2. A justificativa apoiava-se em `E4b-final-checkpoint.md` estar com Status `CLOSED` (commit `60b0565`).
3. Essa justificativa **deriva o estado do ADR do estado da épica** — inferência que o próprio protocolo de governança veda: *"épica concluída NÃO prova ADR aceito"*. Um checkpoint de fechamento de épica é evidência de implementação entregue; não é, por si, registro de Gate Arquitetural.
4. **A auditoria individual desses contratos não foi executada.** Nenhuma conclusão sobre a existência ou inexistência dos respectivos Gates foi produzida. É possível que os gates existam e estejam registrados — isso precisa ser verificado lendo cada artefato, não presumido.
5. As alterações foram **revertidas às 22:59:38–22:59:42**. Os três arquivos estão hoje idênticos ao commitado, com Status "Proposto".

**Registro normativo:** nenhuma conclusão sobre a aceitação de `ADR-E4B-001`, `ADR-E4B-003` ou `ADR-SYS-001` deve ser inferida sem evidência específica de Gate. O estado documental atual desses três contratos é "Proposto", e assim permanece.

### 2.3 Divergências conhecidas e não resolvidas

Registradas para continuidade. **Nenhuma foi corrigida** — não é escopo deste checkpoint.

| # | Divergência | Situação |
|---|---|---|
| 1 | `MASTER-ROADMAP:12` afirma `ADR-E7-001` congelado; o ADR se declara aguardando novo Gate | Aberta. Aguarda decisão do Product Owner: registrar o Gate #2 (se ocorreu) ou corrigir o roadmap (se não ocorreu) |
| 2 | Commit `d94674c` alega "approve ADR-E7-001 RC1.1" mas grava o ADR com Status "Proposto" e sem veredito | Aberta |
| 3 | `DLB-001`, `ODI-001`, `ADR-E4B-001`, `ADR-E4B-003`, `ADR-SYS-001` — declarados "Proposto", sustentando épicas marcadas CONCLUÍDO | Aberta. Auditoria individual planejada (§6) |
| 4 | `ADR-E7-001:42` descreve `ADR-ATTR-002` como "Proposto · pronto para Gate", estado anterior à sua promoção | Aberta, severidade menor — referência datada |

### 2.4 Pré-condições em aberto da Fase 1 de E2.1

| # | Pré-condição | Natureza |
|---|---|---|
| R1 | Capturar payload real de callback de status (Z-API `MessageStatusCallback`; uazapi `MESSAGES_UPDATE`) | **Técnica.** Depende de ambiente externo. ⚠️ Apontar o webhook de status para o endpoint de produção **dispararia o defeito D-C**, caso ele seja real — a captura deve ir para coletor inerte |
| R2 | Formalizar a evidência da medição de D-C em artefato versionado | **Documental.** A medição foi executada em 2026-07-29 (172 mensagens totais, 167 de cliente, **0** fantasmas nas três assinaturas; `whatsapp_webhook_dlq` com 0 linhas), mas por consulta operacional não versionada. Falta artefato reproduzível — não falta investigação |

Distinção a preservar: **incidência observada de D-C é zero; a existência do defeito no código permanece confirmada** (o parser de entrada Z-API não discrimina pelo campo `type` do envelope). Zero incidência não significa defeito inexistente.

---

## 3. Princípios de governança consolidados

Registrados conforme declarado pelo Product Owner na ordem de trabalho que originou este checkpoint.

### Princípio 1 — Independência das evidências

São evidências **independentes**: implementação, épica, ADR, checkpoint, commit.

Nenhuma delas autoriza inferir automaticamente o estado de outra.

```
Código implementado  ≠  ADR aprovado
Épica CLOSED         ≠  Gate Arquitetural aprovado
ADR aceito           ≠  implementação concluída
```

### Princípio 2 — Evidência antes da alteração

Antes de qualquer sincronização documental, confirmar:

1. qual era o Gate esperado;
2. onde ele está registrado;
3. quais critérios foram avaliados;
4. qual foi o resultado.

Somente depois alterar o status documental.

### Princípio 3 — Auditoria independente

O agente que produz uma alteração ou conclusão não deve ser a única autoridade de validação. A revisão adversarial deve questionar inclusive as conclusões do arquiteto principal.

### Princípio 4 — Revisão adversarial pode retroceder etapas

A revisão adversarial não se limita a defeitos de implementação. Pode reabrir decisões arquiteturais, ADRs, escopo, documentação e interpretações anteriores.

---

## 4. Modelo operacional multi-agente

Papéis declarados pelo Product Owner.

| Papel | Agente | Responsabilidade |
|---|---|---|
| **Product Owner** | — | Prioridades, decisões de negócio, aprovação final |
| **Chief Systems Architect** | ChatGPT | Arquitetura, ADRs, escopo, definição dos Gates, arbitragem entre modelos |
| **Architecture Review** | Opus | Revisão profunda de arquitetura, riscos sistêmicos, validação de contratos |
| **Auditor Adversarial** | Sonnet | Contestar conclusões, verificar evidências, procurar inferências inválidas, revisar decisões antes da aprovação |
| **Engenharia** | Claude Code | Implementação, migrations, testes, build, commits. **Não decide arquitetura sozinho** |
| **Engenharia crítica / revisão técnica** | DeepSeek | Implementação quando solicitado, viabilidade técnica, edge cases, revisão crítica |
| **Revisores auxiliares** | Laguna, Ling, Nemotron | Revisão documental, segunda opinião, análise técnica complementar — conforme necessidade |

---

## 5. Fluxo operacional oficial

```
Necessidade
    ↓
ADR
    ↓
Gate Arquitetural           (ChatGPT + Opus + revisão adversarial quando necessário)
    ↓
IMP
    ↓
Implementação               (Claude Code / DeepSeek)
    ↓
Validação Técnica
    ↓
Revisão Adversarial         (Sonnet + DeepSeek)
    ↓
Correções
    ↓
Gate Final
    ↓
Commit + Push
    ↓
Deploy
    ↓
Validação Produção
    ↓
Checkpoint
    ↓
Próxima épica
```

---

## 6. Próximos ciclos planejados

Registro de planejamento. Nenhum destes ciclos foi iniciado.

### Primeiro — `ADR-GOV-001`

Criar **ADR-GOV-001 — Modelo de Governança Multi-Agente do ForceCRM**, formalizando os papéis, gates e regras registrados em §3, §4 e §5.

### Segundo — auditoria individual de `DLB-001` e `ODI-001`

Cada contrato avaliado **separadamente**, sem promoção em lote. Classificações possíveis:

- **A)** Gate registrado e evidenciado
- **B)** Gate não encontrado
- **C)** Gate alegado sem evidência suficiente
- **D)** Implementação existente sem decisão formal comprovada

### Terceiro — retomada de épicas

Somente após a resolução documental dos itens acima.

---

## 7. Estado de continuidade

Para a próxima sessão, em ordem:

1. **Verificar o working tree antes de qualquer coisa.** Há trabalho não commitado de mais de um autor, e houve escrita concorrente nesta sessão (§1.5). O working tree é a fonte de verdade; a memória de conversa não é.
2. **Nada foi commitado nesta sessão** após `9ed4502`. Tudo em §1.2 permanece exposto a perda.
3. **Quatro contratos foram promovidos e revertidos** (§2.1, §2.2). O estado atual deles é "Proposto", idêntico ao commitado. Nenhuma auditoria de gate foi executada para eles.
4. **Nenhuma divergência de §2.3 foi resolvida.** Todas aguardam ciclo próprio.

---

*Fim do checkpoint. Registro de estado e de processo apenas — nenhum ADR promovido, nenhum contrato alterado, nenhuma inconsistência resolvida, nenhuma decisão arquitetural criada. Nenhum commit realizado.*
