# CHECKPOINT E2.1-RC1 — Pendências Arquiteturais

| | |
|---|---|
| **Épico** | E2.1 — Canonical Message Status, ciclo de correção RC1 |
| **Tipo** | Registro de pendência arquitetural — **não é decisão técnica**; registra o que ficou fora do escopo e por quê |
| **Data** | 2026-07-30 |
| **Adjudicação de referência** | `docs/architecture/E2.1-RC1-canonical-status-adjudication.md` (commit `c075685`) |
| **Contrato envolvido** | `EIS-001` §4.1 — contrato **não alterado** por este documento |
| **Estado** | **PENDING ARCHITECTURAL DECISION** |
| **Portador futuro** | Ciclo próprio de EIS / Identity Resolution |
| **Código produzido** | **Nenhum.** Registro documental apenas |
| **Schema alterado** | **Nenhum** |
| **Documentos existentes alterados** | **Nenhum** |

---

## 1. Contexto

Durante a revisão do ciclo **E2.1-RC1** foi identificada uma questão relativa à **resolução de identidade externa sem especificação de `kind`**.

A adjudicação arquitetural do RC1 — registrada em `docs/architecture/E2.1-RC1-canonical-status-adjudication.md` — aprovou um conjunto explícito e fechado de decisões: o problema **B2** (perda de evento sob concorrência no compare-and-set), a estratégia de releitura e reavaliação após CAS falho, o escopo de arquivos do ciclo, os testes obrigatórios e a errata de `EIS-001` §4.3.

A questão de `kind` **não integrou** esse conjunto.

Este documento existe para que a decisão de deixá-la fora possua artefato versionado, e não dependa da memória de nenhuma conversa.

---

## 2. Pendência — `EIS-001` §4.1

Registro do estado da pendência:

1. **A questão permanece fora do escopo de E2.1-RC1.**
2. **Nenhuma alteração contratual foi aprovada neste ciclo.** `EIS-001` §4.1 permanece exatamente como está.
3. **Nenhuma implementação deve ser feita com base nesta pendência.** Código que pressuponha uma resolução para a ambiguidade de `kind` está fora de qualquer escopo autorizado até que o ciclo portador decida.

---

## 3. Motivo da exclusão

1. **A adjudicação RC1 aprovou apenas as decisões explicitamente listadas.** O que não foi adjudicado não entra por extensão, ainda que tecnicamente relacionado.
2. **Alterar §4.1 neste momento ampliaria o escopo do ciclo.** A semântica de resolução de identidade é fronteira própria; mexer nela durante um ciclo dedicado à concorrência no CAS misturaria dois eixos de decisão.
3. **A questão deve ser tratada em ciclo próprio de Identity Resolution**, com o contrato `EIS-001` como objeto central, e não como efeito colateral de um ciclo de correção de status.

---

## 4. Risco reconhecido

Registro técnico do risco, sem proposta de solução:

1. **`kind` é opcional na operação de resolução** (`EIS-001` §4.1). Quando omitido, a busca percorre todas as espécies registradas para a conexão.
2. **O índice de unicidade é `(connection_ref, kind, value)`** (`EIS-001` §3.4). Ele garante no máximo uma linha por espécie — não uma linha por valor. Duas espécies distintas podem portanto registrar o mesmo `value` dentro da mesma conexão.
3. **Consequência:** uma busca sem `kind` pode produzir **múltiplas correspondências**, e essas correspondências podem apontar para mensagens diferentes.
4. **A resolução dessa ambiguidade exige decisão arquitetural própria** — qual espécie tem precedência, ou se a ambiguidade deve ser tratada como não-correlação. Nenhuma dessas alternativas foi decidida, e nenhuma é presumida aqui.
5. **A pendência não está esquecida nem é considerada resolvida.** Este registro é a evidência de que ela permanece aberta e rastreável.

---

## 5. Estado

**PENDING ARCHITECTURAL DECISION**

| | |
|---|---|
| **Portador futuro** | Ciclo próprio de EIS / Identity Resolution |
| **Contrato a examinar** | `EIS-001` §4.1, em conjunto com §3.4 |
| **Bloqueia E2.1-RC1?** | **Não.** A implementação aprovada para o RC1 não depende de alterar §4.1 |
| **Autoriza implementação?** | **Não.** Nenhum código pode ser produzido com base nesta pendência |

---

*Fim do registro. Nenhuma solução proposta, nenhuma correção de código sugerida, nenhum documento existente alterado, nenhum contrato modificado. `EIS-001` e `ADR-MSG-STATUS-001` permanecem como estão.*
