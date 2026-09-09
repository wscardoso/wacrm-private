import { describe, expect, it } from 'vitest'
import { MetaProvider } from './meta'
import { classifyFailure } from '../delivery/failure-classifier'

// F-INT-01 (E2E validation) — locks in the current, deliberate
// end-to-end behavior of Meta send-failure classification so a future
// change to either classifyMetaSendFailure (meta.ts) or
// MetaProvider.capabilities is a conscious decision, not a silent
// regression discovered in production.
//
// This is NOT a bug fix. The audit's initial read ("everything
// ambiguous never retries") is correct as *observed effect*, but the
// design is intentional: ADR-E4B-002 §2 notes the provider may have
// already accepted/processed a 429/5xx/network-failure attempt before
// the error surfaced, so treating it as 'deterministic-transient' and
// blindly retrying risks sending a duplicate WhatsApp message to a
// real customer — worse than a delayed one. Loosening this without
// first verifying Meta's actual idempotency/reconciliation behavior
// (capabilities.nativeIdempotency / .deliveryReconciliation, both
// honestly declared `false` today because neither has been verified)
// would trade a reliability problem for a correctness one. That
// verification is a dedicated follow-up, not something to guess at
// here — see meta.ts's own capabilities comment.
describe('Meta send-failure classification — current end-to-end behavior', () => {
  const provider = new MetaProvider({
    phoneNumberId: 'pn-1',
    accessToken: 'token',
    verifyToken: 'verify',
  })

  function endToEnd(error: unknown) {
    const outcome = provider.classifySendFailure(error)
    return { outcome, decision: classifyFailure(outcome, provider.capabilities) }
  }

  it.each([400, 401, 403, 404, 422])(
    'Meta API error: %i -> deterministic-permanent -> permanent (never retried, correctly)',
    (status) => {
      const { outcome, decision } = endToEnd(new Error(`Meta API error: ${status}`))
      expect(outcome).toBe('deterministic-permanent')
      expect(decision).toBe('permanent')
    },
  )

  it.each([429, 500, 502, 503, 504])(
    'Meta API error: %i -> ambiguous -> ambiguous-without-recovery-capability (never auto-retried today)',
    (status) => {
      const { outcome, decision } = endToEnd(new Error(`Meta API error: ${status}`))
      expect(outcome).toBe('ambiguous')
      expect(decision).toBe('ambiguous-without-recovery-capability')
    },
  )

  it('a network-level failure (no status recoverable) -> ambiguous -> ambiguous-without-recovery-capability', () => {
    const { outcome, decision } = endToEnd(new TypeError('fetch failed'))
    expect(outcome).toBe('ambiguous')
    expect(decision).toBe('ambiguous-without-recovery-capability')
  })

  it("a local invariant error (e.g. \"returned no message id\") -> ambiguous -> ambiguous-without-recovery-capability", () => {
    const { outcome, decision } = endToEnd(new Error('Meta returned no message id'))
    expect(outcome).toBe('ambiguous')
    expect(decision).toBe('ambiguous-without-recovery-capability')
  })

  it('capabilities are both false today (undeclared/unverified) — the reason every ambiguous outcome dead-ends', () => {
    expect(provider.capabilities).toEqual({
      nativeIdempotency: false,
      deliveryReconciliation: false,
    })
  })
})
