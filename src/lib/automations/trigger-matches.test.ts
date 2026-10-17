import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin-client', () => ({ supabaseAdmin: () => ({}) }))

import { triggerMatches } from './engine'
import type { Automation } from '@/types'

function auto(trigger_type: string, trigger_config: Record<string, unknown>): Automation {
  return { trigger_type, trigger_config } as unknown as Automation
}

describe('triggerMatches: deal triggers', () => {
  it('matches any deal when no filter is configured', () => {
    expect(triggerMatches(auto('deal_stage_changed', {}), { pipeline_id: 'p1', stage_id: 's1' })).toBe(true)
  })
  it('filters by stage', () => {
    const a = auto('deal_stage_changed', { stage_id: 's2' })
    expect(triggerMatches(a, { pipeline_id: 'p1', stage_id: 's1' })).toBe(false)
    expect(triggerMatches(a, { pipeline_id: 'p1', stage_id: 's2' })).toBe(true)
  })
  it('filters by pipeline', () => {
    const a = auto('deal_created', { pipeline_id: 'p2' })
    expect(triggerMatches(a, { pipeline_id: 'p1', stage_id: 's1' })).toBe(false)
    expect(triggerMatches(a, { pipeline_id: 'p2', stage_id: 's1' })).toBe(true)
  })
})

describe('triggerMatches: conversation_assigned', () => {
  it('matches any assignee when unfiltered', () => {
    expect(triggerMatches(auto('conversation_assigned', {}), { agent_id: 'a1' })).toBe(true)
  })
  it('filters by agent', () => {
    const a = auto('conversation_assigned', { agent_id: 'a1' })
    expect(triggerMatches(a, { agent_id: 'a2' })).toBe(false)
    expect(triggerMatches(a, { agent_id: 'a1' })).toBe(true)
    expect(triggerMatches(a, undefined)).toBe(false)
  })
})
