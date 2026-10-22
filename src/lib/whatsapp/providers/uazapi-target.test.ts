import { describe, expect, it, vi } from 'vitest'
import {
  canonicalizeBaseUrl,
  resolveUazapiTarget,
  type RequestedUazapi,
  type StoredUazapi,
} from './uazapi-target'

// =============================================================
// Which server may receive which credential.
//
// resolveUazapiTarget is pure, so everything here runs without I/O. The key
// observable is `decryptStored`: for any request that names a server other
// than the stored one, the stored ciphertext must not even be decrypted.
//
// Scope note: this proves the stored token is bound to the stored base_url.
// It does NOT prove a destination is a safe network address (private ranges,
// DNS rebinding, connection-time checks); that belongs to the outbound HTTP
// layer.
// =============================================================

const STORED: StoredUazapi = {
  base_url: 'https://good.uazapi.dev',
  instance_id: 'inst-1',
  access_token: 'CIPHERTEXT',
}

function run(request: RequestedUazapi, stored: StoredUazapi | null = STORED) {
  const decrypt = vi.fn(() => 'STORED-TOKEN')
  const result = resolveUazapiTarget(request, stored, decrypt)
  return { result, decrypt }
}

describe('canonicalizeBaseUrl', () => {
  it.each([
    ['https://good.uazapi.dev', 'https://good.uazapi.dev'],
    ['https://GOOD.Uazapi.DEV/', 'https://good.uazapi.dev'],
    ['  https://good.uazapi.dev//  ', 'https://good.uazapi.dev'],
    ['https://good.uazapi.dev:443', 'https://good.uazapi.dev'],
    ['http://good.uazapi.dev:80', 'http://good.uazapi.dev'],
    ['https://good.uazapi.dev.', 'https://good.uazapi.dev'],
    ['https://good.uazapi.dev:8443/api/', 'https://good.uazapi.dev:8443/api'],
  ])('normalises %j', (raw, expected) => {
    expect(canonicalizeBaseUrl(raw)).toBe(expected)
  })

  it.each([
    ['empty', ''],
    ['not a URL', 'not a url'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
    ['ftp scheme', 'ftp://good.uazapi.dev'],
    ['embedded credentials', 'https://user:pass@good.uazapi.dev'],
    ['userinfo that looks like a host', 'https://good.uazapi.dev@evil.example'],
    ['query', 'https://good.uazapi.dev/?x=1'],
    ['fragment', 'https://good.uazapi.dev/#frag'],
    ['NUL in host', 'https://good.uazapi.dev\u0000.evil.example'],
  ])('rejects %s', (_label, raw) => {
    expect(canonicalizeBaseUrl(raw)).toBeNull()
  })
})

describe('stored token: positive cases (same authorized server)', () => {
  it.each([
    ['identical', 'https://good.uazapi.dev'],
    ['trailing slash', 'https://good.uazapi.dev/'],
    ['upper-case host', 'https://GOOD.UAZAPI.DEV'],
    ['explicit default port', 'https://good.uazapi.dev:443'],
    ['fully-qualified trailing dot', 'https://good.uazapi.dev.'],
    ['surrounding whitespace', '  https://good.uazapi.dev  '],
    // The WHATWG parser (the one fetch uses) maps the ideographic full stop
    // to '.', so this really is the same host and must not be refused.
    ['ideographic full stop', 'https://good。uazapi.dev'],
  ])('%s -> uses the stored token against the stored base_url', (_label, requested) => {
    const { result, decrypt } = run({ baseUrl: requested })
    expect(result).toEqual({
      ok: true,
      baseUrl: STORED.base_url, // the stored spelling, never the request's
      instanceId: 'inst-1',
      token: 'STORED-TOKEN',
      tokenSource: 'stored',
    })
    expect(decrypt).toHaveBeenCalledTimes(1)
  })

  it('no baseUrl in the request -> stored server and stored token', () => {
    const { result, decrypt } = run({})
    expect(result).toMatchObject({ ok: true, baseUrl: STORED.base_url, tokenSource: 'stored' })
    expect(decrypt).toHaveBeenCalledTimes(1)
  })

  it('blank baseUrl counts as absent', () => {
    const { result } = run({ baseUrl: '   ', instanceId: '  ', token: '  ' })
    expect(result).toMatchObject({ ok: true, tokenSource: 'stored', instanceId: 'inst-1' })
  })

  it('an instanceId override is still sent only to the stored server', () => {
    const { result } = run({ instanceId: 'other-instance' })
    expect(result).toMatchObject({
      ok: true,
      baseUrl: STORED.base_url,
      instanceId: 'other-instance',
      tokenSource: 'stored',
    })
  })

  it('IDN and punycode spellings are the same server', () => {
    const stored: StoredUazapi = { ...STORED, base_url: 'https://xn--bcher-kva.example' }
    const { result } = run({ baseUrl: 'https://bücher.example' }, stored)
    expect(result).toMatchObject({ ok: true, tokenSource: 'stored' })
  })

  it('alternative IPv4 spellings that the URL parser resolves to the stored literal', () => {
    const stored: StoredUazapi = { ...STORED, base_url: 'https://203.0.113.10' }
    const { result } = run({ baseUrl: 'https://0xCB.0.113.10' }, stored)
    expect(result).toMatchObject({ ok: true, tokenSource: 'stored' })
  })

  it('line breaks inside the host are stripped by the URL parser, so it is the same host', () => {
    const { result } = run({ baseUrl: 'https://good.\nuazapi.dev' })
    expect(result).toMatchObject({ ok: true, tokenSource: 'stored' })
  })
})

describe('stored token: negative cases (the stored token must NOT be decrypted)', () => {
  const DIVERGENT: Array<[string, string]> = [
    ['other domain', 'https://evil.example'],
    ['suffix attack', 'https://good.uazapi.dev.evil.example'],
    ['prefix attack', 'https://evil-good.uazapi.dev'],
    ['sub-domain', 'https://sub.good.uazapi.dev'],
    ['parent domain', 'https://uazapi.dev'],
    ['other port', 'https://good.uazapi.dev:8443'],
    ['scheme downgrade', 'http://good.uazapi.dev'],
    ['other path prefix', 'https://good.uazapi.dev/other'],
    ['backslash host confusion', 'https://evil.example\\@good.uazapi.dev'],
    ['IP literal', 'https://203.0.113.10'],
    ['IPv6 literal', 'https://[2001:db8::1]'],
    ['loopback', 'https://127.0.0.1'],
    ['homograph (U+0261)', 'https://ɡood.uazapi.dev'],
    ['stored host as a path segment', 'https://evil.example/good.uazapi.dev'],
  ]

  it.each(DIVERGENT)('%s -> token_required_for_new_host', (_label, requested) => {
    const { result, decrypt } = run({ baseUrl: requested })
    expect(result).toEqual({ ok: false, code: 'token_required_for_new_host' })
    expect(decrypt).not.toHaveBeenCalled()
  })

  const UNPARSEABLE: Array<[string, string]> = [
    ['userinfo that spells the stored host', 'https://good.uazapi.dev@evil.example'],
    ['credentials', 'https://user:pass@good.uazapi.dev'],
    ['fragment smuggling', 'https://evil.example#@good.uazapi.dev'],
    ['query smuggling', 'https://evil.example/?x=good.uazapi.dev'],
    ['query on the right host', 'https://good.uazapi.dev/?next=https://evil.example'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
    ['not a URL', 'not a url'],
    ['NUL in host', 'https://good.uazapi.dev\u0000.evil.example'],
  ]

  it.each(UNPARSEABLE)('%s -> invalid_base_url', (_label, requested) => {
    const { result, decrypt } = run({ baseUrl: requested })
    expect(result).toEqual({ ok: false, code: 'invalid_base_url' })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('even a decrypt that would throw is never reached for a divergent target', () => {
    const decrypt = vi.fn(() => {
      throw new Error('must not be called')
    })
    const result = resolveUazapiTarget({ baseUrl: 'https://evil.example' }, STORED, decrypt)
    expect(result).toEqual({ ok: false, code: 'token_required_for_new_host' })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('an invalid STORED base_url is never treated as a match', () => {
    const stored: StoredUazapi = { ...STORED, base_url: 'https://good.uazapi.dev/?x=1' }
    const { result, decrypt } = run({ baseUrl: 'https://good.uazapi.dev' }, stored)
    expect(result).toEqual({ ok: false, code: 'invalid_base_url' })
    expect(decrypt).not.toHaveBeenCalled()
  })
})

describe('caller-supplied token is the caller\'s own credential', () => {
  it('may be sent to the server the caller names; the stored token is not touched', () => {
    const { result, decrypt } = run({ baseUrl: 'https://my.own.server', token: 'CALLER-TOKEN' })
    expect(result).toEqual({
      ok: true,
      baseUrl: 'https://my.own.server',
      instanceId: 'inst-1',
      token: 'CALLER-TOKEN',
      tokenSource: 'request',
    })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('without baseUrl it falls back to the stored server (still the caller\'s token)', () => {
    const { result, decrypt } = run({ token: 'CALLER-TOKEN' })
    expect(result).toMatchObject({
      ok: true,
      baseUrl: STORED.base_url,
      token: 'CALLER-TOKEN',
      tokenSource: 'request',
    })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('works with no stored config at all', () => {
    const { result, decrypt } = run(
      { baseUrl: 'https://new.server', instanceId: 'i', token: 't' },
      null,
    )
    expect(result).toMatchObject({ ok: true, tokenSource: 'request' })
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('still rejects a base URL that cannot be parsed', () => {
    const { result } = run({ baseUrl: 'javascript:alert(1)', token: 't' })
    expect(result).toEqual({ ok: false, code: 'invalid_base_url' })
  })

  it('needs both a server and an instance', () => {
    expect(run({ token: 't' }, null).result).toEqual({ ok: false, code: 'incomplete' })
    expect(run({ baseUrl: 'https://x.example', token: 't' }, null).result).toEqual({
      ok: false,
      code: 'incomplete',
    })
  })
})

describe('incomplete stored configuration', () => {
  it.each([
    ['no config row', null],
    ['no stored token', { ...STORED, access_token: null }],
    ['no stored base_url', { ...STORED, base_url: null }],
    ['no stored instance', { ...STORED, instance_id: null }],
  ])('%s -> incomplete', (_label, stored) => {
    const { result } = run({}, stored as StoredUazapi | null)
    expect(result).toEqual({ ok: false, code: 'incomplete' })
  })

  it('a decrypt failure is "incomplete", not an exception', () => {
    const result = resolveUazapiTarget({}, STORED, () => {
      throw new Error('bad key')
    })
    expect(result).toEqual({ ok: false, code: 'incomplete' })
  })

  it('an empty decrypted token is "incomplete"', () => {
    expect(resolveUazapiTarget({}, STORED, () => '')).toEqual({ ok: false, code: 'incomplete' })
  })
})

describe('invariant over hostile inputs', () => {
  it('the stored token is released only for a request that canonicalises to the stored server', () => {
    const hostile = [
      'https://evil.example',
      'https://good.uazapi.dev.evil.example',
      'https://evil.example\\@good.uazapi.dev',
      'https://good.uazapi.dev@evil.example',
      'https://evil.example#@good.uazapi.dev',
      'https://good.uazapi.dev:8443',
      'http://good.uazapi.dev',
      'https://good.uazapi.dev/x',
      'https://[::1]',
      'https://2130706433',
      'https://0x7f.1',
      'https://localhost',
      'https://ɡood.uazapi.dev',
    ]
    for (const baseUrl of hostile) {
      const decrypt = vi.fn(() => 'STORED-TOKEN')
      const result = resolveUazapiTarget({ baseUrl }, STORED, decrypt)
      expect(result.ok, baseUrl).toBe(false)
      expect(decrypt, baseUrl).not.toHaveBeenCalled()
    }
  })
})
