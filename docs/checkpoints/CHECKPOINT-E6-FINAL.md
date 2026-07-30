# Checkpoint — E6 (Attribution End-to-End) — Fechamento da Épica

| Campo | Valor |
|---|---|
| **Data** | 2026-07-30 |
| **Épico** | E6 — Attribution End-to-End |
| **Status anterior** | PARCIAL (1/4 entregáveis fechado) |
| **Status final** | **CONCLUÍDO — como infraestrutura, reescopado** |
| **Checkpoints relacionados** | `docs/checkpoints/E6.0-final-checkpoint.md` (fecha o sub-escopo de enriquecimento), `docs/checkpoints/CHECKPOINT-ROADMAP-RECONCILIATION.md` §9 (addendum que motivou este fechamento) |
| **ADRs relacionados** | `docs/adr/ADR-ATTR-001-lead-attribution.md` (Aceito), `docs/adr/ADR-ATTR-002-per-tenant-ad-account-credentials.md` (Aceito) |

## 1. Por que este checkpoint existe, e por que é distinto de `E6.0-final-checkpoint.md`

`E6.0-final-checkpoint.md` (2026-07-29) fechou o **sub-escopo de enriquecimento** — o job que consulta a Marketing API e grava `lead_attributions`. Este documento fecha a **épica E6 inteira**, definida no roadmap original (`MASTER-ROADMAP.md` §7) por quatro entregáveis: congelar `ADR-ATTR-001`, enriquecimento, UI de relatório, CAPI. Os dois documentos coexistem porque cobrem escopos diferentes — um sub-épico técnico e a épica de produto que o contém.

## 2. Estado dos quatro entregáveis originais

| Entregável | Estado em 2026-07-29 (auditoria) | Estado agora | Decisão |
|---|---|---|---|
| Congelar `ADR-ATTR-001` | Proposto (aguardava contestação) | **Aceito** — §11 do ADR | Fechado nesta sessão, 2026-07-29 |
| Enriquecimento | Implementado, não fechado formalmente | **Concluído** — `E6.0-final-checkpoint.md` | Fechado nesta sessão, 2026-07-29 |
| UI de relatório | Ausente — RPC e rota existem, zero consumidores de front-end | **Reescopado para E12** | Decisão de Weyner, 2026-07-30 |
| CAPI | Ausente — não-objetivo declarado de E6.0 | **Fora do MVP** (P3/P4) | Decisão de Weyner, 2026-07-29 (via `ADR-ATTR-001` §9) |

## 3. A decisão de reescopo — raciocínio completo

A auditoria de reconciliação (`CHECKPOINT-ROADMAP-RECONCILIATION.md` §4) identificou que o backend do relatório de attribution está completo e testado (`get_enrichment_report` — migration `056:366`; rota `/api/enrichment/report`), mas não existe nenhuma tela que o consuma (`grep` em `src/app`, `src/components`, `src/hooks` retorna vazio). Marcar E6 como CONCLUÍDO sem qualificação faria a documentação afirmar um entregável que não existe — o mesmo tipo de drift que a reconciliação inteira de 2026-07-29 corrigiu.

Três opções foram apresentadas a Weyner:

- **(a)** Reescopar E6 explicitamente: UI sai para uma épica de Reporting (E12, que já existia e estava bloqueada por E6). E6 fecha como "backend de attribution completo".
- **(b)** Manter E6 PARCIAL até a tela existir; fechar formalmente só E6.0.
- **(c)** Implementar a UI antes de fechar — fora do escopo documental desta sessão.

**Decisão: (a).** Motivos registrados por Weyner e por esta auditoria:

1. O backend está completo e testado — não há trabalho técnico pendente que justifique manter E6 aberto.
2. A UI de relatório é trabalho de produto (telas, componentes, hooks), não uma decisão arquitetural pendente — não há razão para um épico de arquitetura ficar aberto por um item de produto.
3. Manter a UI dentro de E6 bloqueava `E12` (Reporting & Export) indefinidamente por um item que pertence naturalmente a ele — inversão de dependência artificial identificada tanto pela auditoria quanto pelo processo externo que revisou a Fase 1 de E2.1.
4. `E12` já existia no roadmap como "Reporting & Export", com escopo genérico de relatórios — a UI de attribution é um caso particular desse escopo, não um item estranho a ele.

## 4. O que este fechamento NÃO decide

- Não prioriza quando `E12` será implementado — segue P2, não iniciado, apenas **desbloqueado**.
- Não reabre `ADR-ATTR-001` ou `ADR-ATTR-002` — ambos permanecem Aceitos, sem alteração de conteúdo.
- Não decide nada sobre `E2.1` (Canonical Message Status) — épica e reescopo de E6 são independentes, tratados em documentos e commits separados.
- Não autoriza CAPI — permanece fora do MVP por decisão já registrada em `ADR-ATTR-001` §9 (P4, mantido no roadmap fora do MVP).

## 5. Evidência de consistência documental

Após este checkpoint, os seguintes documentos foram atualizados para não se contradizerem:

- `docs/MASTER-ROADMAP.md` → v1.5: E6 marcado CONCLUÍDO (§6, §7), grafo de dependências corrigido (§8, `E6 bloqueia E12` removido), FASE 4 atualizada (§9).
- `docs/checkpoints/CHECKPOINT-ROADMAP-RECONCILIATION.md` → addendum §9, preservando §1–§8 como registro histórico do estado em `26e5d39`, sem reescrever a auditoria original.
- `docs/architecture/E6.0-attribution-enrichment-marketing-api.md` → status "Implementado e fechado" (já feito em 2026-07-29).

## 6. Decisão final

**E6 está formalmente fechado como épica de infraestrutura.** A UI de relatório de attribution passa a ser entregável de `E12 — Reporting & Export`, que fica desbloqueado a partir desta data. Nenhum código foi alterado por este checkpoint — é fechamento documental sobre trabalho técnico já existente e verificado.
