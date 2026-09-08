"use client";

import { useEffect, useRef, useState } from "react";

/**
 * S2 (plans/001-private-media-buckets-s2.md), Step 4 — chat-media and
 * flow-media are private post-migration-076, so a stored `media_url`
 * (the old permanent public URL shape) is no longer directly
 * fetchable by the browser. This hook resolves it to a short-lived
 * signed URL via `POST /api/media/resolve` on mount, memoized by
 * `url` so re-renders don't re-fetch.
 *
 * Returns the raw `url` optimistically until the resolved value comes
 * back (matches this repo's existing loading-state convention in
 * message-bubble.tsx's `MediaImage`, which shows a spinner rather
 * than nothing while a similar async load is in flight — here we
 * instead show the best-guess URL immediately since most callers
 * don't have a dedicated loading slot). A URL that isn't recognizably
 * one of our buckets (inbound Meta-hosted media, ad creative, etc.)
 * comes back unchanged from `/api/media/resolve` — this hook is safe
 * to point at ANY stored URL, not just ones known to be ours.
 *
 * On a resolve failure (e.g. network error, or a genuine RLS denial
 * for a foreign-account path) this keeps the raw `url` rather than
 * clearing it — the caller's own `onError` (e.g. `<img onError>`)
 * already handles "media failed to load" degradation; there's no
 * separate error state to plumb through here.
 */
export function useResolvedMediaUrl(url: string | null | undefined): string {
  const [resolved, setResolved] = useState(url ?? "");
  const requestedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!url) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResolved("");
      requestedFor.current = null;
      return;
    }
    // Optimistic value for the new src immediately, then attempt to
    // resolve it. Guards against re-fetching for a `url` this effect
    // has already resolved (e.g. an unrelated re-render).
    setResolved(url);
    if (requestedFor.current === url) return;
    requestedFor.current = url;

    let cancelled = false;
    fetch("/api/media/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`resolve failed: ${res.status}`))))
      .then((data: { url?: string }) => {
        if (!cancelled && data?.url) setResolved(data.url);
      })
      .catch(() => {
        // Keep the optimistic raw url — see doc comment above.
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return resolved;
}

/**
 * Render-prop wrapper around `useResolvedMediaUrl` for call sites that
 * would rather not manage the hook directly. `children` receives the
 * resolved (or, until then, raw) URL.
 */
export function AccountMedia({
  src,
  children,
}: {
  src: string | null | undefined;
  children: (resolvedSrc: string) => React.ReactNode;
}) {
  const resolvedSrc = useResolvedMediaUrl(src);
  return <>{children(resolvedSrc)}</>;
}
