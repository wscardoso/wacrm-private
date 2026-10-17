/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the automation engine's funnel-facing additions:
 * round-robin assignment, the `move_deal_stage` / `update_deal_field`
 * steps (including their service-role guards) and
 * `cancelPendingCadencesForContact`.
 *
 * `supabaseAdmin()` is replaced by an in-memory thenable query builder
 * whose results are driven per-test by a resolver. This keeps the tests
 * hermetic (no DB, no network) while still exercising the real engine
 * code paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface QueryState {
  table: string
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete'
  filters: [string, unknown][]
  ins: [string, unknown[]][]
  single: boolean
  payload: unknown
  selected?: string
}

type Resolver = (s: QueryState) => { data?: unknown; error?: unknown; count?: number | null }

type RpcResolver = (name: string, args: unknown) => { data?: unknown; error?: unknown }

const h = vi.hoisted(() => {
  const calls: QueryState[] = []
  const rpcCalls: { name: string; args: unknown }[] = []
  let resolver: Resolver = () => ({ data: null })

  function makeBuilder(table: string): any {
    const s: QueryState = {
      table,
      op: 'select',
      filters: [],
      ins: [],
      single: false,
      payload: undefined,
    }
    const chain: Record<string, unknown> = {}
    Object.assign(chain, {
      select(sel?: string) {
        s.selected = sel
        return chain
      },
      insert(p: unknown) {
        s.op = 'insert'
        s.payload = p
        return chain
      },
      update(p: unknown) {
        s.op = 'update'
        s.payload = p
        return chain
      },
      upsert(p: unknown) {
        s.op = 'upsert'
        s.payload = p
        return chain
      },
      delete() {
        s.op = 'delete'
        return chain
      },
      eq(c: string, v: unknown) {
        s.filters.push([c, v])
        return chain
      },
      in(c: string, v: unknown[]) {
        s.ins.push([c, v])
        return chain
      },
      gte(c: string, v: unknown) {
        s.filters.push([c, v])
        return chain
      },
      gt(c: string, v: unknown) {
        s.filters.push([c, v])
        return chain
      },
      is(c: string, v: unknown) {
        s.filters.push([c, v])
        return chain
      },
      order() {
        return chain
      },
      limit() {
        return chain
      },
      single() {
        s.single = true
        return chain
      },
      maybeSingle() {
        s.single = true
        return chain
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        calls.push({
          ...s,
          filters: [...s.filters],
          ins: s.ins.map((x) => [x[0], [...(x[1] as unknown[])]] as [string, unknown[]]),
        })
        try {
          resolve(resolver(s) ?? { data: null })
        } catch (e) {
          reject?.(e)
        }
      },
    })
    return chain
  }

  const api = {
    calls,
    rpcCalls,
    makeBuilder,
    // Swapped per test by setRpcResolver; the mocked rpc() calls
    // api.rpcResolver at invoke time so the latest resolver wins.
    rpcResolver: (() => ({ data: null, error: null })) as RpcResolver,
    setResolver(fn: Resolver) {
      resolver = fn
    },
    setRpcResolver(fn: RpcResolver) {
      api.rpcResolver = fn
    },
    reset() {
      calls.length = 0
      rpcCalls.length = 0
      resolver = () => ({ data: null })
      api.rpcResolver = () => ({ data: null, error: null })
    },
  }
  return api
})

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (t: string) => h.makeBuilder(t),
    rpc: async (name: string, args: unknown) => {
      h.rpcCalls.push({ name, args })
      return h.rpcResolver(name, args)
    },
  }),
}))

vi.mock('@/lib/automations/meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'wamid' })),
}))

import {
  runAutomationsForTrigger,
  cancelPendingCadencesForContact,
} from './engine'
import type { Automation, AutomationStep } from '@/types'

const ACCOUNT = 'acct-1'
const CONTACT = 'contact-1'

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    account_id: ACCOUNT,
    user_id: 'user-1',
    name: 'test',
    trigger_type: 'new_contact_created',
    trigger_config: {},
    is_active: true,
    execution_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

function step(
  step_type: string,
  step_config: Record<string, unknown>,
  over: Partial<AutomationStep> = {},
): AutomationStep {
  return {
    id: 's1',
    automation_id: 'a1',
    position: 0,
    step_type,
    step_config,
    parent_step_id: null,
    branch: null,
    ...over,
  } as AutomationStep
}

/** Default plumbing every `runAutomationsForTrigger` run needs. */
function baseResolver(a: Automation, steps: AutomationStep[]): Resolver {
  return (s) => {
    if (s.table === 'automations' && s.op === 'select') return { data: [a] }
    if (s.table === 'automation_logs' && s.op === 'insert') return { data: { id: 'log-1' } }
    if (s.table === 'automation_steps' && s.op === 'select') return { data: steps }
    if (s.table === 'automation_logs' && s.op === 'select' && s.selected === 'id') {
      return { data: null, count: 0 }
    }
    if (s.table === 'automation_logs' && s.op === 'select') {
      return { data: { steps_executed: [], status: 'success' } }
    }
    return { data: null }
  }
}

function findCall(table: string, op: QueryState['op']): QueryState | undefined {
  return h.calls.find((c) => c.table === table && c.op === op)
}

function allCalls(table: string, op: QueryState['op']): QueryState[] {
  return h.calls.filter((c) => c.table === table && c.op === op)
}

beforeEach(() => {
  h.reset()
})

// ------------------------------------------------------------
// A1 — round-robin assignment
// ------------------------------------------------------------

describe('assign_conversation round_robin', () => {
  const rrStep = step('assign_conversation', { mode: 'round_robin' })

  it('resolves the agent through a single atomic RPC and assigns it', async () => {
    const a = auto()
    h.setResolver((s) => {
      if (s.table === 'contacts') return { data: { id: CONTACT } }
      return baseResolver(a, [rrStep])(s)
    })
    h.setRpcResolver((name) => (name === 'assign_next_lead_agent' ? { data: 'u2' } : { data: null }))

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_contact_created',
      contactId: CONTACT,
    })

    // Exactly one rotation call, scoped to the account.
    const rr = h.rpcCalls.filter((c) => c.name === 'assign_next_lead_agent')
    expect(rr).toHaveLength(1)
    expect(rr[0].args).toEqual({ p_account_id: ACCOUNT })

    // The chosen id is written to the conversation, account-scoped.
    const convUpdate = findCall('conversations', 'update')
    expect(convUpdate).toBeDefined()
    expect((convUpdate!.payload as any).assigned_agent_id).toBe('u2')
    expect(convUpdate!.filters).toContainEqual(['account_id', ACCOUNT])
    expect(convUpdate!.filters).toContainEqual(['contact_id', CONTACT])
  })

  it('never reproduces the non-atomic read-then-upsert (regression lock)', async () => {
    const a = auto()
    h.setResolver((s) => {
      if (s.table === 'contacts') return { data: { id: CONTACT } }
      return baseResolver(a, [rrStep])(s)
    })
    h.setRpcResolver(() => ({ data: 'u1' }))

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_contact_created',
      contactId: CONTACT,
    })

    // The rotation state must NOT be read or written from the app tier:
    // a SELECT-then-UPSERT pair is exactly the race that was fixed, so
    // any reappearance of these calls fails the lock. Membership is
    // likewise resolved inside the RPC (keyed on account_role there).
    expect(allCalls('account_lead_routing', 'select')).toHaveLength(0)
    expect(allCalls('account_lead_routing', 'upsert')).toHaveLength(0)
    expect(allCalls('account_lead_routing', 'insert')).toHaveLength(0)
    expect(allCalls('profiles', 'select')).toHaveLength(0)
  })

  it("returns 'no agent resolved' when the RPC reports no eligible agent", async () => {
    const a = auto()
    h.setResolver((s) => {
      if (s.table === 'contacts') return { data: { id: CONTACT } }
      return baseResolver(a, [rrStep])(s)
    })
    // NULL body = account has zero eligible members (owner/admin/agent).
    h.setRpcResolver(() => ({ data: null }))

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_contact_created',
      contactId: CONTACT,
    })

    // No assignment write at all, and the run still succeeds recording
    // the 'no agent resolved' detail.
    const convWrites = allCalls('conversations', 'update')
    expect(convWrites.some((c) => 'assigned_agent_id' in (c.payload as object))).toBe(false)

    const logUpdate = allCalls('automation_logs', 'update').find(
      (c) => (c.payload as any)?.status === 'success',
    )
    expect(logUpdate).toBeDefined()
    const steps = (logUpdate!.payload as any).steps_executed as { detail: string }[]
    expect(steps.at(-1)?.detail).toBe('no agent resolved')
  })

  it('fails the step when the atomic RPC errors', async () => {
    const a = auto()
    h.setResolver((s) => {
      if (s.table === 'contacts') return { data: { id: CONTACT } }
      return baseResolver(a, [rrStep])(s)
    })
    h.setRpcResolver((name) =>
      name === 'assign_next_lead_agent'
        ? { data: null, error: { message: 'deadlock detected' } }
        : { data: null },
    )

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_contact_created',
      contactId: CONTACT,
    })

    // Failure is surfaced, not swallowed: the run is logged `failed`
    // with the RPC message, and no conversation is assigned.
    expect(allCalls('conversations', 'update')).toHaveLength(0)
    const failedLog = allCalls('automation_logs', 'update').find(
      (c) => (c.payload as any)?.status === 'failed',
    )
    expect(failedLog).toBeDefined()
    expect(String((failedLog!.payload as any).error_message)).toContain(
      'round-robin assignment failed',
    )
    expect(String((failedLog!.payload as any).error_message)).toContain('deadlock detected')
  })

  it('leaves the specific mode untouched (no rotation RPC)', async () => {
    const a = auto()
    h.setResolver((s) => {
      if (s.table === 'contacts') return { data: { id: CONTACT } }
      return baseResolver(a, [step('assign_conversation', { mode: 'specific', agent_id: 'u9' })])(s)
    })

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_contact_created',
      contactId: CONTACT,
    })

    expect(h.rpcCalls.some((c) => c.name === 'assign_next_lead_agent')).toBe(false)
    const convUpdate = findCall('conversations', 'update')
    expect((convUpdate!.payload as any).assigned_agent_id).toBe('u9')
  })
})

// ------------------------------------------------------------
// A2 — update_deal_field guards
// ------------------------------------------------------------

describe('update_deal_field', () => {
  const a = auto({ trigger_type: 'deal_created' })

  it('writes an allow-listed built-in field', async () => {
    h.setResolver(baseResolver(a, [step('update_deal_field', { field: 'title', value: 'Novo título' })]))

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'deal_created',
      contactId: null,
      context: { deal_id: 'd1' },
    })

    const upd = findCall('deals', 'update')
    expect(upd).toBeDefined()
    expect(upd!.filters).toContainEqual(['id', 'd1'])
    expect(upd!.filters).toContainEqual(['account_id', ACCOUNT])
    expect((upd!.payload as any).title).toBe('Novo título')
  })

  it('coerces a numeric field, accepting a comma decimal separator', async () => {
    h.setResolver(baseResolver(a, [step('update_deal_field', { field: 'value', value: '10,5' })]))

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'deal_created',
      contactId: null,
      context: { deal_id: 'd1' },
    })

    const upd = findCall('deals', 'update')
    expect((upd!.payload as any).value).toBe(10.5)
  })

  it('rejects a non-allow-listed column and fails the step', async () => {
    h.setResolver(
      baseResolver(a, [step('update_deal_field', { field: 'account_id', value: 'evil' })]),
    )

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'deal_created',
      contactId: null,
      context: { deal_id: 'd1' },
    })

    // No deal write happened at all.
    expect(allCalls('deals', 'update')).toHaveLength(0)

    // The run is recorded as failed, carrying the guard's message.
    const logUpdate = allCalls('automation_logs', 'update').find(
      (c) => (c.payload as any)?.status === 'failed',
    )
    expect(logUpdate).toBeDefined()
    expect(String((logUpdate!.payload as any).error_message)).toContain('not allowed')
  })

  it('namespaces custom fields under custom:<key>', async () => {
    h.setResolver(
      (s) => {
        if (s.table === 'deals' && s.op === 'select') {
          return { data: { id: 'd1', custom_fields: { existing: 'keep' } } }
        }
        return baseResolver(a, [
          step('update_deal_field', { field: 'custom:origem', value: 'instagram' }),
        ])(s)
      },
    )

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'deal_created',
      contactId: null,
      context: { deal_id: 'd1' },
    })

    const upd = findCall('deals', 'update')
    expect((upd!.payload as any).custom_fields).toEqual({
      existing: 'keep',
      origem: 'instagram',
    })
  })
})

// ------------------------------------------------------------
// A2 — move_deal_stage guards
// ------------------------------------------------------------

describe('move_deal_stage', () => {
  const a = auto({ trigger_type: 'deal_stage_changed' })

  it('moves the deal when the target stage belongs to the account', async () => {
    h.setResolver((s) => {
      if (s.table === 'pipeline_stages' && s.op === 'select') {
        return { data: { id: 'st2', pipeline_id: 'pl1' } }
      }
      return baseResolver(a, [step('move_deal_stage', { stage_id: 'st2' })])(s)
    })

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'deal_stage_changed',
      contactId: null,
      context: { deal_id: 'd1' },
    })

    const upd = findCall('deals', 'update')
    expect(upd).toBeDefined()
    expect((upd!.payload as any).stage_id).toBe('st2')
    expect(upd!.filters).toContainEqual(['account_id', ACCOUNT])
  })

  it('refuses a stage outside the account', async () => {
    h.setResolver((s) => {
      if (s.table === 'pipeline_stages' && s.op === 'select') return { data: null }
      return baseResolver(a, [step('move_deal_stage', { stage_id: 'foreign' })])(s)
    })

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'deal_stage_changed',
      contactId: null,
      context: { deal_id: 'd1' },
    })

    expect(allCalls('deals', 'update')).toHaveLength(0)
    const logUpdate = allCalls('automation_logs', 'update').find(
      (c) => (c.payload as any)?.status === 'failed',
    )
    expect(String((logUpdate!.payload as any).error_message)).toContain('not in account')
  })
})

// ------------------------------------------------------------
// A3 — cadence cancellation
// ------------------------------------------------------------

describe('cancelPendingCadencesForContact', () => {
  it('marks parked waits as cancelled and appends a log step', async () => {
    h.setResolver((s) => {
      if (s.table === 'automation_pending_executions' && s.op === 'select') {
        return { data: [{ id: 'p1', automation_id: 'a1', log_id: 'l1' }] }
      }
      if (s.table === 'automations' && s.op === 'select') {
        return { data: { cancel_on_reply: true } }
      }
      if (s.table === 'automation_logs' && s.op === 'select') {
        return { data: { steps_executed: [] } }
      }
      return { data: null }
    })

    const count = await cancelPendingCadencesForContact(ACCOUNT, CONTACT)
    expect(count).toBe(1)

    const pendingUpdate = findCall('automation_pending_executions', 'update')
    expect(pendingUpdate).toBeDefined()
    expect((pendingUpdate!.payload as any).status).toBe('cancelled')

    const logUpdate = findCall('automation_logs', 'update')
    expect(logUpdate).toBeDefined()
    const steps = (logUpdate!.payload as any).steps_executed as { detail: string }[]
    expect(steps.at(-1)?.detail).toContain('cancelled')
  })

  it('respects cancel_on_reply=false', async () => {
    h.setResolver((s) => {
      if (s.table === 'automation_pending_executions' && s.op === 'select') {
        return { data: [{ id: 'p1', automation_id: 'a1', log_id: 'l1' }] }
      }
      if (s.table === 'automations' && s.op === 'select') {
        return { data: { cancel_on_reply: false } }
      }
      return { data: null }
    })

    const count = await cancelPendingCadencesForContact(ACCOUNT, CONTACT)
    expect(count).toBe(0)
    expect(allCalls('automation_pending_executions', 'update')).toHaveLength(0)
  })

  it('returns 0 when there are no pending executions', async () => {
    h.setResolver(() => ({ data: [] }))
    const count = await cancelPendingCadencesForContact(ACCOUNT, CONTACT)
    expect(count).toBe(0)
  })
})
