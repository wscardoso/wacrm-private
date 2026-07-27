# E7 — Inventário de Superfícies de Ciphertext

| | |
|---|---|
| **Versão** | 1 |
| **Data** | 2026-07-27 |
| **Deriva de** | `ADR-E7-001` §13.1 — obrigatório como referência para toda declaração de convergência (I7); `IMP-E7-001` §5, Fase 4 |
| **Owner** | Platform Architecture |
| **Mantido por** | Revisão de PR — qualquer épico que introduza armazenamento operacional de ciphertext (ou de dados que possam referenciá-lo) declara sua entrada aqui como parte da própria definição de pronto daquele épico (`ADR-E7-001 §13.1`), nunca descoberto retroativamente. |

---

## 1. Propósito

Este documento é o **Inventário de Superfícies de Ciphertext** exigido por `ADR-E7-001 §13.1`: a única referência válida contra a qual "convergência total" de um KID (I7) pode ser avaliada. Uma declaração de convergência que não cite a versão deste documento contra a qual foi produzida não satisfaz I7 (`ADR-E7-001 §13.3`).

Este documento **não é consultado por nenhum código em runtime** — é um artefato de governança, mantido por revisão humana, análogo aos demais documentos de `docs/architecture/`. A versão citada acima (e, quando aplicável, o hash do commit que a introduziu) é o identificador que uma futura Convergence Attestation (`ADR-E7-001 §13.3`, IMP-E7-001 Fase 5) deve referenciar.

Este documento **não decide** o mecanismo de convergência de nenhuma superfície — apenas declara onde ciphertext pode existir. A estratégia (preguiçosa e/ou administrativa, `ADR-E7-001 §13.2`) e seu estado de implementação são registrados na coluna "Cobertura de convergência" de cada tabela abaixo.

---

## 2. Tabelas primárias

| Superfície | Coluna(s) com ciphertext | Binding Context | Cobertura de convergência |
|---|---|---|---|
| `whatsapp_config` | `access_token`, `verify_token`, `waba_id` | `whatsapp_config:{account_id}` | **Preguiçosa**: self-heal em `webhook/route.ts` (campo `verify_token`) e `send/route.ts` (campo `access_token`) — estendido nesta Sprint (IMP-E7-001 Fase 4) para também convergir KID-antigo→KID-corrente, além de legado→canônico. **Administrativa**: `GET /api/whatsapp/config/kid-convergence-sweep` (novo nesta Sprint), cobre as 3 colunas por linha. |
| `ad_account_credentials` | `ciphertext` | `ad_account:{account_id}` | **Nenhuma ainda.** Domínio decrypt-only do lado da aplicação (`ADR-ATTR-002`; só há RPC de leitura para o job de enriquecimento, sem self-heal de escrita) e sem rotação de chave em curso. Gap explícito e aceito — rastreado para quando este domínio precisar de rotação real; nenhuma declaração de convergência total (I7) pode ser feita hoje sem cobrir esta lacuna. |

---

## 3. Filas e mecanismos de retry

| Superfície | Contém ciphertext diretamente? | Observação |
|---|---|---|
| `outbound_retry_ledger` (E4a/E4b, migration 049) | **Não.** Armazena apenas `message_id` (referência a `messages`, que também não contém ciphertext). | Relevante mesmo sem ciphertext próprio: os caminhos que processam este ledger (`delivery/cron/route.ts`, `delivery/orphan-sweep/route.ts`, `sender.ts`) resolvem `whatsapp_config.access_token` via `connection_ref` no momento do processamento — ou seja, dependem da cobertura de convergência de `whatsapp_config` acima, não de uma cobertura própria. Nenhuma ação adicional necessária nesta superfície além de garantir que `whatsapp_config` esteja convergido. |

## 4. Dead-letter queue (DLQ)

| Superfície | Contém ciphertext diretamente? | Observação |
|---|---|---|
| `outbound_retry_ledger` com `status = 'dead'` | **Não.** Mesma tabela da seção 3 — DLQ é um valor de `status`, não uma tabela separada. | Mesma conclusão da seção 3: nenhuma cobertura própria necessária; herda a cobertura de `whatsapp_config`. |

## 5. Jobs assíncronos / eventos em trânsito

| Superfície | Contém ciphertext diretamente? | Observação |
|---|---|---|
| `enrichment_ledger` (E6.0, migration 056) | **Não.** Armazena apenas `attribution_id`/`account_id` e estado do job — nenhuma coluna de ciphertext. | O job de enriquecimento (`credential-resolver.ts`) decifra `ad_account_credentials.ciphertext` **em voo**, nunca persiste ciphertext nem texto plano no ledger. Depende inteiramente da cobertura (hoje ausente, §2) de `ad_account_credentials`. |

## 6. Snapshots e backups

| Superfície | Observação |
|---|---|
| Backups gerenciados do Postgres/Supabase (todas as tabelas acima) | Fora do alcance de qualquer sweep aplicativo. Um backup restaurado após um KID ser `Destroyed` reintroduziria ciphertext irrecuperável — o cenário exato que I7 existe para prevenir (`ADR-E7-001 §13.1`). Nenhuma mitigação de código é possível aqui; qualquer declaração de convergência total deve considerar a política de retenção de backup vigente no momento da declaração, fora do escopo deste documento. |

## 7. Superfícies futuras

Todo épico futuro que introduza armazenamento operacional de ciphertext (ou de dados que possam referenciá-lo — filas, caches, exports) declara sua entrada nesta seção como parte da própria definição de pronto daquele épico, incrementando a versão deste documento no topo. Nenhuma superfície nova pode ser assumida coberta por omissão.

---

## 8. Resumo de cobertura (para leitura rápida antes de qualquer declaração de convergência)

| Domínio | Convergência preguiçosa | Convergência administrativa | Pronto para avaliação de I7? |
|---|---|---|---|
| `whatsapp_config` | ✔ (legado→canônico desde IMP-CRYPTO-001 Phase 2/3.2; KID-antigo→KID-corrente desde IMP-E7-001 Fase 4) | ✔ (desde IMP-E7-001 Fase 4) | Sim, para as 3 colunas listadas em §2 |
| `ad_account_credentials` | ✖ | ✖ | **Não** — gap explícito, ver §2 |
