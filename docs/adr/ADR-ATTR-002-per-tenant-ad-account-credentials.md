# ADR-ATTR-002 — Per-Tenant Meta Marketing API Credentials

| | |
|---|---|
| **Tipo** | Architecture Decision Record — **fronteira de segredos**; decide estrutura e autorização, não runtime nem implementação |
| **Épico** | Pré-requisito de **E6.0** (enriquecimento + relatório) e de **P3/CAPI** — não é E6.0 |
| **Deriva de / reusa** | `ADR-ATTR-001 §0.4` (retrofit — este ADR foi nomeado ali como obrigatório) · `whatsapp_config` (001/032 — precedente de segredo por tenant cifrado app-side) · `encryption.ts` (AES-256-GCM, chave global) · `ADR-SYS-001` + `042`/`E5b` (padrão de RPC platform SECURITY DEFINER, gate tenant-scoped `access_role='admin'`, `platform_audit_log`) · `037`/`038` (`is_platform_operator_for`, `platform_audit_log`) |
| **Status** | Proposto · pronto para Gate |
| **Autoridade** | Decide **apenas** a fronteira de armazenamento, autorização, rotação, auditoria e isolamento das credenciais de conta de anúncios por tenant. **Não** decide o job de enriquecimento (E6.0), **não** decide CAPI (P3), **não** constrói E7, **não** reabre nenhum contrato fechado (E4b, E5, ADR-ATTR-001-captura, ODI-001, DLB-001, EIS-001, ADR-SYS-001). |
| **Baseline de código** | HEAD `485b1e6` |

---

## 1. Contexto

O enriquecimento de atribuição (ADR-ATTR-001 D4 / E6.0) e a retroalimentação CAPI (P3) exigem invocar a **Graph API (Marketing) da conta de anúncios de cada cliente**. Isso requer **credenciais Meta por tenant** — tokens de conta de anúncios (system-user / long-lived), de **alto valor e longa vida**, que leem toda a conta de anúncios e, com CAPI, **escrevem conversões** (afetam otimização/gasto).

**Estado real em `485b1e6`:**

- **Criptografia:** uma única `ENCRYPTION_KEY` global (64-hex, AES-256-GCM) em `src/lib/whatsapp/encryption.ts`, aplicada **na camada de aplicação** (Node crypto), com fallback de leitura legado `aes-256-cbc`. **Não há `key_version`, não há re-encrypt — E7 (Encryption Key Versioning) não existe.**
- **Precedente de segredo por tenant:** `whatsapp_config.access_token`/`verify_token`/`waba_id` são **ciphertext TEXT** por tenant, cifrados/decifrados server-side, com RLS. É o molde que este ADR segue para *criptografia*, mas de que diverge para *autorização* e *raio de dano*.
- **Padrão platform-side já congelado (E5b/ADR-SYS-001):** RPC `SECURITY DEFINER` com gate tenant-scoped `platform_operator_accounts.access_role='admin'`, `42501` para não autorizado, auditoria em `platform_audit_log` na mesma transação.

Nenhuma credencial de conta de anúncios existe hoje. Este ADR decide **onde e como** ela viverá, **antes** de qualquer job consumi-la.

---

## 2. Problema

**Qual é a fronteira correta de armazenamento, autorização, rotação, auditoria e isolamento para um segredo de conta de anúncios por tenant — de raio de dano superior ao dos segredos atuais — de modo que E6.0 possa consumi-lo com segurança sem que a decisão seja tomada dentro do job?**

Quatro sub-problemas que o precedente `whatsapp_config` **não** resolve:

- **P-1 — Ator provisionador diferente.** A credencial de ad account é operada por **Weyner (agência / gestor de tráfego)**, não pelo admin do tenant. O provisionamento é **platform-side**, não member-side.
- **P-2 — Raio de dano superior.** Token de ad account > token de envio WhatsApp: leitura da conta inteira, escrita de conversões (P3). Compromisso é mais severo → régua mais alta de criptografia/rotação/auditoria/isolamento.
- **P-3 — Rotação/expiração.** Tokens Meta expiram e precisam refresh/revogação — semântica que os segredos atuais (`whatsapp_config`) não têm.
- **P-4 — Interseção com E7 não resolvida.** Um segredo novo, de longa vida, sob a **chave global sem versionamento**, herda o débito de rotação de chave de E7 — que não existe.

---

## 3. Restrições

1. **Não reabrir contratos fechados** (E4b, E5, ADR-ATTR-001-captura, ADR-SYS-001, ODI-001, DLB-001, EIS-001).
2. **Nenhuma migration, RPC concreta, nome de coluna ou código** — este ADR decide a fronteira; a execução é trabalho posterior (E6.0 / commit próprio).
3. **Não construir E7** — apenas ser compatível com ele e registrar o débito.
4. **Não decidir a mecânica da integração externa** (refresh OAuth, rate-limit, backoff da Graph API) — isso é contrato de E6.0; aqui só o **estado** da credencial (ativa/expirada/revogada) e o caminho de reprovisionamento.
5. **O plaintext do segredo nunca reside no banco** — decidido em §5 D-7.

---

## 4. Alternativas avaliadas

### 4.1 Local do segredo

- **A. Coluna(s) em `accounts`.** ❌ Rejeitada. `accounts` é identidade de workspace (E5); mistura um segredo de alto valor na linha de identidade e o coloca atrás dos caminhos de escrita de E5 (member admin + platform operator) não projetados para segredos. Má separação; amplia superfície.
- **B. Coluna(s) em `whatsapp_config`.** ❌ Rejeitada. Ad account é **outro sistema externo**; um tenant pode ter conta de anúncios sem `whatsapp_config` específico (ou vários). Sobrecarregar acopla dois integrations distintos e herda a autorização member-side (admin do tenant), errada para P-1.
- **C. Tabela nova dedicada por tenant.** ✅ **Escolhida.** Separação limpa: RLS própria, auditoria própria, colunas de rotação/estado próprias, e autorização platform-side própria. Segue o precedente de **criptografia** de `whatsapp_config` sem herdar sua autorização.

### 4.2 Criptografia

- **D. pgcrypto / cifragem no banco.** ❌ Rejeitada. Divergiria do padrão vigente (app-layer) e colocaria plaintext no plano do banco (contra D-7).
- **E. Novo esquema/chave dedicada só para ad accounts.** ❌ Rejeitada por ora. Introduz um segundo sistema de chaves sem E7; complexidade sem ganho até key-versioning existir.
- **F. Reuso de `encrypt()` (AES-256-GCM, chave global), envelope E7-aware.** ✅ **Escolhida.** Consistência com o resto do app; débito de rotação de chave é o mesmo de todos os segredos (documentado), e o envelope de ciphertext é desenhado para E7 re-encriptar depois.

### 4.3 Autorização de escrita

- **G. Member admin (padrão `whatsapp_config`).** ❌ Rejeitada como via primária (P-1: a agência é a dona operacional).
- **H. Admin global de plataforma (padrão 042).** ❌ Rejeitada — largo demais; qualquer superadmin escreveria segredo de qualquer tenant.
- **I. Operador de plataforma admin-para-o-tenant (padrão E5b).** ✅ **Escolhida.** Tenant-scoped + action-gated (`access_role='admin'` naquele tenant), `42501`, auditoria — exatamente o padrão já congelado em E5b, que resolveu esta mesma classe de decisão.

---

## 5. Decisão

Oito decisões (D-1…D-8), todas de **fronteira/estrutura**, nenhuma de runtime.

- **D-1 — Local: tabela nova e dedicada por tenant.** Não `accounts`, não `whatsapp_config` (§4.1-C).
- **D-2 — Criptografia por reuso.** Ciphertext AES-256-GCM via `encrypt()` (`encryption.ts`); nunca plaintext em repouso; nunca legível por cliente. Envelope compatível com futuro `key_version` (E7-aware, §6).
- **D-3 — Autorização de escrita platform-side.** Provisionar/rotacionar/revogar exige **operador de plataforma com `access_role='admin'` no tenant-alvo** (padrão E5b), via RPC `SECURITY DEFINER` com `42501` para qualquer não-autorizado (não-operador, operador de outro tenant, `viewer`/`agent`). **Default v1:** o admin do tenant **não** provisiona a própria credencial (a agência é dona operacional) — revisável em decisão de produto futura, registrada como aberta.
- **D-4 — Rotação e revogação (de token, não de chave).** A credencial carrega **estado** (ativa / expirada / revogada) e caminho de **reprovisionamento**. Revogar = marcar revogada e apagar o ciphertext. **Rotação da chave de criptografia** (re-encrypt sob nova `ENCRYPTION_KEY`) é **de E7**, explicitamente **deferida** (§6).
- **D-5 — Isolamento multi-tenant.** RLS por `account_id` (padrão `whatsapp_config`/`lead_attributions`) **mais** o invariante de consumo D-8. A credencial só é utilizável no contexto do tenant que a possui.
- **D-6 — Auditoria obrigatória.** Toda mutação grava `platform_audit_log` (037) com novas `action`s (ex.: `ad_credential_set` / `ad_credential_rotated` / `ad_credential_revoked`), na **mesma transação**, registrando **ator + tenant + ação — nunca o valor do segredo**.
- **D-7 — Fronteira DB↔app: o banco nunca vê plaintext.** A **rota Next** (que detém a `ENCRYPTION_KEY`) cifra o token; a RPC `SECURITY DEFINER` apenas **armazena ciphertext + autoriza + audita**, e **nunca decifra nem retorna** o segredo. A decifragem é exclusivamente app-tier/background. Isso bounde o risco de SECURITY DEFINER (§8).
- **D-8 — Invariante de consumo (contratual).** Qualquer caminho que decifre/use a credencial **só** o faz para o tenant cujo `account_id` casa com o das linhas de atribuição que processa. `attribution ∧ credential` sempre unidas pelo mesmo `account_id`; corte estrito, verificável por teste cross-tenant. Nenhum uso de credencial de um tenant no contexto de outro.

---

## 6. Relação com E7 (Encryption Key Versioning)

E7 **não existe** em `485b1e6` (sem `key_version`, sem re-encrypt). Decisão normativa:

- ATTR-002 **não depende de E7** — bloquear atribuição na construção de key-versioning seria desproporcional.
- ATTR-002 **não ignora E7** — não finge que rotação de chave existe.
- **Ship no modelo de chave global atual, E7-aware:** o envelope de ciphertext é desenhado para que E7, quando existir, **re-encripte** a credencial junto com os demais segredos, sem migração de dados especial. O **débito de rotação de chave** é **registrado** como herdado e compartilhado com `whatsapp_config` (que já vive com ele) — não é dívida nova criada por ATTR-002, é a mesma dívida estendida a mais um segredo.
- Quando E7 chegar, a credencial de ad account é um dos consumidores de `key_version` — sem reabrir este ADR.

---

## 7. Isolamento multi-tenant — detalhe

Duas camadas, ambas obrigatórias:

1. **Repouso:** RLS por `account_id`; nenhuma policy de escrita para cliente — escrita só via a RPC `SECURITY DEFINER` (D-3/D-7).
2. **Consumo (D-8):** o job de E6.0 roda como **service_role** (fura RLS por natureza). A isolação, portanto, **não** vem só da RLS — vem do **invariante de join**: o job só decifra a credencial do `account_id` que está processando. Um defeito de join usaria o token de A para enriquecer leads de B (vaza dados de anúncio de A / age contra a conta errada). Este invariante é **contratual** e deve ser coberto por teste cross-tenant em E6.0.

---

## 8. Riscos de SECURITY DEFINER e mitigações

| Risco | Mitigação (decidida) |
|---|---|
| RPC definer sem re-checar autorização → qualquer autenticado escreve segredo de qualquer tenant (classe do bug `viewer` do E5) | D-3: gate tenant-scoped `access_role='admin'`, `42501`, padrão E5b já congelado |
| `search_path` não pinado → hijack de função | `SET search_path = public` (padrão 042/050) — requisito |
| Definer decifra/retorna o segredo | D-7: a RPC **não** decifra e **não** retorna o segredo; só armazena ciphertext |
| Segredo vaza na auditoria | D-6: `platform_audit_log` registra ação/ator/tenant, **nunca** o valor |
| Plaintext no plano do banco (logs, dumps) | D-7: plaintext só na camada de app; banco só ciphertext |

---

## 9. Consequências arquiteturais

- Nasce uma **entidade de segredo dedicada**, isolada de identidade (E5) e de conexão WhatsApp — superfície de ataque menor e auditável.
- A **assimetria de autorização** fica explícita e correta: `whatsapp_config` = tenant-admin; ad-account credential = platform-operator-admin. Cada segredo com o dono operacional certo.
- O **débito de E7** é tornado visível e compartilhado, não escondido dentro de um job.
- **E6.0 fica desbloqueado** por ATTR-002 (a fronteira de credencial), não por ADR-ATTR-001 sozinho.
- Custo de construção baixo (reusa criptografia + padrão E5b + `platform_audit_log`); custo de decidir errado alto (segredo de maior raio de dano do sistema).

## 10. Impacto sobre os contratos existentes

| Contrato | Impacto | Reabre? |
|---|---|---|
| `whatsapp_config` / `encryption.ts` | Reuso do padrão de criptografia; nenhuma alteração | **Não** |
| `ADR-SYS-001` / E5b / 042 | Reuso do padrão de RPC platform SECURITY DEFINER + gate tenant-scoped-admin | **Não** |
| `platform_audit_log` (037) | Novas `action`s, sem tabela/coluna nova | **Não** |
| `ADR-ATTR-001` | Cumpre §0.4 (credenciais = ADR próprio); captura CTWA intocada | **Não** |
| E7 | Declarada relação (E7-aware, débito registrado); E7 não é construído aqui | **Não** |
| messaging / E4a / E4b | Zero contato | **Não** |

## 11. Impacto futuro

- **E6.0 (enriquecimento):** consome a credencial (decrypt app-side, chama Graph API, preenche colunas de enriquecimento); mecânica externa (auth/rate-limit/backoff) é contrato de E6.0, podendo reusar a disciplina de retry/DLQ de E4b; honra D-8.
- **P3 (CAPI):** consome a mesma credencial para escrever conversões; depende ainda de sinal de venda (cross-domain) — contrato próprio futuro.
- **E7:** re-encripta a credencial junto com os demais segredos quando existir.

## 12. Critérios de aceite (do ADR e da implementação futura que o consome)

1. Credencial vive em tabela dedicada por tenant; nunca em `accounts`/`whatsapp_config`; ciphertext AES-256-GCM (reuso); nunca plaintext em repouso nem legível por cliente.
2. Escrita/rotação/revogação só por operador de plataforma **admin-para-o-tenant**; `viewer`/`agent`/estranho/operador de outro tenant → `42501` idêntico; `search_path` pinado; a RPC **não decifra nem retorna** o segredo.
3. Estado de credencial (ativa/expirada/revogada) e caminho de reprovisionamento definidos; rotação de **chave** deferida a E7 com débito registrado e ciphertext E7-compatível.
4. Toda mutação audita em `platform_audit_log` (ator/tenant/ação, **sem** valor), mesma transação.
5. Isolamento provável por teste: RLS por `account_id` **e** invariante D-8 (nenhum caminho decifra credencial de um tenant no contexto de outro).
6. Sem impacto em messaging/E4b/E5/ADR-ATTR-001-captura.

## 13. Conformidade

- **Nenhum contrato fechado reaberto.** Reuso de padrões congelados (criptografia `whatsapp_config`; RPC platform E5b/ADR-SYS-001; auditoria 037).
- **Nenhum runtime, migration, RPC concreta, nome de coluna ou código** decidido — estrutura e fronteira apenas.
- **Não abre E6.0 nem CAPI** — apenas os desbloqueia/precede.
- **E7-aware, não E7-dependente** (§6).

---

*Fim do ADR. Fronteira de segredos apenas — nenhum código, migration, RPC concreta, nome de coluna ou implementação foi produzido. Pré-requisito de E6.0; consumido por E6.0 (enriquecimento) e P3 (CAPI).*
