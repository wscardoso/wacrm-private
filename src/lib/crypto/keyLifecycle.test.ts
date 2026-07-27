import { describe, it, expect, vi } from 'vitest'
import {
  declareKidRetired,
  revertKidRetired,
  reactivateKid,
  getKeyLifecycleEvents,
  issueConvergenceAttestation,
  getConvergenceAttestation,
  validateKidDestroyable,
  destroyKid,
  listConvergenceAttestations,
  bumpInventoryVersion,
  getCurrentInventoryVersion,
} from './keyLifecycle'

// ─── Fake Supabase client — always injected explicitly (callerSupabase),
// so createClient()/next/headers cookies() is never invoked in this
// unit test. Mirrors the injectable-client pattern already used by
// update-workspace-identity.ts. ────────────────────────────────────────

const USER = { id: 'user-1' }

function fakeClient(overrides?: {
  user?: typeof USER | null
  rpcImpl?: (name: string, params: Record<string, unknown>) => { data: unknown; error: unknown }
  fromImpl?: () => { data: unknown; error: unknown }
}) {
  const user = overrides?.user === undefined ? USER : overrides.user
  const rpcImpl = overrides?.rpcImpl ?? (() => ({ data: null, error: null }))
  const fromImpl = overrides?.fromImpl ?? (() => ({ data: [], error: null }))

  return {
    auth: {
      getUser: async () => ({ data: { user } }),
    },
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => rpcImpl(name, params)),
    from: vi.fn(() => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => fromImpl(),
        order: () => fromImpl(),
      }
      return chain
    }),
  } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('declareKidRetired — T6', () => {
  it('returns the persisted event on success', async () => {
    const event = {
      id: 1,
      kid: 'ACTIVE_V1',
      event_type: 'retired',
      actor_user_id: USER.id,
      reason: 'converged',
      metadata: null,
      created_at: '2026-01-01T00:00:00Z',
    }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('declare_kid_retired')
        expect(params).toEqual({ p_kid: 'ACTIVE_V1', p_reason: 'converged' })
        return { data: event, error: null }
      },
    })

    const result = await declareKidRetired('ACTIVE_V1', 'converged', client)

    expect(result).toEqual({ success: true, event })
  })

  it('fails with unauthorized when no session user is present', async () => {
    const client = fakeClient({ user: null })
    const result = await declareKidRetired('ACTIVE_V1', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('translates a 42501 RPC error to unauthorized', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '42501', message: 'nope' } }),
    })
    const result = await declareKidRetired('ACTIVE_V1', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'You are not authorized to manage key lifecycle state.' },
    })
  })

  it('translates a 22023 RPC error to validation', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '22023', message: 'kid must not be empty' } }),
    })
    const result = await declareKidRetired('', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'validation', message: 'kid must not be empty' },
    })
  })

  it('translates an unrecognized RPC error code to unexpected', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '99999', message: 'weird' } }),
    })
    const result = await declareKidRetired('ACTIVE_V1', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unexpected', message: 'Failed to record key lifecycle event.' },
    })
  })
})

describe('revertKidRetired — T7', () => {
  it('calls the revert_kid_retired RPC and returns the persisted event', async () => {
    const event = {
      id: 2,
      kid: 'ACTIVE_V1',
      event_type: 'reverted_to_decrypt_only',
      actor_user_id: USER.id,
      reason: null,
      metadata: null,
      created_at: '2026-01-02T00:00:00Z',
    }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('revert_kid_retired')
        expect(params).toEqual({ p_kid: 'ACTIVE_V1', p_reason: null })
        return { data: event, error: null }
      },
    })

    const result = await revertKidRetired('ACTIVE_V1', undefined, client)
    expect(result).toEqual({ success: true, event })
  })
})

describe('reactivateKid — T5', () => {
  it('calls the reactivate_kid RPC and returns the persisted event', async () => {
    const event = {
      id: 3,
      kid: 'ACTIVE_V1',
      event_type: 'reactivated',
      actor_user_id: USER.id,
      reason: 'late rollback',
      metadata: null,
      created_at: '2026-01-03T00:00:00Z',
    }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('reactivate_kid')
        expect(params).toEqual({ p_kid: 'ACTIVE_V1', p_reason: 'late rollback' })
        return { data: event, error: null }
      },
    })

    const result = await reactivateKid('ACTIVE_V1', 'late rollback', client)
    expect(result).toEqual({ success: true, event })
  })
})

describe('getKeyLifecycleEvents', () => {
  it('returns the events for a KID, most-recent-first ordering delegated to the query', async () => {
    const events = [
      { id: 2, kid: 'ACTIVE_V1', event_type: 'reverted_to_decrypt_only', actor_user_id: USER.id, reason: null, metadata: null, created_at: '2026-01-02T00:00:00Z' },
      { id: 1, kid: 'ACTIVE_V1', event_type: 'retired', actor_user_id: USER.id, reason: null, metadata: null, created_at: '2026-01-01T00:00:00Z' },
    ]
    const client = fakeClient({ fromImpl: () => ({ data: events, error: null }) })

    const result = await getKeyLifecycleEvents('ACTIVE_V1', client)
    expect(result).toEqual(events)
  })

  it('returns an empty array (never throws) when the query errors', async () => {
    const client = fakeClient({ fromImpl: () => ({ data: null, error: { code: '42501', message: 'denied' } }) })
    const result = await getKeyLifecycleEvents('ACTIVE_V1', client)
    expect(result).toEqual([])
  })
})

// ============================================================
// Phase 5 — Convergence Attestation & Destroyed (T8)
// ============================================================

describe('issueConvergenceAttestation — §13.3', () => {
  it('returns the persisted attestation on success', async () => {
    const attestation = {
      id: 1,
      kid: 'DECRYPT_ONLY_V2',
      inventory_version: 2,
      issued_by: USER.id,
      metadata: null,
      created_at: '2026-06-01T00:00:00Z',
    }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('issue_convergence_attestation')
        expect(params).toEqual({ p_kid: 'DECRYPT_ONLY_V2', p_inventory_version: 2, p_metadata: null })
        return { data: attestation, error: null }
      },
    })

    const result = await issueConvergenceAttestation('DECRYPT_ONLY_V2', 2, undefined, client)
    expect(result).toEqual({ success: true, attestation })
  })

  it('passes metadata to the RPC when provided', async () => {
    const metadata = { verified_by: 'inventory-sweep-v1' }
    const attestation = {
      id: 2,
      kid: 'DECRYPT_ONLY_V2',
      inventory_version: 2,
      issued_by: USER.id,
      metadata,
      created_at: '2026-06-01T00:00:00Z',
    }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('issue_convergence_attestation')
        expect(params).toEqual({ p_kid: 'DECRYPT_ONLY_V2', p_inventory_version: 2, p_metadata: metadata })
        return { data: attestation, error: null }
      },
    })

    const result = await issueConvergenceAttestation('DECRYPT_ONLY_V2', 2, metadata, client)
    expect(result).toEqual({ success: true, attestation })
  })

  it('fails with unauthorized when no session user is present', async () => {
    const client = fakeClient({ user: null })
    const result = await issueConvergenceAttestation('DECRYPT_ONLY_V2', 2, undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('translates a 23505 RPC error to validation (duplicate attestation)', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "convergence_attestations_kid_key"' } }),
    })
    const result = await issueConvergenceAttestation('DECRYPT_ONLY_V2', 2, undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'validation', message: 'duplicate key value violates unique constraint "convergence_attestations_kid_key"' },
    })
  })

  it('translates a 22023 RPC error to validation (invalid inventory version)', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '22023', message: 'inventory_version must be >= 1' } }),
    })
    const result = await issueConvergenceAttestation('DECRYPT_ONLY_V2', 0, undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'validation', message: 'inventory_version must be >= 1' },
    })
  })

  it('translates an unrecognized RPC error code to unexpected', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '99999', message: 'weird' } }),
    })
    const result = await issueConvergenceAttestation('DECRYPT_ONLY_V2', 2, undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unexpected', message: 'Failed to record key lifecycle event.' },
    })
  })
})

describe('getConvergenceAttestation', () => {
  it('returns the attestation when it exists', async () => {
    const attestation = {
      id: 1,
      kid: 'DECRYPT_ONLY_V2',
      inventory_version: 2,
      issued_by: USER.id,
      metadata: null,
      created_at: '2026-06-01T00:00:00Z',
    }
    const client = fakeClient({ fromImpl: () => ({ data: attestation, error: null }) })

    const result = await getConvergenceAttestation('DECRYPT_ONLY_V2', client)
    expect(result).toEqual(attestation)
  })

  it('returns null when no attestation exists', async () => {
    const client = fakeClient({ fromImpl: () => ({ data: null, error: null }) })

    const result = await getConvergenceAttestation('UNKNOWN_KID', client)
    expect(result).toBeNull()
  })

  it('returns null (never throws) when the query errors', async () => {
    const client = fakeClient({ fromImpl: () => ({ data: null, error: { code: '42501', message: 'denied' } }) })

    const result = await getConvergenceAttestation('DECRYPT_ONLY_V2', client)
    expect(result).toBeNull()
  })
})

describe('validateKidDestroyable', () => {
  const validResult = {
    valid: true,
    reason: null,
    attestation: { id: 1, kid: 'DECRYPT_ONLY_V2', inventory_version: 2, issued_by: USER.id, metadata: null, created_at: '2026-06-01T00:00:00Z' },
    retired_event: { id: 2, kid: 'DECRYPT_ONLY_V2', event_type: 'retired', actor_user_id: USER.id, reason: 'converged', metadata: null, created_at: '2026-06-02T00:00:00Z' },
  }

  it('returns valid true when both preconditions are met', async () => {
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('validate_kid_destroyable')
        expect(params).toEqual({ p_kid: 'DECRYPT_ONLY_V2' })
        return { data: validResult, error: null }
      },
    })

    const result = await validateKidDestroyable('DECRYPT_ONLY_V2', client)
    expect(result).toEqual({ success: true, validation: validResult })
  })

  it('returns valid false with reason when preconditions are not met', async () => {
    const invalid = {
      valid: false,
      reason: 'KID has not been declared Retired',
      attestation: { id: 1, kid: 'DECRYPT_ONLY_V2', inventory_version: 2, issued_by: USER.id, metadata: null, created_at: '2026-06-01T00:00:00Z' },
      retired_event: null,
    }
    const client = fakeClient({
      rpcImpl: () => ({ data: invalid, error: null }),
    })

    const result = await validateKidDestroyable('DECRYPT_ONLY_V2', client)
    expect(result).toEqual({ success: true, validation: invalid })
  })

  it('fails with unauthorized when no session user is present', async () => {
    const client = fakeClient({ user: null })
    const result = await validateKidDestroyable('DECRYPT_ONLY_V2', client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('returns valid false with reason when attestation version does not match current inventory version', async () => {
    const stale = {
      valid: false,
      reason: 'Convergence attestation was issued against inventory version 1, but the current inventory version is 2. Re-issue the attestation against the current inventory version before destroying this KID.',
    }
    const client = fakeClient({
      rpcImpl: () => ({ data: stale, error: null }),
    })

    const result = await validateKidDestroyable('DECRYPT_ONLY_V2', client)
    expect(result).toEqual({ success: true, validation: stale })
  })

  it('translates RPC errors appropriately', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '22023', message: 'kid not found' } }),
    })
    const result = await validateKidDestroyable('UNKNOWN_KID', client)
    expect(result).toEqual({
      success: false,
      error: { code: 'validation', message: 'kid not found' },
    })
  })
})

describe('destroyKid — T8', () => {
  it('calls the destroy_kid RPC and returns the persisted event + attestation', async () => {
    const destroyResult = {
      event: { id: 3, kid: 'DECRYPT_ONLY_V2', event_type: 'destroyed', actor_user_id: USER.id, reason: 'remediated', metadata: null, created_at: '2026-06-03T00:00:00Z' },
      attestation: { id: 1, kid: 'DECRYPT_ONLY_V2', inventory_version: 2, issued_by: USER.id, metadata: null, created_at: '2026-06-01T00:00:00Z' },
    }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('destroy_kid')
        expect(params).toEqual({ p_kid: 'DECRYPT_ONLY_V2', p_reason: 'remediated' })
        return { data: destroyResult, error: null }
      },
    })

    const result = await destroyKid('DECRYPT_ONLY_V2', 'remediated', client)
    expect(result).toEqual({ success: true, result: destroyResult })
  })

  it('passes null reason when omitted', async () => {
    const destroyResult = {
      event: { id: 4, kid: 'DECRYPT_ONLY_V2', event_type: 'destroyed', actor_user_id: USER.id, reason: null, metadata: null, created_at: '2026-06-03T00:00:00Z' },
      attestation: { id: 1, kid: 'DECRYPT_ONLY_V2', inventory_version: 2, issued_by: USER.id, metadata: null, created_at: '2026-06-01T00:00:00Z' },
    }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('destroy_kid')
        expect(params).toEqual({ p_kid: 'DECRYPT_ONLY_V2', p_reason: null })
        return { data: destroyResult, error: null }
      },
    })

    const result = await destroyKid('DECRYPT_ONLY_V2', undefined, client)
    expect(result).toEqual({ success: true, result: destroyResult })
  })

  it('fails with unauthorized when no session user is present', async () => {
    const client = fakeClient({ user: null })
    const result = await destroyKid('DECRYPT_ONLY_V2', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('translates RPC errors appropriately', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '22023', message: 'KID has not been declared Retired' } }),
    })
    const result = await destroyKid('DECRYPT_ONLY_V2', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'validation', message: 'KID has not been declared Retired' },
    })
  })

  it('translates a 42501 to unauthorized', async () => {
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
    })
    const result = await destroyKid('DECRYPT_ONLY_V2', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'You are not authorized to manage key lifecycle state.' },
    })
  })

  it('rejects destroy when attestation inventory version is stale — real reason is preserved, not replaced by a generic message', async () => {
    // migration 058 raises this precondition failure with ERRCODE 22023
    // (validation), NOT 42501 (insufficient_privilege) — the two admin
    // checks inside destroy_kid already use 42501 for "not an admin".
    // Using 22023 here is load-bearing: translateRpcError's 42501 branch
    // discards error.message entirely in favor of a generic "not
    // authorized" string, which would hide the real reason on the one
    // transition in this whole contract that is irreversible.
    const staleMessage =
      'Cannot destroy KID: Convergence attestation was issued against inventory version 1, but the current inventory version is 2. Re-issue the attestation against the current inventory version before destroying this KID.'
    const client = fakeClient({
      rpcImpl: () => ({ data: null, error: { code: '22023', message: staleMessage } }),
    })
    const result = await destroyKid('DECRYPT_ONLY_V2', undefined, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'validation', message: staleMessage },
    })
  })

  it('rejects destroy with the real reason when no attestation exists at all (22023, not a generic message)', async () => {
    const client = fakeClient({
      rpcImpl: () => ({
        data: null,
        error: {
          code: '22023',
          message: 'Cannot destroy KID: No convergence attestation found for this KID. Issue one via issue_convergence_attestation first.',
        },
      }),
    })
    const result = await destroyKid('NEVER_ATTESTED_KID', undefined, client)
    expect(result).toEqual({
      success: false,
      error: {
        code: 'validation',
        message: 'Cannot destroy KID: No convergence attestation found for this KID. Issue one via issue_convergence_attestation first.',
      },
    })
  })

  it('rejects destroy with the real reason when the KID is not currently Retired (e.g. reverted via T7 after being retired)', async () => {
    const client = fakeClient({
      rpcImpl: () => ({
        data: null,
        error: {
          code: '22023',
          message:
            "Cannot destroy KID: KID's most recent lifecycle event is not Retired. Declare via declare_kid_retired first (T6), and ensure no later reversal (T7) or reactivation (T5) has occurred since.",
        },
      }),
    })
    const result = await destroyKid('REVERTED_KID', undefined, client)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.code).toBe('validation')
      expect(result.error.message).toContain('most recent lifecycle event is not Retired')
    }
  })
})

describe('listConvergenceAttestations', () => {
  it('returns all attestations, most recent first', async () => {
    const attestations = [
      { id: 2, kid: 'KID_C', inventory_version: 1, issued_by: USER.id, metadata: null, created_at: '2026-06-02T00:00:00Z' },
      { id: 1, kid: 'KID_A', inventory_version: 2, issued_by: USER.id, metadata: { note: 'swept' }, created_at: '2026-06-01T00:00:00Z' },
    ]
    const client = fakeClient({ fromImpl: () => ({ data: attestations, error: null }) })

    const result = await listConvergenceAttestations(client)
    expect(result).toEqual(attestations)
  })

  it('returns an empty array (never throws) when the query errors', async () => {
    const client = fakeClient({ fromImpl: () => ({ data: null, error: { code: '42501', message: 'denied' } }) })

    const result = await listConvergenceAttestations(client)
    expect(result).toEqual([])
  })
})

describe('getCurrentInventoryVersion', () => {
  it('returns the version reported by the RPC', async () => {
    const client = fakeClient({
      rpcImpl: (name) => {
        expect(name).toBe('get_current_inventory_version')
        return { data: 3, error: null }
      },
    })
    const result = await getCurrentInventoryVersion(client)
    expect(result).toBe(3)
  })

  it('returns null (never throws) when the RPC errors', async () => {
    const client = fakeClient({ rpcImpl: () => ({ data: null, error: { code: '42501', message: 'denied' } }) })
    const result = await getCurrentInventoryVersion(client)
    expect(result).toBeNull()
  })
})

describe('bumpInventoryVersion', () => {
  it('calls bump_inventory_version with the requested version and returns the persisted row', async () => {
    const row = { id: 1, version: 2, updated_at: '2026-06-01T00:00:00Z', updated_by: USER.id }
    const client = fakeClient({
      rpcImpl: (name, params) => {
        expect(name).toBe('bump_inventory_version')
        expect(params).toEqual({ p_new_version: 2 })
        return { data: row, error: null }
      },
    })
    const result = await bumpInventoryVersion(2, client)
    expect(result).toEqual({ success: true, inventoryVersion: row })
  })

  it('fails with unauthorized when no session user is present', async () => {
    const client = fakeClient({ user: null })
    const result = await bumpInventoryVersion(2, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'unauthorized', message: 'You must be signed in to manage key lifecycle state.' },
    })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('propagates the real reason when the version is not exactly current + 1', async () => {
    const client = fakeClient({
      rpcImpl: () => ({
        data: null,
        error: { code: '22023', message: 'inventory_version must increase by exactly 1 (current: 1, requested: 3)' },
      }),
    })
    const result = await bumpInventoryVersion(3, client)
    expect(result).toEqual({
      success: false,
      error: { code: 'validation', message: 'inventory_version must increase by exactly 1 (current: 1, requested: 3)' },
    })
  })
})
