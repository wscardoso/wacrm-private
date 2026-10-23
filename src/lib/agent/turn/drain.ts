import { claimInboundTurnJob, reclaimStuckInboundTurnJobs } from '@/lib/agent/turn/substrate'
import { INBOUND_TURN_LEASE_SECONDS, runWithInboundTurnLease } from '@/lib/agent/turn/lease'
import { recordInboundTurnFailure, recordInboundTurnSuccess } from '@/lib/agent/turn/finish'
import { runInboundDownstreamForMessage } from '@/lib/whatsapp/inbound-downstream'

export interface InboundTurnDrainResult {
  reclaimed: number
  processed: number
  failed: number
  skipped: number
}

/**
 * Processes durable inbound turn jobs (Q10). Downstream = conversation update
 * effects already split from persist; no LLM in this drain until F4 wires agent.
 */
export async function drainInboundTurnJobs(opts?: {
  maxJobs?: number
  reclaimStaleSeconds?: number
}): Promise<InboundTurnDrainResult> {
  const maxJobs = opts?.maxJobs ?? 10
  const reclaimed = await reclaimStuckInboundTurnJobs(opts?.reclaimStaleSeconds ?? 0)

  let processed = 0
  let failed = 0
  let skipped = 0

  for (let i = 0; i < maxJobs; i++) {
    const job = await claimInboundTurnJob(INBOUND_TURN_LEASE_SECONDS)
    if (!job) {
      skipped++
      break
    }

    let turn: { leaseHeld: boolean }
    try {
      turn = await runWithInboundTurnLease(job, () => runInboundDownstreamForMessage(job.messageId))
    } catch (err) {
      // Only a downstream failure is a failed attempt. A failing report (logged
      // by recordInboundTurnFailure) leaves the job to its lease; the batch goes on.
      await recordInboundTurnFailure(job, err)
      failed++
      continue
    }

    if (!turn.leaseHeld) {
      console.warn('[inbound-turn] lease lost before completion:', job.messageId)
      failed++
      continue
    }

    // The downstream succeeded. If the report is refused or fails the job is
    // not counted as processed, but it is never re-marked as a failed attempt.
    const report = await recordInboundTurnSuccess(job)
    if (report.status === 'error') {
      console.error('[inbound-turn] could not record completion:', job.messageId, report.error)
    }
    if (report.status === 'recorded') processed++
    else failed++
  }

  return { reclaimed, processed, failed, skipped }
}
