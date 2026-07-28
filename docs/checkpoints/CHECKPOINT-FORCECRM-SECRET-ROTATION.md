# CHECKPOINT-FORCECRM-SECRET-ROTATION

## Rotação de Webhook Secret — Z-API (C7)

**Data:** 2026-07-28
**Operador:** CLI executor (service role)
**Commit (rotação DB, operação sem commit de código próprio):** N/A — a rotação em si é uma
mutação de banco, não um commit. O estado do código no momento equivale ao squash final
`702aa11` (ver seção 6).

---

## 1. Motivo da Rotação

O webhook secret anterior foi exposto em commits históricos do repositório (`34ae1da`, `fdd6e1d`, ambos locais e nunca pushados). A credencial foi invalidada operacionalmente (rotação Z-API + novo hash no Supabase) **e** o histórico Git local foi reescrito para remover o plaintext dos objetos — `34ae1da`, `fdd6e1d` e o commit intermediário `9116ebc` não existem mais no repositório (confirmado via `git cat-file -e`, ausentes). Os commits equivalentes, com conteúdo idêntico e secret redigido, foram squashados em `702aa11`, já pushado para `origin/main`.

---

## 2. Secret Anterior Invalidado

- **Secret:** `<REDACTED — invalidado durante rotação, ver hash abaixo>`
- **Hash SHA-256 anterior:** `ef9a52641bba68c1c9c2637dad30da8e168f77556d3603dbaa8fe43bbafd45cf`
- **Status:** Revogado — não aceito por autenticação HMAC

---

## 3. Bootstrap Executado

- **Script:** `scripts/rotate-zapi-webhook.mjs` (one-off, operacional)
- **Connection ID:** `a3f7e05a-59f4-4727-b1b1-9843cfed4181`
- **Account ID:** `eefd83ef-b6b2-49a4-af4d-71fd21a95dcb`
- **Workspace:** Atomo Soluções
- **Timestamp da rotação:** `2026-07-28T05:06:39.044Z`
- **Novo hash SHA-256 persistido:** `eb1272ef4e1ffef196b985be2f50571c6909e326bd365dc35c9bb43572392278`

O secret foi gerado via `crypto.randomBytes(32).toString('base64url')`. Apenas o hash SHA-256 foi persistido em `whatsapp_config.webhook_secret_hash`. O plaintext foi exibido uma única vez na saída padrão do script e nunca foi registrado em arquivo, banco ou log.

---

## 4. Validações Realizadas

| Validação | Resultado |
|---|---|
| Hash persistido no Supabase | ✅ Confirmado (`whatsapp_config` retornou hash esperado) |
| Hash corresponde ao gerado | ✅ Match exato |
| Conexão Z-API permanece `connected` | ✅ `status = connected` |
| Secret anterior não foi preservado | ✅ Hash anterior substituído |
| Nenhuma alteração de schema/código | ✅ Zero arquivos de código alterados |
| Nenhuma migration executada | ✅ N/A |

---

## 5. Status

**ROTATION COMPLETE**

### Pendente (operacional — executar manualmente)

- [ ] Configurar novo `WEBHOOK_URL` no painel Z-API
- [ ] Enviar mensagem de teste; confirmar 200 + inbound processing
- [ ] Confirmar que URL antiga retorna 401
- [ ] Confirmar descriptografia do token de acesso permanece íntegra
