import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Loose comparison: same normalized digits, or same last 8 digits.
 *
 * ONLY safe for advisory surfaces ("possible duplicate" warnings) —
 * two genuinely different numbers can share their last 8 digits
 * across country/area codes, so treating this as identity would
 * attach one contact's messages to another. For identity decisions
 * (webhook attribution, find-or-create, import merge) use
 * `phonesMatchStrict` instead.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Strict identity comparison. True only when the two numbers are the
 * same subscriber written differently:
 *
 *   1. identical normalized digits, or
 *   2. one is the other with the country code omitted
 *      ("4155551212" vs "14155551212"), or
 *   3. they differ only by a trunk-prefix 0 after the country code
 *      ("370063949836" vs "37063949836" — see phoneVariants).
 *
 * Unlike `phonesMatch`, a bare last-8-digit collision between two
 * fully-qualified numbers with different country codes does NOT match.
 */
export function phonesMatchStrict(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (!n1 || !n2) return false
  if (n1 === n2) return true

  // Missing country code: the shorter number is a full suffix of the
  // longer one (7-digit minimum mirrors isValidE164's floor).
  const [shorter, longer] = n1.length <= n2.length ? [n1, n2] : [n2, n1]
  if (shorter.length >= 7 && longer.endsWith(shorter)) return true

  // Trunk-prefix 0 inserted/removed after the country code.
  return phoneVariants(n1).includes(n2) || phoneVariants(n2).includes(n1)
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}

/**
 * Try sending a WhatsApp message with phone-variant fallback.
 *
 * Meta sandboxes and numbers stored with/without a trunk 0 need
 * retrying across phoneVariants() before giving up. If a non-primary
 * variant lands the message we persist it back to the contact row
 * so future sends skip the retry loop.
 *
 * @param sanitized   Digits-only phone (output of sanitizePhoneForMeta)
 * @param contactId   Contact row id -- updated when a variant works
 * @param attempt     Caller-supplied send function; throws on failure
 * @param db          Supabase client with write access to contacts
 */
export async function sendWithPhoneVariantRetry(
  sanitized: string,
  contactId: string,
  attempt: (phone: string) => Promise<string>,
  db: SupabaseClient,
): Promise<{ result: string }> {
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null

  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }

  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contactId)
  }

  return { result: waMessageId }
}
