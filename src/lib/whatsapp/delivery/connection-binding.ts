import { createHash } from 'node:crypto'

// =============================================================================
// Delivery binding — the immutable snapshot of the channel an outbound message
// was created for. SINGLE source of the format: every writer and every retry
// check goes through this module; nothing else may compose the fingerprint.
//
// Why a snapshot and not just `whatsapp_config.id`: the config row is updated
// IN PLACE (provider, phone_number_id, instance_id, base_url, tokens) while its
// `id` stays. `connection_ref = config.id` therefore names the account's slot,
// not the channel the message was created for. A retry must be re-sent only
// through the same provider and the same channel (WhatsApp number / uazapi
// instance), so the channel is stored on the message and compared on retry.
//
// Persisted on `messages` (nullable, outbound only; migration 083):
//   connection_ref       whatsapp_config.id at creation (EIS-001 §3.2 semantics;
//                        becomes connections.id in E3 — no FK, by that decision)
//   delivery_provider    'meta' | 'uazapi'
//   delivery_channel_fp  `v1:<sha256 hex>` of the NON-SECRET channel identity
//
// Fingerprint contract (version v1)
//   input    provider-specific, normalised identity fields only:
//              meta   : phone_number_id
//              uazapi : instance_id, base_url
//            Tokens, verify tokens, waba_id and credentials embedded in a URL
//            are NEVER part of it. Fields of the other provider (stale columns
//            left by an earlier provider) are ignored.
//   normal.  strings: NFC, trimmed, must be non-empty. base_url: must be a valid
//            http(s) URL; reduced to `origin + pathname` with trailing slashes
//            removed (scheme/host lower-cased, default port dropped, userinfo,
//            query and hash discarded).
//   encoding JSON array, so field boundaries are unambiguous:
//              ["v1","meta","<phone_number_id>"]
//              ["v1","uazapi","<instance_id>","<normalised base_url>"]
//            UTF-8, hashed with SHA-256, stored as `v1:` + lower-case hex.
//   missing  or invalid required data => DeliveryBindingError. Nothing is ever
//            hashed with a placeholder, so absent data cannot collide with a
//            legitimate value.
//   stable   under token rotation and cosmetic URL changes; changes with
//            provider, number, instance or endpoint.
//   evolve   the `vN:` prefix. A reader that does not know a version treats the
//            binding as unprovable (blocks) instead of guessing; a new version
//            must be added here together with its normalisation.
// =============================================================================

export const SUPPORTED_DELIVERY_PROVIDERS = ['meta', 'uazapi'] as const
export type DeliveryProvider = (typeof SUPPORTED_DELIVERY_PROVIDERS)[number]

export const CHANNEL_FP_CURRENT_VERSION = 1

/** The columns of a `whatsapp_config` row that identify the channel. */
export interface ConnectionIdentityRow {
  id: string
  account_id?: string | null
  provider?: string | null
  phone_number_id?: string | null
  instance_id?: string | null
  base_url?: string | null
}

export interface DeliveryBinding {
  connection_ref: string
  delivery_provider: DeliveryProvider
  delivery_channel_fp: string
}

/** What a message row stores (all three may be NULL on legacy rows). */
export interface StoredBinding {
  connection_ref?: string | null
  delivery_provider?: string | null
  delivery_channel_fp?: string | null
}

export class DeliveryBindingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryBindingError'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FP_RE = /^v(\d+):([0-9a-f]{64})$/

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DeliveryBindingError(`${field} is missing`)
  const normalised = value.normalize('NFC').trim()
  if (normalised === '') throw new DeliveryBindingError(`${field} is empty`)
  return normalised
}

function normaliseBaseUrl(value: unknown): string {
  const text = requiredText(value, 'base_url')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new DeliveryBindingError('base_url is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DeliveryBindingError('base_url must be http(s)')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** Provider of a config row, applying the column default (`meta`). Throws for anything unsupported. */
export function deliveryProviderOf(row: { provider?: string | null }): DeliveryProvider {
  const provider = row.provider ?? 'meta'
  if ((SUPPORTED_DELIVERY_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as DeliveryProvider
  }
  throw new DeliveryBindingError(`unsupported provider "${String(row.provider)}"`)
}

export function computeChannelFingerprint(row: ConnectionIdentityRow): string {
  const provider = deliveryProviderOf(row)
  const payload =
    provider === 'meta'
      ? ['v1', 'meta', requiredText(row.phone_number_id, 'phone_number_id')]
      : ['v1', 'uazapi', requiredText(row.instance_id, 'instance_id'), normaliseBaseUrl(row.base_url)]
  const hex = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
  return `v${CHANNEL_FP_CURRENT_VERSION}:${hex}`
}

/** The binding to persist, in the same INSERT as the outbound message. */
export function bindingFromConnection(row: ConnectionIdentityRow): DeliveryBinding {
  if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) {
    throw new DeliveryBindingError('connection id is missing or not a uuid')
  }
  return {
    connection_ref: row.id,
    delivery_provider: deliveryProviderOf(row),
    delivery_channel_fp: computeChannelFingerprint(row),
  }
}

// ── Verification before a retry ──────────────────────────────────────────────

export type BindingBlockReason =
  | 'binding_missing'        // a legacy message, or a message created without the snapshot
  | 'binding_invalid'        // present but malformed / unknown version / unsupported provider
  | 'connection_removed'     // the config row no longer exists
  | 'connection_mismatch'    // the config row found is not the one recorded
  | 'account_mismatch'       // config.account_id !== conversation.account_id
  | 'provider_unsupported'   // the current config uses a provider that is no longer supported
  | 'provider_changed'       // the account now uses another provider
  | 'channel_unprovable'     // the current config lacks the data to compute the fingerprint
  | 'channel_changed'        // same slot, different number / instance / endpoint

export type BindingVerdict =
  | { ok: true; provider: DeliveryProvider }
  | { ok: false; reason: BindingBlockReason; detail: string }

const block = (reason: BindingBlockReason, detail: string): BindingVerdict => ({ ok: false, reason, detail })

/**
 * Decides whether the connection that exists NOW is provably the channel the
 * message was created for. Pure and secret-free: it never receives a token.
 * Anything that cannot be proven is a block — there is no "probably the same".
 *
 * `conversationAccountId` comes from the message's own conversation, never from
 * the connection or from the request.
 */
export function evaluateBinding(args: {
  stored: StoredBinding
  conversationAccountId: string | null | undefined
  connection: ConnectionIdentityRow | null
}): BindingVerdict {
  const { stored, connection } = args

  if (!stored.connection_ref && !stored.delivery_provider && !stored.delivery_channel_fp) {
    return block('binding_missing', 'message has no delivery binding (created before the binding existed)')
  }
  if (!stored.connection_ref || !stored.delivery_provider || !stored.delivery_channel_fp) {
    return block('binding_invalid', 'delivery binding is incomplete')
  }
  if (!UUID_RE.test(stored.connection_ref)) {
    return block('binding_invalid', 'connection_ref is not a uuid')
  }
  if (!(SUPPORTED_DELIVERY_PROVIDERS as readonly string[]).includes(stored.delivery_provider)) {
    return block('binding_invalid', `recorded provider "${stored.delivery_provider.slice(0, 40)}" is not supported`)
  }
  const fpMatch = FP_RE.exec(stored.delivery_channel_fp)
  if (!fpMatch) return block('binding_invalid', 'delivery_channel_fp is malformed')
  if (Number(fpMatch[1]) !== CHANNEL_FP_CURRENT_VERSION) {
    return block('binding_invalid', `delivery_channel_fp version v${fpMatch[1]} is not understood`)
  }

  if (!connection) return block('connection_removed', 'the recorded connection no longer exists')
  if (connection.id !== stored.connection_ref) {
    return block('connection_mismatch', 'the connection found is not the recorded one')
  }
  if (!args.conversationAccountId || !connection.account_id || connection.account_id !== args.conversationAccountId) {
    return block('account_mismatch', 'the connection does not belong to the conversation\'s account')
  }

  let provider: DeliveryProvider
  try {
    provider = deliveryProviderOf(connection)
  } catch {
    return block('provider_unsupported', `the connection now uses "${String(connection.provider).slice(0, 40)}", which is not supported`)
  }
  if (provider !== stored.delivery_provider) {
    return block('provider_changed', `the connection now uses ${provider}; the message was created for ${stored.delivery_provider}`)
  }

  let current: string
  try {
    current = computeChannelFingerprint(connection)
  } catch (err) {
    return block('channel_unprovable', err instanceof Error ? err.message : 'cannot compute the channel fingerprint')
  }
  if (current !== stored.delivery_channel_fp) {
    return block('channel_changed', 'the number / instance / endpoint of the connection changed since the message was created')
  }
  return { ok: true, provider }
}
