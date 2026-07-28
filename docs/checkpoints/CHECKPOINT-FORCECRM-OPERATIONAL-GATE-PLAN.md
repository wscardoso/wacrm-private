# Plano de Execução — CHECKPOINT-FORCECRM-OPERATIONAL-GATE

## 1. Cenário Piloto Escolhido

Para validar os fluxos operacionais de atendimento, multi-tenancy e integração, utilizaremos os workspaces previamente cadastrados no banco de dados via script de bootstrap:

- **Workspace Principal (Piloto):** `Atomo Soluções`
  - **CNPJ:** `49.556.450/0001-54`
  - **Owner:** Paulo Barboza (`atendimento@atomosolucoes.com`)
- **Workspace Secundário (Isolamento):** `Oral Unic Contagem`
  - **CNPJ:** `42.689.093/0001-53`
  - **Owner:** Izabela Caroline Resende (`administracao@oraluniccontagem.com.br`)
- **Operador Responsável:** Weyner / Operador da Plataforma (`w.cardoso@digitallforce.com.br`)

---

## 2. Critérios a Serem Validados

O plano cobrirá os seguintes cenários estruturados pelo Gate Operacional:

### Grupo A — Validados por teste automatizado/local (Preservando distinção entre evidência parcial e aprovação final)
1. **Isolamento de Dados no Inbox (RLS + Filtros):** Garantir que consultas ao inbox pelo operador no Workspace A tragam estritamente dados de A, mesmo que o operador pertença a múltiplos tenants.
2. **Autenticidade do Webhook (C7):** Garantir que requisições ao webhook sem assinatura ou com assinatura inválida (HMAC SHA256 / segredo incorreto) retornem `401`/`403` e não persistam mensagens.
3. **Idempotência (C4) e Auditoria:** Garantir que o processamento do webhook desduplique mensagens repetidas (`wamid` duplicado) e gere registros em `audit_log` para operações críticas.
4. **Regressão de Regras da Janela de Sessão (Sprint C):** Garantir que o cálculo de expiração temporal respeite a borda de 24h a partir da última mensagem de cliente.

### Grupo B — Validados em Ambiente Real (Pendente de Validação Operacional)
1. **Inbound Real via Webhook:** Recebimento e processamento de um evento real enviado pela API externa de WhatsApp (Z-API / Meta) para o endpoint do workspace piloto (`Atomo Soluções`).
2. **Interface do Operador (Thread + Envio):** Exibição da conversa, histórico cronológico consistente e envio de resposta pelo operador via Inbox.
3. **Badge Temporal Reativo (Sprint C):** Transição visual do badge para "Expired" e bloqueio de envio de texto livre na UI do operador em tempo real quando ultrapassadas as 24h, sem reload.
4. **Cleanup do Timer:** Ausência de loops de processamento ou memory leaks (sem warnings no console) quando o operador troca de aba ou conversa.

---

## 3. Evidências Esperadas

- **Para Grupo A (Validados por teste automatizado/local):**
  - Logs de execução de testes automatizados unitários/integração com foco em multi-tenancy e criptografia.
  - Verificação de logs HTTP/Respostas de chamadas manuais (Mock Webhook requests).
- **Para Grupo B (Validados em Ambiente Real / Webhook Real):**
  - Timestamp do evento real.
  - Payload sanitizado recebido.
  - `workspace_id` resolvido.
  - Resultado HTTP da integração (status de retorno do webhook).
  - ID da mensagem real no banco de dados (`messages.id` e `messages.status`).
  - IDs das conversations correspondentes no banco de dados associados ao workspace `Atomo Soluções`.
  - Capturas de tela (ou logs do console) da mudança de estado do badge e cleanup dos timers de intervalo.
  - Registro de log na tabela `audit_log` associado ao evento.

---

## 4. Riscos de Execução

- **Risco 1: Interação com Clientes Reais (Interrupção Imediata).**
  - *Mitigação:* As mensagens de teste devem ser enviadas exclusivamente a partir de números de controle (celulares de teste do desenvolvedor/QA) cadastrados. Se qualquer fluxo interagir ou expuser dados de clientes finais reais, a execução será paralisada imediatamente.
- **Risco 2: Limitações do Sandbox (Ausência de Túnel Webhook).**
  - *Mitigação:* Como o agente AI opera localmente, chamadas externas de webhook que dependam de túnel público (ex. ngrok) para integração em tempo real com servidores do WhatsApp serão classificadas como "Pendentes de Validação Operacional", fornecendo o roteiro exato para o operador Weyner executar no ambiente live.
- **Risco 3: Concorrência Mínima (Objetivo: Consistência Operacional, Não Capacidade de Escala).**
  - *Mitigação:* Simulação de duas requisições de webhook de números de teste distintos disparadas simultaneamente para atestar que o banco de dados e os handlers não causam race-conditions, duplicações ou travamentos estruturais sob concorrência, sem a pretensão de medir throughput ou estresse de carga.
