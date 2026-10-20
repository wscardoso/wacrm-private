# Plan 002: Reconcile MASTER-ROADMAP.md and related docs with the real code

## Status

- **Status: CONCLUÍDO na árvore de trabalho, não commitado**
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (documentation only — no code, schema, migration, infra or production change)
- **Category**: docs
- **Revision**: rewritten 2026-10-17. Original (planned at `2e66c12`, 2026-09-08, roadmap v1.5) covered only E2.1 Phase 1, two hotfixes and C21; that scope was overtaken by later commits (v1.6, v1.7) and is superseded by this version.
- **Planned/inspected at**: `3301c773acf93fa0eefe732124ea714dacbfbe54` (`main` = `origin/main`). Epic snapshot audited by the roadmap: `26e5d39`.
- **Outcome**: roadmap **v1.8** (see its "Histórico"). Changes live in the working tree and are **not committed**.

## Scope

In scope (documentation only):
- `docs/MASTER-ROADMAP.md` (v1.7 → v1.8), `plans/README.md`, this file.
- Cross-references directly contradicted by the evidence: `docs/adr/ADR-AUT-001-automations-flows-reconciliation.md` (reconciliation note only), `docs/architecture/FORCECRM-ROXY-BOUNDARY.md` (`key_version` → KID/Key Ring), `docs/QUICK_REFERENCE.md` (DLQ check note).

Out of scope:
- Application code, tests, migrations, schema, RLS, DB functions, frontend, infra, deploy, production, the SoR.
- A general product audit. Historical ADRs/changelog entries are annotated, never rewritten.

## Reconciled items (evidence = repository at `3301c77`)

| Item | Result |
|---|---|
| E1 | `getProvider()` on all send paths; 8 non-test modules still import `meta-api`, tolerated by `KNOWN_VIOLATORS`; arch test detects only the single-quoted `@/…` alias |
| E2.1 | Phase 1 implemented and wired to the non-Meta webhook (063, `319694f`/`c0af1f9`/`5a02996`); epic **not closed**; R1, R2, D-C open and separate; production behaviour NOT VERIFIED |
| E4b / C6 / R10 | outbound ledger/enqueue/drain/orphan-sweep implemented; inbound DLQ has table + `enqueue_webhook_dlq` but no caller and no sweep/drain found — C6 open |
| E7 | mechanism is KID in envelope + Key Ring, not `key_version` |
| E8 | C21 closed (075); C16, C19 open per prior roadmap (not investigated, NOT VERIFIED); C20 partially addressed by 063 — NOT VERIFIED |
| E9 | partial: operator UI present; audit viewer and workspace suspension absent |
| E10 | ADR-AUT-001 accepted; convergence not started; `conversation_assigned` dispatcher exists (`721c512`, manual assignment) |
| E11 | scaffold only (`/api/v1/me`, `requireApiKey(scope?)`, `hasScope`); no resource endpoint |
| Migrations 076/080/081 | applied **per operator report**; not independently verified; not claimed absent |
| Clint #2, #13, #15 | no canonical definition in the repo; documentation/product-decision gap, no requirement invented |
| Round-robin concurrency | NOT TESTED on real PostgreSQL (local PGlite is sequential) |

## Acceptance criteria

1. Proven doc divergences corrected or recorded as pending.
2. The roadmap presents nothing partial/unverified as complete.
3. `plans/README.md` consistent with the above.
4. This plan aligned to the inspected version/commit.
5. Operational `key_version` references reconciled with KID/Key Ring (history preserved in ADR-ATTR-002 and AUD-001).
6. Sections on `meta-api`, `messages.status`, DLQ, E2.1, E7–E11 consistent with the evidence.
7. C20 and other unproven points stay NOT VERIFIED.
8. `git diff --check` clean; consistency review done.
9. `git status` shows only authorised documentation files.
10. No code, DB, production, infra or SoR change.

## Verification commands

| Purpose | Command |
|---|---|
| Base commit | `git rev-parse HEAD` → `3301c773…` |
| Only docs changed | `git status --short` |
| Whitespace | `git diff --check` |
| Direct `meta-api` imports | `grep -rnE "from ['\"].*meta-api['\"]" src --include=*.ts --include=*.tsx` |
| Inbound DLQ callers | `grep -rn "enqueue_webhook_dlq" src` |
| `key_version` in code | `grep -rn "key_version" src supabase` (expect none) |

## STOP conditions

Stop and report if a correction would need a change to code, migrations, DB, infra, production or the SoR, or would require inferring a fact the repository does not prove.

## Maintenance notes

- Not covered: running real PostgreSQL concurrency tests, independent verification of 076/080/081 in production, production smoke tests, an E2.1 closing checkpoint, and defining Clint items #2/#13/#15. Each needs separate authorisation or an operator decision.
