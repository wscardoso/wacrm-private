export type ToolAuthOutcome = 'allow' | 'deny' | 'evaluation_failure'

export interface ToolAuthDecision {
  outcome: ToolAuthOutcome
  reason_code: string
}

/**
 * D11 — fail-closed tool authorization (native agent). No ROXY import.
 */
export function evaluateToolCall(args: {
  toolName: string
  /** Server-resolved tenant for this turn. */
  contextAccountId: string
  /** Must match contextAccountId; any mismatch is deny. */
  accountId: string
}): ToolAuthDecision {
  if (!args.toolName?.trim()) {
    return { outcome: 'evaluation_failure', reason_code: 'invalid_tool_name' }
  }
  if (args.accountId !== args.contextAccountId) {
    return { outcome: 'deny', reason_code: 'cross_account_tool_denied' }
  }
  if (args.toolName === 'handoff_to_human') {
    return { outcome: 'allow', reason_code: 'handoff_to_human_v1' }
  }
  return { outcome: 'deny', reason_code: 'no_ratified_policy_for_tool' }
}
