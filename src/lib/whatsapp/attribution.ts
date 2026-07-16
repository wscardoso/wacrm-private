/**
 * Click-to-WhatsApp (CTWA) lead attribution — Fonte A (native Meta
 * `referral`). See ADR-ATTR-001 for the full design.
 *
 * This module is deliberately split in two:
 *   - `captureReferral()` is a pure function: referral in, canonical
 *     insert payload out (or null). No I/O, fully unit-testable.
 *   - `persistAttribution()` does the actual writes (idempotent
 *     upsert into `lead_attributions`, plus the `conversations` /
 *     `contacts` pointer updates) and is exercised via the webhook
 *     integration tests.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadAttribution, LeadAttributionSourceChannel, Referral } from '@/types'

export interface CaptureReferralInput {
  accountId: string
  contactId: string
  conversationId: string
  /**
   * wamid of the inbound message carrying the referral. This — not
   * `ctwa_clid` — is the idempotency key: Meta doesn't guarantee a
   * click id on every referral shape, and a NULL `ctwa_clid` would
   * never collide with itself on a unique index, letting a replayed
   * webhook insert a duplicate row.
   */
  messageId: string
  referral: Referral | null | undefined
}

/**
 * Canonical insert payload for `lead_attributions`, derived from a
 * Meta `referral` object. Returns null when there's nothing to
 * capture (no referral on this message — the overwhelming majority
 * of inbound messages, which are replies in an existing thread, not
 * CTWA opens).
 *
 * A referral without `ctwa_clid` is still captured — Meta doesn't
 * guarantee the click id on every referral shape (e.g. some post-type
 * referrals), and partial attribution (headline/body/creative) is
 * still more useful than nothing.
 */
export function captureReferral(
  input: CaptureReferralInput,
): Omit<LeadAttribution, 'id' | 'created_at'> | null {
  const { referral } = input
  if (!referral) return null

  // A referral object with no identifying fields at all isn't worth
  // persisting — treat it the same as "no referral".
  const hasSignal =
    referral.source_id ||
    referral.ctwa_clid ||
    referral.headline ||
    referral.body ||
    referral.source_url
  if (!hasSignal) return null

  const source_channel: LeadAttributionSourceChannel = 'ctwa_meta'

  const mediaUrl = referral.image_url || referral.video_url || referral.thumbnail_url || null

  return {
    account_id: input.accountId,
    contact_id: input.contactId,
    conversation_id: input.conversationId,
    source_channel,
    origin_message_id: input.messageId,
    ad_source_id: referral.source_id ?? null,
    ad_source_type: referral.source_type ?? null,
    ad_source_url: referral.source_url ?? null,
    ad_headline: referral.headline ?? null,
    ad_body: referral.body ?? null,
    ad_media_type: referral.media_type ?? null,
    ad_media_url: mediaUrl,
    ctwa_clid: referral.ctwa_clid ?? null,
    fbclid: null,
    gclid: null,
    utm: null,
    campaign_id: null,
    campaign_name: null,
    adset_id: null,
    adset_name: null,
    ad_id: null,
    ad_name: null,
    placement: null,
    enriched_at: null,
    raw: referral,
  }
}

export interface PersistAttributionResult {
  attribution: LeadAttribution | null
  /** True when this call set contacts.first_attribution_id (i.e. it
   *  was NULL before this write). False if it was already set, or if
   *  nothing was persisted. */
  firstTouchWritten: boolean
}

/**
 * Persist a captured referral: insert into `lead_attributions`
 * (idempotent on `origin_message_id` — `ON CONFLICT ... DO NOTHING`,
 * via the unique index from migration 033), point
 * `conversations.attribution_id` at it, and — only if not already
 * set — stamp `contacts.first_attribution_id` / `first_source_channel`.
 *
 * Additive and best-effort by design (ADR-ATTR-001 D5): any failure
 * here must never block the inbound message from being stored. The
 * caller is expected to log and swallow errors, same as the other
 * best-effort webhook side-effects (flagBroadcastReplyIfAny, etc).
 */
export async function persistAttribution(
  supabase: SupabaseClient,
  input: CaptureReferralInput,
): Promise<PersistAttributionResult> {
  const payload = captureReferral(input)
  if (!payload) return { attribution: null, firstTouchWritten: false }

  let attribution: LeadAttribution | null = null

  // ON CONFLICT (origin_message_id) DO NOTHING. supabase-js expresses
  // this as an upsert with ignoreDuplicates: true — on a replayed
  // webhook (same wamid), the conflicting row is left untouched and
  // .select() returns no rows for it, rather than erroring or
  // silently overwriting.
  const { data: upserted, error: upsertError } = await supabase
    .from('lead_attributions')
    .upsert(payload, { onConflict: 'origin_message_id', ignoreDuplicates: true })
    .select()
    .maybeSingle()

  if (upsertError) {
    console.error('[attribution] insert failed:', upsertError.message)
    return { attribution: null, firstTouchWritten: false }
  }

  if (upserted) {
    attribution = upserted
  } else {
    // Conflict hit — this exact message (by wamid) was already
    // processed by an earlier delivery. Re-fetch the row that
    // delivery created instead of treating this as "nothing to do":
    // every downstream write below (conversation pointer, first-touch)
    // is itself idempotent, so replaying them is harmless and keeps
    // this call's result consistent regardless of which delivery
    // "won".
    const { data: existing, error: fetchError } = await supabase
      .from('lead_attributions')
      .select('*')
      .eq('origin_message_id', payload.origin_message_id)
      .maybeSingle()
    if (fetchError) {
      console.error('[attribution] re-fetch after conflict failed:', fetchError.message)
      return { attribution: null, firstTouchWritten: false }
    }
    attribution = existing
  }

  if (!attribution) return { attribution: null, firstTouchWritten: false }

  // Point the conversation at the (most recent) attribution.
  const { error: convError } = await supabase
    .from('conversations')
    .update({ attribution_id: attribution.id })
    .eq('id', input.conversationId)
  if (convError) {
    console.error('[attribution] conversation update failed:', convError.message)
  }

  // First-touch: only write if not already set. Read-then-write, not
  // atomic, but the caller only runs this on a contact's first-ever
  // inbound message, so the race window (two simultaneous first
  // messages for the same brand-new contact) is negligible and the
  // worst case is a harmless overwrite with equally-valid data.
  const { data: contactRow, error: contactFetchError } = await supabase
    .from('contacts')
    .select('first_attribution_id')
    .eq('id', input.contactId)
    .maybeSingle()

  let firstTouchWritten = false
  if (contactFetchError) {
    console.error('[attribution] contact fetch failed:', contactFetchError.message)
  } else if (contactRow && !contactRow.first_attribution_id) {
    const { error: contactUpdateError } = await supabase
      .from('contacts')
      .update({
        first_attribution_id: attribution.id,
        first_source_channel: attribution.source_channel,
      })
      .eq('id', input.contactId)
      .is('first_attribution_id', null) // belt-and-braces against the race above
    if (contactUpdateError) {
      console.error('[attribution] contact first-touch update failed:', contactUpdateError.message)
    } else {
      firstTouchWritten = true
    }
  }

  return { attribution, firstTouchWritten }
}
