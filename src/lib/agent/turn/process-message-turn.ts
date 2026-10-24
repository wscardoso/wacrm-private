import { claimInboundTurnForMessage } from '@/lib/agent/turn/substrate'
import { INBOUND_TURN_LEASE_SECONDS, runWithInboundTurnLease } from '@/lib/agent/turn/lease'
import { recordInboundTurnFailure, recordInboundTurnSuccess } from '@/lib/agent/turn/finish'
import { runInboundDownstreamForMessage } from '@/lib/whatsapp/inbound-downstream'

/**
 * Claim, run downstream for one persisted message, complete the turn job.
 *
 * true   - the turn ran and its completion was recorded
 * false  - nothing to do or ownership lost: no claim, lease lost mid-turn, or the
 *          completion was refused (the job is reclaimed and retried by the drain)
 * throws - the claim RPC failed; or the downstream threw (the original error,
 *          after the failed attempt was reported, even if that report failed);
 *          or the downstream succeeded but its completion could not be recorded
 *          (that error; the job stays under its lease for the 088 reclaim).
 */
export async function processInboundTurnForMessage(messageId: string): Promise<boolean> {
  const job = await claimInboundTurnForMessage(messageId, INBOUND_TURN_LEASE_SECONDS)
  if (!job) return false

  let turn: { leaseHeld: boolean }
  try {
    turn = await runWithInboundTurnLease(job, () => runInboundDownstreamForMessage(messageId))
  } catch (err) {
    await recordInboundTurnFailure(job, err)
    throw err
  }

  if (!turn.leaseHeld) {
    // Ownership lost mid-turn: the job is reclaimed and retried under a new token.
    console.warn('[inbound-turn] lease lost before completion:', messageId)
    return false
  }

  const report = await recordInboundTurnSuccess(job)
  if (report.status === 'error') throw report.error
  return report.status === 'recorded'
}
