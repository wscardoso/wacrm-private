import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMediaUrl } from './meta-api'

// =============================================================
// F4B — media resolution origin proof.
//
// `mediaId` is interpolated into a fixed Graph API URL and the
// account's stored token is attached to that request. These tests
// prove that no `mediaId` value can move the request to another
// origin, regardless of traversal / scheme / backslash tricks.
// =============================================================

const ACCESS_TOKEN = 'meta-token-secret'
const GRAPH_ORIGIN = 'https://graph.facebook.com'

const HOSTILE_MEDIA_IDS = [
  '../../../evil.example',
  '..%2F..%2F..%2Fevil.example',
  '..\\..\\evil.example',
  '//evil.example',
  'https://evil.example',
  '?url=https://evil.example',
  '#@evil.example',
  '@evil.example',
  '%2F%2Fevil.example',
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getMediaUrl — mediaId cannot change the request origin', () => {
  it.each(HOSTILE_MEDIA_IDS)(
    'keeps the token on the Graph origin for mediaId=%j',
    async (mediaId) => {
      const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc',
            mime_type: 'image/jpeg',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      vi.stubGlobal('fetch', fetchMock)

      await getMediaUrl({ mediaId, accessToken: ACCESS_TOKEN })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(new URL(url).origin).toBe(GRAPH_ORIGIN)
      expect(init.headers).toEqual({
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      })
    },
  )

  it('resolves the download URL only from the Graph response body', async () => {
    const graphMediaUrl =
      'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc'
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({ url: graphMediaUrl, mime_type: 'image/png' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await getMediaUrl({
      mediaId: 'media-1',
      accessToken: ACCESS_TOKEN,
    })

    expect(result).toEqual({
      url: graphMediaUrl,
      mimeType: 'image/png',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://graph.facebook.com/v21.0/media-1',
    )
  })
})
