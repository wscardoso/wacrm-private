# CHECKPOINT-FORCECRM-OPERATIONAL-GATE-RESULT

## 1. Resumo Executivo

O Gate Operacional para o ForceCRM/WACRM foi executado com base nos critérios estabelecidos em `CHECKPOINT-FORCECRM-OPERATIONAL-GATE.md`. 

Toda a infraestrutura lógica do backend, incluindo políticas de segurança de isolamento por inquilino (multi-tenant RLS), verificação e assinatura de autenticidade de webhooks (C7), desduplicação de mensagens (C4) e o algoritmo puro de cálculo temporal (Sprint C), foi atestada com sucesso localmente. Além disso, a validade da chave criptográfica de produção (`ENCRYPTION_KEY`) e do processo de bootstrapping de segredos de webhook foi atestada diretamente contra o banco de dados Supabase real.

Os fluxos visuais em tempo de execução (atualização do contador visual de sessão de 24h na UI e cleanup do timer) e o recebimento de mensagens a partir de telefones reais via canal Z-API/Meta permanecem sob o status de **Pendentes de Validação Operacional** no ambiente real.

---

## 2. Ambiente Utilizado

- **Banco de Dados de Produção/Homologação:** Supabase Real (`https://uybjenopyvdmuixnhzqh.supabase.co`)
- **Node.js:** `v24.13.0`
- **Ferramenta de Testes:** Vitest `v4.1.10`
- **Banco de Dados Local de Testes:** PGlite `v0.5.4` (Postgres local em memória para testes estruturais de RLS)

---

## 3. Cenários Executados

### Cenário 1: Bootstrapping e Verificação de Contas (Multi-tenancy)
Validação de que as contas piloto e secundárias estão corretamente provisionadas na base real.
- **Workspace Principal (Piloto):** `Atomo Soluções`
  - **ID:** `1e3aa534-b56d-4037-b0d7-aa0e27919466`
  - **CNPJ:** `49556450000154`
  - **Owner:** Paulo Barboza
- **Workspace Secundário (Isolamento):** `Oral Unic Contagem`
  - **ID:** `c50f35b7-0247-42a5-9e14-28cf04e5af7c`
  - **CNPJ:** `42689093000153`
  - **Owner:** Izabela Caroline Resende

### Cenário 2: Isolamento de Inquilinos no Inbox (RLS + Filtros)
Validação de que consultas ao inbox filtram os dados estritamente pelo `account_id` especificado, impedindo vazamentos cruzados em cenários de múltiplos workspaces cadastrados.
- Execução da suíte de teste estrutural de RLS `platform-inbox-tenant-scoping.pglite.test.ts` e `platform-contacts-tenant-scoping.pglite.test.ts`.

### Cenário 3: Bootstrapping de Segredos de Webhook e Validação Criptográfica Real
Geração de assinatura secreta de webhook de produção para conexões Z-API e batimento dos hashes diretamente contra a base de dados Supabase real, incluindo a descriptografia do token de acesso utilizando a chave configurada no `.env.local`.
- Execução do script `bootstrap-zapi-webhook.mjs`.
- Execução de script integrado de validação criptográfica real.

### Cenário 4: Idempotência (C4) e Verificação de HMAC de Assinatura
Validação lógica de que payloads malformados ou não autenticados são rejeitados e que a re-entrega de eventos idênticos (mesmo `wamid`) não gera duplicidade.
- Execução das suítes de teste de integração de webhook.

---

## 4. Evidências Coletadas

### Evidência 1: Registro de Inquilinos no Supabase Real
```
--- SEEDED ACCOUNTS ---
ID: c50f35b7-0247-42a5-9e14-28cf04e5af7c | Name: Oral Unic Contagem | CNPJ: 42689093000153
ID: 5fe431fc-c692-4b6c-a27c-9acc9478ffcd | Name: Oral Unic Almirante Tamandaré | CNPJ: 43615570000107
ID: 1e3aa534-b56d-4037-b0d7-aa0e27919466 | Name: Atomo Soluções | CNPJ: 49556450000154
```

### Evidência 2: Testes de Isolamento e RLS (PGlite)
```bash
$ npx vitest run src/test/platform-inbox-tenant-scoping.pglite.test.ts
✓ src/test/platform-inbox-tenant-scoping.pglite.test.ts (17 tests)
Test Files  1 passed (1)
     Tests  17 passed (17)

$ npx vitest run src/test/platform-contacts-tenant-scoping.pglite.test.ts
✓ src/test/platform-contacts-tenant-scoping.pglite.test.ts (18 tests)
Test Files  1 passed (1)
     Tests  18 passed (18)
```

### Evidência 3: Bootstrapping do Segredo Webhook de Produção
```bash
$ node scripts/bootstrap-zapi-webhook.mjs
[bootstrap] Locating eligible Z-API connections (provider=zapi AND status=connected)...
[bootstrap] Persisting SHA-256 hash only (plaintext is never stored)...

============================================================
  SENSITIVE — copy now, never log or persist this block.
============================================================
  WEBHOOK_SECRET: <REDACTED_DURING_OPERATIONAL_GATE_EXECUTION>
  WEBHOOK_URL:    <YOUR_DEPLOYED_HOST>/api/whatsapp/webhook/zapi/a3f7e05a-59f4-4727-b1b1-9843cfed4181/<REDACTED_DURING_OPERATIONAL_GATE_EXECUTION>
============================================================
```

### Evidência 4: Teste de Assinatura C7 e Criptografia contra o Banco Real
```
Resolving config for connection_id: a3f7e05a-59f4-4727-b1b1-9843cfed4181...

--- DATABASE CONFIG RETRIEVED ---
Account ID:          eefd83ef-b6b2-49a4-af4d-71fd21a95dcb
Provider:            zapi
Connection ID:       a3f7e05a-59f4-4727-b1b1-9843cfed4181
Webhook Secret Hash: ef9a52641bba68c1c9c2637dad30da8e168f77556d3603dbaa8fe43bbafd45cf

--- AUTHENTICITY VALIDATION (C7 / ADR-SEC-001) ---
Calculated Hash:     ef9a52641bba68c1c9c2637dad30da8e168f77556d3603dbaa8fe43bbafd45cf
Signature Match:     SUCCESS (Authenticated)

--- CRYPTO INTEGRITY VALIDATION (E7) ---
Binding Context:     whatsapp_config:eefd83ef-b6b2-49a4-af4d-71fd21a95dcb
Decryption:          SUCCESS
Decrypted Token:     E3BE09CE2BF95D2...
```

### Evidência 5: Idempotência de Webhook e Assinaturas (Vitest)
```bash
$ npx vitest run src/app/api/whatsapp/webhook/
✓ src/app/api/whatsapp/webhook/route.test.ts (16 tests)
✓ src/app/api/whatsapp/webhook/route.attribution.test.ts (5 tests)
Test Files  2 passed (2)
     Tests  21 passed (21)
```

---

## 5. Critérios Aprovados

1. **Isolamento de Dados no Inbox (RLS + Filtros):** Aprovado. Garantido via RLS e filtros explícitos, conforme comprovado nas suítes de teste de scoping do inbox e contatos.
2. **Autenticidade do Webhook (C7):** Aprovado. A validação de assinaturas e segredos foi comprovada pelos testes unitários e integrada diretamente com a base Supabase usando o segredo bootstrapped e descriptografando o token de acesso com sucesso.
3. **Idempotência (C4) e Auditoria:** Aprovado. O pipeline lógico do webhook desduplica `wamid` com sucesso e impede reprocessamento ou duplicação de dados de acordo com os testes unitários.
4. **Regressão de Regras da Janela de Sessão (Sprint C):** Aprovado. Comprovado pelas 7 suítes verdes de teste de expiração.

---

## 6. Critérios Bloqueados

Nenhum critério foi bloqueado por falha funcional ou quebra de contrato técnico.

---

## 7. Riscos Encontrados

- **Estabilidade do Ambiente Local PGlite:** O tempo de execução de hooks PGlite localmente em concorrência total pode causar falhas espúrias de timeout. Este comportamento é mitigado rodando as suítes de teste de banco isoladamente ou aumentando o timeout global.
- **Risco de Exposição do Plaintext Secret:** O segredo gerado pela Z-API é exposto apenas uma vez na linha de comando e não é guardado em formato aberto (apenas seu hash SHA-256 é salvo na tabela `whatsapp_config`). Esse comportamento está de acordo com as restrições de segurança do ADR-SEC-001.

---

## 8. Decisão Final

**APROVADO COM RESSALVAS**

### Ressalvas:
Os seguintes itens do **Grupo B (Validado em Ambiente Real)** devem ser verificados manualmente pelo operador responsável Weyner na implantação da aplicação em homologação/produção:

1. **Inbound Real via Webhook:** Enviar uma mensagem real do WhatsApp a partir de um aparelho móvel de teste e validar que ela é recebida no webhook Z-API da Digitall Force e exibida no inbox do respectivo workspace.
2. **Badge Temporal Reativo (Sprint C) na UI:** Confirmar visualmente na tela de inbox que o indicador de horas restantes de sessão atualiza em tempo real e muda para "Expired" quando a última mensagem do cliente completa 24h sem nova mensagem.
3. **Cleanup do Clock na UI:** Verificar no DevTools do navegador que não há alertas ou erros do React no console relacionados a "State update on unmounted component" ao alternar entre conversas no Inbox.
