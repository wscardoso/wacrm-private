# Plan 002: Reconcile MASTER-ROADMAP.md with the real HEAD (E2.1 Phase 1 + two hotfixes already landed)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2e66c12..HEAD -- docs/MASTER-ROADMAP.md`
> If the roadmap changed since this plan was written, re-read it and compare
> against the "Current state" excerpts below before proceeding; on a
> mismatch, treat it as a STOP condition — someone else may already be mid-way
> through the same reconciliation.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (documentation only, no code/schema/behavior change)
- **Depends on**: none (independent of Plan 001)
- **Category**: docs
- **Planned at**: commit `2e66c12`, 2026-09-08

## Why this matters

`docs/MASTER-ROADMAP.md` declares itself (line 3) the project's **source of truth for remaining scope**, snapshotted at HEAD `26e5d39`. The actual HEAD is `2e66c12` — nine commits ahead. Of those nine, five are not cosmetic (docs-only) commits; they change what's actually true about the system, and none of it is reflected in the roadmap text:

1. `319694f`/`0711fbb`/`c0af1f9`/`5a02996`/`4955da9` (2026-08-04) implement and activate **E2.1 Phase 1** (canonical non-Meta status dispatch, migration 063 widening `messages.status` to 7 states, the `resolve-by-external-id` fallback fix, connection bootstrap wiring) — but §17 and the E2.1 row in §7 still say "Fase 1 (Implementação) ainda não iniciada". This is the single most load-bearing claim in the whole document (§8.1's "hard precedence chain" section exists specifically to justify why E2.1 blocks everything downstream) and it is now wrong.
2. `c999c44` lands dormant identity/phone-merge infrastructure (migrations 064-072, `ADR-IDENTITY-BR-001`, `ADR-CONTACT-MERGE-001`) — feature-flagged off, no application code calls it yet, so it doesn't change any Gap Analysis row, but it's real infrastructure with its own ADRs that the roadmap's contract table (§16) doesn't list.
3. `38a825e` (migration 073) and `2a6061e` (migration 074, HOTFIX-002) are **tenant-isolation security fixes** — an RPC (`insert_message_external_ids`) that let any authenticated user attach an external id to another tenant's message, and a `profiles` RLS gap enabling tenant escalation. Neither is reflected anywhere the roadmap tracks security posture (§10 risk matrix, §13 MVP security checklist).
4. `ecd78fa` makes `deals.conversation_id` get populated at creation — directly relevant to §7's E12 entry, which currently lists "`lead_attributions` não tem nenhuma FK/ligação com `deals`" as a design gap that E12 must close. That gap is now partially narrowed (a conversation-mediated path exists) even though no FK was added.
5. Commit `2e66c12` (this session) already fixed the table/RPC counts (33→43, 20→74) and the stale "Meta-only" claims — do not redo those; they're done. This plan only covers what's still stale.

Anyone reading the roadmap today to decide what to work on next would conclude E2.1 is still unstarted and would be unaware of two closed tenant-isolation vulnerabilities and their fixes. That's the concrete cost this plan removes.

## Current state

All excerpts below are from `docs/MASTER-ROADMAP.md` as of commit `2e66c12`.

**Header** (`docs/MASTER-ROADMAP.md:3`):
```
**Versão:** v1.5 · **Snapshot auditado:** HEAD `26e5d39` (fechamentos documentais de 2026-07-29/30 aplicados sobre este snapshot; nenhuma alteração de código considerada)
```

**Executive summary** (`docs/MASTER-ROADMAP.md:24`):
```
- **A camada de messaging foi o débito dominante — hoje majoritariamente fechada** `[C]`. `E1` (Provider Boundary), `E2.0` (correção de identidade/R16), `E4a` (integridade de saída) e `E4b` (retry/DLQ) estão **concluídos**. Resta **E2.1** (Status Canônico) como único elo aberto da cadeia dura, e `E3` (Connections/multi-conexão) como item estrutural ainda não iniciado.
```

**Gap Analysis, FKs row** (`docs/MASTER-ROADMAP.md:180`):
```
| FKs / integridade | — | C16, C19, C20, C21 | E3 | P2 |
```
C21 (`conversations.assigned_agent_id` without a FK) was closed by migration `075_conversations_assigned_agent_fk.sql` (committed in `2e66c12`, tested in `src/test/c21-assigned-agent-fk.pglite.test.ts`, 4/4 passing). C16, C19, C20 remain open — do not mark those closed.

**Epic table, E2.1 row** (`docs/MASTER-ROADMAP.md:195`):
```
| **E2.1** | Status Canônico | Ciclo de vida da mensagem por resolução de identidade | `docs/adr/ADR-MSG-STATUS-001.md` + `docs/checkpoints/CHECKPOINT-E2.1-STATUS-CANONICAL.md` | **FASE 0 CONCLUÍDA** — contrato escrito e aprovado no gate de 2026-07-29 (`CHECKPOINT-E2.1` §9); Fase 1 (implementação) é a próxima entrega, sujeita às pré-condições de §17 |
```

**§17, current bullet list** (`docs/MASTER-ROADMAP.md:448-480`, status block at `452-457`):
```
### Epic E2.1 — Canonical Message Status

**Status atual**

- ✅ Fase 0 concluída
- ✅ `ADR-MSG-STATUS-001` aprovado
- ✅ `CHECKPOINT-E2.1-STATUS-CANONICAL` aprovado
- ⏳ Fase 1 (Implementação) ainda não iniciada
```
(followed by the R1/R2 pre-conditions text, which this plan does not touch — R1/R2 were pre-conditions for *starting* Phase 1; now that Phase 1 has code, leave that historical record as-is and add new content after it rather than deleting it.)

Commits to cite as evidence (all already on `main`, already pushed or ready to push — verify with `git log --oneline -20` before writing, in case more have landed since this plan was written):
- `319694f` "feat(E2.1): implement canonical status resolution and concurrency handling"
- `0711fbb` "docs: close E2.1 RC1 checkpoint"
- `c0af1f9` "feat(status): complete canonical status activation" — wires `parseStatusEvent()` into the non-Meta webhook route, adds migration `063` widening `messages.status` to the full 7-state set, fixes the `resolve-by-external-id` fallback to accept `sender_type IN ('agent','bot')`.
- `5a02996` "fix(whatsapp): wire connection bootstrap and webhook generation" — fixes `whatsapp_config.connection_id` never being set on INSERT (was breaking every fresh connection).
- `4955da9` "docs: record E2.1 activation gate evidence" — point-in-time audit trail for the above.
- `38a825e` "fix(security): enforce tenant isolation for RPCs and internal tables" — migration `073`.
- `2a6061e` "HOTFIX-002: S1 tenant escalation fix — profiles RLS + gate test" — migration `074`, `docs/checkpoints/CHECKPOINT-HOTFIX-002-S1.md`.
- `c999c44` "feat(identity): canonical phone identity and merge infrastructure" — migrations `064-072`, `docs/adr/ADR-IDENTITY-BR-001.md`, `docs/adr/ADR-CONTACT-MERGE-001.md`. Dormant (`identity_merge_v2_state` defaults `'off'`, no call site invokes `phoneIdentity()`/`merge_identity_group()` yet).
- `ecd78fa` "feat(deals): persist conversation origin on creation".

Repo convention for versioned roadmap changes: this doc has its own changelog inside itself (§"Histórico", lines 8-15 near the top) — each substantive update gets a new `vX.Y` bullet describing what changed and why, in the same voice/density as the existing v1.3/v1.4/v1.5 entries. Follow that pattern; do not silently edit history without adding a new versioned bullet.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Confirm HEAD | `git rev-parse --short HEAD` | matches what you cite in the doc |
| Confirm no code changed | `git diff --stat` | empty (this plan is docs-only) |
| Confirm commit messages | `git log --oneline 26e5d39..HEAD` | matches the list in "Current state" (plus anything newer — read it, don't assume) |

There is no build/typecheck/test gate for a markdown-only change; do not run `npx next build`/`vitest` as a done-criterion for this plan — there's nothing for them to catch here.

## Scope

**In scope**:
- `docs/MASTER-ROADMAP.md` only.

**Out of scope**:
- Any other doc (ADRs, checkpoints) — this plan reconciles the roadmap's *claims*, it does not re-litigate or re-audit the underlying decisions.
- Re-numbering epics or re-deriving the dependency graph (§8) — nothing in the five commits changes epic dependencies.
- Re-running the full "Gap Analysis" or "Epic table" audit from scratch. Touch only the specific rows/sections identified in "Current state". If you notice an unrelated stale claim while editing, note it in your final report but do not fix it here — scope creep in a docs plan is how the doc drifts from the code again.

## Git workflow

- Branch: `advisor/002-reconcile-roadmap-head`
- Single commit, conventional-commits style matching this repo's `docs:` prefix convention (see `git log --oneline` for examples like `docs: reconcile master roadmap with repository state`, `docs: synchronize ADR status with verified code state`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Bump the version header and snapshot SHA

Edit line 3. Bump `**Versão:** v1.5` → `v1.6`. Update the snapshot SHA to the actual current `git rev-parse --short HEAD` at the time you make this edit (confirm it first — do not copy `2e66c12` blindly if more commits have landed since this plan was written). Add a new bullet to the "Histórico" list (after the existing v1.5 bullet, lines 8-15) summarizing: E2.1 Phase 1 implemented and activated (cite `319694f`, `c0af1f9`, `5a02996`); two tenant-isolation hotfixes closed (migrations 073/074, HOTFIX-002); dormant identity/phone-merge infrastructure landed (migrations 064-072, feature-flagged off); C21 closed (migration 075, this session). Match the density and citation style of the existing v1.4/v1.5 bullets — they cite commit SHAs and checkpoint files inline, not just prose.

**Verify**: `git diff docs/MASTER-ROADMAP.md` shows only the header/changelog change so far; the new bullet reads coherently next to v1.5's.

### Step 2: Update the executive summary

Edit line 24. Change "Resta **E2.1** (Status Canônico) como único elo aberto da cadeia dura" to reflect that E2.1 Phase 1 is implemented and activated (not "concluído" outright unless you confirm — check whether any checkpoint closes E2.1 formally the way `E4b-final-checkpoint.md` closes E4b; if none exists, say "Fase 1 implementada e ativada" rather than claiming the epic is fully closed, and note in your final report that a closing checkpoint for E2.1 would be a reasonable next doc to write, without writing it yourself here).

**Verify**: re-read the full paragraph (lines 20-32) for internal consistency — it should no longer contradict itself against the E2.1 row you're about to update in Step 3.

### Step 3: Update the E2.1 epic-table row and §17 status block

Line 195: update the status cell to reflect Phase 1 implemented (cite `319694f`/`c0af1f9`/`5a02996`), keeping the same "P0" priority framing style as neighboring rows.

Lines 452-457 (§17 status block): change `- ⏳ Fase 1 (Implementação) ainda não iniciada` to `- ✅ Fase 1 (Implementação) ativada` (or equivalent), and add one short paragraph after the existing bullet list (before the R1/R2 pre-conditions text — leave R1/R2 untouched as historical record of what gated the start of Phase 1) citing what actually shipped: non-Meta status dispatch wired into the webhook route, migration 063 (5→7 status states), the `resolve-by-external-id` `sender_type IN ('agent','bot')` fix, connection bootstrap fix. Do not delete the R1/R2 pre-conditions section — it remains accurate as a record of what had to be true before Phase 1 could start.

**Verify**: §17 reads coherently top to bottom — a reader should come away knowing Phase 1 shipped and roughly what it contains, without the R1/R2 history being confusing about timing.

### Step 4: Close C21 in the Gap Analysis

Line 180: split C21 out of the open list. Change:
```
| FKs / integridade | — | C16, C19, C20, C21 | E3 | P2 |
```
to reflect C21 closed (migration 075) while C16/C19/C20 remain open — e.g. add a `~~C21~~` strikethrough or a footnote consistent with how other closed items in this same table are marked (see how `~~Messaging core~~`, `~~Provider boundary~~` etc. use strikethrough + "CONCLUÍDO" in the same table, lines ~164-179, for the pattern to match).

**Verify**: the row's formatting matches the strikethrough convention already used elsewhere in the same table (§6).

### Step 5: Full read-through

Read the entire file once, start to finish, checking specifically that the four edits above don't leave contradictions elsewhere (e.g., §1's "Cadeia de precedência dura" paragraph around line 30, §9 "Roadmap por fases" Fase 2 status text, and §13 MVP checklist's `[ ] **status não-Meta (E2.1)**` line — that checkbox should likely flip to `[x]` if you're confident Phase 1 is genuinely active end-to-end; if uncertain, leave it unchecked and say so in your final report rather than guessing).

**Verify**: `grep -n "Fase 1 (Implementação) ainda não iniciada\|único elo aberto da cadeia dura" docs/MASTER-ROADMAP.md` returns no matches (both stale claims removed), OR if any remaining match is intentional (e.g. inside the historical v1.4 changelog bullet, which should NOT be edited — changelog entries are point-in-time and immutable), confirm by inspection that it's the changelog, not a live status claim.

## Test plan

Not applicable — documentation-only change, no automated test exists or should be added for prose content. Verification is entirely the read-through in Step 5 plus the grep checks in each step.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `git diff --stat` shows only `docs/MASTER-ROADMAP.md` changed
- [ ] Version header (line ~3) shows `v1.6` and a HEAD SHA matching `git rev-parse --short HEAD` at commit time
- [ ] `grep -n "Fase 1 (Implementação) ainda não iniciada" docs/MASTER-ROADMAP.md` — no live-status match (changelog-only mentions, if any, are fine)
- [ ] `grep -n "C16, C19, C20, C21" docs/MASTER-ROADMAP.md` — no longer lists C21 as open alongside C16/C19/C20 without a closed marker
- [ ] A new "Histórico" bullet (v1.6) exists citing the five commits from "Current state"
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `git log --oneline 26e5d39..HEAD` no longer matches the commit list in "Current state" (more work landed since this plan was written) — re-derive what's actually unreflected before editing, don't blindly apply this plan's specific wording to a different set of commits.
- You cannot find a checkpoint that formally closes E2.1 (the way `E4b-final-checkpoint.md` closes E4b) and are unsure whether to describe E2.1 as "Phase 1 implemented" vs "epic concluded" — default to the more conservative "Phase 1 implemented and activated," do not invent a closure that isn't documented elsewhere.
- Any edit you're about to make would require re-deriving §8's dependency graph or §10's risk matrix from scratch — that's out of scope; report it as a follow-up instead.

## Maintenance notes

- This plan intentionally does not touch §10 (risk matrix) to add rows for the two tenant-isolation hotfixes (migrations 073/074) or the dormant identity-merge infrastructure (064-072) — both are real gaps in the roadmap's own risk tracking, deliberately left for a separate, focused pass rather than bundled into this doc-sync plan (which is scoped to the E2.1-staleness problem specifically). Worth a Plan 003 if the maintainer wants it.
- Once E2.1 gets a formal closing checkpoint (if/when one is written), the E2.1 epic-table row and §13 MVP checklist should be revisited again — this plan only gets the doc from "wrong" to "accurate about Phase 1," not necessarily to "epic closed."
