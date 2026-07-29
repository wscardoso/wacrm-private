# CHECKPOINT-ROADMAP-RECONCILIATION

**Data:** 2026-07-29 · **Baseline:** HEAD `26e5d39` (branch `main`), working tree limpa (só alterações de doc pendentes)
**Escopo:** auditoria de sincronização entre `MASTER-ROADMAP.md` e o estado real do repositório. Nenhum código, ADR, contrato ou schema foi alterado nesta auditoria.
**Método:** verificação direta em código, migrations, ADRs, checkpoints e `git log` — nunca aceito resumo de commit como prova (a lição do achado principal desta auditoria, ver §5).

---

## 1. Por que esta auditoria existe

O `MASTER-ROADMAP.md` v1.3 (atualizado ontem, 2026-07-28, para refletir E7) mostrou-se **ainda desatualizado**: uma sessão de auditoria de código encontrou evidência de que E1, E2.0, E4a, E4b, E5, E6.0 e E9 já estavam implementados e fechados, sem que o roadmap refletisse isso. Esta auditoria reconcilia o documento inteiro contra o repositório real, épico por épico.

---

## 2. Inventário de épicos — status real

| Épico | Nome | Status real | Evidência principal |
|---|---|---|---|
| **E0** | ADR Messaging Core | **CONCLUÍDO** | `ADR-MSG-001.md` — Status "Aceito", ratificado 2026-07-21 |
| **E1** | Delivery Layer & Provider Boundary | **CONCLUÍDO** | commits `78bd7cd`, `b0f5988`; arch test `no-direct-meta-import.arch.test.ts` verde; `send/route.ts`, `broadcast/route.ts`, `flows/meta-send.ts`, `automations/meta-send.ts` usam `getProvider()` + `delivery/` |
| **E2.0** | Message Identity Correction (R16) | **CONCLUÍDO, mas subutilizado** | `zapi.ts:131-135` declara `wamid`/`provider_message_id` via `ExternalIdentity`; migration `047_message_external_ids.sql`; `settlement.ts` grava via `insert_message_external_ids`. **Ressalva:** o único consumidor de status (`handleStatusUpdate`, rota Meta) resolve mensagem por `.eq('message_id', status.id)` — a coluna legada, não por `message_external_ids`. E2.0 grava identidades que E2.1 (inexistente) nunca lê. |
| **E2.1** | Status Canônico | **NÃO INICIADO** | Confirmado por duas auditorias independentes (ver §3). Zero pipeline de status para providers não-Meta; domínio usa vocabulário Meta diretamente (`RECIPIENT_STATUS_LADDER` só em `route.ts`); sem contrato escrito ("a escrever" no roadmap, correto). |
| **E3** | Connections (multi-conexão) | **NÃO INICIADO** | Nenhuma migration de tabela `connections`; `whatsapp_config` continua single-connection por account |
| **E4a** | Outbound Delivery Integrity | **CONCLUÍDO** | commit `ef7e4f9`; `ODI-001` publicado (`8057b22`); `delivery/settlement.ts` implementa intent→settle com `idempotency_key` |
| **E4b** | Async Reliability (DLQ/retry) | **CONCLUÍDO** | `docs/checkpoints/E4b-final-checkpoint.md`, commit final `60b0565`; 691 testes verdes; `ADR-E4B-001/002/003`, `ADR-SYS-001`, `ARO-001` fechados |
| **E5** | Workspace Commercial Identity | **CONCLUÍDO** | commit `485b1e6`; `docs/architecture/E5-workspace-commercial-identity.md` |
| **E6** | Attribution End-to-End (completo) | **PARCIAL** | Ver §4. 1 de 4 entregáveis fechado (enriquecimento); ADR-ATTR-001 segue "Proposto"; UI de relatório ausente; CAPI inexistente (não-objetivo declarado de E6.0) |
| **E6.0** | Enrichment via Marketing API (sub-escopo de E6) | **IMPLEMENTADO, não formalmente fechado** | commit `2c4daef` (+2387 linhas: migrations 055/056, `src/lib/enrichment/` com 6 módulos, 2 rotas, `ADR-ATTR-002`); 57 testes verdes incluindo isolamento D-8 multi-tenant. **Lacuna é documental**: doc ainda diz "Rascunho para Gate arquitetural", baseline desatualizado (`485b1e6`, o commit *anterior* à implementação); sem checkpoint de encerramento |
| **E7** | Encryption Key Versioning | **CONCLUÍDO** | 5 fases, `docs/checkpoints/E7-final-checkpoint.md`, `ADR-CRYPTO-001`/`ADR-E7-001` congelados |
| **E8** | Integridade Referencial (C16/C19/C21) | **NÃO INICIADO** | Sem commits, sem migrations correspondentes |
| **E9** | Platform Operations UI | **CONCLUÍDO** | commit `2a2da71` "Platform Operations UI — control tower grid + team management" |
| **E10** | ADR-AUT-001 + Convergência Automations×Flows | **NÃO INICIADO** | Sem `ADR-AUT-001`, sem commits |
| **E11** | Public API v1 Resources | **NÃO INICIADO** | Só `GET /api/v1/me` (scaffold pré-existente) |
| **E12** | Reporting & Export | **NÃO INICIADO** | Bloqueado por E6 incompleto (roadmap §8.2) |
| **E13** | Observabilidade | **NÃO INICIADO** | Sem correlation IDs, sem logs estruturados além de `console.error` |

---

## 3. E2.1 — evidência detalhada (duas auditorias independentes convergentes)

Ambas as auditorias (Sonnet CLI e modelo Ling, rodadas separadamente pelo operador) chegaram à mesma conclusão por caminhos de evidência distintos:

- Existe **um único** consumidor de status em toda a base: `handleStatusUpdate` dentro da rota webhook Meta (`src/app/api/whatsapp/webhook/route.ts`), operando sobre `value.statuses[]` — formato exclusivo da Graph API.
- A interface `WhatsAppProvider` (`providers/types.ts`) não declara nenhum método de parsing de status — só `parseInboundMessage`.
- A rota webhook não-Meta trata todo payload como mensagem de entrada; um callback de status de Z-API/uazapi chegando ali retorna `{ received: true, processed: 0 }` e é descartado **em silêncio** — violação do critério 13 de `EIS-001` ("ausência de correlação é sinal, nunca ausência de sinal").
- O domínio usa o vocabulário de status da Meta diretamente (`CHECK` constraint da migration 001, `RECIPIENT_STATUS_LADDER` em `route.ts`), sem tradução — coincidência herdada, não abstração.
- Nenhum commit no histórico é atribuível a um pipeline de status canônico. Commits que mencionam "status" pertencem a outro domínio (ciclo de vida de **template** Meta: `template-status-normalize.ts`, commits `aa4f34c`/`c7d7806`/`bac3065`) — falso-positivo comum numa varredura por nome de arquivo.
- **Achado extra de uma das auditorias, não solicitado mas material:** E2.0 está pagando um custo sem benefício realizado — grava identidades (`message_external_ids`) que nenhum código lê hoje. Não é um bug (E2.0 entregou exatamente seu escopo, por design, para E2.1 consumir), mas é o motivo concreto pelo qual fechar E2.1 tem valor imediato, não só arquitetural.

**Conclusão:** E2.1 é o item genuinamente não iniciado mais próximo do topo da cadeia de precedência dura do roadmap (`E1 → E2.0 → E2.1`), e o único que impede o problema central do executive summary do roadmap ("mensagens Z-API ficam travadas em `sent`") de ser resolvido.

---

## 4. E6 / E6.0 — evidência detalhada

- **Commit `2c4daef`** está com a mensagem enganosa ("finalize hardening and D-8 isolation verification") — na prática entrega o épico inteiro: migrations 055 (`ad_account_credentials`) e 056 (`enrichment_ledger`), 6 módulos em `src/lib/enrichment/`, 2 rotas (`/api/enrichment/cron`, `/api/enrichment/report`), `ADR-ATTR-002`, e 4 arquivos de teste. Essa mensagem de commit subdimensionada é a causa raiz rastreável de por que a reconciliação foi necessária — uma leitura por `git log --oneline` não revela que a feature foi entregue ali.
- **Código ativo e mantido**, não código morto: `credential-resolver.ts` foi migrado para `decryptWithBindingContext` durante o E7 (`c36b3b5`), e `orchestration.ts` recebeu ajuste em `2876bc6` — sinais de manutenção contínua pós-entrega.
- **57 testes verdes** (43 unit/integração + 14 PGlite), incluindo os 4 cenários de isolamento D-8 (não-contaminação de credencial entre tenants no mesmo lote).
- **Lacuna real, não técnica:** o documento `E6.0-attribution-enrichment-marketing-api.md` nunca foi promovido — ainda diz "Rascunho para Gate arquitetural" com baseline no commit *anterior* à implementação (`485b1e6`). Não existe checkpoint de encerramento (único item de porte comparável a E4b/E7 sem um).
- **Dependência arquitetural pendente real:** E6.0 consome `ADR-ATTR-001 §3.1` como "modelo de captura congelado", mas `ADR-ATTR-001` continua **"Proposto (aguarda contestação de GPT/HY3 antes de congelar)"** — confirmado lendo o próprio arquivo. A captura roda em produção (webhook Meta, commit `307d6cf`) sem o ADR que a autoriza estar formalmente fechado.
- **`ADR-ATTR-002`** (fronteira de credencial, consumida por E6.0) está **"Proposto · pronto para Gate"** — também não formalmente aprovado, apesar de já consumida em produção.

**E6 como épico completo, 4 entregáveis do roadmap:**

| Entregável | Estado |
|---|---|
| Congelar ADR-ATTR-001 | ❌ Não congelado |
| Enriquecimento (E6.0) | ✅ Implementado e testado, doc/checkpoint pendentes |
| UI | 🟡 Parcial — ficha de contato mostra o resultado (`contact-sidebar.tsx`), mas `/api/enrichment/report` não tem consumidor de front-end |
| CAPI | ❌ Inexistente (não-objetivo declarado da fase atual, P3 futura) |

**Conclusão:** E6.0 é trabalho técnico real e testado à espera só de fechamento documental (baixo esforço, baixo risco). E6 como um todo permanece PARCIAL e continua bloqueando E12 (`MASTER-ROADMAP` §8.2), porque a UI de relatório e o CAPI não existem e o ADR base não está congelado.

---

## 5. Divergências e lições

1. **Mensagens de commit não são fonte confiável de escopo.** `2c4daef` e o padrão observado ontem (E7, E5, E9 também documentados via commits cujo "assunto" descreve só a última etapa) mostram que qualquer reconciliação de roadmap precisa ler diff real, não só `git log --oneline`.
2. **ADRs consumidos antes de congelados** é um padrão recorrente neste projeto: `ADR-ATTR-001` e `ADR-ATTR-002` estão os dois "Proposto", mas ambos já têm código em produção que os pressupõe fechados. Vale uma decisão explícita do Weyner (congelar retroativamente ou revisar) — não é bloqueante tecnicamente, mas é dívida de governança.
3. **Nenhuma contradição doc↔código foi encontrada em E2.1** — o roadmap já dizia "a escrever" e é exatamente isso. A única surpresa genuína do dia anterior era sobre os épicos que o roadmap achava pendentes e já estavam prontos (E1/E2.0/E4a/E4b/E5/E6.0/E7/E9), não sobre os que seguem abertos.
4. **`docs/checkpoints/` tem um padrão a manter**: E4b e E7 têm checkpoint formal; E1, E2.0, E5, E6.0 e E9 não têm (encerrados só via commit + doc de arquitetura). Vale considerar, como item de processo (não técnico), gerar esses checkpoints retroativos para os épicos já fechados — melhora rastreabilidade futura, mas não é prioridade de código.

---

## 6. Dependências reais (atualizadas)

```
E0 ✅ → E1 ✅ → E2.0 ✅ → E2.1 ❌ (PRÓXIMO)
                    │
                    └──────────────→ E4a ✅ → E4b ✅
E1 ✅ → E3 ❌ (bloqueia E8, E11, E13)
E6 🟡 (parcial) → E12 ❌ (continua bloqueado)
E5 ✅, E7 ✅, E9 ✅ — paralelos, já concluídos
E10, E11, E13 — sem bloqueio técnico, apenas não priorizados ainda
```

A precedência dura `E1 → E2.0 → E2.1` (`DN-001`) permanece válida e agora está no seu último elo em aberto. E4a/E4b não dependiam de E2.1 (são ramos paralelos a partir de E2.0, conforme o grafo original do roadmap) — por isso puderam ser concluídos antes, sem violar a precedência.

---

## 7. Roadmap corrigido — resumo para `MASTER-ROADMAP.md`

Concluídos, não refletidos até esta reconciliação: **E1, E2.0 (parcial-técnico), E4a, E4b, E5, E9** (E7 já corrigido na v1.3).
Parcial, mal classificado como "a escrever" sem nuance: **E6 / E6.0**.
Confirmados como realmente abertos, sem mudança: **E2.1, E3, E8, E10, E11, E12, E13**.

---

## 8. Próxima épica recomendada

### 🎯 Próxima épica oficial do ForceCRM: **E2.1 — Status Canônico**

**Justificativa técnica:**

1. É o único elo restante da cadeia de precedência dura `E1 → E2.0 → E2.1`, já com E1 e E2.0 fechados — não há pré-requisito pendente.
2. Resolve diretamente o problema central declarado no executive summary do roadmap: mensagens enviadas por Z-API/uazapi ficam travadas em `sent`, sem nunca refletir `delivered`/`read`.
3. Dá utilidade real ao investimento já feito em E2.0 — hoje `message_external_ids` é gravado e nunca lido; E2.1 é o consumidor que faltava.
4. Não reabre nenhum contrato fechado (E4a/E4b/ADR-MSG-001 permanecem intocados — E2.1 é consumidor novo, não modifica os já existentes).
5. Menor risco relativo comparado a E3 (Connections, classificado no próprio roadmap como "risco máximo", exigindo migration estrutural e ensaio em cópia de produção).

**Alternativa de menor esforço, se preferir ganho rápido antes:** fechar E6.0 formalmente (promover `E6.0-attribution-enrichment-marketing-api.md` de "Rascunho" para aprovado, criar `E6.0-final-checkpoint.md`) — é trabalho documental puro sobre código já pronto e testado, sem decisão arquitetural nova. Não é um épico de código, mas resolve uma dívida de rastreabilidade real.

Nenhuma decisão foi tomada nesta auditoria — cabe ao Weyner escolher entre iniciar E2.1 ou fechar a lacuna documental de E6.0 primeiro.
