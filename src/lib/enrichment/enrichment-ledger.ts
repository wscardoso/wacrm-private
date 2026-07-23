import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { ClaimedRow, EnrichmentLedgerEntry, EnrichmentOutcomeClass } from './types'

export async function enqueuePendingAttributions(): Promise<number> {
  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('enqueue_pending_attributions')
  if (error) {
    console.error('[enrichment-ledger] enqueue failed:', error.message)
    throw error
  }
  return (data as number) ?? 0
}

export async function claimBatch(
  limit: number = 10,
  accountId?: string,
): Promise<ClaimedRow[]> {
  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('claim_enrichment_batch', {
    p_limit: limit,
    p_account_id: accountId ?? null,
  })
  if (error) {
    console.error('[enrichment-ledger] claim failed:', error.message)
    throw error
  }
  return (data as ClaimedRow[]) ?? []
}

export async function resolveSuccess(
  attributionId: string,
  campaignId?: string,
  campaignName?: string,
  adsetId?: string,
  adsetName?: string,
  adId?: string,
  adName?: string,
  placement?: string,
): Promise<void> {
  const admin = supabaseAdmin()
  const { error } = await admin.rpc('resolve_enrichment_success', {
    p_attribution_id: attributionId,
    p_campaign_id: campaignId ?? null,
    p_campaign_name: campaignName ?? null,
    p_adset_id: adsetId ?? null,
    p_adset_name: adsetName ?? null,
    p_ad_id: adId ?? null,
    p_ad_name: adName ?? null,
    p_placement: placement ?? null,
  })
  if (error) {
    console.error('[enrichment-ledger] resolve success failed:', error.message)
    throw error
  }
}

export async function resolveFailure(
  attributionId: string,
  outcomeClass: EnrichmentOutcomeClass,
  errorCode: string,
  attemptCount: number,
): Promise<EnrichmentLedgerEntry> {
  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('resolve_enrichment_failure', {
    p_attribution_id: attributionId,
    p_outcome_class: outcomeClass,
    p_error_code: errorCode,
    p_attempt_count: attemptCount,
  })
  if (error) {
    console.error('[enrichment-ledger] resolve failure failed:', error.message)
    throw error
  }
  return data as unknown as EnrichmentLedgerEntry
}

export async function reclaimStuck(): Promise<number> {
  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('reclaim_stuck_enrichment')
  if (error) {
    console.error('[enrichment-ledger] reclaim failed:', error.message)
    throw error
  }
  return (data as number) ?? 0
}

export async function expireStale(): Promise<number> {
  const admin = supabaseAdmin()
  const { data, error } = await admin.rpc('expire_stale_enrichments')
  if (error) {
    console.error('[enrichment-ledger] expire failed:', error.message)
    throw error
  }
  return (data as number) ?? 0
}
