# CHECKPOINT-FORCECRM-GROUP-B-RESULT

## 1. Resumo Executivo

Este documento cobre a validação operacional real do **Grupo B**, conforme escopo definido no
prompt de execução recebido em 2026-07-28, com base em `CHECKPOINT-FORCECRM-SECRET-ROTATION.md`
(secret rotacionado, hash persistido, Grupo A aprovado).

**Os 4 cenários obrigatórios foram executados**, em sessão conjunta entre o operador (Weyner) e o
assistente, contra o ambiente de deploy real `https://forcecrm.digitallforcelabs.cloud`, usando a
instância Z-API real "Digitall Force Labs" (a única instância com número de WhatsApp conectado —
nenhum tenant piloto Atomo Soluções/Oral Unic tem número próprio conectado).

Uma primeira tentativa de execução automatizada (CLI, sem acesso a browser/painel/telefone) havia
sido corretamente recusada e registrada como `INTERROMPIDO` em versão anterior deste documento,
que entregou um runbook manual. Este documento substitui aquela versão com o resultado real da
execução desse runbook.

Durante a execução, um erro de atribuição de tenant foi encontrado e corrigido **antes** de
qualquer persistência incorreta — ver seção 3.4.

---

## 2. Cenários Executados

Todos os 4 cenários obrigatórios foram executados nesta sessão, com evidência real coletada.

---

## 3. Evidências

### 3.1 Cenário 1 — Inbound Real via Webhook

- **Pré-condição:** o secret em texto puro da primeira rotação (`CHECKPOINT-FORCECRM-SECRET-ROTATION.md`,
  seção 3) havia se perdido (não foi salvo em gerenciador de senhas). O operador rodou
  `scripts/rotate-zapi-webhook.mjs` uma segunda vez, no próprio terminal (não repassado ao
  assistente, para não repetir a exposição de secret em texto puro no chat).
  - **Timestamp da 2ª rotação:** `2026-07-28T15:34:55.275Z`
  - **Novo hash SHA-256:** `d2d3caf0e2d1d992105b100d931ecf1fe0f93a69991dae9c3380aa56b749b9b3`
- **Webhook configurado:** painel Z-API → instância "Digitall Force Labs" → webhook "Ao receber"
  apontando para `https://forcecrm.digitallforcelabs.cloud/api/whatsapp/webhook/zapi/a3f7e05a-59f4-4727-b1b1-9843cfed4181/<secret>`.
- **Mensagem de teste enviada:** "Oi", de número de teste autorizado (`553196567647`), recebida às 14:00.
- **Resultado:** conversa e mensagem persistidas corretamente no workspace **Digitall Force**
  (`account_id eefd83ef-b6b2-49a4-af4d-71fd21a95dcb`):
  - **Conversation ID:** `1f8faf75-0eaa-41c6-9986-750caf49e309`
  - **Message ID:** `9c81e8cb-0a4a-45fb-8190-60b88b691f8c`
  - **Connection ID:** `a3f7e05a-59f4-4727-b1b1-9843cfed4181`
  - Confirmado via Supabase Table Editor pelo operador.
- Status HTTP da requisição do webhook não foi verificado diretamente (nem ngrok nem log de
  servidor foram inspecionados) — a evidência de sucesso é a persistência real confirmada acima,
  que só ocorre após autenticação bem-sucedida no `route.ts` (ver seção 3.4 do runbook original
  sobre o mecanismo de auth).

### 3.2 Cenário 2 — Inbox Operacional

- A conversa apareceu no Inbox do workspace Digitall Force, com a mensagem inbound ("Oi", 14:00)
  em ordem cronológica correta.
- O operador respondeu pela UI do Inbox: "Boa tarde, como vai? Teste deu certo?" (14:01).
- **Confirmado pelo operador:** a resposta chegou no telefone de teste.

### 3.3 Cenário 3 — Badge Temporal Sprint C

- Na conversa recém-criada (Weyner Cardoso), o badge exibiu corretamente **"24h remaining"**.
- Em uma conversa pré-existente sem mensagens do cliente há 19 dias (Josiany Linda), o sistema
  exibiu corretamente:
  - Badge "No customer messages" / banner "24-hour session expired. Use a template to re-engage."
  - Campo de texto livre bloqueado (placeholder "Session expired - use a template", botão de
    envio desabilitado).
  - Atalho para "Templates" disponível.
- **Ressalva:** essa conversa já estava expirada por nunca ter tido mensagem do cliente, então
  validamos o **estado final correto** (bloqueio + banner), mas não observamos ao vivo, dentro da
  mesma sessão de UI aberta, a transição de "Xh remaining" para "Expired" sem reload — isso
  exigiria acompanhar uma conversa cruzando a fronteira real das 24h, o que não foi forçado por
  não envolver manipulação de timestamp em dados de produção. Considerado **validado com ressalva**.

### 3.4 Cenário 4 — Cleanup Timer / DevTools

- DevTools aberto (Console), navegação entre múltiplas conversas (Academia Lendária, Maria
  Almeida, Barreto, Weyner Cardoso, Josiany Linda).
- **Nenhum erro ou warning React** relacionado a "unmounted component" ou "state update" foi
  observado.
- Achados **não relacionados** ao escopo do Sprint C, registrados apenas para referência (fora de
  escopo para correção neste Gate):
  - Violações de CSP (`style-src`, report-only) ao carregar fontes do Google Fonts.
  - Violações de CSP (`media-src`, report-only) ao carregar áudio de `f004.backblazeb2.com`.
  - Ambas report-only (não bloqueiam a aplicação); indicam que a política de CSP não inclui esses
    domínios — possível item de tech debt separado.

### 3.5 Near-miss — Atribuição incorreta de workspace (corrigido antes de qualquer persistência)

Durante a preparação do Cenário 1, o operador foi inicialmente instruído (por rótulo herdado de
`CHECKPOINT-FORCECRM-SECRET-ROTATION.md`) a logar no workspace **Atomo Soluções**. Antes de
qualquer configuração ser salva, o painel administrativo "Supervised tenants" do ForceCRM revelou
que apenas o tenant **Digitall Force** estava "Conectado" — os 3 tenants piloto (Atomo Soluções,
Oral Unic Contagem, Oral Unic Almirante Tamandaré) estavam "Não configurado".

Cruzamento com `CHECKPOINT-FORCECRM-OPERATIONAL-GATE-RESULT.md` confirmou: o `account_id
eefd83ef-b6b2-49a4-af4d-71fd21a95dcb` rotacionado sempre pertenceu ao workspace **Digitall
Force**, não Atomo Soluções (cujo `account_id` real, `1e3aa534-b56d-4037-b0d7-aa0e27919466`, está
listado na seção "SEEDED ACCOUNTS" daquele documento). O rótulo errado se originou de uma sessão
anterior que não cruzou o `account_id` contra a lista de contas seedadas antes de nomeá-lo.

**Nenhuma configuração ou persistência incorreta chegou a ocorrer** — o erro foi detectado e
corrigido antes de qualquer ação no workspace errado. `CHECKPOINT-FORCECRM-SECRET-ROTATION.md`
foi corrigido (seção 7) com o rótulo certo e o registro deste near-miss.

### 3.6 Outros achados registrados durante a execução (não bloqueantes)

- **Bug de UI confirmado:** `src/components/settings/whatsapp-config.tsx` (linhas ~119–124) monta
  a URL de webhook para providers não-Meta usando o campo legado `verifyToken` (2 segmentos),
  incompatível com o contrato real de 3 segmentos (`{provider}/{connectionId}/{webhookSecret}`)
  exigido por `route.ts`. Gera URLs que resultam em 401. Não corrigido neste Gate (proibido alterar
  código); registrado como tech debt.
- **Credenciais Z-API expostas em prints durante a sessão:** Security Token (Client-Token) e
  Token/API Key da instância "Digitall Force Labs" apareceram em texto puro em capturas de tela
  compartilhadas nesta conversa. Não são o webhook secret (não autenticam o endpoint interno), mas
  são credenciais reais de conta Z-API — recomenda-se ao operador avaliar rotação/regeneração
  desses tokens no painel Z-API por precaução.
- **"Failed to save configuration"** ocorreu ao tentar salvar a tela de configuração WhatsApp
  enquanto logado como Digitall Force antes da correção de rota — não investigado a fundo (fora de
  escopo), mas o formulário confirmou não ter persistido nada (tela voltou a "Não conectado" no
  reload), então não há risco de dado inconsistente.
- **Bug de correção real, encontrado pelo operador durante o teste (fora do escopo Sprint C):**
  mensagens recebidas em grupos do WhatsApp em que a instância "Digitall Force Labs" participa
  foram processadas como se fossem conversas 1:1 — o sistema criou "contatos" isolados (ex.:
  "Carlos") usando o JID do grupo (`120363024204839543`) como se fosse o número de telefone da
  pessoa, com `senderName` do autor da mensagem dentro do grupo. Causa raiz: `parseInboundMessage`
  em `src/lib/whatsapp/providers/zapi.ts` (linha ~227) lê `msg.phone` diretamente e não checa
  `isGroup`/JID de grupo antes de processar. Ocorreu com pelo menos 2 grupos diferentes.
  **Mitigação aplicada pelo operador, sem alteração de código:** toggle "Ignorar mensagens de
  grupos" habilitado no painel Z-API — mensagens de grupo deixam de chegar ao webhook. **Correção
  de código real (detectar grupo e tratar corretamente) registrada como tech debt, não corrigida
  neste Gate** (fora de escopo, código não pode ser alterado).

---

## 4. Critérios Aprovados

1. Inbound Real via Webhook — recepção, resolução de workspace correta (Digitall Force),
   persistência de `conversation` e `message` confirmada via IDs reais.
2. Inbox Operacional — visualização, resposta do operador, entrega confirmada ao destinatário de teste.
3. Cleanup Timer — ausência de erros React / timers órfãos / state update pós-unmount.
4. Isolamento de tenant — nenhuma persistência cruzada entre workspaces ocorreu (o near-miss foi
   pego antes de qualquer escrita).

---

## 5. Critérios Pendentes / Parciais

1. Badge Temporal Sprint C — validado o estado final (bloqueio + banner de expiração), mas a
   transição ao vivo "Xh remaining → Expired" sem reload não foi observada nesta sessão (exigiria
   acompanhar uma conversa real cruzando as 24h). Recomenda-se reconfirmar oportunisticamente
   quando uma conversa ativa cruzar essa fronteira.
2. Confirmação de `audit_log` para o evento de recebimento do Cenário 1 não foi verificada
   explicitamente (só `conversations`/`messages`).
3. Confirmação de que a URL antiga do webhook retorna 401 (item do runbook original do rotation
   script) não foi testada nesta sessão.

---

## 6. Decisão Final

**APROVADO COM RESSALVAS**

Os 4 cenários obrigatórios foram executados com evidência real, incluindo persistência
confirmada no tenant correto. As ressalvas (seção 5) são de baixo risco — nenhuma envolve
comportamento inseguro ou cruzamento de dados entre workspaces — e podem ser fechadas
oportunisticamente sem bloquear a liberação operacional do Gate.

O near-miss de atribuição de workspace (seção 3.5) foi detectado e corrigido antes de causar
qualquer persistência incorreta, validando que o processo de dupla verificação (não aceitar
rótulos herdados sem cruzar contra a fonte de verdade) funcionou como pretendido.
