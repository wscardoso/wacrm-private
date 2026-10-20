# Z-API decommission — operational runbook

**Status (2026-10-20): PREPARED, NOT EXECUTED.** Nothing in this directory has been run against any remote database. The code removal is done and tested locally; the data side below needs an authorised operator. The delivery-binding contract (`messages.connection_ref` and friends) is implemented locally and its migration is prepared, not applied: see `delivery-binding-rollout.md`.

The scripts were validated only on an in-memory Postgres (`src/test/zapi-decommission-sql.pglite.test.ts`, 41 tests). That proves the SQL does what it claims on a representative schema; it does not prove anything about the real database. A technical identity ([0] of the inventory) does not prove that the database is the intended one either: the person running it must confirm the environment by other means.

Files:

| File | Purpose | Writes? |
|---|---|---|
| `01-inventory.sql` | Identity of the session, schema contract of the delivery jobs, foreign keys/cascades of `whatsapp_config`, legacy footprint, reference values | No |
| `02-decommission.sql` | Clears the legacy Z-API token holder and marks zapi rows disconnected; takes a transaction-local "before" snapshot | **Yes** |
| `03-verify.sql` | Compares the state with the snapshot (same transaction, before COMMIT) | No |
| `connection-ref-schema-analysis.md` | Evidence and alternatives for `messages.connection_ref` (pre-decision analysis) | — |
| `delivery-binding-rollout.md` | The implemented binding contract, ordered rollout, verification, monitoring, rollback | — |
| `../../../supabase/migrations/083_messages_delivery_binding.sql` | Adds the three binding columns to `messages` (additive) | **Yes — NOT applied** |

## What the code already guarantees (local, tested)

| Situation | Behaviour |
|---|---|
| Account saved with `provider='zapi'` | Never dispatched to any provider. `providerConfigFromRow` throws `ProviderUnsupportedError`; it never falls through to Meta. |
| `POST /api/whatsapp/config` with `provider:"zapi"` | `400`, nothing read or written. |
| `GET /api/whatsapp/config` on a zapi row | `200`, `connected:false`, `reason:"provider_unsupported"`. |
| `DELETE /api/whatsapp/config` | Unchanged; works for any provider. **It deletes the row and, by FK cascade, its `whatsapp_webhook_dlq` history** (and anything else [2] of the inventory finds). |
| `/api/whatsapp/webhook/zapi/…` | `410 Gone` before any DB access. |
| `/send`, `/broadcast`, `/react` | `400 Unsupported WhatsApp provider: zapi`. |
| Automations / flows | Throw `ProviderUnsupportedError` (the step fails; nothing is sent). |
| Retry cron, zapi connection | **Blocked** (`pending`, `next_attempt_at NULL`, explicit `last_error`), never re-sent, never dead-lettered. |
| Retry cron, message lookup fails for any reason other than "no such row" (incompatible schema, permissions, network) | Entry **released** to `pending` with its due time kept and an explicit `last_error`; **not** dead-lettered; nothing sent or settled. Only `PGRST116` (no row) still dead-letters. |
| Retry cron, message without a complete, valid binding (`connection_ref`, `delivery_provider`, `delivery_channel_fp`) | Blocked (original provider unknown) — never retried through another provider. Legacy messages are never backfilled and never re-sent. |
| Retry cron / orphan-sweep, connection removed, of another account, provider or channel changed, or no evidence of non-delivery | Blocked with an explicit reason (`blocked (<reason>): …`), never `dead`, never re-sent. Rules: `delivery-binding-rollout.md` §1. |
| Orphan sweep | A `sending` orphan of a zapi connection gets the blocked ledger entry (explicit `last_error`), without decrypting the credential and without repeating an error each run. A failed `select` logs the PostgreSQL error code. |
| Re-saving the row as uazapi | Writes `waba_id = NULL`, so a legacy Z-API token is not carried into the new connection. |

A blocked entry is resolved only by the existing TTL sweep (72 h): the message, still `sending`, is then settled `failed` and the entry goes `dead`. **Correction:** before the TTL fix of this work the sweep passed `''` for the UUID parameter `p_connection_ref`, which PostgreSQL rejects, so this resolution did not actually happen; it now passes `NULL` (verified on a real PostgreSQL function, not through PostgREST). That is the same path (ADR-E4B-002 §5 caminho D) that every Meta and uazapi orphan takes today, because neither provider declares `nativeIdempotency`. The delivery state of such a message is unknown; nothing marks it as sent and nothing re-sends it.

## Finding: `messages.connection_ref`

The orphan sweep and the retry cron read `messages.connection_ref`; before migration 083 no versioned migration created it and no writer set it. Whether the production database has it is **unknown** until an authorised operator runs `01-inventory.sql` ([1] reports type and nullability, [2d] who else writes it, [2e] the settle function signature). If it is absent, the sweep processes nothing and the cron cannot retry anything, for every provider; the cron does not destroy ledger entries in that situation (see the table above). The decision is taken and implemented locally: `delivery-binding-rollout.md`. **Order: migration 083 first, then the release** — a release that writes the columns into a database without them fails every send. Do not "fix" the database to make the inventory run.

## Read-only protection and its limits

`01-inventory.sql` starts with `SET default_transaction_read_only = on;` and ends with `RESET default_transaction_read_only;`. This is a session setting: it works in autocommit and inside an explicit transaction, and an error in one statement does not poison the others (there is no wrapping transaction). Limits:

* It is a guard rail, not a security boundary: the same session or a superuser can switch it off. The script itself contains only `SELECT`.
* A connection pooler in *transaction* mode may run the statements on different server sessions, so the `SET` may not apply to the later ones. **Always confirm with [0]**: `transaction_read_only` must be `on`; if it says `off`, stop. Where possible connect with a role that has no write privilege at all — that is the only real protection.
* `SET TRANSACTION READ ONLY` (inside `BEGIN`) is the alternative; it only covers that transaction. Either is acceptable if [0] confirms it.
* Run `[0]`..`[2e]` first: they read only catalogs and always return a diagnosis. Statements `[3]`..`[10]` read application tables and fail if the schema lacks them; the `blocks_statements` column of [1] says which. With `psql`, do not use `ON_ERROR_STOP` for the inventory: a failure of one data statement should not hide the diagnosis already printed.

## Procedure

1. **Confirm the target** (project, environment) with the owner. Do not use a connection whose identity is not certain.
2. **Inventory (read only).** Run `01-inventory.sql`. Keep the whole output. Review:
   * [0] identity and read-only state; [1]/[1b] schema contract (any non-`OK` row is a finding, `messages.connection_ref` first);
   * [2]/[2b] foreign keys and cascades. `in_versioned_migrations = false` is a dependency the repository does not know about; `found_in_database = false` in [2b] is drift. **No row does not prove "no dependency".**
   * [3] providers, [4] unexpected providers, [5] `waba_id` on non-Meta rows (manual review), [6]/[7] pending work and DLQ history of zapi accounts.
3. **Decide per account.** A zapi account stays *explicitly unsupported* until its operator configures and validates uazapi or Meta in *Settings → WhatsApp* (that screen pre-selects uazapi and pre-fills nothing from the Z-API row). Nothing is converted automatically and no credential is copied between providers.
4. **Backup** of `whatsapp_config` (at minimum `id`, `status`, `waba_id` of the rows listed in [9]), verified restorable. **Rehearse the whole sequence on a copy first**, with the same role.
5. **Decommission (writes).** One transaction, REPEATABLE READ — `02` refuses otherwise, because the "before" snapshot and the checks of `03` must see one frozen database:
   ```sql
   BEGIN ISOLATION LEVEL REPEATABLE READ;
   SET LOCAL zapi_decommission.backup_confirmed = 'yes';
   \i 02-decommission.sql
   SET LOCAL zapi_decommission.expected_zapi_rows            = '<zapi_rows from inventory [8]>';
   SET LOCAL zapi_decommission.expected_non_zapi_fingerprint = '<non_zapi_fingerprint from inventory [8]>';
   \i 03-verify.sql        -- 11 rows, every one must show ok = true
   COMMIT;                 -- otherwise ROLLBACK;
   ```
   A *serialization failure* means a targeted row changed concurrently: roll back, re-run the inventory, and decide again.
6. **Revoke externally** (not done by any script, not authorised by this work): in the Z-API dashboard, revoke the instance token and the Security Token, and remove the webhook. Until then the stored `access_token` of each zapi row is a live credential. After revocation the account owner may remove the row in the UI (*Reset Configuration*); do that knowing it cascades the row's DLQ history and whatever [2] listed.

## What `03-verify.sql` proves — and does not

It checks, inside the frozen snapshot: no zapi row connected, none keeps `waba_id`; the zapi row count, the other columns of the zapi rows, the fingerprint of every non-zapi row, and the row counts of `messages`, `outbound_retry_ledger` and `whatsapp_webhook_dlq` are unchanged; and (criteria 10–11) that the state still equals the inventory the operator read.

Counts and fingerprints show that **this transaction** deleted or inserted nothing and left other rows alone. They do not prove the content of the data, the absence of concurrent changes outside the snapshot, or that the backup is restorable. The fingerprints hash only technical columns and *presence* flags (`IS NOT NULL`) plus `updated_at` (bumped by the `set_updated_at` trigger — see [2c]); **no credential value is hashed, selected or printed**. If [2c] shows no such trigger, the fingerprint is weaker.

The "before" values live only in transaction-local settings (`set_config(…, true)`): nothing is written to any table and nothing outlives the transaction. Counts from the inventory are NOT used as the "before" values, because a live system moves between the inventory and the decommission.

## Success criteria

- `03-verify.sql`: all 11 criteria `ok`.
- Re-running `02-decommission.sql` updates 0 rows.
- After the TTL window (72 h) the zapi accounts' `sending` messages are `failed` with their ledger entries `dead` (inventory [6]/[7] buckets empty).

## Rollback

Restore `status` and `waba_id` of the affected rows from the backup (they are the only columns changed). There is no other copy of the cleared `waba_id` values.

## Secrets

* `waba_id` is a Meta-only column holding a plaintext WABA id on Meta rows. On `provider='zapi'` rows it held the encrypted Security Token (the code wrote it only from `client_token`). The script therefore selects by `provider`, not by value, and never decrypts or prints anything.
* On a `uazapi` row a non-NULL `waba_id` is a leftover but cannot be classified by content (plaintext Meta WABA id vs. encrypted token). The script leaves those rows alone; they are reported by inventory [5] for manual review. New uazapi saves clear the column.
* The settings screen reads `whatsapp_config` with `select('*')` from the browser (RLS-scoped to the account's members), so a legacy `waba_id` ciphertext reaches that browser until the column is cleared. This predates the removal.
* No script here uses a credential value, not even inside a hash. (An earlier version fingerprinted `access_token` with unsalted `md5`; it was removed.)
