# Reconciliação Final — Análise ChatPro × R-Sonnet × R-DeepSeek

**Data:** 2026-08-07 · **Autor:** Sonnet (Cowork), síntese das três rodadas · **Método:** onde os dois relatórios independentes divergem, verifiquei o código eu mesmo antes de arbitrar — não tomei o lado de nenhum por autoridade do modelo.

---

## 1. O que as três rodadas concordam (fechado, sem debate)

- **Tags já existem, completas.** Minha análise original errou classificando como "não confirmado". Confirmado por mim: `contact_tags`/`tags` (001:73-88), RLS, RPC `filter_contacts_by_tags` (025/040), UI (`tag-manager.tsx`), uso em broadcast/automations/flows.
- **Automations e Flows já são provider-agnósticos.** Confirmado por mim: `automations/meta-send.ts:104` e `flows/meta-send.ts:97,229,400` chamam `getProvider()`. O rótulo "ambos Meta-only" do `MASTER-ROADMAP.md §2.3` é resíduo desatualizado — contradiz o próprio §1 do mesmo documento. Minha análise original herdou esse erro do roadmap sem verificar.
- **A duplicação Automations×Flows é concreta, não hipotética.** Confirmado por mim: `flows/meta-send.ts:23-28,56-59` nomeia o alvo da extração (`engineSendBase`) em comentário do próprio time. Isso não é "dois motores sem decisão documentada" — é dispatch+retry reimplementado duas vezes sob duas orquestrações genuinamente diferentes (Flows = máquina de estados conversacional; Automations = árvore de reação a evento).
- **Existe um contrato de orquestração implícito, não documentado, entre os dois motores.** Confirmado por mim: `flows/engine.ts:1003` — `// Don't consume — let automations have a shot at it.` Os dois motores já convivem no código com uma regra de precedência real; só não está em nenhum ADR.
- **`lead_attributions.source_channel` é um CHECK fechado de 4 valores, hoje só `ctwa_meta` é gravado.** Confirmado por mim: migração 033, linhas 45-47 têm `CHECK (source_channel IN ('ctwa_meta','tracked_link','organic','unknown'))`. Fonte B (link rastreável — `tracking_links`/`tracking_clicks`) está inteiramente especificada em `ADR-ATTR-001 §3.4` (fase P2, Aceito) mas nunca migrada — zero tabelas no schema real.
- **Não deve existir um barramento único de eventos.** As duas reconciliações independentes chegaram à mesma conclusão por caminhos diferentes: o padrão real do repo (RPC `SECURITY DEFINER` core + fachadas + ledger com claim-as-lock + cron) já se repete 5× (035, 048/050, 051/052, 056, 057) e deve ser reaplicado por feature nova (webhook de saída, etc.), não centralizado numa instância compartilhada. **Isso muda o diagrama que discutimos antes** — a caixa única "EVENT MODEL" no seu diagrama deveria ser lida como "um padrão repetido", não como uma tabela/bus física compartilhada. Ver §4.
- **DLQ (`whatsapp_webhook_dlq`, 031) está morta por decisão em aberto, não por esquecimento.** Confirmado por mim: `status-handler.ts:67-71` documenta explicitamente que o destino é uma decisão pendente de E2.1. Não deve ser reaproveitada como base de um webhook de saída sem reabrir essa decisão — o padrão (fila+retry) pode ser copiado, o código não.
- **IA é folha em branco — zero infraestrutura, zero ADR.** Confirmado por grep negativo nas duas rodadas e por mim. `ADR-AI-001` é pré-requisito de qualquer código de IA, e deve vir depois de um `ADR-AUT-001` que decida como IA entra num motor existente (nó dentro de Flows, nunca motor #3).
- **Multi-canal (Facebook/Instagram) permanece fora do North Star** — nenhuma das três análises recomenda perseguir.

---

## 2. Onde as duas reconciliações divergiram, e como resolvi

### 2.1 Departamentos/filas — a divergência mais importante

- **R-Sonnet:** recomendou manter `departments` fora do roadmap — "sem evidência de dor real", RLS hoje é por dono, atribuição de agente é só metadado de exibição.
- **R-DeepSeek:** recomendou tratar roteamento como primitiva arquitetural real (E15, P2), com evidência mais forte: conversa nasce sem fila (`findOrCreateConversation`), e o passo `assign_conversation` em modo `round_robin` das Automations é **literalmente fake**.

**Verifiquei eu mesmo — `automations/engine.ts:451-464`:**
```
case 'assign_conversation': {
  ...
  if (cfg.mode === 'round_robin') {
    // Pick any member of the account. The existing implementation
    // only ever returned the automation's author; preserving that
    // shape until a real round-robin algorithm replaces it.
    ...
  }
```

Isso resolve a divergência a favor do DeepSeek, mas com uma correção de escopo: o comentário não é evidência de que "departamentos" são necessários — é evidência de que **alguém já tentou resolver distribuição de conversa e parou na metade**. Isso é uma primitiva de roteamento não resolvida, não necessariamente uma primitiva de departamento/fila completa (com SLA, take-over, jornada de trabalho).

**Minha arbitragem:** escopo mínimo correto agora é **corrigir C21 (FK de `assigned_agent_id`) e implementar um round-robin real simples** (distribuir entre membros ativos da conta) — isso já resolve o código fake existente sem inventar o conceito de "departamento". `departments` como camada completa (fila, SLA, take-over) fica condicionado a uma decisão sua de crescimento de operação, não a uma necessidade técnica hoje. Isto é uma síntese, não uma vitória de um lado: o R-Sonnet está certo que construir `departments` agora seria antecipação especulativa; o R-DeepSeek está certo que deixar o round-robin fake sem tocar é ignorar uma dívida já comprovada em produção.

### 2.2 Precisa de um novo ADR para o Widget/Fonte B (`ADR-ATTR-003`)?

- **R-Sonnet:** não, a decisão já foi tomada em `ADR-ATTR-001` (D2), só falta executar P2.
- **R-DeepSeek:** sim, um `ADR-ATTR-003` (ou emenda) é necessário para abrir o CHECK de `source_channel`, definir semântica de first-touch orgânico, etc.

**Verifiquei eu mesmo em `ADR-ATTR-001-lead-attribution.md` §3.4/D2:** a Fonte B já está especificada com schema completo (`tracking_links`, `tracking_clicks`), fluxo de captura (`GET /r/[slug]`), e semântica de matching por token — isto não é uma lacuna de decisão, é trabalho de implementação P2 já ordenado no próprio ADR.

**Minha arbitragem:** concordo com o R-Sonnet no essencial — não é preciso um ADR novo do zero. Mas o R-DeepSeek acerta num detalhe real: o CHECK de `source_channel` (033:45-47) hoje só permite `ctwa_meta|tracked_link|organic|unknown` — se o Widget precisar de um valor distinto (`widget`, por exemplo, para diferenciar de `organic` genérico), isso é uma migração de schema pontual, não uma decisão arquitetural. Recomendo: **emenda curta ao `ADR-ATTR-001`** (uma seção nova, não um documento novo) registrando a decisão de nomenclatura do valor do CHECK quando P2 for de fato implementado — não bloqueia nada agora.

### 2.3 Prioridade relativa de E12 (multi-origem) vs E2.1

Aqui as duas convergem: **E2.1 continua sendo a próxima épica oficial** (já decidido por você em 2026-07-29, registrado no MASTER-ROADMAP v1.4). A decisão de **E12 nascer multi-origem** é uma decisão de design de custo zero que deveria ser tomada agora (documentalmente), sem adiantar a construção de E12 em si. Nenhuma das duas reconciliações propõe reordenar E2.1.

---

## 3. Achados novos que nenhuma das duas reconciliações — nem minha análise original — tinha

- **S2/S3 (buckets públicos, `_bcast_bump` sem REVOKE) não têm checkpoint formal no repo.** Só existe `CHECKPOINT-HOTFIX-002-S1.md` para S1. O R-DeepSeek sinalizou isso corretamente como dívida de governança P0 — vale formalizar um checkpoint ou pelo menos um registro rastreável para S2/S3, mesmo que a correção ainda não tenha sido feita, para não perder o rastro do que já foi auditado.
- **`lead_attributions` não tem nenhuma ligação com `deals`/receita.** Nenhum FK, nenhuma coluna de junção. Isso significa que hoje não dá para responder "quanto de receita veio de qual anúncio" dentro do banco — só "quantos leads". Isso é relevante para o desenho de E12: se o objetivo final é relatório comercial (não só contagem de lead), a ligação attribution→deal precisa entrar no escopo de E12 desde o design, não como P3 futuro.
- **O MASTER-ROADMAP.md está desatualizado em números básicos** (33→42 tabelas com RLS, ~20→~40 RPCs) porque está congelado em `26e5d39`, anterior às migrations 070-074 (S1 hotfix incluso). Não muda nenhuma decisão, mas vale um ciclo de atualização documental antes do próximo planejamento sério.

---

## 4. Impacto no diagrama que discutimos antes

O diagrama que você desenhou (ATTRIBUTION / CONVERSATION / AUTOMATION → EVENT MODEL → Reporting/Webhooks/AI, com OBSERVABILITY transversal) continua correto como **mapa conceitual de domínios**. O que as duas reconciliações corrigem é a implementação por trás da caixa "EVENT MODEL": não deve virar uma tabela/serviço único. Cada consumidor (Reporting, Webhooks, IA) deveria continuar sendo alimentado pelo **mesmo padrão estrutural** (RPC `SECURITY DEFINER` + ledger + cron) aplicado localmente a cada domínio, não por uma barramento físico compartilhado — isso é coerente com a decisão já registrada no repo de "nunca a mesma instância" (`E6.0`) e evita o risco que already sinalizei: uma abstração sem consumidor real.

---

## 5. Roadmap consolidado (substitui a seção 6 da análise original)

**Decisões documentais, custo zero, sem código (fazer primeiro):**
1. Registrar E12 como multi-origem desde o design + ligação futura com `deals`.
2. Emenda curta ao `ADR-ATTR-001` para nomenclatura do valor de `source_channel` do Widget (quando P2 entrar).
3. Formalizar checkpoints de S2/S3.
4. Corrigir §2.3 do MASTER-ROADMAP (Automations/Flows não são Meta-only) e as contagens defasadas.

**Curto prazo, baixo risco:**
5. Corrigir C21 (FK de `assigned_agent_id`) + implementar round-robin real simples (substituindo o `TODO` fake).
6. Motivos de finalização tipados, respostas rápidas — sem dependência.
7. Webhook de saída (E14), seguindo o padrão E4b — não a tabela 031 morta.

**Decisão arquitetural antes de construir (P1, decisão sem código ainda):**
8. `ADR-AUT-001` — não "qual motor vence", mas: extrair `engineSendBase` compartilhado, decidir onde IA entra como nó, dar destino às superfícies mortas (`http_fetch`, `manual`, `time_based`, `conversation_assigned`, `tag_added`).

**Visionário, depende do passo 8:**
9. `ADR-AI-001` (fronteiras data/ação/autoridade/tenant/billing) — **e agora precisa reconciliar com a Roxy-agent**, que já está em desenvolvimento paralelo, antes de ser escrito no vácuo.
10. Copiloto MVP (sugestão, humano no loop) → só depois, chatbot IA como nó dentro de Flows.

**Fora do roadmap, sem mudança:**
11. Multi-canal FB/Instagram. `departments` como camada completa (fila/SLA/take-over) — condicionado a decisão sua de crescimento, não a necessidade técnica comprovada hoje.
