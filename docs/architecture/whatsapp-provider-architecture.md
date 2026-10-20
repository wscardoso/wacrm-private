# WhatsApp Provider Architecture — Checkpoint

**Status:** Checkpoint descritivo do estado real do código em `main` (baseline `62e88b7`).
**Data:** 2026-07-17
**Propósito:** mapear o que existe hoje — não uma arquitetura-alvo. Não substitui o ADR-ATTR-001 nem o AUD-001-consolidado; complementa os dois com uma visão estrutural única. Objetivo prático: evitar arqueologia futura no `whatsapp-config.tsx` (1400+ linhas) e nos dois pipelines inbound.

## 1. Escopo

Este documento descreve: os três providers WhatsApp e suas fronteiras reais; o contrato `InboundMessage`; os dois pipelines inbound ainda existentes; onde a normalização acontece; como a identidade externa da mensagem é preservada (e a diferença entre a chave do C4 e a chave da atribuição CTWA); a relação entre outbound e inbound; responsabilidades por camada; decisões consolidadas; e dívidas arquiteturais conhecidas (derivadas do AUD-001, ainda abertas).

Não propõe soluções para nada listado como dívida. Não reabre nem altera o C4.

## 2. Os três providers

Todos implementam `WhatsAppProvider` (`src/lib/whatsapp/providers/types.ts`): `sendText/sendMedia/sendTemplate/sendReaction/sendInteractiveButtons/sendInteractiveList/parseInboundMessage/verifyWebhookRequest`.

| Provider | Status | HMAC no webhook | Templates HSM | Atribuição CTWA nativa |
|---|---|---|---|---|
| `MetaProvider` | Oficial | Sim (`x-hub-signature-256`) | Sim | Sim (`referral`) |
| `UazapiProvider` | Oficial (não-Meta) | Não — segredo na URL | Não (fallback texto) | Não |
| ~~`ZApiProvider`~~ | **Removido em 2026-10-20** (ver §Remoção da Z-API) | — | — | — |

`getProvider(config)` (`providers/index.ts`) é a factory que resolve config → instância de provider. **Hoje ela é chamada em um único lugar do codebase: `src/app/api/whatsapp/send/route.ts`, no ramo `provider !== 'meta'`.** Nenhum outro caminho de envio usa a factory.

## 3. Outbound: quem usa a abstração e quem não usa

Verificado por grep direto de imports de `meta-api.ts` vs `providers/`:

- **Usa `getProvider()`:** apenas `send/route.ts` (envio manual do agente pelo composer).
- **Importa `meta-api.ts` diretamente, ignorando a abstração:**
  - `src/lib/automations/meta-send.ts`
  - `src/lib/flows/meta-send.ts`
  - `src/app/api/whatsapp/broadcast/route.ts`
  - `src/app/api/whatsapp/react/route.ts`

Consequência prática: mensagens disparadas por automations, por flows, broadcasts e reações de agente **só funcionam em contas Meta**. Uma conta uazapi tem envio manual de texto/mídia funcional, mas nenhuma automação, flow, broadcast ou reação chega ao destinatário. Isso corresponde a C1/C2/C3 do AUD-001-consolidado — achados confirmados nesta verificação, ainda abertos, fora do escopo do C4.

`MetaProvider.parseInboundMessage` existe e é testável isoladamente, mas a rota webhook Meta não o chama — mantém parsing inline próprio, comentário explícito no código: *"provided for symmetry with other adapters but the Meta webhook route does NOT call it — full backward compatibility."* (C8 do AUD-001, aberto.)

## 4. O contrato `InboundMessage`

Formato canônico normalizado (`providers/types.ts`): `messageId, from, senderName, timestamp, type, contextMessageId, text, mediaRef, mediaRefIsUrl, mimeType, caption, filename, reactionTargetMessageId/Emoji, interactiveReplyType/Id/Title`.

`mediaRefIsUrl` existe porque Meta retorna um media ID opaco (exige proxy autenticado — `mediaRefIsUrl=false`), enquanto o uazapi retorna URL direta consumível sem autenticação adicional (`mediaRefIsUrl=true`).

## 5. Duas camadas de normalização

1. **Payload do provider → `InboundMessage`**: dentro de cada adapter. `parseMetaPayload` (`providers/meta.ts`), `UazapiProvider.parseInboundMessage`. A rota webhook Meta faz o equivalente inline, sem passar pelo adapter (ver §3).
2. **`InboundMessage` / mensagem Meta → linha em `messages`**: lógica quase-idêntica duplicada entre `inbound-processor.ts` (`processInboundMessage`) e `webhook/route.ts` (`processMessage`) — mesmo `toContentType`, mesma resolução de `contentText`/`mediaUrl`, mesmo resolve de reply-context, mesma ordem de passos. É duplicação de manutenção real: qualquer mudança de regra de domínio (ex.: novo `content_type`, nova regra de first-touch) precisa ser replicada nos dois lugares.

## 6. Os dois pipelines inbound

- **Meta inline** — `src/app/api/whatsapp/webhook/route.ts`, função `processMessage()`. Parsing e orquestração de domínio no mesmo arquivo (~1080 linhas).
- **Compartilhado não-Meta** — `src/app/api/whatsapp/webhook/[provider]/[webhookSecret]/route.ts` → `processInboundMessage()` em `src/lib/whatsapp/inbound-processor.ts`. Serve o uazapi via `InboundMessage`. O segmento `zapi` dessa rota responde `410 Gone`.

**Isso é dívida arquitetural reconhecida, não uma decisão final.** O próprio código documenta a intenção: comentário no topo de `inbound-processor.ts` — *"When the Meta webhook is eventually unified, this is the shared base both paths will use."* Essa unificação nunca aconteceu e **não é escopo deste checkpoint** — só está sendo registrada aqui como debt conhecido, para não se perder de vista.

## 7. Identidade externa da mensagem — duas chaves distintas, não confundir

**`message_id`** — identidade da mensagem em si, usada para dedup de persistência (C4, fechado, `62e88b7`). Populada por `msg.id` (Meta) ou `messageId`/`key.id` (uazapi). Índice único parcial:

```sql
CREATE UNIQUE INDEX idx_messages_conv_msgid_customer
  ON messages (conversation_id, message_id)
  WHERE sender_type = 'customer' AND message_id IS NOT NULL AND message_id <> ''
```

Inserção via RPC `insert_inbound_message` (`ON CONFLICT (conversation_id, message_id) WHERE <predicado> DO NOTHING RETURNING id`), chamada nos dois pipelines (Meta inline e `inbound-processor.ts`) com o gate `wasInserted` protegendo os efeitos downstream (unread_count, broadcast-reply, flows, automations) de duplicação em redelivery. Verificado nesta sessão: não há outro `INSERT`/RPC de mensagem com `sender_type='customer'` fora desses dois caminhos — cobertura confirmada.

**`origin_message_id`** — chave de idempotência da tabela `lead_attributions` (ADR-ATTR-001), **não a mesma coisa**. É o wamid da mensagem que carregou o `referral` do Click-to-WhatsApp. Deliberadamente não é `ctwa_clid`, porque `ctwa_clid` pode ser NULL em alguns formatos de referral e um NULL nunca colide consigo mesmo num índice único. As duas chaves resolvem problemas de idempotência diferentes, em tabelas diferentes, e não devem ser tratadas como intercambiáveis.

## 8. Dependência implícita: uma conexão por conta

Hoje `message_id` é escopado só por `conversation_id`, não por provider/conexão. Isso é seguro porque `whatsapp_config` tem `UNIQUE(account_id)` — uma conta só pode ter uma config/provider ativo por vez (C10 do AUD-001). Se essa restrição mudar no futuro (multi-conexão por conta, ex.: Meta + uazapi simultâneos na mesma conta), a chave de dedup do C4 precisaria incorporar a conexão/provider — isso não é um problema hoje, mas é uma pré-condição implícita que vale manter visível.

## 9. Outbound × inbound: como se relacionam

Não há acoplamento estrutural — são caminhos independentes que só se cruzam em `messages` e na resolução de reply/quote (`contextMessageId` ↔ `reply_to_message_id`, lookup por `message_id` nos dois sentidos). O único outbound que passa pela abstração de provider é `send/route.ts` (§3); broadcast e reação de agente são outbound que não passam por provider algum hoje — vão direto a `meta-api.ts`, e por isso não têm equivalente funcional em contas não-Meta.

## 10. Responsabilidades por camada (como estão, não como deveriam)

- **Provider** (`providers/*.ts`): tradução para a API HTTP de cada serviço; parsing de payload inbound → `InboundMessage`; verificação de webhook (`verifyWebhookRequest` — só Meta faz HMAC real; uazapi retorna `true` sempre, segurança delegada ao segredo-na-URL — C7, aberto).
- **Processor** (`inbound-processor.ts`): orquestração de domínio do caminho não-Meta — contato/conversa, dedup, dispatch de flows/automations.
- **Webhook route**: autenticação/roteamento HTTP. No caminho Meta, além disso concentra parsing e toda a orquestração de domínio (não delega ao processor — ver §6).

Não existe uma camada "adapter" separada do "provider" no código atual — são o mesmo objeto.

## 11. Decisões já consolidadas

- Z-API foi **removido** em 2026-10-20. Antes disso era experimental/interno, gated por `WHATSAPP_ENABLE_ZAPI` / `NEXT_PUBLIC_WHATSAPP_ENABLE_ZAPI` (commit `3724e31`); esses flags não têm mais efeito. Meta e uazapi são os providers suportados.
- **C4 fechado** (`62e88b7`): idempotência inbound via RPC com `ON CONFLICT ... WHERE <predicado parcial> DO NOTHING RETURNING id`, chave `(conversation_id, message_id)`, cobrindo os dois pipelines. Auditado, `APPROVE WITH NOTES`. Ressalvas conhecidas e aceitas, fora de escopo: `message_id=''` não é deduplicado (decisão de escopo); o read-modify-write de `unread_count` para mensagens distintas concorrentes é um bug separado, não tratado pelo C4.
- Atribuição CTWA (ADR-ATTR-001): chave de idempotência é `origin_message_id`, nunca `ctwa_clid`; first-touch no contato nunca é sobrescrito; só Meta tem atribuição nativa hoje (§7).
- `waba_id` foi reusado para armazenar o `client_token` criptografado do Z-API. Nenhum código o lê ou grava mais para esse fim; linhas antigas de contas Z-API podem manter um valor residual nessa coluna (não removido — ver §Remoção da Z-API).

## 12. Dívidas arquiteturais conhecidas (AUD-001, ainda abertas)

Nenhuma destas foi tratada pelo C4 e nenhuma está proposta para resolução neste documento:

- **C1/C2/C3/C8** — abstração de provider não é usada por automations, flows, broadcast e reactions (Meta-only hardcoded); webhook Meta não usa `MetaProvider.parseInboundMessage`. Confirmado nesta sessão (§3, §6).
- **C5** — status de entrega (`sent/delivered/read`) só é processado no caminho Meta; não-Meta fica travado em `sent`.
- **C6** — DLQ (`enqueue_webhook_dlq`) nunca é chamada.
- **C7** — webhook não-Meta sem HMAC, segredo na URL, lookup de config por scan O(n). Registrado como dívida futura, junto com o reuso de `waba_id` (§11) — ambos deliberadamente fora do escopo imediato, por ordem de prioridade do usuário.
- **C9/C10/C11** — `messages` sem `provider`/`account_id` próprios (isolamento hoje via JOIN em `conversations`); uma conexão por conta (§8).
- **C12** — mídia não-Meta armazenada como URL crua, sem proxy/auth, sujeita a expiração.
- **C13** — `ENCRYPTION_KEY` única, sem versionamento/rotação.
- **C14** — envio não-Meta não pausa flows ativos ao intervir um agente.
- **C15** — webhook não-Meta sem rate-limit próprio.
- **C22** — cobertura de teste real (produção) do uazapi ainda pendente — é o item "matriz de testes" do roadmap, não iniciado.

## 13. Impacto arquitetural do C4

Fechou exclusivamente a duplicação de persistência inbound (C4). Estabeleceu um padrão reutilizável — RPC com `ON CONFLICT ... WHERE <predicado> DO NOTHING RETURNING id` para contornar a limitação do supabase-js (`.upsert(ignoreDuplicates)` não suporta índice único parcial, erro `42P10`) — que provavelmente será necessário de novo se C9 avançar (dedup mais rico por `provider`+`external_id`).

**O C4 não unificou os dois pipelines inbound (§6), não resolveu C1/C2/C3/C5/C6/C7/C8/C9/C10/C11/C12/C13/C14/C15/C22, e não deve ser reaberto para tentar cobri-los.** Cada um permanece como item de trabalho separado, priorizável independentemente.

## 14. Não-objetivos deste documento

Não propõe solução de design para C7 ou para o reuso de `waba_id`. Não reabre, não estende e não corrige o C4. Não é uma arquitetura-alvo — é um retrato do código em `62e88b7`, para servir de ponto de partida factual à próxima decisão do roadmap.

## Remoção da Z-API

**Decisão operacional (2026-10-20):** o provider Z-API foi removido do ForceCRM. Meta e uazapi permanecem suportados e inalterados.

O que mudou:

- `providers/zapi.ts` e os scripts `scripts/bootstrap-zapi-webhook.mjs` / `scripts/rotate-zapi-webhook.mjs` foram apagados.
- `getProvider` só aceita `meta` e `uazapi`. A escolha a partir de uma linha de `whatsapp_config` é feita por `providerConfigFromRow` (`providers/index.ts`) e é **explícita**: qualquer valor diferente de `meta`/`uazapi` (inclusive `zapi`) lança `ProviderUnsupportedError`. Ela **nunca** cai em Meta por omissão — isso executaria uma credencial Z-API contra a API da Meta.
- `POST /api/whatsapp/config` com `provider: "zapi"` responde `400`, sem ler nem gravar nada. `GET` de uma linha legada responde `200` com `connected: false` e `reason: "provider_unsupported"`. `DELETE` continua funcionando para qualquer provider.
- `/api/whatsapp/webhook/zapi/{connectionId}/{secret}` (GET e POST) responde `410 Gone` antes de qualquer consulta ao banco.
- Envio (`/send`, `/broadcast`, `/react`), automations e flows para uma conta com `provider='zapi'` falham com `ProviderUnsupportedError` (as rotas HTTP respondem `400`). O cron de entrega **bloqueia** as retentativas dessa conexão (`pending`, `next_attempt_at NULL`, `last_error` explícito — ADR-E4B-002 §5 caminho D) e o orphan-sweep dá o mesmo tratamento às órfãs `sending`, sem decifrar a credencial: nada é reenviado nem marcado como enviado; só o TTL de 72 h resolve (a mensagem vira `failed`). *Correção:* antes da correção desta etapa o TTL passava `''` ao parâmetro UUID `p_connection_ref` (rejeitado pelo PostgreSQL), então essa resolução não ocorria; agora passa `NULL`.
- **Vínculo de entrega (implementado localmente, migration 083 preparada e NÃO aplicada):** toda mensagem de saída grava, no mesmo INSERT feito por `createIntent` (único criador; Flows e Automations também passam por ele), `connection_ref` (`whatsapp_config.id`), `delivery_provider` e `delivery_channel_fp` (`v1:` + SHA-256 de provider/`phone_number_id` ou `instance_id`+`base_url`, sem segredos). Cron e orphan-sweep só reenviam se a conexão atual existir, for da mesma conta da conversa, tiver o mesmo provider e reproduzir a impressão digital, e houver evidência de não entrega (`deterministic_transient` ou `nativeIdempotency` real); caso contrário bloqueiam com motivo explícito. Mensagens anteriores (colunas `NULL`) nunca são reenviadas nem preenchidas retroativamente. Detalhes e rollout: `docs/operations/zapi-decommission/delivery-binding-rollout.md`.
- As variáveis `WHATSAPP_ENABLE_ZAPI` e `NEXT_PUBLIC_WHATSAPP_ENABLE_ZAPI` foram removidas de `.env.local.example` e não são mais lidas.

O que **não** mudou (e por quê):

- Nenhuma migration. A coluna `whatsapp_config.provider` e as linhas existentes ficam como estão; um valor `zapi` persistido é reconhecido apenas para exibir o aviso de migração e permitir a exclusão.
- `waba_id` de linhas `provider='zapi'` pode conter o antigo Security Token cifrado. Nenhum dado foi apagado; o procedimento operacional preparado (e **não executado**) está em `docs/operations/zapi-decommission/`. Salvar a linha como uazapi passa a gravar `waba_id = NULL`.
- `InboundDlqSource` e testes unitários da DLQ ainda aceitam o literal `'zapi'`: linhas históricas de `whatsapp_webhook_dlq` podem ter essa origem.
- Documentos históricos (ADRs, checkpoints, roadmap) continuam descrevendo a Z-API como ela era.

Migração de uma conta existente: abrir *Configurações → Conexão WhatsApp*, escolher uazapi (ou Meta), informar as novas credenciais e salvar; ou usar *Reset Configuration* para remover a linha antiga.
