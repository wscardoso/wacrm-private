import { renewInboundTurnLease, type ClaimedInboundTurn } from '@/lib/agent/turn/substrate'

/** Lease requested on claim and on each renewal (088: clamped to 30..3600 s). */
export const INBOUND_TURN_LEASE_SECONDS = 300

export interface InboundTurnLease {
  /** false once a renewal was refused or failed: the turn is no longer ours. */
  isHeld(): boolean
}

/**
 * Runs `work` while renewing the claim's lease every third of its duration.
 * A refused or failed renewal marks the lease lost; the caller must then not
 * complete the job (088 rejects it anyway) and must not treat the turn as its own.
 * Long-running work should check `lease.isHeld()` between side effects.
 */
export async function runWithInboundTurnLease<T>(
  job: ClaimedInboundTurn,
  work: (lease: InboundTurnLease) => Promise<T>,
  lockSeconds = INBOUND_TURN_LEASE_SECONDS,
): Promise<{ result: T; leaseHeld: boolean }> {
  let held = true
  let renewing = false
  const lease: InboundTurnLease = { isHeld: () => held }

  const timer = setInterval(() => {
    if (!held || renewing) return
    renewing = true
    renewInboundTurnLease({ messageId: job.messageId, claimToken: job.claimToken, lockSeconds })
      .then((ok) => {
        if (!ok) held = false
      })
      .catch((err) => {
        held = false
        console.error('[inbound-turn] lease renewal failed:', job.messageId, err)
      })
      .finally(() => {
        renewing = false
      })
  }, Math.max(1, Math.floor(lockSeconds / 3)) * 1000)
  timer.unref?.()

  try {
    const result = await work(lease)
    return { result, leaseHeld: held }
  } finally {
    clearInterval(timer)
  }
}
