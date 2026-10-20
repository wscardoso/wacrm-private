# `messages.connection_ref` — schema incompatibility of the delivery jobs

**Status (2026-10-20): decided and implemented LOCALLY — see `delivery-binding-rollout.md`. Migration 083 is prepared and NOT applied; nothing was changed in any database.**

This document is the analysis that preceded the decision. Its §1 facts describe the repository **before** the implementation: since then `createIntent` writes `connection_ref`, `delivery_provider` and `delivery_channel_fp` in the same INSERT, and Flows and Automations create their messages through `createIntent` (no other module inserts into `messages`; enforced by `src/test/outbound-message-creation.arch.test.ts`). Statements about the **production** schema remain conditional until `01-inventory.sql` is run by an authorised operator.

**Correction.** §3 below says the TTL sweep "keeps working" and the README said it "resolves" blocked entries. That was wrong: the sweep called `settle_outbound_message_system` with `p_connection_ref = ''`, which PostgreSQL rejects as an invalid `uuid`, so it settled nothing. It now passes `NULL` (proved on a real PostgreSQL function, not on PostgREST).

## 1. What the repository establishes

| Fact | Evidence |
|---|---|
| The retry cron selects `messages.connection_ref` and uses it as the id of the connection to send through. | `src/app/api/whatsapp/delivery/cron/route.ts` — select list of the message lookup; `const connectionRef = msg.connection_ref as string`; `whatsapp_config … .eq('id', connectionRef)`. |
| The orphan sweep selects `messages.connection_ref` and looks the connection up by it. | `src/app/api/whatsapp/delivery/orphan-sweep/route.ts` — `.select('id, connection_ref, conversation_id, created_at')`; `whatsapp_config … .eq('id', msg.connection_ref)`. |
| No versioned migration (001–082; the `082` file lives on the PR #25 branch, not in this release) creates `messages.connection_ref`. | `git grep connection_ref -- supabase`: occurrences are only `message_external_ids.connection_ref` (047) and the `p_connection_ref` parameters of `settle_outbound_message*` (048, 050, 073). `git log -S connection_ref` finds 4 commits; none adds it to `messages`. The `messages` DDL is 001 plus `ALTER`s in 009, 010, 048 (`idempotency_key`), 063 (status CHECK). |
| The writers of `messages` never set it. | `createIntent` (`src/lib/whatsapp/delivery/settlement.ts`) inserts `id, conversation_id, sender_type, content_type, content_text, media_url, template_name, status, idempotency_key, reply_to_message_id` — no `connection_ref`, although it receives `args.connectionRef`. `settle_outbound_message` writes the provider id into `messages.message_id` and, when identities are present, rows into `message_external_ids`. Flows and Automations insert their own `messages` rows (`src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts`) without it either. |
| `createIntent` has 5 call sites. | `send/route.ts` (non-Meta and Meta paths) and `delivery/sender.ts` (3). |
| One WhatsApp connection per account. | `whatsapp_config_account_id_key UNIQUE (account_id)` (017: "one WhatsApp number per account"). |
| The tests cannot see it. | Route tests mock Supabase; PGlite schemas mirror `messages` without the column. |

Consequently, **against a database that has exactly the versioned schema**, both queries fail with PostgreSQL `42703 (column … does not exist)`.

## 2. What is not known

Whether the production database has the column. The repository cannot answer: an out-of-band change (SQL editor, an unversioned migration) is possible, and so is the opposite. `01-inventory.sql` [1] now answers it, with existence, type (`udt_name`), `data_type` and nullability, and [0] states which database answered. Until someone runs it, **every statement below about production is conditional.**

## 3. Observable effect if the column is absent

* **Orphan sweep:** the first query fails → `[orphan-sweep] select orphans failed` is logged and 0 orphans are processed, every run, for every provider. It writes nothing.
* **Retry cron (before the change in §6):** the message lookup returned an error that was reported as *"message not found"* and the ledger entry was marked `dead`. Entries created by the synchronous failure path (`handleSendFailure` → `enqueue_outbound_retry`) would be dead-lettered at their first due run, without ever being retried.
* **TTL sweep** (`sweepExpired`) does not use the column and keeps working.

## 4. Alternatives

### A. The database already has the column (the repository is behind the database)

*Evidence needed:* `01-inventory.sql` [1] reports `messages.connection_ref` as `OK` (`uuid`) — and, to be useful, nullability and a sample of how many recent `sending`/`failed` rows have it non-null (a count only, never values).

*Consequences:* production works while the repository does not describe it. Any environment built from migrations (a new staging project, a restore from schema, the PGlite suites) lacks the column, so the jobs fail there. The drift must be recorded; the migration that would reproduce the column must still be written, and its relation to the existing column (type, nullability, FK, who writes it) is unknown from the repository. **Who writes the column in production is a separate open question:** the repository's writers do not.

*Effect on providers:* none from the decision itself.

### B. Add `connection_ref` by migration

* **Origin of the value:** `whatsapp_config.id` of the connection used for the send. Known at every write site: `send/route.ts` (`config.id`), the three `sender.ts` helpers (their `connectionRef` argument), and, for Flows/Automations, the `config` row they already load. `createIntent` already receives `connectionRef` and ignores it.
* **Writing it:** `createIntent` would add `connection_ref: args.connectionRef`; the direct inserts in `flows/meta-send.ts` (3 sites) and `automations/meta-send.ts` must be changed too, otherwise their orphans have no connection.
* **Old rows / NULLs:** every existing row would be `NULL`. A backfill is possible only through the account relation (`messages → conversations.account_id → whatsapp_config`, valid because of `UNIQUE(account_id)`) and is wrong for a message sent through a provider the account has since switched away from. Rows that stay `NULL` need a defined behaviour in the jobs (the cron now blocks them, §6).
* **Schema:** `ALTER TABLE messages ADD COLUMN connection_ref UUID` (nullable, no default; a rewrite-free change on PostgreSQL 11+). An FK `REFERENCES whatsapp_config(id)` must choose a delete rule: `CASCADE` would delete messages when a config is deleted (unacceptable), `SET NULL` silently destroys the link, `RESTRICT/NO ACTION` would block *Reset Configuration*. No FK is also a valid, weaker choice. An index is only needed if something filters by it; the jobs filter by `messages.id`/`status`.
* **Compatibility:** additive; old code ignores it. New code must tolerate `NULL` during the transition.
* **Rollback:** `ALTER TABLE messages DROP COLUMN connection_ref` — loses the values written since; code reverted first, or the jobs fail again.
* **Impact on Meta / UAZAPI:** positive (retry and sweep become able to work for both); risk is the first activation of machinery that may have been inert: old `sending` messages become eligible orphans and `failed`/ambiguous rows may start being retried. A pre-activation inventory of `sending` messages older than the TTL is advisable. Z-API legacy: with the column populated, a zapi row is handled by the blocked path added in the last phase; without it (NULL), by the NULL-connection path (§6).

### C. Derive the connection through the existing relations

* **Relations:** `messages.conversation_id → conversations.account_id → whatsapp_config.account_id`. Cardinality is 1:1 because of `UNIQUE(account_id)`; the lookup returns at most one config.
* **More than one configuration per account:** impossible today by constraint. If the constraint is ever relaxed, this alternative silently picks the wrong connection; it must be paired with a guard (fail if the count ≠ 1).
* **Avoiding the wrong connection:** a message sent through provider P, then the account switches to Q, then the message is retried: the derivation yields Q, so the retry would go out through **another provider than the original**. The ADR-E4B-002 caminho D rule ("never resend blindly") is not satisfied for providers without idempotency; the retry would have to be refused whenever the account's current provider differs from the one that sent — and the message does not record which one sent. That information exists only in B.
* **Idempotency / isolation:** account scoping is inherent (the account comes from the conversation), which is an advantage over B; idempotency of the resend is unchanged (the ledger is keyed by `message_id`).
* **Schema:** none. Code: cron and sweep select `conversations(account_id)` through the message (an embedded select) and look the config up by `account_id`; tests for both change.
* **Rollback:** code revert only.
* **Impact on Meta / UAZAPI:** works for both while an account never switches provider; unsafe exactly in the case that matters for this decommission (an account migrating from Z-API to uazapi would have its legacy `sending` messages retried through uazapi). Not recommended without an extra signal of the original provider.

## 5. Comparison

| | A | B | C |
|---|---|---|---|
| Schema change | none (needs drift record + migration for new environments) | additive column | none |
| Knows the original provider of a message | only if production writes it | **yes** | **no** |
| Z-API → uazapi switch safe for old messages | depends on how production fills it | yes (old rows `NULL` → blocked) | **no** (retried through the new provider) |
| Code changes | none | `createIntent` + 4 direct inserts + tests | cron + sweep + tests |
| New-environment parity | broken until migrated | restored | restored |
| Needs authorisation outside the repo | verification query | migration (+ optional backfill) | none |

No recommendation is made here: that is the schema owner's call. What the evidence supports is that C cannot distinguish the original provider, which is the property the decommission relies on.

## 6. What was changed locally without deciding the schema

`src/app/api/whatsapp/delivery/cron/route.ts` now separates the cases that used to be collapsed into "message not found → dead":

| Situation | Before | Now |
|---|---|---|
| Message really absent (`.single()` returned no row, PostgREST `PGRST116`) | ledger `dead` | unchanged: ledger `dead` |
| Lookup failed for any other reason (missing column `42703`, permissions, network, anything) | ledger `dead` (*"message not found: …"*) | ledger returns to `pending` **keeping its due `next_attempt_at`**, with an explicit `last_error` (`message lookup failed … — not dead-lettered`); the next cron run tries again; nothing is sent or settled |
| Message has a `NULL`/empty `connection_ref` (column exists but not filled) | `.eq('id', null)` → query error → `dead` | blocked (`pending`, `next_attempt_at NULL`, explicit reason): the original connection is unknown, so a resend is unsafe; only the TTL resolves it |
| Config lookup failed for any reason other than absence | ledger `dead` | returns to `pending` as above |
| Conversation/contact lookup failed for any reason other than "no row" | ledger `dead` (*"contact phone not found"*) | returns to `pending` as above |
| Recipient really missing (no row, or contact without phone) | ledger `dead` | unchanged |
| Config really absent | ledger `dead` | unchanged |
| Provider no longer supported (e.g. Z-API) | blocked (previous phase) | unchanged |

The orphan sweep already only logs on a failed query and writes nothing; its log line now names the PostgreSQL error code, so a schema incompatibility is recognisable instead of generic.

This does not make the retry machinery work against a database without the column: it stops it from destroying ledger entries while the schema question is open.
