/**
 * Multi-provider inbound webhook
 * POST /api/whatsapp/webhook/[provider]/[webhookSecret]
 *
 * Z-API:   configure this URL in the Z-API dashboard → Webhook
 * uazapi:  configure this URL in your uazapi instance → Webhook settings
 *
 * [webhookSecret] must match the `verify_token` saved in whatsapp_config
 * (encrypted). This is the access-control mechanism — without the correct
 * secret in the URL, the webhook is rejected with 401.
 */

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { ZApiProvider } from '@/lib/whatsapp/providers/zapi'
import { UazapiProvider } from '@/lib/whatsapp/providers/uazapi'
import { processInboundMessage } from '@/lib/whatsapp/inbound-processor'
import type { WhatsAppProviderKind } from '@/types'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; webhookSecret: string }> },
) {
  const { provider: providerParam, webhookSecret } = await params

  const provider = providerParam as WhatsAppProviderKind
  if (provider !== 'zapi' && provider !== 'uazapi') {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 404 })
  }

  // Look up the whatsapp_config row that matches this webhook secret
  const { data: configs, error: dbError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id, access_token, verify_token, instance_id, base_url, provider')
    .eq('provider', provider)

  if (dbError) {
    console.error('[webhook/provider] DB error:', dbError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  // Find the config whose decrypted verify_token matches the URL secret
  let matchedConfig: (typeof configs)[number] | null = null
  for (const cfg of configs ?? []) {
    if (!cfg.verify_token) continue
    try {
      const decrypted = decrypt(cfg.verify_token)
      if (decrypted === webhookSecret) {
        matchedConfig = cfg
        break
      }
    } catch {
      // Skip configs with unreadable tokens
    }
  }

  if (!matchedConfig) {
    console.warn(`[webhook/${provider}] No config matched secret`)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rawBody = await request.text()
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Build the provider to parse the inbound message
  let parsedMessage
  try {
    if (provider === 'zapi') {
      const accessToken = decrypt(matchedConfig.access_token)
      const p = new ZApiProvider({
        instanceId: matchedConfig.instance_id!,
        token: accessToken,
      })
      parsedMessage = p.parseInboundMessage(payload)
    } else {
      const accessToken = decrypt(matchedConfig.access_token)
      const p = new UazapiProvider({
        baseUrl: matchedConfig.base_url!,
        instanceId: matchedConfig.instance_id!,
        token: accessToken,
      })
      // uazapi may send arrays of messages in one payload.
      // Process each event independently so a failure in one event does
      // not prevent the remaining events from being processed.
      const rawData = (payload as Record<string, unknown>).data
      const events = Array.isArray(rawData) ? (rawData as unknown[]) : [payload]

      for (const event of events) {
        try {
          const msg = p.parseInboundMessage(event)
          if (msg) {
            await processInboundMessage(
              msg,
              matchedConfig.account_id,
              matchedConfig.user_id,
            )
          }
        } catch (err) {
          // Log safely — never include tokens, secrets or the raw payload.
          console.error(`[webhook/${provider}] Failed to process event:`, err instanceof Error ? err.message : 'unknown error')
        }
      }
      return NextResponse.json({ ok: true })
    }
  } catch (err) {
    console.error(`[webhook/${provider}] Parse error:`, err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ error: 'Parse error' }, { status: 500 })
  }

  if (!parsedMessage) {
    // fromMe / status update / unsupported event — acknowledge but don't process
    return NextResponse.json({ ok: true })
  }

  try {
    await processInboundMessage(
      parsedMessage,
      matchedConfig.account_id,
      matchedConfig.user_id,
    )
  } catch (err) {
    console.error(`[webhook/${provider}] Processing error:`, err instanceof Error ? err.message : 'unknown error')
    return NextResponse.json({ error: 'Processing error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
