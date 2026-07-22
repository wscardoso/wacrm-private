# E5 — Workspace Commercial Identity — Feature Contract

| | |
|---|---|
| **Tipo** | Contrato de feature (design document) — **não é ADR**; aplica padrões já congelados |
| **Épico** | E5 — Workspace Commercial Identity |
| **Split** | **E5a** — Account Identity Data · **E5b** — Platform Workspace Identity Management |
| **Deriva de / reusa** | `042_create_platform_workspace_rpc` (padrão de RPC platform SECURITY DEFINER) · `037_platform_admin_foundation` / `038_platform_read_context` (`can_access_account`, `is_platform_operator_for`, `platform_audit_log`) · `041_accounts_owner_nullable_and_cnpj` (coluna e constraint de CNPJ) · `021_account_default_currency` (precedente de coluna aditiva com CHECK) · `017_account_sharing` (RLS `accounts_update = is_account_member(id,'admin')`) |
| **Status** | Aprovado no Gate arquitetural · pronto para implementação (Sonnet) |
| **Autoridade** | Aditivo. **Não** cria ADR, **não** altera messaging, **não** toca `messages.status`, **não** cria nova abstração, **não** reabre nenhuma decisão fechada (E4b, ODI-001, DLB-001, ADR-SYS-001, ADR-MSG-001). Reusa padrões existentes verbatim. |
| **Baseline de código** | HEAD `b3ccb04` |

---

## 1. Objetivo

Dar à conta (`accounts`) **identidade comercial completa e editável após a criação**, por dois escritores legítimos e já existentes no sistema — o **admin do tenant** (self-service, via RLS) e o **operador de plataforma** (supervisão, via RPC `SECURITY DEFINER`) — sem introduzir tabela, abstração, ADR ou caminho de autorização novos.

Hoje (`b3ccb04`) a conta nasce com identidade parcial: `name` e `cnpj` só são setáveis na **criação** (`create_platform_workspace`, 042); não há caminho de UPDATE para CNPJ (não corrigível), nem colunas para razão social, telefone comercial e e-mail comercial. E5 fecha essa lacuna.

---

## 2. Não objetivos

1. **Não** tocar messaging, providers, `messages`, `messages.status`, retry ledger ou qualquer artefato de E4a/E4b.
2. **Não** criar tabela nova, trigger novo, tipo novo, nem abstração nova.
3. **Não** criar um segundo caminho de rename — o rename member-side (`/api/account` PATCH) é **estendido**, não duplicado.
4. **Não** redefinir constraints já existentes (CNPJ de 041, currency de 021) — são **reusadas**.
5. **Não** construir billing, faturamento, emissão fiscal, validação externa de CNPJ (Receita), nem verificação de e-mail/telefone. E5 grava e valida **formato**, não veracidade.
6. **Não** criar trilha de auditoria voltada ao tenant nem nova tabela de auditoria — o caminho platform reusa `platform_audit_log`; o caminho member não é auditado em `platform_audit_log` (que é platform-scoped) — ver §9.
7. **Não** alterar a semântica de `owner_user_id`, membership, roles ou contexto de plataforma.

---

## 3. Escopo E5a — Account Identity Data

A **camada de dados e o caminho de escrita do próprio tenant**. Autossuficiente; não depende de E5b.

Inclui:

1. **Colunas aditivas** em `accounts` para razão social, telefone comercial e e-mail comercial (§6), com validação em **CHECK constraints no banco** (§7) — de modo que **ambos** os escritores (E5a member e E5b platform) herdem a mesma validação e não possam divergir.
2. **Extensão do PATCH member-side** (`/api/account`) — hoje só escreve `name` sob `requireRole('admin')` + RLS `accounts_update = is_account_member(id,'admin')` — para aceitar também os campos de identidade e o CNPJ, com **semântica de partial update** (§7.4).
3. **Caminho de correção de CNPJ pós-criação** pelo admin do tenant (a coluna e a constraint já existem em 041; falta o caminho de escrita — E5a o abre no member-side; E5b no platform-side).

Não inclui: RPC de plataforma, UI de plataforma, auditoria (tudo isso é E5b).

---

## 4. Escopo E5b — Platform Workspace Identity Management

O **caminho de escrita do operador de plataforma** e a superfície de operação. Depende de E5a (as colunas precisam existir primeiro).

Inclui:

1. **RPC `SECURITY DEFINER` de UPDATE de identidade** — irmã de `create_platform_workspace` (042), que só faz INSERT. Permite ao operador de plataforma editar a identidade de um tenant **supervisionado** mesmo **não sendo membro** dele (a RLS `accounts_update` sozinha bloquearia — por isso o `SECURITY DEFINER`). Autorização delegada **exatamente** ao padrão de 042/037/038 (§8).
2. **Auditoria** de toda mutação platform-side em `platform_audit_log`, com uma **nova `action`** (ex.: `update_workspace_identity`), no mesmo mecanismo de `create_workspace` — sem tabela/trigger novos (§9).
3. **Rota de UI de plataforma** `/act/[accountId]/settings` (inexistente hoje) para consumir o RPC. UI é consumidor fino do contrato.

Não inclui: nenhuma nova semântica de autorização (reusa a de 042); nenhuma alteração no caminho member-side de E5a.

---

## 5. Modelo de dados

**Entidade única afetada:** `accounts` (colunas aditivas). **Sem** tabela nova.

Eixo de auditoria: `platform_audit_log` (037), reuso — nova `action`, sem coluna nova.

Princípio normativo do modelo: **a validação vive em CHECK constraints na própria `accounts`**, não na aplicação. Consequência: os dois escritores (member PATCH e platform RPC) são **fachadas de autorização distintas sobre as mesmas colunas com a mesma validação de banco** — impossível divergirem. É o mesmo princípio de fachada que o projeto já aplica em outros pontos (ex.: ADR-SYS-001 para settlement), **sem reabri-lo** e sem generalizá-lo em abstração nova.

`updated_at` de `accounts` (trigger já existente) passa a registrar "quando a identidade mudou pela última vez" — sem novo mecanismo.

---

## 6. Campos envolvidos em `accounts`

| Campo | Situação | Papel |
|---|---|---|
| `name` | Existe (001) | Nome do workspace — editável member (existe) e platform (novo em E5b) |
| `cnpj` | Existe (041), 14 dígitos normalizados, `UNIQUE` parcial | Passa a ser **editável/corrigível** pós-criação (member em E5a, platform em E5b) |
| `default_currency` | Existe (021) | Fora do escopo de escrita de E5 (não é identidade comercial) |
| `owner_user_id` | Existe (041, nullable) | Fora de escopo (não é identidade comercial) |
| **razão social** | **Novo (E5a)** | Nome jurídico da empresa |
| **telefone comercial** | **Novo (E5a)** | Contato comercial |
| **e-mail comercial** | **Novo (E5a)** | Contato comercial |

As três colunas novas nascem **nullable** (identidade é preenchível ao longo do tempo, não obrigatória na criação — coerente com `owner_user_id` nullable de 041). Nomes concretos de coluna são decisão de implementação; o contrato fixa **existência, nulidade e validação**, não o identificador exato.

---

## 7. Regras de validação

Todas expressas como **CHECK constraints no banco** (precedente: `accounts_cnpj_format` 041, `accounts_default_currency_format` 021), para que ambos os escritores herdem.

### 7.1 Razão social
Quando presente (não-null): string não-vazia após `trim`, com limite superior de tamanho (mesmo espírito do `MAX_NAME_LEN` já usado no PATCH de `name`). Valor vazio após `trim` → rejeitar (não gravar string vazia; usar `NULL` para "não informado").

### 7.2 Telefone comercial
Quando presente: **validação de formato básico** — caracteres permitidos (dígitos, `+`, espaços/hífens/parênteses opcionais) e tamanho razoável. **Não** é para virar um parser de telecom nem impor E.164 estrito. Sem verificação de existência do número.

### 7.3 E-mail comercial
Quando presente: **validação de formato básico** — presença de `@` e estrutura mínima (algo antes, `@`, domínio com ponto). **Não** implementar um validador completo de RFC 5322. Sem verificação de entrega.

> **Orientação normativa para a implementação (telefone e e-mail):** a CHECK deve **rejeitar lixo óbvio, nunca dados reais**. O risco a evitar é uma constraint rígida demais que bloqueie um número/e-mail legítimo em produção. Na dúvida entre restringir mais ou aceitar, **aceitar** — validar formato é higiene, não gatekeeping. Uma constraint restritiva demais aqui é um defeito, não uma proteção.

### 7.4 CNPJ
**Reusa** `accounts_cnpj_format` (041): `NULL` ou exatamente 14 dígitos. **Não redefine.** A unicidade parcial `idx_accounts_cnpj_unique` (041) permanece — corrigir um CNPJ não pode colidir com outro tenant; colisão → erro de unicidade. Formato inválido → `ERRCODE 22023` (mesmo código que 042 usa).

### 7.5 Semântica de partial update — normativa
- **Chave omitida** no payload → campo **inalterado**. Um update de identidade **nunca** apaga campos não enviados.
- **`null` explícito** → **limpa** o campo (define `NULL`). É a única forma de esvaziar um campo.
- Esta distinção (omitido ≠ null explícito) é contratual e vale **igualmente** para os dois escritores.

---

## 8. Modelo de autorização

Dois escritores, **duas fachadas de autorização sobre as mesmas colunas** — nenhuma semântica nova.

### 8.1 Member admin — via RLS (E5a)
Caminho: PATCH `/api/account` estendido. Guardas, **inalterados em natureza**:
- `requireRole('admin')` na rota (já existe);
- RLS `accounts_update = is_account_member(id,'admin')` (017) — o próprio banco só permite o UPDATE se o chamador for **admin membro daquela conta**;
- rate-limit no molde já existente (`admin:rename:*`).

Um admin edita **apenas a própria conta**. Não-admin e não-membro são bloqueados pela RLS. Nenhuma escalada de privilégio nova.

### 8.2 Platform operator — via SECURITY DEFINER (E5b)

Caminho: novo RPC de UPDATE, **irmão de `create_platform_workspace` (042)**, espelhando-o em estrutura:
- `SECURITY DEFINER`, `SET search_path = public`, `OWNER postgres`;
- `REVOKE ALL FROM PUBLIC`; `GRANT EXECUTE TO authenticated`;
- validação de entrada → `ERRCODE 22023` (formato), como 042;
- corpo único = uma transação (UPDATE + audit no mesmo ato).

**Diferença deliberada no predicado de autorização — Scope gate ≠ Action gate:**

| Aspecto | 042 (create) | 054 (update identity) |
|---|---|---|
| O que autoriza | Criar um tenant novo (não existe ainda) | Alterar identidade de um tenant existente |
| Gate de escopo | `is_platform_operator_for` (037) — operador ativo com vínculo ao tenant | `is_platform_operator_for` (037) — idem |
| Gate de ação | `platform_operators.role = 'admin'` (rank global) | **`platform_operator_accounts.access_role = 'admin'`** (papel no tenant) |
| Razão | Criação é operação global que exige Superadmin | Mutação de tenant existente é operação delegada ao admin **daquele tenant** |

O RPC 042 cria um tenant **novo** — não existe conta-alvo para ancorar uma permissão tenant-scoped, portanto o gate é global (`platform_operators.role`). O RPC 054 altera um tenant **existente** e já supervisionado — o operador tem uma linha em `platform_operator_accounts` que fixa seu `access_role` naquele tenant. O predicado de ação exige `access_role = 'admin'` para mutação de identidade, rejeitando operadores `viewer` ou `agent` (que passam no gate de escopo — podem acessar o tenant — mas falham no gate de ação — não podem mutá-lo). Ambos usam `42501` para não vazar qual condição falhou.

Não autorizado → `RAISE EXCEPTION USING ERRCODE = '42501'` (mesmo código e mesma forma de 042).

O `SECURITY DEFINER` existe **exclusivamente** para transpor a RLS `is_account_member` no caso legítimo do operador que supervisiona mas não é membro — exatamente a justificativa que 042 já estabeleceu para o INSERT.

### 8.3 Reuso do padrão `create_platform_workspace` — normativo
O RPC de E5b **deve** ser estruturalmente uma cópia de 042 trocando INSERT por UPDATE:
mesmo `SECURITY DEFINER`/`SET search_path`/`OWNER`, mesmo `42501`, mesmo `REVOKE`/`GRANT`, mesma validação de CNPJ (`22023`), mesma escrita em `platform_audit_log` na mesma transação.

**Exceção normativa — o predicado de autorização (§8.2):** 042 usa `platform_operators.role = 'admin'` (global); 054 usa `platform_operator_accounts.access_role = 'admin'` (tenant-scoped). Essa diferença não é desvio — é a aplicação do mesmo princípio (Scope vs Action) que o contrato documenta em §8.2. A estrutura do RPC (forma do `42501`, validação `22023`, audit transacional) permanece idêntica; apenas o **alvo** do gate de ação muda porque a operação (UPDATE em tenant existente vs INSERT em tenant novo) tem requisito de autorização diferente. Qualquer **outro** desvio é violação do contrato e deve ser levantado no review, não decidido na implementação.

---

## 9. Auditoria

- **Platform-side (E5b):** toda mutação grava uma linha em `platform_audit_log` (037) — colunas existentes `actor_user_id`, `target_account_id`, `action`, `metadata` — com **nova `action`** (ex.: `update_workspace_identity`), na **mesma transação** do UPDATE (padrão de 042, que usa `action='create_workspace'`). `metadata` registra os campos alterados (sem vazar valores sensíveis além do necessário). Sem tabela/trigger novos.
- **Member-side (E5a):** **não** grava em `platform_audit_log` — essa tabela é platform-scoped (ator = operador de plataforma). Um admin editando a própria conta é self-service; o rastro é `accounts.updated_at` (trigger existente). Criar auditoria tenant-facing seria tabela nova → **fora de escopo** (§2). Decisão pinada: member-side não é auditado em `platform_audit_log`.

---

## 10. APIs / RPCs previstas

| Item | Split | Natureza | Reuso |
|---|---|---|---|
| Migration aditiva — 3 colunas + CHECK constraints em `accounts` | E5a | Estrutura de dados | Precedente 041/021 |
| PATCH `/api/account` estendido (name + identidade + cnpj, partial update) | E5a | Rota member-side | Estende rota existente |
| Novo RPC `SECURITY DEFINER` de UPDATE de identidade de workspace | E5b | RPC platform-side | Espelha 042 |
| Rota UI `/act/[accountId]/settings` | E5b | Frontend | Nova, consumidor fino |

**Split no histórico de migrations — normativo.** Cada split é **uma migration própria**; **não juntar tudo em uma só** (mesmo espírito do E4b: mudança pequena, validação clara, rollback mental simples). Nomes sugeridos (não vinculantes; o número final segue a sequência vigente após 052):

```
053_accounts_commercial_identity.sql        ← E5a: colunas + CHECK constraints
054_platform_workspace_identity_update.sql  ← E5b: RPC SECURITY DEFINER + audit
```

A migration de E5b (054) **não** deve conter as colunas de E5a (053) — ver §Sequência dura. Nomes concretos de coluna, do RPC e da `action` de auditoria são decisão de implementação, contanto que respeitem §7–§9. O contrato **não** prescreve identificadores além da recomendação de split acima.

---

## 11. Critérios de aceite

1. As três colunas de identidade existem em `accounts`, nullable, com CHECK constraints (§7); CNPJ e currency reusam as constraints existentes sem redefini-las.
2. Admin membro edita `name`, razão social, telefone, e-mail e CNPJ da **própria** conta via PATCH; RLS mantida; não-admin e membro de outro tenant bloqueados.
3. Operador de plataforma edita a identidade de um tenant **supervisionado** via o novo RPC, mesmo **não sendo membro**; operador **não autorizado** recebe **`42501`**, mesmo com `accountId` válido — idêntico a 042.
4. CNPJ é corrigível pós-criação; formato inválido → `22023`; colisão de unicidade rejeitada; um CNPJ corrigido válido persiste.
5. **Partial update** nunca apaga campo omitido; `null` explícito limpa o campo (§7.5) — verificado nos dois escritores.
6. Toda mutação platform-side grava `platform_audit_log` com a nova `action`, na mesma transação; member-side não grava nessa tabela (§9).
7. `accounts.updated_at` é atualizado em toda mutação (trigger existente).
8. **Nenhuma** alteração em `messages.status`, messaging, providers, retry ledger ou qualquer contrato de E4b; nenhuma tabela/trigger/abstração nova além das 3 colunas.
9. `tsc --noEmit`, testes (PGlite) e `next build` verdes em CI (o sandbox local dá Bus error ambiental — validação real é no CI).

---

## 12. Matriz de testes

**Autorização (molde "4 cenários → 42501" já exigido pelo roadmap para RPCs novos):**

| Cenário | Caminho | Esperado |
|---|---|---|
| Admin membro edita própria conta | member PATCH | ✅ grava |
| Agente/viewer membro edita | member PATCH | ❌ RLS/`requireRole` bloqueia |
| Admin membro do tenant A edita tenant B | member PATCH | ❌ RLS bloqueia |
| Operador de plataforma **admin** com vínculo no tenant edita | platform RPC | ✅ grava + audita |
| Operador de plataforma **viewer** com vínculo no tenant edita | platform RPC | ❌ `42501` (scope OK, action denied) |
| Operador de plataforma **sem** vínculo com o tenant | platform RPC | ❌ `42501` |
| Usuário sem contexto de plataforma chama o RPC | platform RPC | ❌ `42501` |
| Anônimo | ambos | ❌ bloqueado |

**Dados / validação:**

| Caso | Esperado |
|---|---|
| Partial update com um campo | só ele muda; omitidos preservados |
| `null` explícito num campo | campo limpo |
| CNPJ 14 dígitos válido novo | grava |
| CNPJ formato inválido | `22023` |
| CNPJ colidindo com outro tenant | erro de unicidade |
| Razão social vazia após trim | rejeitada (usar NULL) |
| E-mail / telefone malformado | rejeitado pela CHECK |
| `updated_at` após update | avança |
| Auditoria platform | 1 linha, action nova, mesma transação |

**Regressão / fronteira:**

| Verificação | Esperado |
|---|---|
| `messages.status` e messaging | intocados |
| Nenhuma tabela/trigger novos além das colunas | confirmado |
| Rename member-side continua funcionando (não duplicado) | verde |

---

## 13. Riscos e decisões preservadas

| # | Risco | Mitigação / decisão preservada |
|---|---|---|
| 1 | RPC de plataforma inventar autorização própria (atalho fora da arquitetura) | §8.3 normativo: adota a mesma estrutura de 042 (`SECURITY DEFINER`, `42501`, validação `22023`, audit transacional), com a diferença deliberada no gate de ação (`access_role = 'admin'` tenant-scoped em vez de `role = 'admin'` global) — documentada em §8.2. Qualquer outro desvio = falha de review |
| 2 | Dois escritores divergirem na validação | §5/§7: validação em CHECK constraints no banco — ambos herdam; impossível divergir |
| 3 | Duplicar o rename (segundo caminho) | §2/§3: member PATCH é **estendido**; platform RPC é a fachada de plataforma sobre as mesmas colunas — não um segundo modelo |
| 4 | Redefinir a constraint de CNPJ e quebrar 041 | §7.4: reuso literal de `accounts_cnpj_format` e `idx_accounts_cnpj_unique`; só se adiciona caminho de escrita |
| 5 | Partial update apagar campos omitidos | §7.5 + critério 5 + teste dedicado |
| 6 | Escopo vazar para billing/validação externa/auditoria tenant-facing | §2: explicitamente fora; sem tabela nova |
| 7 | E5b começar antes de E5a (colunas ausentes) | Sequência dura: E5a (colunas) → E5b (RPC/UI). E5a é autossuficiente |
| 8 | Tocar messaging/`messages.status` por engano | §2/§8 critério 8: E5 não importa nem referencia nada de messaging |

**Decisões preservadas (não reabertas):** E4b (ADR-E4B-001/002/003), ADR-SYS-001, ODI-001, DLB-001, EIS-001, ADR-MSG-001 permanecem intactos. E5 **não** é ADR-SYS-001 (aquele trata de ator sem sessão / service_role; E5b usa `authenticated` com contexto de plataforma, como 042). **Backlog de E4b** (TTL por criação da intenção; erro explícito no enqueue) permanece aberto e **não** é tocado por E5.

---

## Plano de implementação posterior (fora deste contrato)

1. **Sonnet:** implementa **E5a** (migration aditiva + CHECK + PATCH estendido + testes member) → e, após E5a verde, **E5b** (RPC espelhando 042 + audit + rota `/act/[accountId]/settings` + testes de autorização/plataforma). Uma migration aditiva por split; nenhuma alteração em 001–052.
2. **DeepSeek:** revisão final, testes, commit, push — com CI verde (o Bus error local é ambiental).

Sequência dura: **E5a → E5b.** Cada um fecha um objetivo; E5a pode ser commitado sozinho.

- **E5a possui lifecycle independente** — pode ser mergeado, publicado e validado sozinho.
- **E5b só inicia após E5a estar publicado e validado.**
- **E5b não deve aparecer na mesma migration que cria as colunas** (E5a). Migrations separadas (§10) — motivo: rollback e revisão mais simples, no espírito de mudança pequena do E4b.

---

*Fim do contrato. Nenhum código, migration, RPC concreta, nome de coluna ou ADR foi produzido. Documento destinado a orientar a implementação (Sonnet) dentro dos padrões já congelados.*
