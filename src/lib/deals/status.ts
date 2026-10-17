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

export type DealCurrent = { status: DealStatus | null; loss_reason: string | null }

/**
 * Same invariant as `resolveStatusUpdate`, for automations that write one
 * built-in deal column at a time (`update_deal_field`). Returns the extra
 * columns to write alongside the requested one, or throws.
 *
 * - `status` -> not lost: clears the reason.
 * - `status` -> lost: an automation cannot ask a human for a reason, so it
 *   keeps the one already stored and otherwise records `fallbackReason`;
 *   a lost deal is therefore never left without a reason.
 * - `loss_reason`: only meaningful on a deal that is already lost, and must
 *   be a non-empty string within the length limit. Writing it on an open or
 *   won deal is refused instead of leaving a stale reason behind.
 */
export function resolveAutomationDealWrite(
  field: string,
  value: unknown,
  current: DealCurrent | null,
  fallbackReason: string,
): Record<string, unknown> {
  if (field === 'status') {
    if (!isDealStatus(value)) {
      throw new Error(`update_deal_field: invalid deal status "${String(value)}"`)
    }
    if (value !== 'lost') return { loss_reason: null }
    const existing = current?.loss_reason?.trim()
    if (existing) return {}
    return { loss_reason: fallbackReason.trim().slice(0, MAX_LOSS_REASON_LENGTH) }
  }
  if (field === 'loss_reason') {
    if (current?.status !== 'lost') {
      throw new Error('update_deal_field: loss_reason can only be set on a lost deal')
    }
    const check = resolveStatusUpdate('lost', value)
    if (!check.ok) throw new Error(`update_deal_field: ${check.error}`)
    // Normalise (trim) the value that is actually written.
    return { loss_reason: check.update.loss_reason }
  }
  return {}
}
