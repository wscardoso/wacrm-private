/**
 * ADR-MSG-STATUS-001 — Canonical message status.
 *
 * D2 — the canonical set is exactly seven states, no others:
 *   {pending, sending, sent, delivered, read, failed, received}
 *
 * `pending` and `received` are the two states ADR-MSG-001 D7 added to the
 * set. They are domain states, not implementation detail — see migration
 * 063, which widened the CHECK on messages.status additively so the domain
 * vocabulary and the storage vocabulary agree.
 *
 * Two axes, deliberately not conflated:
 *   - progress (outbound):  pending < sending < sent < delivered < read
 *   - exception (outbound): failed — off the progress axis (D2, D6/T3)
 *   - inbound:              received — degenerate, no transitions (D6/T6)
 *
 * `replied` is NOT here: it belongs to broadcast_recipients, not to a
 * message lifecycle (D3).
 */

export type CanonicalStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'received'

export const CANONICAL_STATUS_VALUES: readonly CanonicalStatus[] = [
  'pending',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'received',
]

export function isCanonicalStatus(value: unknown): value is CanonicalStatus {
  return (
    typeof value === 'string' &&
    (CANONICAL_STATUS_VALUES as readonly string[]).includes(value)
  )
}

/**
 * D2 — the ordered progress axis. `failed` and `received` are NOT on it.
 * Index is the level; D5 decides admissibility by level and never by
 * event timestamp.
 */
const PROGRESS_AXIS: readonly CanonicalStatus[] = [
  'pending',
  'sending',
  'sent',
  'delivered',
  'read',
]

/** Level on the progress axis, or -1 for states off the axis. */
export function progressLevel(status: CanonicalStatus): number {
  return (PROGRESS_AXIS as readonly string[]).indexOf(status)
}

/**
 * Outcome of evaluating a status event against the current state
 * (D6 matrix).
 *
 *  - 'apply'        — ✅ admissible; the transition is performed.
 *  - 'noop'         — ⭕ regression or repeat. Expected redelivery. NOT a
 *                     signal: it must not be recorded (D8: "⭕ não é sinal
 *                     — é o caso normal de reentrega e não deve poluir o
 *                     registro").
 *  - 'inadmissible' — 🚫 the event contradicts a terminal state, or targets
 *                     an inbound message. Recorded as N2 (D8).
 */
export type TransitionOutcome = 'apply' | 'noop' | 'inadmissible'

/**
 * D6 — transition admissibility. Decided purely by canonical level (D5);
 * the event timestamp never participates.
 *
 * T1 progress: y admissible iff level(y) > level(x). Level SKIPS ARE
 *              ADMISSIBLE — a lost intermediate webhook must not pin the
 *              message at a lower level (A5).
 * T2 regression: level(y) <= level(x) -> noop, silent.
 * T3 exception: -> failed iff current level <= 2 (pending|sending|sent).
 * T4 failed is terminal; any later event is inadmissible (observable).
 * T6 received admits nothing, and is never an event target.
 */
export function evaluateTransition(
  current: CanonicalStatus | null,
  incoming: CanonicalStatus,
): TransitionOutcome {
  // T6 — inbound messages have a degenerate lifecycle. A status event that
  // resolves to one is rejected and recorded, never applied.
  if (current === 'received' || incoming === 'received') return 'inadmissible'

  // No prior state: any outbound state is admissible as the first one.
  if (current === null) return 'apply'

  // T4 — failed is absolutely terminal. A later event means the provider
  // contradicted itself; that is signal, not routine redelivery.
  if (current === 'failed') return 'inadmissible'

  if (incoming === 'failed') {
    // T3 — admissible only before delivery is established.
    const level = progressLevel(current)
    return level >= 0 && level <= progressLevel('sent') ? 'apply' : 'inadmissible'
  }

  const currentLevel = progressLevel(current)
  const incomingLevel = progressLevel(incoming)

  // Unknown current state (e.g. legacy row outside the canonical set):
  // treat conservatively as inadmissible rather than guessing.
  if (currentLevel < 0 || incomingLevel < 0) return 'inadmissible'

  // T1 / T2
  return incomingLevel > currentLevel ? 'apply' : 'noop'
}

/**
 * D8 — the three classes of event that do NOT transition and MUST produce
 * an observable record. All three are "not applied"; none of them means
 * "apply". (⭕ noop is deliberately absent: it is the normal redelivery
 * case and must stay out of the record.)
 *
 *  N1 — uncorrelated: the value resolves to no message in the connection.
 *  N2 — inadmissible: resolves, but 🚫 on the D6 matrix.
 *  N3 — unknown: a provider status value outside the declared map (D9).
 */
export type StatusEventSignal = 'N1' | 'N2' | 'N3'

export interface CanonicalStatusEvent {
  /** Provider-level identifier referenced by the status event. */
  externalId: string
  status: CanonicalStatus
  /** Instant of the event, normalised to ms-epoch string by the adapter (D9). */
  timestamp: string
}
