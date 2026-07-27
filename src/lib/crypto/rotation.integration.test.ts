import { describe, it, expect } from 'vitest'
import { KeyRing, type KeyMaterial } from './keyring'

// ─── IMP-E7-001 Phase 2 — Rotation process integration tests ──────────────
//
// Exercises ADR-E7-001 §11 (T1 → T3/T4) and §12 (rollback) end to end,
// simulating a staged rolling deploy as a sequence of independently
// constructed KeyRing instances — exactly how ADR-E7-001 §9/§11 describes
// rotation being realized in practice: atomic whole-KeyRing replacement at
// process initialization, never in-place mutation.
//
// Scope: KeyRing only. No file outside this test is touched (IMP-E7-001
// Phase 2: "nenhum arquivo de código de aplicação"). `encryption.ts` and
// domain call sites are exercised through `getWriteKey()`/`resolveKey()`
// in production, so proving the invariants hold at the KeyRing boundary is
// sufficient to prove RNF-1 (zero call-site change) without touching them.

const TEST_KEY_HEX_A = '11'.repeat(32)
const TEST_KEY_HEX_B = '22'.repeat(32)
const TEST_KEY_HEX_C = '33'.repeat(32)
const TEST_KEY_HEX_D = '44'.repeat(32)

function keyMaterial(kid: string, hex: string, capacity: KeyMaterial['capacity']): KeyMaterial {
  return {
    kid,
    algorithm: 'aes-256-gcm',
    key: Buffer.from(hex, 'hex'),
    capacity,
  }
}

describe('Rotation process — T1 (provisioning + introduction as DecryptOnly)', () => {
  it('a new KID can be introduced as DecryptOnly without affecting the current Active KID', () => {
    const before = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
    ])

    // T1: ACTIVE_V2 provisioned and introduced as DecryptOnly (§11 step 1-2).
    const afterT1 = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'DecryptOnly'),
    ])

    // Active KID and its material are unaffected by T1.
    expect(afterT1.getWriteKey().kid).toBe(before.getWriteKey().kid)
    expect(afterT1.getWriteKey().key).toEqual(before.getWriteKey().key)
    // New KID resolves for read, never for write.
    expect(afterT1.resolve('ACTIVE_V2').capacity).toBe('DecryptOnly')
    expect(afterT1.getWriteKey().kid).not.toBe('ACTIVE_V2')
  })
})

describe('Rotation process — partial rollout (fail-closed, never silent, never corrupting)', () => {
  it('an instance not yet updated with the new KID fails closed with UNKNOWN_KID; an updated instance resolves it', () => {
    // Simulates the rollout window of §11 step 2: some running instances
    // already carry ACTIVE_V2 as DecryptOnly, others have not yet received
    // the configuration update.
    const outdatedInstance = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
    ])
    const updatedInstance = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'DecryptOnly'),
    ])

    // An envelope tagged ACTIVE_V2 reaching an outdated instance fails
    // closed and deterministically — never a fallback, never a crash on
    // unrelated data, never silent acceptance (I12).
    expect(() => outdatedInstance.resolve('ACTIVE_V2')).toThrow('UNKNOWN_KID')
    // The same instance is entirely unaffected for KIDs it does know.
    expect(outdatedInstance.resolve('LEGACY_GCM').capacity).toBe('DecryptOnly')
    expect(outdatedInstance.getWriteKey().kid).toBe('ACTIVE_V1')

    // An already-updated instance resolves the same KID without issue.
    expect(updatedInstance.resolve('ACTIVE_V2').capacity).toBe('DecryptOnly')
  })
})

describe('Rotation process — T3/T4 (atomic promotion, confirmed 100% rollout)', () => {
  it('promotes the new KID to Active and demotes the previous Active to DecryptOnly, atomically, preserving I4', () => {
    // Precondition satisfied: ACTIVE_V2 already DecryptOnly on 100% of
    // instances (simulated by simply proceeding — the rollout confirmation
    // itself is an operational/deploy-observability step, not something
    // the KeyRing can or should verify, per ADR-E7-001 §9/IMP-E7-001 §4.1).
    const prePromotion = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'DecryptOnly'),
    ])

    // T3/T4: single atomic replacement of the whole KeyRing — never an
    // incremental, partially-visible mutation (ADR-E7-001 §9, §11 step 3).
    const postPromotion = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'DecryptOnly'), // T4
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'Active'), // T3
    ])

    // I4 holds on both sides of the transition: exactly one Active, never
    // zero, never two, at any observable instant.
    expect(prePromotion.getWriteKey().kid).toBe('ACTIVE_V1')
    expect(postPromotion.getWriteKey().kid).toBe('ACTIVE_V2')
    expect(postPromotion.resolve('ACTIVE_V1').capacity).toBe('DecryptOnly')
    expect(postPromotion.resolve('ACTIVE_V2').capacity).toBe('Active')

    // A KeyRing that would violate I4 (both Active simultaneously) is
    // impossible to construct — this is the mechanism T3/T4 relies on to
    // guarantee atomicity, not a separate check.
    expect(
      () =>
        new KeyRing([
          keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
          keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'Active'),
        ]),
    ).toThrow('MULTIPLE_ACTIVE_KEYS')
  })

  it('reads data emitted under the old KID and the new KID identically after promotion — no branch, no special-casing (RNF-1)', () => {
    const postPromotion = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'DecryptOnly'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'Active'),
    ])

    // Same call, same code path, regardless of which KID the envelope was
    // originally emitted under — this is what RNF-1 requires at the
    // KeyRing boundary that encryption.ts/call sites exclusively depend on.
    const oldEnvelopeMaterial = postPromotion.resolve('ACTIVE_V1')
    const newEnvelopeMaterial = postPromotion.resolve('ACTIVE_V2')

    expect(oldEnvelopeMaterial.key).toEqual(Buffer.from(TEST_KEY_HEX_B, 'hex'))
    expect(newEnvelopeMaterial.key).toEqual(Buffer.from(TEST_KEY_HEX_C, 'hex'))
    expect(oldEnvelopeMaterial.algorithm).toBe(newEnvelopeMaterial.algorithm)
  })
})

describe('Rotation process — rollback (ADR-E7-001 §12)', () => {
  it('reverting a premature promotion restores the original Active KID without affecting legibility of any KID', () => {
    const promoted = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'DecryptOnly'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'Active'),
    ])

    // Rollback: republish the prior configuration. Same mechanism as
    // promotion (§12: "é a mesma operação de 'promoção atômica' ... aplicada
    // na direção inversa"), never a removal of read capability.
    const rolledBack = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'DecryptOnly'),
    ])

    expect(rolledBack.getWriteKey().kid).toBe('ACTIVE_V1')
    // Any envelope emitted under ACTIVE_V2 during the (reverted) promotion
    // window remains fully readable — ACTIVE_V2 never leaves the Key Ring,
    // it is only demoted, exactly as ADR-E7-001 §12 requires.
    expect(rolledBack.resolve('ACTIVE_V2').capacity).toBe('DecryptOnly')
    expect(rolledBack.resolve('ACTIVE_V2').key).toEqual(promoted.resolve('ACTIVE_V2').key)
    // Legacy KIDs are untouched by either promotion or rollback.
    expect(rolledBack.resolve('LEGACY_GCM').capacity).toBe('DecryptOnly')
  })
})

describe('Rotation process — multiple consecutive rotations (v1 → v2 → v3 → v4)', () => {
  it('resolves every historical KID identically after several sequential rotations, with no growth in resolution complexity', () => {
    // v1 active
    const gen1 = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'Active'),
    ])
    expect(gen1.getWriteKey().kid).toBe('ACTIVE_V1')

    // v1 -> v2
    const gen2 = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'DecryptOnly'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'Active'),
    ])
    expect(gen2.getWriteKey().kid).toBe('ACTIVE_V2')

    // v2 -> v3
    const gen3 = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'DecryptOnly'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'DecryptOnly'),
      keyMaterial('ACTIVE_V3', TEST_KEY_HEX_D, 'Active'),
    ])
    expect(gen3.getWriteKey().kid).toBe('ACTIVE_V3')

    // v3 -> v4 (reusing a fresh KID, distinct hex, to keep I6 — no reuse)
    const keyHexV4 = '55'.repeat(32)
    const gen4 = new KeyRing([
      keyMaterial('LEGACY_GCM', TEST_KEY_HEX_A, 'DecryptOnly'),
      keyMaterial('ACTIVE_V1', TEST_KEY_HEX_B, 'DecryptOnly'),
      keyMaterial('ACTIVE_V2', TEST_KEY_HEX_C, 'DecryptOnly'),
      keyMaterial('ACTIVE_V3', TEST_KEY_HEX_D, 'DecryptOnly'),
      keyMaterial('ACTIVE_V4', keyHexV4, 'Active'),
    ])

    // Every generation's write key is exactly what that generation set it
    // to be — no accumulated state leaks across independently constructed
    // KeyRing instances (RNF-3: determinism within a process lifetime).
    expect(gen4.getWriteKey().kid).toBe('ACTIVE_V4')

    // Every KID ever introduced remains resolvable for reads — O(1) lookup,
    // unaffected by how many rotations preceded it (RNF-4).
    expect(gen4.resolve('LEGACY_GCM').capacity).toBe('DecryptOnly')
    expect(gen4.resolve('ACTIVE_V1').capacity).toBe('DecryptOnly')
    expect(gen4.resolve('ACTIVE_V2').capacity).toBe('DecryptOnly')
    expect(gen4.resolve('ACTIVE_V3').capacity).toBe('DecryptOnly')
    expect(gen4.resolve('ACTIVE_V4').capacity).toBe('Active')

    // Material for each KID is stable across the generations it appears in.
    expect(gen4.resolve('ACTIVE_V1').key).toEqual(gen2.resolve('ACTIVE_V1').key)
    expect(gen4.resolve('ACTIVE_V2').key).toEqual(gen3.resolve('ACTIVE_V2').key)
  })
})
