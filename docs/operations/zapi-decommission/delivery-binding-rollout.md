# Delivery binding (`connection_ref`) — implementation and rollout

**Status (2026-10-20): IMPLEMENTED LOCALLY. Migration 083 NOT applied. Nothing deployed. No remote database was read or changed.**

| Stage | State | Evidence |
|---|---|---|
| Code (binding helper, `createIntent`, 5 creation sites, cron, orphan-sweep, TTL fix) | Done locally, **uncommitted** | tests listed in §7 |
| Migration `083_messages_delivery_binding.sql` | Prepared; rehearsed **only on in-memory PostgreSQL** (PGlite) | `src/test/delivery-binding.pglite.test.ts` |
| Remote schema inventory | **BLOCKED** — no authorised, identified connection | `01-inventory.sql` is ready |
| Rehearsal on a copy of the real database | **Not done** | needs a copy and an operator |
| Migration applied / release deployed / new rows verified | **Not done** | §3–§5 |

Architecture is **not** reopened here. The decision (snapshot of the delivery identity on the message, one creator, retry only with proof) is in `connection-ref-schema-analysis.md` and the ADRs it cites.

## 1. The contract

Every OUTBOUND message row carries, written in the **same INSERT** that creates it (`createIntent`, the only module allowed to insert into `messages`):

| Column | Value |
|---|---|
| `connection_ref` (uuid) | `whatsapp_config.id` at creation (EIS-001 §3.2). No FK. |
| `delivery_provider` (text) | `meta` or `uazapi` |
| `delivery_channel_fp` (text) | `v1:` + SHA-256 hex of the non-secret channel identity: `["v1","meta",phone_number_id]` or `["v1","uazapi",instance_id,normalised base_url]` (NFC, trimmed, URL reduced to origin + path without trailing slash, userinfo dropped). No token, no `waba_id`. |

Why a snapshot and not the id alone: `whatsapp_config` is edited in place (`UNIQUE(account_id)`), so its id survives a switch of provider, number or instance. A message is re-sent only if the connection that exists **now** reproduces what it was created for.

Single helper: `src/lib/whatsapp/delivery/connection-binding.ts` (`bindingFromConnection` at creation, `evaluateBinding` at retry). Creation is centralised and guarded by `src/test/outbound-message-creation.arch.test.ts`, which fails if any other module inserts into `messages`.

### Retry rule (cron and orphan-sweep)

A message is re-sent only when **all** hold; otherwise the ledger entry is **blocked** (`pending`, `next_attempt_at NULL`, `last_error = 'blocked (<reason>): …'`) — never `dead`, never re-sent:

1. stored binding present and well formed (`binding_missing` / `binding_invalid`);
2. the lookup of the connection did not error (a query error **releases** the entry, due time kept, and is retried);
3. the connection exists (`connection_removed`) and its id is the stored one (`connection_mismatch`);
4. `whatsapp_config.account_id == conversations.account_id` (`account_mismatch`);
5. the provider is supported (`provider_unsupported`) and unchanged (`provider_changed`);
6. the recomputed fingerprint equals the stored one (`channel_changed`; `channel_unprovable` if it cannot be computed);
7. **evidence of non-delivery**: the classification is `deterministic_transient` **or** the provider declares real `nativeIdempotency` (`no_evidence_of_non_delivery`). The policy was not widened. Today neither Meta nor uazapi declares `nativeIdempotency`, and only uazapi can produce `deterministic_transient` (ECONNREFUSED / ENOTFOUND / EAI_AGAIN).

Legacy messages (created before the release; columns `NULL`) are **never** re-sent and **never** backfilled: the account's current provider says nothing about the provider that sent them. They drain by TTL (72 h).

### TTL sweep fix (stage 0)

The TTL sweep called `settle_outbound_message_system` with `p_connection_ref = ''`. `''` is not a valid `uuid`; PostgreSQL rejects it (`invalid input syntax for type uuid`), so the sweep never settled anything — **earlier statements in this directory that "the TTL resolves blocked entries" were not true before this fix**. It now passes `NULL`; the sweep also no longer treats a lookup error as "message gone", and marks an entry resolved only when the settlement outcome is `failed`. Proved on a real PostgreSQL function (PGlite): `''` is rejected, `NULL` settles, a second settlement is a noop, two concurrent ones yield exactly one winner. **Not executed against the real PostgREST/Supabase path.**

## 2. Prerequisites (access the implementer does not have)

* An identified, authorised **read-only** connection to the target database (project/environment confirmed by its owner). Without it nothing in §3 can be done or claimed.
* A **copy** of the database (or a branch) for the rehearsal, with the same role that will run the migration.
* Explicit authorisation to apply `083` and to deploy.

## 3. Ordered rollout

Order matters: **the migration must precede the release that writes the columns.** A release that inserts `connection_ref` into a database that lacks it makes **every outbound send fail** (proved: `delivery-binding.pglite.test.ts`, "a database lacking migration 083 rejects the insert").

0. **TTL fix** is code: it ships with the release (§4) and does not depend on the migration (it passes `NULL`, which the existing function already accepts). If it must go earlier than the rest, deploy it alone — it is independent of the columns.
1. **Confirm the schema (read-only).** Run `01-inventory.sql` on the target. Read, in this order:
   * [0] identity and `transaction_read_only = on` (else stop);
   * [1] contract: expect `messages.connection_ref`, `delivery_provider`, `delivery_channel_fp` as `MISSING`, or `connection_ref` present — if present with a type other than `uuid`, **stop**: migration 083 refuses to adopt it (`TYPE_MISMATCH`), and someone must explain where it came from;
   * [2d] triggers on `messages` and functions mentioning the columns (anything other than `settle_outbound_message*` / `insert_message_external_ids` needs a human);
   * [2e] exact signature of `settle_outbound_message_system`: `p_connection_ref uuid DEFAULT NULL`;
   * [6]/[7] and the age of `sending` messages (the population that will become eligible for the TTL).
2. **Rehearse on a copy.** Apply 083, re-apply it (must be a no-op), re-run the inventory ([1] all `OK`), run a send through the app against the copy.
3. **Apply 083 on the target** (additive: three nullable columns, no default, no FK, no index, no backfill; `NOTIFY pgrst, 'reload schema'` is included). Re-run [1]: all `OK`. Confirm PostgREST sees the columns (a `select=connection_ref,delivery_provider,delivery_channel_fp` through the API returns, rather than `42703`/`PGRST204`).
4. **Deploy the release** (§4).
5. **Verify that new rows fill the fields** (§5). Do this **before** relying on any retry behaviour.
6. **Read rule.** It ships with the release: from the moment it runs, a message without a binding is blocked rather than re-sent. There is nothing to switch on later.
7. **Monitor** (§6) for at least one full TTL window (72 h).

## 4. What the release contains (all uncommitted in the working tree)

`connection-binding.ts` (new) · `settlement.ts` (`createIntent` writes the binding; `settleMessageSystem` sends `NULL`, never `''`) · `sender.ts` · `send/route.ts` · `flows/meta-send.ts` and `automations/meta-send.ts` (text, media, interactive, template via `createIntent`) · `delivery/cron/route.ts` · `delivery/orphan-sweep/route.ts` · migration `083`.

## 5. Verification after the release (read-only)

`01-inventory.sql` [10] gives the counts. What proves success:

* New outbound rows (created after the deploy) show `has_binding = true`, `config_same_account = true`, `provider_matches_snapshot = true`. `has_binding = false` rows must all be older than the deploy time.
* Any new row with `has_binding = false` means a creation path escapes `createIntent`: **stop and investigate**.
* Rows of Meta **and** uazapi accounts both appear (the two providers keep working).

Equivalent single-account query (no content, no phone):

```sql
SELECT m.delivery_provider, count(*) AS rows_, min(m.created_at) AS first_seen
FROM public.messages m
WHERE m.sender_type IN ('agent','bot') AND m.connection_ref IS NOT NULL
  AND m.created_at > '<deploy time>'
GROUP BY 1;
```

## 6. Monitoring

* `outbound_retry_ledger` rows with `next_attempt_at IS NULL` and `last_error LIKE 'blocked (%'`: group by the reason inside the parentheses. A burst of `binding_missing` right after the deploy is the legacy population (expected, bounded by 72 h); later it must be ~0.
* `channel_changed` / `provider_changed` / `account_mismatch` after the deploy: a real configuration change or a defect — review each.
* Logs of the two jobs: lookup errors now print the PostgreSQL error code (`42703` = column missing → migration not applied).
* `sending` messages older than 72 h must trend to 0 (the TTL fix at work). If they do not, the TTL settlement is still failing on the real path.

## 7. Local validation

Targeted tests (all passing at the time of writing): `connection-binding.test.ts`, `outbound-message-creation.arch.test.ts`, `outbound-creation-sites.test.ts`, `send/route.test.ts`, `delivery/cron/route.test.ts`, `delivery/orphan-sweep/route.test.ts`, `delivery-binding.pglite.test.ts`, `zapi-decommission-sql.pglite.test.ts`. The full suite / `tsc` / lint results are in the final report of this work, with the baseline comparison.

What these tests **cannot** show: behaviour of the real PostgREST/Supabase stack (schema cache, RLS with the service role, error shapes), the real Meta and uazapi servers, or production data.

## 8. Rollback

* **Release:** redeploy the previous build. The columns stay; the old code ignores them. Messages created meanwhile keep their binding and are harmless.
* **Migration:** normally not rolled back. If it must be, `ALTER TABLE public.messages DROP COLUMN delivery_channel_fp, DROP COLUMN delivery_provider, DROP COLUMN connection_ref;` — **only after** the release that writes them is gone (otherwise every send fails), and **never** if `connection_ref` pre-existed (the migration adopts a pre-existing uuid column; dropping it would destroy data that was not ours). Check in [1] / migration history before dropping.
* A blocked ledger entry is not rolled back: it is resolved by the TTL.

## 9. Known residual risks (not fixed by this work)

1. ~~The cron marks a ledger entry `dead` for a `content_type` it cannot rebuild (e.g. Flows `interactive`) leaving the message `sending` until the TTL.~~ **Fixed (local, uncommitted):** the cron never writes `dead` while the message is `sending`. For an unsendable entry (unsupported `content_type`, missing recipient) it first settles the message `failed` through `settle_outbound_message_system` (compare-and-set) and only then marks the entry `dead` — and only when the ledger classification is `deterministic_transient` (proof that no earlier attempt was delivered). Otherwise the entry is blocked (`pending`, `next_attempt_at NULL`) and the TTL resolves both. The same rule covers a fatal exception in the drain (blocked, `scheduler_fatal_error`) and a failing settle (released or blocked, never `dead`). The cron also re-reads the message status and re-sends only while it is `sending`; a message already `sent`/`delivered`/`read` closes the entry `delivered`, `failed` closes it `dead`, anything else blocks it.
2. Flows media inserts never persisted `media_url`, so a media retry has nothing to send (it is blocked/dead, not misdelivered).
3. The cron re-sends a template without language/components.
4. If settlement fails **after** the provider accepted the send, the delivery state is unknown. **Changed (local, uncommitted):** the entry is no longer `dead`; it is blocked (`settle_failed_after_send`, with the provider message id in `last_error` for reconciliation), never re-sent, and the 72 h TTL settles the message `failed` (risk 5 applies: it may have been delivered). A settle `noop` after a real send (the message left `sending` between the status read and the settle) is no longer recorded as `delivered`: the entry goes `dead` with a possible-duplicate reason, because this send did not settle the message.
5. The TTL marks a possibly-delivered message `failed` (state unknown, by design of ADR-E4B-002 §5 path D).
6. `/broadcast` and `/react` create no `messages` row, so they are outside this contract.
7. Everything in §7 "cannot show".
