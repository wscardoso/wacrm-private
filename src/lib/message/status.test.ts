import { describe, it, expect } from 'vitest'
import {
  CANONICAL_STATUS_VALUES,
  evaluateTransition,
  isCanonicalStatus,
  progressLevel,
  type CanonicalStatus,
} from './status'

// ADR-MSG-STATUS-001 — the D6 matrix is the normative artefact. It is
// transcribed literally below so that a future edit contradicting the
// contract fails here rather than in production.

describe('D2 — canonical set', () => {
  it('is exactly the seven states, no others', () => {
    expect([...CANONICAL_STATUS_VALUES].sort()).toEqual(
      ['delivered', 'failed', 'pending', 'read', 'received', 'sending', 'sent'].sort(),
    )
  })

  it('includes pending and received — the two states ADR-MSG-001 D7 added', () => {
    expect(CANONICAL_STATUS_VALUES).toContain('pending')
    expect(CANONICAL_STATUS_VALUES).toContain('received')
  })

  it('does not include replied — that belongs to broadcast_recipients (D3)', () => {
    expect(CANONICAL_STATUS_VALUES as readonly string[]).not.toContain('replied')
  })

  it('rejects non-canonical values', () => {
    expect(isCanonicalStatus('replied')).toBe(false)
    expect(isCanonicalStatus('PLAYED')).toBe(false)
    expect(isCanonicalStatus(undefined)).toBe(false)
  })
})

describe('D2 — progress axis ordering', () => {
  it('orders pending < sending < sent < delivered < read', () => {
    const axis: CanonicalStatus[] = ['pending', 'sending', 'sent', 'delivered', 'read']
    expect(axis.map(progressLevel)).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps failed and received off the axis', () => {
    expect(progressLevel('failed')).toBe(-1)
    expect(progressLevel('received')).toBe(-1)
  })
})

// a = apply (✅) · n = noop (⭕) · x = inadmissible (🚫)
const MATRIX: Record<string, Record<string, 'a' | 'n' | 'x'>> = {
  pending:   { sending: 'a', sent: 'a', delivered: 'a', read: 'a', failed: 'a' },
  sending:   { sending: 'n', sent: 'a', delivered: 'a', read: 'a', failed: 'a' },
  sent:      { sending: 'n', sent: 'n', delivered: 'a', read: 'a', failed: 'a' },
  delivered: { sending: 'n', sent: 'n', delivered: 'n', read: 'a', failed: 'x' },
  read:      { sending: 'n', sent: 'n', delivered: 'n', read: 'n', failed: 'x' },
  failed:    { sending: 'x', sent: 'x', delivered: 'x', read: 'x', failed: 'x' },
  received:  { sending: 'x', sent: 'x', delivered: 'x', read: 'x', failed: 'x' },
}

const EXPECTED = { a: 'apply', n: 'noop', x: 'inadmissible' } as const

describe('D6 — full transition matrix', () => {
  for (const [current, row] of Object.entries(MATRIX)) {
    for (const [incoming, cell] of Object.entries(row)) {
      it(`${current} + ${incoming} -> ${EXPECTED[cell]}`, () => {
        expect(
          evaluateTransition(current as CanonicalStatus, incoming as CanonicalStatus),
        ).toBe(EXPECTED[cell])
      })
    }
  }
})

describe('T1 — level skips are admissible', () => {
  // A5: forbidding skips pins the message forever whenever an
  // intermediate webhook is lost, which is routine.
  it('applies read directly onto sending', () => {
    expect(evaluateTransition('sending', 'read')).toBe('apply')
  })

  it('applies delivered directly onto pending', () => {
    expect(evaluateTransition('pending', 'delivered')).toBe('apply')
  })

  it('applies read onto sent without delivered ever arriving', () => {
    expect(evaluateTransition('sent', 'read')).toBe('apply')
  })
})

describe('T2 — out-of-order events never regress', () => {
  it('delivered arriving after read is a silent noop', () => {
    expect(evaluateTransition('read', 'delivered')).toBe('noop')
  })

  it('sent arriving after delivered is a silent noop', () => {
    expect(evaluateTransition('delivered', 'sent')).toBe('noop')
  })

  it('noop is not a signal — it is distinct from inadmissible', () => {
    // D8: ⭕ must not pollute the record; only 🚫 is recorded as N2.
    expect(evaluateTransition('read', 'delivered')).not.toBe('inadmissible')
  })
})

describe('duplicate delivery (I1)', () => {
  it('re-applying the same status is a noop at every progress level', () => {
    for (const s of ['sending', 'sent', 'delivered', 'read'] as CanonicalStatus[]) {
      expect(evaluateTransition(s, s)).toBe('noop')
    }
  })

  it('a repeated failed event does not re-apply', () => {
    expect(evaluateTransition('failed', 'failed')).toBe('inadmissible')
  })
})

describe('T3/T4 — failed', () => {
  it('is admissible from pending, sending and sent', () => {
    for (const s of ['pending', 'sending', 'sent'] as CanonicalStatus[]) {
      expect(evaluateTransition(s, 'failed')).toBe('apply')
    }
  })

  it('is refused once delivery is established', () => {
    expect(evaluateTransition('delivered', 'failed')).toBe('inadmissible')
    expect(evaluateTransition('read', 'failed')).toBe('inadmissible')
  })

  it('closes D-B: failed on a message in sending is applied, not dropped', () => {
    // The pre-E2.1 ladder refused this because `sending` was absent from
    // it, leaving E4a-settled messages unable to ever reach failed.
    expect(evaluateTransition('sending', 'failed')).toBe('apply')
  })

  it('is terminal — no later event transitions it', () => {
    for (const s of ['sending', 'sent', 'delivered', 'read'] as CanonicalStatus[]) {
      expect(evaluateTransition('failed', s)).toBe('inadmissible')
    }
  })
})

describe('T6 — inbound messages', () => {
  it('never accept a status event', () => {
    for (const s of ['sending', 'sent', 'delivered', 'read', 'failed'] as CanonicalStatus[]) {
      expect(evaluateTransition('received', s)).toBe('inadmissible')
    }
  })

  it('are never the target of a status event either', () => {
    expect(evaluateTransition('sent', 'received')).toBe('inadmissible')
  })
})

describe('first event / unknown current state', () => {
  it('accepts any outbound status when there is no prior state', () => {
    expect(evaluateTransition(null, 'delivered')).toBe('apply')
  })

  it('refuses to guess from a state outside the canonical set', () => {
    expect(evaluateTransition('replied' as CanonicalStatus, 'read')).toBe('inadmissible')
  })
})
