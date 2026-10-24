import { completeInboundTurnJob, type ClaimedInboundTurn } from '@/lib/agent/turn/substrate'

/**
 * Outcome of reporting a turn to complete_inbound_turn_job (088).
 *   recorded - the holder's report was accepted
 *   refused  - the RPC answered false: lease expired or token replaced; nothing changed
 *   error    - the RPC itself failed; the job is untouched and stays `processing`
 *              under its lease, so the 088 recovery (expired lease -> reclaim ->
 *              failed attempt with backoff) applies. Nothing is thrown from here.
 */
export type TurnReport = { status: 'recorded' } | { status: 'refused' } | { status: 'error'; error: unknown }

async function report(
  job: ClaimedInboundTurn,
  args: { success: boolean; error?: string },
): Promise<TurnReport> {
  try {
    const ok = await completeInboundTurnJob({
      messageId: job.messageId,
      claimToken: job.claimToken,
      success: args.success,
      error: args.error,
    })
    return ok ? { status: 'recorded' } : { status: 'refused' }
  } catch (error) {
    return { status: 'error', error }
  }
}

/**
 * The downstream finished without throwing. A failure of this report says
 * nothing about the downstream, so it is never answered with complete(false):
 * the job is left to its lease and the caller decides how to surface `error`.
 */
export function recordInboundTurnSuccess(job: ClaimedInboundTurn): Promise<TurnReport> {
  return report(job, { success: true })
}

/**
 * The downstream threw `cause`. Reports the failed attempt (retry/backoff is
 * the SQL's job) and never throws: a failure of the report is logged next to
 * the cause, so the caller can still raise or count the original error.
 */
export async function recordInboundTurnFailure(job: ClaimedInboundTurn, cause: unknown): Promise<TurnReport> {
  const message = cause instanceof Error ? cause.message : String(cause)
  const result = await report(job, { success: false, error: message })
  if (result.status === 'error') {
    console.error('[inbound-turn] could not record failed attempt:', job.messageId, result.error, 'cause:', message)
  }
  return result
}
