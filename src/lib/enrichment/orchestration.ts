import { resolveCredential, CredentialResolutionError } from './credential-resolver'
import { classifyEnrichmentFailure, computeEnrichmentBackoff } from './failure-classifier'
import { fetchAdData, GraphApiError } from './graph-api-client'
import { enqueuePendingAttributions, claimBatch, resolveSuccess, resolveFailure, reclaimStuck, expireStale } from './enrichment-ledger'
import { ENRICHMENT_MAX_ATTEMPT_COUNT, ENRICHMENT_TTL_MS, ENRICHMENT_BATCH_LIMIT } from './types'

export interface EnrichmentCycleResult {
  enqueued: number
  claimed: number
  succeeded: number
  failedPermanent: number
  failedTransient: number
  reclaimed: number
  expired: number
  errors: string[]
}

export async function runEnrichmentCycle(
  accountId?: string,
): Promise<EnrichmentCycleResult> {
  const result: EnrichmentCycleResult = {
    enqueued: 0,
    claimed: 0,
    succeeded: 0,
    failedPermanent: 0,
    failedTransient: 0,
    reclaimed: 0,
    expired: 0,
    errors: [],
  }

  try {
    result.reclaimed = await reclaimStuck()
  } catch (err) {
    result.errors.push(`reclaim error: ${(err as Error).message}`)
  }
  try {
    result.expired = await expireStale()
  } catch (err) {
    result.errors.push(`expire error: ${(err as Error).message}`)
  }

  try {
    result.enqueued = await enqueuePendingAttributions()
  } catch (err) {
    result.errors.push(`enqueue error: ${(err as Error).message}`)
    return result
  }

  let batch: Awaited<ReturnType<typeof claimBatch>>
  try {
    batch = await claimBatch(ENRICHMENT_BATCH_LIMIT, accountId)
  } catch (err) {
    result.errors.push(`claim error: ${(err as Error).message}`)
    return result
  }

  result.claimed = batch.length
  if (batch.length === 0) return result

  for (const row of batch) {
    try {
      await enrichSingleRow(row)
      result.succeeded++
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('retry')) {
        result.failedTransient++
      } else {
        result.failedPermanent++
      }
      result.errors.push(`[${row.attribution_id}] ${msg}`)
    }
  }

  return result
}

async function enrichSingleRow(row: {
  attribution_id: string
  account_id: string
  attempt_count: number
  last_error: string | null
  ad_source_id: string | null
}): Promise<void> {
  if (row.attempt_count >= ENRICHMENT_MAX_ATTEMPT_COUNT) {
    await resolveFailure(row.attribution_id, 'permanent', 'max_attempts_exceeded', row.attempt_count + 1)
    throw new Error(`permanent: max_attempts_exceeded`)
  }

  if (!row.ad_source_id) {
    await resolveFailure(row.attribution_id, 'permanent', 'missing_ad_source_id', row.attempt_count + 1)
    throw new Error(`permanent: missing_ad_source_id`)
  }

  let token: string
  try {
    const credential = await resolveCredential(row.account_id)
    token = credential.token
  } catch (err) {
    const errInfo = err instanceof CredentialResolutionError
      ? { message: err.message, errorType: err.code }
      : { message: (err as Error).message, errorType: 'credential_resolution_error' }

    const classification = classifyEnrichmentFailure({
      message: errInfo.message,
      errorType: errInfo.errorType,
    })

    await resolveFailure(
      row.attribution_id,
      classification.outcomeClass,
      classification.errorCode,
      row.attempt_count + 1,
    )

    if (!classification.canRetry) {
      throw new Error(`permanent: ${classification.errorCode}`)
    }
    throw new Error(`retry: ${classification.errorCode}`)
  }

  let enrichmentResult: ReturnType<typeof fetchAdData> extends Promise<infer T> ? T : never
  try {
    enrichmentResult = await fetchAdData(token, row.ad_source_id)
  } catch (err) {
    const graphErr = err as GraphApiError
    const classification = classifyEnrichmentFailure({
      message: graphErr.message,
      httpStatus: graphErr.httpStatus,
      errorType: graphErr.errorType ?? graphErr.name,
    })

    await resolveFailure(
      row.attribution_id,
      classification.outcomeClass,
      classification.errorCode,
      row.attempt_count + 1,
    )

    if (!classification.canRetry) {
      throw new Error(`permanent: ${classification.errorCode}`)
    }
    throw new Error(`retry: ${classification.errorCode}`)
  }

  await resolveSuccess(
    row.attribution_id,
    enrichmentResult.campaign_id,
    enrichmentResult.campaign_name,
    enrichmentResult.adset_id,
    enrichmentResult.adset_name,
    enrichmentResult.ad_id,
    enrichmentResult.ad_name,
    enrichmentResult.placement,
  )
}
