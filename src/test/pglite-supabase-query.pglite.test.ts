import { describe, it, expect, beforeAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { bootChain, seedWorld } from '@/test/support/full-migration-chain'
import { pgliteSupabaseWithQuery, type PgliteQueryError } from '@/test/support/pglite-supabase-query'

/** The query client used by the T5 inbound test, checked against the real schema. */
describe('pgliteSupabaseWithQuery', () => {
  let db: PGlite
  let world: Awaited<ReturnType<typeof seedWorld>>
  let client: ReturnType<typeof pgliteSupabaseWithQuery>
  let contactId: string

  beforeAll(async () => {
    db = await bootChain(91)
    world = await seedWorld(db)
    client = pgliteSupabaseWithQuery(db)
    contactId = (
      await db.query<{ contact_id: string }>(`SELECT contact_id FROM conversations WHERE id = $1`, [world.convA])
    ).rows[0]!.contact_id
  })

  it('select with eq / like returns rows; maybeSingle returns the row or null', async () => {
    const byLike = await client.from('contacts').select('*').eq('account_id', world.accountA).like('phone', '%90001')
    expect(byLike.error).toBeNull()
    expect(byLike.data).toHaveLength(1)

    const one = await client.from('contacts').select('id').eq('id', contactId).maybeSingle()
    expect(one).toEqual({ data: { id: contactId }, error: null })
    const none = await client.from('contacts').select('id').eq('phone', 'no-such').maybeSingle()
    expect(none).toEqual({ data: null, error: null })
  })

  it('single() on zero rows is PGRST116; maybeSingle() on several rows is PGRST116', async () => {
    const zero = await client.from('contacts').select('id').eq('phone', 'no-such').single()
    expect((zero.error as PgliteQueryError).code).toBe('PGRST116')
    const many = await client.from('accounts').select('id').maybeSingle()
    expect((many.error as PgliteQueryError).code).toBe('PGRST116')
  })

  it('count with head returns the count and no rows', async () => {
    const r = await client.from('contacts').select('id', { count: 'exact', head: true }).eq('account_id', world.accountA)
    expect(r.error).toBeNull()
    expect(r.data).toBeNull()
    expect(r.count).toBe(1)
  })

  it('in / is / order / limit', async () => {
    const r = await client
      .from('conversations')
      .select('id, account_id')
      .in('account_id', [world.accountA, world.accountB])
      .is('assigned_agent_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
    expect(r.error).toBeNull()
    expect(r.data).toHaveLength(1)

    const both = await client.from('conversations').select('id').in('account_id', [world.accountA, world.accountB])
    expect(both.data).toHaveLength(2)
    const onlyA = await client.from('conversations').select('id').in('account_id', [world.accountA])
    expect(onlyA.data).toEqual([{ id: world.convA }])
  })

  it('insert + select + single returns the full row; update and delete apply their filters', async () => {
    const ins = await client
      .from('contacts')
      .insert({ account_id: world.accountA, user_id: '10000000-0000-4000-8000-00000000000a', phone: '5511900000001', name: 'Q' })
      .select()
      .single()
    expect(ins.error).toBeNull()
    expect(ins.data).toMatchObject({ phone: '5511900000001', name: 'Q', account_id: world.accountA })

    const id = (ins.data as { id: string }).id
    expect((await client.from('contacts').update({ name: 'Q2' }).eq('id', id)).error).toBeNull()
    expect((await client.from('contacts').select('name').eq('id', id).maybeSingle()).data).toEqual({ name: 'Q2' })
    expect((await client.from('contacts').delete().eq('id', id)).error).toBeNull()
    expect((await client.from('contacts').select('id').eq('id', id).maybeSingle()).data).toBeNull()
  })

  it('upsert on (account_id, contact_id) returns the existing conversation instead of a second row', async () => {
    const r = await client
      .from('conversations')
      .upsert(
        { account_id: world.accountA, user_id: '10000000-0000-4000-8000-00000000000a', contact_id: contactId },
        { onConflict: 'account_id, contact_id' },
      )
      .select()
      .single()
    expect(r.error).toBeNull()
    expect((r.data as { id: string }).id).toBe(world.convA)
  })

  it('SQL errors come back as values with the SQLSTATE', async () => {
    const r = await client.from('contacts').insert({ account_id: '99999999-9999-4999-8999-999999999999', user_id: '10000000-0000-4000-8000-00000000000a', phone: '5511900000002' }).select().single()
    expect(r.data).toBeNull()
    expect((r.error as PgliteQueryError).code).toBe('23503')
  })

  it('unmodelled constructs are explicit errors, never silent', async () => {
    const embedded = await client.from('broadcast_recipients').select('id, broadcasts!inner(account_id)')
    expect((embedded.error as PgliteQueryError).code).toBe('TEST_UNSUPPORTED')
    const dotted = await client.from('messages').select('id').eq('conversations.account_id', world.accountA)
    expect((dotted.error as PgliteQueryError).code).toBe('TEST_UNSUPPORTED')
  })

  it('rpc is the real function (H0)', async () => {
    const r = await client.rpc('reclaim_stuck_inbound_turn_jobs', { p_stale_seconds: 0 })
    expect(r).toEqual({ data: 0, error: null })
  })
})
