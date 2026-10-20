# Release candidate 1: safeFetch, ownership guards

Branch `release/rc1-safefetch`. Base `3301c77` (main). **Nada foi publicado**: sem push, PR, deploy, SQL remoto ou migration. A migration 083 não existe.

## 1. Conteúdo (ordem de integração)

| Commit | Frente | Resumo |
|---|---|---|
| `0d6e329` | H1 | token da instância uazapi preso ao `base_url` armazenado (já ancestral de H2 e F4) |
| `7453ff2` | H2 | `safeFetch` + política de IP |
| `adf1180` | H2 | uazapi inteiro via `safeFetch`; `config` rejeita `base_url` proibido |
| `e22c261` | H2 | `paging.next` do sync de templates só no mesmo endpoint Graph |
| `cd3a3d2` | F4 | `send_webhook` via `safeFetch`; ativação exige https |
| `2e4ac13` | F4 | URL colada no cabeçalho de imagem via `safeFetch` (Storage segue direto) |
| `356852c` | merge | merge de `f4/http-sinks` (preserva os hashes de H2/F4) |
| `09f7758` | F4B | testes que fixam a origem de mídia e o `Cache-Control` atual (só testes) |
| `c2cec1a` | F3 | guards de ownership nos engines de automations e flows |
| `767757a` | F3 | proposta de RLS (documento) e teste PGlite que reproduz as lacunas |
| `e3ba163` | F4 | testes de URL malformada/sem host/com credenciais no cabeçalho |

F4A (`f4a/templates-sync-paging`) está **substituído** pelo H2: os 9 testes dele passam contra `assertSameGraphEndpoint`, que é mais estrito (exige o mesmo path). Worktree e arquivos preservados, nada integrado.

## 2. Validação (neste candidato)

- `tsc --noEmit`: limpo.
- ESLint nos arquivos alterados: 0 erros, 5 warnings.
- `npx vitest run` (padrão): 19 arquivos falham, **todos** `Hook timed out in 10000ms` em `*.pglite.test.ts`; 1.841 passam, 293 pulados por causa dos hooks.
- `npx vitest run --hookTimeout=180000 --testTimeout=180000 --maxWorkers=3`: **131 arquivos, 2.134/2.134**, nenhum pulado.
- Sem migrations tocadas, sem `Cache-Control` alterado em código, sem segredos nas linhas adicionadas.

## 3. Segurança: o que está provado e o que não está

| Comportamento | Prova |
|---|---|
| URL proibida (http, porta, IP literal, localhost, userinfo, malformada) não abre conexão | integração: `safeFetch` real sobre dns/https falso |
| Nome que resolve para IP privado/loopback/link-local não envia byte | integração: a lista `sent` fica vazia |
| DNS rebinding revalidado a cada conexão | integração + loopback real (`safe-fetch.test.ts`) |
| Redirect recusado, `Location` nunca resolvido | integração |
| TLS e DNS reais | **não provado** (rede falsa ou loopback) |
| Guards de F3 contra o PostgREST real | **não provado** (unitário com mock; PGlite só cobre o SQL proposto) |

Os `fetch` restantes no servidor têm destino fixo (Graph, Z-API), ou ficam confinados (sync após `assertSameGraphEndpoint`; Storage re-assinado).

## 4. Compatibilidade

**Webhooks ativos: resultado NÃO disponível.** Exige `service_role` no banco remoto e nenhuma credencial foi fornecida a esta execução. A consulta está em `docs/release/rc1-webhook-compat.sql` (somente leitura, mascarada: só esquema/host/porta, nunca path, query, headers ou corpo; testada em PGlite local com dados sintéticos). Precisa de `SELECT` em `automations` e `automation_steps`. Ela não detecta host público que resolve para IP privado nem endpoints com redirect.

Regra de decisão sobre o resultado: 0 linhas = nada a fazer; linhas `not_https`/`port_not_443` = o dono troca a URL para https:443 (ou o endpoint passa a atender nela); `ip_literal`/`internal…`/`userinfo` = dependem de decisão do responsável, não flexibilizar a política.

**Cabeçalho de template (decisão aplicada: manter restritivo).** Só afeta criar/editar template com cabeçalho de **imagem**. Upload pelo Storage: inalterado. Link colado: precisa ser https, porta 443, direto (sem redirect), host público. Vídeo e documento não são baixados pelo servidor. Envio de mensagens e campanhas não mudam.

**Limite de 1 MiB do `safeFetch`:** mantido. O `send_webhook` ignora o corpo, mas uma resposta maior que 1 MiB falha o passo mesmo com 2xx. Reproduzido em teste; sem evidência de webhook real nessa situação. Melhoria posterior possível: opção explícita de descarte de corpo.

## 5. Pendências

| Item | Categoria | Encerramento |
|---|---|---|
| Rodar a consulta de webhooks e decidir sobre as linhas | C (bloqueia o deploy até haver resultado) | saída mascarada revisada |
| RLS do banco não cobre as associações entre contas (contact_tags, deals, conversations, automation_steps): só os caminhos `service_role` têm guard | C (exige uma migration autorizada; ver `docs/security/F3-OWNERSHIP-ISOLATION-PROPOSAL.md`) | decisão sobre a migration 083, fora deste release |
| Limite de 1 MiB no webhook | D | n/a |
| TLS/DNS reais e F3 contra PostgREST real | C | smoke tests abaixo |

## 6. Configuração

Nenhuma nova. `send_webhook` e cabeçalho rodam em runtime Node (nenhuma rota declara edge). `META_APP_ID` continua exigido para cabeçalho de imagem, como antes. Sem migrations.

## 7. Rollout, smoke tests e rollback

Rollout: publicar de uma vez (sem flag), observar o log de automações e erros 400/502 de templates por 24 h.

Smoke tests (staging ou produção, após o deploy):
1. Automação com `send_webhook` para um endpoint https:443 público: log `webhook 200`. Com `http://...` ou IP interno: `webhook destination not allowed`.
2. Template com imagem enviada pelo upload: submit OK. Com link https direto: OK. Com link que redireciona: mensagem "redirects".
3. Instância uazapi existente: enviar mensagem e checar status. `POST /api/whatsapp/config` com `base_url` http: 400.
4. "Sync from Meta" numa conta com mais de 100 templates (paginação).
5. Automação com `add_tag` de tag de outra conta: passo falha com `tag not in account`.
6. `GET /api/whatsapp/media/{id}`: `Cache-Control: public, max-age=86400` como antes.

Rollback: sem migration e sem dados alterados, o rollback é reimplantar a versão anterior do código (main `3301c77` ou o artefato atual de produção). Automações com webhook bloqueado simplesmente voltam a funcionar.

## 8. Ainda exige autorização

Push, PR, merge remoto, deploy, execução da consulta de webhooks no banco remoto e qualquer migration (incluindo a 083).
