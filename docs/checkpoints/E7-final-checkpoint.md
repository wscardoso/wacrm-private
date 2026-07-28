# ForceCRM — E7 Final Checkpoint

| | |
|---|---|
| **Épico** | E7 — Encryption Key Versioning |
| **Status** | **CLOSED** |
| **Commit** | `d443ac0` |
| **Branch** | `main` |
| **Publicação** | `origin/main` — pushed |
| **Data** | 2026-07-27 |

---

## Executive Summary

IMP-E7-001 (Key Lifecycle Rotation Capability) is **closed**. The system can
provision, rotate, converge, retire, attest, and destroy keys. **No real
rotation has been executed** — the capability is delivered, the operational
decision remains pending.

---

## Current State

| Layer | Status | Key Artifact |
|---|---|---|
| Key Ring | Frozen | `src/lib/crypto/keyring.ts` |
| Rotation process | Tested (v1→v4) | `rotation.integration.test.ts` |
| Retired governance | Live via RPCs | Migration 057 |
| Ciphertext convergence | Detection + self-heal + sweep | `kidConvergence.ts`, sweep route |
| Convergence attestation | Structural precondition for T8 | Migration 058 |
| Inventory surface map | v1, gaps documented | `E7-ciphertext-surface-inventory.md` |

**Commit:** `d443ac0` on `main`, pushed to origin.

---

## Frozen Decisions (not to be reopened without ADR)

1. **KeyRing is frozen** — governance modules (`keyLifecycle.ts`,
   `kidConvergence.ts`) never import it. Convergence is purely declarative.
2. **Writes through SECURITY DEFINER RPCs only** — `convergence_attestations`
   has zero INSERT/UPDATE/DELETE policies. `key_lifecycle_events` same
   posture.
3. **Admin gate is `platform_operators.role = 'admin'`** — not
   `platform_operator_accounts.access_role`. KID lifecycle is
   platform-wide, not tenant-scoped.
4. **Actor/timestamp server-side** — `auth.uid()` / `NOW()` exclusively;
   no RPC accepts caller-supplied identity.
5. **ADR-CRYPTO-001 §4** rewritten with Legacy exception (§8.1). No further
   changes to that ADR without a new RC.
6. **Phase 5 requires explicit human confirmation** before any merge or
   execution that triggers `destroy_kid`. This is not delegable.

---

## Known Risks & Gaps

| Item | Severity | Note |
|---|---|---|
| `ad_account_credentials` uncovered | Medium | Documented in inventory v1. No convergence path exists for this table. |
| `get_current_inventory_version()` seeded as 1 | Info | Must be bumped each time a new ciphertext surface is added to the inventory. No automatic mechanism. |
| PGlite integration tests timeout (>10s) | Low | Environmental (cold start + schema load). All 15 PGlite suites affected, none E7-specific. Unit tests pass. |
| Deployment model assumes single-process VPS | Info | Sweep cursor is in-memory (per-invocation). Under pure serverless each invocation restarts from row 1 — redundant, never incorrect. |

---

## Next Decision Points (no implementation)

1. **Should a rotation be executed operationally?** Requires a real driver
   (e.g., KID exhaustion, vulnerability, compliance deadline). Not a
   code task — an operational decision.
2. **Should `ad_account_credentials` be converged?** If yes, must be
   scoped as a follow-up épico with its own ADR/contract.
3. **Is there any domain without cryptographic coverage?** Inventory v1
   is the starting point; new épicos must update it (ADR-E7-001 §13.1).
4. **Should the attestation → destroy flow be automated via UI?**
   Currently CLI/RPC only. Optional — depends on operational team's needs.

---

## Handoff to Next Agent

- **Do not** reopen E7 phases.
- **Do not** modify KeyRing.
- **Do not** propose or start implementation of any feature without
  a new ADR and Gate approval.
- **Do** use this checkpoint to understand what contracts are in place
  and what invariants must not be broken.

---

*End of checkpoint. E7 capability delivered. No irreversible action taken.*
