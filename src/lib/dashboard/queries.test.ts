import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadActivity, loadConversationsSeries, loadMetrics, loadPipelineDonut, loadResponseTime } from './queries'

const EMPTY_LIST = { data: [], error: null }
const EMPTY_COUNT = { data: null, error: null, count: 0 }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------
// loadMetrics
// ---------------------------------------------------------------

describe('loadMetrics', () => {
  it('returns a MetricsBundle with zero counts when no data exists', async () => {
    const db = fromMock({
      conversations: query({}),
      contacts: query({}),
      deals: query({ data: [], error: null }),
      messages: query({}),
    })

    const result = await loadMetrics(db as unknown as SupabaseClient)
    expect(result).toEqual({
      activeConversations: { current: 0, previous: 0 },
      newContactsToday: { current: 0, previous: 0 },
      openDealsValue: 0,
      openDealsCount: 0,
      messagesSentToday: { current: 0, previous: 0 },
    })
  })

  it('aggregates counts and deal values correctly', async () => {
    const db = fromMock({
      conversations: query({ data: null, count: 12 }),
      contacts: query({ data: null, count: 8 }),
      deals: query({ data: [{ value: 100 }, { value: 250 }], error: null }),
      messages: query({ data: null, count: 20 }),
    })

    const result = await loadMetrics(db as unknown as SupabaseClient)
    expect(result).toEqual({
      activeConversations: { current: 12, previous: 0 },
      newContactsToday: { current: 8, previous: 8 },
      openDealsValue: 350,
      openDealsCount: 2,
      messagesSentToday: { current: 20, previous: 20 },
    })
  })
})

// ---------------------------------------------------------------
// loadConversationsSeries
// ---------------------------------------------------------------

describe('loadConversationsSeries', () => {
  it('returns empty series when no messages', async () => {
    const db = fromMock({
      messages: query(EMPTY_LIST),
    })

    const result = await loadConversationsSeries(db as unknown as SupabaseClient, 7)
    expect(result).toHaveLength(7)
    for (const point of result) {
      expect(point.incoming).toBe(0)
      expect(point.outgoing).toBe(0)
    }
  })

  it('buckets messages into correct days', async () => {
    const data = [
      { created_at: '2026-07-08T10:00:00Z', sender_type: 'customer' },
      { created_at: '2026-07-08T11:00:00Z', sender_type: 'agent' },
      { created_at: '2026-07-07T09:00:00Z', sender_type: 'customer' },
    ]
    const db = fromMock({
      messages: query({ data, error: null }),
    })

    const result = await loadConversationsSeries(db as unknown as SupabaseClient, 7)
    const today = result.find(r => r.day === '2026-07-08')
    const yesterday = result.find(r => r.day === '2026-07-07')
    expect(today?.incoming).toBe(1)
    expect(today?.outgoing).toBe(1)
    expect(yesterday?.incoming).toBe(1)
    expect(yesterday?.outgoing).toBe(0)
  })
})

// ---------------------------------------------------------------
// loadPipelineDonut
// ---------------------------------------------------------------

describe('loadPipelineDonut', () => {
  it('returns empty stages when no pipeline data', async () => {
    const db = fromMock({
      pipeline_stages: query(EMPTY_LIST),
      deals: query({ data: [], error: null }),
    })

    const result = await loadPipelineDonut(db as unknown as SupabaseClient)
    expect(result.stages).toEqual([])
    expect(result.totalValue).toBe(0)
  })

  it('groups deals by stage', async () => {
    const stages = [
      { id: 's1', name: 'Lead', color: '#blue', pipeline_id: 'p1', position: 0 },
      { id: 's2', name: 'Qualified', color: '#green', pipeline_id: 'p1', position: 1 },
    ]
    const deals = [
      { stage_id: 's1', value: 100, status: 'open' },
      { stage_id: 's1', value: 200, status: 'open' },
      { stage_id: 's2', value: 500, status: 'open' },
    ]
    const db = fromMock({
      pipeline_stages: query({ data: stages, error: null }),
      deals: query({ data: deals, error: null }),
    })

    const result = await loadPipelineDonut(db as unknown as SupabaseClient)
    expect(result.stages).toHaveLength(2)
    expect(result.stages[0]).toMatchObject({ id: 's1', name: 'Lead', dealCount: 2, totalValue: 300 })
    expect(result.stages[1]).toMatchObject({ id: 's2', name: 'Qualified', dealCount: 1, totalValue: 500 })
    expect(result.totalValue).toBe(800)
  })
})

// ---------------------------------------------------------------
// loadResponseTime
// ---------------------------------------------------------------

describe('loadResponseTime', () => {
  it('returns empty buckets when no messages', async () => {
    const db = fromMock({
      messages: query(EMPTY_LIST),
    })

    const result = await loadResponseTime(db as unknown as SupabaseClient)
    expect(result.buckets).toHaveLength(7)
    for (const b of result.buckets) {
      expect(b.avgMinutes).toBeNull()
      expect(b.samples).toBe(0)
    }
    expect(result.thisWeekAvg).toBeNull()
    expect(result.lastWeekAvg).toBeNull()
  })

  it('pairs first customer message with next agent reply', async () => {
    const data = [
      { conversation_id: 'c1', sender_type: 'customer', created_at: '2026-07-08T10:00:00Z' },
      { conversation_id: 'c1', sender_type: 'agent', created_at: '2026-07-08T10:05:00Z' },
      { conversation_id: 'c2', sender_type: 'customer', created_at: '2026-07-08T11:00:00Z' },
      { conversation_id: 'c2', sender_type: 'customer', created_at: '2026-07-08T11:30:00Z' },
      { conversation_id: 'c2', sender_type: 'agent', created_at: '2026-07-08T12:00:00Z' },
    ]
    const db = fromMock({
      messages: query({ data, error: null }),
    })

    const result = await loadResponseTime(db as unknown as SupabaseClient)
    const totalSamples = result.buckets.reduce((s, b) => s + b.samples, 0)
    expect(totalSamples).toBe(2)
    expect(result.thisWeekAvg).not.toBeNull()
  })
})

// ---------------------------------------------------------------
// loadActivity
// ---------------------------------------------------------------

describe('loadActivity', () => {
  it('returns an empty array when no activity exists', async () => {
    const db = fromMock({
      messages: query(EMPTY_LIST),
      contacts: query(EMPTY_LIST),
      deals: query(EMPTY_LIST),
      broadcasts: query(EMPTY_LIST),
      automation_logs: query(EMPTY_LIST),
    })

    const result = await loadActivity(db as unknown as SupabaseClient)
    expect(result).toEqual([])
  })

  it('merge-sorts items from all sources', async () => {
    const contactsResult = {
      data: [{ id: 'c1', name: 'Alice', phone: '123', created_at: '2026-07-08T12:00:00Z' }],
      error: null,
    }
    const db = fromMock({
      messages: query(EMPTY_LIST),
      contacts: query(contactsResult),
      deals: query(EMPTY_LIST),
      broadcasts: query(EMPTY_LIST),
      automation_logs: query(EMPTY_LIST),
    })

    const result = await loadActivity(db as unknown as SupabaseClient)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('contact')
    expect(result[0].text).toContain('Alice')
  })
})

// ---------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------

/**
 * Build a thenable query result. The returned object has every
 * Supabase chain method as `vi.fn(() => chain)`, and resolving
 * the promise returns `value`.
 */
function query<T>(value: T) {
  const chain = { then: (resolve: (v: T) => void) => resolve(value) }
  const methods = ['select', 'eq', 'gte', 'lt', 'order', 'limit', 'maybeSingle', 'single']
  for (const m of methods) {
    ;(chain as Record<string, unknown>)[m] = vi.fn(() => chain)
  }
  return chain
}

/**
 * Build a mock `db` object where `db.from(table)` returns a
 * chain that always resolves to `config[table]`, regardless of
 * the chain methods called.
 */
function fromMock(config: Record<string, ReturnType<typeof query>>) {
  return {
    from: vi.fn((table: string) => config[table] ?? query({ data: [], error: null })),
  }
}
