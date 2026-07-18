import crypto from 'crypto'
import { supabaseAdmin } from '@/lib/supabase/admin-client'

// ============================================================
// ADR-SEC-001 (C7) — non-Meta webhook authentication helpers.
//
// The webhook URL contract is:
//   /api/whatsapp/webhook/{provider}/{connectionId}/{webhookSecret}
//
// The raw webhookSecret is never persisted. Only its SHA-256 hash is
// stored in whatsapp_config.webhook_secret_hash. Authentication compares
// the received secret's hash to the stored hash using a constant-time
// comparison so timing does not leak validity.
//
// Replay protection is explicitly OUT OF SCOPE for this round (see the
// ADR): C4 already de-duplicates repeated message_ids at the application
// layer, but that is not a cryptographic guarantee of request origin.
// ============================================================

/** Opaque, non-sequential public connection identifier. */
export function generateConnectionId(): string {
  return crypto.randomUUID()
}

/**
 * High-entropy shared secret for the webhook URL. 32 random bytes →
 * base64url (URL-safe, no padding). ~256 bits of entropy.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** SHA-256 hex digest of the raw secret. This is what gets persisted. */
export function hashWebhookSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex')
}

/**
 * Constant-time string equality. Both inputs are normalised to equal-length
 * buffers (SHA-256 hex is a fixed 64 chars) before comparison so the
 * comparison cost does not depend on where the first differing byte is.
 * Returns false when either side is missing/empty.
 */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  // Pad to the larger length so timingSafeEqual never throws on mismatch;
  // a length difference already implies inequality, but we still pay a
  // constant comparison cost rather than an early-out.
  const len = Math.max(bufA.length, bufB.length)
  const paddedA = Buffer.alloc(len)
  const paddedB = Buffer.alloc(len)
  bufA.copy(paddedA)
  bufB.copy(paddedB)
  return crypto.timingSafeEqual(paddedA, paddedB)
}

export interface BootstrapResult {
  connectionId: string
  /** Plaintext secret — revealed EXACTLY ONCE. Never persisted. */
  webhookSecret: string
}

export type BootstrapOutcome =
  | { status: 'ok'; result: BootstrapResult }
  /** Connection already initialized — bootstrap is idempotent-safe and
   *  refuses to silently overwrite an existing credential. Caller must
   *  pass `forceRotate: true` to rotate, or use a dedicated rotation path. */
  | { status: 'already_initialized' }
  /** No whatsapp_config row matches the given connection_id. */
  | { status: 'not_found' }
  /** DB write failed. */
  | { status: 'error'; message: string }

/**
 * Assisted-migration bootstrap for a single connection.
 *
 * Generates a connection_id (if the row lacks one), a high-entropy secret,
 * and persists ONLY its SHA-256 hash to whatsapp_config.webhook_secret_hash.
 * The plaintext secret is returned once and is the operator's responsibility
 * to copy into the Z-API / uazapi webhook URL. There is deliberately NO
 * fallback to the legacy verify_token.
 *
 * SAFETY: by default this REFUSES to overwrite an already-initialized
 * connection (webhook_secret_hash IS NOT NULL). A second call without an
 * explicit rotation intent would otherwise silently invalidate the live
 * webhook URL. To rotate an existing credential, pass `forceRotate: true`.
 *
 * This is a temporary, explicit mechanism — not a second permanent auth
 * path. Once the operator has configured the new URL, the legacy
 * verify_token is simply unused.
 */
export async function bootstrapConnection(
  connectionId: string,
  opts: { forceRotate?: boolean } = {},
): Promise<BootstrapOutcome> {
  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, connection_id, webhook_secret_hash')
    .eq('connection_id', connectionId)
    .maybeSingle()

  if (error || !config) return { status: 'not_found' }

  // Guard against silently clobbering a live credential.
  if (config.webhook_secret_hash && !opts.forceRotate) {
    return { status: 'already_initialized' }
  }

  const newConnectionId = config.connection_id ?? generateConnectionId()
  const secret = generateWebhookSecret()
  const hash = hashWebhookSecret(secret)

  const { error: updateError } = await supabaseAdmin()
    .from('whatsapp_config')
    .update({ connection_id: newConnectionId, webhook_secret_hash: hash })
    .eq('id', config.id)

  if (updateError) {
    return { status: 'error', message: updateError.message }
  }

  return { status: 'ok', result: { connectionId: newConnectionId, webhookSecret: secret } }
}
