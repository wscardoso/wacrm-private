import type { ProviderCapabilities, SendOutcomeClass } from '../providers/types'

/**
 * Failure Classifier — ARO-001 §7 ("Componentes previstos" / Failure
 * classifier), ADR-E4B-002 §5 item 3 (árvore de decisão).
 *
 * Pure function of domain: consumes only the `SendOutcomeClass` already
 * emitted by the Provider Adapter (ADR-E4B-003 §3.4) and the
 * `ProviderCapabilities` already declared by the provider (ADR-E4B-003
 * §3.1–§3.3) — never a raw provider error, never provider identity
 * (`provider === 'meta'` etc). This is the same agnosticism `DLB-001`
 * §4.3 requires and `ADR-E4B-003` §3.5 makes structurally enforced.
 *
 * Normative order (ADR-E4B-002 §5 item 3 — mandatory, not incidental):
 * the first branch is *known outcome × ambiguous*. Only over a *known*
 * outcome does transient × permanent apply. This is not "transient vs
 * permanent first" with ambiguous as a third case — ambiguity dominates
 * and is decided before transient/permanent is ever considered.
 *
 * This module only classifies. It does not retry, does not enqueue,
 * does not settle, does not touch the ledger, the scheduler, or TTL —
 * those are later commits (ARO-001 §12–§16).
 */

/**
 * Abstract decision consumed by the delivery layer. Deliberately not a
 * 1:1 mirror of `SendOutcomeClass` — it also folds in the
 * capability-gated policy of `ADR-E4B-002` §5 for the ambiguous case,
 * so callers never re-derive that branch themselves.
 */
export type RetryDecision =
  | 'permanent'
  | 'retryable'
  | 'ambiguous-with-native-idempotency'
  | 'ambiguous-with-reconciliation'
  | 'ambiguous-without-recovery-capability'

/**
 * @param outcome The domain class already emitted by `provider.classifySendFailure()`.
 * @param capabilities The capability contract already declared by the provider.
 */
export function classifyFailure(
  outcome: SendOutcomeClass,
  capabilities: ProviderCapabilities,
): RetryDecision {
  // Step 1 (ADR-E4B-002 §5 item 3): known outcome × ambiguous — first,
  // and decisive. Ambiguity is never re-examined against
  // transient/permanent; it is resolved entirely by capability
  // (ADR-E4B-002 §5, Alternativa E).
  if (outcome === 'ambiguous') {
    if (capabilities.nativeIdempotency) {
      return 'ambiguous-with-native-idempotency'
    }
    if (capabilities.deliveryReconciliation) {
      return 'ambiguous-with-reconciliation'
    }
    return 'ambiguous-without-recovery-capability'
  }

  // Step 2: only reached for a *known* (non-ambiguous) outcome.
  if (outcome === 'deterministic-transient') {
    return 'retryable'
  }

  // outcome === 'deterministic-permanent'
  return 'permanent'
}
