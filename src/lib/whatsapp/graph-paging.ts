/**
 * Guard for Graph API pagination.
 *
 * Meta paginates by returning a `paging.next` URL inside the response body, and
 * callers fetch it with the account's Bearer token. A URL that arrives inside a
 * response is data from a third party: before the credential is sent to it, it
 * has to be the very same endpoint we started from. Only the query string (the
 * cursor) may differ.
 */

export class UntrustedPagingUrlError extends Error {
  constructor() {
    super('unexpected pagination URL')
    this.name = 'UntrustedPagingUrlError'
  }
}

/**
 * Returns `next` when it is the same Graph endpoint as `endpoint` (same scheme,
 * host, default port and path; no credentials, no fragment). Throws
 * UntrustedPagingUrlError otherwise, without echoing the offending URL.
 */
export function assertSameGraphEndpoint(next: string, endpoint: string): string {
  let nextUrl: URL
  let endpointUrl: URL
  try {
    nextUrl = new URL(next)
    endpointUrl = new URL(endpoint)
  } catch {
    throw new UntrustedPagingUrlError()
  }
  if (
    nextUrl.protocol !== 'https:' ||
    nextUrl.username ||
    nextUrl.password ||
    nextUrl.port !== '' ||
    nextUrl.hash ||
    nextUrl.hostname !== endpointUrl.hostname ||
    nextUrl.pathname !== endpointUrl.pathname
  ) {
    throw new UntrustedPagingUrlError()
  }
  return nextUrl.toString()
}
