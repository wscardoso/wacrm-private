/**
 * uazapi target resolution — which server may receive which credential.
 *
 * The stored uazapi instance token (whatsapp_config.access_token) is an
 * account secret. The connection-status and QR routes used to merge the stored
 * row with caller-supplied values field by field (`baseUrl || config.base_url`,
 * `token || decrypt(config.access_token)`), so a caller could pair the stored
 * token with a `baseUrl` of their own choosing and make the server send it
 * there.
 *
 * Rules enforced here, as a pure function (no I/O, no clock, no env):
 *
 *   1. A token supplied by the caller is the caller's own credential and may
 *      go to the host the caller names. Whether that host is a *safe network
 *      destination* (private ranges, DNS rebinding, redirects at connection
 *      time) is NOT decided here; that is the job of the outbound HTTP layer.
 *   2. The stored token is only ever paired with the stored base_url. If the
 *      request names a different server, the stored token is neither
 *      decrypted nor used: the caller must provide a token for it.
 *   3. When the stored token is used, the returned baseUrl is the stored
 *      string, never the request's spelling of it.
 */

export interface StoredUazapi {
  base_url: string | null
  instance_id: string | null
  /** Ciphertext as stored; only decrypted through `decryptStored`. */
  access_token: string | null
}

export interface RequestedUazapi {
  baseUrl?: string | null
  instanceId?: string | null
  token?: string | null
}

export type UazapiTarget =
  | {
      ok: true
      baseUrl: string
      instanceId: string
      token: string
      tokenSource: 'request' | 'stored'
    }
  | { ok: false; code: 'incomplete' | 'invalid_base_url' | 'token_required_for_new_host' }

/**
 * Canonical identity of a uazapi server, or null if `raw` is not an acceptable
 * base URL. It is derived with the WHATWG URL parser, the same parser `fetch`
 * uses to decide where to connect, so two spellings that are equal here reach
 * the same origin and two that differ here never get conflated.
 *
 * Normalised: scheme and host case, trailing dot of a fully-qualified host,
 * default port (dropped by the parser), IDN to punycode, trailing slashes of
 * the path, backslashes (parsed as `/`).
 * Rejected: non-http(s) schemes, embedded credentials, query, fragment.
 */
export function canonicalizeBaseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || url.search || url.hash) return null
  const host = url.hostname.replace(/\.$/, '').toLowerCase()
  if (!host) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${path}`
}

const clean = (v: string | null | undefined): string | undefined => v?.trim() || undefined

export function resolveUazapiTarget(
  request: RequestedUazapi,
  stored: StoredUazapi | null,
  decryptStored: () => string,
): UazapiTarget {
  const reqBase = clean(request.baseUrl)
  const reqInstance = clean(request.instanceId)
  const reqToken = clean(request.token)

  // Rule 1: the caller's own credential.
  if (reqToken) {
    const baseUrl = reqBase ?? clean(stored?.base_url)
    const instanceId = reqInstance ?? clean(stored?.instance_id)
    if (!baseUrl || !instanceId) return { ok: false, code: 'incomplete' }
    if (!canonicalizeBaseUrl(baseUrl)) return { ok: false, code: 'invalid_base_url' }
    return { ok: true, baseUrl, instanceId, token: reqToken, tokenSource: 'request' }
  }

  // Rules 2 and 3: the stored credential, bound to the stored server.
  const storedBase = clean(stored?.base_url)
  if (!storedBase || !stored?.access_token) return { ok: false, code: 'incomplete' }

  if (reqBase) {
    const requested = canonicalizeBaseUrl(reqBase)
    const authorized = canonicalizeBaseUrl(storedBase)
    if (!requested || !authorized) return { ok: false, code: 'invalid_base_url' }
    // Divergent target: bail out BEFORE touching the ciphertext.
    if (requested !== authorized) return { ok: false, code: 'token_required_for_new_host' }
  }

  const instanceId = reqInstance ?? clean(stored.instance_id)
  if (!instanceId) return { ok: false, code: 'incomplete' }

  let token: string
  try {
    token = decryptStored()
  } catch {
    return { ok: false, code: 'incomplete' }
  }
  if (!token) return { ok: false, code: 'incomplete' }

  return { ok: true, baseUrl: storedBase, instanceId, token, tokenSource: 'stored' }
}
