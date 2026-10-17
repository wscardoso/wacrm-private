import type { DealStatus } from '@/types'

export const MAX_LOSS_REASON_LENGTH = 500

const VALID_STATUSES: readonly DealStatus[] = ['open', 'won', 'lost']

export function isDealStatus(v: unknown): v is DealStatus {
  return typeof v === 'string' && (VALID_STATUSES as readonly string[]).includes(v)
}

export type StatusUpdate = { status: DealStatus; loss_reason: string | null }

export type StatusResolution =
  | { ok: true; update: StatusUpdate }
  | { ok: false; error: string }

/**
 * Single rule for a deal's status/loss_reason pair, shared by the API route
 * and the UI: `lost` is a special state (not a pipeline stage) that REQUIRES
 * a non-empty reason; `open` and `won` always clear it, so a stale reason can
 * never survive a reopen or a win.
 */
export function resolveStatusUpdate(status: unknown, lossReason: unknown): StatusResolution {
  if (!isDealStatus(status)) {
    return { ok: false, error: 'Invalid status' }
  }
  if (status !== 'lost') {
    return { ok: true, update: { status, loss_reason: null } }
  }
  const reason = typeof lossReason === 'string' ? lossReason.trim() : ''
  if (!reason) {
    return { ok: false, error: 'A loss reason is required to mark a deal as lost' }
  }
  if (reason.length > MAX_LOSS_REASON_LENGTH) {
    return {
      ok: false,
      error: `Loss reason must be at most ${MAX_LOSS_REASON_LENGTH} characters`,
    }
  }
  return { ok: true, update: { status, loss_reason: reason } }
}
