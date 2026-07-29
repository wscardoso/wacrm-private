# CHECKPOINT E2.1 — Canonical Message Status (Fase 0)

| | |
|---|---|
| **Épico** | E2.1 — Canonical Message Status |
| **Fase** | Fase 0 — Contrato Arquitetural |
| **Data** | 2026-07-29 |
| **ADR produzido** | `docs/adr/ADR-MSG-STATUS-001.md` |
| **SHA auditado** | `26e5d39` |
| **Working tree no momento da auditoria** | Alterações pendentes apenas em documentação (`MASTER-ROADMAP.md`, dois checkpoints) e dois arquivos não versionados (`.claude/settings.json`, `scripts/rotate-zapi-webhook.mjs`). Nenhuma alteração em `src/` ou `supabase/` |
| **Código produzido** | **Nenhum.** Fase 0 é contrato |
| **Schema alterado** | **Nenhum.** Nenhuma migration criada |
| **ADRs existentes alterados** | **Nenhum** |

---

## 1. Escopo executado

Auditoria técnica do ciclo de status de mensagens no baseline `26e5d39` e produção do contrato arquitetural definitivo. As oito perguntas do enunciado foram respondidas com evidência de código; as oito definições exigidas foram emitidas como decisão normativa.

**Método.** Leitura direta de código e schema, sem inferência a partir de documentação. Toda afirmação do ADR aponta para arquivo e linha. Onde a evidência foi insuficiente para afirmar um fato de produção, isso está declarado como tal (D-C).

---

## 2. Respostas às oito perguntas de auditoria

| # | Pergunta | Resposta | Evidência |
|---|---|---|---|
| 1 | Como cada provider representa status atualmente? | Meta consome `value.statuses[]` cru. **Z-API e uazapi não representam status de forma alguma** | `webhook/route.ts:276-278, 392-461`; `zapi.ts`; `uazapi.ts` |
| 2 | Quais status chegam via callback? | Meta `sent/delivered/read/failed`; Z-API `SENT/RECEIVED/READ/PLAYED` (`ids[]`, ms); uazapi `ack 0..5`. Os dois últimos são descartados ou mal interpretados | ADR §2.2 |
| 3 | Quais status são persistidos? | `messages.status` CHECK = `('sending','sent','delivered','read','failed')`. `pending` e `received` **ausentes** apesar de D7. Três autoridades divergentes escrevem a coluna | `001:173`; `048`; `inbound-processor.ts:309`; `webhook/route.ts:359-390` |
| 4 | Existe normalização parcial? | **Não.** Existe coincidência assumida, declarada em comentário: *"Meta's status values already match the CHECK constraint"* | `webhook/route.ts:398-399` |
| 5 | Onde existem diferenças entre providers? | Sete eixos: vocabulário, semântica (`RECEIVED`≠`received`), granularidade (`PLAYED`), falha, cardinalidade (`ids[]`), unidade de tempo, identidade referenciada (R16) | ADR §2.5 |
| 6 | Quais estados pertencem ao domínio e quais ao provider? | Domínio: os sete de D2. Provider: `SENT/RECEIVED/READ/PLAYED`, `ack 0..5`, códigos de erro | ADR §2.7 |
| 7 | Como o domínio deve representar o ciclo completo? | Eixo de progresso monotônico de 5 níveis + terminal de exceção + estado degenerado de entrada | ADR D2, D6 |
| 8 | Como garantir compatibilidade para novos providers? | Cinco condições de D9/§6; domínio inalterado por provider novo | ADR §6 |

---

## 3. Definições emitidas

| Exigência | Onde | Síntese |
|---|---|---|
| **Estados canônicos** | D2 | `{pending, sending, sent, delivered, read, failed, received}` — sete, nenhum outro. `pending` e `received` são exatamente os dois que `ADR-MSG-001` D7 já declarou acrescentados |
| **Transições permitidas** | D6, T1–T7 + matriz 7×5 | Monotonicidade por **nível**, com salto admissível. Regressão é noop |
| **Estados terminais** | §4 | `read` (progresso), `failed` (exceção), `received` (absoluto) |
| **Estados transitórios** | §4 | `pending`, `sending`, `sent`, **`delivered`** |
| **Regras de idempotência** | D7, I1–I5 | CAS transacional; marca temporal nunca sobrescrita; idempotência de efeito distinta da de persistência (invariante A); `ids[]` decomposto |
| **Eventos fora de ordem** | D5, T2, T7 | Decididos por nível, nunca por timestamp. Progresso implícito sem inferência de marcas |
| **Providers com menos informação** | D9 | Mapa declarado por adapter; cobertura vazia por padrão; ausência de emissão nunca é evidência de negativa; desconhecido nunca vira `failed` |
| **Compatibilidade retroativa** | §5 | Nove superfícies mapeadas; única alteração de schema exigida é **aditiva** (`pending`, `received` no CHECK), declarada mas **não autorizada** por este ADR |

---

## 4. Defeitos ativos descobertos na auditoria

| # | Defeito | Severidade | Fechado por |
|---|---|---|---|
| **D-A** | Escada única governa dois vocabulários (`messages` × `broadcast_recipients`) | Alta | D3 |
| **D-B** | `'sending'` ausente da escada: `ladderLevel = -1` aceita qualquer estado, e `failed` a partir de `sending` é recusado | Alta | D6 (matriz inclui `sending`) |
| **D-C** | Parser de entrada Z-API não discrimina por `type` do envelope; `MessageStatusCallback` é candidato a virar mensagem de cliente fantasma | **Crítica** | A12 + critério §10.15 |
| **D-D** | Evento de status não correlacionável descartado em silêncio no caminho não-Meta | Alta | D8 |
| **D-E** | `webhook_dlq` (`031`) é tabela órfã — zero uso em `src/` | Média | D8 (destino a decidir em Fase 1) |
| **D-F** | `resolveMessageByExternalId` (`EIS-001` §4.1) não existe; E2.0 grava identidades sem leitor | Alta | D10 |

**D-C não é incidente confirmado.** A ausência de discriminação por `type` é fato verificado em código; a consequência em produção depende do payload real, que não foi capturado nesta fase. Está registrado como risco crítico com verificação obrigatória (§10.15 do ADR), não como falha observada. Nenhuma correção foi aplicada — Fase 0 não produz código.

---

## 5. Evidências do gate

| Evidência | Fonte |
|---|---|
| `WhatsAppProvider` declara 8 métodos; nenhum de parsing de status | `providers/types.ts:139-161` |
| Busca exaustiva `parseStatus\|StatusUpdate\|statusEvent\|status_event` retorna 2 linhas, ambas no webhook Meta | `grep src/` |
| Rota não-Meta trata payload exclusivamente como entrada; status → `{received:true, processed:0}` | `webhook/[provider]/[connectionId]/[webhookSecret]/route.ts:147-176` |
| uazapi retorna `null` sem `msg.message` → `MESSAGES_UPDATE` descartado | `uazapi.ts:255` |
| Gate Z-API é `fromMe === true`, não o campo `type` | `zapi.ts:230` |
| Sem guarda por `type:'unknown'` ou `messageId` vazio antes do INSERT de entrada | `inbound-processor.ts:294-320` |
| `messages.status` CHECK sem `pending`/`received` | `001_initial_schema.sql:173` |
| `broadcast_recipients.status` com vocabulário distinto, incluindo `replied` | `001_initial_schema.sql:325` |
| `settle_outbound_message` faz CAS estrito a partir de `'sending'` | `048_outbound_delivery_integrity.sql` |
| Entrada persistida com `status:'delivered'` fixo | `inbound-processor.ts:309`, `webhook/route.ts:695` |
| `handleStatusUpdate` resolve por `.eq('message_id', ...)`, não por identidade | `webhook/route.ts:407, 435` |
| `message_external_ids` gravado no envio; nenhum leitor | `settlement.ts:44-54`, `047` |
| `resolveMessageByExternalId` inexistente | busca em `src/` e `supabase/` |
| `webhook_dlq` sem uso em código de aplicação | `031`, `grep dlq src/` |
| `timestamp * 1000` incondicional no caminho de status | `webhook/route.ts:430` |
| Detecção de magnitude de timestamp existe no caminho de entrada | `inbound-processor.ts:287-292` |
| Nenhum commit da história atribuível a E2.1 | `git log --all --grep=status -i` |
| `outbound_retry_ledger` com vocabulário próprio (`pending/retrying/delivered/dead`) | `049` |

---

## 6. Conformidade com contratos congelados

| Contrato | Situação |
|---|---|
| `ADR-MSG-001` D7 | **Cumprido.** O ADR normatiza exatamente a delegação declarada, incluindo os dois estados (`pending`, `received`) que D7 acrescentou |
| `ADR-MSG-001` invariantes A–D | **Preservados.** A (efeito) em I4; B (idempotência de entrada) intocado; C (auth de webhook) invocado em D10; D (direção derivada) reafirmado em §4 |
| `ADR-MSG-001` §7 | **Preservado.** Convivência das duas populações de entrada mantida; nenhum backfill autorizado |
| `EIS-001` §4.1–§4.3, §8.13, §8.15 | **Consumidos, não reabertos.** D10 implementa o consumidor que faltava |
| `ODI-001` §5 | **Preservado.** `settle_outbound_message` mantém autoridade de liquidação de tentativa (D11) |
| `ADR-E4B-001/002/003` | **Não reabertos.** D12 declara fronteira; D9 evita ampliar `ProviderCapabilities` |
| `DLB-001` §10.1 | **Aplicado.** Default conservador para provider não declarado |
| `ADR-ATTR-001/002`, `E6.0` | **Intocados.** `E6.0` §1.2.6 já declarava `messages.status` fora de seu escopo; a recíproca é verdadeira |

Nenhum ADR existente foi alterado. Nenhum contrato aprovado foi reaberto.

---

## 7. Rascunho anterior substituído

Foram encontrados no disco, ao iniciar a Fase 0, dois arquivos não versionados de mesmo nome, criados em 2026-07-29 14:34 por sessão anterior. Foram lidos integralmente e **substituídos**, não mesclados. Cópias preservadas fora do repositório, em `…/scratchpad/ADR-MSG-STATUS-001.SUPERSEDED-draft-1434.md` e `…/CHECKPOINT-E2.1.SUPERSEDED-draft-1434.md`.

A substituição não foi de estilo. O rascunho continha decisões que contradizem código verificado ou contrato congelado:

| # | Defeito do rascunho | Consequência se implementado |
|---|---|---|
| 1 | Mapeava "Meta `pending` → `sending`" | Meta **não emite** `pending` em `statuses[]`. Mapeamento de vocabulário inexistente |
| 2 | Declarava 5 estados canônicos e "nenhuma alteração de schema necessária", mas também previa `received` | `received` não está no CHECK. Contradição interna; contraria D7, que amplia o conjunto para incluir `pending` **e** `received` |
| 3 | **Status desconhecido → `failed` como "default conservador"** | Fabrica não-entrega não observada; contamina métrica; pode disparar retry de mensagem entregue. É o pior default disponível (ADR A6) |
| 4 | Proibia salto de nível (`sending→delivered` ✗, `sent→read` ✗) e mandava **rejeitar** `read` chegado antes de `delivered` | Mensagem presa permanentemente sempre que um webhook intermediário se perde — ocorrência normal (ADR A5/T1) |
| 5 | Listava `delivered` como terminal e, na mesma seção, admitia `delivered → read` | Contradição interna |
| 6 | "Out-of-order → ignorar silenciosamente", repetido em cinco linhas | Viola `EIS-001` §8.13 diretamente |
| 7 | Não mencionava `message_external_ids`, `resolveMessageByExternalId` nem `EIS-001` §4.1 | Omite a razão pela qual E2.0 precede E2.1; R16 permaneceria aberto na leitura |
| 8 | Não fornecia mapa de status de Z-API nem de uazapi ("mapeamento a definir por provider") | Deixa indefinido o entregável central do épico |
| 9 | Não identificava a homonímia Z-API `RECEIVED` ≠ `received` | Risco crítico R1 não mitigado |
| 10 | Mandava consultar o ledger de retry (E4b) para inferir status e integrar testes de E4b ao status | Conflaria eixo de tentativa com eixo de mensagem (ADR D12/A8) |
| 11 | Citava "`EIS-001` critérios 10–13 (forward-only transitions)" | Miscitação: 10–13 tratam de identidade Z-API e de não-correlação observável, não de transições |
| 12 | Não identificava D-A, D-B, D-C, D-D, D-E nem D-F | Seis defeitos ativos permaneceriam invisíveis à Fase 1 |
| 13 | Afirmava "working tree limpa" | Havia três arquivos modificados e dois não versionados |

Os itens 3, 4 e 6 são defeitos de correção — produziriam perda de dados de estado ou fabricação de fato — e são a razão pela qual a substituição foi integral.

---

## 8. Pré-condições obrigatórias para a Fase 1

Nenhuma reabre contrato; todas são verificação ou ampliação aditiva.

1. **Capturar payload real** de `MessageStatusCallback` (Z-API) e de `MESSAGES_UPDATE` (uazapi) e fixá-los como fixture antes de escrever código (D-C, §10.15).
2. **Quantificar o acervo** eventualmente afetado por D-C antes de qualquer correção — medir precede corrigir.
3. **Migration aditiva** de `messages.status` para admitir `pending` e `received`. Aditiva, reexecutável, sem remoção nem renomeação.
4. **Implementar `resolveMessageByExternalId`** conforme `EIS-001` §4.1–§4.3, com o critério 15 verificado (D-F, R4).
5. **Decidir o destino do registro de D8** — reuso de `webhook_dlq` (`031`) ou superfície própria.
6. **Separar as escadas** de `messages` e `broadcast_recipients` (D-A) preservando `flagBroadcastReplyIfAny` e os contadores agregados (R8).
7. **Suíte Meta verde** antes de iniciar e ao concluir (`ADR-MSG-001` §7).

---

## 9. Decisão

🟢 **Contrato aprovado para implementação.**

**Fundamento.** O contrato é completo sobre as oito perguntas e as oito definições exigidas; é internamente consistente; não reabre nenhum contrato congelado; e cada decisão está ancorada em evidência de código verificada em `26e5d39`. Os seis defeitos ativos descobertos (D-A…D-F) são **entradas** para a Fase 1, não contradições do contrato — cada um tem decisão que o fecha e critério de aceitação que o verifica.

**Alcance da aprovação.** A aprovação é do **contrato**, não do início imediato da codificação. As sete pré-condições de §8 são vinculantes; as duas primeiras — captura de payload real e quantificação do acervo — precedem qualquer linha de código, porque D-C é o único item da auditoria cuja severidade é crítica e cuja confirmação depende de evidência que a Fase 0 não podia obter.

**O que tornaria 🔴 a decisão correta**, e não ocorreu: conflito entre o contrato e uma decisão congelada; ambiguidade em estado, transição ou mapeamento; ou necessidade de reabrir `ADR-MSG-001`, `EIS-001` ou `ODI-001`. Nenhuma das três se verificou.

---

*Fase 0 encerrada. Nenhum código, schema, migration ou ADR existente foi alterado. Os únicos arquivos escritos são `docs/adr/ADR-MSG-STATUS-001.md` e este checkpoint.*
