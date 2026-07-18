# AUD-001 — Relatório de Auditoria do Fluxo Operacional e da Arquitetura Multi-Provider

**Sistema:** WACRM (`wacrm` v0.2.2) — Next.js 16 + Supabase (Postgres/Auth/Realtime)
**Papel condutor:** Arquiteto de Software / Integração — com lentes de Data Engineering, QA e Security aplicadas por camada
**Data:** 2026-07-16
**Base auditada:** código real em `main` (commit `bac3065`), migrations `001`→`032`, rotas `src/app/api/whatsapp/*`, `src/lib/whatsapp/*`

> Esta auditoria **não assume** que a arquitetura ideal já existe. Ela reconstrói como o sistema realmente funciona hoje e nomeia as fronteiras arquiteturais que precisam existir para suportar múltiplos providers (Meta, uazapi, Z-API/Evolution) e múltiplos tenants.

---

## 0. Sumário executivo

O WACRM **já não é** um sistema "centrado na Meta" puro: existe uma abstração `WhatsAppProvider` (`src/lib/whatsapp/providers/types.ts`) com implementações `meta`, `zapi` e `uazapi`, e o multi-tenancy foi corretamente promovido de `user_id` para `account_id` com RLS real (migration `017`). A fundação é sólida. Porém a adoção da abstração é **assimétrica e incompleta**, e há **um buraco de integridade de dados que compromete diretamente o multi-provider**: não existe deduplicação/idempotência de mensagens inbound.

### Veredito por camada

| Camada | Estado | Nota |
|---|---|---|
| Tenancy + RLS (Domínio A) | **Forte** | RLS por `is_account_member`, forward-only, service-role isolado no webhook |
| Modelo de dados (Domínio B) | **Frágil no eixo provider** | Sem `external_id`/`provider` em `messages`; sem unicidade de `message_id`; 1 conexão por conta |
| Fluxo de mensagens (Domínio C) | **Divergente** | Dois pipelines inbound paralelos; status só para Meta; **sem dedup** |
| Providers (Domínio D) | **Contrato existe, meio adotado** | Meta não usa o próprio contrato; broadcast é Meta-only |
| Automação/Operações (Domínio E) | **OK com ressalvas** | Automação e broadcast não passam pela abstração |
| Segurança/API (Domínio F) | **Dois modelos de confiança** | Meta HMAC (bom) vs. segredo-na-URL (fraco); DLQ morta |

### Achados críticos (P0) — detalhados nas seções indicadas

1. **Sem deduplicação/idempotência de inbound** — `messages.message_id` tem apenas índice **não-único**; ambos os pipelines fazem `INSERT` puro. Retry de webhook = mensagem duplicada. → §C-15, §C-16
2. **Status (delivered/read/failed) só funciona para Meta** — a rota multi-provider não processa `statuses`. Mensagens de uazapi/Z-API ficam presas em `sent`/`delivered` para sempre. → §C-13
3. **Correlação de ID externo é provider-frágil** — `messages.message_id` guarda `wamid` (Meta) ou `zaapId` (Z-API) sem coluna `provider`/`external_id`. Status callbacks de Z-API referenciam um id **diferente** do salvo no envio → correlação quebra. → §B-8, §C-13
4. **DLQ existe mas está morta** — `whatsapp_webhook_dlq` + `enqueue_webhook_dlq` (migration `031`) **nunca são chamados** no código. Falha no processamento assíncrono = perda silenciosa. → §C-17, §F-28
5. **Segurança de webhook não-Meta = segredo na URL** — `verifyWebhookRequest` sempre retorna `true`; sem HMAC, sem replay-protection; o segredo trafega no path (logável em proxies/access logs). → §C-14, §F-27

### Achados de arquitetura (P1)

6. **Dois pipelines inbound paralelos** (`webhook/route.ts` inline vs. `inbound-processor.ts`) duplicam ~250 linhas de lógica de domínio. → §D-20
7. **Meta não usa o próprio `MetaProvider`** — envio Meta vai direto a `meta-api.ts`; envio não-Meta vai por `getProvider()`. O contrato existe mas o provider principal o ignora. → §D-18, §D-20
8. **Broadcast é Meta-only** — `broadcast/route.ts` importa apenas `sendTemplateMessage` de `meta-api`; uma conta não-Meta que dispara broadcast chama a API da Meta com credenciais inválidas. → §E-23
9. **1 conexão por conta** — `UNIQUE(account_id)` em `whatsapp_config`. Provider é uma coluna, não uma entidade. Não há como uma conta ter Meta + uazapi simultâneos nem dois números. → §A-3, §D-21

---

## 1. Como o sistema realmente funciona hoje (fluxo reconstruído)

### 1.1 Envio (outbound) — `POST /api/whatsapp/send`

```
UI → /api/whatsapp/send (auth via cookie Supabase)
      → resolve account_id via profiles
      → rate-limit (in-memory, por user)
      → carrega conversation + contact + whatsapp_config (account-scoped)
      → decrypt(access_token)  [self-heal CBC→GCM]
      ├── SE config.provider != 'meta':
      │      getProvider(zapi|uazapi) → provider.sendText/sendMedia()
      │      INSERT messages(status='sent', message_id = providerMessageId)
      │      (sem retry de variantes, sem template, sem pause de flow)
      └── SE 'meta' (default):
             sendTextMessage/sendMediaMessage/sendTemplateMessage (meta-api.ts DIRETO)
             retry por variantes de telefone; auto-corrige contact.phone
             INSERT messages(status='sent', message_id = wamid)
             pausa flow_runs ativos do contato (supabaseAdmin)
```

**Fronteira observada:** a Meta termina no `wamid` retornado; o WACRM assume a persistência daí em diante. Para não-Meta a mesma fronteira existe, mas o "id externo" tem semântica diferente (ver §B-8).

### 1.2 Recebimento (inbound) — **dois caminhos distintos**

```
META:      POST /api/whatsapp/webhook
             verifica HMAC (META_APP_SECRET, fail-closed)
             ack 200 → processWebhook() ASSÍNCRONO (fire-and-forget)
             resolve tenant por phone_number_id (UNIQUE) → config
             processMessage()  [lógica INLINE, ~400 linhas]

NÃO-META:  POST /api/whatsapp/webhook/[provider]/[webhookSecret]
             resolve tenant por scan linear + decrypt(verify_token)==secret
             provider.parseInboundMessage(payload) → InboundMessage
             processInboundMessage()  [lógica em inbound-processor.ts]
```

Os dois caminhos fazem a **mesma coisa** (find/create contact → conversation → insert message → flag broadcast reply → dispatch flows → dispatch automations), mas em **código separado e divergente**. Só o caminho Meta trata `statuses`, reactions com proxy de mídia autenticado, e template webhooks.

---

## Domínio A — Tenancy e identidade

### A-1. Multi-tenancy e isolamento — **FORTE**
- **Unidade real de isolamento:** `account` (tabela `accounts`, migration `017`). Design travado em **1 conta por usuário** (`idx_accounts_one_per_owner`, `UNIQUE(owner_user_id)`).
- **Vínculo:** toda tabela de domínio carrega `account_id NOT NULL` (backfill + `SET NOT NULL` em `017`). `user_id` legado permanece apenas como "agente dono/auditoria", **não** para isolamento.
- **Resolução do tenant:** nas rotas autenticadas, via `profiles.account_id` a partir de `auth.uid()`. No webhook, via `phone_number_id` (Meta) ou segredo-na-URL (não-Meta).
- **Caminhos que ignoram o tenant:** os writes de webhook usam `supabaseAdmin()` (service role, **bypassa RLS**) — necessário e correto, mas significa que o isolamento nesses caminhos é **garantido só pelo código** (o `account_id` é passado explicitamente). Ver risco em §A-4.

> **Pergunta do briefing — "Um usuário consegue afetar dados de outro cliente?"** Pela via autenticada (browser/server com sessão): **não** — RLS bloqueia. Pela via webhook: só se um atacante forjar a resolução de tenant — o que para não-Meta é plausível (§F-27).

### A-2. Identidade do usuário — **OK**
- Auth: Supabase Auth (cookies SSR, `@supabase/ssr`). `createClient()` server-side lê a sessão.
- `Auth User → profiles.account_id → account_role` (`owner>admin>agent>viewer`).
- Roles resolvidos server-side por `requireRole()` (`src/lib/auth/account.ts`) e por `is_account_member(account_id, min_role)` no banco. **Dois pontos de verdade coerentes.**
- Ressalva: `profiles.role TEXT` legado permanece sem uso (marcado para remoção no próprio `017`).

### A-3. Credenciais por cliente — **PARCIAL / limitante**
- Tokens vivem em `whatsapp_config` (por `account_id`), **criptografados AES-256-GCM** (`encryption.ts`), com self-heal de formato legado CBC→GCM.
- Campos por provider: Meta usa `phone_number_id`/`waba_id`/`access_token`/`verify_token`; Z-API usa `instance_id`/`access_token` e **reusa `waba_id` para guardar o client-token** (criptografado); uazapi usa `base_url`/`instance_id`/`access_token`.
- **As credenciais SÃO do cliente** (não globais) — bom. **Exceção global:** `META_APP_SECRET` é único por instância (§F-27).
- **Limitação estrutural:** `UNIQUE(account_id)` ⇒ **uma única credencial/conexão por conta**. Rotação existe só como "salvar de novo"; não há histórico nem múltiplas conexões.

> **Pergunta — "as credenciais são do cliente ou globais?"** Do cliente, criptografadas por tenant. Único vetor global remanescente: `META_APP_SECRET` (assinatura de webhook Meta).

### A-4. RLS e autorização — **FORTE, com um alerta de FK**
- Todas as tabelas relevantes têm RLS por `is_account_member()` (`SECURITY DEFINER`, `STABLE`), com três camadas: viewer (SELECT), agent+ (CRUD operacional), admin+ (tabelas de settings). Tabelas filhas checam via join no pai.
- Browser e server passam por RLS; **service role** (`supabaseAdmin`) só é usado em webhooks/cron/RPCs — bypass **intencional e escopado**.
- **O banco protege o tenant, não só o código** — resposta direta à pergunta central do briefing. O único lugar onde é "só código" é o write de webhook, por necessidade (não há sessão de usuário num evento da Meta).
- **⚠ Alerta de FK (P2):** `contacts.user_id`, `conversations.user_id` etc. ainda são `NOT NULL REFERENCES auth.users ON DELETE CASCADE`. Se o usuário carimbado em `user_id` (para inbound, o dono do config) for deletado, **as linhas dele cascateiam** mesmo com a conta viva. `accounts.owner_user_id` é `ON DELETE RESTRICT` (protege o owner), mas linhas antigas carimbadas com outro `user_id` são vulneráveis. Recomenda-se migrar esses FKs para `ON DELETE SET NULL`.

---

## Domínio B — Modelo de dados

### B-5. Contatos — **OK (dedup robusta)**
- Identidade: `(account_id, phone_normalized)` com `UNIQUE` parcial (migration `022`). `phone_normalized` é coluna **gerada** (`regexp_replace(phone,'\D','','g')`), impossível de dessincronizar.
- `findExistingContact` (`src/lib/contacts/dedupe.ts`) pré-filtra por sufixo de 8 dígitos em SQL e aplica identidade estrita em JS — mesma lógica em webhook, form manual e import CSV. **Três caminhos concordam.**
- Merge de duplicados histórico (`merge_duplicate_contacts`) re-aponta filhos antes de deletar — sem perda.
- **Sem identificador externo de contato por provider** (ex.: JID do WhatsApp vs. wa_id). Hoje o telefone normalizado é a única chave. Aceitável, mas para Evolution/uazapi (que usam `@s.whatsapp.net` / `@g.us`) **grupos** cairiam no mesmo esquema de telefone — não modelado.

### B-6. Conversas — **OK, simples**
- `conversations`: `UNIQUE(account_id, contact_id)` (upsert em `onConflict`). Status `open|pending|closed`. `assigned_agent_id` existe (livre, sem FK).
- **Não há coluna `provider` nem `channel`/`connection_id`** na conversa. Uma conversa é "o contato", agnóstica de canal. Isso quebra quando a mesma conta tiver Meta **e** uazapi para o mesmo telefone (ver §D-21).
- Encerramento/reabertura: por `status`; não há máquina de estados nem timestamps de fechamento dedicados.

### B-7. Mensagens — **modelo real (não idealizado)**
Schema real de `messages` (migration `001`, estendido em `009/010`):
```
id                  UUID PK
conversation_id     UUID FK → conversations (ON DELETE CASCADE)
sender_type         'customer' | 'agent' | 'bot'
sender_id           UUID (livre)
content_type        CHECK: text|image|document|audio|video|location|template|interactive
content_text        TEXT
media_url           TEXT
template_name       TEXT
message_id          TEXT        ← id EXTERNO do provider (wamid / zaapId / key.id)
status              CHECK: sending|sent|delivered|read|failed
reply_to_message_id UUID (interno)
interactive_reply_id TEXT
created_at          TIMESTAMPTZ
```
**Ausências críticas para multi-provider:**
- **Não há `provider`** — impossível saber por qual canal a mensagem trafegou.
- **Não há `external_id` distinto de `message_id`** nem `tenant_id`/`account_id` (a mensagem herda tenant via `conversation`).
- **Não há `direction`** explícito (derivado de `sender_type`).
- **`message_id` não é único** (ver §B-10 / §C-15).

### B-8. IDs internos e externos — **PONTO ARQUITETURAL FRÁGIL**
```
ID interno (messages.id UUID)
    ↕  messages.message_id (TEXT, sem provider tag)
        Meta   → wamid (mesmo id no envio e no status webhook) ✅
        Z-API  → zaapId no envio; MAS status callback referencia OUTRO id ❌
        uazapi → key.id (Baileys); status/ack vêm em evento separado não tratado ❌
```
- A correlação **sobrevive para Meta** porque o `wamid` é estável entre envio e status. **Não sobrevive** para Z-API/uazapi: o id retornado no envio (`zaapId`) difere do id das callbacks de status, e a rota multi-provider **nem processa status** (§C-13).
- **Sem coluna `provider`**, dois providers poderiam teoricamente colidir `message_id` (improvável, mas o modelo não previne).

> **Pergunta crítica do briefing — "Existe estratégia de correlação capaz de sobreviver a múltiplos providers?"** **Não.** Hoje ela sobrevive só para Meta. É o item #1 do design alvo (§8).

### B-9. Mídia e attachments — **DOIS MODELOS**
- **Meta:** inbound salva `media_url = /api/whatsapp/media/{mediaId}` (proxy autenticado; `getMediaUrl` valida com a Meta antes de persistir). Download server-side com token. Expiração administrada pelo proxy.
- **Não-Meta:** `mediaRefIsUrl=true` ⇒ salva a **URL crua do provider** direto em `media_url`. Sem proxy, sem auth, sujeita a **expiração** e a **vazamento** (URL pública). Outbound não-Meta envia `link` direto ao provider.
- Sem transformação/normalização de mídia comum entre providers; sem `media_id` interno.

### B-10. Consistência e integridade — **BOA na base, LACUNA de idempotência**
- FKs e cascades bem definidos; `broadcast_recipients` tem trigger agregador que re-deriva contadores do broadcast pai (migrations `003/005`).
- Índices de performance em `029`; índices por `account_id` em `017`.
- **Estado impossível não prevenido:** duas linhas `messages` com o mesmo `message_id` (mesmo provider) — porque o índice `idx_messages_message_id` **não é único** e nenhum `INSERT` usa `ON CONFLICT`. Este é o vetor de duplicação (§C-15).
- Sem `CHECK` no valor de `provider` em `whatsapp_config` (migration `032` deixa `TEXT` livre).

---

## Domínio C — Fluxo de mensagens

### C-11. Envio — reconstruído em §1.1. Achados:
- Nasce no `INSERT` **após** sucesso no provider ⇒ mensagem só existe no banco se o provider aceitou. Não há estado `sending` persistido antes da chamada; logo **falha de envio não deixa rastro** no inbox (só resposta HTTP 502 ao cliente). Ver §C-17.
- ID externo salvo em `messages.message_id`. Para Meta há retry de variantes de telefone; para não-Meta **não há**.

### C-12. Recebimento — reconstruído em §1.2. Divergência estrutural (§D-20).

### C-13. Status — **SÓ META (P0)**
- `handleStatusUpdate` (em `webhook/route.ts`) implementa uma escada forward-only correta: `pending→sent→delivered→read→replied`, com `failed` aceito só de `pending`/`sent`. Espelha em `messages.status` e em `broadcast_recipients`. **Bem feito — para Meta.**
- **A rota `webhook/[provider]/[webhookSecret]` não trata status algum.** `parseInboundMessage` retorna `null` para eventos que não são mensagem de entrada, e o handler simplesmente responde `ok`. Resultado: **para uazapi/Z-API, delivered/read/failed nunca chegam ao banco.** As mensagens ficam eternamente em `sent`/`delivered`.
- `messages.status` CHECK **não inclui `replied`**, mas a escada referencia `replied` — inócuo porque a Meta não envia `replied` como status de mensagem (é derivado só para broadcast). Marcar como inconsistência menor.

### C-14. Webhooks — **DOIS MODELOS DE CONFIANÇA**
| Aspecto | Meta (`/webhook`) | Não-Meta (`/webhook/[provider]/[secret]`) |
|---|---|---|
| Autenticação | HMAC-SHA256 (`META_APP_SECRET`), **fail-closed** | Segredo no path == `verify_token` |
| Verificação de origem | Assinatura criptográfica | Nenhuma (`verifyWebhookRequest`→`true`) |
| Resolução de tenant | `phone_number_id` (UNIQUE, O(1)) | **Scan linear + decrypt** de todos os configs do provider |
| Idempotência | **Nenhuma** | **Nenhuma** |
| Eventos fora de ordem | Escada forward-only (status) | N/A (status não tratado) |
| Rate-limit | Sim, por `phone_number_id` | **Não** |
| Tamanho máximo | 512 KB (dupla checagem) | Sem limite |

### C-15. Deduplicação — **AUSENTE (P0)**
- **Mensagens:** nenhum dos dois pipelines checa `message_id` existente antes do `INSERT`, e não há unicidade no banco. A Meta **reentrega** webhooks em timeout/erro; como o processamento é assíncrono após o `200`, uma reentrega gera **linha duplicada** no inbox, **incrementa `unread_count` duas vezes**, **re-dispara automations e flows**. Idem para uazapi que reenvia arrays.
- **Reactions:** deduplicadas corretamente (upsert em `message_reactions` por `(message_id, actor_type, actor_id)`).
- **Broadcast:** `broadcast_recipients` não tem chave idempotente por recipient+broadcast; um reprocesso poderia reinserir.

### C-16. Retry e idempotência — **RISCO REAL**
> **Pergunta do briefing — "O retry pode enviar duas mensagens ao cliente?"**
- **Outbound:** o retry de variantes de telefone (Meta) só ocorre em erro "recipient not allowed" e **para no primeiro sucesso** — não duplica envio. `fetchWithRetry` (429/503/504) reexecuta a chamada HTTP; se a Meta processou mas o response se perdeu, **pode haver envio duplicado ao cliente** (sem idempotency-key na chamada à Graph API).
- **Inbound:** sem dedup, o retry **duplica a persistência** (não o envio) — §C-15.

### C-17. Erros e falhas — **VISIBILIDADE FRACA**
> **Pergunta — "Como o usuário fica sabendo que a mensagem falhou?"**
- No **envio**: recebe erro HTTP (502/500) na hora — mas **nada é persistido** (a mensagem não entra como `failed` no inbox). Se a UI não tratar, a falha some.
- No **recebimento/processamento assíncrono**: `processWebhook(...).catch(console.error)` — **apenas log**. Não há `failed` visível, não há reencaminhamento. A **DLQ (`031`) deveria** capturar isso, mas **está morta** (§F-28).
- Tipos de falha mapeados no código: auth, rate-limit (429), timeout (504), erro de provider, erro de banco. Falha parcial de broadcast é reportada por-recipiente no response.

---

## Domínio D — Providers

### D-18. Meta Provider — contrato real
`meta-api.ts` cobre: `sendText/Media/Template`, `getMediaUrl/downloadMedia`, `verifyPhoneNumber`, `registerPhoneNumber`, `subscribeWabaToApp`, templates (submit/sync/lifecycle webhook), upload resumível de mídia. **É o provider mais completo** — e o único com templates, status e mídia proxied.
- **Porém:** existe um `MetaProvider` class (`providers/meta.ts`) que implementa a interface `WhatsAppProvider`, **mas as rotas de envio e o webhook Meta não o usam** — falam direto com `meta-api.ts`. O contrato não é exercido pelo provider de referência.

### D-19. uazapi Provider — o que precisa ser adaptado
`providers/uazapi.ts` (compatível Evolution API) implementa envio de texto/mídia/reaction/botões/listas e `parseInboundMessage` (shape Baileys: `key`, `message.conversation`, etc.). Lacunas:
- `sendTemplate` faz **fallback para texto** (uazapi não tem templates HSM da Meta).
- **Status/ack não implementados** — não há `parseStatus`.
- Mídia inbound = URL crua (§B-9).
- `checkStatus` existe (connection state), usado no health-check.

### D-20. Contrato multi-provider — **EXISTE, mas meio adotado (P1)**
A interface pedida no briefing praticamente já existe:
```ts
interface WhatsAppProvider {
  sendText/sendMedia/sendTemplate/sendReaction
  sendInteractiveButtons/sendInteractiveList
  parseInboundMessage(payload): InboundMessage | null
  verifyWebhookRequest(req, rawBody): Promise<boolean>
}
```
**O que falta no contrato:**
- `parseStatus(payload): StatusEvent | null` — **inexistente**; é a causa raiz de §C-13.
- Faltam `normalizeInbound` unificado que **os dois pipelines** compartilhem (hoje Meta reimplementa inline).
- `verifyWebhookRequest` é no-op para não-Meta (§F-27).

> **Pergunta — "existe algo equivalente a MessageProvider ou a abstração precisa ser criada?"** **Existe e está ~60% pronta.** Precisa: (a) `parseStatus`, (b) unificar o pipeline inbound sobre `processInboundMessage`, (c) fazer Meta usar `MetaProvider`, (d) adicionar dedup no ponto único de persistência.

### D-21. Seleção do provider — **por conta, não por conexão (P1)**
```
Tenant (account) → whatsapp_config (1 linha, UNIQUE account_id) → provider (coluna) → credenciais
```
- A escolha é **por tenant**, correto quanto a não ser global. **Mas** não é "por conexão": não existe entidade `channel`/`connection`. Uma conta = um provider = um número. O alvo do briefing (`Tenant → Channel/Connection → Provider → Credentials`) **exige uma nova tabela** (§8).

---

## Domínio E — Automação e operações

### E-22. Automações — **mesmo fluxo? quase**
- `runAutomationsForTrigger` é disparado dentro de ambos os pipelines inbound, **após** contato/conversa/mensagem existirem. Ações de envio dentro de automations reusam o serviço de envio.
- **Divergência:** automations disparadas via flow/automation que enviam mensagem passam pelo caminho Meta (`meta-api`) — não pela abstração. Para uma conta não-Meta, ações de "send_message" de automação **precisam** rotear pelo provider certo; verificar cobertura (o send route trata provider, mas o engine de automação/flow pode chamar helpers Meta diretos — ponto a validar em §7).

### E-23. Broadcasts — **META-ONLY (P1)**
- `broadcast/route.ts` importa **apenas** `sendTemplateMessage` de `meta-api` e usa `config.phone_number_id`. Não há ramo por provider.
- Uma conta não-Meta: `phone_number_id` é um **placeholder = instance_id** (setado no config POST), então o broadcast chamaria a Graph API da Meta com credenciais uazapi/Z-API ⇒ **falha em 100% dos recipientes**.
- Fan-out é **sequencial in-process** (loop `for`), sem fila/worker, sem rate-limit por-mensagem, sem retry idempotente por recipient. Para volumes reais isso trava a request e não escala.

### E-24. Templates — **Meta-only por natureza**
- `message_templates` modela templates da Meta (categoria, header/body/footer/buttons, status de aprovação). Sync/submit/lifecycle via webhook Meta.
- Z-API/uazapi **não têm** templates HSM ⇒ `sendTemplate` vira texto; o send route **bloqueia** template para não-Meta com erro explícito (bom).
- Sem camada de compatibilidade/variáveis comum entre providers.

### E-25. Atribuição de conversas — **básica**
- `conversations.assigned_agent_id` (sem FK). `member_presence` (migration `024`) existe. Ownership por `account_id`; distribuição/round-robin não modelados. Mudança de agente = update simples. Permissões por RLS (agent+ pode escrever).

---

## Domínio F — Segurança e API

### F-26. API pública (`/api/v1`) — **base sólida, superfície mínima**
- `api_keys` (migration `026`): escopos como `text[]`, autorização **por escopo** independente do role (`scopes.ts`). Criação gated em admin+. Chaves revogáveis.
- **Superfície implementada hoje:** apenas `GET /api/v1/me`. `messages:send`, `broadcasts:send` etc. estão definidos como escopos mas **os endpoints ainda não existem**. Rate-limit por chave a validar quando os endpoints forem criados.

### F-27. Segurança dos webhooks — **assimétrica (P0 para não-Meta)**
- **Meta:** HMAC-SHA256 com `timingSafeEqual`, fail-closed sem `META_APP_SECRET`. **Bom.** Ressalva: `META_APP_SECRET` é **global** (um app Meta para toda a instância) — aceitável para self-host single-org, problemático para multi-org real.
- **Não-Meta:** sem assinatura. O "segredo" é o `verify_token` no **path da URL** → aparece em logs de proxy/CDN/observabilidade. A comparação é um loop `decrypt`+`===` **não constant-time** sobre todos os configs do provider (leak de timing + custo O(n) de decrypt por request). **Sem replay-protection** em nenhum webhook.

### F-28. Observabilidade e erros — **PARCIAL**
- Logs abundantes com prefixos (`[whatsapp/send]`, `[webhook]`), mas **sem correlation IDs**, sem `provider`/`tenant`/`external_id` estruturados. Rastrear uma mensagem ponta-a-ponta (o ideal do briefing) hoje exige `grep` por `message_id`.
- **DLQ morta:** `whatsapp_webhook_dlq` e `enqueue_webhook_dlq` (migration `031`) **não são referenciados em nenhum lugar de `src/`** (apenas em um teste). O comentário promete "prevents permanent message loss" — a promessa não está conectada ao código.
- Sem métricas (contadores de sent/failed por provider/tenant).

---

## 7. Pontos a validar (dívida de investigação)

1. **Automation/Flow engine → envio:** confirmar se `send_message` de automations/flows roteia por provider ou chama `meta-api` direto (impacta contas não-Meta). Arquivos: `src/lib/automations/engine.ts`, `src/lib/flows/engine.ts`.
2. **Z-API status callback:** confirmar o shape real do `MessageStatusCallback` e qual id ele referencia vs. `zaapId` salvo no envio.
3. **`profiles.role` legado:** remover conforme nota da migration `017`.
4. **FKs `user_id ON DELETE CASCADE`** em tabelas de domínio — confirmar impacto de deleção de membro não-owner.

---

## 8. Design alvo (fronteiras arquiteturais a criar)

### 8.1 Modelo de dados — evoluções mínimas

**(a) `messages`: tornar a correlação provider-safe + idempotente**
```sql
ALTER TABLE messages
  ADD COLUMN provider    TEXT,              -- 'meta'|'uazapi'|'zapi'
  ADD COLUMN external_id TEXT,              -- id do provider (renomeia papel de message_id)
  ADD COLUMN direction   TEXT CHECK (direction IN ('inbound','outbound'));
-- Idempotência inbound (o achado #1):
CREATE UNIQUE INDEX idx_messages_provider_external
  ON messages (conversation_id, provider, external_id)
  WHERE external_id IS NOT NULL;
```
E todo `INSERT` inbound passa a usar `ON CONFLICT DO NOTHING`, num **único ponto de persistência** (§8.3).

**(b) `connections`: provider por conexão, não por conta** (habilita Meta + uazapi juntos e múltiplos números)
```sql
CREATE TABLE connections (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','uazapi','zapi')),
  label TEXT,
  credentials JSONB,           -- criptografado por campo
  webhook_secret TEXT,         -- por conexão, não global
  status TEXT,
  is_primary BOOLEAN DEFAULT false,
  UNIQUE (account_id, provider, /* number/instance */ )
);
```
`conversations` e `messages` ganham `connection_id`. `whatsapp_config` vira uma view/migração de compatibilidade. Resolução de tenant no webhook passa a ser `connection_id`/segredo **por conexão** (O(1), não scan).

**(c) `provider` CHECK** em `whatsapp_config` até a migração para `connections`.

### 8.2 Contrato de provider unificado
```ts
interface WhatsAppProvider {
  readonly kind: string
  sendText/sendMedia/sendTemplate/sendReaction/sendInteractive*(): Promise<SendResult>
  parseInboundMessage(payload): InboundMessage | null
  parseStatus(payload): StatusEvent | null          // ← NOVO (fecha §C-13)
  verifyWebhookRequest(req, rawBody): Promise<boolean> // ← real p/ todos (fecha §F-27)
  supports: { templates: boolean; status: boolean; mediaProxy: boolean } // capacidades
}
```
- Adicionar `MetaProvider.parseStatus` e fazer o **webhook Meta usar `MetaProvider`** — eliminando a lógica inline.
- `SendResult` passa a devolver `{ externalId, provider }`.

### 8.3 Unificar o pipeline inbound
- **Um único** `processInboundMessage(inbound, connection)` — Meta e não-Meta convergem nele. Esse ponto único faz: dedup (`ON CONFLICT`), persistência, flag de broadcast, dispatch de flows/automations. Elimina os ~250 loc duplicados (§D-20) e garante que **toda** correção (dedup, status) valha para todos os providers.
- Rota multi-provider passa a chamar `provider.parseStatus` e a mesma função de status forward-only hoje exclusiva da Meta.

### 8.4 Confiabilidade e segurança
- **Ligar a DLQ:** no `catch` do processamento assíncrono, chamar `enqueue_webhook_dlq(account_id, config_id, payload, error)`; criar cron de reprocesso (existe padrão em `/api/*/cron`). Fecha §C-17/§F-28.
- **Idempotency-key** na chamada de envio à Graph API (e equivalente por provider) para fechar §C-16.
- **Webhook não-Meta:** mover o segredo do path para **header** + HMAC quando o provider suportar; nonce/timestamp para replay; comparação constant-time; resolução por `connection_id` na URL (não scan).
- **Persistir falha de envio** como `messages.status='failed'` para dar visibilidade no inbox (§C-17).

### 8.5 Broadcast multi-provider + fila
- Extrair o envio de broadcast para o mesmo `getProvider()` do send route (ramo por provider), com bloqueio de template só onde não há suporte.
- Mover o fan-out para uma **fila/worker** (mesmo padrão de cron já presente) com rate-limit por-mensagem e idempotência por `(broadcast_id, contact_id)`.

### 8.6 Observabilidade
- `correlation_id` por evento; logs estruturados com `{tenant, connection, provider, message_id, external_id, direction, status}`. Meta: contadores por provider/tenant.

---

## 9. Roadmap priorizado

### P0 — Integridade e confiança (fazer primeiro)
1. **Idempotência inbound** — índice único `(conversation_id, provider, external_id)` + `ON CONFLICT DO NOTHING`. (§C-15/16, §B-8/10)
2. **`parseStatus` + status para todos os providers** — unificar processamento de status. (§C-13, §D-20)
3. **Ligar a DLQ** no catch do webhook + cron de reprocesso. (§C-17, §F-28)
4. **Segurança do webhook não-Meta** — HMAC/replay onde possível, resolução O(1), constant-time. (§F-27)

### P1 — Fronteiras arquiteturais (habilita o multi-provider "de verdade")
5. **Unificar pipeline inbound** sobre `processInboundMessage`; Meta usa `MetaProvider`. (§D-20)
6. **Broadcast por provider** + fila/worker idempotente. (§E-23)
7. **`messages.provider`/`external_id`/`direction`**; persistir `failed` no envio. (§B-7, §C-17)
8. **Tabela `connections`** (provider por conexão, múltiplos números). (§A-3, §D-21)

### P2 — Higiene e robustez
9. FKs `user_id` → `ON DELETE SET NULL`; remover `profiles.role`. (§A-4, §A-2)
10. `CHECK` em `whatsapp_config.provider`; `messages.status` incluir/normalizar `replied`. (§B-10, §C-13)
11. Mídia não-Meta via proxy autenticado (paridade com Meta). (§B-9)
12. Rate-limit distribuído (Redis/Upstash) se escalar além de 1 instância; observabilidade estruturada. (§C-14, §F-28)

---

## 10. Resposta às perguntas centrais do briefing

| Pergunta | Resposta curta |
|---|---|
| Onde termina a Meta e começa o WACRM? | No `wamid`/id externo retornado. A partir daí, persistência é 100% do WACRM — mas o WACRM **não** normaliza esse id entre providers. |
| Um usuário afeta dados de outro cliente? | Via sessão autenticada: **não** (RLS). Via webhook não-Meta: **plausível** por fraqueza do segredo-na-URL. |
| Credenciais são do cliente ou globais? | Do cliente (AES-GCM por tenant). Único global: `META_APP_SECRET`. |
| O banco protege o tenant ou só o código? | **O banco protege** (RLS real). Exceção necessária: writes de webhook via service role. |
| Existe estratégia de correlação multi-provider? | **Não** — funciona só para Meta hoje. É o item #1 do design alvo. |
| Existe contrato MessageProvider? | **Sim, ~60% pronto.** Falta `parseStatus`, unificação do inbound e adoção pelo Meta. |
| O retry envia duas mensagens ao cliente? | Improvável no outbound (para no 1º sucesso), mas **possível** sem idempotency-key; no inbound o retry **duplica persistência** (sem dedup). |
| A escolha do provider é por tenant? | Sim, mas **por conta**, não por conexão — falta a entidade `connection`. |

---

*Relatório gerado como parte da AUD-001. Evidências apontam para arquivos e migrations reais do repositório; itens em §7 requerem validação adicional antes de implementação.*
