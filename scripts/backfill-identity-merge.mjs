#!/usr/bin/env node
// =============================================================
// scripts/backfill-identity-merge.mjs
//
// Runner controlado do backfill de grupos de identidade — HOTFIX-001
// Fase E.3. Unidade de trabalho é UM grupo de merge ativo
// ((account_id, phone_identity) com >= 2 contatos) — nunca uma linha,
// nunca uma conta inteira (E.1).
//
// Progresso vive inteiramente em identity_merge_backfill_checkpoint
// (071), não em memória: matar e reiniciar o runner a qualquer momento
// retoma exatamente de onde parou (E.3.6). 'done' nunca é retocado;
// 'in_progress' órfãos são devolvidos ao pool pelo reclaim de leases
// (E.3.2) depois de LEASE_TIMEOUT_SECONDS; 'pending'/'failed' nunca se
// perdem.
//
// Algoritmo por passada (E.3.3–E.3.5):
//   1. Descoberta — INSERT dos grupos ativos da conta (E.3.1).
//   2. Reclaim de leases expirados (E.3.2).
//   3. Claim de batch com FOR UPDATE SKIP LOCKED + backoff (E.3.3).
//   4. Para cada grupo: dimensiona, deriva statement_timeout por
//      chamada, invoca merge_identity_group() sob SET LOCAL
//      statement_timeout na MESMA transação (E.3.4–E.3.5). Nunca
//      divide um grupo em múltiplas transações (§9.2).
//   5. Marca 'done' (com merge_run_id) ou 'failed' (attempts += 1,
//      last_error). Grupos acima do hard_ceiling viram
//      'exceeds_single_transaction_ceiling' — janela de manutenção.
//
// O runner checa a flag de rollout (072) a cada claim de batch (F.6):
// conta com identity_merge_v2_state = 'off' é pulada.
//
// Pré-requisitos:
//   - .env.local com NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//     (para a flag) e DATABASE_URL (conexão direta Postgres — pooler de
//     transação do Supabase), que precisa ter acesso a
//     merge_identity_group() (service_role).
//
// Uso:
//   node scripts/backfill-identity-merge.mjs <account_id> [<account_id> ...]
//   node scripts/backfill-identity-merge.mjs --all
//
// Variáveis de ambiente (todas opcionais):
//   LEASE_TIMEOUT_SECONDS   default 300
//   BATCH_SIZE              default 50
//   BACKFILL_BASE_TIMEOUT_MS    default 5000
//   BACKFILL_TIMEOUT_COEF_MS    default 2   (ms por linha estimada)
//   BACKFILL_HARD_CEILING_MS    default 120000
//   MAX_ATTEMPTS            default 5
// =============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_PATH = path.resolve(__dirname, '..', '.env.local')

const DEFAULTS = {
  LEASE_TIMEOUT_SECONDS: 300,
  BATCH_SIZE: 50,
  BACKFILL_BASE_TIMEOUT_MS: 5000,
  BACKFILL_TIMEOUT_COEF_MS: 2,
  BACKFILL_HARD_CEILING_MS: 120000,
  MAX_ATTEMPTS: 5,
}

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) return
  const text = fs.readFileSync(ENV_PATH, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

function intEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`${name} inválido: "${raw}" (esperado inteiro >= 1)`)
  }
  return Math.floor(n)
}

function status(msg) {
  process.stderr.write(`[backfill] ${msg}\n`)
}

function fail(msg) {
  process.stderr.write(`[backfill] ABORT: ${msg}\n`)
  process.exit(1)
}

async function accountFlagOff(sb, accountId) {
  const { data, error } = await sb
    .from('accounts')
    .select('identity_merge_v2_state')
    .eq('id', accountId)
    .maybeSingle()
  if (error) throw new Error(`falha ao ler flag da conta ${accountId}: ${error.message}`)
  if (!data) {
    status(`conta ${accountId} não encontrada — ignorada`)
    return true
  }
  if (data.identity_merge_v2_state === 'off') {
    status(`conta ${accountId} em Estado 0 (flag off) — backfill pulado (F.6)`)
    return true
  }
  return false
}

// ---- E.3.1: descoberta dos grupos ativos da conta ----
async function discoverGroups(client, accountId) {
  const result = await client.query(
    `
    INSERT INTO identity_merge_backfill_checkpoint (account_id, phone_identity)
    SELECT account_id, phone_identity
    FROM contacts
    WHERE account_id = $1 AND phone_identity <> ''
    GROUP BY account_id, phone_identity
    HAVING count(*) > 1
    ON CONFLICT (account_id, phone_identity) DO NOTHING
    `,
    [accountId],
  )
  if (result.rowCount > 0) status(`conta ${accountId}: ${result.rowCount} novo(s) grupo(s) descoberto(s)`)
}

// ---- E.3.2: reclaim de leases expirados ----
async function reclaimExpiredLeases(client, leaseTimeoutSeconds) {
  const result = await client.query(
    `
    UPDATE identity_merge_backfill_checkpoint
    SET status = 'pending', claimed_at = NULL
    WHERE status = 'in_progress'
      AND claimed_at < NOW() - (interval '1 second' * $1)
    `,
    [leaseTimeoutSeconds],
  )
  if (result.rowCount > 0) status(`${result.rowCount} lease(s) expirado(s) devolvido(s) a 'pending'`)
}

// ---- E.3.3: claim de batch (FOR UPDATE SKIP LOCKED + backoff) ----
// backoff_delay(attempts) = LEAST(2^attempts * 10s, 300s) — um grupo que
// acabou de falhar não é reclamado de imediato por um ciclo vizinho.
async function claimBatch(client, accountId, batchSize, maxAttempts) {
  const result = await client.query(
    `
    UPDATE identity_merge_backfill_checkpoint
    SET status = 'in_progress', claimed_at = NOW(), updated_at = NOW()
    WHERE id IN (
      SELECT id
        FROM identity_merge_backfill_checkpoint
       WHERE account_id = $1
         AND status IN ('pending', 'failed')
         AND attempts < $3
         AND updated_at < NOW() - CASE
               WHEN attempts = 0 THEN interval '0 seconds'
               ELSE LEAST(
                 power(2, attempts) * interval '10 seconds',
                 interval '300 seconds'
               )
             END
       ORDER BY updated_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
    )
    RETURNING *
    `,
    [accountId, batchSize, maxAttempts],
  )
  return result.rows
}

// ---- E.3.4: dimensiona o grupo (mensagens + reações + conversas) ----
async function sizeGroup(client, accountId, phoneIdentity) {
  const result = await client.query(
    `
    WITH grp AS (
      SELECT id FROM contacts WHERE account_id = $1 AND phone_identity = $2
    ),
    conv AS (
      SELECT c.id FROM conversations c JOIN grp g ON c.contact_id = g.id WHERE c.account_id = $1
    )
    SELECT
      (SELECT count(*) FROM grp)   AS contacts,
      (SELECT count(*) FROM conv)  AS conversations,
      (SELECT count(*) FROM messages m JOIN conv ON m.conversation_id = conv.id) AS messages,
      (SELECT count(*) FROM message_reactions r JOIN conv ON r.conversation_id = conv.id) AS reactions
    `,
    [accountId, phoneIdentity],
  )
  const row = result.rows[0]
  return (Number(row.messages) || 0) + (Number(row.reactions) || 0) + (Number(row.conversations) || 0)
}

// ---- E.3.5: timeout dinâmico por tamanho estimado de grupo ----
function deriveTimeout(estimatedRows, cfg) {
  const estimatedMs = cfg.coef * estimatedRows
  if (estimatedMs > cfg.hardCeiling) {
    return { timeoutMs: null, exceedsCeiling: true }
  }
  const timeoutMs = Math.min(Math.max(cfg.base, estimatedMs), cfg.hardCeiling)
  return { timeoutMs, exceedsCeiling: false }
}

// ---- E.3.4: invoca a RPC sob SET LOCAL statement_timeout na MESMA transação ----
async function runMerge(client, accountId, phoneIdentity, timeoutMs) {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`)
    const result = await client.query(
      'SELECT * FROM merge_identity_group($1, $2)',
      [accountId, phoneIdentity],
    )
    await client.query('COMMIT')
    return result.rows[0]
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }
}

async function markDone(client, id, mergeRunId) {
  await client.query(
    `UPDATE identity_merge_backfill_checkpoint
        SET status = 'done', merge_run_id = $2, last_error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [id, mergeRunId],
  )
}

async function markFailed(client, id, attempts, errorMessage) {
  await client.query(
    `UPDATE identity_merge_backfill_checkpoint
        SET status = 'failed', attempts = $2, last_error = $3, updated_at = NOW()
      WHERE id = $1`,
    [id, attempts, errorMessage],
  )
}

async function markCeilingExceeded(client, id, maxAttempts) {
  // E.3.5: excluído do backfill de rotina sem contar como falha comum —
  // attempts vai ao teto (fora do claim de rotina, attempts < max)
  // apenas como marcador de exclusão; last_error distinto sinaliza a
  // fila da janela de manutenção. Um operador reseta manualmente após
  // rodar o mesmo merge com hard_ceiling maior aceito (E.3.5).
  await client.query(
    `UPDATE identity_merge_backfill_checkpoint
        SET status = 'failed',
            attempts = $2,
            last_error = 'exceeds_single_transaction_ceiling',
            updated_at = NOW()
      WHERE id = $1`,
    [id, maxAttempts],
  )
}

async function processAccount(client, sb, accountId, cfg) {
  if (await accountFlagOff(sb, accountId)) return

  await discoverGroups(client, accountId)
  await reclaimExpiredLeases(client, cfg.leaseTimeoutSeconds)

  let loop = true
  while (loop) {
    // Flag rechecada a cada claim de batch (F.6).
    if (await accountFlagOff(sb, accountId)) return

    const batch = await claimBatch(client, accountId, cfg.batchSize, cfg.maxAttempts)
    if (batch.length === 0) break

    for (const group of batch) {
      status(
        `grupo ${accountId} ${group.phone_identity} (${group.attempts} tentativa(s), ${group.status})`,
      )

      try {
        const estimatedRows = await sizeGroup(client, accountId, group.phone_identity)
        const { timeoutMs, exceedsCeiling } = deriveTimeout(estimatedRows, cfg)

        if (exceedsCeiling) {
          status(
            `  estimado ${estimatedRows} linhas excede hard_ceiling — janela de manutenção (E.3.5)`,
          )
          await markCeilingExceeded(client, group.id, cfg.maxAttempts)
          continue
        }

        const summary = await runMerge(client, accountId, group.phone_identity, timeoutMs)
        await markDone(client, group.id, summary?.merge_run_id ?? null)
        status(
          `  OK run=${summary?.merge_run_id ?? 'n/a'} convs=${summary?.conversations_merged ?? 0} ` +
            `msgs=${summary?.messages_collapsed ?? 0} reações=${summary?.reactions_collapsed ?? 0} ` +
            `attr=${summary?.attributions_repointed ?? 0} flows=${summary?.flow_runs_superseded ?? 0} ` +
            `t=${timeoutMs}ms`,
        )
      } catch (err) {
        const attempts = group.attempts + 1
        await markFailed(client, group.id, attempts, (err?.message ?? String(err)).slice(0, 2000))
        status(`  FALHA (${attempts}/${cfg.maxAttempts}): ${err?.message ?? err}`)
      }
    }
  }

  // E.3.7: conclusão da conta.
  const remaining = await client.query(
    `SELECT count(*) FILTER (WHERE status = 'failed') AS failed,
            count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'in_progress') AS in_progress
       FROM identity_merge_backfill_checkpoint
      WHERE account_id = $1 AND attempts < $2`,
    [accountId, cfg.maxAttempts],
  )
  const r = remaining.rows[0]
  status(
    `conta ${accountId} concluída — failed=${r.failed} pending=${r.pending} in_progress=${r.in_progress} ` +
      `(sinal de F.5: failed deve ser 0 no caminho feliz)`,
  )
}

async function main() {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const databaseUrl = process.env.DATABASE_URL
  if (!url || !serviceKey) fail('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios')
  if (!databaseUrl) fail('DATABASE_URL (conexão direta Postgres) obrigatório')

  const args = process.argv.slice(2)
  const allAccounts = args.includes('--all')
  const accountIds = args.filter((a) => a !== '--all')
  if (!allAccounts && accountIds.length === 0) {
    fail('informe ao menos um account_id, ou use --all para processar contas com flag on')
  }

  const cfg = {
    leaseTimeoutSeconds: intEnv('LEASE_TIMEOUT_SECONDS', DEFAULTS.LEASE_TIMEOUT_SECONDS),
    batchSize: intEnv('BATCH_SIZE', DEFAULTS.BATCH_SIZE),
    base: intEnv('BACKFILL_BASE_TIMEOUT_MS', DEFAULTS.BACKFILL_BASE_TIMEOUT_MS),
    coef: intEnv('BACKFILL_TIMEOUT_COEF_MS', DEFAULTS.BACKFILL_TIMEOUT_COEF_MS),
    hardCeiling: intEnv('BACKFILL_HARD_CEILING_MS', DEFAULTS.BACKFILL_HARD_CEILING_MS),
    maxAttempts: intEnv('MAX_ATTEMPTS', DEFAULTS.MAX_ATTEMPTS),
  }

  const sb = createClient(url, serviceKey)
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  status(`lease=${cfg.leaseTimeoutSeconds}s batch=${cfg.batchSize} base=${cfg.base}ms coef=${cfg.coef}ms/linha ceiling=${cfg.hardCeiling}ms max=${cfg.maxAttempts}`)

  try {
    if (allAccounts) {
      const { data: flagged, error: listErr } = await sb
        .from('accounts')
        .select('id')
        .neq('identity_merge_v2_state', 'off')
      if (listErr) throw new Error(`falha ao listar contas: ${listErr.message}`)
      if (!flagged) throw new Error('falha ao listar contas: resposta vazia')
      for (const acc of flagged) {
        await processAccount(client, sb, acc.id, cfg)
      }
    } else {
      for (const id of accountIds) {
        await processAccount(client, sb, id, cfg)
      }
    }
  } finally {
    await client.end()
  }
  status('backfill concluído')
}

main().catch((err) => {
  process.stderr.write(`[backfill] ERRO FATAL: ${err?.stack ?? err}\n`)
  process.exit(1)
})
