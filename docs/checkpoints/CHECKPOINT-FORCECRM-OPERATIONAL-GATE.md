# CHECKPOINT-FORCECRM-OPERATIONAL-GATE

## Gate Operacional — Transição Construção → Operação

**Projeto:** ForceCRM / WACRM
**Tipo:** Checkpoint Arquitetural
**Status:** Draft para validação
**Base:** `ad33df9`
**Último marco fechado:** Sprint C — Session Window Accuracy

---

# 1. Objetivo do Gate Operacional

Este documento define os critérios de validação para transição do ForceCRM/WACRM da fase de construção da plataforma para a fase de operação real.

O objetivo deste gate não é validar novas funcionalidades, expansão de arquitetura ou evolução de produto.

O objetivo é comprovar que os componentes já implementados conseguem sustentar uma operação real com clientes, operadores e integrações externas.

O Gate Operacional representa a mudança de estado:

```
Construção da plataforma
 ↓
 Validação operacional
 ↓
 Uso com clientes reais
```

A aprovação deste gate significa que a plataforma demonstrou comportamento operacional verificável.

---

# 2. Princípio de Validação

## Código existente não equivale a capacidade operacional

A aprovação do Gate Operacional deve ser baseada em evidências observáveis.

Resumo verbal, descrição de implementação ou intenção arquitetural não constituem evidência suficiente.

Cada critério deve possuir:

- comportamento esperado;
- evidência necessária;
- responsável pela validação;
- condição objetiva de aprovação.

---

# 3. Estado Arquitetural Atual

## Marcos concluídos

### E7 — Crypto Lifecycle

Status:

✅ Fechado

Evidências:

- ADR criptográfico aprovado;
- implementação versionada;
- checkpoint canônico criado.

---

### E9 — Platform Operations

Status:

✅ Fechado

Evidências:

- Platform Administration disponível;
- gerenciamento operacional de workspaces;
- auditoria de operações.

---

### Sprint C — Session Window Accuracy

Status:

✅ Fechado

Commit:

```
9be8ff1
```

Checkpoint:

```
ad33df9
```

Decisão registrada:

Sprint C não alterou regra de negócio.

A implementação corrigiu exclusivamente a representação visual do estado temporal da janela Meta 24h.

Mantidos:

- regra Meta 24h (`>= 24`);
- fluxo de templates;
- MessageComposer;
- schema existente;
- contratos existentes.

---

# 4. Critérios do Gate Operacional

---

# 4.1 Workspace Lifecycle

## Objetivo

Comprovar que um workspace pode existir, ser administrado e operar dentro do modelo multi-tenant.

## Critérios

### Criação

Validar:

- workspace criado corretamente;
- owner associado corretamente;
- dados mínimos preenchidos.

Evidência esperada:

- registro persistido no banco com account_id correto;
- identificação correta do tenant.

Responsável:

Operação/QA.

Condição de aprovação:

Workspace criado e verificado em banco e interface.

---

### Administração

Validar:

- workspace aparece na Platform Administration (`/act`);
- informações apresentadas correspondem ao tenant correto;
- permissões administrativas funcionam.

Evidência esperada:

- comportamento observado na aplicação;
- registro operacional ou captura de tela.

Responsável:

Operação/QA.

Condição de aprovação:

Workspace visível e administrável via interface.

---

### Isolamento

Validar:

- workspace A não visualiza dados do workspace B;
- consultas respeitam contexto do tenant.

Evidência esperada:

- teste operacional com dois workspaces distintos;
- dados de A ausentes na interface de B.

Responsável:

Operação/QA.

Condição de aprovação:

Nenhum dado de A acessível a partir de B.

---

### Desativação (se aplicável)

Caso exista fluxo de desativação de workspace, validar:

- isolamento após desativação;
- impedimento de novos eventos indevidos;
- preservação da integridade dos demais tenants.

Caso não exista operação de desativação implementada, registrar como:

"Fora do escopo operacional atual."

---

# 4.2 WhatsApp Integration

## Objetivo

Validar o fluxo completo de comunicação inbound.

Fluxo esperado:

```
WhatsApp
 ↓
 Webhook
 ↓
 Processamento
 ↓
 Conversation
 ↓
 Thread
 ↓
 Operador
```

## Critérios

Validar:

- mensagem inbound recebida;
- evento processado;
- mensagem persistida;
- conversation criada;
- thread associada;
- tenant correto;
- auditoria registrada.

Evidência esperada:

- mensagem real recebida do canal WhatsApp;
- registros correspondentes no sistema (messages, conversations, audit_log);
- logs/eventos relacionados disponíveis para consulta.

Responsável:

Operação/QA.

Condição de aprovação:

Fluxo inbound completo executado sem erro, com registros verificáveis em banco e interface.

---

## Autenticidade de entrada

Validar:

- requisições autenticadas são aceitas e processadas;
- requisições inválidas (assinatura ausente/incorreta) são rejeitadas;
- eventos rejeitados não geram persistência.

Evidência esperada:

- teste operacional com requisição inválida;
- resposta HTTP 401/403;
- ausência de registros criados para requisição rejeitada.

Responsável:

Operação/QA.

Condição de aprovação:

Requisição inválida rejeitada sem efeito colateral no banco.

---

# 4.3 Inbox Operational Flow

## Objetivo

Validar o fluxo diário do operador.

Fluxo esperado:

```
Cliente envia mensagem

↓

Operador visualiza

↓

Operador responde

↓

Cliente recebe
```

## Critérios

Validar:

- thread carregada corretamente;
- histórico preservado com ordenação temporal conforme regra definida pelo sistema;
- mensagens não desaparecem;
- mensagens não aparecem associadas a outro tenant;
- mensagens mantêm identificação correta de origem (sender_type, sender_id);
- operador consegue responder;
- mensagem enviada corretamente;
- estado da conversa permanece consistente.

Evidência esperada:

- execução real do atendimento;
- registros de mensagens consultáveis em ordem cronológica.

Responsável:

Operação/QA.

Condição de aprovação:

Fluxo completo de atendimento executado sem erro, com ordenação temporal preservada e sem perda de mensagens.

---

## Concorrência operacional mínima

Validar:

- múltiplas mensagens simultâneas de diferentes clientes são processadas sem perda;
- mais de um atendimento ativo no mesmo workspace simultaneamente;
- ausência de perda ou duplicação indevida de mensagens.

Não é teste de carga. Objetivo: validar comportamento operacional básico sob concorrência mínima (pelo menos 2 fluxos simultâneos).

Evidência esperada:

- 2+ conversas ativas simultaneamente;
- registros completos e sem duplicação.

Responsável:

Operação/QA.

Condição de aprovação:

Múltiplos atendimentos simultâneos sem perda ou duplicação de mensagens.

---

# 4.4 Session Window Validation

## Objetivo

Validar o comportamento operacional da janela Meta 24h após Sprint C.

## Implementado e comprovado

✅ Extração da lógica temporal
✅ Clock reativo
✅ Testes determinísticos
✅ Build, typecheck e lint

---

## Pendente de validação operacional

### Badge temporal

Critério:

Com uma conversa aberta próxima da fronteira de 24h, o indicador visual deve atualizar sem necessidade de nova mensagem ou reload.

Evidência:

- observação em navegador;
- comportamento registrado.

Responsável:

QA / operador responsável pelo ambiente.

---

### Cleanup do clock

Critério:

Ao trocar de conversa, o componente desmontado não deve continuar executando atualizações.

Evidência:

- ausência de warnings no console;
- comportamento normal durante navegação.

Responsável:

QA / operador responsável pelo ambiente.

---

# 4.5 Multi-tenant Safety

## Objetivo

Comprovar isolamento entre clientes.

## Critérios

Validar:

- dados pertencem ao account_id correto;
- permissões respeitam tenant;
- eventos não cruzam contextos;
- auditoria mantém separação.

Evidência esperada:

- testes com múltiplos workspaces ativos simultaneamente;
- registros de auditoria consultáveis por workspace.

Responsável:

Operação/QA.

Condição de aprovação:

Nenhum dado ou evento de um workspace acessível a partir de outro.

---

# 4.6 Audit Trail

## Objetivo

Garantir rastreabilidade operacional.

## Critérios

Validar:

- eventos críticos possuem registro;
- actor identificado;
- timestamp presente;
- contexto suficiente para investigação.

Evidência esperada:

- registros de auditoria consultáveis;
- query verificável que retorna eventos esperados.

Responsável:

Operação/QA.

Condição de aprovação:

Eventos operacionais rastreáveis com actor, timestamp e contexto.

---

# 5. Cenário Piloto

Este Gate **não pode ser aprovado** enquanto esta seção estiver incompleta.

## Workspace piloto

Pendente.

---

## Operador responsável

Pendente.

---

## Período de validação

Pendente.

---

## Fluxos executados

Pendente.

---

## Resultado

Pendente.

---

# 6. Critérios de Aprovação

Cada item deve ser verificado com evidência concreta. Nenhum item pode ser aprovado por descrição verbal ou resumo.

---

### 6.1 Operação — Fluxo completo de atendimento

Critério:

Uma conversa real deve ser iniciada por um cliente através do canal WhatsApp configurado, gerando registro persistido de mensagem inbound, Conversation e Thread associadas ao workspace correto. O operador deve visualizar e responder, e a resposta deve ser confirmada como enviada.

Evidência esperada:

- registro da mensagem inbound no banco;
- registro da Conversation;
- evidência visual do atendimento na interface;
- registro da mensagem outbound;
- confirmação de envio (status `sent` ou `delivered`).

Responsável:

Operação/QA.

Condição de aprovação:

Fluxo completo executado sem erro, com registros verificáveis.

---

### 6.2 Segurança — Isolamento entre tenants

Critério:

Dois workspaces distintos devem operar simultaneamente sem que dados de um sejam acessíveis ao outro via interface, consulta ou evento.

Evidência esperada:

- operador logado no workspace A vê apenas dados de A;
- tentativa de acesso a dados de B retorna vazio ou erro.

Responsável:

Operação/QA.

Condição de aprovação:

Nenhum dado de um workspace visível em outro.

---

### 6.3 Integrações — WhatsApp inbound

Critério:

Mensagem enviada de um número externo via WhatsApp deve ser recebida pelo webhook, processada e persistida.

Evidência esperada:

- registro da mensagem no banco;
- registro da conversation;
- thread disponível no inbox do workspace correto.

Responsável:

Operação/QA.

Condição de aprovação:

Mensagem real recebida e persistida.

---

### 6.4 Auditoria — Rastreabilidade operacional

Critério:

Eventos críticos (inbound recebido, outbound enviado, alterações de workspace) devem possuir registro com actor, timestamp e contexto.

Evidência esperada:

- consulta a `audit_log` retorna eventos esperados;
- actor e timestamp estão preenchidos.

Responsável:

Operação/QA.

Condição de aprovação:

Registros de auditoria existem e são consultáveis.

---

# 7. Critérios de Interrupção Imediata

O Gate deve ser **interrompido imediatamente** caso qualquer um dos seguintes eventos seja observado durante a validação:

- vazamento de dados entre tenants (dado do workspace A visível no workspace B);
- mensagem persistida no workspace incorreto;
- falha de isolamento confirmada;
- perda de mensagem (enviada pelo cliente mas não persistida);
- corrupção de histórico (mensagens alteradas, removidas ou reordenadas indevidamente);
- comportamento que comprometa dados reais de cliente.

Procedimento:

1. Interromper a validação operacional imediatamente.
2. Notificar o responsável pelo gate.
3. Registrar o incidente com contexto (timestamp, workspace afetado, evidência).
4. Não prosseguir com a operação até que a causa seja identificada e corrigida.
5. Após correção, reiniciar o ciclo de validação desde o início.

O objetivo desta interrupção é impedir exposição ou corrupção adicional durante validação operacional.

---

# 8. Critérios de Bloqueio

O Gate deve ser considerado reprovado caso ocorra:

- mensagem não recebida;
- mensagem associada ao tenant incorreto;
- operador incapaz de responder;
- inconsistência de histórico;
- ausência de auditoria;
- quebra de isolamento entre clientes;
- comportamento operacional incompatível com o fluxo esperado.

---

# 9. Monitoramento Operacional

Validar a existência de mecanismo verificável para detectar:

- falha de processamento inbound (mensagem recebida pelo webhook mas não persistida);
- ausência de eventos esperados (silêncio prolongado sem causa conhecida);
- erro operacional (falha de envio, timeout, erro de permissão).

Mecanismos aceitos:

- logs estruturados consultáveis;
- alertas configurados;
- healthchecks;
- heartbeat de integração;
- equivalentes existentes.

Não criar implementação — apenas validar que o mecanismo existe e é acessível à operação.

Evidência esperada:

- confirmação de que logs são gerados e retidos;
- operador sabe onde consultar.

Responsável:

Operação/QA.

Condição de aprovação:

Mecanismo de observabilidade existe e é verificável.

---

# 10. Fora de Escopo

Não fazem parte deste Gate:

- novas funcionalidades CRM;
- billing;
- ADR-ATTR-002 / Meta Marketing API;
- automações avançadas;
- melhorias cosméticas;
- expansão de infraestrutura sem necessidade operacional;
- novos ciclos de arquitetura sem evidência operacional.

---

# 11. Próxima Fase Após Aprovação

Após aprovação do Gate Operacional:

- operação com clientes reais;
- coleta de feedback;
- identificação de necessidades reais;
- priorização baseada em evidência operacional.

A evolução posterior deve ser orientada por uso real da plataforma, não por hipótese de implementação.

---

# 12. Registro de Decisão

Este checkpoint estabelece a transição:

```
ForceCRM como plataforma construída

↓

ForceCRM como plataforma operada
```

A partir deste ponto, novas evoluções devem nascer de necessidades observadas em operação, mantendo o princípio:

```
Evidência antes de expansão.
```
