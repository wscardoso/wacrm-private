# GATE-EVIDENCE — E2.1 Activation · Reconciliação das auditorias externas de 2026-08-03

| | |
|---|---|
| **Tipo** | Pacote de evidências para Gate de auditoria (pré-commit do ciclo E2.1 Activation) |
| **Autor** | Implementation Engineer (Claude/Cowork) |
| **Destinatário** | Auditor independente (Gate 3 do processo de governança) |
| **Data** | 2026-08-03 |
| **HEAD local** | `90739ff64f061a85bdc9e30000c60d69e516b90d` (branch `main`) |
| **SHA auditado externamente** | `0711fbbb67b0c1218d2c7841399ef20aa9c1de0b` — ancestral do HEAD local (3 commits atrás, todos documentais) |
| **Working tree** | 32 entradas não commitadas/não rastreadas (inventário na §2) |
| **Diff consolidado** | `GATE-EVIDENCE-E2.1-ACTIVATION-2026-08-03.diff` (mesmo diretório; exclui `package-lock.json`) |

---

## 1. Contexto

Em 2026-08-03 três auditorias externas (Hermes Agent) foram executadas contra o clone
GitHub em `0711fbbb`: (a) auditoria técnica independente (F-01…F-10), (b) auditoria de
conformidade ADR (divergências 1–20), (c) análise de riscos de produção (P1…P6, parcial).

**Constatação central desta reconciliação:** o snapshot auditado não continha o
working tree local. Parte substancial do ciclo E2.1 Activation **já está implementada
localmente e não commitada** — invisível para o auditor. Vários achados classificados
como "Crítica/Certa" já estão resolvidos no working tree; outros permanecem válidos e
são confirmados linha a linha abaixo. Duas afirmações factuais das auditorias são
**falsas** (§5).

Toda evidência desta seção em diante foi verificada diretamente no checkout local por
mim (comandos de reprodução na §7), em cumprimento à regra de que evidência citada por
terceiros não entra em gate sem verificação própria.

---

## 2. Inventário do working tree (32 entradas, dois workstreams distintos)

### 2.1 Workstream A — E2.1 Activation (objeto DESTE gate)

Arquivos rastreados modificados (ver diff consolidado):

| Arquivo | Δ | Conteúdo |
|---|---|---|
| `src/lib/whatsapp/providers/types.ts` | +27 | `parseStatusEvent(payload): CanonicalStatusEvent[]` adicionado à interface `WhatsAppProvider`, com contrato D9/D5/D8/A6/I5 documentado inline |
| `src/lib/whatsapp/providers/zapi.ts` | +65 | `parseStatusEvent` Z-API (MessageStatusCallback, `ids[]` → N eventos) |
| `src/lib/whatsapp/providers/uazapi.ts` | +86 | `parseStatusEvent` uazapi (`MESSAGES_UPDATE`, envelope `{event, data:{messages[]}}`) |
| `src/lib/whatsapp/providers/meta.ts` | +53 | `parseStatusEvent` Meta (paridade de contrato; rota Meta ainda NÃO consome — ver §4.3) |
| `.../webhook/[provider]/[connectionId]/[webhookSecret]/route.ts` | +59/−12 | Dispatch **status-first** (ADR-MSG-STATUS-001 §2.11, D-C): `parseStatusEvent` antes de qualquer parsing inbound; eventos roteados para `handleCanonicalStatusEvent`; aplicações independentes por evento (I5); resposta com `statusProcessed`/`inboundProcessed` |
| `src/lib/whatsapp/providers/webhook-auth.test.ts` | ±5 | Ajuste de teste |
| `package.json` | +2 | `pg` + `@types/pg` (devDependencies, suporte a testes) |

Arquivos novos (untracked) do workstream A:

- `supabase/migrations/063_messages_status_canonical.sql` — 50 linhas; CHECK aditivo
  para os 7 estados canônicos (`pending`/`received` adicionados), reexecutável, sem
  backfill (D4 permanece aberta), com comentário de coluna citando D2/D3/D6.
- `src/lib/whatsapp/providers/parse-status.test.ts` — 218 linhas, testes dos parsers
  de status dos adapters.
- `src/lib/whatsapp/providers/dc-discovery.test.ts` — teste adicional de providers.

### 2.2 Workstream B — HOTFIX-001 (identidade BR + merge de contatos; FORA deste gate)

`docs/HOTFIX-001.md` (plano, pós-Gate de revisão), `docs/adr/ADR-IDENTITY-BR-001.md`,
`docs/adr/ADR-CONTACT-MERGE-001.md`, `docs/reference/`, migrations `064`–`072`,
`scripts/backfill-identity-merge.mjs`, `scripts/generate-ddd-constants.mjs`,
`scripts/rotate-zapi-webhook.mjs`, `src/lib/whatsapp/phone-identity.ts`,
`src/test/identity-merge.pglite.test.ts`, `src/test/identity-smoke.pglite.test.ts`.

Os checkpoints HOTFIX-001 (homologação, deploy readiness, pós-deploy) são exatamente os
3 commits entre o SHA auditado e o HEAD local. Este workstream deve ter gate próprio;
está listado aqui apenas para explicar o working tree e evitar commit misto.

### 2.3 Infra local (fora de qualquer gate)

`.claude/settings.json`, `.claude/settings.local.json`, `package-lock.json` (regen).

---

## 3. Mapa achado → estado real

Legenda de veredicto: **CONFIRMADO** (válido no working tree atual) ·
**RESOLVIDO-WT** (já resolvido no working tree, não commitado) ·
**FALSO** (afirmação factual incorreta da auditoria) ·
**PARCIAL** (parte resolvida, parte pendente).

| # | Achado (fonte) | Veredicto | Evidência local verificada |
|---|---|---|---|
| F-01 / Div-5 | Fallback de resolução exclui `sender_type='bot'` | **CONFIRMADO** | `src/lib/message/resolve-by-external-id.ts:120` → `.eq('sender_type', 'agent')`. Handler aceita `agent`+`bot` (`status-handler.ts:60`). Bug real, correção de 1 linha + testes. |
| F-02 / Div-1, Div-2 | Handler canônico sem wiring; adapters sem parsing de status | **RESOLVIDO-WT** (não-Meta) / **PARCIAL** (Meta) | Interface: `types.ts:176`. Adapters: `zapi.ts:341`, `uazapi.ts:355`, `meta.ts:229`. Rota não-Meta: dispatch status-first chamando `handleCanonicalStatusEvent` (route, diff §4.1). Rota Meta ainda usa `handleStatusUpdate` legado (`webhook/route.ts:278,392`). |
| F-05 / Div-3 | Migration 063 ausente | **RESOLVIDO-WT** | `supabase/migrations/063_messages_status_canonical.sql` existe no working tree (untracked). Conteúdo íntegro (§2.1). |
| F-03 / Div-4 | Inbound persiste `delivered` em vez de `received` | **CONFIRMADO** | `inbound-processor.ts:309` e `webhook/route.ts:695` → `p_status: 'delivered'`. Correção sequenciada após aplicar a 063 (ordem correta: migration → código). |
| F-04 / Div-6 | Sinais D8 só em `console.warn` | **CONFIRMADO** | `status-handler.ts:73-78,84-86`. Decisão de superfície persistente (DLQ vs tabela própria) segue pendente — é pré-condição 5 do §8 do checkpoint RC1 e item de decisão DESTE gate. |
| Div-7 / P1 | ACK prematuro no webhook Meta | **CONFIRMADO** | `webhook/route.ts:247-252`: `processWebhook(body).catch(...)` + `200` imediato. Em serverless, risco real de perda pós-ACK. Sem uso da DLQ no catch. |
| Div-8 / P3 | RPC `insert_message_external_ids` sem validação de tenant | **CONFIRMADO** | `047_message_external_ids.sql:70-88`: corpo da função não valida `auth.uid()`/membership; `GRANT EXECUTE TO authenticated`. O `is_account_member` da migration está apenas na policy de **SELECT** (linha 57) — a escrita via RPC está aberta a qualquer autenticado. Achado de segurança mais sério do conjunto. |
| Div-9 / P4 | DLQ (031) sem RLS nem grants restritivos | **CONFIRMADO** | `031_webhook_dlq.sql`: zero ocorrências de `ROW LEVEL SECURITY` / `GRANT` / `REVOKE`. |
| Div-10 | Segredo de webhook no path da URL | **CONFIRMADO** | Estrutura da rota inalterada. Mitigação real; priorizar em ciclo de segurança (nota: rotação de segredo Z-API já executada 2026-07-28). |
| Div-11 | Comparação não constante no cron de automations | **CONFIRMADO** | `automations/cron/route.ts:23` → `supplied !== expected`. |
| Div-12 | RPC de credencial retorna ciphertext | **PARCIAL** | Tabela 055 restringe SELECT direto a `service_role` (por design, o job E6.0 lê ciphertext). A afirmação sobre `RETURNING to_jsonb(...)` na RPC de escrita merece verificação pontual no gate — baixa severidade. |
| Div-13/14/15 | Retry sem `idempotency_key`; template perde parâmetros; falha de enqueue vira `noop` | **CONFIRMADO** (não reverificado linha a linha) | Coerentes com ADR-E4B/ODI-001 conhecidos; escopo de ciclo E4-hardening, não deste gate. |
| F-07 | Timestamps não normalizados por adapter | **PARCIAL** | Novo contrato `parseStatusEvent` NORMALIZA para ms-epoch no adapter (types.ts, doc inline). Caminho Meta legado (`route.ts:430`, `*1000` fixo) permanece até a convergência da rota Meta. |
| F-08 | Lockfile ausente | **FALSO** | Ver §5.1. |
| Div-18 | Checkpoint RC1 mente sobre migration "no working tree" | **FALSO** | Ver §5.2. |
| F-06 / P2 | Callback de status Z-API vira inbound/descartado | **RESOLVIDO-WT** | Exatamente o cenário D-C que o dispatch status-first do route corrige: status é extraído ANTES de qualquer interpretação inbound; envelope uazapi `{data: objeto}` nunca passa pelo unwrap de array inbound. Coberto por `parse-status.test.ts`. |
| F-09 | Webhook Meta monolítico | **CONFIRMADO** | Dívida documentada; convergência é ciclo próprio (pós-ativação). |
| F-10 / Div-17 | Observabilidade `console.*`; roadmap defasado (`26e5d39`) | **CONFIRMADO** | `MASTER-ROADMAP.md:3` ainda declara snapshot `26e5d39`. E13 não iniciado. |
| Div-19/20 | Contratos "Propostos" não promovidos; ADR-E7-001 contraditório | **CONFIRMADO** | Dívida documental já registrada no checkpoint de governança de 2026-07-29. |

---

## 4. Evidências-chave (excertos verificados)

### 4.1 Dispatch status-first na rota não-Meta (working tree)

```
route.ts (diff): parseStatusEvent(payload) executado ANTES do parsing inbound;
se statusEvents.length > 0 → loop com handleCanonicalStatusEvent(ev, config.id)
por evento (I5: falha de um não suprime os demais) → retorna statusProcessed,
SEM tocar o pipeline inbound. Caso contrário, caminho inbound pré-E2.1 inalterado.
```

Diff completo em `GATE-EVIDENCE-E2.1-ACTIVATION-2026-08-03.diff`.

### 4.2 Migration 063 (working tree)

CHECK aditivo com os 7 estados (D2), reexecutável (`DROP ... IF EXISTS`), sem backfill
(D4 aberta), comentário de coluna com a semântica D2/D3/D6. 50 linhas.

### 4.3 O que o working tree NÃO resolve (pendências reais do gate)

1. F-01 — fallback `bot` (1 linha + testes).
2. Rota Meta: `handleStatusUpdate` legado (route:278) coexiste com o handler canônico
   → duas autoridades de escrita de `messages.status`.
3. ACK prematuro Meta (route:247-252).
4. `p_status: 'received'` nos dois pipelines inbound (após 063 aplicada).
5. Persistência D8 (decisão de superfície: reuso da DLQ 031 — que por sua vez precisa
   de RLS — ou tabela própria).
6. Segurança RPCs 031/047 (ciclo próprio recomendado, mas 031 interage com a decisão D8).
7. Fixtures reais de payload Z-API/uazapi (testes atuais usam fixtures construídas).

---

## 5. Erros factuais das auditorias externas

### 5.1 F-08 ("não existe lockfile") — FALSO

`git ls-tree 0711fbbb --name-only | grep lock` → `package-lock.json` presente **no
próprio SHA auditado** (último commit relevante: `cd937ae` "chore: regenerate
package-lock.json (fix npm ci on Coolify)"). O `ENOTEMPTY` do auditor foi falha do
ambiente dele, não do repositório. Todo o bloco F-08 (e a melhoria P1 nº 9) cai.

### 5.2 Div-18 ("checkpoint afirma falsamente migration no working tree") — FALSO

O checkpoint RC1 afirmou que a migration 063 estava escrita e **no working tree** — e
ela está exatamente lá (untracked, portanto invisível num clone do GitHub). A acusação
de "afirmação factual incorreta" decorre da limitação de visibilidade do auditor.
Permanece válida, porém, a lição operacional: artefato citado em checkpoint deveria ser
commitado (ou o checkpoint deveria declarar explicitamente "untracked, pendente de
gate") para ser auditável externamente.

---

## 6. Decisões solicitadas ao Auditor neste gate

1. **Aprovar/reprovar o wiring status-first** da rota não-Meta + `parseStatusEvent` nos
   3 adapters + migration 063 + testes, como fechamento da Fase 1 do E2.1 para
   providers não-Meta (escopo do diff consolidado + arquivos §2.1).
2. **Decidir a superfície D8** (pré-condição 5 do checkpoint RC1): reuso da
   `whatsapp_webhook_dlq` (exige endurecer a 031) vs tabela dedicada de eventos de
   status rejeitados.
3. **Ratificar o sequenciamento** proposto: (a) commit do escopo aprovado em item 1 +
   F-01; (b) migration 063 aplicada em produção ANTES do deploy de código que grave
   `received`/`pending`; (c) troca de `p_status` nos pipelines inbound; (d) ciclo
   seguinte: rota Meta (legado + ACK); (e) ciclo de segurança RPCs 031/047 + segredo
   no path + timing-safe no cron.
4. **Registrar documentalmente**: atualização do MASTER-ROADMAP para o SHA real,
   distinção E2.1-RC1 × E2.1-Activation, e as duas retificações da §5 como resposta
   formal às auditorias externas.

Nenhum item acima foi implementado por decisão minha isolada: os artefatos do §2.1
implementam contratos já congelados (ADR-MSG-001, ADR-MSG-STATUS-001, EIS-001); as
pendências do §4.3 aguardam este gate.

---

## 7. Reprodução (todos executados em 2026-08-03 no checkout local)

```bash
git rev-parse HEAD                                   # 90739ff...
git merge-base --is-ancestor 0711fbbb HEAD && echo ancestral
git log --oneline 0711fbbb..HEAD                     # 3 commits (docs HOTFIX-001)
git status --porcelain | wc -l                       # 32
git ls-tree 0711fbbb --name-only | grep -i lock      # package-lock.json (refuta F-08)
git ls-files supabase/migrations/063_*.sql           # vazio → untracked (explica Div-18)
grep -n "sender_type" src/lib/message/resolve-by-external-id.ts          # :120 'agent'
grep -rn "handleCanonicalStatusEvent" src/app                            # rota não-Meta
grep -n "parseStatusEvent" src/lib/whatsapp/providers/*.ts               # 4 arquivos
grep -n "p_status" src/lib/whatsapp/inbound-processor.ts src/app/api/whatsapp/webhook/route.ts
grep -n "handleStatusUpdate" src/app/api/whatsapp/webhook/route.ts       # :278 legado
sed -n '247,252p' src/app/api/whatsapp/webhook/route.ts                  # ACK prematuro
sed -n '70,90p' supabase/migrations/047_message_external_ids.sql         # RPC sem validação
grep -cn "ROW LEVEL\|GRANT\|REVOKE" supabase/migrations/031_webhook_dlq.sql  # 0
grep -n "!==" src/app/api/automations/cron/route.ts                      # :23
grep -n "Snapshot" docs/MASTER-ROADMAP.md                                # 26e5d39
```
