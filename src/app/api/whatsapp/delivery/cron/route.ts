import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getProvider, type WhatsAppProvider } from '@/lib/whatsapp/providers'
import type { SendResult } from '@/lib/whatsapp/providers/types'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { settleMessageSystem, type SettlementResult } from '@/lib/whatsapp/delivery/settlement'
import { classifyFailure } from '@/lib/whatsapp/delivery/failure-classifier'
import { nextAttemptOrExpire, DEFAULT_BACKOFF_CONFIG, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT } from '@/lib/whatsapp/delivery/retry-policy'

const BATCH_LIMIT = 50

/**
 * ARO-001 §12 — Drain due outbound retry ledger entries.
 *
 * Auth: `AUTOMATION_CRON_SECRET` + `x-cron-secret` (timingSafeEqual,
 * same pattern as flows/cron). Service-role throughout.
 *
 * Flow per entry:
 *   1. Claim-as-lock (status pending → retrying)
 *   2. Reconstruct message, contact, provider
 *   3. Call provider.send
 *   4. settleMessageSystem + update ledger (delivered / dead / re-enqueue)
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const { data: due, error } = await admin
    .from('outbound_retry_ledger')
    .select('id, message_id, attempt_count, classification, created_at')
    .eq('status', 'pending')
    .not('next_attempt_at', 'is', null)
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    console.error('[delivery-cron] select due failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!due || due.length === 0) return NextResponse.json({ processed: 0, dead: 0 })

  let processed = 0
  let dead = 0

  for (const row of due) {
    try {
      const result = await processDueEntry(admin, row)
      if (result === 'processed') processed++
      if (result === 'dead') dead++
    } catch (err) {
      console.error('[delivery-cron] entry %s fatal:', row.id, err instanceof Error ? err.message : err)
      await admin
        .from('outbound_retry_ledger')
        .update({ status: 'dead', last_error: 'scheduler fatal error' })
        .eq('id', row.id)
        .eq('status', 'retrying')
      dead++
    }
  }

  return NextResponse.json({ processed, dead })
}

type DrainResult = 'processed' | 'dead' | 'skipped'

async function processDueEntry(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string; message_id: string; attempt_count: number; classification: string; created_at: string },
): Promise<DrainResult> {
  // ── 1. Claim-as-lock ───────────────────────────────────────
  const { data: claim } = await admin
    .from('outbound_retry_ledger')
    .update({ status: 'retrying' })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()
  if (!claim) return 'skipped'

  // ── 2. Load message + conversation + contact + provider config ──
  const { data: msg, error: msgErr } = await admin
    .from('messages')
    .select('id, conversation_id, content_type, content_text, media_url, template_name, reply_to_message_id, connection_ref, created_at')
    .eq('id', row.message_id)
    .single()

  if (msgErr || !msg) {
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: `message not found: ${msgErr?.message ?? 'unknown'}` })
      .eq('id', row.id)
    return 'dead'
  }

  const { data: conv } = await admin
    .from('conversations')
    .select('contact:contacts(phone)')
    .eq('id', msg.conversation_id)
    .single()

  const phone = (conv as { contact: { phone: string } | null } | null)?.contact?.phone
  if (!phone) {
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: 'contact phone not found' })
      .eq('id', row.id)
    return 'dead'
  }
  const to = sanitizePhoneForMeta(phone)

  const connectionRef = msg.connection_ref as string
  const { data: wc, error: wcErr } = await admin
    .from('whatsapp_config')
    .select('*')
    .eq('id', connectionRef)
    .maybeSingle()

  if (wcErr || !wc) {
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: `provider config not found: ${wcErr?.message ?? 'unknown'}` })
      .eq('id', row.id)
    return 'dead'
  }

  const accessToken = decrypt(wc.access_token)
  let clientToken: string | undefined
  if (wc.provider === 'zapi' && wc.waba_id) {
    try { clientToken = decrypt(wc.waba_id) } catch { /* ignore */ }
  }

  const provider: WhatsAppProvider = getProvider(
    wc.provider === 'zapi'
      ? { provider: 'zapi', instanceId: wc.instance_id, accessToken, clientToken }
      : wc.provider === 'uazapi'
        ? { provider: 'uazapi', baseUrl: wc.base_url, instanceId: wc.instance_id, accessToken }
        : { provider: 'meta', phoneNumberId: wc.phone_number_id, accessToken, verifyToken: '' },
  )

  // ── 3. Resolve context (reply-to) ──────────────────────────
  const replyToId = msg.reply_to_message_id
  let contextMessageId: string | undefined
  if (replyToId) {
    const { data: parent } = await admin
      .from('messages')
      .select('message_id')
      .eq('id', replyToId)
      .maybeSingle()
    if (parent?.message_id) contextMessageId = parent.message_id
  }

  // ── 4. Re-execute delivery ─────────────────────────────────
  const msgId = msg.id
  const contentType = msg.content_type
  let sendResult: SendResult
  try {
    if (contentType === 'text') {
      sendResult = await provider.sendText({ to, text: msg.content_text ?? '', contextMessageId })
    } else if (['image', 'video', 'document', 'audio'].includes(contentType)) {
      sendResult = await provider.sendMedia({
        to,
        kind: contentType as 'image' | 'video' | 'document' | 'audio',
        link: msg.media_url ?? '',
        caption: msg.content_text ?? undefined,
        contextMessageId,
      })
    } else if (contentType === 'template') {
      sendResult = await provider.sendTemplate({
        to,
        templateName: msg.template_name ?? '',
        contextMessageId,
      })
    } else {
      await admin
        .from('outbound_retry_ledger')
        .update({ status: 'dead', last_error: `unsupported content_type: ${contentType}` })
        .eq('id', row.id)
      return 'dead'
    }
  } catch (sendErr) {
    return handleRetryFailure(admin, row, provider, sendErr, msgId, connectionRef)
  }

  // ── 5. Success — settle via system facade ──────────────────
  let settlement: SettlementResult
  try {
    settlement = await settleMessageSystem(
      admin, msgId, 'sent', connectionRef,
      sendResult.externalIdentities, sendResult.messageId,
    )
  } catch (settleErr) {
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: `settle failed: ${settleErr instanceof Error ? settleErr.message : String(settleErr)}` })
      .eq('id', row.id)
    return 'dead'
  }

  const ledgerStatus = settlement.outcome === 'sent' || settlement.outcome === 'noop' ? 'delivered' : 'dead'
  await admin.from('outbound_retry_ledger').update({ status: ledgerStatus }).eq('id', row.id)

  return ledgerStatus === 'delivered' ? 'processed' : 'dead'
}

async function handleRetryFailure(
  admin: ReturnType<typeof supabaseAdmin>,
  row: { id: string; message_id: string; attempt_count: number; classification: string; created_at: string },
  provider: WhatsAppProvider,
  error: unknown,
  msgId: string,
  connectionRef: string,
): Promise<DrainResult> {
  const outcome = provider.classifySendFailure(error)
  const decision = classifyFailure(outcome, provider.capabilities)
  const lastError = error instanceof Error ? error.message : String(error)

  if (decision === 'permanent') {
    await settleMessageSystem(admin, msgId, 'failed', connectionRef, [])
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: lastError })
      .eq('id', row.id)
    return 'dead'
  }

  const nextAttempt = nextAttemptOrExpire(
    row.attempt_count + 1,
    new Date(row.created_at),
    DEFAULT_TTL_MS,
    DEFAULT_BACKOFF_CONFIG,
  )

  if (nextAttempt.kind === 'expired') {
    await settleMessageSystem(admin, msgId, 'failed', connectionRef, [])
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: `${lastError} (TTL expired)` })
      .eq('id', row.id)
    return 'dead'
  }

  const attemptCount = row.attempt_count + 1
  if (attemptCount >= MAX_ATTEMPT_COUNT) {
    await settleMessageSystem(admin, msgId, 'failed', connectionRef, [])
    await admin
      .from('outbound_retry_ledger')
      .update({ status: 'dead', last_error: `${lastError} (max attempts ${MAX_ATTEMPT_COUNT})` })
      .eq('id', row.id)
    return 'dead'
  }

  await admin
    .from('outbound_retry_ledger')
    .update({
      status: 'pending',
      attempt_count: attemptCount,
      next_attempt_at: nextAttempt.nextAttemptAt.toISOString(),
      last_error: lastError,
    })
    .eq('id', row.id)

  return 'processed'
}
