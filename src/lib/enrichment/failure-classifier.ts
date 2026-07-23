import { ENRICHMENT_BACKOFF_BASE_MS, ENRICHMENT_BACKOFF_MAX_MS } from './types'
import type { EnrichmentOutcomeClass } from './types'

export interface EnrichmentError {
  message: string
  httpStatus?: number
  errorType?: string
}

export type ClassificationResult = {
  outcomeClass: EnrichmentOutcomeClass
  errorCode: string
  canRetry: boolean
}

const ERROR_CODE_MAP: Array<{
  test: (err: EnrichmentError) => boolean
  outcomeClass: EnrichmentOutcomeClass
  errorCode: string
}> = [
  {
    test: (e) => e.errorType === 'credential_not_found',
    outcomeClass: 'permanent',
    errorCode: 'credential_not_found',
  },
  {
    test: (e) => e.errorType === 'credential_expired',
    outcomeClass: 'blocked',
    errorCode: 'credential_expired',
  },
  {
    test: (e) => e.errorType === 'credential_revoked',
    outcomeClass: 'blocked',
    errorCode: 'credential_revoked',
  },
  {
    test: (e) => e.errorType === 'credential_decrypt_error',
    outcomeClass: 'permanent',
    errorCode: 'credential_decrypt_error',
  },
  {
    test: (e) => e.httpStatus === 401 || e.httpStatus === 403,
    outcomeClass: 'permanent',
    errorCode: 'graph_api_auth_error',
  },
  {
    test: (e) => e.httpStatus === 429,
    outcomeClass: 'transient',
    errorCode: 'rate_limited',
  },
  {
    test: (e) => e.httpStatus !== undefined && e.httpStatus >= 500,
    outcomeClass: 'transient',
    errorCode: 'graph_api_server_error',
  },
  {
    test: (e) => e.errorType === 'network_error' || e.errorType === 'timeout',
    outcomeClass: 'transient',
    errorCode: 'network_timeout',
  },
  {
    test: (e) => e.httpStatus === 404,
    outcomeClass: 'permanent',
    errorCode: 'object_not_found',
  },
  {
    test: (e) => e.httpStatus !== undefined && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 404 && e.httpStatus !== 429,
    outcomeClass: 'permanent',
    errorCode: 'graph_api_client_error',
  },
]

export function classifyEnrichmentFailure(
  error: EnrichmentError,
): ClassificationResult {
  for (const rule of ERROR_CODE_MAP) {
    if (rule.test(error)) {
      return {
        outcomeClass: rule.outcomeClass,
        errorCode: rule.errorCode,
        canRetry: rule.outcomeClass === 'transient',
      }
    }
  }
  return {
    outcomeClass: 'transient',
    errorCode: 'unclassified',
    canRetry: true,
  }
}

export function computeEnrichmentBackoff(attemptCount: number): number {
  const exponential = ENRICHMENT_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attemptCount))
  const capped = Math.min(exponential, ENRICHMENT_BACKOFF_MAX_MS)
  const jitter = capped * 0.2 * Math.random()
  return Math.round(capped + jitter)
}
