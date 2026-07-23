export type EnrichmentLedgerStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'failed_permanent'
  | 'expired'

export type EnrichmentOutcomeClass =
  | 'permanent'
  | 'transient'
  | 'blocked'

export interface EnrichmentLedgerEntry {
  attribution_id: string
  account_id: string
  status: EnrichmentLedgerStatus
  attempt_count: number
  last_attempt_at: string | null
  last_outcome_class: string | null
  last_error: string | null
  locked_until: string | null
  ttl_expires_at: string
  created_at: string
  updated_at: string
}

export interface ClaimedRow {
  attribution_id: string
  account_id: string
  attempt_count: number
  last_error: string | null
  ad_source_id: string | null
}

export interface EnrichmentResult {
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  adset_name?: string
  ad_id?: string
  ad_name?: string
  placement?: string
}

export interface EnrichmentReport {
  total: number
  pending: number
  claimed: number
  completed: number
  failed_permanent: number
  expired: number
  never_enqueued: number
}

export interface CredentialData {
  ciphertext: string
  status: string
  expires_at: string | null
}

export const ENRICHMENT_TTL_MS = 72 * 60 * 60 * 1000
export const ENRICHMENT_MAX_ATTEMPT_COUNT = 10
export const ENRICHMENT_BACKOFF_BASE_MS = 30_000
export const ENRICHMENT_BACKOFF_MAX_MS = 30 * 60_000
export const ENRICHMENT_BATCH_LIMIT = 10
