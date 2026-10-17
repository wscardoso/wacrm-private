import { describe, expect, it } from 'vitest'
import { MAX_LOSS_REASON_LENGTH, resolveStatusUpdate } from './status'

describe('resolveStatusUpdate', () => {
  it('lost requires a reason and trims it', () => {
    expect(resolveStatusUpdate('lost', '  Preço alto  ')).toEqual({
      ok: true,
      update: { status: 'lost', loss_reason: 'Preço alto' },
    })
  })

  it.each([undefined, null, '', '   ', 42])('rejects lost with reason %p', (reason) => {
    expect(resolveStatusUpdate('lost', reason).ok).toBe(false)
  })

  it('rejects a reason over the maximum length, accepts exactly the maximum', () => {
    expect(resolveStatusUpdate('lost', 'x'.repeat(MAX_LOSS_REASON_LENGTH + 1)).ok).toBe(false)
    expect(resolveStatusUpdate('lost', 'x'.repeat(MAX_LOSS_REASON_LENGTH)).ok).toBe(true)
  })

  it.each(['open', 'won'] as const)('%s always clears the reason', (status) => {
    expect(resolveStatusUpdate(status, 'stale reason')).toEqual({
      ok: true,
      update: { status, loss_reason: null },
    })
  })

  it.each([undefined, null, 'closed', 'LOST', 1, {}])('rejects invalid status %p', (status) => {
    expect(resolveStatusUpdate(status, 'x').ok).toBe(false)
  })
})
