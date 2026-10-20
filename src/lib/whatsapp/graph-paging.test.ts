import { describe, expect, it } from 'vitest'
import { UntrustedPagingUrlError, assertSameGraphEndpoint } from './graph-paging'

const ENDPOINT =
  'https://graph.facebook.com/v21.0/waba-1/message_templates?limit=100&fields=id,name,language'

describe('assertSameGraphEndpoint: accepted', () => {
  it.each([
    ['a new cursor', `${ENDPOINT}&after=QVFIU`],
    ['a different query entirely', 'https://graph.facebook.com/v21.0/waba-1/message_templates?after=abc&limit=25'],
    ['the same URL', ENDPOINT],
    ['no query', 'https://graph.facebook.com/v21.0/waba-1/message_templates'],
    ['an explicit default port', 'https://graph.facebook.com:443/v21.0/waba-1/message_templates?after=x'],
    ['upper-case host', 'https://GRAPH.FACEBOOK.COM/v21.0/waba-1/message_templates?after=x'],
  ])('%s', (_label, next) => {
    const result = assertSameGraphEndpoint(next, ENDPOINT)
    expect(new URL(result).hostname).toBe('graph.facebook.com')
    expect(new URL(result).pathname).toBe('/v21.0/waba-1/message_templates')
  })

  it('returns a normalised URL string', () => {
    expect(assertSameGraphEndpoint(`${ENDPOINT}&after=1`, ENDPOINT)).toBe(new URL(`${ENDPOINT}&after=1`).toString())
  })
})

describe('assertSameGraphEndpoint: refused', () => {
  it.each([
    ['another host', 'https://evil.example/v21.0/waba-1/message_templates?after=x'],
    ['look-alike suffix', 'https://graph.facebook.com.evil.example/v21.0/waba-1/message_templates'],
    ['look-alike prefix', 'https://evilgraph.facebook.com/v21.0/waba-1/message_templates'],
    ['sub-domain', 'https://x.graph.facebook.com/v21.0/waba-1/message_templates'],
    ['plain http', 'http://graph.facebook.com/v21.0/waba-1/message_templates'],
    ['other port', 'https://graph.facebook.com:8443/v21.0/waba-1/message_templates'],
    ['userinfo that spells the right host', 'https://graph.facebook.com@evil.example/v21.0/waba-1/message_templates'],
    ['credentials', 'https://user:pw@graph.facebook.com/v21.0/waba-1/message_templates'],
    ['another WABA', 'https://graph.facebook.com/v21.0/waba-2/message_templates'],
    ['another API version', 'https://graph.facebook.com/v22.0/waba-1/message_templates'],
    ['another node', 'https://graph.facebook.com/v21.0/me/accounts'],
    ['a longer path', 'https://graph.facebook.com/v21.0/waba-1/message_templates/extra'],
    ['a path traversal that lands elsewhere', 'https://graph.facebook.com/v21.0/waba-1/message_templates/../../me'],
    ['a fragment', 'https://graph.facebook.com/v21.0/waba-1/message_templates?after=x#frag'],
    ['backslash host confusion', 'https://evil.example\\@graph.facebook.com/v21.0/waba-1/message_templates'],
    ['scheme-relative', '//evil.example/v21.0/waba-1/message_templates'],
    ['not a URL', 'not a url'],
    ['empty', ''],
    ['javascript scheme', 'javascript:alert(1)'],
    ['IP literal', 'https://157.240.1.1/v21.0/waba-1/message_templates'],
  ])('%s', (_label, next) => {
    expect(() => assertSameGraphEndpoint(next, ENDPOINT)).toThrow(UntrustedPagingUrlError)
  })

  it('the error does not echo the offending URL', () => {
    try {
      assertSameGraphEndpoint('https://secret-host.example/x', ENDPOINT)
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toBe('unexpected pagination URL')
      expect((error as Error).message).not.toMatch(/secret-host/)
    }
  })

  it('an unparseable reference endpoint refuses everything', () => {
    expect(() => assertSameGraphEndpoint('https://graph.facebook.com/x', 'not a url')).toThrow(UntrustedPagingUrlError)
  })
})
