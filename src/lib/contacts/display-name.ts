/**
 * Display name for a contact in lists, feeds and headers.
 *
 * WhatsApp push-names are free text, so some contacts arrive with a
 * "name" that carries no readable content at all (".", "-", "  ").
 * Rendering that verbatim produced rows like "New message from .".
 * A name only counts when it has at least one letter or digit;
 * otherwise we fall back to the phone, and finally to null so the
 * caller can apply its own localized placeholder.
 *
 * Presentation only — the stored contact row is never modified.
 */
export function contactDisplayName(
  name: string | null | undefined,
  phone: string | null | undefined,
): string | null {
  const trimmed = name?.trim() ?? "";
  if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) return trimmed;
  const tel = phone?.trim() ?? "";
  return tel || null;
}
