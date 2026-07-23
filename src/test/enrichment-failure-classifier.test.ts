import { describe, it, expect } from 'vitest'
import {
  classifyEnrichmentFailure,
  computeEnrichmentBackoff,
} from '@/lib/enrichment/failure-classifier'
import { ENRICHMENT_BACKOFF_BASE_MS, ENRICHMENT_BACKOFF_MAX_MS } from '@/lib/enrichment/types'

describe('classifyEnrichmentFailure — §8 (fault handling)', () => {
  it('credential_not_found → permanent, no retry', () => {
    const r = classifyEnrichmentFailure({ message: 'not found', errorType: 'credential_not_found' })
    expect(r.outcomeClass).toBe('permanent')
    expect(r.canRetry).toBe(false)
    expect(r.errorCode).toBe('credential_not_found')
  })

  it('credential_expired → blocked, no retry', () => {
    const r = classifyEnrichmentFailure({ message: 'expired', errorType: 'credential_expired' })
    expect(r.outcomeClass).toBe('blocked')
    expect(r.canRetry).toBe(false)
    expect(r.errorCode).toBe('credential_expired')
  })

  it('credential_revoked → blocked, no retry', () => {
    const r = classifyEnrichmentFailure({ message: 'revoked', errorType: 'credential_revoked' })
    expect(r.outcomeClass).toBe('blocked')
    expect(r.canRetry).toBe(false)
  })

  it('401 auth error → permanent, no retry', () => {
    const r = classifyEnrichmentFailure({ message: 'unauthorized', httpStatus: 401 })
    expect(r.outcomeClass).toBe('permanent')
    expect(r.canRetry).toBe(false)
    expect(r.errorCode).toBe('graph_api_auth_error')
  })

  it('403 permission error → permanent, no retry', () => {
    const r = classifyEnrichmentFailure({ message: 'forbidden', httpStatus: 403 })
    expect(r.outcomeClass).toBe('permanent')
    expect(r.canRetry).toBe(false)
  })

  it('429 rate limit → transient, retry', () => {
    const r = classifyEnrichmentFailure({ message: 'rate limited', httpStatus: 429 })
    expect(r.outcomeClass).toBe('transient')
    expect(r.canRetry).toBe(true)
    expect(r.errorCode).toBe('rate_limited')
  })

  it('5xx server error → transient, retry', () => {
    const r = classifyEnrichmentFailure({ message: 'server error', httpStatus: 502 })
    expect(r.outcomeClass).toBe('transient')
    expect(r.canRetry).toBe(true)
    expect(r.errorCode).toBe('graph_api_server_error')
  })

  it('network timeout → transient, retry', () => {
    const r = classifyEnrichmentFailure({ message: 'timeout', errorType: 'timeout' })
    expect(r.outcomeClass).toBe('transient')
    expect(r.canRetry).toBe(true)
    expect(r.errorCode).toBe('network_timeout')
  })

  it('404 object not found → permanent, no retry', () => {
    const r = classifyEnrichmentFailure({ message: 'not found', httpStatus: 404 })
    expect(r.outcomeClass).toBe('permanent')
    expect(r.canRetry).toBe(false)
    expect(r.errorCode).toBe('object_not_found')
  })

  it('4xx other → permanent, no retry', () => {
    const r = classifyEnrichmentFailure({ message: 'bad request', httpStatus: 400 })
    expect(r.outcomeClass).toBe('permanent')
    expect(r.canRetry).toBe(false)
    expect(r.errorCode).toBe('graph_api_client_error')
  })

  it('unclassified error → transient (safe default)', () => {
    const r = classifyEnrichmentFailure({ message: 'weird error', errorType: 'unknown' })
    expect(r.outcomeClass).toBe('transient')
    expect(r.canRetry).toBe(true)
    expect(r.errorCode).toBe('unclassified')
  })
})

describe('computeEnrichmentBackoff', () => {
  it('returns a positive number of milliseconds', () => {
    const backoff = computeEnrichmentBackoff(0)
    expect(backoff).toBeGreaterThanOrEqual(ENRICHMENT_BACKOFF_BASE_MS)
    expect(backoff).toBeLessThanOrEqual(ENRICHMENT_BACKOFF_MAX_MS * 1.2)
  })

  it('increases with attempt count', () => {
    const b1 = computeEnrichmentBackoff(0)
    const b5 = computeEnrichmentBackoff(5)
    expect(b5).toBeGreaterThan(b1)
  })

  it('caps at max step', () => {
    const b10 = computeEnrichmentBackoff(10)
    expect(b10).toBeLessThanOrEqual(ENRICHMENT_BACKOFF_MAX_MS * 1.2)
  })
})
