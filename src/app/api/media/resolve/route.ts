import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveSignedMediaUrl, MEDIA_SIGNED_URL_TTL_SECONDS_UI } from '@/lib/storage/resolve-media-url'

/**
 * POST /api/media/resolve
 *
 * S2 (plans/001-private-media-buckets-s2.md), Step 4 — chat-media and
 * flow-media are private post-migration-076, so a `media_url` already
 * stored in the DB (the old permanent public URL shape) is no longer
 * directly fetchable. This route mints a short-lived signed URL, on
 * behalf of the caller's own session, for the client-side render path
 * (`<AccountMedia>`).
 *
 * Authorization is entirely Storage RLS (migration 076's account-
 * scoped SELECT policy): `createSignedUrl` is called with the
 * caller's own authenticated Supabase client, so a request for a path
 * outside the caller's account fails there — surfaced below as a 403,
 * not silently swallowed. No manual account check is added on top of
 * that; that would duplicate — and could drift from — the RLS policy
 * that's the actual enforcement point.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const url = (body as { url?: unknown } | null)?.url
    if (typeof url !== 'string' || !url) {
      return NextResponse.json({ error: 'url is required' }, { status: 400 })
    }

    try {
      const resolved = await resolveSignedMediaUrl(supabase, url, MEDIA_SIGNED_URL_TTL_SECONDS_UI)
      return NextResponse.json({ url: resolved })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resolve media URL'
      // A Storage RLS denial (caller isn't a member of the owning
      // account) surfaces here — 403, not a signed URL, and not
      // swallowed into a fallback to the (now-broken) raw public URL.
      return NextResponse.json({ error: message }, { status: 403 })
    }
  } catch (error) {
    console.error('Error in /api/media/resolve POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
