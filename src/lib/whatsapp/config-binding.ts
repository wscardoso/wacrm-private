/**
 * `whatsapp_config` domain — Binding Context and write-enablement gate
 * for the Phase 3.2 cutover (IMP-CRYPTO-001 RC1.3 §3.4/§3.5).
 *
 * Binding Context formula: `whatsapp_config:{account_id}`. `whatsapp_config`
 * is unique-constrained on `account_id` (migration 017,
 * `whatsapp_config_account_id_key`), so `account_id` is available at every
 * call site before any database operation — including INSERT, where the
 * row's own `id` does not exist yet. See IMP §3.5 for the full analysis.
 *
 * Write-enablement follows the IMP §6 atomic-cutover design: `decrypt`
 * call sites move to `decryptWithBindingContext` unconditionally (it reads
 * both legacy and canonical ciphertext), while `encrypt` call sites stay
 * gated behind this flag so canonical writes only begin once the decrypt
 * path is confirmed live everywhere. Mirrors the existing
 * `WHATSAPP_ENABLE_ZAPI` env-flag idiom already used in this codebase
 * (`config/route.ts`).
 */

export function whatsappConfigBindingContext(accountId: string): string {
  return `whatsapp_config:${accountId}`
}

export function isWhatsappConfigCanonicalWriteEnabled(): boolean {
  return process.env.WHATSAPP_CONFIG_CANONICAL_WRITE === 'true'
}
