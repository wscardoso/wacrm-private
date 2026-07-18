#!/usr/bin/env node
// =============================================================
// scripts/bootstrap-zapi-webhook.mjs
//
// ONE-OFF OPERATIONAL MIGRATION TOOL for ADR-SEC-001 (C7).
//
// This is NOT a public endpoint, NOT a permanent route, and NOT part of the
// web app. It is a throwaway CLI run locally by an operator AFTER the
// 6b4bb73 deploy is live, to install the new webhook credential on the
// single existing Z-API connection.
//
// What it does:
//   1. Loads .env.local (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
//   2. Locates EXACTLY ONE connection where provider='zapi' AND status='connected'.
//      - zero or >1 eligible rows  -> ABORT, no secret generated.
//   3. Uses the existing connection_id (backfilled by migration 036). Never
//      regenerates the public identifier.
//   4. REFUSES if webhook_secret_hash is already populated (no rotation, no
//      forceRotate, no rotation flags accepted by this tool).
//   5. Generates a high-entropy secret, persists ONLY its SHA-256 hash.
//   6. Prints the secret + new URL ONCE in a clearly-marked sensitive block.
//
// Fail-closed: any failure in identification, validation, or persistence
// aborts BEFORE the secret is revealed. The plaintext secret is never
// written to a file, the database, a migration, or any log line.
//
// Run order (operational):
//   deploy 6b4bb73 -> run this -> copy URL -> paste into Z-API dashboard
//   -> test inbound -> test redelivery/idempotency -> confirm old URL rejected.
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
    // Strip surrounding single/double quotes if present.
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
  // Normal progress output only — NEVER includes the secret.
  process.stderr.write(`[bootstrap] ${msg}\n`)
}

function fail(msg) {
  process.stderr.write(`[bootstrap] ABORT: ${msg}\n`)
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
    .select('id, connection_id, provider, status, webhook_secret_hash')
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
    fail('Eligible connection has no connection_id (migration 036 backfill missing?). Nothing generated.')
  }
  if (conn.webhook_secret_hash) {
    fail('webhook_secret_hash already populated for this connection. Refusing to overwrite (no rotation). Nothing generated.')
  }

  const secret = generateWebhookSecret()
  const hash = hashWebhookSecret(secret)

  status('Persisting SHA-256 hash only (plaintext is never stored)...')
  const { error: updateError } = await supabase
    .from('whatsapp_config')
    .update({ webhook_secret_hash: hash })
    .eq('id', conn.id)

  if (updateError) fail(`Failed to persist hash: ${updateError.message}. Secret was NOT revealed.`)

  // Everything succeeded — reveal exactly once, clearly marked sensitive.
  const host = process.env.BOOTSTRAP_PUBLIC_BASE_URL || '<YOUR_DEPLOYED_HOST>'
  const webhookUrl = `${host}/api/whatsapp/webhook/zapi/${conn.connection_id}/${secret}`

  process.stdout.write('\n')
  process.stdout.write('============================================================\n')
  process.stdout.write('  SENSITIVE — copy now, never log or persist this block.\n')
  process.stdout.write('============================================================\n')
  process.stdout.write(`  WEBHOOK_SECRET: ${secret}\n`)
  process.stdout.write(`  WEBHOOK_URL:    ${webhookUrl}\n`)
  process.stdout.write('============================================================\n')
  process.stdout.write('  Next steps:\n')
  process.stdout.write('    1. Paste WEBHOOK_URL into the Z-API dashboard webhook field.\n')
  process.stdout.write('    2. Send a test message; confirm 200 + inbound processing.\n')
  process.stdout.write('    3. Re-send same payload; confirm C4 idempotency (dedupe).\n')
  process.stdout.write('    4. Confirm the OLD webhook URL is rejected (401).\n')
  process.stdout.write('============================================================\n\n')
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
})
