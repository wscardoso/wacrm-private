# IMP-CRYPTO-001 — Implementation Plan

**Version:** RC1.3
**Baseline ADR:** ADR-CRYPTO-001 `f84b845`
**Status:** Planning — pre-Phase 3 checkpoint
**Owner:** Platform Architecture
**Consumed by:** ADR-E7-001 (Encryption Key Rotation)
**Supersedes:** IMP-CRYPTO-001 RC1.2 (approved, Implementation Gate #3)

---

## 0. Changelog

### 0.1 RC1.0 → RC1.1 (Gate #1 → Gate #2)

This revision resolved all blocking and non-blocking findings from Implementation Gate #1 (NO-GO). No change to ADR-CRYPTO-001. No change to any approved invariant (I1–I14). No change to the cryptographic architecture (envelope format, AAD construction, KID semantics). All changes were execution-plan, rollout, storage-representation, and test-plan corrections.

| Gate #1 Finding | Severity | Resolution in RC1.1 |
|---|---|---|
| Recognition Tree defined twice with contradictory order | CRITICAL | Single normative definition, §5.1, with no exploratory reasoning, alternatives, or intermediate notes. |
| `bindingContext` optional + phased encrypt/decrypt rollout risked unrecoverable/unreadable data | CRITICAL | Rollout restructured to per-domain atomic cutover, §6. |
| Nonce reuse risk: `ACTIVE_V1` shared raw key material with `LEGACY_GCM` | HIGH | `ACTIVE_V1` uses a distinct derived key (HKDF), treated as a Key Ring initial-configuration decision, not an architecture change, §4.3. |
| Self-declared "Addendum to ADR" | HIGH | Removed. Storage layer formally separated into Cryptographic Representation vs. Persistence Representation, §4.4. |
| AES-GCM pseudocode: `setAAD` sequenced after cipher finalization | MEDIUM | Corrected pseudocode with mandatory 7-step order (header → AAD → cipher → setAAD → encrypt → tag → serialize), §6.1. |
| No explicit I9 (algorithm == KID algorithm) check | MEDIUM | Explicit `ALGORITHM_MISMATCH` check added to decrypt pseudocode before any decrypt attempt, §6.1. |
| Rollback plan not actionable post-write | MEDIUM | Rewritten as prevention-first (per-domain atomicity removes the scenario), §12. |
| No invariant traceability matrix | LOW | Added, §7.0, covering I1–I14. |
| No nonce-isolation test between KIDs | LOW | Added, §7.1. |

### 0.2 RC1.1 → RC1.2 (Gate #2 → Gate #3)

Gate #2 returned **GO WITH CONDITIONS**, with two conditions to be closed before final approval. No change to ADR-CRYPTO-001. No change to any approved invariant. No architecture reopened.

| Gate #2 Finding | Severity | Resolution in RC1.2 |
|---|---|---|
| `bindingContext` enforcement ambiguity: document claimed compile-time-only, type-required contract, while describing a transition window in which the shared public signature remained `string \| undefined` for all 17 call sites for the duration of Phase 2 | MEDIUM | Eliminated structurally, not patched: the public API is split into two permanently distinct function pairs — `encrypt`/`decrypt` (no `bindingContext` parameter at all, legacy-only, pre-cutover) and `encryptWithBindingContext`/`decryptWithBindingContext` (`bindingContext: string` required, no optional/undefined variant ever exists). No function anywhere in this plan has an optional `bindingContext`. §3.3, §4.1, §6, §6.1, §7.1. |
| Rollback plan (§12) covered only the `encrypt`/write-path revert scenario; no defined strategy for a defect in the read path (parser, Recognition Tree, canonical decrypt, AAD validation) discovered after canonical envelopes already exist | MEDIUM | §12 expanded with an explicit Read-Path Defect Scenario: fix-forward mandated, rollback of the read path to a canonical-incapable version explicitly prohibited once canonical writes have begun for any domain, write-path pause (feature flag) as the sole emergency lever. |

### 0.3 RC1.2 → RC1.3 (pre-Phase 3 checkpoint)

Phase 1 and Phase 2 implemented and approved (commits `f3cf5a1`, `1656fef`). Before starting Phase 3, a call-site inventory of all `whatsapp_config` consumers surfaced a contract inconsistency in the Binding Context formula, analyzed and resolved architecturally — no ADR change, no invariant impact, no cryptographic architecture change.

| Finding | Severity | Resolution in RC1.3 |
|---|---|---|
| `bindingContext = whatsapp_config:{id}` (§3.4) is unavailable at `encryptWithBindingContext` time on INSERT flows — Postgres generates `id` after insert, encryption happens before. Additionally, §3.4 already had an undocumented internal divergence: Flows/Automations used `{connection_id}` for the same domain. | HIGH (would have blocked Phase 3 or caused AAD mismatches across consumer groups of the same row) | Domain formula changed to `whatsapp_config:{account_id}` — resolved at every call site before any database operation, no pre-generated identifier needed, no transitional empty-BC window. Unifies all consumer groups onto one formula. Formalized with an explicit dependency on the "1 row per account" invariant (migration 017) and a residual-risk note, §3.5. |

### 0.4 Implementation Completion Review — process findings closed

Phase 3.1 (`ad_account_credentials`, commit `c36b3b5`) and Phase 3.2 (`whatsapp_config`, commit `23da2c3`) completed all 17 call sites across both in-scope domains. A subsequent Implementation Completion Review (Architect, post-Phase-3.2) found the cryptographic implementation, invariants I1–I14, and domain coverage fully compliant with this plan and the ADR (no CRITICAL/HIGH findings), with 3 process/test-coverage findings. All 3 are closed as of this revision — no ADR change, no invariant impact, no cryptographic architecture change, no call-site behavior change.

| Finding | Severity | Resolution |
|---|---|---|
| ESLint import-restriction rule (§4.1, §6 step 5, §8 Risk Register) was never implemented for either migrated domain — the CI-time regression guard against a call site re-importing the pre-cutover `encrypt`/`decrypt`/`isLegacyFormat` pair did not exist. | MEDIUM | Implemented in `eslint.config.mjs`: `no-restricted-imports` on `@/lib/whatsapp/encryption` for `encrypt`/`decrypt`/`isLegacyFormat`, scoped to `src/**/*.ts(x)`, with an explicit `ignores` allow-list limited to the module itself, the tests that exercise the legacy pair directly, and the 3 flag-gated fallback call sites (`config/route.ts`, `send/route.ts`, `webhook/route.ts`). Verified to fire on a non-listed import and to pass clean on the current tree. |
| Three tests mandated by §7.1 were missing: (a) type-level compile-fail test for omitted/`undefined` `bindingContext`; (b) nonce-isolation property test at the specified scale (≥10,000 `ACTIVE_V1` nonces vs. a legacy-nonce fixture corpus); (c) "canonical read regression on frozen fixtures" test backing the §12.2 fix-forward rule. | MEDIUM | (a) Added `src/lib/whatsapp/encryption.type-test.ts` — `@ts-expect-error` assertions checked by `tsc --noEmit` (§7.6), verified to catch a deliberately reintroduced regression. (b) Added to `src/lib/crypto/keyring.test.ts` — 10,000 freshly generated nonces (same `crypto.randomBytes(12)` call as `ACTIVE_V1` encryption) asserted collision-free against each other and against a deterministic 5,000-entry fixture corpus. (c) Added `src/lib/crypto/__fixtures__/canonical-envelopes.json` (4 canonical envelopes, produced once against the fixed test `ENCRYPTION_KEY`, covering both domains plus empty-string and Unicode plaintext) and `src/lib/crypto/canonical-fixtures.test.ts`, which fails the build if any entry stops decrypting — the automated backstop for §12.2. |
| `encryptWithBindingContext` does not contain the write-enablement gate shown as an internal step in the §6.1 reference pseudocode; the gate is instead applied at each call site (`config/route.ts`'s `encryptForConfig`, and inline in `send/route.ts`/`webhook/route.ts`). Functionally equivalent and verified correct at every current call site, but correctness depends on caller discipline rather than being enforced inside the shared function. | LOW | Accepted as a documented design decision, not changed — recorded in §8 Risk Register below. Centralizing the gate inside `encryptWithBindingContext` itself remains an option for a future domain's cutover if this residual risk is judged to have grown (e.g. many more call sites, or call sites outside this codebase's review discipline). |

---

## 1. Scope

Implementation of the canonical Crypto Envelope contract as defined in ADR-CRYPTO-001.

This plan covers:
- Encapsulation of the envelope serialization/deserialization
- Key Ring resolution
- Backward-compatible decryption (legacy `iv:ct` and `iv:ct:tag` formats)
- Binding Context integration
- Updates to all 17 call sites

This plan does NOT cover:
- Key rotation (ADR-E7-001)
- Convergence / batch migration (ADR-E7-001)
- KMS / HSM / BYOK (future ADRs)

---

## 2. Impact Map

### 2.1 Current Architecture (Before)

```
encryption.ts
  encrypt(text: string): string
  decrypt(text: string): string
  isLegacyFormat(text: string): boolean

Global ENCRYPTION_KEY (env var)
No envelope version / KID / algorithm ID
Format: iv:ct:tag (GCM) or iv:ct (CBC legacy)
Detection: colon-count heuristic
Binding: none
```

### 2.2 Target Architecture (After)

```
lib/crypto/
  envelope.ts        — serialization, deserialization, recognition tree
  keyring.ts          — KID → key material resolution
  encryption.ts       — public API: encrypt/decrypt (pre-cutover, no-BC, deprecated)
                         + encryptWithBindingContext/decryptWithBindingContext (post-cutover, BC required)

Key Ring config (env vars or secrets)
Envelope version, KID, algorithm ID embedded in every new ciphertext
Binding Context in AAD for canonical envelopes (mandatory, non-empty per domain)
Recognition tree (single, normative definition — see §5.1): canonical → legacy GCM → legacy CBC → invalid
Storage: base64url of canonical binary envelope, applied only at the persistence boundary (see §4.4)
```

### 2.3 Modules Touched

| Module | Change | Impact |
|--------|--------|--------|
| `src/lib/whatsapp/encryption.ts` | **Extend** — add `encryptWithBindingContext`/`decryptWithBindingContext`; keep `encrypt`/`decrypt` unchanged and deprecated until Phase 3 | All 17 callers, phased per domain |
| `src/lib/crypto/envelope.ts` | **New** — binary serialization, AAD construction, recognition tree | None (internal) |
| `src/lib/crypto/keyring.ts` | **New** — KID resolution, write/read key separation, key derivation for `ACTIVE_V1` | None (internal) |
| 17 API routes and lib modules | **Import switch** — per-domain, switch from `encrypt`/`decrypt` to `encryptWithBindingContext`/`decryptWithBindingContext` with a concrete BC (§4.1) | All callers, one domain-release at a time |
| `.env.local` / deployment config | **New keys** — KEYRING configuration | DevOps |

---

## 3. Components

### 3.1 New: `src/lib/crypto/envelope.ts`

**Responsibility:** Canonical serialization and parsing.

```
Exports:
  serializeCanonical(params: EnvelopeParams): Buffer
  parseCanonical(buffer: Buffer): EnvelopeFields
  recognizeFormat(stored: string): FormatResult
    → "canonical" | "legacy_gcm" | "legacy_cbc" | "invalid"
  buildAAD(header: HeaderFields, bindingContext: string): Buffer
```

**Internal:**
- Binary TLV serialization (ADR §3.1.1)
- AAD construction (ADR §3.1.3)
- Recognition tree (§5.1 of this plan; normative, single definition)
- Disjunction validation (ADR §3.1.4, §8.4), extended to the base64url storage representation per §4.4

**No dependencies on Key Ring or encryption keys.** Pure data transformation.

### 3.2 New: `src/lib/crypto/keyring.ts`

**Responsibility:** KID → cryptographic material resolution.

```
Exports:
  KeyRing class or functions
  resolveKey(kid: string): KeyMaterial
  getWriteKey(): KeyMaterial
  hasKID(kid: string): boolean
```

**Internal:**
- Wraps the configured key set
- Initially: `LEGACY_GCM`, `LEGACY_CBC`, and `ACTIVE_V1`
- Resolution is a single-step lookup (no trial, no fallback)
- Fail-closed for unknown KIDs
- `ACTIVE_V1` material is **derived**, not shared raw, from `LEGACY_GCM`/`LEGACY_CBC` material — see §4.3

### 3.3 Modified: `src/lib/whatsapp/encryption.ts`

**Responsibility:** Public encryption API.

```
Exports (two permanently distinct function pairs — never a single signature with optional bindingContext):

  // Pre-cutover API. No bindingContext parameter exists on these functions at all.
  // Used exclusively by call sites belonging to a domain that has not yet completed
  // its Phase 2 cutover (§6). Produces and reads ONLY legacy format ciphertexts.
  // @deprecated — removed in Phase 3, once every domain has cut over (§6, §13).
  encrypt(data: string): string
  decrypt(token: string): string

  // Post-cutover API. bindingContext is a required parameter — there is no overload,
  // default, or union type that accepts omission or `undefined`. This is the only
  // API capable of producing or reading canonical envelopes.
  encryptWithBindingContext(data: string, bindingContext: string): string
  decryptWithBindingContext(token: string, bindingContext: string): string
```

**Internal:**
- `encrypt`/`decrypt` are untouched copies of the original pre-ADR implementation (`iv:ct:tag` / `iv:ct`, no envelope, no Key Ring, no Recognition Tree dependency) — they exist only so that call sites not yet in their domain's cutover window continue to compile and behave exactly as before. They never import from `lib/crypto/`.
- `encryptWithBindingContext` serializes a canonical envelope via the Key Ring write key (`ACTIVE_V1`); `bindingContext` is required and threaded into `buildAAD()`.
- `decryptWithBindingContext` runs the Recognition Tree (§5.1) → resolves KID → verifies algorithm (I9) → decrypts. It reads **both** legacy and canonical ciphertexts, since a domain's historical data remains legacy even after that domain's own cutover. `bindingContext` is required by the signature; for legacy ciphertexts it is accepted but not cryptographically verified, per ADR §8.7.
- No function in this module ever accepts `bindingContext?: string` or `bindingContext: string | undefined`. A call site either uses the no-BC pair (pre-cutover) or the required-BC pair (post-cutover); it never uses a hybrid.
- **Temporary compatibility adapter (only if strictly necessary, not used by any of the current 17 call sites):** if a specific call site cannot switch atomically for a documented reason (e.g. a shared helper invoked by both a migrated and a not-yet-migrated domain), an explicitly named adapter `encryptDuringTransition(data, bindingContext: string)` / equivalent may be introduced, under these non-negotiable conditions: (1) the name makes its transitional nature unambiguous; (2) it contains a runtime guard — `if (!bindingContext) throw new Error('BINDING_CONTEXT_REQUIRED')` — in addition to the compile-time requirement; (3) it is listed in §8 Risk Register with the specific call site and a removal deadline no later than the end of Phase 3; (4) it never falls back to an empty or synthesized Binding Context. No such adapter is planned for the current 17 call sites listed in §3.4.

### 3.4 Caller Update Pattern

Every call site that currently does:
```typescript
const token = decrypt(stored_ciphertext)
// or
const ct = encrypt(plaintext)
```

Changes to (§4.1 — new function names, not new optional parameters on the old ones):
```typescript
const bc = bindingContextForX(...)   // domain-specific helper, never empty by omission
const token = decryptWithBindingContext(stored_ciphertext, bc)
// or
const ct = encryptWithBindingContext(plaintext, bc)
```

Both changes for a given domain ship in the same release, per §6.

**Binding Context per domain (revised — pre-Phase 3 architectural decision, see §3.5):**

| Domain | Binding Context Value | Cardinality |
|--------|----------------------|-------------|
| `whatsapp_config` rows (all consumers: API routes, Flows, Automations, self-heal upgrades, delivery cron/orphan-sweep) | `whatsapp_config:{account_id}` | 1 per account |
| `ad_account_credentials` rows | `ad_account:{account_id}` | 1 per row |
| Enrichment (credential-resolver) | `ad_account:{account_id}` | 1 per account |

Every domain listed above has a non-empty Binding Context formula. No call site in this plan uses an empty Binding Context; empty BC (ADR §7.4) remains a defined, legal value of the contract but is not used by any current caller, and is never produced by omission.

### 3.5 `whatsapp_config` Binding Context — formula decision (pre-Phase 3)

**Superseded:** earlier drafts of this plan used `whatsapp_config:{id}` (most call sites) and, inconsistently, `whatsapp_config:{connection_id}` (Flows/Automations) for the same domain — an internal divergence that was never deliberately resolved and would have caused encrypt/decrypt AAD mismatches across consumer groups of the same row.

**Decision:** the domain's Binding Context formula is `whatsapp_config:{account_id}`, not `{id}`.

**Reason:** `encryptWithBindingContext` is called, on INSERT flows (`config/route.ts POST`, both the zapi/uazapi and Meta branches), **before** the row exists — `id` is Postgres-generated at insert time and is not available at encryption time. `account_id` is resolved from the authenticated caller before any database write, unconditionally, at every encrypt call site in the pre-Phase-3 inventory — this eliminates the INSERT-timing problem structurally, with no pre-generated identifier, no double-encryption step, and no transitional empty-BC window.

On the decrypt side, `account_id` is the same column already present on every `whatsapp_config` row, but is not yet selected by two of the inventoried call sites — `delivery/orphan-sweep/route.ts` (`enqueueOrphan`, currently selects `provider, access_token, instance_id, phone_number_id, base_url, waba_id`) and `webhook/route.ts`'s verify-token GET loop (currently selects `id, verify_token`). Both need `account_id` added to their existing `select()` call — a mechanical, one-column change, not an architectural gap, and squarely inside the mandatory per-domain call-site audit already required before that domain's Phase 2 cutover step (§6, §8).

**Dependency (must hold for this formula to remain valid):** the invariant "at most one live `whatsapp_config` row per `account_id`" (migration 017, per existing code comments in `config/verify-registration/route.ts`, `media/[mediaId]/route.ts`, `flows/meta-send.ts`). If this invariant is ever relaxed — e.g. multiple simultaneous WhatsApp connections per account — `account_id` stops uniquely identifying a row, and this formula must be re-evaluated **before** that feature ships, not after. Tracked as a Risk Register entry (§8).

**Known residual risk, accepted:** a ciphertext from a deleted `whatsapp_config` row could pass AAD verification against a newly created row for the same `account_id` (delete → reconnect cycle), since both share the same Binding Context. This requires an orphaned ciphertext to resurface through an anomalous path (stuck queue, cache, partial restore) — not reachable by a domain consumer under normal operation (ADR P3). Row-level granularity (`{id}`) would close this gap but requires pre-generating the row identifier before every INSERT; rejected as disproportionate to the risk given the dependency above. Documented in §8.

---

## 4. Contracts Affected

### 4.1 Public API Change

**Before:**
```typescript
encrypt(data: string): string
decrypt(text: string): string
isLegacyFormat(text: string): boolean
```

**After (RC1.2 — two permanently distinct function pairs, per §3.3):**
```typescript
// Pre-cutover. No bindingContext parameter — cannot produce or read canonical envelopes.
// @deprecated — removed in Phase 3.
encrypt(data: string): string
decrypt(token: string): string

// Post-cutover. bindingContext is required — no optional/undefined variant exists.
encryptWithBindingContext(data: string, bindingContext: string): string
decryptWithBindingContext(token: string, bindingContext: string): string

// isLegacyFormat: deprecated, removed in Phase 3 alongside encrypt/decrypt.
```

**Enforcement design — no shared optional signature at any point.** Gate #2 found that a single, globally shared `encrypt(data, bindingContext?: string)` signature — needed to remain optional for the entire multi-sprint duration of Phase 2, so that not-yet-migrated call sites would still compile — meant the claimed "compile-time, non-optional" contract was not actually true for most of the rollout, and no runtime guard closed the gap. RC1.2 removes the ambiguity structurally instead of patching it:

- **Before a domain's cutover:** its call sites import and use only `encrypt`/`decrypt` (no `bindingContext` parameter exists on these functions — there is nothing to omit). The domain's data remains entirely legacy; no canonical envelope can be produced through this pair, by construction. Per ADR §8.7, Binding Context has no cryptographic role for legacy ciphertexts, so the absence of the parameter here is not a weakening of the contract.
- **During a domain's cutover (§6):** its call sites switch, in the same release, to `encryptWithBindingContext`/`decryptWithBindingContext`. `bindingContext: string` is required by the type system — there is no code path, in either function, that accepts a missing or `undefined` value. A defense-in-depth runtime guard (`BINDING_CONTEXT_REQUIRED`, §6.1) also rejects an empty/falsy value at the function boundary, covering any caller that bypasses static typing (e.g. an `any`-typed or dynamically constructed call).
- **After a domain's cutover:** no call site belonging to that domain can import `encrypt`/`decrypt` (no-BC) again without a code review flag — an ESLint rule restricting `encrypt`/`decrypt` imports to the explicit allow-list of not-yet-migrated call sites (maintained alongside §3.4) enforces this at CI time, shrinking as domains complete cutover and reaching zero entries at the start of Phase 3.
- **Phase 3:** once every domain has cut over, `encrypt`/`decrypt` (no-BC) and `isLegacyFormat` are deleted from the module entirely — not merely deprecated. `encryptWithBindingContext`/`decryptWithBindingContext` may then be renamed to the plain `encrypt`/`decrypt` names, since no ambiguous pair remains to conflict with them.

No canonical envelope is ever produced with an empty or synthesized Binding Context, and no function in this plan ever has a `bindingContext` parameter that is simultaneously optional and capable of producing canonical output. An explicit empty string remains a legal, deliberate value per ADR §7.4 for a domain that genuinely has no resource-level identity to bind to, but no domain in §3.4 uses it — every current formula is non-empty.

### 4.2 Output Format Change

`encrypt()` output changes from `iv:ct:tag` to `base64url(canonical binary envelope)`. Consumers that treat the output as an opaque token are unaffected. Consumers that parse, inspect, or length-check the ciphertext string will break.

**Identified risk:** Any code that assumes the ciphertext is a hex string, checks its format, or uses it in string concatenation that expects `:` delimiters. Mitigation: audit all 17 call sites for such assumptions before Phase 2 (§6).

### 4.3 Key Ring Configuration Contract — Initial Configuration Decision

The separation of `ACTIVE_V1` key material from the Legacy KIDs described below is an **initial configuration decision of the Key Ring**, made entirely within the boundaries ADR-CRYPTO-001 already grants it: the ADR defines the Key Ring as "the authority of cryptographic resolution" (§5) and states that, initially, `LEGACY_GCM` and `LEGACY_CBC` "resolve to the same underlying cryptographic material" while preserving independent KID identity (§8.1) — the ADR does not mandate that `ACTIVE_V1` must also share that raw material; it only permits it. This plan exercises that latitude differently, for operational-security reasons internal to this implementation, without touching the KID resolution model, the invariants, or any envelope semantics.

New required configuration:

| Variable | Purpose | Status |
|----------|---------|--------|
| `ENCRYPTION_KEY` | Legacy key (both `LEGACY_GCM` and `LEGACY_CBC`); root input to `ACTIVE_V1` derivation | Existing, preserved |
| `KEYRING_WRITE_KID` | KID for new envelopes (optional, defaults to `ACTIVE_V1`) | New |
| `KEYRING_CONFIG` | Full key ring definition for rotation (future) | New (ADR-E7-001) |

Initial Key Ring configuration:

```
LEGACY_GCM  → ENCRYPTION_KEY                                       → AES-256-GCM → DecryptOnly
LEGACY_CBC  → ENCRYPTION_KEY                                       → AES-256-CBC → DecryptOnly
ACTIVE_V1   → HKDF-SHA256(ENCRYPTION_KEY, info="wacrm:crypto:ACTIVE_V1", len=32) → AES-256-GCM → Active
```

**Key material separation (resolves Gate #1 HIGH finding — nonce reuse risk):**

`ACTIVE_V1` does **not** reuse the raw bytes of `ENCRYPTION_KEY`. It derives a distinct 32-byte key via HKDF (RFC 5869), using `ENCRYPTION_KEY` as input keying material and a fixed, KID-specific `info` context string. This guarantees the physical AES-256-GCM key used for all `ACTIVE_V1` encryptions is cryptographically independent of the key used by the pre-migration legacy encrypt path (which consumed `ENCRYPTION_KEY` directly), eliminating any possibility that a freshly generated `ACTIVE_V1` nonce collides with a nonce already consumed, outside Key Ring tracking, by historical legacy ciphertexts under the same physical key.

This preserves I2/I3/I6: `ACTIVE_V1 → material` remains a total, deterministic function of configuration (HKDF is deterministic given fixed inputs), not a per-boot random value, and no KID is reused. `LEGACY_GCM`/`LEGACY_CBC` are unaffected — they remain DecryptOnly against the original `ENCRYPTION_KEY`, matching the ciphertexts they must continue to decrypt.

**Forward compatibility with ADR-E7-001:** when key rotation introduces a dedicated, independently provisioned key for a future active KID, the derivation step is simply replaced by direct key material in `KeyRing` configuration — `resolveKey()`/`getWriteKey()` and all call-site code are unaffected. The derivation strategy is an initial-state implementation detail of this plan, not a load-bearing part of the KID resolution contract.

### 4.4 Storage Encoding Layer

The canonical envelope's authoritative logical form is **binary**, exactly as defined in ADR-CRYPTO-001 §3.1. This plan does not change that.

Both `whatsapp_config` and `ad_account_credentials` columns are `TEXT`. Persisting raw binary in a `TEXT`/UTF-8 column risks corruption for byte sequences that are not valid UTF-8.

**Resolution:** the binary canonical envelope is encoded as `base64url` exclusively at the storage/transport boundary — immediately before a database write, and immediately after a database read. No other component (`envelope.ts` internals, AAD construction, Key Ring, cipher operations) is aware of this encoding; `serializeCanonical`/`parseCanonical`/`buildAAD` operate exclusively on the binary form. `base64url` is applied and removed only in `encryption.ts`, at the two points where a value crosses the storage boundary.

**Normative layer separation for this plan:**

```
Cryptographic Representation:
  binary canonical envelope
  — defined exclusively by ADR-CRYPTO-001 §3.1
  — the only form ever passed to serializeCanonical / parseCanonical / buildAAD / cipher operations
  — the only form the ADR's invariants (I1–I14) and Recognition Tree (§8.3) describe

Persistence Representation:
  base64url(binary canonical envelope)
  — exists solely to satisfy the TEXT column constraint of whatsapp_config / ad_account_credentials
  — carries no cryptographic meaning; it is not part of the envelope contract
  — decoded back to the Cryptographic Representation before any cryptographic operation
  — produced from the Cryptographic Representation only after all cryptographic operations for encrypt are complete
```

The Cryptographic Representation remains, without exception, the binary canonical envelope defined by the ADR. The Persistence Representation is a storage/transport detail entirely downstream of it, owned by this plan, reversible without loss, and never itself an input to any cryptographic function.

**Scope clarification requested from the Architect (not asserted by this plan):** ADR §8.3 defines the Recognition Tree in terms of "the first byte of the persisted ciphertext," under the implicit assumption that the persisted form equals the canonical binary form. Under `base64url` storage, the persisted form is the encoded text, so the Recognition Tree must decode-then-inspect rather than inspect-then-decode to reach an equivalent result. This is a request for the Architect to record a scope clarification alongside RC1.1 approval — it is not a unilateral reinterpretation of the ADR by this plan, and no such "addendum" language appears anywhere else in this document.

The Recognition Tree in §5.1 implements the decode-then-inspect rule and preserves the ADR's normative precedence (canonical before legacy). Collision analysis: `base64url`'s alphabet (`A-Za-z0-9-_`) does not include `:`; the legacy patterns (§5.1, step 2) require at least one `:` by full-string anchored match. A string cannot simultaneously satisfy both a legacy pattern and a canonical base64url decode with first byte `0x01`, so the two classes remain disjoint under storage encoding, consistent with ADR §8.4's disjunction requirement extended to the encoded representation.

---

## 5. Recognition Tree

### 5.1 Recognition Tree (Normative — single definition)

This is the **only** definition of the Recognition Tree in this document. Any other ordering is not valid and must not be implemented.

Applied in this fixed order, per ADR §8.3 precedence:

1. **Canonical attempt (precedence level 1).** Attempt `base64url`-decode of the full persisted string.
   - If decode fails (invalid alphabet/padding) → not canonical, proceed to step 2.
   - If decode succeeds and the first byte of the decoded buffer is `0x01` → classify as **canonical**. Proceed to `parseCanonical`. If parsing fails (malformed header, truncated fields, invalid lengths) → **Invalid Envelope**. There is no fallback to legacy from this branch (ADR §8.3).
   - If decode succeeds but the first byte is not `0x01` → not canonical, proceed to step 2.

2. **Legacy recognition (precedence level 2).** Reached only if step 1 did not classify as canonical.
   - Full-string match against `^[0-9a-fA-F]+:[0-9a-fA-F]+:[0-9a-fA-F]+$` (uppercase hex normalized to lowercase before matching) → **Legacy GCM**.
   - Full-string match against `^[0-9a-fA-F]+:[0-9a-fA-F]+$` → **Legacy CBC**.

3. **Fail closed (precedence level 3).** Neither of the above → **Invalid Envelope** (ADR I10, I12).

This is deterministic and non-heuristic: classification depends only on the fixed order above and exact decode/pattern results, never on likelihood or partial matches. It matches ADR §8.3's mandated precedence and ADR §8.4's disjunction, extended to the `base64url` storage representation per §4.4.

---

## 6. Implementation Phases

### Phase 1 — Foundation (no behavioral change)

**Files:** `envelope.ts`, `keyring.ts`

**Deploy:** Safe. New modules only, no existing code changed.

**Verification:**
- Serialize → parse roundtrip produces identical bytes
- Recognition tree (§5.1): known formats classified correctly, invalid rejected, order verified explicitly
- AAD construction: two independent implementations produce identical bytes
- Key ring resolution: known KIDs resolve, unknown KIDs fail closed
- `ACTIVE_V1` derived key ≠ `ENCRYPTION_KEY` raw bytes, ≠ `LEGACY_GCM`/`LEGACY_CBC` material (see §7.1 nonce-isolation test)

**Duration:** 1 sprint

### 6.1 Reference Pseudocode — `encryptWithBindingContext` / `decryptWithBindingContext` (normative sequencing)

This is the single reference implementation flow for the post-cutover API (§3.3, §4.1). `bindingContext: string` is required by the type signature; a runtime guard additionally rejects an empty/falsy value at the function boundary — the only two ways this function can execute are "no `bindingContext` given, compile fails" or "`bindingContext` given and non-empty." There is no third path.

Mandatory order for encrypt: (1) define header, (2) build AAD, (3) create cipher, (4) `setAAD()`, (5) encrypt, (6) obtain authentication tag, (7) serialize envelope. The same care applies to decrypt, with the explicit I9 algorithm check inserted before any decrypt attempt.

```typescript
function encryptWithBindingContext(data: string, bindingContext: string): string {
  // Runtime guard — defense in depth beyond the type system (e.g. `any`-typed callers)
  if (!bindingContext) {
    throw new Error('BINDING_CONTEXT_REQUIRED')
  }

  // Write-enablement gate (§6, Phase 2 step 2/4) — while off, emits legacy format unchanged
  if (!isCanonicalWriteEnabled(currentDomain())) {
    return encrypt(data)   // delegates to the unchanged pre-cutover implementation, §3.3
  }

  // 1. Define header
  const keyMaterial = keyring.getWriteKey()
  const nonce = generateUniqueNonce(keyMaterial.kid)
  const header = {
    version: 0x01,
    kid: keyMaterial.kid,
    algorithm: keyMaterial.algorithm,
    nonce,
  }

  // 2. Build AAD
  const aad = buildAAD(header, bindingContext)

  // 3. Create cipher
  const cipher = crypto.createCipheriv(keyMaterial.algorithm, keyMaterial.key, nonce)

  // 4. setAAD() — before any encrypt call
  cipher.setAAD(aad)

  // 5. Encrypt
  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])

  // 6. Obtain authentication tag
  const authTag = cipher.getAuthTag()

  // 7. Serialize envelope (Cryptographic Representation)
  const envelope = serializeCanonical({
    version: header.version,
    kid: header.kid,
    algorithm: header.algorithm,
    nonce: header.nonce,
    ciphertext,
    authTag,
  })

  // Persistence Representation applied only here, at the storage boundary (§4.4)
  return base64url(envelope)
}

function decryptWithBindingContext(token: string, bindingContext: string): string {
  // Runtime guard — defense in depth beyond the type system
  if (!bindingContext) {
    throw new Error('BINDING_CONTEXT_REQUIRED')
  }

  const classification = recognizeFormat(token)   // §5.1 — single normative rule

  switch (classification.format) {
    case 'canonical': {
      const raw = base64urlDecode(token)          // Persistence → Cryptographic Representation
      const envelope = parseCanonical(raw)

      const keyMaterial = keyring.resolve(envelope.kid)

      // Explicit I9 check — before any decrypt attempt
      if (envelope.algorithm !== keyMaterial.algorithm) {
        throw new Error('ALGORITHM_MISMATCH')
      }

      // 1. Header available from parsed envelope
      const header = {
        version: envelope.version,
        kid: envelope.kid,
        algorithm: envelope.algorithm,
        nonce: envelope.nonce,
      }

      // 2. Build AAD
      const aad = buildAAD(header, bindingContext)

      // 3. Create decipher
      const decipher = crypto.createDecipheriv(keyMaterial.algorithm, keyMaterial.key, envelope.nonce)

      // 4. setAAD() — before setAuthTag / update
      decipher.setAAD(aad)
      decipher.setAuthTag(envelope.authTag)

      // 5. Decrypt — throws on tag mismatch (wrong BC, tampering, or wrong key)
      return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8')
    }
    case 'legacy_gcm':
      // Unchanged original GCM path — tag verified, no AAD; BC accepted but not verified (ADR §8.7)
      return legacyDecryptGCM(classification, keyring.resolve('LEGACY_GCM'))
    case 'legacy_cbc':
      // Unchanged original CBC path — no auth tag; BC accepted but not verified (ADR §8.7)
      return legacyDecryptCBC(classification, keyring.resolve('LEGACY_CBC'))
    case 'invalid':
      throw new Error('INVALID_ENVELOPE')
  }
}
```

`encrypt(data: string): string` / `decrypt(token: string): string` (pre-cutover pair, §3.3) are the unchanged original implementation and are not reproduced here — no envelope, no Key Ring, no Recognition Tree, no Binding Context of any kind.

### Phase 2 — Per-domain atomic cutover

**Files:** `encryption.ts` (add `encryptWithBindingContext`/`decryptWithBindingContext`, per §3.3/§4.1), all call sites for one domain at a time

This phase replaces the previous plan's separate "encryption module rewrite" and "binding context integration" phases. Gate #1 found that splitting encrypt-migration from decrypt-migration by *operation type*, across separate multi-sprint phases, created windows where canonical envelopes with real Binding Context were unreadable by not-yet-updated decrypt call sites, and windows where canonical envelopes were written with an empty/default Binding Context that could never later be reconciled. Gate #2 additionally required that encrypt and decrypt for a domain not merely be *sequenced* correctly but be *migrated together*, in one release, with no globally shared optional signature bridging them. RC1.2 satisfies both:

**Rule:** for a given domain, `encryptWithBindingContext`/`decryptWithBindingContext` are introduced for that domain's call sites — decrypt and encrypt together — in a **single deploy/release**. Nothing about the domain's migration spans multiple release cycles. Within that one release, canonical **write-enablement** is gated by a per-domain feature flag, flipped only after the release (containing both the new decrypt and new encrypt code) has reached 100% of running instances — a matter of minutes in a standard rolling deploy, not a separate phase. This closes the only real hazard of a "simultaneous" cutover: a rolling deploy where an old-code instance (still running only `encrypt`/`decrypt`, no-BC) could receive a canonical envelope written moments earlier by an already-updated instance and fail to read it.

**Rollout steps, per domain, in priority order** (`whatsapp_config` → `ad_account_credentials` → remaining call sites grouped by domain), all within one release for the domain:

1. Identify and freeze the domain's Binding Context formula (already documented in §3.4).
2. Ship one PR/release that: (a) switches all of the domain's decrypt call sites from `decrypt` to `decryptWithBindingContext(token, bc)`, and (b) switches all of the domain's encrypt call sites from `encrypt` to `encryptWithBindingContext(data, bc)` — but with canonical output gated behind `FLAG_CANONICAL_WRITE_<DOMAIN>` (default **off** at deploy time); while the flag is off, `encryptWithBindingContext` internally still emits the legacy format (BC is computed and validated, but not yet embedded in a written AAD), so behavior is unchanged in production at the moment of deploy.
3. Confirm the release has reached 100% of running instances (standard deploy-completion signal). Run the shadow/integration checks (§7.2) against the now-fully-deployed `decryptWithBindingContext` path on existing legacy data.
4. Flip `FLAG_CANONICAL_WRITE_<DOMAIN>` on. From this instant, `encryptWithBindingContext` for the domain produces canonical envelopes with the real Binding Context, and every instance capable of reading them (`decryptWithBindingContext`, already 100% deployed since step 3) is already live. There is no window, at any point from step 2 onward, in which a canonical envelope of this domain can exist without every running instance already able to decrypt it.
5. ESLint import restriction (§4.1) for this domain's call sites is updated to forbid `encrypt`/`decrypt` (no-BC) imports, closing the door on regression.

**Key risks (updated):**
- Binary canonical envelopes are not hex strings; storage uses `base64url` per §4.4 — resolved structurally, not a residual risk.
- A domain boundary is mis-scoped (e.g. a caller reads `whatsapp_config` data through a code path not identified in §3.4) → treated as a HIGH risk requiring an explicit call-site audit before step 2 of each domain; see §8.
- Feature flag `FLAG_CANONICAL_WRITE_<DOMAIN>` is flipped before step 3's 100%-rollout confirmation → treated as a HIGH risk; mitigation is an automated deploy-completion gate (flag flip blocked programmatically until the release's rollout status reports 100%), not a manual step; see §8.

### Phase 3 — Legacy format retirement preparation

**Files:** `encryption.ts`, call sites

**Deploy:** Delete `encrypt`/`decrypt` (no-BC pair) and `isLegacyFormat` entirely, per §4.1 — by this point every domain has cut over and nothing imports them (enforced by the ESLint allow-list reaching zero entries, §6 step 5). `encryptWithBindingContext`/`decryptWithBindingContext` may be renamed to `encrypt`/`decrypt`, since no ambiguous pair remains. The renamed `decrypt` still reads legacy ciphertexts (via the Recognition Tree, §5.1) indefinitely, independent of this cleanup.

**Precondition:** All data confirmed migrated via lazy migration or sweeper (ADR-E7-001).

---

## 7. Test Plan

### 7.0 Invariant Traceability Matrix

| Invariant | Statement (summary) | Test(s) |
|---|---|---|
| I1 | Every envelope has exactly one KID | Canonical serialization tests (§7.1, `envelope.ts`) — header always contains exactly one KID field |
| I2 | Every KID references exactly one crypto material | Key Ring resolution tests — `resolve(kid)` is a pure function returning one `KeyMaterial` |
| I3 | KID globally unique, KID→material total & deterministic, no scoped resolution | Key Ring tests — no tenant/scope parameter accepted; same KID always resolves identically |
| I4 | Exactly one Active key per Key Ring | Key Ring tests — `getWriteKey()` returns exactly one key; config validation rejects multiple Active entries |
| I5 | Active key is also valid for read | Key Ring tests — `ACTIVE_V1` resolvable via `resolve()` as well as `getWriteKey()` |
| I6 | No KID reuse | Key Ring config validation test — duplicate KID definitions rejected at load time |
| I7 | Destroyed transition precondition (out of scope — ADR-E7-001) | N/A in this plan |
| I8 | Auth tag mandatory for canonical + Legacy GCM; Legacy CBC has none by design | Roundtrip tests (tag verified on decrypt); corrupted-tag fuzz test (§7.4); Legacy CBC test asserts no tag path invoked |
| I9 | Envelope algorithm must equal KID's registered algorithm | **New:** explicit `ALGORITHM_MISMATCH` test — craft canonical envelope with `algorithm` field diverging from the resolved KID's registered algorithm, assert rejection before decrypt is attempted |
| I10 | Unknown Envelope Version fails closed | Recognition tree test — byte `0x02..0xFF` (non-hex-range) with valid base64url wrapper classifies as invalid |
| I11 | Unknown Algorithm Identifier fails closed | Canonical envelope with unregistered algorithm string → Key Ring / algorithm-check rejection |
| I12 | Unknown KID fails closed | Key Ring resolution test — unknown KID throws, no fallback attempted |
| I13 | Nonce/IV uniqueness per KID | Concurrent-encrypt test (§7.3) + **new** nonce-isolation test (§7.1) covering cross-KID/cross-era uniqueness under shared-lineage key material |
| I14 | AAD exactly matches canonical serialization of header + Binding Context | AAD construction tests — all 5 fields individually varied, output byte-compared |

### 7.1 Unit Tests

| Suite | Module | Tests | Coverage |
|-------|--------|-------|----------|
| Canonical serialization | `envelope.ts` | Serialize → parse produces same fields; invalid buffers rejected; injectivity (different fields → different bytes) | All field combinations; boundary lengths (0, 1, max) |
| AAD construction | `envelope.ts` | Two independent constructions produce same bytes; changing any field changes AAD | All 5 fields individually |
| Recognition tree | `envelope.ts` | Canonical (base64url), legacy GCM (`iv:ct:tag`), legacy CBC (`iv:ct`), invalid (every other pattern); uppercase hex normalized; **order-of-precedence test**: adversarial input crafted to be ambiguous under an incorrect (legacy-first) order must classify as canonical, proving §5.1's order is actually implemented | 20+ pattern variants + 1 precedence-order regression test |
| Key Ring resolution | `keyring.ts` | Known KID returns material; unknown KID throws; exactly one write key; `ACTIVE_V1` derivation is deterministic given fixed `ENCRYPTION_KEY` | All KIDs + negative tests |
| **Nonce isolation (implemented — §0.4)** | `keyring.ts` / `encryption.ts` | `ACTIVE_V1` derived key bytes ≠ `ENCRYPTION_KEY` raw bytes; ≠ `LEGACY_GCM`/`LEGACY_CBC` key bytes; a corpus of historical legacy nonces (fixture data) and a batch of freshly generated `ACTIVE_V1` nonces never collide under identical key material | `src/lib/crypto/keyring.test.ts` — property test over 10,000 generated nonces against a 5,000-entry fixture legacy-nonce corpus |
| Algorithm match (new) | `encryption.ts` | Canonical envelope with `algorithm` field diverging from resolved KID's algorithm → `ALGORITHM_MISMATCH`, decrypt never attempted | Divergent algorithm per known KID |
| Envelope roundtrip | `encryption.ts` | encrypt → decrypt = original data; legacy → new decrypt = same data | GCM only; CBC legacy; CBC→GCM migration path |
| Binding Context | `encryption.ts` | `encryptWithBindingContext` + BC → `decryptWithBindingContext` with matching BC = OK; matching encrypt BC → decrypt with different BC (wrong BC) = FAIL (tag mismatch) | All variants |
| **BC required, no signature ambiguity (implemented — §0.4)** | `encryption.ts` | (a) Type-level test (`@ts-expect-error`, checked by `tsc --noEmit`): `encryptWithBindingContext`/`decryptWithBindingContext` called with only one argument, or with `bindingContext: undefined`, fails to compile — `src/lib/whatsapp/encryption.type-test.ts`. (b) Runtime test: calling either function with `bindingContext` forced to `undefined`/`''` via an `any`-typed cast throws `BINDING_CONTEXT_REQUIRED` before any cryptographic operation runs — `src/lib/whatsapp/encryption.test.ts`, "BC undefined guard" suite (pre-existing, Phase 2). (c) Confirms `encrypt`/`decrypt` (no-BC pair) never appear in the import graph of a call site outside the `eslint.config.mjs` allow-list (static ESLint-rule enforcement, §4.1) — verified by running ESLint against the full migrated tree and against a deliberately reintroduced violation. | One test per condition, run for every migrated domain |
| **Canonical read regression on frozen fixtures (implemented — §0.4)** | `envelope.ts` / `keyring.ts` | A frozen corpus of canonical envelopes, produced once per domain immediately after that domain's cutover (§6, step 4) and checked into the test fixtures, must remain decryptable by every subsequent version of `envelope.ts`/`keyring.ts`. Failing this test blocks merge — it is the automated backstop for the fix-forward rule in §12. | `src/lib/crypto/__fixtures__/canonical-envelopes.json` (4 entries: `whatsapp_config`, `ad_account_credentials`, empty string, Unicode) + `src/lib/crypto/canonical-fixtures.test.ts`, run on every commit touching `lib/crypto/` |

### 7.2 Integration Tests

| Test | Description |
|------|-------------|
| Legacy compatibility | Decrypt current production ciphertexts (both GCM and CBC) with new code — must produce identical plaintext |
| New format production | Encrypt with new code, decrypt with new code — roundtrip OK |
| Cross-format stability | Decrypt old GCM → produce same plaintext; new encrypt → decrypt with new = same as old → new |
| Binding context enforcement | Decrypt canonical envelope with wrong BC → throws |
| Key Ring miss | Decrypt canonical envelope with unknown KID → throws |
| Storage encoding | `base64url` canonical envelope stored/retrieved from TEXT column without corruption |
| **Per-domain atomic cutover (updated, RC1.2)** | Simulate the Phase 2 rollout sequence for one domain: release deployed with `FLAG_CANONICAL_WRITE_<DOMAIN>` off (both new functions live, legacy behavior), release reaches 100%, flag flipped on — assert no intermediate state exists where a canonical envelope is unreadable by any running instance |
| **Fix-forward compatibility (new)** | A patched `envelope.ts`/`keyring.ts` (simulating a post-cutover bugfix) must still decrypt every fixture produced by the pre-patch version — see §7.1 "Canonical read regression on frozen fixtures" and §12 |

### 7.3 Non-Regression Tests

| Scenario | Current Behavior | Expected After |
|----------|-----------------|----------------|
| Legacy CBC decrypt | Returns plaintext | Same |
| Legacy GCM decrypt | Returns plaintext | Same |
| New encrypt → decrypt roundtrip | N/A (new format) | Roundtrip OK |
| `isLegacyFormat` on CBC | `true` | `true` (deprecated but preserved) |
| `isLegacyFormat` on GCM | `false` | `false` |
| Invalid format | Throws | Throws (same message? optional) |
| Concurrent encrypts | Multiple random IVs, no collision | Same, with per-KID nonce tracking |
| Non-empty binding context (default for all current domains) | N/A | Works, produces non-empty BC in AAD |

### 7.4 Fuzz / Edge Cases

| Input | Expected |
|-------|----------|
| Empty string | Invalid envelope → throws |
| Base64url of random bytes (first byte ≠ 0x01) | Invalid envelope → throws |
| Base64url of canonical with corrupted tag | Decrypt → auth failure → throws |
| Legacy `iv:ct` with invalid hex chars | Invalid → throws |
| Mixed-case hex in legacy format | Normalized → accepted (ADR §8.3) |
| UTF-8 BOM prefix | Invalid → throws |
| Extremely long ciphertext (> 64KB) | May stress 4-byte length prefix; test boundary at 2^32-1 (not in practice, but contract allows) |
| KID collision (two callers same KID) | Nonce uniqueness per KID prevents collision; test concurrent encrypts |
| Adversarial string with no `:` that happens to be valid base64url with first byte ≠ `0x01` | Classified invalid, not canonical, not legacy |

### 7.5 Performance Tests

| Scenario | Current | Target | Measurement |
|----------|---------|--------|-------------|
| Encrypt (new format) | ~1ms | < 2ms (base64 overhead) | Latency P50, P99 |
| Decrypt canonical | ~1ms | < 2ms (parsing overhead) | Latency P50, P99 |
| Decrypt legacy | ~1ms | ~1ms (no parsing overhead for legacy) | Latency P50, P99 |
| Concurrent decrypt (17 routes) | N/A | No measurable mutex contention | Thread safety |

### 7.6 CI/CD Checks

| Gate | Command | When |
|------|---------|------|
| TypeScript compile | `tsc --noEmit` | Every commit |
| Unit tests | `vitest run src/lib/crypto/` | Every commit |
| Integration tests | `vitest run src/lib/whatsapp/encryption.test.ts` | Every commit |
| Full test suite | `vitest run` | Before deploy |
| Legacy compatibility | `vitest run --testPathPattern legacy-compat` | Before deploy |
| Build | `next build` | Before deploy |

---

## 8. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Binary envelope stored in TEXT column corrupts data | High | Critical | `base64url` encoding applied exclusively at storage boundary (§4.4). Never write raw binary to TEXT column. |
| A call site is mis-scoped to a domain (reads data via a path not enumerated in §3.4) | Medium | High | Explicit call-site audit before each domain's Phase 2 release (§6 step 2). Domain cutover blocked until audit signed off. |
| Legacy CBC ciphertext without auth tag causes silent data corruption if fed to canonical parser | Low | High | Recognition tree (§5.1) is deterministic and precedence-ordered; CBC never reaches the canonical parser. |
| Queue of concurrent encrypts produces duplicate nonce under same KID | Low | Critical | Counter-based or checked-random nonce generation. Test at high concurrency (§7.1). |
| `ACTIVE_V1` nonce collides with historical legacy nonce under shared-lineage key | Low (was unaddressed in RC1.0) | Critical | `ACTIVE_V1` uses HKDF-derived key, cryptographically distinct from `ENCRYPTION_KEY` (§4.3). Nonce-isolation test (§7.1). |
| `isLegacyFormat` used in string-length-dependent code breaks with base64url | Medium | Medium | Deprecate `isLegacyFormat`. Audit all callers before Phase 2. |
| `FLAG_CANONICAL_WRITE_<DOMAIN>` flipped before the release reaches 100% of running instances (RC1.2) | Low | Critical | Flag flip gated programmatically on an automated deploy-completion signal, not a manual step (§6, step 4). Integration test simulates a partial-rollout state and asserts the flag cannot be flipped. |
| A regressed call site re-imports the pre-cutover `encrypt`/`decrypt` (no-BC) after its domain has migrated (RC1.2) | Low | Medium | **Closed (§0.4).** ESLint import-restriction rule implemented in `eslint.config.mjs` — fails CI if `encrypt`/`decrypt`/`isLegacyFormat` are imported outside the explicit allow-list (module itself, legacy-pair tests, and the 3 flag-gated fallback call sites). |
| `encryptWithBindingContext` does not itself contain the write-enablement gate shown in the §6.1 reference pseudocode; each domain's call sites apply the gate externally (e.g. `config/route.ts`'s `encryptForConfig`). Correctness for future call sites depends on replicating that pattern correctly, rather than being enforced by the shared function. (§0.4) | Low | Low | Accepted design decision — every current call site verified correct (Implementation Completion Review, post-Phase-3.2). Any new domain's Phase 2 release must include this gate at each of its encrypt call sites as part of the mandatory call-site audit (§6 step 2, §8 "mis-scoped call site" risk above); centralizing the gate inside `encryptWithBindingContext` remains available if this pattern proves error-prone in practice. |
| A future fix to `envelope.ts`/`keyring.ts` breaks the ability to read canonical envelopes written before the fix (RC1.2) | Low | Critical | Frozen fixture corpus per domain, tested on every commit (§7.1, §7.2); fix-forward is mandatory, read-path rollback is prohibited (§12). |
| The "1 `whatsapp_config` row per `account_id`" invariant (migration 017) is relaxed in the future (e.g. multi-connection accounts), silently invalidating the `{account_id}`-based Binding Context formula (§3.5, RC1.3) | Low | High | Formula dependency explicitly documented (§3.5). Any feature proposal relaxing the 1:1 invariant must re-evaluate the BC formula before shipping — tracked as a required check, not left implicit. |
| A ciphertext from a deleted `whatsapp_config` row passes AAD verification against a newly created row for the same `account_id` (delete → reconnect cycle), since both share the same BC (§3.5, RC1.3) | Low | Medium | Accepted residual risk: requires an orphaned ciphertext to resurface via an anomalous path (stuck queue, cache, partial restore); not reachable by a domain consumer under normal operation (ADR P3). Row-level BC would close this gap but was rejected as disproportionate given the dependency above — revisit if the 1:1 invariant changes. |

---

## 9. Migration Compatibility Matrix

| Ciphertext Origin | Decrypt New Code | Expected |
|-------------------|-----------------|----------|
| Old CBC (`iv:ct`) | Legacy CBC path in recognition tree | Same plaintext |
| Old GCM (`iv:ct:tag`) | Legacy GCM path in recognition tree | Same plaintext |
| New canonical (`base64url`) | Canonical path in recognition tree | Same plaintext |
| New canonical (raw binary) | Not stored (always `base64url`-encoded before persistence) | N/A — never produced in this form |

---

## 10. Dependencies

| Dependency | Blocking | Notes |
|-----------|----------|-------|
| ADR-CRYPTO-001 approved | Yes | Done (`f84b845`) |
| Architect sign-off on §4.4 storage-encoding scope clarification | Yes | Required before Phase 1 completion; not a reinterpretation, a recorded clarification |
| Key Ring configuration design (ADR-E7-001) | No | Phase 1 works with single-key-lineage config (`ENCRYPTION_KEY` + HKDF derivation) |
| Binding Context formula per domain | Yes (per domain, before that domain's Phase 2) | All current domains already have non-empty formulas documented (§3.4) |
| Column encoding decision (TEXT + base64url vs BYTEA) | Resolved | `base64url` in existing TEXT columns, per §4.4 |

---

## 11. Phases Summary

| Phase | Deliverable | Estimated Duration | Risk |
|-------|-------------|-------------------|------|
| 1 | `envelope.ts` + `keyring.ts` (incl. `ACTIVE_V1` derivation) | 1 sprint | Low — new modules, no impact |
| 2 | Per-domain atomic cutover (encrypt+decrypt together), all 17 call sites, all domains | 2–3 sprints | Medium — mechanical per domain, but each domain cutover is a single coordinated deploy rather than a global two-step split |
| 3 | Cleanup + deprecation removal | 0.5 sprint | Low — after convergence verified |

**Total estimated: 3.5–4.5 sprints** from Phase 1 start to Phase 2 completion across all domains (Phase 3 can wait).

---

## 12. Rollback Plan

### 12.1 Write-Path Rollback (encrypt)

**Design principle:** canonical write-enablement for a domain is controlled by `FLAG_CANONICAL_WRITE_<DOMAIN>` (§6), flipped only after both `encryptWithBindingContext` and `decryptWithBindingContext` are live on 100% of running instances. There is no deploy state in which a canonical envelope exists that any active reader cannot decrypt.

**Scenario: a domain's Phase 2 release misbehaves before the flag is flipped (§6, steps 2–3).**

Rollback is clean: revert the release for that domain, or simply leave the flag off. No canonical envelope for that domain has been written yet. Legacy encrypt/decrypt is unaffected throughout, since `encryptWithBindingContext` with the flag off delegates directly to the unchanged `encrypt` (§6.1).

**Scenario: a defect is found after the flag is flipped (§6, step 4), and the defect is isolated to the write path (e.g. an incorrect Binding Context formula for the domain, not a parser/decrypt defect).**

Flip `FLAG_CANONICAL_WRITE_<DOMAIN>` back off. `encryptWithBindingContext` immediately resumes emitting legacy format. Already-written canonical envelopes remain fully readable, since `decryptWithBindingContext` (which handles both legacy and canonical) is never touched by this action. No re-encryption is required and none is proposed. This is a single flag flip, not a deploy.

### 12.2 Read-Path Defect Scenario (RC1.2 — closes Gate #2 condition)

**Scope:** a defect discovered in the parser (`parseCanonical`), the Recognition Tree (`recognizeFormat`, §5.1), canonical decrypt, or AAD validation (`buildAAD`) — in `envelope.ts` or `keyring.ts` — **after** canonical envelopes have already been produced for one or more domains (i.e. after any domain has reached §6 step 4 for the first time).

**Explicit prohibition:** rollback of the read path (`decryptWithBindingContext`, or the shared `envelope.ts`/`keyring.ts` modules it depends on) to a version incapable of parsing canonical envelopes is **prohibited** once canonical writes have begun for any domain. Such a rollback would make already-written canonical data unreadable — an outcome this plan treats as strictly worse than leaving a known bug live behind a mitigating control, and therefore not an available option, not even as an emergency measure.

**Required strategy: fix-forward, mandatory.**

1. **Immediate containment (if the defect affects correctness of reads, not just an edge case):** flip `FLAG_CANONICAL_WRITE_<DOMAIN>` off for every affected domain. This pauses new canonical writes without touching any existing data or the read path itself; legacy encrypt/decrypt continues unaffected on a separate, untouched code path (§12.1). This bounds the blast radius while a fix is prepared — it is a write-side lever, never a read-side one.
2. **Patch in place:** fix `envelope.ts`/`keyring.ts` directly, keeping the module fully backward-compatible with (a) legacy ciphertexts and (b) every canonical envelope already written — verified automatically by the frozen fixture corpus (§7.1 "Canonical read regression on frozen fixtures," §7.2 "Fix-forward compatibility"), which fails the build if the patch cannot decrypt any previously-produced canonical envelope.
3. **Deploy the fix** through the standard CI/CD gates (§7.6) with the same urgency as any critical production bug fix — this is an ordinary fast-follow release, not a special rollback procedure.
4. **Resume writes:** once the fix is verified in production (canary or equivalent), flip `FLAG_CANONICAL_WRITE_<DOMAIN>` back on for the affected domains.

**If the defect is severe enough that reads must be paused entirely** (not just writes) — an extreme case, since it means even legacy-format reads relying on shared `envelope.ts` recognition logic are compromised — the mitigation is to keep a known-good prior binary serving read-only traffic **in parallel** (blue/green, not a revert of the primary deployment) while the fix is prepared, rather than rolling the primary deployment's read path backward. This preserves the ability to decrypt canonical data at all times.

**Residual scenario requiring operational judgment, not automated rollback:** a call site was missed from the domain audit (§8 risk: "mis-scoped call site") and reads canonical data through an unaudited path. This is treated as a defect in cutover execution, not a rollback case; the mitigation is the mandatory pre-cutover call-site audit (§6, §8), not a post-hoc recovery procedure.

---

## 13. Architect Sign-off Required Before Final Gate Approval

1. Confirm §4.4's scope clarification (Recognition Tree operates on the `base64url`-encoded persisted form; decode-then-inspect) is acceptable as a recorded clarification, not requiring ADR amendment.
2. Confirm HKDF-based derivation of `ACTIVE_V1` (§4.3) is an acceptable initial-state implementation decision of the Key Ring, compatible with ADR-E7-001's future rotation model.

Both items are administrative confirmations, not open technical questions; neither blocks the start of Phase 1. They are recorded here so that final Gate approval can serve as the sign-off vehicle for both.
