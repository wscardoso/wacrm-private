# CHECKPOINT HOTFIX-001 — Deploy Readiness (Autorização de Aplicação de Migrations)

| | |
|---|---|
| **Tipo** | Artefato de evidência da validação operacional pré-deploy |
| **Estado** | **Deploy autorizado** — aplicação de migrations 064–072 no Supabase |
| **Data** | 2026-08-01 |
| **Ambiente consultado** | Supabase `wa-crm` (`uybjenopyvdmuixnhzqh`) via PostgREST com `SUPABASE_SERVICE_ROLE_KEY` |

---

## 1. Referência

Este registro formaliza o último carimbo entre **"implementação validada"** e **"mudança autorizada no ambiente"** para a aplicação das migrations 064–072 do [HOTFIX-001](../HOTFIX-001.md) — Identidade Canônica e Merge de Contatos. As migrations foram executadas verbatim no harness PGlite e a suíte G.2 está 100% verde (34/34); a suíte completa: 99 arquivos / 1418 testes, typecheck e lint limpos.

Autoridades semânticas consumidas (congeladas, não reabertas):

- `docs/adr/ADR-IDENTITY-BR-001` — Identidade Canônica de Telefone (Brasil).
- `docs/adr/ADR-CONTACT-MERGE-001` — Semântica de Consolidação de Contatos e Conversas.

## 2. Achado operacional — `deals.conversation_id`

`deals` possui coluna própria `conversation_id`. Na semântica de merge de `ADR-CONTACT-MERGE-001` (§4.5, passo 13a de HOTFIX-001), `deals` é uma das tabelas de vínculo re-apontadas por `contact_id` antes da remoção do contato perdedor. A pré-condição operacional para a aplicação das migrations é que **nenhum `deals` existente dependa de re-apontamento de `conversation_id`** — sem isso, a verificação pós-migration de totalidade referencial (I2) seria afetada por dados pré-existentes.

A verificação operacional abaixo confirma o estado do ambiente antes de qualquer alteração de schema.

## 3. Consulta executada

```sql
SELECT count(*) FROM deals WHERE conversation_id IS NOT NULL;
```

**Equivalente executado via PostgREST** (mesmo Postgres de origem, filtro idêntico, contagem exata — `Prefer: count=exact`):

```
GET /rest/v1/deals?conversation_id=not.is.null&select=id
```

Sanidade: contagem total de `deals` no projeto também consultada (`select=id` sem filtro) para distinguir "resultado real" de "falha de acesso".

## 4. Resultado

| Métrica | Valor |
|---|---|
| `count(*)` com `conversation_id IS NOT NULL` | **0** |
| `count(*)` total de `deals` | **0** |
| Código HTTP | `200` |
| `Content-Range` | `*/0` |

**Interpretação:** a tabela `deals` é alcançável e está vazia no ambiente. Nenhuma linha pré-existente possui `conversation_id` populado, portanto nenhuma revisão de `ADR-CONTACT-MERGE-001` é necessária para cobrir população histórica nesta aplicação.

## 5. Decisão

> **Deploy autorizado sem revisão do ADR-CONTACT-MERGE-001.**

## 6. Observação

> **Qualquer futura população de `deals.conversation_id` deverá ser tratada conforme revisão formal do ADR.**

---

*Evidência da validação registrada. Migrations 064–072 aplicáveis ao Supabase; validações pós-migration seguem como próximo passo.*
