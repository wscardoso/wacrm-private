// ============================================================
// IMP-E7-001 Phase 3 & Phase 5 — Key lifecycle governance
// (T5/T6/T7) + Convergence Attestation (T8).
//
// Phase 3: Application-layer wrapper around the append-only
// declare_kid_retired / revert_kid_retired / reactivate_kid RPCs
// (migration 057). This module is PURELY DECLARATIVE governance: it
// records intent for audit (RNF-5, ADR-E7-001 §8.0/§8.1) and is NEVER
// consulted by resolveKey()/getWriteKey() in keyring.ts — the KeyRing
// class is untouched by, and does not import, this file. Declaring a
// KID `Retired` here has zero effect on any decrypt/encrypt call site.
//
// Phase 5 (IMP-E7-001 Fase 5): Convergence Attestation
// (ADR-E7-001 §13.3) — structural precondition for T8 (Retired →
// Destroyed). The 4 properties of §13.3 are enforced server-side
// in migration 058; this module provides the typed application-layer
// wrappers.
//
// Mirrors the RPC-wrapper shape of
// src/lib/workspaces/update-workspace-identity.ts: requires an
// authenticated session, delegates ALL authorization to the RPC
// (admin-gated, SECURITY DEFINER), never accepts actor identity from
// the caller, translates Postgres errors into a typed, UI-safe result.
// ============================================================

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

export type KeyLifecycleEventType =
  | 'retired' // T6: DecryptOnly -> Retired
  | 'reverted_to_decrypt_only' // T7: Retired -> DecryptOnly
  | 'reactivated' // T5: Retired -> Active
  | 'destroyed' // T8: Retired -> Destroyed (Fase 5)

export interface KeyLifecycleEvent {
  id: number
  kid: string
  event_type: KeyLifecycleEventType
  actor_user_id: string
  reason: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export type KeyLifecycleErrorCode = 'validation' | 'unauthorized' | 'unexpected'

export interface KeyLifecycleError {
  code: KeyLifecycleErrorCode
  message: string
}

export type KeyLifecycleResult =
  | { success: true; event: KeyLifecycleEvent }
  | { success: false; error: KeyLifecycleError }

function translateRpcError(error: PostgrestError): KeyLifecycleError {
  switch (error.code) {
    case '42501':
      return {
        code: 'unauthorized',
        message: 'You are not authorized to manage key lifecycle state.',
      }
    case '22023':
      return {
        code: 'validation',
        message: error.message || 'Invalid key lifecycle request.',
      }
    case '23505':
      return {
        code: 'validation',
        message: error.message || 'A convergence attestation already exists for this KID.',
      }
    default:
      console.error('[keyLifecycle] unexpected RPC error:', error)
      return {
        code: 'unexpected',
        message: 'Failed to record key lifecycle event.',
      }
  }
}

type LifecycleRpcName = 'declare_kid_retired' | 'revert_kid_retired' | 'reactivate_kid'

async function callLifecycleRpc(
  rpcName: LifecycleRpcName,
  kid: string,
  reason: string | undefined,
  callerSupabase?: SupabaseClient,
): Promise<KeyLifecycleResult> {
  const supabase = callerSupabase ?? (await createClient())

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    }
  }

  const { data, error } = await supabase.rpc(rpcName, {
    p_kid: kid,
    p_reason: reason ?? null,
  })

  if (error) {
    return { success: false, error: translateRpcError(error) }
  }

  if (!data || typeof data !== 'object') {
    console.error(`[keyLifecycle] ${rpcName} returned no row:`, data)
    return { success: false, error: { code: 'unexpected', message: 'Failed to record key lifecycle event.' } }
  }

  return { success: true, event: data as KeyLifecycleEvent }
}

/**
 * T6: DecryptOnly -> Retired. Purely declarative (ADR-E7-001 §8.0/§8.1)
 * — never touches the Key Ring, never affects resolveKey()/getWriteKey().
 */
export async function declareKidRetired(
  kid: string,
  reason?: string,
  callerSupabase?: SupabaseClient,
): Promise<KeyLifecycleResult> {
  return callLifecycleRpc('declare_kid_retired', kid, reason, callerSupabase)
}

/**
 * T7: Retired -> DecryptOnly (reversal). Reversible at any time, no
 * precondition (ADR-E7-001 §8.3). Purely declarative.
 */
export async function revertKidRetired(
  kid: string,
  reason?: string,
  callerSupabase?: SupabaseClient,
): Promise<KeyLifecycleResult> {
  return callLifecycleRpc('revert_kid_retired', kid, reason, callerSupabase)
}

/**
 * T5: Retired -> Active (reactivation), including the "late rollback"
 * scenario of ADR-E7-001 §12. Purely declarative — the actual
 * promotion (I4-preserving atomic KeyRing replacement) is a separate,
 * operational step (ADR-E7-001 §9/§11), not performed by this function.
 */
export async function reactivateKid(
  kid: string,
  reason?: string,
  callerSupabase?: SupabaseClient,
): Promise<KeyLifecycleResult> {
  return callLifecycleRpc('reactivate_kid', kid, reason, callerSupabase)
}

/**
 * Reads the full lifecycle history for a KID, most recent first.
 * Read-only — relies on the table's RLS SELECT policy (platform
 * operators only, migration 057), never bypasses it with an elevated
 * client. Returns an empty array on error rather than throwing, since
 * this is an auditing/reporting helper, not a decision input for any
 * cryptographic operation.
 */
export async function getKeyLifecycleEvents(
  kid: string,
  callerSupabase?: SupabaseClient,
): Promise<KeyLifecycleEvent[]> {
  const supabase = callerSupabase ?? (await createClient())

  const { data, error } = await supabase
    .from('key_lifecycle_events')
    .select('*')
    .eq('kid', kid)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[keyLifecycle] getKeyLifecycleEvents error:', error)
    return []
  }

  return (data ?? []) as KeyLifecycleEvent[]
}

// ============================================================
// IMP-E7-001 Phase 5 — Convergence Attestation & Destroyed (T8).
// ============================================================

export interface ConvergenceAttestation {
  id: number
  kid: string
  inventory_version: number
  issued_by: string
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface DestroyKidResult {
  event: KeyLifecycleEvent
  attestation: ConvergenceAttestation
}

export interface DestroyableValidation {
  valid: boolean
  reason: string | null
  attestation: ConvergenceAttestation | null
  retired_event: KeyLifecycleEvent | null
}

export type ConvergenceAttestationResult =
  | { success: true; attestation: ConvergenceAttestation }
  | { success: false; error: KeyLifecycleError }

export type DestroyKidActionResult =
  | { success: true; result: DestroyKidResult }
  | { success: false; error: KeyLifecycleError }

export type DestroyableValidationResult =
  | { success: true; validation: DestroyableValidation }
  | { success: false; error: KeyLifecycleError }

/**
 * Issues a Convergence Attestation for a KID (ADR-E7-001 §13.3).
 * Requires an active platform admin session.
 *
 * The 4 properties are enforced server-side (migration 058):
 *   (1) separate table, not KeyRing config
 *   (2) kid + inventory_version are required, non-null
 *   (3) existence vs absence is the distinguisher
 *   (4) UNIQUE(kid) + ON CONFLICT DO NOTHING prevents overwrite
 */
export async function issueConvergenceAttestation(
  kid: string,
  inventoryVersion: number,
  metadata?: Record<string, unknown>,
  callerSupabase?: SupabaseClient,
): Promise<ConvergenceAttestationResult> {
  const supabase = callerSupabase ?? (await createClient())

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    }
  }

  const { data, error } = await supabase.rpc('issue_convergence_attestation', {
    p_kid: kid,
    p_inventory_version: inventoryVersion,
    p_metadata: metadata ?? null,
  })

  if (error) {
    return { success: false, error: translateRpcError(error) }
  }

  if (!data || typeof data !== 'object') {
    console.error('[keyLifecycle] issue_convergence_attestation returned no row:', data)
    return { success: false, error: { code: 'unexpected', message: 'Failed to issue convergence attestation.' } }
  }

  return { success: true, attestation: data as ConvergenceAttestation }
}

/**
 * Retrieves the Convergence Attestation for a KID, if any.
 * Read-only — relies on the table's RLS SELECT policy (platform
 * operators only, migration 058). Returns null if no attestation
 * exists (the distinguisher from §13.3 property 3).
 */
export async function getConvergenceAttestation(
  kid: string,
  callerSupabase?: SupabaseClient,
): Promise<ConvergenceAttestation | null> {
  const supabase = callerSupabase ?? (await createClient())

  const { data, error } = await supabase
    .from('convergence_attestations')
    .select('*')
    .eq('kid', kid)
    .maybeSingle()

  if (error) {
    console.error('[keyLifecycle] getConvergenceAttestation error:', error)
    return null
  }

  return data as ConvergenceAttestation | null
}

/**
 * Pre-flight check: validates that a KID meets both preconditions for
 * T8 (Retired → Destroyed):
 *   (a) a Convergence Attestation exists for this KID
 *   (b) the KID has been declared Retired (most recent lifecycle event)
 *
 * Returns the validation result plus the attestation and retired event,
 * so callers can display details. Never throws — errors are returned
 * as { success: false, error }.
 */
export async function validateKidDestroyable(
  kid: string,
  callerSupabase?: SupabaseClient,
): Promise<DestroyableValidationResult> {
  const supabase = callerSupabase ?? (await createClient())

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    }
  }

  const { data, error } = await supabase.rpc('validate_kid_destroyable', {
    p_kid: kid,
  })

  if (error) {
    return { success: false, error: translateRpcError(error) }
  }

  return { success: true, validation: data as DestroyableValidation }
}

/**
 * T8: Retired → Destroyed. Records the governance declaration,
 * gated by the same preconditions as validateKidDestroyable
 * (reuses the server-side validate_kid_destroyable function).
 *
 * Requires an active platform admin session.
 *
 * This is PURELY DECLARATIVE — it records the destroyed event in
 * the audit trail. The operational removal of the KID from KeyRing
 * configuration is a separate step (env/secret change).
 *
 * Prohibited transitions (enforced server-side):
 *   - T11: DecryptOnly → Destroyed (skipping Retired)
 *   - Destroy without valid attestation
 */
export async function destroyKid(
  kid: string,
  reason?: string,
  callerSupabase?: SupabaseClient,
): Promise<DestroyKidActionResult> {
  const supabase = callerSupabase ?? (await createClient())

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    }
  }

  const { data, error } = await supabase.rpc('destroy_kid', {
    p_kid: kid,
    p_reason: reason ?? null,
  })

  if (error) {
    return { success: false, error: translateRpcError(error) }
  }

  if (!data || typeof data !== 'object') {
    console.error('[keyLifecycle] destroy_kid returned no row:', data)
    return { success: false, error: { code: 'unexpected', message: 'Failed to destroy KID.' } }
  }

  return { success: true, result: data as DestroyKidResult }
}

/**
 * Lists all Convergence Attestations — all KIDs that could be
 * candidates for Destroyed (attestation exists, but may not yet
 * be Retired; cross-reference with getKeyLifecycleEvents).
 *
 * Read-only, platform operator scope.
 */
export async function listConvergenceAttestations(
  callerSupabase?: SupabaseClient,
): Promise<ConvergenceAttestation[]> {
  const supabase = callerSupabase ?? (await createClient())

  const { data, error } = await supabase
    .from('convergence_attestations')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[keyLifecycle] listConvergenceAttestations error:', error)
    return []
  }

  return (data ?? []) as ConvergenceAttestation[]
}

export interface InventoryVersionRow {
  id: number
  version: number
  updated_at: string
  // Null only for the migration-seeded bootstrap row (version 1) — every
  // bump via bump_inventory_version() always stamps a real auth.uid().
  updated_by: string | null
}

export type BumpInventoryVersionResult =
  | { success: true; inventoryVersion: InventoryVersionRow }
  | { success: false; error: KeyLifecycleError }

/**
 * Reads the currently tracked inventory version
 * (`docs/architecture/E7-ciphertext-surface-inventory.md`'s version
 * number, as recorded in `inventory_versions`). Returns null on error
 * or if unavailable — this is a display/reporting helper, callers that
 * need the authoritative value for a security decision should rely on
 * the server-side check inside `validate_kid_destroyable`/`destroy_kid`
 * (migration 058), never recompute it client-side.
 */
export async function getCurrentInventoryVersion(
  callerSupabase?: SupabaseClient,
): Promise<number | null> {
  const supabase = callerSupabase ?? (await createClient())

  const { data, error } = await supabase.rpc('get_current_inventory_version')

  if (error || typeof data !== 'number') {
    if (error) console.error('[keyLifecycle] getCurrentInventoryVersion error:', error)
    return null
  }

  return data
}

/**
 * Bumps the tracked inventory version by exactly 1 (migration 058:
 * `bump_inventory_version`). Requires an active platform admin session.
 * Strictly monotonic — the RPC rejects anything other than
 * current + 1, so versions can never be skipped or reused. `updated_by`
 * is always `auth.uid()`, never a caller argument.
 */
export async function bumpInventoryVersion(
  newVersion: number,
  callerSupabase?: SupabaseClient,
): Promise<BumpInventoryVersionResult> {
  const supabase = callerSupabase ?? (await createClient())

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return {
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    }
  }

  const { data, error } = await supabase.rpc('bump_inventory_version', {
    p_new_version: newVersion,
  })

  if (error) {
    return { success: false, error: translateRpcError(error) }
  }

  if (!data || typeof data !== 'object') {
    console.error('[keyLifecycle] bump_inventory_version returned no row:', data)
    return { success: false, error: { code: 'unexpected', message: 'Failed to bump inventory version.' } }
  }

  return { success: true, inventoryVersion: data as InventoryVersionRow }
}
