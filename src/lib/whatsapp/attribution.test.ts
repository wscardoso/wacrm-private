import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { captureReferral, persistAttribution } from './attribution'
import type { Referral } from '@/types'

// ---------------------------------------------------------------
// captureReferral — pure function, no I/O
// ---------------------------------------------------------------

describe('captureReferral', () => {
  const base = {
    accountId: 'acc-1',
    contactId: 'contact-1',
    conversationId: 'conv-1',
    messageId: 'wamid-1',
  }

  it('parses a complete referral into the canonical payload', () => {
    const referral: Referral = {
      source_id: 'ad-123',
      source_type: 'ad',
      source_url: 'https://facebook.com/ad-123',
      headline: '20% off today',
      body: 'Book your appointment now',
      media_type: 'image',
      image_url: 'https://scontent.example/creative.jpg',
      ctwa_clid: 'clid-abc123',
    }

    const result = captureReferral({ ...base, referral })

    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      account_id: 'acc-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      source_channel: 'ctwa_meta',
      origin_message_id: 'wamid-1',
      ad_source_id: 'ad-123',
      ad_source_type: 'ad',
      ad_source_url: 'https://facebook.com/ad-123',
      ad_headline: '20% off today',
      ad_body: 'Book your appointment now',
      ad_media_type: 'image',
      ad_media_url: 'https://scontent.example/creative.jpg',
      ctwa_clid: 'clid-abc123',
    })
    expect(result?.raw).toEqual(referral)
  })

  it('returns null when there is no referral', () => {
    expect(captureReferral({ ...base, referral: undefined })).toBeNull()
    expect(captureReferral({ ...base, referral: null })).toBeNull()
  })

  it('returns null for an empty referral object with no identifying signal', () => {
    expect(captureReferral({ ...base, referral: {} })).toBeNull()
  })

  it('still captures a referral that has no ctwa_clid', () => {
    const referral: Referral = {
      source_id: 'ad-999',
      headline: 'Spring sale',
    }
    const result = captureReferral({ ...base, referral })
    expect(result).not.toBeNull()
    expect(result?.ctwa_clid).toBeNull()
    expect(result?.ad_source_id).toBe('ad-999')
  })

  it('falls back to video_url / thumbnail_url when image_url is absent', () => {
    const result = captureReferral({
      ...base,
      referral: { source_id: 'ad-1', video_url: 'https://video.example/x.mp4' },
    })
    expect(result?.ad_media_url).toBe('https://video.example/x.mp4')
  })
})

// ---------------------------------------------------------------
// persistAttribution — idempotency + first-touch semantics
//
// Backed by a minimal in-memory fake Supabase client covering only
// the operations persistAttribution actually issues (upsert/insert/
// select/update with eq/is/maybeSingle/single).
// ---------------------------------------------------------------

interface Row {
  [key: string]: unknown
}

function makeFakeSupabase() {
  const db: Record<string, Row[]> = {
    lead_attributions: [],
    conversations: [],
    contacts: [],
  }
  let counter = 0
  const genId = () => `gen-${++counter}`

  function from(table: string) {
    if (!db[table]) db[table] = []
    const eqFilters: Array<[string, unknown]> = []
    const isFilters: string[] = []
    let insertPayload: Row | null = null
    let updatePayload: Row | null = null
    let upsertPayload: { data: Row; onConflict?: string; ignoreDuplicates?: boolean } | null = null

    function applyFilters(rows: Row[]) {
      return rows.filter(
        (r) =>
          eqFilters.every(([f, v]) => r[f] === v) &&
          isFilters.every((f) => r[f] === null || r[f] === undefined),
      )
    }

    function resolve(): { data: Row | Row[] | null; error: null } {
      if (insertPayload) {
        const row: Row = { id: genId(), created_at: new Date().toISOString(), ...insertPayload }
        db[table].push(row)
        return { data: [row], error: null }
      }
      if (upsertPayload) {
        const fields = (upsertPayload.onConflict ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const existing = fields.length
          ? db[table].find((r) => fields.every((f) => r[f] === upsertPayload!.data[f]))
          : undefined
        if (existing) {
          if (upsertPayload.ignoreDuplicates) {
            // ON CONFLICT ... DO NOTHING — existing row is left as-is
            // and PostgREST returns no row for the conflicting insert.
            return { data: [], error: null }
          }
          Object.assign(existing, upsertPayload.data)
          return { data: [existing], error: null }
        }
        const row: Row = { id: genId(), created_at: new Date().toISOString(), ...upsertPayload.data }
        db[table].push(row)
        return { data: [row], error: null }
      }
      if (updatePayload) {
        const matched = applyFilters(db[table])
        matched.forEach((r) => Object.assign(r, updatePayload))
        return { data: matched, error: null }
      }
      return { data: applyFilters(db[table]), error: null }
    }

    const builder = {
      select: () => builder,
      eq: (f: string, v: unknown) => {
        eqFilters.push([f, v])
        return builder
      },
      is: (f: string, v: unknown) => {
        if (v === null) isFilters.push(f)
        return builder
      },
      insert: (payload: Row) => {
        insertPayload = payload
        return builder
      },
      update: (payload: Row) => {
        updatePayload = payload
        return builder
      },
      upsert: (payload: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
        upsertPayload = {
          data: payload,
          onConflict: opts?.onConflict,
          ignoreDuplicates: opts?.ignoreDuplicates,
        }
        return builder
      },
      maybeSingle: async () => {
        const { data } = resolve()
        const arr = data as Row[]
        return { data: arr[0] ?? null, error: null }
      },
      single: async () => {
        const { data } = resolve()
        const arr = data as Row[]
        return arr[0]
          ? { data: arr[0], error: null }
          : { data: null, error: { message: 'no rows' } }
      },
      then: (onFulfilled: (value: ReturnType<typeof resolve>) => unknown) =>
        Promise.resolve(resolve()).then(onFulfilled),
    }

    return builder
  }

  return { fake: { from, db }, client: { from } as unknown as SupabaseClient }
}

describe('persistAttribution', () => {
  let supabase: ReturnType<typeof makeFakeSupabase>['fake']
  let client: SupabaseClient

  beforeEach(() => {
    const made = makeFakeSupabase()
    supabase = made.fake
    client = made.client
    supabase.db.contacts.push({ id: 'contact-1', first_attribution_id: null })
    supabase.db.conversations.push({ id: 'conv-1', attribution_id: null })
  })

  const input = (messageId: string, referral: Referral) => ({
    accountId: 'acc-1',
    contactId: 'contact-1',
    conversationId: 'conv-1',
    messageId,
    referral,
  })

  it('creates an attribution, links the conversation, and stamps first-touch', async () => {
    const result = await persistAttribution(
      client,
      input('wamid-1', { source_id: 'ad-1', headline: 'Promo', ctwa_clid: 'clid-1' }),
    )

    expect(result.attribution).not.toBeNull()
    expect(result.attribution!.origin_message_id).toBe('wamid-1')
    expect(result.firstTouchWritten).toBe(true)
    expect(supabase.db.lead_attributions).toHaveLength(1)
    expect(supabase.db.conversations[0].attribution_id).toBe(result.attribution!.id)
    expect(supabase.db.contacts[0].first_attribution_id).toBe(result.attribution!.id)
    expect(supabase.db.contacts[0].first_source_channel).toBe('ctwa_meta')
  })

  it('is idempotent on origin_message_id: the same webhook delivered twice yields a single row', async () => {
    await persistAttribution(client, input('wamid-1', { source_id: 'ad-1', ctwa_clid: 'clid-1' }))
    await persistAttribution(client, input('wamid-1', { source_id: 'ad-1', ctwa_clid: 'clid-1' }))

    expect(supabase.db.lead_attributions).toHaveLength(1)
  })

  it('does not duplicate even when ctwa_clid is NULL on both deliveries (the reason ctwa_clid cannot be the conflict key)', async () => {
    await persistAttribution(client, input('wamid-1', { source_id: 'ad-1' }))
    await persistAttribution(client, input('wamid-1', { source_id: 'ad-1' }))

    expect(supabase.db.lead_attributions).toHaveLength(1)
  })

  it('preserves first-touch and creates a new attribution on a later distinct message', async () => {
    const first = await persistAttribution(
      client,
      input('wamid-1', { source_id: 'ad-1', ctwa_clid: 'clid-1' }),
    )
    const second = await persistAttribution(
      client,
      input('wamid-2', { source_id: 'ad-2', ctwa_clid: 'clid-2' }),
    )

    expect(supabase.db.lead_attributions).toHaveLength(2)
    expect(second.firstTouchWritten).toBe(false)
    // Conversation now points at the most recent touch...
    expect(supabase.db.conversations[0].attribution_id).toBe(second.attribution!.id)
    // ...but the contact's first-touch is untouched.
    expect(supabase.db.contacts[0].first_attribution_id).toBe(first.attribution!.id)
  })

  it('returns a no-op result when there is no referral to capture', async () => {
    const result = await persistAttribution(client, {
      accountId: 'acc-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      messageId: 'wamid-x',
      referral: undefined,
    })
    expect(result.attribution).toBeNull()
    expect(result.firstTouchWritten).toBe(false)
    expect(supabase.db.lead_attributions).toHaveLength(0)
  })
})
