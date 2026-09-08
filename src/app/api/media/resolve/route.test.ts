import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------

const mockAuthGetUser = vi.fn()
const mockCreateClientImpl = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: mockCreateClientImpl,
}))

const mockResolveSignedMediaUrl = vi.fn()
vi.mock('@/lib/storage/resolve-media-url', () => ({
  resolveSignedMediaUrl: (...args: Parameters<typeof mockResolveSignedMediaUrl>) =>
    mockResolveSignedMediaUrl(...args),
  MEDIA_SIGNED_URL_TTL_SECONDS_UI: 3600,
}))

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function req(body: unknown): Request {
  return new Request('http://localhost/api/media/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let fakeSupabase: { auth: { getUser: typeof mockAuthGetUser } }

beforeEach(() => {
  vi.clearAllMocks()
  mockAuthGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  fakeSupabase = { auth: { getUser: mockAuthGetUser } }
  mockCreateClientImpl.mockResolvedValue(fakeSupabase)
})

describe('POST /api/media/resolve', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthGetUser.mockResolvedValueOnce({ data: { user: null }, error: new Error('no session') })
    const { POST } = await import('./route')
    const res = await POST(req({ url: 'https://proj.supabase.co/storage/v1/object/public/chat-media/account-1/x.png' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when url is missing', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it('returns 200 + the resolved signed URL for an own-account path', async () => {
    const rawUrl = 'https://proj.supabase.co/storage/v1/object/public/chat-media/account-1/photo.png'
    const signedUrl = 'https://proj.supabase.co/storage/v1/object/sign/chat-media/account-1/photo.png?token=abc'
    mockResolveSignedMediaUrl.mockResolvedValueOnce(signedUrl)

    const { POST } = await import('./route')
    const res = await POST(req({ url: rawUrl }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ url: signedUrl })
    expect(mockResolveSignedMediaUrl).toHaveBeenCalledWith(fakeSupabase, rawUrl, 3600)
  })

  it('propagates a Storage RLS denial (foreign-account path) as 403, not a fallback URL', async () => {
    mockResolveSignedMediaUrl.mockRejectedValueOnce(new Error('permission denied'))

    const { POST } = await import('./route')
    const res = await POST(req({ url: 'https://proj.supabase.co/storage/v1/object/public/chat-media/account-other/photo.png' }))
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error).toContain('permission denied')
  })

  it('returns the pass-through value unchanged for a non-bucket URL', async () => {
    const inboundUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc123'
    mockResolveSignedMediaUrl.mockResolvedValueOnce(inboundUrl)

    const { POST } = await import('./route')
    const res = await POST(req({ url: inboundUrl }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ url: inboundUrl })
  })
})
