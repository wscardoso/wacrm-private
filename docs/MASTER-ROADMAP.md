# WACRM/FORCECRM — MASTER ROADMAP

**Versão:** v1.2 · **Snapshot auditado:** HEAD `c8f1585`, working tree limpa
**Fonte de verdade do escopo restante.** Documentos normativos derivados: `docs/adr/ADR-MSG-001.md`, `docs/architecture/EIS-001-external-identity-storage.md`, `docs/architecture/DN-001-eis001-implementation-preconditions.md`, `docs/architecture/DLB-001-delivery-layer-boundary.md`.

**Legenda de confiança:** `[C]` confirmado no código · `[I]` inferido · `[P]` planejado em doc · `[R]` recomendação · `[?]` desconhecido.

**Histórico**
- **v1.0** — mapa inicial produzido por reconhecimento do repositório.
- **v1.1** — após revisão adversarial arbitrada no código: E2.0 criado, `message_external_ids` substitui `external_id` único, R16 registrado, E4 dividido em E4a/E4b, E0 corrigido quanto a invariantes vigentes.
- **v1.2** — persistência como artefato versionado; cadeia de precedência dura `E1 → E2.0 → E2.1` registrada conforme `DN-001`; §8 e §9 atualizados; §16 remete aos contratos derivados em vez de duplicá-los.

---

## 1. Executive Summary

O projeto está num estado assimétrico:

- **A camada de tenant (member-side) é madura** `[C]`. Contatos, inbox, pipelines, broadcasts, automations, flows, templates Meta, API keys e settings existem ponta a ponta, com RLS em 33 tabelas e ~60 arquivos de teste.
- **A camada de Platform é recente e estreita** `[C]`. Fundação de autorização (037), contexto read-only (038), discovery (039), contatos e inbox read-only em `/act/[accountId]`, provisionamento de Workspace com Owner obrigatório (041–046, fechado em `c8f1585`). Não há tela de escrita platform-side além da criação de Workspace.
- **A camada de messaging é o débito dominante** `[C]`. Dos 22 achados do `AUD-001`, apenas C4, C7 e C15 foram fechados. Os 19 restantes seguem abertos, incluindo os quatro críticos de provider boundary (C1, C2, C3, C5).

**O produto tem multi-provider no papel e Meta-only no runtime.** Broadcasts, reactions, automations e flows importam `meta-api` diretamente `[C]`. Um workspace em Z-API/uazapi recebe mensagens mas não dispara automação, broadcast ou reaction, e suas mensagens ficam travadas em `sent`.

**R16 — achado crítico não detectado por nenhuma das quatro auditorias.** `zapi.ts` grava `data.zaapId ?? data.messageId` no envio (6 call-sites) e lê `msg.messageId` no inbound `[C]`. Ligar o status não-Meta sem corrigir isso quebraria a correlação em 100% das mensagens Z-API, silenciosamente. Endereçado em E2.0, especificado em `EIS-001`.

**Cadeia de precedência dura, registrada em `DN-001`:** `E1 → E2.0 → E2.1`. Não é ordenação de conveniência — E2.0 não tem onde escrever até que E1 exista (§8).

**Risco de fundo:** o North Star (atribuição CTWA) está implementado a meio caminho e sem dono formal — `033`, `attribution.ts` e testes existem `[C]`, mas `ADR-ATTR-001` segue "Proposto". Ver D3 em §15.

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
| Messaging core | adapters + idempotência inbound | `Connection`, status canônico, outbox | ADR-MSG-001 | **P0** |
| Provider boundary | `getProvider` em send | engines/broadcast/react | ADR-MSG-001 | **P0** |
| **Fronteira de criação de saída** | dispersa em 4 locais | dono único | ADR-MSG-001 D6 · DLB-001 | **P0** |
| Message identity | `message_id` + índice parcial | conjunto de identidades; correção Z-API | E1 · EIS-001 | **P0** |
| Status não-Meta | — | `parseEvents` + rota | E2.0 | **P0** |
| Outbound integrity | — | persist-before-send, idempotency-key | E1 | **P0** |
| Reliability async | tabela DLQ | wiring + cron | E2.1 | P1 |
| Modelo `messages` | RLS via JOIN | `account_id`, `connection_id` | E2.0 | P1 |
| Multi-conexão | UNIQUE(account_id) | tabela `connections` | E2.0 | P1 |
| Encryption | chave global | `key_version` + re-encrypt | — | P1 |
| Workspace identity | cnpj (só criação) | 3 campos + RPC + UI | — | P1 |
| Attribution | captura + tabela | enriquecimento, UI, relatório, CAPI | E1 | **P1** |
| Platform ops UI | RPCs prontos | telas | — | P2 |
| Automations × Flows | ambos | decisão de convergência | ADR-AUT-001 | P2 |
| Public API | `/me` | recursos + enforcement | E3 | P2 |
| Reporting | dashboard | relatórios + export | E6 | P2 |
| FKs / integridade | — | C16, C19, C20, C21 | E3 | P2 |
| Testes | ~60 arquivos | cross-tenant, matriz provider, retry | — | P1 |
| Observabilidade | `console.error` | correlation IDs, logs estruturados | E3 | P2 |

---

## 7. Épicos restantes

Épicos com contrato próprio remetem a ele; os demais mantêm forma condensada até entrarem na fila.

| ID | Nome | Objetivo | Contrato | Prio |
|---|---|---|---|---|
| **E0** | ADR Messaging Core | Congelar o modelo antes do código | `docs/adr/ADR-MSG-001.md` (v4, Proposto) | **P0** |
| **E1** | Delivery Layer & Provider Boundary | Fronteira única de envio e de criação de mensagem de saída | `docs/architecture/DLB-001-delivery-layer-boundary.md` | **P0** |
| **E2.0** | Message Identity Correction | Conjunto de identidades; correção de R16 | `docs/architecture/EIS-001-external-identity-storage.md` | **P0** |
| **E2.1** | Status Canônico | Ciclo de vida da mensagem por resolução de identidade | a escrever | **P0** |
| **E3** | Connections | Multi-conexão por workspace | a escrever | P1 |
| **E4a** | Outbound Delivery Integrity | persist-before-send, idempotency-key, estado `failed` | a escrever | **P0** |
| **E4b** | Async Reliability | DLQ wiring + reprocesso | a escrever | P1 |
| **E5** | Workspace Commercial Identity | 3 campos + RPC + `/act/[accountId]/settings` | §16 | P1 |
| **E6** | Attribution End-to-End | Congelar ADR-ATTR-001, enriquecimento, UI, CAPI | a escrever | **P1** |
| **E7** | Encryption Key Versioning | `key_version` + re-encrypt | a escrever | P1 |
| **E8** | Integridade Referencial | C16, C19, C21 | a escrever | P2 |
| **E9** | Platform Operations UI | grant/revoke, assign, audit viewer, suspensão | a escrever | P2 |
| **E10** | ADR-AUT-001 + Convergência | Automations × Flows | a escrever | P2 |
| **E11** | Public API v1 Resources | Endpoints com escopos enforced | a escrever | P2 |
| **E12** | Reporting & Export | Relatórios e export | a escrever | P2 |
| **E13** | Observabilidade | Correlation IDs, logs estruturados | a escrever | P2 |

---

## 8. Grafo de dependências

```
                    E0 — ADR-MSG-001  (decisão, sem código)
                          │
        ┌─────────────────┼──────────────────┬──────────────────┐
        ↓                 ↓                  ↓                  ↓
   E1 Delivery Layer  E7 Encryption     E5 Workspace       E9 Platform
   & Provider          Versioning       Identity           Ops UI
   Boundary            (independente)   (independente)     (independente)
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
  E8   E11    E13        E10        (E6 já liberado por E1)
                                     E6 Attribution ──→ E12 Reporting
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
- **E6 bloqueia E12.**

### 8.3 Não é bloqueio

E2.1 **não** depende de E3. `message_id` já existe, `sender_type` já codifica direção, e coluna de direção não deve ser criada (`ADR-MSG-001`, invariante D). Não há ciclo entre E2 e E3.

### 8.4 Paralelos seguros

E5, E7 e E9 não dependem de messaging e podem avançar em paralelo a E0/E1.

---

## 9. Roadmap por fases

**FASE 0 — Decisão (sem código).** E0; opcionalmente E10 em paralelo. Único item cujo custo de adiamento é multiplicativo. Validação: ADR revisado adversarialmente e marcado `Aceito`. **Estado: CONCLUÍDA — `ADR-MSG-001 v4` promovido a `Aceito` em 2026-07-21, com D1 ratificada e N-3 reclassificado como risco aberto não-bloqueante (ADR §13). E1 liberado.**

**FASE 1 — Quick wins paralelos.** E5 e E7. Independentes do ADR, baixo risco. Validação: testes PGlite do RPC (4 cenários de autorização), partial update não apaga campos omitidos.

**FASE 2 — P0 de Messaging.** **E1 → E2.0 → E2.1 → E4a → E4b.** Ordem obrigatória nos três primeiros (§8.1). É o que hoje quebra clientes reais fora do Meta. Validação: matriz provider×operação verde, **teste de R16 verde**, smoke manual em conta Meta antes do push.

**FASE 3 — Modelo de dados.** E3 → E8. Só depois que boundary e identidade estão corretos. Risco máximo do roadmap; ensaio em cópia de produção e rollback escrito antes de começar.

**FASE 4 — Produto.** E6 → E12, com E9 em paralelo. Validação: um lead de anúncio real rastreado do clique ao relatório.

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
| R4 | Rotação de `ENCRYPTION_KEY` derruba conexões | Security | Baixa | Crítico | 🟠 | E7 | Fase 1 |
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

**Plataforma** — [x] operadores + escopo · [x] contexto `/act` auditado · [x] provisionamento com Owner · [ ] identidade comercial (E5) · [ ] UI de operadores (E9)
**Workspaces** — [x] criação · [x] currency · [x] CNPJ na criação · [ ] edição pós-criação (E5)
**Usuários** — [x] signup/login/reset · [x] convites · [x] papéis · [x] transferência de ownership
**CRM** — [x] contatos + tags + custom fields + notas + import · [x] pipelines/deals · [ ] busca global `[R]`
**Comunicação** — [x] inbox realtime · [x] mídia · [x] reactions (Meta) · [x] templates Meta · [ ] **fronteira de entrega (E1)** · [ ] **identidade correta (E2.0)** · [ ] **status não-Meta (E2.1)**
**Automação** — [x] automations · [x] flows · [ ] **envio provider-agnóstico (E1)**
**Operação** — [ ] falha de envio visível (E4a) · [ ] DLQ ligada (E4b)
**Segurança** — [x] RLS em 33 tabelas · [x] auth do webhook não-Meta · [x] rate-limit · [ ] versionamento de chave (E7)
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
| **D3** | ADR-ATTR-001: congelar ou revogar? Código implementado, ADR "Proposto" | North Star | **Weyner** |
| **D4** | Backfill do histórico `delivered` → `received`? | Consistência histórica | Arquiteto + data |
| **D5** | Dois números no mesmo tenant → uma ou duas conversas? | Modelo de conversa | Produto |
| **D6** | Providers não-oficiais suportam equivalente a template? | Escopo de E1 | Pesquisa |
| **D7** | Pipeline de migration em produção: manual ou automatizado? | Risco de deploy | Ops |

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
