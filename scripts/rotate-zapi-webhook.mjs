#!/usr/bin/env node
// =============================================================
// scripts/rotate-zapi-webhook.mjs
//
// ONE-OFF OPERATIONAL ROTATION TOOL for ADR-SEC-001 (C7).
//
// This is NOT a public endpoint, NOT a permanent route, and NOT part of the
// web app. It is a throwaway CLI run by an operator to rotate the webhook
// secret on an EXISTING Z-API connection that already has a hash populated.
//
// What it does:
//   1. Loads .env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
//   2. Locates EXACTLY ONE connection where provider='zapi' AND status='connected'.
//      - zero or >1 eligible rows -> ABORT, no secret generated.
//   3. Generates a new high-entropy secret, persists its SHA-256 hash OVERWRITING
//      the previous hash.
//   4. Prints the new secret + URL ONCE in a clearly-marked sensitive block.
//   5. Prints a rotation timestamp for the evidence document.
//
// Prerequisites:
//   - Old secret already revoked/rotated on Z-API dashboard.
//   - .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
//
// Run order (operational):
//   1. Revoke old secret on Z-API dashboard.
//   2. Run this script -> copy new secret + URL.
//   3. Paste new WEBHOOK_URL into Z-API dashboard.
//   4. Send a test message; confirm 200 + inbound processing.
//   5. Confirm old webhook URL is rejected (401).
// =============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_PATH = path.resolve(__dirname, '..', '.env.local')

function loadEnvLocal() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error('.env.local not found (expected at project root)')
  }
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

function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('base64url')
}

function hashWebhookSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

function status(msg) {
  process.stderr.write(`[rotate] ${msg}\n`)
}

function fail(msg) {
  process.stderr.write(`[rotate] ABORT: ${msg}\n`)
  process.exit(1)
}

async function main() {
  loadEnvLocal()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    fail('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing from .env.local')
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  status('Locating eligible Z-API connections (provider=zapi AND status=connected)...')
  const { data: rows, error } = await supabase
    .from('whatsapp_config')
    .select('id, account_id, connection_id, provider, status, webhook_secret_hash')
    .eq('provider', 'zapi')
    .eq('status', 'connected')

  if (error) fail(`DB lookup failed: ${error.message}`)
  if (!rows || rows.length === 0) {
    fail('No eligible Z-API connection found (provider=zapi AND status=connected). Nothing generated.')
  }
  if (rows.length > 1) {
    fail(`Found ${rows.length} eligible Z-API connections; expected exactly one. Refusing to guess. Nothing generated.`)
  }

  const conn = rows[0]
  if (!conn.connection_id) {
    fail('Eligible connection has no connection_id. Nothing generated.')
  }
  if (!conn.webhook_secret_hash) {
    status(`Connection ${conn.connection_id} (account: ${conn.account_id}) has empty webhook_secret_hash.`)
    status('Proceeding with first-time secret generation (no prior hash to rotate).')
  } else {
    status(`Previous hash: ${conn.webhook_secret_hash}`)
  }

  status(`Connection: ${conn.connection_id}`)
  status(`Previous hash: ${conn.webhook_secret_hash}`)
  status('Generating new secret and hash...')

  const secret = generateWebhookSecret()
  const newHash = hashWebhookSecret(secret)
  const rotationTimestamp = new Date().toISOString()

  status(`Persisting new SHA-256 hash (rotation at ${rotationTimestamp})...`)
  const { error: updateError } = await supabase
    .from('whatsapp_config')
    .update({ webhook_secret_hash: newHash })
    .eq('id', conn.id)

  if (updateError) {
    fail(`Failed to persist new hash: ${updateError.message}. Secret was NOT revealed.`)
  }

  // Confirm the update was applied
  const { data: confirm } = await supabase
    .from('whatsapp_config')
    .select('webhook_secret_hash')
    .eq('id', conn.id)
    .single()

  if (!confirm || confirm.webhook_secret_hash !== newHash) {
    fail('Hash verification failed after update. Secret was NOT revealed.')
  }

  // Everything succeeded — reveal exactly once.
  const host = process.env.BOOTSTRAP_PUBLIC_BASE_URL || '<YOUR_DEPLOYED_HOST>'
  const webhookUrl = `${host}/api/whatsapp/webhook/zapi/${conn.connection_id}/${secret}`

  process.stdout.write('\n')
  process.stdout.write('============================================================\n')
  process.stdout.write('  SENSITIVE — copy now, never log or persist this block.\n')
  process.stdout.write('============================================================\n')
  process.stdout.write(`  ROTATION TIMESTAMP: ${rotationTimestamp}\n`)
  process.stdout.write(`  CONNECTION_ID:      ${conn.connection_id}\n`)
  process.stdout.write(`  WEBHOOK_SECRET:     ${secret}\n`)
  process.stdout.write(`  WEBHOOK_URL:        ${webhookUrl}\n`)
  process.stdout.write(`  NEW HASH:           ${newHash}\n`)
  process.stdout.write('============================================================\n')
  process.stdout.write('  Next steps:\n')
  process.stdout.write('    1. Paste WEBHOOK_URL into Z-API dashboard webhook field.\n')
  process.stdout.write('    2. Send a test message; confirm 200 + inbound processing.\n')
  process.stdout.write('    3. Confirm OLD webhook URL is rejected (401).\n')
  process.stdout.write('============================================================\n\n')

  status(`Rotation complete at ${rotationTimestamp}. Hash updated for connection ${conn.connection_id}.`)
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
})
