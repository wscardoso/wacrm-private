// ============================================================
// IMP-E7-001 Phase 4 — KID convergence detection (ADR-E7-001 §13.2).
//
// Pure detection helper shared by both recognized convergence
// strategies (lazy self-heal on read, administrative sweep): given a
// stored ciphertext string and the Key Ring's current write KID,
// determines whether the value is a canonical envelope encrypted under
// a KID other than the current one — the trigger condition for
// reconverging it. Never decrypts, never re-encrypts; callers already
// hold (or already call) decryptWithBindingContext/
// encryptWithBindingContext for that, exactly as the existing
// legacy->canonical self-heal (isLegacyFormat) does.
//
// Uses only envelope.ts's and keyring.ts's existing public exports
// (decodeBase64url, recognizeFormat, parseCanonical, createDefaultKeyRing)
// — both files are frozen for the entirety of IMP-E7-001 (§3) and are
// not modified by this module.
// ============================================================

import { recognizeFormat, decodeBase64url, parseCanonical } from './envelope'
import { createDefaultKeyRing } from './keyring'

/**
 * True iff `stored` is a canonical envelope whose embedded KID differs
 * from `currentWriteKid`. Legacy formats and invalid/malformed envelopes
 * return false — those are the domain of the existing legacy->canonical
 * self-heal (isLegacyFormat), not KID convergence, and are left for the
 * caller's own decrypt call to surface (this helper never throws).
 */
export function needsKidConvergence(stored: string, currentWriteKid: string): boolean {
  if (recognizeFormat(stored).format !== 'canonical') {
    return false
  }
  try {
    const envelope = parseCanonical(decodeBase64url(stored))
    return envelope.kid !== currentWriteKid
  } catch {
    return false
  }
}

/**
 * The Key Ring's current write KID — the convergence target. Thin
 * wrapper so call sites never construct a KeyRing themselves; if
 * ADR-E7-001 rotation changes what createDefaultKeyRing() returns, this
 * is the only place that needs no change (it just reads the new value).
 */
export function getCurrentWriteKid(): string {
  return createDefaultKeyRing().getWriteKey().kid
}
