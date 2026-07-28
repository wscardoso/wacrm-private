# CHECKPOINT-FORCECRM-GROUP-B-RESULT

## 1. Resumo Executivo

Este documento cobre a validação operacional real do **Grupo B**, conforme escopo definido no
prompt de execução recebido em 2026-07-28, com base em `CHECKPOINT-FORCECRM-SECRET-ROTATION.md`
(secret rotacionado, hash persistido, Grupo A aprovado).

**Nenhum dos 4 cenários obrigatórios foi executado nesta sessão.** Os quatro exigem, por
natureza, ações que um agente de CLI sem acesso a browser, telefone ou painel externo não pode
realizar:

| Cenário | Por que não pôde ser executado aqui |
|---|---|
| 1. Inbound Real via Webhook | Exige acesso ao painel Z-API (credenciais de conta) e envio a partir de um aparelho de WhatsApp real e autorizado. Além disso, o secret em texto puro só existiu uma vez na saída do script de rotação (`scripts/rotate-zapi-webhook.mjs`) e não foi persistido em nenhum lugar — não há como reconstituir uma assinatura HMAC válida sem quem copiou aquele output. |
| 2. Inbox Operacional | Exige a aplicação rodando em ambiente acessível (deploy real), um operador humano na UI e um destinatário de teste real recebendo a resposta enviada pelo sistema. |
| 3. Badge Temporal Sprint C | Exige observação visual ao vivo de uma sessão de UI, incluindo aguardar 24h reais para o estado `Expired`. |
| 4. Cleanup Timer / DevTools | Exige inspecionar o console de DevTools de uma sessão de browser real durante navegação entre conversas. |

Em vez de fabricar evidências (timestamps, IDs de mensagem/conversa, capturas de tela) que não
foram de fato produzidas, este checkpoint registra a **decisão de parada** e entrega, em vez
disso, o **runbook operacional** que o operador humano (Weyner) deve seguir para produzir essas
evidências e permitir o fechamento real do Gate.

---

## 2. Cenários Executados

Nenhum. Ver seção 1.

---

## 3. Evidências

Nenhuma evidência de execução real (webhook inbound, resposta via Inbox, badge de sessão,
DevTools) foi coletada nesta sessão. As únicas evidências existentes seguem sendo as já
registradas em `CHECKPOINT-FORCECRM-SECRET-ROTATION.md` (rotação de secret) e em
`CHECKPOINT-FORCECRM-OPERATIONAL-GATE-RESULT.md` (validação lógica/estrutural via testes
automatizados e Supabase real).

---

## 4. Critérios Aprovados

Nenhum critério do Grupo B foi aprovado nesta execução (nenhum foi de fato testado).

---

## 5. Critérios Pendentes

Todos os 4 cenários do Grupo B permanecem pendentes:

1. Inbound Real via Webhook (recepção, resolução de workspace, persistência de
   `conversation`/`message`/`audit_log`).
2. Inbox Operacional (visualização, resposta do operador, entrega ao destinatário).
3. Badge Temporal Sprint C (contador ao vivo, transição para `Expired`, bloqueio de texto livre).
4. Cleanup Timer (ausência de erros React / timers órfãos / state update pós-unmount).

---

## 6. Decisão Final

**INTERROMPIDO**

Interrompido não por violação de critério de parada de segurança (nenhum dado cruzado entre
workspaces foi observado, porque nenhum teste real foi executado), mas por **impossibilidade de
execução automatizada** dos cenários exigidos. O Gate Grupo B só pode ser fechado após execução
manual pelo operador responsável, usando o runbook abaixo.

---

## 7. Runbook para Execução Manual (Weyner)

> Pré-requisito: aplicação implantada e acessível publicamente (HTTPS), com a `connection_id`
> `a3f7e05a-59f4-4727-b1b1-9843cfed4181` já configurada (Grupo A) e o secret em texto puro salvo
> em local seguro (gerenciador de senhas) a partir da execução do rotation script — se esse
> texto puro não foi guardado, é necessário rodar `scripts/rotate-zapi-webhook.mjs` novamente
> antes de prosseguir, pois o hash sozinho não permite montar a URL do webhook.

### Cenário 1 — Inbound Real via Webhook

1. No painel Z-API, configurar o `WEBHOOK_URL` da instância como:
   `https://<seu-host-deploy>/api/whatsapp/webhook/zapi/a3f7e05a-59f4-4727-b1b1-9843cfed4181/<WEBHOOK_SECRET_PLAINTEXT>`
   (rota real: `src/app/api/whatsapp/webhook/[provider]/[connectionId]/[webhookSecret]/route.ts`).
2. A partir de um número de teste autorizado, enviar uma mensagem de texto para o número
   conectado à instância Z-API.
3. Confirmar no log da aplicação (ou APM) que a requisição `POST` retornou `200` com corpo
   `{ "received": true, "processed": 1 }`.
4. No Supabase, consultar (com `account_id = eefd83ef-b6b2-49a4-af4d-71fd21a95dcb`):
   - `conversations` — nova linha criada, `account_id` correto.
   - `messages` — nova linha `direction = inbound`, vinculada à conversa acima.
   - `audit_log` — evento correspondente ao recebimento.
5. Registrar como evidência: timestamp da requisição, `connection_id`, `workspace_id`
   (`account_id`), `message.id`, `conversation.id`.
6. **Critério de parada:** se qualquer registro acima aparecer vinculado a um `account_id`
   diferente de `eefd83ef-b6b2-49a4-af4d-71fd21a95dcb` (ex.: `Oral Unic Contagem`), interromper
   imediatamente e reportar antes de prosseguir para os demais cenários.

### Cenário 2 — Inbox Operacional

1. Logar na aplicação como usuário do workspace Atomo Soluções e abrir o Inbox.
2. Confirmar que a conversa do Cenário 1 aparece na lista, com a mensagem inbound visível e
   ordem cronológica correta em relação a mensagens anteriores (se houver).
3. Responder pela UI do Inbox.
4. Confirmar no telefone de teste que a resposta chegou.
5. Registrar: horário do envio da resposta pela UI e horário de recebimento no telefone de
   teste (para avaliar latência), além de screenshot da conversa no Inbox.

### Cenário 3 — Badge Temporal Sprint C

1. Observar o badge de contagem de sessão na conversa aberta no Cenário 2 (deve mostrar horas
   restantes decrescendo, sem necessidade de reload).
2. Para validar a transição para `Expired` sem esperar 24h reais, usar uma conversa de teste
   cuja última mensagem do cliente já tenha mais de 24h (ou, se disponível em ambiente de
   homologação, ajustar o timestamp da última mensagem inbound diretamente no banco de teste
   — nunca em produção — para simular a expiração).
3. Confirmar que, após a expiração, o campo de texto livre é bloqueado (placeholder / mensagem
   de estado `Expired`) sem necessidade de reload de página.
4. Registrar prints antes/depois da expiração.

### Cenário 4 — Cleanup Timer (DevTools)

1. Abrir DevTools (aba Console) no navegador durante a navegação do Cenário 2/3.
2. Alternar entre pelo menos 3 conversas diferentes no Inbox, incluindo abrir e fechar a
   conversa de teste várias vezes.
3. Confirmar ausência de:
   - Warnings/erros React (ex.: "Can't perform a React state update on an unmounted component").
   - Timers (`setInterval`/`setTimeout`) que continuam disparando após navegar para outra
     conversa (pode ser inspecionado via `console.log` temporário ou breakpoints, se necessário).
4. Registrar print do console limpo ao final da navegação.

### Fechamento

Após produzir as evidências reais dos 4 cenários, atualizar este documento (ou criar um novo
`CHECKPOINT-FORCECRM-GROUP-B-RESULT-v2.md`) substituindo as seções 2–6 pelas evidências e pela
decisão final real (`APROVADO`, `APROVADO COM RESSALVAS` ou `INTERROMPIDO`), seguindo o mesmo
critério de parada descrito neste documento.
