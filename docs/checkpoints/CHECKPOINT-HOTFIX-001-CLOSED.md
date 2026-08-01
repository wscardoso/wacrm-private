# CHECKPOINT HOTFIX-001 — Fechamento do Gate de Homologação

| | |
|---|---|
| **Tipo** | Checkpoint de fechamento documental do Gate |
| **Estado** | **Approved for Implementation** |
| **Data** | 2026-08-01 |
| **Fluxo** | Gate Inicial → Gate Final → Rodada de Correções → Gate de Homologação Final |

---

## 1. Resumo executivo

`docs/HOTFIX-001.md` — Plano de Implementação da Identidade Canônica e Merge de Contatos — foi submetido aos quatro gates do fluxo de homologação e **aprovado para implementação**. Este checkpoint registra o fechamento documental do Gate e é o marco de entrada da execução controlada (implementação em fases, validação e checkpoint de estado implementado).

## 2. Autoridades congeladas

A execução consome exclusivamente, como autoridade semântica, os dois documentos congelados:

- `docs/adr/ADR-IDENTITY-BR-001` — Identidade Canônica de Telefone (Brasil), **congelado** (§14).
- `docs/adr/ADR-CONTACT-MERGE-001` — Semântica de Consolidação de Contatos e Conversas, **congelado** (§14).

Nenhuma decisão semântica dos dois ADRs é reaberta, reinterpretada ou ajustada por esta execução.

## 3. Bloqueios validados

| Bloqueio | Status |
|---|---|
| **CRÍTICO-3** | **RESOLVIDO** — re-apontamento de `contact_notes`, `deals` e `broadcast_recipients` antes da remoção do contato perdedor; nenhuma tabela omitida; nenhum helper remove contatos diretamente; `DELETE` do perdedor exclusivamente no passo final previsto. |
| **ALTO-4** | **RESOLVIDO** — procedimento operacional (A.6) para contas já promovidas ao índice UNIQUE: re-canonicalização, redescoberta, backfill e repromoção do índice, respeitando `ADR-IDENTITY-BR-001`, `GENERATED STORED` e F.5. |
| **MÉDIO** | **RESOLVIDO** — A.4 e F.1 mantidos exatamente no mecanismo homologado; sem flag booleana isolada; sem modelo diferente de estados. |

## 4. Contrato de execução

A implementação executa **somente** o previsto em `docs/HOTFIX-001.md`, na ordem de fases do próprio documento (A→G), sem:

- nova auditoria;
- reabertura de decisões;
- melhorias arquiteturais fora de escopo;
- alteração de escopo.

---

*Fechamento documental do Gate registrado. Próximo passo: commit documental isolado.*
