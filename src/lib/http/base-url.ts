// ============================================================
// getBaseUrl — resolve the public-facing origin of this deployment
// from an incoming Request.
//
// Why this exists
// ----------------
// Any server route that needs to build an absolute, self-referential
// URL (invite links, auth email redirects) cannot just read
// `new URL(request.url).origin`. That reflects whatever `Host` the
// Node process itself received — and on a typical reverse-proxied
// deploy (Hostinger Managed Node.js, Vercel, Cloudflare, nginx) the
// proxy commonly does NOT forward the original `Host` unless
// explicitly configured to. When it doesn't, `request.url` silently
// resolves to the proxy's internal upstream target (e.g.
// `http://localhost:3000`), and every link built from it points
// there instead of the real public domain.
//
// This bit the /auth/callback route directly: password-reset and
// magic-link emails redirected users to `localhost:3000` in
// production because the route trusted `new URL(request.url).origin`
// verbatim. This helper is the fix, extracted from the resolution
// logic originally written for POST /api/account/invitations (which
// hit the same class of bug first) so every route that needs a
// public base URL shares one hardened implementation instead of
// re-deriving it ad hoc.
//
// Resolution order, first match wins:
//
//   1. `NEXT_PUBLIC_SITE_URL` — operator's explicit config. Trumps
//      everything; if set, that's where links point.
//   2. `X-Forwarded-Host` (+ `X-Forwarded-Proto`) — set by every
//      reverse proxy in front of the app when configured correctly.
//      This is what makes links Just Work in production without
//      forcing the operator to set an env var.
//   3. `Host` header + the protocol the request arrived on — bare
//      deployments without a proxy.
//   4. Last-resort fallback to the canonical production domain. Only
//      hit if the request has no Host header at all (essentially
//      impossible from a real browser) or the allow-list rejected
//      every candidate. Logs a warning so the operator can spot the
//      misconfig.
//
// Defense-in-depth: `ALLOWED_INVITE_HOSTS`
// -----------------------------------------
// The request-header path (#2 and #3 above) trusts whatever hostname
// the client (or proxy) puts in the header. On a typical proxied
// deploy the proxy overwrites these so they're trustworthy. On a bare
// deployment exposed to the public internet, an attacker could send a
// request directly with a crafted `Host: phishing.example` and
// receive a link pointing at their site.
//
// When `ALLOWED_INVITE_HOSTS` is set (comma-separated hostnames), we
// validate the derived host against the list. Anything not on the
// list falls through to the fallback domain with a loud
// console.warn. Operators who care about this attack surface should
// set this to their canonical hostnames; everyone else gets the
// permissive (but still `X-Forwarded-Host`-aware) default.
//
// The env var name is shared across every caller of this module
// (invitations, auth callback, and any future one) rather than
// namespaced per-feature — it's the same "which hosts is this app
// instance allowed to build absolute URLs for" question everywhere
// it's asked.
// ============================================================

const FALLBACK_BASE_URL = "https://forcecrm.digitallforcelabs.cloud";

function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function isHostAllowed(
  hostname: string,
  allowList: readonly string[] | null,
): boolean {
  if (!allowList) return true; // No allow-list → permissive (legacy behavior).
  return allowList.includes(hostname.toLowerCase());
}

/**
 * Resolve the public base URL (scheme + host, no trailing slash) for
 * the deployment handling `request`. See module doc comment above
 * for the full resolution order and rationale.
 */
export function getBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const allowList = parseAllowedHosts();
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost && isHostAllowed(forwardedHost, allowList)) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }

  const host = request.headers.get("host")?.trim();
  if (host && isHostAllowed(host, allowList)) {
    // The protocol on `request.url` is whatever the framework saw —
    // reliable for bare deployments where no proxy is rewriting it.
    const reqProto = new URL(request.url).protocol.replace(":", "");
    return `${reqProto}://${host}`;
  }

  // We fall through here when EITHER no Host header was present at
  // all (essentially impossible from a real browser) OR an
  // ALLOWED_INVITE_HOSTS list was set and neither candidate matched
  // it. The warning is the operator's signal that someone is
  // probing the app with a spoofed Host header — or, in the
  // /auth/callback case, that the reverse proxy still isn't
  // forwarding Host/X-Forwarded-Host correctly.
  if (allowList && (forwardedHost || host)) {
    console.warn(
      "[getBaseUrl] rejected non-allow-listed host:",
      { forwardedHost, host, allowList },
    );
  } else {
    console.warn(
      "[getBaseUrl] could not derive base URL from request; falling back to canonical domain",
    );
  }
  return FALLBACK_BASE_URL;
}
