# AUD-001 — Consolidação das Quatro Auditorias

**Auditorias comparadas:** Claude (Arquiteto de SW/Integração), DeepSeek, HY3 (multi-papel), GPT 5.5 (independente)
**Método:** cada afirmação factual divergente foi **arbitrada contra o código real**.
**Data:** 2026-07-16

---

## 0. Achado metodológico (o mais importante): as auditorias leram *snapshots diferentes*

A GPT 5.5 abriu com uma alegação que contradizia as outras três: que no commit `bac3065` o `getProvider()` **só suporta Meta** e lança `ProviderUnsupportedError` para o resto. Arbitrei no repositório e **a GPT está correta** — e a explicação é reveladora:

```
git show HEAD:providers/index.ts   →  export { MetaProvider }  + throw Unsupported   (só Meta)
working tree providers/index.ts    →  meta + zapi + uazapi no factory
```

`git status` confirma que **toda a camada multi-provider é trabalho não-commitado** em relação a `bac3065`:

| Arquivo | Estado vs commit `bac3065` |
|---|---|
| `providers/uazapi.ts`, `providers/zapi.ts` | **untracked** (não existem no commit) |
| `app/api/whatsapp/webhook/[provider]/…` | **untracked** |
| `supabase/migrations/032_whatsapp_provider.sql` | **untracked** |
| `providers/index.ts` (factory +zapi/uazapi) | modificado, não commitado |
| `send/route.ts` (ramo não-Meta) | modificado, não commitado |
| `inbound-processor.ts` | modificado, não commitado |

**Consequência:** Claude, DeepSeek e HY3 auditaram a **working tree** (o commit + alterações não-commitadas em andamento). A GPT auditou o **commit `bac3065` puro** via `git show HEAD`. Nenhum lado está "errado" — auditamos estados diferentes do mesmo repositório. Mas isso muda a interpretação da maturidade:

- **No commit:** multi-provider é essencialmente **inexistente** (interface existe, adapters e wiring não). É Meta-only.
- **Na working tree:** multi-provider existe como **WIP não-commitado** — o que explica por que ele parece "construído mas adotado de forma inconsistente".

> **Crédito à GPT 5.5:** foi a única a olhar o snapshot commitado e a pegar essa divergência. Meu próprio relatório rotulou "commit `bac3065`" quando na verdade auditei a working tree suja — correção registrada. *(A GPT exagera ao chamar as outras de "factualmente erradas": a working tree é o estado real do que está sendo construído; o que faltou às três — inclusive a mim — foi sinalizar que ela diverge do commit.)*

---

## 1. Leitura geral

As três auditorias **convergem no diagnóstico central** e chegam de forma independente ao mesmo veredito: *"a abstração de provider está certa, mas não é load-bearing"* + *"multi-tenant é sólido, multi-provider é parcial"*. Isso é o sinal mais forte possível de que os achados são reais.

As três têm **ênfases de risco diferentes**, e é aí que se complementam:

| Auditoria | Força | Lente dominante |
|---|---|---|
| **Claude** | Integridade de dados, segurança fina, design alvo detalhado | "O que corrompe estado / o que criar" |
| **DeepSeek** | Completude de provider, mapeamento de arquivos | "O que quebra o multi-provider hoje" |
| **HY3** | Precisão cirúrgica (linhas), FKs, cobertura de QA | "Onde exatamente, e o que não é testado" |

---

## 2. Matriz consolidada de achados

Legenda: 🔴 Crítico · 🟠 Alto · 🟡 Médio · ✅ visto · — não mencionado · **CV** = veredito no código

| # | Achado | Claude | DeepSeek | HY3 | Severidade acordada | CV (verificado no código) |
|---|---|:--:|:--:|:--:|:--:|---|
| C1 | **Engines (automations/flows) enviam só via Meta** (`meta-send.ts`) | ⚠️ (marcado "a validar") | 🟠 #13 | 🔴 #1 | **🔴 Crítico** | ✅ `automations/meta-send.ts` + `flows/meta-send.ts` importam `sendTextMessage`/`sendTemplateMessage` de `meta-api` |
| C2 | **Reactions só via Meta** (`react/route.ts`) | — | — | 🔴 #1 | **🔴 Crítico** | ✅ `import { sendReactionMessage } from 'meta-api'` (só HY3 pegou) |
| C3 | **Broadcast só Meta** | 🔴 | 🔴 #2 | 🔴 #1 | **🔴 Crítico** | ✅ `broadcast/route.ts` importa só `sendTemplateMessage` |
| C4 | **Sem dedup / `message_id` não-único** → duplicação em redelivery | 🔴 #1 | 🟠 #9 | 🟠 #3/#4 | **🔴 Crítico** | ✅ `idx_messages_message_id` não-único; `INSERT` puro nos 2 writers |
| C5 | **Status só Meta** (não-Meta travado em `sent`) | 🔴 | 🔴 #1 | 🟠 #6 | **🔴 Crítico** | ✅ rota `[provider]` não processa `statuses` |
| C6 | **DLQ morta** (`enqueue_webhook_dlq` nunca chamado) | 🔴 | 🔴 #5 | — | **🟠 Alto** | ✅ sem referências em `src/` |
| C7 | **Webhook não-Meta: sem HMAC, segredo-na-URL, scan O(n)** | 🔴 | 🟠 | 🟠 #2 | **🟠 Alto** | ✅ `verifyWebhookRequest`→`true`; scan+decrypt de todos os configs |
| C8 | **Meta webhook ignora o próprio `MetaProvider`** (monólito 1038 loc + dead code) | 🟠 | 🔴 #3 | ✅ | **🟠 Alto** | ✅ parser inline; `MetaProvider.parseInboundMessage` não usado |
| C9 | **Sem `provider`/`external_id` em `messages`** | 🟠 | 🟠 #8 | 🟡 #7 | **🟠 Alto** | ✅ schema confirma ausência |
| C10 | **1 conexão por conta** (`UNIQUE(account_id)`) | 🟠 | ⚠️ | 🟡 #7 | **🟠 Alto** | ✅ `017` `whatsapp_config_account_id_key` |
| C11 | **`messages` sem `account_id`** (isolamento por JOIN) | — (subvalorizei) | 🟠 #7 | 🟠 (Data) | **🟡 Médio** | ✅ RLS de `messages` via JOIN em `conversations` |
| C12 | **Mídia não-Meta = URL crua** (expira, sem auth) | 🟡 | ⚠️ | 🟡 #8 | **🟡 Médio** | ✅ `mediaRefIsUrl` salva URL direta |
| C13 | **`ENCRYPTION_KEY` global, sem rotação/KEK** → lockout | (só citei `META_APP_SECRET`) | — | 🟠 #5 | **🟠 Alto** | ✅ chave única; rotate = `token_corrupted` |
| C14 | **Send não-Meta não pausa flows** | ⚠️ | 🟠 #11 | — | **🟡 Médio** | ✅ pause só no ramo Meta |
| C15 | **Webhook não-Meta sem rate-limit** | ✅ (tabela) | 🟠 #10 | 🟠 | **🟡 Médio** | ✅ ausente na rota `[provider]` |
| C16 | **FKs inconsistentes no delete de contato** (conversations CASCADE vs deals/broadcast SET NULL) | — | — | 🟡 (Data) | **🟡 Médio** | ✅ `004` = SET NULL; `001` conversations = CASCADE |
| C17 | **Falha de envio não persiste** como `failed` (invisível no inbox) | 🟠 | — | ✅ ("persist before send") | **🟠 Alto** | ✅ `INSERT` só após sucesso do provider |
| C18 | **Idempotency-key ausente no envio à Graph API** (double-send em retry 429/504) | 🟠 | — | 🟠 #3 | **🟠 Alto** | ✅ `fetchWithRetry` sem idempotency-key |
| C19 | **FK `user_id ON DELETE CASCADE`** de `auth.users` | 🟡 | — | 🟠 #2 (RLS/service-role) | **🟡 Médio** | ✅ tabelas de domínio |
| C20 | **`messages.status` CHECK sem `replied`/`pending`** (na escada, fora do CHECK) | 🟡 (`replied`) | — | ✅ (`pending`) | **🟡 Baixo** | ✅ CHECK = sending/sent/delivered/read/failed |
| C21 | **`assigned_agent_id` sem FK; `provider` sem CHECK** | (provider CHECK sim) | — | 🟡 (Data) | **🟡 Baixo** | ✅ `032` deixa `provider` TEXT livre |
| C22 | **Gaps de teste** (sem teste uazapi/zapi, webhook duplicado, cross-tenant, retry) | — | — | 🟠 #9 | **🟠 Alto** | ✅ (só HY3 auditou a suíte) |

---

## 3. Achados exclusivos de cada auditoria (valor incremental)

**Só a Claude:** idempotency-key no outbound (C18), falha de envio invisível (C17), `user_id ON DELETE CASCADE` de auth.users (C19), comparação não-constant-time no match de segredo, e o **design alvo detalhado** (tabela `connections`, contrato `parseStatus`, índice único idempotente).

**Só a DeepSeek:** enquadramento explícito de `messages` sem `account_id` (C11) e tabelas-filhas sem `account_id`; mapeamento dos arquivos `meta-send.ts` (que a Claude só suspeitou).

**Só a HY3:** **reactions Meta-only (C2)** — ninguém mais viu; **FK inconsistente no delete de contato (C16)**; **`ENCRYPTION_KEY` rotation-lockout (C13)**; **cobertura de teste ausente (C22)**; "persistir antes de enviar"; API v1 usa service-role e escopos não são enforced.

**Só a GPT 5.5:** o **achado metodológico do §0** (a mais valiosa); a **contradição comentário↔código** em `automations/meta-send.ts:124` e `flows/meta-send.ts:386` — o comentário diz *"Persist the message BEFORE sending to Meta"* mas o `INSERT` executa **depois** do envio (verificado: comentário existe; ordem do código a confirmar no fix); a **conflação semântica do `status='delivered'` no inbound** (mensagem recebida não é "delivered" no mesmo sentido de uma outbound — inbound deveria nascer `received`); e refinamentos de design (abaixo).

### 3.1 Refinamentos de design da GPT 5.5 (mais fortes que o meu esboço inicial)

- **A unidade de integração é a `Connection`, não o provider nem o account.** `provider` é uma *propriedade* da conexão. → o meu design de tabela `connections` fica correto, mas a GPT o torna o **centro** do modelo.
- **Identidade externa = `(connection_id, external_id)`**, não `(account_id, provider, external_id)`. Mais limpo: `account_id` deriva da conexão (duplicável em `messages` só por RLS/índice/performance).
- **Conversa multi-canal:** `UNIQUE(account_id, contact_id)` é insuficiente — o mesmo contato via número Meta e via número uazapi podem ser **duas conversas**. Chave futura: `(account_id, connection_id, contact_id)`.
- **Contrato do provider:** preferir `parseEvents(payload): ProviderEvent[]` (union: `InboundMessage | MessageStatus | Reaction | ConnectionStatus`) a encher a interface com `parseStatus`/`parseReaction`/… separados. Mais escalável.
- **Dedup de persistência ≠ dedup de efeitos colaterais.** Mesmo com `ON CONFLICT DO NOTHING`, o insert precisa retornar `{inserted: true|false}` e **só disparar flows/automations quando `inserted=true`** — senão o redelivery ainda duplica efeitos. *(Nuance que meu `ON CONFLICT DO NOTHING` sozinho não cobria.)*
- **Outbound:** "mover o INSERT para cima" não basta — DB e provider são dois sistemas externos sem transação distribuída. Precisa de um **modelo de delivery explícito** (outbox: `Message Intent → Delivery Attempt → Provider Result → Message State`).
- **Processo:** escrever um **ADR-001 (Messaging Core + Provider Boundary)** *antes* de implementar qualquer correção, senão corrige-se status/dedup/broadcast sobre `account → whatsapp_config → provider` e refaz-se tudo quando o 2º provider entrar em produção.

---

## 4. Correções e disputas (arbitradas no código)

1. **DeepSeek — "findExistingContact usa trigram search"** → **impreciso**. É `LIKE '%sufixo'` (últimos 8 dígitos) + `phonesMatch` em JS; **não há trigram** (nenhum `pg_trgm`). Efeito colateral que ninguém flagou: wildcard à esquerda **não usa índice → full scan** em tabelas grandes de contatos.
2. **DeepSeek — "Z-API/uazapi suportam HSM templates, oportunidade perdida"** → **duvidoso**. Providers não-oficiais (Baileys/web) não têm o conceito de template HSM aprovado pela Meta. Podem mandar botões/listas, não "templates aprovados". **A verificar na doc do provider** antes de virar tarefa.
3. **DeepSeek — "Template blocking p/ não-Meta = 🔴 crítico"** → **enquadramento discutível**. Bloquear template Meta onde não há suporte é comportamento defensivo **correto**; o defeito é a ausência de alternativa, não o bloqueio.
4. **Números de rate-limit** divergem (DeepSeek: 60/min send, 5/min broadcast; HY3: 300/min webhook, 60/min send). São buckets diferentes; não altera conclusões.
5. **Severidade do dedup (C4):** Claude 🔴, DeepSeek 🟠, HY3 🟠. **Consolidado 🔴** — mensagem duplicada dobra `unread_count` e **re-dispara automations/flows**: é corrupção de estado observável, não ruído.

---

## 5. Plano de remediação consolidado (fusão dos três)

As três propõem a mesma Fase 1. Ordem acordada:

**P0 — Tornar a abstração load-bearing** (fecha C1, C2, C3, C5, C8)
- `resolveProviderForAccount(accountId)` → `getProvider(config)` único.
- Trocar imports diretos de `meta-api` em `automations/meta-send.ts`, `flows/meta-send.ts`, `broadcast/route.ts`, `react/route.ts` por um `engineSender(provider, …)`.
- Meta inbound passa a usar `MetaProvider.parseInboundMessage` (mata o monólito + dead code).
- Adicionar `parseStatus()` ao contrato e plugar na rota `[provider]` (fecha status não-Meta).

**P0 — Idempotência & dedup** (fecha C4, C17, C18)
- `CREATE UNIQUE INDEX ... ON messages(conversation_id, provider, external_id) WHERE external_id IS NOT NULL` (backfill antes).
- `ON CONFLICT DO NOTHING` no inbound; idempotency-key no outbound.
- Persistir `messages` com `status='sending'` **antes** da chamada ao provider; marcar `failed` no erro.

**P1 — Confiabilidade & segurança** (fecha C6, C7, C13, C15)
- Ligar a DLQ no `catch` do webhook + cron de reprocesso.
- Webhook não-Meta: segredo em header + HMAC quando possível, replay-protection, resolução O(1), rate-limit.
- Versionar `ENCRYPTION_KEY` (`key_version` + job de re-encrypt); avaliar KEK por tenant.

**P1 — Modelo de dados** (fecha C9, C10, C11, C16, C19)
- `messages.account_id` + `provider` (FK/CHECK); `conversations.connection_id` + `closed_at`.
- Tabela `connections` (provider por conexão → habilita multi-provider intra-tenant).
- FKs `ON DELETE SET NULL` onde a cascata destrói histórico; FK em `assigned_agent_id`.

**P2 — Mídia, QA, observabilidade** (fecha C12, C20, C21, C22)
- Proxy/re-fetch de mídia não-Meta; reduzir `Cache-Control` do proxy Meta.
- Testes: uazapi/zapi/`getProvider`, webhook duplicado, cross-tenant, retry/double-send, late-status.
- Correlation IDs + logs estruturados `{tenant, connection, provider, external_id, direction, status}`.

---

## 6. Conclusão

Nenhuma das quatro auditorias tem erro grave. As únicas imprecisões factuais são pontuais e da DeepSeek (trigram, templates não-oficiais, enquadramento do template-block). Balanço por auditor:

- **GPT 5.5** — a mais sofisticada arquiteturalmente e a única a pegar o **achado metodológico** (§0: multi-provider é WIP não-commitado no HEAD). Refinou o design para centrar em `Connection` e alertou que corrigir sintomas antes do modelo de conexão gera retrabalho.
- **HY3** — a mais precisa tecnicamente; achado exclusivo mais relevante entre os sintomas (reactions Meta-only) + FKs + cobertura de teste.
- **Claude** — design alvo e riscos de integridade fina (idempotency-key, falha de envio invisível).
- **DeepSeek** — primeira a mapear os `meta-send.ts` concretamente.

**Convergência das quatro sobre o mesmo eixo:** a abstração de provider precisa virar a **fronteira real** do sistema — hoje é "ornamental" (existe no design, não no runtime). Mas a GPT adiciona a leitura mais profunda: o problema-raiz não é "faltam adapters", é que **não existe uma unidade `Connection` nem um domínio de messaging independente do provider**.

**Recomendação de sequência (fusão das quatro):**
1. **ADR-001 — Messaging Core & Provider Boundary** (decisão formal: `Connection` como unidade; identidade externa `(connection_id, external_id)`; inbound idempotente; status como evento canônico; único delivery service; engines proibidos de importar API concreta de provider; `whatsapp_config` = legado).
2. Depois, executar P0/P1 do §5 **sobre** esse modelo — não sobre `account → whatsapp_config → provider`.

> Nota de estado: como a camada multi-provider está **não-commitada** (§0), a primeira ação prática pode ser simplesmente decidir se esse WIP é a fundação a manter ou a refazer segundo o ADR — antes de commitá-lo.
