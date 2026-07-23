import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: vi.fn(),
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(),
}))

import { classifyEnrichmentFailure, computeEnrichmentBackoff } from '@/lib/enrichment/failure-classifier'

describe('classifyEnrichmentFailure — §8 full coverage', () => {
  const cases: Array<{
    name: string
    input: { message: string; httpStatus?: number; errorType?: string }
    expectedOutcome: string
    expectedCode: string
    canRetry: boolean
  }> = [
    { name: 'credential_not_found', input: { message: 'x', errorType: 'credential_not_found' }, expectedOutcome: 'permanent', expectedCode: 'credential_not_found', canRetry: false },
    { name: 'credential_expired', input: { message: 'x', errorType: 'credential_expired' }, expectedOutcome: 'blocked', expectedCode: 'credential_expired', canRetry: false },
    { name: 'credential_revoked', input: { message: 'x', errorType: 'credential_revoked' }, expectedOutcome: 'blocked', expectedCode: 'credential_revoked', canRetry: false },
    { name: 'credential_decrypt_error', input: { message: 'x', errorType: 'credential_decrypt_error' }, expectedOutcome: 'permanent', expectedCode: 'credential_decrypt_error', canRetry: false },
    { name: 'graph 401', input: { message: 'x', httpStatus: 401 }, expectedOutcome: 'permanent', expectedCode: 'graph_api_auth_error', canRetry: false },
    { name: 'graph 403', input: { message: 'x', httpStatus: 403 }, expectedOutcome: 'permanent', expectedCode: 'graph_api_auth_error', canRetry: false },
    { name: 'rate limit 429', input: { message: 'x', httpStatus: 429 }, expectedOutcome: 'transient', expectedCode: 'rate_limited', canRetry: true },
    { name: 'server error 502', input: { message: 'x', httpStatus: 502 }, expectedOutcome: 'transient', expectedCode: 'graph_api_server_error', canRetry: true },
    { name: 'network timeout', input: { message: 'x', errorType: 'timeout' }, expectedOutcome: 'transient', expectedCode: 'network_timeout', canRetry: true },
    { name: 'network_error', input: { message: 'x', errorType: 'network_error' }, expectedOutcome: 'transient', expectedCode: 'network_timeout', canRetry: true },
    { name: '404 not found', input: { message: 'x', httpStatus: 404 }, expectedOutcome: 'permanent', expectedCode: 'object_not_found', canRetry: false },
    { name: '400 bad request', input: { message: 'x', httpStatus: 400 }, expectedOutcome: 'permanent', expectedCode: 'graph_api_client_error', canRetry: false },
    { name: 'unclassified', input: { message: 'x', errorType: 'unknown' }, expectedOutcome: 'transient', expectedCode: 'unclassified', canRetry: true },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const r = classifyEnrichmentFailure(c.input)
      expect(r.outcomeClass).toBe(c.expectedOutcome)
      expect(r.errorCode).toBe(c.expectedCode)
      expect(r.canRetry).toBe(c.canRetry)
    })
  }
})

describe('computeEnrichmentBackoff', () => {
  it('produces increasing backoff', () => {
    const values = Array.from({ length: 6 }, (_, i) => computeEnrichmentBackoff(i))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1])
    }
  })
})
