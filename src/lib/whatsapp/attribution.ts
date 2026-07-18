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

  // Idempotent insert via RPC. supabase-js upsert with ignoreDuplicates
  // emits ON CONFLICT (origin_message_id) WITHOUT the partial-index
  // predicate, which fails against the partial unique index (error
  // 42P10). The RPC insert_lead_attribution supplies the WHERE clause
  // explicitly and returns the new row id, or NULL when this exact
  // origin_message_id was already processed (redelivery).
  const { data: insertedId, error: insertError } = await supabase.rpc(
    'insert_lead_attribution',
    {
      p_account_id: payload.account_id,
      p_contact_id: payload.contact_id,
      p_conversation_id: payload.conversation_id,
      p_source_channel: payload.source_channel,
      p_origin_message_id: payload.origin_message_id,
      p_ad_source_id: payload.ad_source_id,
      p_ad_source_type: payload.ad_source_type,
      p_ad_source_url: payload.ad_source_url,
      p_ad_headline: payload.ad_headline,
      p_ad_body: payload.ad_body,
      p_ad_media_type: payload.ad_media_type,
      p_ad_media_url: payload.ad_media_url,
      p_ctwa_clid: payload.ctwa_clid,
      p_fbclid: payload.fbclid,
      p_gclid: payload.gclid,
      p_utm: payload.utm,
      p_campaign_id: payload.campaign_id,
      p_campaign_name: payload.campaign_name,
      p_adset_id: payload.adset_id,
      p_adset_name: payload.adset_name,
      p_ad_id: payload.ad_id,
      p_ad_name: payload.ad_name,
      p_placement: payload.placement,
      p_raw: payload.raw,
    },
  )

  if (insertError) {
    console.error('[attribution] insert failed:', insertError.message)
    return { attribution: null, firstTouchWritten: false }
  }

  if (insertedId) {
    // New row created. Re-fetch the full row to return it.
    const { data: created, error: fetchError } = await supabase
      .from('lead_attributions')
      .select('*')
      .eq('id', insertedId)
      .maybeSingle()
    if (fetchError) {
      console.error('[attribution] fetch after insert failed:', fetchError.message)
      return { attribution: null, firstTouchWritten: false }
    }
    attribution = created
  } else {
    // Conflict hit — this exact message (by wamid) was already
    // processed by an earlier delivery. Re-fetch the existing row so
    // every downstream write below (conversation pointer, first-touch)
    // is itself idempotent, keeping this call's result consistent
    // regardless of which delivery "won".
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
