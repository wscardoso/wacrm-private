# ADR-ATTR-001 — Lead Attribution (Click-to-WhatsApp + Rastreio de Origem)

**Status:** Proposto (aguarda contestação de GPT/HY3 antes de congelar)
**Snapshot:** working tree = HEAD `bac3065` + WIP não-commitado (ver `docs/AUD-001-consolidado.md` §0)
**Arquiteto:** Claude/Opus · **Executor:** Sonnet 5
**Prioridade:** #1 do produto (ver memória: North Star = saber a origem do lead)

---

## 1. Contexto e objetivo

Weyner (Digitall Force) opera o WACRM para si e 4 clientes de tráfego pago (Oral Unic Contagem, Oral Unic Almirante Tamandaré, Clique Fibra Telecom, Átomo). A **maioria dos leads chega de anúncios pagos**. O objetivo: para cada conversa, saber **origem, campanha, conjunto, anúncio, posicionamento** — e, quando possível, **ver o criativo do anúncio** dentro do CRM. Depois: **retroalimentar** Meta/Google com as conversões reais do CRM.

Hoje o WACRM **descarta 100%** desse dado: a interface `WhatsAppMessage` do webhook não tem campo `referral`, e nenhuma tabela guarda origem.

**Referência de mercado (Tintim):** entrega isso por (a) `referral` nativo do Meta em campanhas Click-to-WhatsApp, (b) links rastreáveis com token na mensagem para as demais fontes, (c) Conversions API para retroalimentar. Como o WACRM **é dono do inbox**, (a) é nativo aqui; (b) só é necessário para fontes não-CTWA (Google Ads, botão de site, bio).

## 2. Decisões arquiteturais

**D1 — Granularidade: atribuição por CONVERSA, com first-touch preservado no CONTATO.**
Cada conversa registra o anúncio que a originou (multi-touch ao longo do tempo). O contato guarda a **primeira** origem de todas (first-touch imutável). Justificativa: clínica/telecom recebem o mesmo lead por vários anúncios; você quer saber qual anúncio trouxe *cada retorno*, sem perder o primeiro. *(Decisão do arquiteto — Weyner pode vetar.)*

**D2 — Duas fontes de captura, um único modelo de destino.**
- **Fonte A (nativa):** `referral` do webhook Meta (Click-to-WhatsApp). Fidelidade total, zero infra.
- **Fonte B (link rastreável):** redirect próprio + token na mensagem pré-preenchida, para Google Ads / botão de site / bio / qualquer não-CTWA.
Ambas gravam no mesmo modelo canônico de atribuição.

**D3 — `attribution` é uma capacidade da conexão.** Só conexões `meta` (oficial) recebem `referral`. Conexões `uazapi` não têm atribuição nativa — dependem exclusivamente da Fonte B. O contrato de provider expõe `supports: { attribution }` (casa com ADR-001/004).

**D4 — Capturar cru agora, enriquecer depois.** O `referral`/token é gravado imediatamente no primeiro contato. O join com Marketing API (nomes de campanha/conjunto/posicionamento + criativo) é assíncrono/sob demanda, não bloqueia o webhook.

**D5 — Entregar P0 cirúrgico no webhook Meta atual, sem esperar o refactor de boundary.** A captura de `referral` é **aditiva e de baixo risco**. Não depende dos ADRs de idempotência/boundary — entra já, e depois é migrada para o `parseEvents` canônico (ADR-002).

## 3. Modelo de dados

### 3.1 Origem canônica (nova tabela)
```sql
CREATE TABLE lead_attributions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE CASCADE,
  source_channel    TEXT NOT NULL,          -- 'ctwa_meta' | 'tracked_link' | 'organic' | 'unknown'
  -- Bruto do referral (Fonte A) ou do clique (Fonte B)
  ad_source_id      TEXT,                    -- referral.source_id (ID do anúncio)
  ad_source_type    TEXT,                    -- 'ad' | 'post'
  ad_source_url     TEXT,
  ad_headline       TEXT,                    -- criativo: título
  ad_body           TEXT,                    -- criativo: corpo
  ad_media_type     TEXT,                    -- 'image' | 'video'
  ad_media_url      TEXT,                    -- thumbnail do criativo (para exibir o anúncio)
  ctwa_clid         TEXT,                    -- click id (chave da CAPI) — PODE SER NULL
  origin_message_id TEXT,                    -- wamid da 1ª mensagem que trouxe o referral — CHAVE DE IDEMPOTÊNCIA
  fbclid            TEXT,                    -- Fonte B
  gclid             TEXT,                    -- Fonte B (Google)
  utm               JSONB,                   -- {source,medium,campaign,content,term}
  -- Enriquecido via Marketing API (D4, assíncrono)
  campaign_id       TEXT, campaign_name  TEXT,
  adset_id          TEXT, adset_name     TEXT,
  ad_id             TEXT, ad_name        TEXT,
  placement         TEXT,                    -- feed/stories/reels/...
  enriched_at       TIMESTAMPTZ,
  raw               JSONB,                   -- payload bruto para auditoria
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lead_attr_conversation ON lead_attributions(conversation_id);
CREATE INDEX idx_lead_attr_account_created ON lead_attributions(account_id, created_at DESC);
CREATE INDEX idx_lead_attr_ctwa ON lead_attributions(ctwa_clid) WHERE ctwa_clid IS NOT NULL;
-- Idempotência: NÃO usar ctwa_clid (pode ser NULL). Dedupe pela mensagem de origem (wamid, sempre presente):
CREATE UNIQUE INDEX idx_lead_attr_origin_msg
  ON lead_attributions(origin_message_id) WHERE origin_message_id IS NOT NULL;
-- RLS: SELECT via is_account_member(account_id); writes só service-role (webhook).
```

### 3.2 First-touch desnormalizado no contato
```sql
ALTER TABLE contacts
  ADD COLUMN first_attribution_id UUID REFERENCES lead_attributions(id) ON DELETE SET NULL,
  ADD COLUMN first_source_channel TEXT;   -- leitura rápida em listas
```
Regra: gravado **uma vez** (quando NULL). Nunca sobrescrito.

### 3.3 Ponteiro na conversa
```sql
ALTER TABLE conversations
  ADD COLUMN attribution_id UUID REFERENCES lead_attributions(id) ON DELETE SET NULL;
```
Cada conversa aponta para a origem que a abriu (a mais recente).

### 3.4 Tabela de cliques (Fonte B — fase P2)
```sql
CREATE TABLE tracking_links (
  id UUID PRIMARY KEY, account_id UUID NOT NULL, slug TEXT UNIQUE,
  destination_phone TEXT, prefilled_text TEXT, utm JSONB, created_at TIMESTAMPTZ
);
CREATE TABLE tracking_clicks (
  id UUID PRIMARY KEY, link_id UUID REFERENCES tracking_links(id),
  token TEXT UNIQUE,                        -- injetado na mensagem pré-preenchida
  fbclid TEXT, gclid TEXT, utm JSONB, user_agent TEXT, ip INET,
  clicked_at TIMESTAMPTZ, matched_conversation_id UUID
);
```

## 4. Mecanismo de captura

### Fonte A — Click-to-WhatsApp nativo (Meta)
No `processMessage` do webhook Meta, ler `message.referral` na **primeira mensagem** da conversa. Se presente → criar `lead_attributions` (`source_channel='ctwa_meta'`), ligar em `conversations.attribution_id`, e (se `contacts.first_attribution_id` for NULL) gravar o first-touch. Idempotente por `origin_message_id` (wamid da mensagem) — **nunca** `ctwa_clid`, que pode ser NULL (ver §3.1).

### Fonte B — Link rastreável (P2)
`GET /r/[slug]?fbclid&gclid&utm_*` → cria `tracking_clicks` com `token`, seta cookie `_fbp/_fbc` via Meta Pixel numa página-interstício, e redireciona para `wa.me/<phone>?text=<prefilled> [#token]`. Na primeira mensagem inbound, extrair o token do corpo → casar com `tracking_clicks` → criar `lead_attributions` (`source_channel='tracked_link'`) e limpar o token do texto exibido.

## 5. Enriquecimento (Marketing API — P1)
Job assíncrono: pega `lead_attributions` com `ad_source_id` e `enriched_at IS NULL`, consulta a Graph API (Marketing) da conta de anúncios do cliente → preenche `campaign/adset/ad/placement` + criativo. Weyner é o gestor de tráfego → tem acesso às contas. Credenciais da conta de anúncios por tenant (novo, criptografado).

## 6. Retroalimentação (Conversions API — P3)
Quando uma conversa vira resultado no CRM (deal ganho / venda detectada), disparar evento para a Meta (**Conversions API for Business Messaging**, `action_source=business_messaging`) usando `ctwa_clid`. Fecha o ciclo: a Meta otimiza para leads que convertem. Google Ads: exportar conversões offline via `gclid`.

## 7. Fases

| Fase | Entrega | Depende de | Valor |
|---|---|---|---|
| **P0** | Captura nativa `referral` (Fonte A) + modelo + exibir origem/criativo no inbox | nada (cirúrgico no webhook Meta) | Origem + anúncio dos leads Meta **já** |
| **P1** | Enriquecimento Marketing API (campanha/conjunto/posicionamento/criativo) | P0 + credencial de ad account | Nomes legíveis + posicionamento |
| **P2** | Links rastreáveis (Fonte B) — Google Ads, botão, bio | P0 | Cobre fontes não-CTWA |
| **P3** | Conversions API (retroalimentar Meta/Google) | P0/P1 + detecção de venda | Otimização da verba (maior ROI) |
| **P4** | Inteligência de conversa (detectar venda/valor/etapa) | — | Dashboards estilo Tintim |

## 8. Pacote de execução P0 (para o Sonnet)

**Objetivo:** capturar e persistir a atribuição CTWA nativa, sem tocar no fluxo de idempotência/boundary.

**Arquivos permitidos:**
- `supabase/migrations/033_lead_attribution.sql` (novo — tabela + colunas + RLS + índices)
- `src/types/index.ts` (tipos `LeadAttribution`, `Referral`)
- `src/app/api/whatsapp/webhook/route.ts` (adicionar `referral` na interface `WhatsAppMessage`; capturar no `processMessage`)
- `src/lib/whatsapp/attribution.ts` (novo — `captureReferral()` puro + testado)
- `src/components/inbox/*` (exibir card de origem/anúncio na conversa)

**Arquivos proibidos:** engines (`automations/*`, `flows/*`), `broadcast/route.ts`, factory de provider, migrations 001–032.

**Invariantes:**
- Captura é **aditiva**: se não houver `referral`, comportamento idêntico ao atual.
- `contacts.first_attribution_id` nunca é sobrescrito depois de gravado.
- Escrita só via `supabaseAdmin()` no webhook; RLS de leitura por `is_account_member`.
- Idempotente: reprocessar o mesmo webhook não duplica `lead_attributions`. Chave = `origin_message_id` (wamid da 1ª mensagem), **nunca** `ctwa_clid` (pode ser NULL). Usar `INSERT ... ON CONFLICT (origin_message_id) DO NOTHING`.
- Nenhuma mudança no caminho não-Meta.

**Testes obrigatórios:**
- `attribution.test.ts`: parse de um `referral` completo; ausência de referral → null; referral sem `ctwa_clid`; segundo webhook idêntico → sem duplicação.
- Webhook: primeira mensagem CTWA cria attribution + liga na conversa + grava first-touch; um segundo clique CTWA do mesmo contato (nova mensagem `referral` na mesma conversa — o schema permite só uma conversa por `(account_id, contact_id)`) preserva o first-touch do contato e cria uma nova `lead_attributions`, atualizando `conversations.attribution_id` para essa atribuição mais recente.

**Critérios de aceite:**
- `tsc --noEmit` limpo; `vitest run` verde.
- Migration idempotente (roda 2x sem erro).
- Enviar um webhook de exemplo com `referral` → linha em `lead_attributions`, `conversations.attribution_id` e `contacts.first_attribution_id` preenchidos; inbox mostra o card do anúncio (headline/body/thumbnail).

## 9. Decisões abertas para Weyner
1. **D1 confirmada?** Atribuição por conversa + first-touch no contato. *(recomendado)*
2. Ordem P2 vs P3: cobrir **Google Ads/links** primeiro (P2) ou **retroalimentar Meta** primeiro (P3)? Depende de quanto do tráfego é CTWA nativo vs. link.
3. P4 (detecção de venda por IA) entra no escopo do WACRM ou fica fora?

## 10. Referências
- Meta — messages webhook reference (objeto `referral`): https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
- Conversions API for Business Messaging (CTWA / `ctwa_clid`): https://support.woztell.com/portal/en/kb/articles/wa-conversion-flow
- Benchmark de produto: Tintim (tintim.com.br) — links rastreáveis + CTWA + CAPI + inteligência de conversa
