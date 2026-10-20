import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================
// F4B — media proxy source-of-truth.
//
// Proves the download URL handed to downloadMedia() comes from the
// Graph response (`getMediaUrl`), never from the request. Query
// parameters and headers supplied by the caller are ignored.
// =============================================================

const mockGetUser = vi.fn()
const mockFrom = vi.fn()
const { mockGetMediaUrl, mockDownloadMedia } = vi.hoisted(() => ({
  mockGetMediaUrl: vi.fn(),
  mockDownloadMedia: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decryptWithBindingContext: (value: string) => value.replace(/^enc:/, ''),
}))

vi.mock('@/lib/whatsapp/config-binding', () => ({
  whatsappConfigBindingContext: (accountId: string) => `whatsapp_config:${accountId}`,
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () =>
    new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }),
  RATE_LIMITS: { mediaFetch: {} },
}))

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: mockGetMediaUrl,
  downloadMedia: mockDownloadMedia,
}))

import { GET } from './route'

const ACCESS_TOKEN = 'meta-token-secret'
const GRAPH_MEDIA_URL =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc123'

type TableResult = { data: unknown; error: unknown }

let tableResults: Record<string, TableResult>

function makeBuilder(table: string) {
  const result = (): TableResult =>
    tableResults[table] ?? { data: null, error: null }

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve(result()),
    single: () => Promise.resolve(result()),
    then: (
      resolve: (value: TableResult) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(result()).then(resolve, reject),
  }
  return builder
}

function request(query = ''): Request {
  return new Request(`http://localhost/api/whatsapp/media/media-1${query}`)
}

function params(mediaId = 'media-1') {
  return { params: Promise.resolve({ mediaId }) }
}

beforeEach(() => {
  vi.clearAllMocks()

  tableResults = {
    profiles: { data: { account_id: 'acc-1' }, error: null },
    whatsapp_config: {
      data: { access_token: `enc:${ACCESS_TOKEN}`, waba_id: 'waba-1' },
      error: null,
    },
  }

  mockGetUser.mockResolvedValue({
    data: { user: { id: 'user-1' } },
    error: null,
  })
  mockFrom.mockImplementation((table: string) => makeBuilder(table))
  mockGetMediaUrl.mockResolvedValue({
    url: GRAPH_MEDIA_URL,
    mimeType: 'image/jpeg',
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.from('image-bytes'),
    contentType: 'image/jpeg',
  })
})

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it('downloads only the URL returned by the Graph resolution', async () => {
    const res = await GET(request(), params())

    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('image-bytes')
    expect(mockGetMediaUrl).toHaveBeenCalledWith({
      mediaId: 'media-1',
      accessToken: ACCESS_TOKEN,
    })
    expect(mockDownloadMedia).toHaveBeenCalledWith({
      downloadUrl: GRAPH_MEDIA_URL,
      accessToken: ACCESS_TOKEN,
    })
  })

  it('ignores caller-supplied URLs in query parameters', async () => {
    const attackerUrl = 'https://attacker.example/collect'
    const res = await GET(
      request(`?downloadUrl=${encodeURIComponent(attackerUrl)}&url=${encodeURIComponent(attackerUrl)}`),
      params(),
    )

    expect(res.status).toBe(200)
    expect(mockDownloadMedia).toHaveBeenCalledWith({
      downloadUrl: GRAPH_MEDIA_URL,
      accessToken: ACCESS_TOKEN,
    })
    const downloadArgs = mockDownloadMedia.mock.calls[0][0] as {
      downloadUrl: string
    }
    expect(downloadArgs.downloadUrl).not.toContain('attacker.example')
  })

  it('documents the current public cache header on media responses', async () => {
    const res = await GET(request(), params())

    // Recorded as-is: F4B does not change this behaviour.
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400')
  })
})
