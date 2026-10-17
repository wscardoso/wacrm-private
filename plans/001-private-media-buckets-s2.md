# Plan 001: Chat/flow media buckets stop leaking cross-tenant reads (S2)

> **v2 (2026-09-08)** — amended after the first execution attempt correctly
> stopped on a real gap: `src/app/api/whatsapp/delivery/cron/route.ts` also
> forwards a stored `media_url` to Meta as a fetchable `link` and was missing
> from v1's scope. Added as Step 3b. Steps 1, 2, and 5 already landed on
> branch `advisor/001-private-media-buckets-s2` (commits `f2fb38d`,
> `e2657be`) under v1 and remain valid — do not redo them, resume from Step 3.
>
> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2e66c12..HEAD -- supabase/migrations/016_flow_media.sql supabase/migrations/020_account_sharing_followups.sql supabase/migrations/023_chat_media.sql src/lib/storage/upload-media.ts src/app/api/whatsapp/send/route.ts src/lib/flows/engine.ts`
> If any of those files changed since this plan was written, re-read them and
> compare against the "Current state" excerpts below before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P0
- **Effort**: L
- **Risk**: HIGH (touches every media send path and every place media is rendered; a mistake breaks outbound media delivery or hides legitimate media from its own account)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `2e66c12`, 2026-09-08

## Why this matters

`chat-media` and `flow-media` are Supabase Storage buckets with `public = TRUE` and a `SELECT` policy that is `USING (bucket_id = '...')` — open to anyone, no account check. This was a deliberate but incomplete tradeoff: Meta's servers need to fetch the media URL without sending our auth headers, and the easiest way to make that happen was to make the whole bucket public. The unintended side effect: **any object in either bucket is readable by anyone who has (or can guess) its URL**, regardless of which account it belongs to. The upload path is `<bucket>/account-<uuid>/<timestamp>-<basename>.<ext>` — sequential/guessable enough that this is a real cross-tenant data exposure, not just a theoretical one. This is tracked, unresolved, in `docs/checkpoints/CHECKPOINT-S2-S3-AUDITED.md` (S2 section only — S3, the `_bcast_bump` privilege issue in the same file, is a separate, unrelated finding and is explicitly OUT of scope for this plan).

The fix makes both buckets private and replaces the public-read policy with an account-scoped one (mirroring the account-scoped write policies that already exist), then re-plumbs every place that currently embeds a permanent public URL to use a short-lived signed URL instead — minted fresh, server-side, at the moment it's actually needed (dispatch to Meta, or render in the browser for a member of the owning account).

## Current state

Buckets and their existing policies:

- `supabase/migrations/023_chat_media.sql:38-42` — bucket `chat-media`, `public = TRUE`.
- `supabase/migrations/023_chat_media.sql:83-86` — `"Chat media is publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'chat-media')`. No account check.
- `supabase/migrations/023_chat_media.sql:91-102` — the **write** policies (INSERT/UPDATE/DELETE) for `chat-media`, correctly account-scoped:
  ```sql
  bucket_id = 'chat-media'
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid()
      AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
  )
  ```
  The new SELECT policy for `chat-media` must use this exact predicate shape (pure account-scoped — this bucket never had a legacy user-scoped path).
- `supabase/migrations/016_flow_media.sql:87-90` — `"Flow media is publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'flow-media')`. No account check. Bucket `public = TRUE` set at `016:57-63`.
- `supabase/migrations/020_account_sharing_followups.sql:63-117` — migrated the `flow-media` **write** policies (INSERT/UPDATE/DELETE only — SELECT was left untouched) to accept *either* the new account-scoped path *or* the legacy user-scoped path, because objects uploaded before 020 used `auth.uid()::text = (storage.foldername(name))[1]`:
  ```sql
  bucket_id = 'flow-media'
  AND (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
    OR auth.uid()::text = (storage.foldername(name))[1]
  )
  ```
  The new SELECT policy for `flow-media` must use this same dual predicate (account-scoped OR legacy user-scoped) so pre-020 objects don't become unreadable by their own uploader.

Upload/read helper — the single choke point for both buckets:

- `src/lib/storage/upload-media.ts:79-117` (`uploadAccountMedia`) uploads the file, then at `:113-115` calls `supabase.storage.from(bucket).getPublicUrl(path)` and returns `{ publicUrl, path }`. `publicUrl` is stored verbatim into `messages.media_url` / a flow node's `media_url` config / a template's header handle by its three callers:
  - `src/components/inbox/message-composer.tsx:248,286`
  - `src/components/flows/forms/node-config-form.tsx:908`
  - `src/components/settings/template-manager.tsx:474`

Server-side dispatch to Meta — the three places that take a stored `media_url` and pass it straight through as a fetchable `link` (this is exactly the capability that requires the URL to still be reachable without our session, so it cannot simply become `SELECT`-restricted with no alternative):

- `src/app/api/whatsapp/send/route.ts:334` — `link: media_url` (also read at `:92`, validated at `:137-139`, used again at `:469` for a second code path in the same file — read both before editing).
- `src/lib/flows/engine.ts:614` — `link: cfg.media_url`.
- `src/app/api/whatsapp/delivery/cron/route.ts:181` — inside `processDueEntry()`, the outbound-retry-ledger (E4b) drain job: loads `messages.media_url` at `:100` and forwards it as `provider.sendMedia({ link: msg.media_url ?? '', ... })` when re-attempting a failed `image`/`video`/`document`/`audio` send. **Added in the v2 revision of this plan** (2026-09-08) — missed in v1, caught by the Plan 001 executor itself (STOP condition, correctly triggered rather than improvised around) after Steps 1/2/5 already landed. Without this fix, migration 076 (Step 1) breaks every media retry the moment it reaches an environment with entries in `outbound_retry_ledger`.

(`src/app/api/whatsapp/broadcast/route.ts`, `src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts` do **not** reference `media_url` — verified by grep. `src/lib/whatsapp/delivery/sender.ts`'s `deliverMedia()` also builds a `link`-bearing payload but has **zero callers** — verified by grep (`grep -rn "deliverMedia(" src/`) — it is dead/future code, not a live fourth site; leave it alone, do not wire it up as part of this plan. Do not add handling to any other file; if you find a reference during implementation that this plan (v2) still missed, treat it as a STOP condition, not something to silently patch around.)

Client-side rendering of stored media (reads the DB value directly as an `<img>`/`<video>`/`<a>` `src`/`href` — these are the surfaces that need a signed, re-mintable URL instead of the permanent one that's in the database):

- `src/components/inbox/message-bubble.tsx`
- `src/components/inbox/message-thread.tsx`
- `src/components/inbox/contact-sidebar.tsx`
- `src/components/flows/shared.tsx`
- `src/components/broadcasts/step3-personalize.tsx`
- `src/components/contacts/platform-contact-detail-view.tsx`

Run `grep -n "media_url" <file>` on each before touching it — this plan does not enumerate every line, only the files. Some of these also render **inbound** media (hosted by Meta itself, a `https://lookaside.fbsbx.com/...`-style URL, never our bucket) — those must pass through unchanged. This is why the resolver in Step 3 must no-op (return the input unchanged) for any URL that isn't recognizably one of our two buckets, rather than assuming every `media_url` is ours.

## Commands you will need

| Purpose   | Command                                                          | Expected on success |
|-----------|-------------------------------------------------------------------|----------------------|
| Typecheck | `npx tsc --noEmit`                                                | exit 0, no errors    |
| Tests     | `npx vitest run`                                                  | all pass             |
| Build     | `npx next build`                                                  | exit 0               |
| Lint      | `npx eslint`                                                      | exit 0                |
| One test file | `npx vitest run <path>`                                       | all pass in that file|

## Scope

**In scope**:
- `supabase/migrations/076_private_media_buckets.sql` (new)
- `src/lib/storage/upload-media.ts`
- `src/lib/storage/resolve-media-url.ts` (new)
- `src/lib/storage/resolve-media-url.test.ts` (new)
- `src/app/api/media/resolve/route.ts` (new)
- `src/app/api/media/resolve/route.test.ts` (new)
- `src/app/api/whatsapp/send/route.ts`
- `src/lib/flows/engine.ts`
- `src/app/api/whatsapp/delivery/cron/route.ts` (added in v2)
- `src/app/api/whatsapp/delivery/cron/route.test.ts` (new — added in v2; no test file exists for this route today)
- The six rendering components listed above under "Client-side rendering", plus any new shared `<AccountMedia>` component you introduce for them
- A new PGlite test for the storage SELECT policy (see Test plan)

**Out of scope** (do NOT touch, even though related):
- S3 (`_bcast_bump` missing `REVOKE`) — separate finding, separate fix, no code overlap with this plan.
- The `avatars` bucket (migration 008) — deliberately public by design, explicitly excluded from S2's own scope in `CHECKPOINT-S2-S3-AUDITED.md` §"Observação de escopo". Do not change it.
- `src/components/settings/profile-form.tsx` — uses the `avatars` bucket, not `chat-media`/`flow-media`. Leave it alone.
- Any change to `messages.media_url` / the flow node config schema itself — this plan changes how the *value already stored there* is resolved at read/send time, not the column or its format. Do not add a migration that rewrites existing `media_url` values.
- `src/components/settings/template-manager.tsx`'s Meta submission path — template header media is uploaded to Meta's own resumable-upload API (a different mechanism from the `link` pattern), not affected by bucket privacy in the same way. If you find it also breaks after Step 1, STOP and report rather than extending this plan's fix to it.

## Git workflow

- Branch: `advisor/001-private-media-buckets-s2`
- Commit per step (this repo's commits are Conventional Commits — see `git log --oneline -5` for style, e.g. `fix(security): ...`, `feat(storage): ...`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Make both buckets private and replace the public SELECT policy

Create `supabase/migrations/076_private_media_buckets.sql`:

```sql
-- 076_private_media_buckets.sql — S2
--
-- chat-media and flow-media were `public = TRUE` with a SELECT policy
-- open to anyone (023:83-86, 016:87-90) — any object was readable by
-- URL alone, across tenants. Storage-level RLS is only enforced once
-- `public = FALSE`; the public-object endpoint bypasses policies
-- entirely while a bucket is public, regardless of what SELECT policy
-- exists. See docs/checkpoints/CHECKPOINT-S2-S3-AUDITED.md (S2).
--
-- Idempotent — safe to re-run.

UPDATE storage.buckets SET public = FALSE WHERE id IN ('chat-media', 'flow-media');

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
CREATE POLICY "Chat media is account-scoped readable"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
CREATE POLICY "Flow media is account-scoped readable"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );
```

**Verify**: `npx vitest run src/test` (or whatever the repo's PGlite migration-loading tests target — grep `loadMigration` usage in `src/test/*.pglite.test.ts` for the pattern, e.g. `src/test/c21-assigned-agent-fk.pglite.test.ts:54-59`) still passes; no existing test asserts the old public policy exists (`grep -rn "publicly readable" src/test` should return nothing after this step, or only in a test you are about to update in Step 5).

### Step 2: Add the signed-URL resolver

Create `src/lib/storage/resolve-media-url.ts`. It must:
- Export `parseAccountBucketPath(url: string): { bucket: 'chat-media' | 'flow-media'; path: string } | null` — recognizes a Supabase public-storage URL of the shape `.../storage/v1/object/public/<bucket>/<path>` for exactly these two bucket ids, extracts `path`; returns `null` for anything else (Meta-hosted inbound media, the `avatars` bucket, garbage input).
- Export `async function resolveSignedMediaUrl(supabase: SupabaseClient, url: string, expirySeconds: number): Promise<string>` — if `parseAccountBucketPath(url)` is `null`, return `url` unchanged (pass-through). Otherwise call `supabase.storage.from(bucket).createSignedUrl(path, expirySeconds)`; on error, throw (callers decide how to surface it — do not silently return the broken public URL).
- Export a constant `MEDIA_SIGNED_URL_TTL_SECONDS` — use `86400` (24h) for the server-to-Meta dispatch use case (Step 3) and a separate, shorter constant `MEDIA_SIGNED_URL_TTL_SECONDS_UI = 3600` (1h) for the render use case (Step 4) — UI signs on every page load, so it doesn't need a long TTL; the send path needs to outlive provider-side retries.

**Verify**: write `src/lib/storage/resolve-media-url.test.ts` covering: (a) a `chat-media` public URL parses to the right bucket+path, (b) a `flow-media` public URL parses correctly, (c) a Meta-hosted URL (e.g. `https://lookaside.fbsbx.com/...`) returns `null` from the parser and is passed through unchanged by `resolveSignedMediaUrl` (mock the Supabase client and assert `createSignedUrl` was NOT called in this case), (d) a recognized URL calls `createSignedUrl` with the parsed path and the given TTL. `npx vitest run src/lib/storage/resolve-media-url.test.ts` → all pass.

### Step 3: Sign the URL right before dispatching to Meta

In `src/app/api/whatsapp/send/route.ts`, before the `link: media_url` construction at line 334 (and the second occurrence around line 469 — check both are covered), call `resolveSignedMediaUrl(supabaseServerClient, media_url, MEDIA_SIGNED_URL_TTL_SECONDS)` and use the result in place of the raw value. Use whatever server-side Supabase client this route already has in scope (check the top of the file for the existing `createClient`/service-role client — do not introduce a second client instance).

Do the same in `src/lib/flows/engine.ts` at line 614 (`link: cfg.media_url`) — resolve it with the same helper before building the payload.

**Verify**: `npx vitest run src/app/api/whatsapp/send/route.test.ts src/lib/flows/engine.test.ts` (adjust filenames to whatever exists — `ls src/app/api/whatsapp/send/*.test.ts src/lib/flows/*.test.ts`) — update/extend these existing suites to assert the outgoing Meta payload's `link` is a signed URL (contains a `token=` query param, or whatever `createSignedUrl`'s output shape is) rather than the raw public URL, for a case where `media_url` points at one of our buckets, and is unchanged for a case where it doesn't (inbound/forwarded media).

### Step 3b: Same fix for the outbound retry-ledger cron (added in v2)

`src/app/api/whatsapp/delivery/cron/route.ts` — the E4b/ARO-001 drain job for `outbound_retry_ledger`. Inside `processDueEntry()`, `msg.media_url` is loaded at `:100` (as part of the `messages` select) and forwarded at `:181` as `provider.sendMedia({ link: msg.media_url ?? '', ... })` for `contentType` in `image`/`video`/`document`/`audio`. This is the same "stored public URL forwarded as a fetchable link" pattern as Step 3, and it breaks the moment migration 076 lands in any environment with rows in `outbound_retry_ledger` — a media send that failed once and is being automatically retried would fail again, permanently, with no path to succeed (the URL 403s every time).

This route already imports and uses `supabaseAdmin` from `@/lib/flows/admin-client` (a service-role client, used throughout the file for every DB operation — see `:1-11` for the import list). Use that same `supabaseAdmin` instance to call `resolveSignedMediaUrl(supabaseAdmin, msg.media_url ?? '', MEDIA_SIGNED_URL_TTL_SECONDS)` before building the `sendMedia` call at `:181`. A service-role client bypasses Storage RLS entirely (by design — this is a trusted background job re-driving a send on the account's behalf, not a user-initiated request), so `createSignedUrl` will succeed regardless of which account's folder the path is under; this is consistent with how the rest of this route already uses `supabaseAdmin` for every other read/write. Do not attempt to resolve the caller's account membership here — there is no end-user session in a cron job.

There is no existing test file for this route (`ls src/app/api/whatsapp/delivery/cron/*.test.ts` returns nothing — confirm this yourself; if one now exists, extend it instead of creating a new one). Create `src/app/api/whatsapp/delivery/cron/route.test.ts` covering at minimum: a due `image`/`video`/`document`/`audio` ledger entry whose `media_url` points at one of our buckets gets a signed URL (not the raw stored value) passed to `provider.sendMedia`'s `link`. Model the route-under-test setup (mocking `supabaseAdmin`, `getProvider`, etc.) after whatever pattern this repo's other cron/route tests use — check `src/app/api/flows/cron/*.test.ts` or similar for the closest existing example of testing a cron-secret-gated `GET` handler with a mocked service-role client, since `AUTOMATION_CRON_SECRET` + `x-cron-secret` auth (per the file's own doc comment at `:15-16`) needs to be satisfied for the handler to run at all.

**Verify**: `npx vitest run src/app/api/whatsapp/delivery/cron/route.test.ts` → all pass, including the new assertion that `link` in the `sendMedia` call is a signed URL, not the raw stored one.

### Step 4: Resolve signed URLs for rendering in the browser

Create `src/app/api/media/resolve/route.ts` — a `POST` Route Handler, authenticated (use this repo's standard server-side Supabase client pattern from an existing authenticated route, e.g. `src/app/api/whatsapp/config/route.ts`). Body: `{ url: string }`. Behavior:
- Resolve the caller's session the same way other authenticated routes in this repo do; 401 if absent.
- Call `resolveSignedMediaUrl(supabase, url, MEDIA_SIGNED_URL_TTL_SECONDS_UI)`.
- The Storage `createSignedUrl` call itself will fail (and this must propagate as a 403) if the RLS policy from Step 1 rejects the caller for that path — i.e., a user from a different account gets a 403, not a signed URL. Do not add a manual account check on top of this — the whole point of Step 1 is that Storage RLS is the enforcement point. Just don't swallow the Storage error.
- Return `{ url: string }` (the resolved value, or the original input if `resolveSignedMediaUrl` passed it through unchanged).

Add a small shared client component (e.g. `src/components/shared/account-media.tsx`) that takes a `src` prop, calls this route once on mount (memoize by `src` so re-renders don't re-fetch), and renders its children/an `<img>`/`<video>` with the resolved URL once available; show the raw `src` optimistically or a loading state in the meantime, per this repo's existing loading-state conventions (check one of the six rendering files for the pattern already in use, e.g. how `message-bubble.tsx` handles an image still loading today).

Then update each of the six files listed under "Client-side rendering" in Current state to route their `media_url`/equivalent through this component instead of using the raw string as `src`/`href` directly. Read each file's existing render logic first — some may already have a wrapper component worth extending rather than introducing a second one.

**Verify**: `npx tsc --noEmit` exits 0. Manually confirmed in Step 6.

### Step 5: Update the existing storage-policy test coverage

Find and update whatever test currently asserts the public SELECT policy for these buckets (search `grep -rln "publicly readable\|chat-media\|flow-media" src/test`). If none exists, this step becomes: write one, modeled on `src/test/c21-assigned-agent-fk.pglite.test.ts` (same `loadMigration` pattern, same PGlite bootstrap style) — but note this new test needs `storage.objects`/`storage.buckets`/`storage.foldername` available, which PGlite may not ship by default; check how any existing test in this repo that touches `storage.*` sets that up (search `storage.objects` across `src/test`) before assuming you need to hand-roll the schema. If no prior art exists for testing `storage.*` RLS in PGlite, STOP and report — this may need a different test strategy (e.g., asserting against the migration SQL text plus the resolver's unit tests from Step 2, rather than executing real Storage RLS in PGlite).

**Verify**: new/updated test passes.

### Step 6: Manual smoke test

Since Storage RLS behavior against the public/signed-URL endpoints cannot be fully exercised by PGlite (PGlite is Postgres, not the Supabase Storage service), do this against a real (dev/staging) Supabase project before considering this done:
1. Send a media message from the inbox composer to a real test WhatsApp number. Confirm it arrives (proves the signed URL Meta fetched was valid).
2. Log in as a member of a *different* account and try to fetch a known media object's old public URL directly (copy one from before this change, or construct `<project>/storage/v1/object/public/chat-media/account-<other-uuid>/...`) — confirm it now 403s/404s instead of returning the file.
3. Open a conversation with existing (pre-migration) media in its history as a legitimate member of that account — confirm images/videos still render (proves the render-time resolver in Step 4 works for historical data, not just new uploads).

## Test plan

- `src/lib/storage/resolve-media-url.test.ts` — new, per Step 2.
- `src/app/api/media/resolve/route.test.ts` — new: 401 unauthenticated, 200 + signed URL for own-account path, error propagated for a foreign-account path. Model the authenticated-route test shape after `src/app/api/whatsapp/config/route.test.ts`.
- Extend `send/route.test.ts` and `flows/engine.test.ts` (Step 3).
- `src/app/api/whatsapp/delivery/cron/route.test.ts` — new, per Step 3b.
- Storage RLS test (Step 5) — exact shape depends on what you find; do not skip investigating prior art.
- `npx vitest run` → all pass, including all new/updated tests above.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npx vitest run` exits 0
- [ ] `npx next build` exits 0
- [ ] `grep -rn "getPublicUrl" src/` shows no NEW call sites beyond what already exists in `upload-media.ts` (that function's return value is unaffected by this plan — only what happens to the value *after* it's stored changes)
- [ ] `grep -rn "publicly readable" supabase/migrations/` — the two old policy names no longer exist in any migration that would still run (076 drops and replaces them; do not edit 016/023 in place)
- [ ] `grep -rn "link: msg.media_url\|link: media_url\|link: cfg.media_url" src/` — every match is preceded by a `resolveSignedMediaUrl(...)` call in the same function, in all three files (`send/route.ts`, `flows/engine.ts`, `delivery/cron/route.ts`)
- [ ] Manual smoke test (Step 6) completed against a real Supabase project, all three checks pass
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any file in "Current state" doesn't match the excerpts shown (drift since this plan was written).
- You find a fifth place (beyond `send/route.ts`, `flows/engine.ts`, and `delivery/cron/route.ts`) that forwards a stored `media_url` to a provider as a fetchable link — this plan's dispatch-time fix only covers those three; a missed one means some send/retry path silently breaks the moment Step 1 lands. (v1 of this plan missed `delivery/cron/route.ts` itself — the executor correctly stopped rather than improvising a fix for it; that's the STOP condition this exact bullet exists to generalize from.)
- `template-manager.tsx`'s Meta template submission breaks after Step 1 (see "Out of scope" — this plan does not have a designed fix for that path).
- PGlite cannot exercise `storage.*` RLS and no prior test pattern exists for it (Step 5) — pick a fallback strategy with the maintainer rather than inventing an untested one.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The 24h (send) / 1h (UI) TTLs in `resolve-media-url.ts` are pragmatic defaults, not a considered product decision — if E4a/E4b's retry ledger ever needs to retry a media send more than 24h after the original upload, the signed URL will have expired and the retry will fail with a provider-side fetch error. If that's ever observed, re-derive the URL from the stored path immediately before each retry attempt rather than raising the TTL indefinitely.
- Anyone adding a new place that stores or renders `media_url` in the future must route through `resolveSignedMediaUrl` (server) or the `<AccountMedia>` component (client) — a new direct `getPublicUrl()`/raw-`<img src>` usage silently reintroduces this exact gap. Worth a lint rule or code-review checklist item; out of scope to add one here.
- S3 (`_bcast_bump` missing `REVOKE`) remains open in the same checkpoint file this plan closes S2 from — a separate, much smaller fix; worth its own plan.
