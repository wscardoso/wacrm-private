import { describe, expect, it } from 'vitest'
import {
  computeBackoff,
  isExpired,
  nextAttemptOrExpire,
  decideRetryOutcome,
  DEFAULT_BACKOFF_CONFIG,
  DEFAULT_TTL_MS,
  MAX_ATTEMPT_COUNT,
} from './retry-policy'

// Commit 6.1 correção #7 — cobertura obrigatória de "Retry flow":
// transient → retry ledger (reschedule); permanent → settlement
// (settle-failed); ambiguous sem capability → bloqueio seguro
// (blocked, nunca reschedule às cegas). decideRetryOutcome é a
// política pura reusada tanto por sender.ts (primeiro enqueue) quanto
// pelo scheduler (cron/route.ts) — testá-la aqui cobre o gate de
// capability sem precisar mockar Supabase.

describe('decideRetryOutcome', () => {
  const CREATED_AT = new Date('2026-01-01T00:00:00.000Z')
  const NOW = new Date('2026-01-01T00:01:00.000Z') // 1 min depois — bem dentro do TTL

  it('permanent → settle-failed regardless of attempt count', () => {
    const action = decideRetryOutcome('permanent', 0, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, NOW)
    expect(action.kind).toBe('settle-failed')
  })

  it('retryable (deterministic-transient) → reschedule with incremented attempt count', () => {
    const action = decideRetryOutcome('retryable', 2, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, NOW)
    expect(action.kind).toBe('reschedule')
    if (action.kind === 'reschedule') {
      expect(action.attemptCount).toBe(3)
      expect(action.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime())
    }
  })

  it('ambiguous-with-native-idempotency → reschedule (safe to resend)', () => {
    const action = decideRetryOutcome('ambiguous-with-native-idempotency', 0, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, NOW)
    expect(action.kind).toBe('reschedule')
  })

  it('ambiguous-with-reconciliation → reschedule (reconcile-then-resend)', () => {
    const action = decideRetryOutcome('ambiguous-with-reconciliation', 0, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, NOW)
    expect(action.kind).toBe('reschedule')
  })

  it('ambiguous-without-recovery-capability → blocked, never rescheduled blindly (ADR-E4B-002 §5 caminho D)', () => {
    const action = decideRetryOutcome('ambiguous-without-recovery-capability', 4, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, NOW)
    expect(action.kind).toBe('blocked')
    if (action.kind === 'blocked') {
      expect(action.attemptCount).toBe(5)
    }
  })

  it('respects TTL — expired even though decision would otherwise reschedule', () => {
    const wayLater = new Date(CREATED_AT.getTime() + DEFAULT_TTL_MS + 1000)
    const action = decideRetryOutcome('retryable', 1, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, wayLater)
    expect(action.kind).toBe('settle-failed')
  })

  it('respects max attempt count — settle-failed once the ceiling is reached', () => {
    const action = decideRetryOutcome('retryable', MAX_ATTEMPT_COUNT - 1, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, NOW)
    expect(action.kind).toBe('settle-failed')
  })

  it('max attempt count is checked before the blocked branch would matter — but blocked never consults the ceiling (ADR-E4B-002 path D is capability-gated, not attempt-gated)', () => {
    // Even at/above the ceiling, an ambiguous-without-recovery-capability
    // outcome still reports 'blocked', not 'settle-failed' — the ceiling
    // is a property of the reschedule branch, not of the capability gate.
    // (Documents current behavior; TTL sweep is what eventually resolves
    // blocked entries, per ARO-001 §16.)
    const action = decideRetryOutcome('ambiguous-without-recovery-capability', MAX_ATTEMPT_COUNT + 3, CREATED_AT, DEFAULT_TTL_MS, MAX_ATTEMPT_COUNT, DEFAULT_BACKOFF_CONFIG, NOW)
    expect(action.kind).toBe('blocked')
  })
})

describe('computeBackoff / isExpired / nextAttemptOrExpire (regression — unchanged by Commit 6.1)', () => {
  it('computeBackoff grows with attempt count and respects the step cap', () => {
    const first = computeBackoff(0, DEFAULT_BACKOFF_CONFIG)
    const later = computeBackoff(10, DEFAULT_BACKOFF_CONFIG)
    expect(first).toBeGreaterThanOrEqual(DEFAULT_BACKOFF_CONFIG.baseMs)
    expect(later).toBeLessThanOrEqual(DEFAULT_BACKOFF_CONFIG.maxStepMs * (1 + DEFAULT_BACKOFF_CONFIG.jitterRatio))
  })

  it('isExpired is a pure age check', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    expect(isExpired(createdAt, 1000, new Date('2026-01-01T00:00:00.500Z'))).toBe(false)
    expect(isExpired(createdAt, 1000, new Date('2026-01-01T00:00:01.500Z'))).toBe(true)
  })

  it('nextAttemptOrExpire never schedules past the TTL horizon', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const ttlMs = 60_000
    const now = new Date('2026-01-01T00:00:59.000Z') // 1s left before TTL
    const decision = nextAttemptOrExpire(5, createdAt, ttlMs, DEFAULT_BACKOFF_CONFIG, now)
    expect(decision.kind).toBe('expired')
  })
})
