# WACRM/FORCECRM — MASTER ROADMAP

**Versão:** v1.5 · **Snapshot auditado:** HEAD `26e5d39` (fechamentos documentais de 2026-07-29/30 aplicados sobre este snapshot; nenhuma alteração de código considerada)
**Fonte de verdade do escopo restante.** Documentos normativos derivados: `docs/adr/ADR-MSG-001.md`, `docs/architecture/EIS-001-external-identity-storage.md`, `docs/architecture/DN-001-eis001-implementation-preconditions.md`, `docs/architecture/DLB-001-delivery-layer-boundary.md`, `docs/architecture/ODI-001-outbound-delivery-integrity.md`, `docs/architecture/ARO-001-async-recovery-orchestration.md`, `docs/adr/ADR-E4B-001-retry-lifecycle-semantics.md`, `docs/adr/ADR-E4B-002-ambiguous-delivery-recovery.md`, `docs/adr/ADR-E4B-003-provider-capability-contract.md`, `docs/adr/ADR-CRYPTO-001.md`, `docs/adr/ADR-E7-001-encryption-key-versioning.md`, `docs/implementation/IMP-CRYPTO-001.md`, `docs/implementation/IMP-E7-001-encryption-key-versioning.md`, `docs/architecture/E5-workspace-commercial-identity.md`, `docs/architecture/E6.0-attribution-enrichment-marketing-api.md`, `docs/adr/ADR-ATTR-001-lead-attribution.md`, `docs/adr/ADR-ATTR-002-per-tenant-ad-account-credentials.md`. Reconciliação completa em `docs/checkpoints/CHECKPOINT-ROADMAP-RECONCILIATION.md`.

**Legenda de confiança:** `[C]` confirmado no código · `[I]` inferido · `[P]` planejado em doc · `[R]` recomendação · `[?]` desconhecido.

**Histórico**
- **v1.0** — mapa inicial produzido por reconhecimento do repositório.
- **v1.1** — após revisão adversarial arbitrada no código: E2.0 criado, `message_external_ids` substitui `external_id` único, R16 registrado, E4 dividido em E4a/E4b, E0 corrigido quanto a invariantes vigentes.
- **v1.2** — persistência como artefato versionado; cadeia de precedência dura `E1 → E2.0 → E2.1` registrada conforme `DN-001`; §8 e §9 atualizados; §16 remete aos contratos derivados em vez de duplicá-los.
- **v1.3** (2026-07-29) — snapshot avançado de `c8f1585` para `26e5d39` (40 commits). **E7 (Encryption Key Versioning) concluído** — as 5 fases do `IMP-E7-001` fechadas e mergeadas (`ADR-CRYPTO-001` v2.0 e `ADR-E7-001` RC1.1 congelados); atualizado em §6, §7, §8, §9, §10, §13. Registrada, como nota operacional (não como épico novo), a sequência Sprint C (bug real do badge de sessão corrigido) → rotação de webhook secret Z-API (2×, a primeira invalidada por perda do plaintext) → Gate Operacional do Grupo B fechado `APROVADO COM RESSALVAS` em 2026-07-28 — ver `docs/checkpoints/CHECKPOINT-FORCECRM-GROUP-B-RESULT.md`. Nenhum desses itens altera os épicos E0–E13 ou a cadeia de precedência; são validação operacional e correção de bug pontual, não escopo restante de messaging.
- **v1.4** (2026-07-29) — **reconciliação completa contra o repositório real** (`docs/checkpoints/CHECKPOINT-ROADMAP-RECONCILIATION.md`), motivada por E1 ter sido encontrado já concluído quando a v1.3 assumia que era o próximo item da fila. Achado: **E1, E2.0, E4a, E4b, E5, E9 estavam concluídos e não refletidos**; **E6.0 está implementado e testado (57 testes verdes, isolamento D-8), mas nunca formalmente fechado** (doc em "Rascunho", sem checkpoint); **E2.1 confirmado como único elo realmente aberto da cadeia dura `E1 → E2.0 → E2.1`** — verificado por duas auditorias independentes. `ADR-ATTR-001` e `ADR-ATTR-002` seguem "Proposto" apesar de código consumidor em produção — dívida de governança registrada, não bloqueante. **Decisão registrada: E2.1 é a próxima épica oficial**, aprovada por Weyner em 2026-07-29. Atualizado em §1, §5, §6, §7, §8, §9, §10, §13.
- **v1.5** (2026-07-30) — **duas dívidas de governança fechadas.** `ADR-ATTR-001` e `ADR-ATTR-002` promovidos a **Aceito** (evidência contra código real, sem reabertura de decisão). `E6.0` fechado formalmente (`docs/checkpoints/E6.0-final-checkpoint.md`). **E6 reescopado e fechado como infraestrutura**: UI de relatório de attribution movida para `E12` (decisão de Weyner — o backend está pronto e testado, a tela é trabalho de produto, e mantê-la em E6 bloqueava E12 sem necessidade); CAPI confirmado fora do MVP. Ver `docs/checkpoints/CHECKPOINT-E6-FINAL.md`. Atualizado em §1, §6, §7, §8, §9.

---

## 1. Executive Summary

O projeto está num estado assimétrico:

- **A camada de tenant (member-side) é madura** `[C]`. Contatos, inbox, pipelines, broadcasts, automations, flows, templates Meta, API keys e settings existem ponta a ponta, com RLS em 33 tabelas e ~60 arquivos de teste.
- **A camada de Platform é recente e estreita** `[C]`. Fundação de autorização (037), contexto read-only (038), discovery (039), contatos e inbox read-only em `/act/[accountId]`, provisionamento de Workspace com Owner obrigatório (041–046, fechado em `c8f1585`). Não há tela de escrita platform-side além da criação de Workspace.
- **A camada de messaging foi o débito dominante — hoje majoritariamente fechada** `[C]`. `E1` (Provider Boundary), `E2.0` (correção de identidade/R16), `E4a` (integridade de saída) e `E4b` (retry/DLQ) estão **concluídos**. Resta **E2.1** (Status Canônico) como único elo aberto da cadeia dura, e `E3` (Connections/multi-conexão) como item estrutural ainda não iniciado.

**O produto não é mais Meta-only no runtime para envio.** `send/route.ts`, `broadcast/route.ts`, `flows/meta-send.ts` e `automations/meta-send.ts` já despacham por `getProvider()` — nenhum importa `meta-api` diretamente (verificado por `no-direct-meta-import.arch.test.ts`). **O que ainda falta:** um workspace em Z-API/uazapi tem suas mensagens enviadas e retentadas corretamente (E1/E4a/E4b), mas o **status** delas (`delivered`/`read`) nunca é atualizado — não existe pipeline de status para providers não-Meta (E2.1, ver §7).

**R16 — corrigido.** `zapi.ts` agora declara `messageId` como identidade primária e grava `wamid`/`provider_message_id` como `ExternalIdentity` via `message_external_ids` (migration 047). **Ressalva:** essas identidades são gravadas mas hoje não têm consumidor — o único parser de status existente (rota Meta) resolve por `message_id` legado, não pelo conjunto de identidades. E2.1 é o consumidor que falta.

**Cadeia de precedência dura, registrada em `DN-001`:** `E1 ✅ → E2.0 ✅ → E2.1 🟡 (Fase 0 concluída — contrato aprovado; Fase 1 é a próxima entrega)`. E4a/E4b não dependiam de E2.1 (ramos paralelos a partir de E2.0) e por isso puderam ser concluídos antes. Detalhe do estado de E2.1 em §17.

**Risco de fundo, resolvido (2026-07-30):** o North Star (atribuição CTWA) tem a captura em produção, o enriquecimento (E6.0) implementado e testado, e `ADR-ATTR-001`/`ADR-ATTR-002` agora **Aceitos** — fechamento em 2026-07-29 (ver §11 de `ADR-ATTR-001` e §14 de `ADR-ATTR-002`). E6 fechado como infraestrutura em 2026-07-30, ver `docs/checkpoints/CHECKPOINT-E6-FINAL.md`.

---

## 2. Estado atual real

### 2.1 Stack `[C]`

| Item | Valor |
|---|---|
| Framework | Next.js **16.2.6** (App Router), React 19.2.4 |
| DB/Auth | Supabase (`@supabase/ssr` 0.10.3), Postgres com RLS |
| UI | Tailwind 4, shadcn, `@base-ui/react`, recharts, sonner |
| Editores | `@xyflow/react` (flows), `@dnd-kit` (pipelines) |
| i18n | `next-intl`, `en` + `pt-BR` |
| Testes | vitest 4 + `@electric-sql/pglite` |
| CI | `.github/workflows/{ci,test}.yml` |

`package.json` ainda declara `author: Arnas Donauskas`, `homepage: github.com/ArnasDon/wacrm`, v`0.2.2` `[C]`. O projeto é fork do template WACRM em transformação para ForceCRM; parte do código herdado (webhook Meta monolítico de 1038 loc, `whatsapp_config` single-connection) é **dívida herdada, não decisão do time**.

### 2.2 Schema real de `messages` (001) `[C]`

```
messages ( id, conversation_id,
           sender_type CHECK IN ('customer','agent','bot'),
           sender_id, content_type, content_text, media_url, template_name,
           message_id TEXT,        -- é o external id, apenas mal nomeado
           status CHECK IN ('sending','sent','delivered','read','failed'),
           created_at )
-- NÃO existe coluna `direction`: derivada de sender_type.
-- 034: UNIQUE (conversation_id, message_id) WHERE sender_type='customer'
```

**33 tabelas** com RLS `[C]`; **20 RPCs** `[C]`.

### 2.3 Inventário por módulo

**Autenticação & Identidade** — completo member-side `[C]`. Falta MFA, SSO, gestão de sessões platform. Risco: FK `user_id ON DELETE CASCADE` de `auth.users` (C19).

**Accounts / Workspaces / Membership** — funcional `[C]` (017–021, 041). Falta `legal_name`, `commercial_phone`, `commercial_email`, planejados em `docs/planning/P2.3` e **não implementados** `[C]`; CNPJ só setável na criação.

**Platform (Superadmin)** — funcional parcial, read-heavy/write-thin `[C]`. Falta `/act/[accountId]/settings`, UI de operadores, visualizador de auditoria, suspensão de workspace, gestão de conexões.

**Contacts** — completo member + read-only platform `[C]`. Risco: `findExistingContact` usa `LIKE '%sufixo'` → full scan `[C]`.

**Conversations / Inbox** — funcional, débito estrutural `[C]`: `messages` sem `account_id` (C11), sem `provider` (C9), CHECK de status incompleto (C20), `assigned_agent_id` sem FK (C21).

**WhatsApp / Providers** — conflitante `[C]`. Fechados: C4, C7, C15. Abertos: C1, C2, C3, C5, C6, C8, C10, C13, C14, C17, C18, além de R16.

**Templates Meta** — completo, 8 arquivos de teste `[C]`.

**Pipelines / Deals** — funcional `[C]`. Risco C16 (CASCADE vs SET NULL no delete de contato).

**Broadcasts** — funcional, Meta-only `[C]`.

**Automations & Flows** — dois motores paralelos, ambos funcionais, ambos Meta-only `[C]`. Nenhum documento explica se são complementares ou se um substitui o outro `[I]`.

**Public API v1** — scaffold; um endpoint (`GET /api/v1/me`) `[C]`.

**Dashboard** — funcional; **Reporting inexistente** `[C]`.

**Ausentes por completo** `[C, grep negativo]`: billing, notifications, tasks, search global, AI, webhooks de saída, onboarding, export, observabilidade estruturada.

---

## 3. Baseline validado — P2.3-B

Confirmado no código, sem reabrir `[C]`: owner obrigatório (044); owner resolvido por e-mail (043–046); Superadmin ≠ Owner; sem roubo de perfil (045); workspace com dados **BLOCK**, não disown, cobrindo as 13 tabelas de domínio (046); atomicidade; autorização `role='admin' AND is_active` com `42501` e actor sempre `auth.uid()`; HEAD `c8f1585`.

Ressalva: testes e build não foram reexecutados no ambiente de auditoria. Estado verde aceito como reportado.

---

## 4. Arquitetura atual

```
BROWSER
 ├─ (auth) · (dashboard) inbox · contacts · pipelines · broadcasts
 │                       · automations · flows · settings · dashboard
 │                          ↓ Supabase client (RLS: is_account_member)
 └─ /act/[accountId]  PLATFORM CONTEXT (read-only)
                          ↓ requirePlatformContext → can_access_account
                          ↓ Server Action → RPC SECURITY DEFINER

API ROUTES
 ├─ /api/account/**  ·  /api/whatsapp/**  ·  /api/automations/**  ·  /api/flows/**
 ├─ /api/whatsapp/webhook                        ← META (monólito 1038 loc)
 ├─ /api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]  ← NÃO-META
 └─ /api/v1/me

MESSAGING (estado real)
 send/route.ts ──┬── provider !== 'meta' → getProvider() → zapi | uazapi   ✅
                 └── provider === 'meta' → meta-api direto                 ✅
 broadcast · react · automations/meta-send · flows/meta-send
                 └────────────────────── meta-api DIRETO ❌

CRIAÇÃO DE MENSAGEM DE SAÍDA — quatro locais distintos  [DN-001, D-2]
 send/route.ts:314,487 · broadcast/route.ts:232
 automations/meta-send.ts:152 · flows/meta-send.ts:126

IDENTIDADE DE MENSAGEM (estado real)
 meta    → wamid consistente entre envio e status              ✅
 uazapi  → key.id consistente entre envio e status             ✅
 zapi    → envio grava zaapId ?? messageId (6 call-sites)
           inbound/status referenciam messageId                ❌ R16
```

---

## 5. Domínios do produto

| Domínio | Origem | Situação |
|---|---|---|
| Platform / Superadmin | `[C]` 037-046 + `[P]` P2.3/P2.4 | parcial |
| Workspaces (identidade comercial) | `[P]` `docs/planning/P2.3` | não implementado |
| Users / Roles / Membership | `[C]` 017-020 | completo |
| Contacts | `[C]` | completo |
| Conversations / Inbox | `[C]` | funcional, modelo frágil |
| WhatsApp / Providers / Connections | `[C]` + `ADR-MSG-001` | parcial crítico |
| Message Identity | `[C]` 001/034 + R16 | incompleta — `EIS-001` |
| Templates Meta · Pipelines · Broadcasts · Automations · Flows | `[C]` | funcionais |
| Lead Attribution (CTWA) | `[C]` 033 + `[P]` ADR "Proposto" | P0 implementado, ADR não congelado |
| Public API v1 · Dashboard · Audit · Settings | `[C]` | scaffold / funcionais |
| Reporting / Analytics | `[P]` | inexistente |
| Billing · Notifications · Tasks · Search · AI · Onboarding | — | **sem evidência — pós-MVP `[R]`** |

---

## 6. Gap Analysis

| Domínio | Existe | Falta | Depende de | Prio |
|---|---|---|---|---|
| ~~Messaging core~~ | adapters + idempotência inbound **+ outbound (E1/E4a)** | `Connection` (E3), status canônico (E2.1) | ADR-MSG-001 | **CONCLUÍDO parcialmente — E2.1/E3 restantes** |
| ~~Provider boundary~~ | `getProvider` em send/broadcast/engines/react | — | ADR-MSG-001 | **CONCLUÍDO — E1** |
| ~~Fronteira de criação de saída~~ | dono único (`delivery/`) | — | ADR-MSG-001 D6 · DLB-001 | **CONCLUÍDO — E1** |
| ~~Message identity~~ | `ExternalIdentity` + `message_external_ids` (047), R16 corrigido | consumidor (E2.1) | E1 · EIS-001 | **CONCLUÍDO — E2.0** |
| Status não-Meta | contrato canônico (`ADR-MSG-STATUS-001`, Fase 0) | implementação: parsers, escada e rota (Fase 1) | E2.0 ✅ | **P0 — Fase 0 concluída; Fase 1 é a próxima entrega (E2.1)** |
| ~~Outbound integrity~~ | intent→settle, `idempotency_key` | — | E1 | **CONCLUÍDO — E4a** |
| ~~Reliability async~~ | retry ledger, scheduler, orphan sweeper | — | E4a | **CONCLUÍDO — E4b** |
| Modelo `messages` | RLS via JOIN | `account_id`, `connection_id` | E2.0 | P1 |
| Multi-conexão | UNIQUE(account_id) | tabela `connections` | E2.0 | P1 |
| ~~Encryption~~ | ~~chave global~~ | ~~`key_version` + re-encrypt~~ | — | **CONCLUÍDO — E7, ver §7** |
| ~~Workspace identity~~ | 3 campos + RPC + UI (E5) | — | — | **CONCLUÍDO** |
| Attribution | captura + tabela + enriquecimento + ADR-ATTR-001/002 (Aceitos) | CAPI (fora do MVP, P3/P4) | E1 ✅ | **CONCLUÍDO — infraestrutura (E6)** |
| ~~Platform ops UI~~ | telas (E9) | — | — | **CONCLUÍDO** |
| Automations × Flows | ambos | decisão de convergência | ADR-AUT-001 | P2 |
| Public API | `/me` | recursos + enforcement | E3 | P2 |
| Reporting | dashboard | relatórios + export + UI de attribution (herdada de E6, reescopo 2026-07-30) | E6 ✅ | P2 |
| FKs / integridade | — | C16, C19, C20, C21 | E3 | P2 |
| Testes | ~60 arquivos | cross-tenant, matriz provider, retry | — | P1 |
| Observabilidade | `console.error` | correlation IDs, logs estruturados | E3 | P2 |

---

## 7. Épicos restantes

Épicos com contrato próprio remetem a ele; os demais mantêm forma condensada até entrarem na fila.

| ID | Nome | Objetivo | Contrato | Prio |
|---|---|---|---|---|
| **E0** | ADR Messaging Core | Congelar o modelo antes do código | `docs/adr/ADR-MSG-001.md` — **Aceito (2026-07-21)** | **CONCLUÍDO** |
| **E1** | Delivery Layer & Provider Boundary | Fronteira única de envio e de criação de mensagem de saída | `docs/architecture/DLB-001-delivery-layer-boundary.md` | **CONCLUÍDO** — commits `78bd7cd`, `b0f5988`; zero import direto de `meta-api` fora de `providers/`/`delivery/` |
| **E2.0** | Message Identity Correction | Conjunto de identidades; correção de R16 | `docs/architecture/EIS-001-external-identity-storage.md` | **CONCLUÍDO, subutilizado** — `zapi.ts` corrigido, migration 047; identidades gravadas sem consumidor até E2.1 fechar |
| **E2.1** | Status Canônico | Ciclo de vida da mensagem por resolução de identidade | `docs/adr/ADR-MSG-STATUS-001.md` + `docs/checkpoints/CHECKPOINT-E2.1-STATUS-CANONICAL.md` | **FASE 0 CONCLUÍDA** — contrato escrito e aprovado no gate de 2026-07-29 (`CHECKPOINT-E2.1` §9); Fase 1 (implementação) é a próxima entrega, sujeita às pré-condições de §17 |
| **E3** | Connections | Multi-conexão por workspace | a escrever | P1 — não iniciado |
| **E4a** | Outbound Delivery Integrity | persist-before-send, idempotency-key, estado `failed` | `docs/architecture/ODI-001-outbound-delivery-integrity.md` | **CONCLUÍDO** — commit `ef7e4f9` |
| **E4b** | Async Reliability | DLQ wiring + reprocesso | `ADR-E4B-001/002/003`, `ARO-001` | **CONCLUÍDO** — `docs/checkpoints/E4b-final-checkpoint.md`, commit `60b0565`, 691 testes verdes |
| **E5** | Workspace Commercial Identity | 3 campos + RPC + `/act/[accountId]/settings` | `docs/architecture/E5-workspace-commercial-identity.md` | **CONCLUÍDO** — commit `485b1e6` |
| **E6** | Attribution — Infraestrutura (reescopado 2026-07-30) | Captura + enriquecimento + ADR-ATTR-001/002 congelados | `docs/architecture/E6.0-attribution-enrichment-marketing-api.md`, `docs/checkpoints/CHECKPOINT-E6-FINAL.md` | **CONCLUÍDO** — UI de relatório reescopada para E12 (RPC `get_enrichment_report` e rota `/api/enrichment/report` já existem, zero consumidores de front-end); CAPI fora do MVP (P3/P4, decisão de Weyner 2026-07-29) |
| **E6.0** | Enrichment via Marketing API (sub-escopo de E6) | Enriquecer `lead_attributions` via Graph API + relatório mínimo | idem, status **Implementado e fechado** no doc | **CONCLUÍDO** — commit `2c4daef`, 57 testes verdes (incl. isolamento D-8); fechado em `docs/checkpoints/E6.0-final-checkpoint.md` (2026-07-29) |
| **E7** | Encryption Key Versioning | `key_version` + re-encrypt | `ADR-E7-001` + `IMP-E7-001` | **CONCLUÍDO (2026-07-27)** |
| **E8** | Integridade Referencial | C16, C19, C21 | a escrever | P2 — não iniciado |
| **E9** | Platform Operations UI | grant/revoke, assign, audit viewer, suspensão | a escrever | **CONCLUÍDO** — commit `2a2da71` |
| **E10** | ADR-AUT-001 + Convergência | Automations × Flows | a escrever | P2 — não iniciado |
| **E11** | Public API v1 Resources | Endpoints com escopos enforced | a escrever | P2 — não iniciado |
| **E12** | Reporting & Export | Relatórios e export, incluindo UI de relatório de attribution (herdada de E6, reescopo 2026-07-30) | a escrever | P2 — não iniciado, **desbloqueado** (E6 concluído em 2026-07-30) |
| **E13** | Observabilidade | Correlation IDs, logs estruturados | a escrever | P2 — não iniciado |

---

## 8. Grafo de dependências

```
                    E0 — ADR-MSG-001  (decisão, sem código)
                          │
        ┌─────────────────┼──────────────────┬──────────────────┐
        ↓                 ↓                  ↓                  ↓
   E1 Delivery Layer  E7 Encryption     E5 Workspace       E9 Platform
   & Provider          Versioning ✅    Identity           Ops UI
   Boundary            CONCLUÍDO        (independente)     (independente)
        │
        │  ◄── PRECEDÊNCIA DURA (DN-001, D-2)
        ↓
   E2.0 Message Identity Correction   ◄── R16 tratado AQUI
        │
        │  ◄── PRECEDÊNCIA DURA (ADR-MSG-001 §6.2)
        ├──────────────┐
        ↓              ↓
   E2.1 Status     E4a Outbound
   Canônico        Integrity
        │              │
        ↓              │
   E4b DLQ ◄───────────┘
        │
        ↓
   E3 Connections  (estrutural — a migration perigosa)
        │
   ┌────┼──────┬──────────┬──────────┐
   ↓    ↓      ↓          ↓          ↓
  E8   E11    E13        E10        E6 ✅ CONCLUÍDO (infraestrutura, 2026-07-30)
                                     E12 Reporting (herda UI de attribution de E6)
```

### 8.1 Cadeia de precedência dura

```
E1  →  E2.0  →  E2.1
```

Nenhum elo admite inversão. Os fundamentos são distintos e ambos normativos:

**E1 → E2.0** — `DN-001`, D-2. O critério 1 do `EIS-001` exige que toda mensagem criada após E2.0 possua identidade na mesma transação de sua criação. Mensagens de saída são criadas em quatro locais (§4), três dos quais são exatamente os call-sites que E1 unifica. **E2.0 não tem onde escrever até que E1 exista.** Não é ordenação de conveniência.

**E2.0 → E2.1** — `ADR-MSG-001` §6.2. Habilitar o ciclo de status antes da correção de identidade produz falha de correlação silenciosa em 100% das mensagens Z-API (R16). É a única precedência do ADR cuja violação causa dano sem sinal.

### 8.2 Demais bloqueadores

- **E0 bloqueia E1, E2.0, E2.1, E3.**
- **E3 bloqueia E8, E11, E13** — todos precisam de `messages.account_id`.
- ~~E6 bloqueia E12~~ — **removido 2026-07-30**: E6 concluído como infraestrutura; UI de relatório reescopada para E12, que agora está desbloqueado (não iniciado por prioridade, não por dependência).

### 8.3 Não é bloqueio

E2.1 **não** depende de E3. `message_id` já existe, `sender_type` já codifica direção, e coluna de direção não deve ser criada (`ADR-MSG-001`, invariante D). Não há ciclo entre E2 e E3.

### 8.4 Paralelos seguros

E5, E7 e E9 não dependem de messaging e podem avançar em paralelo a E0/E1.

---

## 9. Roadmap por fases

**FASE 0 — Decisão (sem código).** E0; opcionalmente E10 em paralelo. Único item cujo custo de adiamento é multiplicativo. Validação: ADR revisado adversarialmente e marcado `Aceito`. **Estado: CONCLUÍDA — `ADR-MSG-001 v4` promovido a `Aceito` em 2026-07-21, com D1 ratificada e N-3 reclassificado como risco aberto não-bloqueante (ADR §13). E1 liberado.**

**FASE 1 — Quick wins paralelos.** E5 e E7. Independentes do ADR, baixo risco. Validação: testes PGlite do RPC (4 cenários de autorização), partial update não apaga campos omitidos. **Estado: CONCLUÍDA — E5 (commit `485b1e6`) e E7 (5 fases, 2026-07-27) ambos fechados.**

**FASE 2 — P0 de Messaging.** **E1 → E2.0 → E2.1 → E4a → E4b.** Ordem obrigatória nos três primeiros (§8.1). **Estado (2026-07-29): E1, E2.0, E4a e E4b CONCLUÍDOS. Só falta E2.1** — único elo em aberto, aprovado como próxima épica oficial. Sem ele, mensagens Z-API/uazapi continuam travadas em `sent` e as identidades gravadas por E2.0 seguem sem consumidor. Validação: matriz provider×operação verde, **teste de R16 verde**, smoke manual em conta Meta antes do push.

**FASE 3 — Modelo de dados.** E3 → E8. Só depois que boundary e identidade estão corretos. Risco máximo do roadmap; ensaio em cópia de produção e rollback escrito antes de começar.

**FASE 4 — Produto.** E6 → E12, com E9 em paralelo. Validação: um lead de anúncio real rastreado do clique ao relatório. **Estado (2026-07-30): E9 CONCLUÍDO (commit `2a2da71`). E6 CONCLUÍDO como infraestrutura — enriquecimento (E6.0) fechado, ADR-ATTR-001/002 Aceitos (ver `docs/checkpoints/CHECKPOINT-E6-FINAL.md`). UI de relatório reescopada para E12; CAPI fora do MVP. E12 desbloqueado, não iniciado — sem dependência pendente.**

**FASE 5 — Maturidade.** E11, E13, execução de E10.

**Ciclo operacional por épico:**
```
ÉPICO → IMPLEMENTAÇÃO → TESTES → REVISÃO (agente distinto)
      → AUDITORIA (agente distinto) → COMMIT/PUSH → PRÓXIMO
```

---

## 10. Matriz de riscos

| # | Risco | Módulo | Prob. | Impacto | Sev. | Mitigação | Quando |
|---|---|---|---|---|---|---|---|
| R1 | Corrigir sintomas sobre modelo errado | Messaging | Alta | Alto | 🔴 | E0 antes de qualquer código | Agora |
| R2 | Migration de `messages` corrompe histórico | DB | Média | Crítico | 🔴 | E3 multi-etapa, ensaio em cópia, rollback escrito | Fase 3 |
| R3 | Cliente não-Meta com broadcast/automation quebrados em silêncio | Providers | Certa | Alto | 🔴 | E1 + capability negotiation com erro explícito | Fase 2 |
| R16 | **Z-API grava `zaapId` no envio e recebe `messageId` no status** | Identity | Certa | Alto | 🔴 | E2.0 antes de E2.1; `EIS-001` §6.1 e critérios 10–13 | Fase 2 |
| R4 | Rotação de `ENCRYPTION_KEY` derruba conexões | Security | Baixa | Crítico | 🟢 | E7 — **mitigado, concluído 2026-07-27** | Fase 1 |
| R5 | Novo RPC platform inventa contrato próprio | Platform | Média | Crítico | 🟠 | Template de 037/042; revisão de todo `SECURITY DEFINER` | Toda fase |
| R6 | Redelivery duplica efeitos colaterais | Messaging | Baixa | Alto | 🟡 | Invariante A vigente; preservar `inbound-processor.ts:324` | Toda fase |
| R7 | Delete de contato destrói conversas | Data | Média | Alto | 🟠 | E8 | Fase 3 |
| R8 | Delete de usuário cascateia domínio | Data | Baixa | Crítico | 🟠 | E8 + runbook | Fase 3 |
| R9 | Falha de envio invisível ao operador | Inbox | Alta | Médio | 🟠 | E4a | Fase 2 |
| R10 | DLQ morta + monitor falso-positivo em `QUICK_REFERENCE` | Webhooks | Média | Alto | 🟠 | E4b + correção da doc | Fase 2 |
| R11 | Full scan em `findExistingContact` | Contacts | Média | Médio | 🟡 | Índice funcional | Fase 3 |
| R12 | Dois motores de automação | Autom/Flows | Certa | Médio | 🟡 | E10 | Fase 5 |
| R13 | ADR-ATTR-001 nunca congelado | Attribution | Média | Alto | 🟠 | D3 (§15) | Fase 4 |
| R14 | Mídia não-Meta expira | Media | Média | Médio | 🟡 | Proxy/re-fetch | Fase 5 |
| R15 | Concorrência em webhooks simultâneos | Messaging | Média | Médio | 🟡 | Índice único + `ON CONFLICT`; validar `unread_count` | Fase 3 |
| R17 | **E2.0 iniciado sem E1** — criação de saída dispersa impede o critério 1 | Identity | Média | Alto | 🟠 | Precedência dura §8.1; `DN-001` §6 | Fase 2 |

---

## 11. Estratégia por agentes

**Princípio inegociável:** quem implementa não revisa; quem revisa não audita. Toda auditoria declara o SHA auditado e confirma working tree limpa (lição do `AUD-001 §0`).

**Revisão adversarial.** Toda crítica é hipótese até ser arbitrada no código. Revisor sem acesso ao repositório produz hipóteses, não achados — o achado de maior valor deste roadmap (R16) surgiu ao verificar uma premissa que um revisor havia inventado. Crítica com premissa falsa e conclusão verdadeira conta como acerto e é registrada com a evidência real.

| Épico | Implementador | Testes | Revisão | Auditoria |
|---|---|---|---|---|
| E0 ADR | `arquiteto` | — | 2º modelo com acesso ao repo | — |
| E1 | `dev` | `qa` | `code-reviewer` | `doc-auditor` |
| E2.0 | `dev` + `data-engineer` | `qa` | `code-reviewer` | — |
| E2.1 | `dev` | `qa` | `code-reviewer` | auditoria de dados |
| E3 | **`data-engineer` dedicado** | `qa` + PGlite | `code-reviewer` | **independente obrigatória** |
| E4a / E4b | `dev` | `qa` | `code-reviewer` | — |
| E5 | `dev` | `qa` | `code-reviewer` | — |
| E6 | `arquiteto` → `dev` | `qa` | `code-reviewer` | `design-review` |
| E9 | `dev` + `ux-expert` | `browser-tester` | `design-review` | — |
| E11 | `dev` | `qa` | `code-reviewer` + security | — |

---

## 12. Estratégia de testes

Ativo a preservar `[C]`: ~60 arquivos, com testes PGlite reais de RPC e RLS.

| Lacuna | Como fechar | Épico |
|---|---|---|
| Matriz provider × operação | `{meta,zapi,uazapi} × {text,media,template,reaction}` | E1 |
| **Correlação de identidade (R16)** | Regressão que **deve falhar** contra `c8f1585` | E2.0 |
| Precedência identidade × fallback | `EIS-001` critério 14 | E2.0 |
| Isolamento cross-tenant no fallback | `EIS-001` critério 15 | E2.0 |
| Cross-tenant em `messages` | PGlite, com e sem `account_id` | E3 |
| Webhook duplicado / redelivery | 1 linha **e** 1 disparo de flow | E2.0/E2.1 |
| Retry / double-send | 429 → retry com idempotency-key → 1 mensagem | E4a |
| DLQ | Enfileira, reprocessa, para após N tentativas | E4b |
| Late status fora de ordem | `delivered` após `read` não regride | E2.1 |
| Backfill de migration | Reexecutável; contagem preservada | E3 |
| Autorização de RPC novo | 4 cenários → todos `42501` | E5, E9 |

**Gate de "pronto":** `tsc --noEmit` limpo, `vitest run` verde, `next build` verde, teste PGlite para todo RPC novo.

---

## 13. Definição de MVP completo

**Plataforma** — [x] operadores + escopo · [x] contexto `/act` auditado · [x] provisionamento com Owner · [x] identidade comercial (E5) · [x] UI de operadores (E9)
**Workspaces** — [x] criação · [x] currency · [x] CNPJ na criação · [x] edição pós-criação (E5)
**Usuários** — [x] signup/login/reset · [x] convites · [x] papéis · [x] transferência de ownership
**CRM** — [x] contatos + tags + custom fields + notas + import · [x] pipelines/deals · [ ] busca global `[R]`
**Comunicação** — [x] inbox realtime · [x] mídia · [x] reactions (Meta) · [x] templates Meta · [x] **fronteira de entrega (E1)** · [x] **identidade correta (E2.0)** · [ ] **status não-Meta (E2.1) — próxima épica**
**Automação** — [x] automations · [x] flows · [x] **envio provider-agnóstico (E1)**
**Operação** — [x] falha de envio visível (E4a) · [x] DLQ ligada (E4b)
**Segurança** — [x] RLS em 33 tabelas · [x] auth do webhook não-Meta · [x] rate-limit · [x] versionamento de chave (E7, concluído 2026-07-27)
**Auditoria** — [x] `platform_audit_log` · [ ] visualizador (E9)
**Testes** — [x] suíte + PGlite · [ ] matriz de provider (E1) · [ ] regressão R16 (E2.0) · [ ] cross-tenant (E3)
**Deploy** — [x] CI · [?] pipeline de migration em produção — confirmar (D7)

**Produção, além do MVP:** multi-conexão (E3), integridade referencial (E8), observabilidade (E13), runbook de migration e rollback, monitoramento pós-deploy automatizado.

---

## 14. Itens pós-MVP

Não requisitos até decisão explícita: billing/assinatura, notificações, tarefas e atividades, busca full-text, IA, webhooks de saída, onboarding guiado, export completo (LGPD), SSO/MFA, apps móveis.

---

## 15. Decisões arquiteturais pendentes

| # | Decisão | Impacto | Decisor |
|---|---|---|---|
| **D1** | `Connection` como unidade vs. manter `whatsapp_config` | Estrutural, bloqueia tudo. Sustentada após revisão adversarial | Arquiteto + Weyner |
| **D2** | Automations e Flows convergem ou coexistem? | Dobra manutenção | Produto |
| **D4** | Backfill do histórico `delivered` → `received`? | Consistência histórica | Arquiteto + data |
| **D5** | Dois números no mesmo tenant → uma ou duas conversas? | Modelo de conversa | Produto |
| **D6** | Providers não-oficiais suportam equivalente a template? | Escopo de E1 | Pesquisa |
| **D7** | Pipeline de migration em produção: manual ou automatizado? | Risco de deploy | Ops |

**D3 — resolvida em 2026-07-29, removida da tabela.** Era *"ADR-ATTR-001: congelar ou revogar?"*. Decisão: **congelar**. `ADR-ATTR-001` promovido a **Aceito** (§11 do próprio ADR) e `ADR-ATTR-002` a **Aceito** (§14), ambos com evidência verificada contra código real — ver v1.5 acima e `CHECKPOINT-E6-FINAL.md`. **A numeração D1–D7 é preservada deliberadamente**: `D4` (backfill `delivered` → `received`) é referenciada por identificador em `ADR-MSG-001` §7/D7 e em `ADR-MSG-STATUS-001`; renumerar quebraria essas referências.

**Pendências abertas nos contratos:** N-3 (dedup de efeitos no caminho de saída, `ADR-MSG-001` §11) · convivência `delivered`/`received` sem portador documental (`EIS-001` §10) · retenção de variante de evento não reconhecida (`ADR-MSG-001` D3).

---

## 16. Contratos de implementação

Contratos escritos vivem em arquivo próprio e **não são duplicados aqui**:

| Épico | Contrato |
|---|---|
| E0 | `docs/adr/ADR-MSG-001.md` |
| E1 | `docs/architecture/DLB-001-delivery-layer-boundary.md` |
| E2.0 | `docs/architecture/EIS-001-external-identity-storage.md` + `docs/architecture/DN-001-eis001-implementation-preconditions.md` |

### E5 — Workspace Commercial Identity (sem contrato próprio; executável em paralelo)

```
MIGRATION  0XX_accounts_commercial_identity.sql
  ADD COLUMN IF NOT EXISTS legal_name TEXT NULL
  ADD COLUMN IF NOT EXISTS commercial_phone TEXT NULL
  ADD COLUMN IF NOT EXISTS commercial_email TEXT NULL
  -- NÃO recriar cnpj (existe desde 041). Idempotente. Nenhuma RLS alterada.
  -- Numeração definida no momento da execução: E2.0 reserva 047.

RPC  update_platform_workspace_identity(
       p_account_id, p_name, p_legal_name, p_cnpj,
       p_commercial_phone, p_commercial_email)
  SECURITY DEFINER · SET search_path = public
  REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated
  AUTORIZAÇÃO: auth.uid() NOT NULL
             + platform_operators.role='admin' AND is_active
             + can_access_account(p_account_id)   → falha = 42501
  SEMÂNTICA: PARTIAL UPDATE — NULL = "não altere", nunca "apague"
  AUDIT: action='update_workspace_identity', actor = auth.uid(),
         metadata dos campos alterados, mesma transação

UI  src/app/act/[accountId]/settings/page.tsx
  requirePlatformContext() no layout existente. Read-then-write.
  Nenhuma escrita client-side direta em `accounts`.

TESTES  4 cenários de autorização + partial update + audit row

PROTEGIDO — NÃO TOCAR
  src/app/api/account/route.ts · src/lib/contacts/*
  supabase/migrations/001–046 (só ADICIONAR) · platform-contact-detail-view.tsx
```

---

## 17. Atualização Operacional (pós v1.4)

### Epic E2.1 — Canonical Message Status

**Status atual**

- ✅ Fase 0 concluída
- ✅ `ADR-MSG-STATUS-001` aprovado
- ✅ `CHECKPOINT-E2.1-STATUS-CANONICAL` aprovado
- ⏳ Fase 1 (Implementação) ainda não iniciada

**Pré-condições obrigatórias antes da implementação**

- **R1:** Capturar payloads reais de callbacks de status (Z-API/uazapi). **Aberta.** Depende de ambiente externo (painel do provider + aparelho real); será tratada em ciclo próprio. ⚠️ A captura não é operação neutra: apontar o webhook de status para o endpoint de produção **dispararia D-C**, caso ele seja real. A captura deve ir para um coletor inerte, nunca para `/api/whatsapp/webhook/zapi/...`.

- **R2:** Quantificar a incidência do defeito D-C. **Medição realizada — pendência é de formalização de evidência, não técnica.**

  Consulta somente-leitura ao banco de produção, executada em 2026-07-29:

  | Métrica | Valor |
  |---|---|
  | `messages` — total | 172 |
  | `messages` — `sender_type = 'customer'` | 167 |
  | Fantasmas: cliente + `message_id = ''` | **0** |
  | Fantasmas: cliente + `message_id IS NULL` | **0** |
  | Fantasmas (estrito): + `content_text IS NULL` | **0** |
  | `whatsapp_webhook_dlq` — linhas | 0 |

  **Resultado: incidência zero.** D-C é risco **latente, nunca materializado** — coerente com o fato de apenas o webhook "Ao receber" ter sido apontado ao endpoint (`CHECKPOINT-FORCECRM-GROUP-B-RESULT.md` §3.1); o webhook de status nunca chegou à aplicação. Isso **não invalida D-C**, que permanece confirmado como defeito de código (o parser de entrada Z-API não discrimina pelo campo `type` do envelope — `ADR-MSG-STATUS-001` §2.6/D-C).

  **Evidência atual: consulta operacional não versionada.** Foi executada em sessão, por script efêmero fora do repositório; não há artefato reproduzível commitado. Por isso R2 **permanece aberta apenas quanto à formalização** — o que falta é um artefato versionado e reexecutável que sustente o número, não investigação adicional.

O roadmap continua correto ao dizer que a implementação da E2.1 não começou; este registro reflete que a fase arquitetural já foi encerrada.
