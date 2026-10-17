import type { DealStatus } from '@/types'

/** Client helper for POST /api/deals/status. Returns an error message or null. */
export async function setDealStatus(
  dealId: string,
  status: DealStatus,
  lossReason?: string,
): Promise<string | null> {
  try {
    const res = await fetch('/api/deals/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId, status, lossReason }),
    })
    if (res.ok) return null
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    return json.error ?? 'Failed to update deal status'
  } catch {
    return 'Network error while updating deal status'
  }
}
