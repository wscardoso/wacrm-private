import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * S2 (plans/001-private-media-buckets-s2.md) — chat-media and
 * flow-media stopped being public buckets (migration 076). Every
 * `media_url` already stored in `messages.media_url` / a flow node's
 * `media_url` config / a template's header handle is still the OLD
 * permanent public URL shape:
 *
 *   .../storage/v1/object/public/<bucket>/<path>
 *
 * That URL now 403s. This module is the single place that turns one
 * of those stored URLs into a short-lived signed URL at the moment
 * it's actually needed — server-side, right before dispatch to Meta
 * (`resolveSignedMediaUrl` + `MEDIA_SIGNED_URL_TTL_SECONDS`), or
 * client-side, right before rendering (`MEDIA_SIGNED_URL_TTL_SECONDS_UI`
 * via `/api/media/resolve`).
 *
 * Anyone adding a new place that stores or renders `media_url` in the
 * future must route through here (server) or `<AccountMedia>`
 * (client) — a new direct `getPublicUrl()` / raw `<img src>` usage
 * silently reintroduces the cross-tenant read this plan closes.
 */

const RECOGNIZED_BUCKETS = ["chat-media", "flow-media"] as const;
type RecognizedBucket = (typeof RECOGNIZED_BUCKETS)[number];

/** 24h — the send path needs to outlive provider-side retries. */
export const MEDIA_SIGNED_URL_TTL_SECONDS = 86400;
/** 1h — the UI signs on every page load, so it doesn't need a long TTL. */
export const MEDIA_SIGNED_URL_TTL_SECONDS_UI = 3600;

/**
 * Parse a Supabase public-storage URL for exactly the two account-scoped
 * buckets this plan covers. Returns `null` for anything else — a
 * Meta-hosted inbound URL (e.g. `https://lookaside.fbsbx.com/...`), the
 * `avatars` bucket, or garbage input. Callers must no-op (pass the input
 * through unchanged) on `null` rather than assume every `media_url` is
 * ours.
 */
export function parseAccountBucketPath(
  url: string,
): { bucket: RecognizedBucket; path: string } | null {
  if (!url) return null;

  const marker = "/storage/v1/object/public/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;

  const rest = url.slice(idx + marker.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;

  const bucket = rest.slice(0, slashIdx);
  const rawPath = rest.slice(slashIdx + 1);
  if (!rawPath) return null;

  if (!(RECOGNIZED_BUCKETS as readonly string[]).includes(bucket)) return null;

  // Strip a query string / fragment if present (defensive — stored URLs
  // from getPublicUrl() never carry one, but a hand-edited value might).
  const path = rawPath.split(/[?#]/)[0];
  if (!path) return null;

  return { bucket: bucket as RecognizedBucket, path: decodeURIComponent(path) };
}

/**
 * Resolve a stored `media_url` to a fetchable URL at the moment it's
 * needed. Pass-through (returns `url` unchanged) for anything that isn't
 * recognizably one of our two account-scoped buckets. For a recognized
 * URL, mints a fresh signed URL via Storage — which is also where the
 * SELECT RLS policy from migration 076 gets enforced: a caller whose
 * session can't see that path fails `createSignedUrl` and this throws,
 * rather than silently falling back to the broken public URL.
 */
export async function resolveSignedMediaUrl(
  supabase: SupabaseClient,
  url: string,
  expirySeconds: number,
): Promise<string> {
  const parsed = parseAccountBucketPath(url);
  if (!parsed) return url;

  const { data, error } = await supabase.storage
    .from(parsed.bucket)
    .createSignedUrl(parsed.path, expirySeconds);

  if (error || !data?.signedUrl) {
    throw new Error(
      error?.message ?? `Failed to create signed URL for ${parsed.bucket}/${parsed.path}`,
    );
  }

  return data.signedUrl;
}
