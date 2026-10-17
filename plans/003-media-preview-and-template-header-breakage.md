# Plan 003: Fix media-preview and template-header breakage left by Plan 001 (S2)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2e66c12..HEAD -- src/components/inbox/message-composer.tsx src/components/flows/forms/node-config-form.tsx src/components/settings/template-manager.tsx src/lib/whatsapp/template-header-handle.ts src/app/api/whatsapp/templates/submit/route.ts "src/app/api/whatsapp/templates/[id]/route.ts"`
> If any of those files changed since this plan was written, re-read them and
> compare against the "Current state" excerpts below before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Depends on Plan 001** (`plans/001-private-media-buckets-s2.md`) being
> merged first, or at minimum having `src/lib/storage/resolve-media-url.ts`
> and `src/components/shared/account-media.tsx` (`useResolvedMediaUrl`)
> present on the branch you're working from — this plan reuses both rather
> than reimplementing them. If neither exists on your base branch, STOP —
> you're on the wrong base.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MEDIUM (Step 1/2 fix an actual functional break in template submission — a real WhatsApp Business feature, not just cosmetic; Steps 3–5 are low-risk UI-only swaps reusing already-tested code)
- **Depends on**: `plans/001-private-media-buckets-s2.md` (migration 076 + `resolve-media-url.ts` + `account-media.tsx` must exist)
- **Category**: bug
- **Planned at**: commit `2e66c12`, 2026-09-08

## Why this matters

Plan 001 made `chat-media` and `flow-media` Supabase Storage buckets private (migration 076) and fixed every *known* place that forwarded a stored bucket URL to something that needed to fetch it without our session. While executing Plan 001's Step 4 (client-side rendering), the executor found — and correctly left unfixed, reporting instead of silently patching — three more call sites that also break once migration 076 lands. Investigating them for this plan surfaced a **fourth, more severe** one the executor's report didn't call out, because it isn't a browser render at all:

1. **`src/lib/whatsapp/template-header-handle.ts:40`** — `ensureImageHeaderHandle()` does a plain, unauthenticated server-side `fetch(payload.header_media_url)` to download a WhatsApp template's header image before re-uploading it to Meta's Resumable Upload API. When `header_media_url` was populated via `uploadAccountMedia('chat-media', file)` (the normal upload path in `template-manager.tsx`), that URL now 403s post-migration-076 — **template submission itself fails**, not just a preview. This is a functional regression in a live product feature (creating/editing a WhatsApp message template with an image header), not a cosmetic one, and it's the highest-priority item in this plan. It was not on Plan 001's radar because Plan 001's "Current state" only enumerated `link`-forwarding call sites (`sendMedia`-shaped) and `<img>`/`<video>`-shaped client renders — a server-side raw `fetch()` of the URL is a third pattern neither plan anticipated until this investigation.
2. **`src/components/settings/template-manager.tsx:857`** — the header-image `<img src={form.header_media_url}>` preview in the template editor. This is the one Plan 001's Step 4 named as its own explicit STOP condition ("If you find it also breaks after Step 1, STOP and report rather than extending this plan's fix to it"). Cosmetic (preview only), but permanent and visible to anyone building a template with an image header.
3. **`src/components/inbox/message-composer.tsx:606-618`** — the staged-attachment preview (`<img>`/`<video>`/`<audio>`) an agent sees after picking a file to attach, before hitting Send. Cosmetic — Plan 001's Step 3 already fixed the actual send path (`send/route.ts`), so the message sends correctly even though the preview is broken.
4. **`src/components/flows/forms/node-config-form.tsx:966`** — the "open uploaded file" link in the Flows builder's media-node config. Cosmetic — Plan 001's Step 3 already fixed `flows/engine.ts`'s dispatch, so the flow runs correctly even though this preview link 403s if clicked.

All four share the same root cause (a stored `chat-media`/`flow-media` URL used somewhere that needs to fetch it without authentication) and the same fix shape: resolve through the resolver Plan 001 already built (`resolveSignedMediaUrl` server-side, `useResolvedMediaUrl`/`<AccountMedia>` client-side) instead of using the raw stored value. Items 2–4 are direct reuses of already-tested code. Item 1 needs a small signature change (threading a Supabase client into `ensureImageHeaderHandle`) but reuses the same resolver function.

## Current state

**1. Server-side template-header fetch — `src/lib/whatsapp/template-header-handle.ts`** (full file is 74 lines; relevant excerpt):

```ts
export async function ensureImageHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  if (payload.header_type !== 'image') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Image-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the image header.',
    )
  }

  // Fetch the sample image bytes (works for our uploaded chat-media URL
  // and for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url)     // ← line 40: THE BREAK
  } catch {
    throw new Error('Could not fetch the header image URL. Make sure it is publicly reachable.')
  }
  ...
```

Note the doc comment above the function (lines 7-8): `header_media_url` "whether the user uploaded a file or pasted a link" — this field is **dual-purpose**. A template author can either upload through our UI (→ a `chat-media` bucket URL) or paste an arbitrary external public HTTPS URL directly into the text field at `template-manager.tsx:848-851`. The fix must keep working for the external-URL case unchanged — this is exactly what `resolveSignedMediaUrl`'s pass-through behavior already does (returns the input unchanged for anything that doesn't parse as one of our two buckets), so no special-casing is needed, just wiring it in.

Two call sites, both with a Supabase client already in scope by the time they call this function:

- `src/app/api/whatsapp/templates/submit/route.ts:92` — `const supabase = await createClient()`; the call to `ensureImageHeaderHandle(payload, accessToken)` happens later in the same `POST` handler (search for `ensureImageHeaderHandle` in this file — it's inside a `try` block that turns a thrown error into a 400 response with the error's message, so throwing a clear message from the resolver is sufficient, no new error handling needed).
- `src/app/api/whatsapp/templates/[id]/route.ts:60` — `const supabase = await createClient()`; the call to `ensureImageHeaderHandle(payload, accessToken)` is at `:158`, same pattern (edit/resubmit path).

Existing test file: `src/lib/whatsapp/template-header-handle.test.ts` — calls `ensureImageHeaderHandle(p, 'tok')` with exactly 2 arguments in 6 test cases, all using `header_media_url: 'https://x.test/img.jpg'` (an external, non-bucket URL) and stubbing global `fetch`. Adding a required 3rd parameter means **every existing call in this file must be updated**, not just the new test case you add.

**2. `src/components/settings/template-manager.tsx:854-861`**:

```tsx
{form.header_format === 'image' && form.header_media_url && (
  <img                                    // ← line 857
    src={form.header_media_url}
    ...
```
(read the surrounding 10 lines yourself — this excerpt is intentionally partial; get the exact JSX attributes before editing, e.g. `alt`/`className`, which this plan doesn't need to change). The uploaded URL is set at `:474-475` — `const { publicUrl } = await uploadAccountMedia('chat-media', file); setForm((f) => ({ ...f, header_media_url: publicUrl }))` — inside `handleHeaderImageFile` (`:461`).

**3. `src/components/inbox/message-composer.tsx:604-622`** (`MediaDraftPreview`, a module-scope component per its own doc comment at `:585-589` — kept outside `MessageComposer` deliberately so React doesn't remount it and drop caption-input focus on every keystroke; do not change that structural choice):

```tsx
{draft.kind === "image" && (
  // eslint-disable-next-line @next/next/no-img-element
  <img
    src={draft.mediaUrl}                  // ← line 609
    alt={draft.filename}
    className="max-h-40 rounded-lg object-cover"
  />
)}
{draft.kind === "video" && (
  <video src={draft.mediaUrl} controls className="max-h-40 rounded-lg" />   {/* ← line 615 */}
)}
{draft.kind === "audio" && (
  <audio src={draft.mediaUrl} controls className="w-full" />               {/* ← line 618 */}
)}
{draft.kind === "document" && (
  ...no URL rendered for document, just a filename — leave unchanged...
)}
```
`draft.mediaUrl` is set from `uploadAccountMedia`'s `publicUrl` at `:248` (image/video/document path) and `:286` (audio path) — both call `uploadAccountMedia(CHAT_MEDIA_BUCKET, file)`.

**4. `src/components/flows/forms/node-config-form.tsx:962-973`**:

```tsx
{cfg.media_url ? (
  <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
    <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
    <a
      href={cfg.media_url}                     {/* ← line 966 */}
      target="_blank"
      rel="noopener noreferrer"
      className="min-w-0 flex-1 truncate text-foreground hover:text-cyan-300"
      title={displayName || cfg.media_url}
    >
      {displayName || cfg.media_url}
    </a>
    ...
```
`cfg.media_url` is set from `uploadAccountMedia(FLOW_MEDIA_BUCKET, file)`'s `publicUrl` at `:908-912`, inside `handleFile` (`:895`).

**Tools already built by Plan 001 that this plan reuses (do not modify their public shape unless you have a concrete reason, and if you do, note it):**

- `src/lib/storage/resolve-media-url.ts` — exports `resolveSignedMediaUrl(supabase: SupabaseClient, url: string, expirySeconds: number): Promise<string>` (pass-through for non-bucket URLs, throws on a Storage error for a recognized one) and two TTL constants, `MEDIA_SIGNED_URL_TTL_SECONDS` (24h, server/dispatch use) and `MEDIA_SIGNED_URL_TTL_SECONDS_UI` (1h, client-render use).
- `src/components/shared/account-media.tsx` — exports the client hook `useResolvedMediaUrl(url: string | null | undefined): string` (calls `POST /api/media/resolve`, memoized by `url`, returns the raw value optimistically/on failure) and a render-prop wrapper `<AccountMedia src={...}>{(resolvedSrc) => ...}</AccountMedia>`. Already used in `message-bubble.tsx`'s `MediaVideo`/`MediaAudio` — model your usage in Steps 4–5 on those two functions rather than reinventing the pattern.

## Commands you will need

| Purpose   | Command                                                          | Expected on success |
|-----------|-------------------------------------------------------------------|----------------------|
| Typecheck | `npx tsc --noEmit`                                                | exit 0, no errors    |
| Tests     | `npx vitest run`                                                  | all pass             |
| Build     | `npx next build`                                                  | exit 0               |
| One test file | `npx vitest run <path>`                                       | all pass in that file|

## Scope

**In scope**:
- `src/lib/whatsapp/template-header-handle.ts`
- `src/lib/whatsapp/template-header-handle.test.ts`
- `src/app/api/whatsapp/templates/submit/route.ts`
- `src/app/api/whatsapp/templates/[id]/route.ts`
- `src/components/settings/template-manager.tsx`
- `src/components/inbox/message-composer.tsx`
- `src/components/flows/forms/node-config-form.tsx`

**Out of scope** (do NOT touch, even though related):
- `src/lib/storage/resolve-media-url.ts`, `src/components/shared/account-media.tsx` — reuse as-is. If you find a real defect in either while using them, STOP and report rather than fixing it here (it's shared infrastructure other call sites already depend on).
- Any other template-submission logic (`template-validators.ts`, `template-components.ts`, `template-status-normalize.ts`, `meta-api.ts`'s `uploadResumableMedia`/`submitMessageTemplate`) — this plan only touches how `header_media_url` gets resolved before the existing fetch, nothing about what happens after.
- `src/components/inbox/message-bubble.tsx`, `contact-sidebar.tsx`, `platform-contact-detail-view.tsx`, `broadcasts/step3-personalize.tsx` — already fixed by Plan 001, do not re-touch.
- Video/document header types for templates — `ensureImageHeaderHandle` is image-only "for now" per its own doc comment (`:13-14`); this plan does not extend that scope.

## Git workflow

- Branch: `advisor/003-media-preview-and-template-header-breakage`
- Commit per step (Conventional Commits — see `git log --oneline -5`)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Thread a Supabase client into `ensureImageHeaderHandle` and resolve the URL before fetching

In `src/lib/whatsapp/template-header-handle.ts`:
- Add a third, required parameter `supabase: SupabaseClient` (import the type from `@supabase/supabase-js`, matching how `resolve-media-url.ts` itself imports it).
- Import `resolveSignedMediaUrl` and `MEDIA_SIGNED_URL_TTL_SECONDS` from `@/lib/storage/resolve-media-url`.
- Immediately before the existing `fetch(payload.header_media_url)` call (current line 40), resolve the URL:
  ```ts
  let mediaUrl: string
  try {
    mediaUrl = await resolveSignedMediaUrl(supabase, payload.header_media_url, MEDIA_SIGNED_URL_TTL_SECONDS)
  } catch (err) {
    throw new Error(
      err instanceof Error ? `Could not resolve header image URL: ${err.message}` : 'Could not resolve header image URL.',
    )
  }
  ```
  Then change the existing `fetch(payload.header_media_url)` to `fetch(mediaUrl)`. Leave everything else in the function (content-type check, size check, `uploadResumableMedia` call) untouched — `mediaUrl` is a local variable that stands in for the same purpose `payload.header_media_url` served before, nothing downstream needs to change.
- For an externally-pasted URL (not one of our buckets), `resolveSignedMediaUrl` passes it through unchanged — this preserves the "or pasted a link" case from the function's own doc comment exactly as today.

**Verify**: `npx tsc --noEmit` will fail at this point (the two call sites don't pass the new argument yet, and the test file doesn't either) — that's expected, continue to Step 2 before checking typecheck.

### Step 2: Update both call sites to pass their in-scope Supabase client

- `src/app/api/whatsapp/templates/submit/route.ts` — change the `ensureImageHeaderHandle(payload, accessToken)` call to `ensureImageHeaderHandle(payload, accessToken, supabase)`, using the `supabase` already created at `:92` in the same `POST` handler (confirm it's in scope at the call site — same function, no new instantiation needed).
- `src/app/api/whatsapp/templates/[id]/route.ts` — same change at the call site around `:158`, using the `supabase` created at `:60`.

**Verify**: `npx tsc --noEmit` — should now pass for these two files specifically (`npx tsc --noEmit 2>&1 | grep -E "templates/submit|templates/\[id\]"` returns nothing); the test file will still fail until Step 3.

### Step 3: Update `template-header-handle.test.ts`

All 6 existing `it(...)` blocks call `ensureImageHeaderHandle(p, 'tok')` — add a third argument, a minimal mock Supabase client sufficient for `resolveSignedMediaUrl`'s pass-through path (all 6 existing tests use the external URL `https://x.test/img.jpg`, which `parseAccountBucketPath` returns `null` for, so `resolveSignedMediaUrl` never actually calls `.storage.from(...).createSignedUrl(...)` on it — a client stub that would throw if that path were hit, e.g. `{ storage: { from: () => { throw new Error('should not be called for a non-bucket URL') } } } as unknown as SupabaseClient`, is sufficient and doubles as an assertion that the pass-through path is really being taken).

Add one new test case proving the resolution actually happens for a bucket URL:
```ts
it('resolves a chat-media URL to a signed URL before fetching', async () => {
  vi.stubEnv('META_APP_ID', 'app-1');
  const fetchMock = vi.fn(async () => imgResponse('image/jpeg', 2048));
  vi.stubGlobal('fetch', fetchMock);
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://signed.example/x' }, error: null }));
  const supabase = { storage: { from: () => ({ createSignedUrl }) } } as unknown as SupabaseClient;
  const p = payload({
    header_media_url:
      'https://project.supabase.co/storage/v1/object/public/chat-media/account-abc/1-x.jpg',
  });
  await ensureImageHeaderHandle(p, 'tok', supabase);
  expect(createSignedUrl).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledWith('https://signed.example/x');
  expect(p.header_handle).toBe('HANDLE123');
});
```
(Adjust the mock shape if `resolve-media-url.test.ts`'s own mocking pattern for `createSignedUrl` differs — check it and match it rather than inventing a second convention for the same call.)

**Verify**: `npx vitest run src/lib/whatsapp/template-header-handle.test.ts` → all 7 tests pass. `npx tsc --noEmit` → exit 0.

### Step 4: Fix the `template-manager.tsx` header-image preview

In `src/components/settings/template-manager.tsx`, import `useResolvedMediaUrl` from `@/components/shared/account-media`. At the `<img src={form.header_media_url}>` around line 857, resolve it: either call the hook at the top of the enclosing component/render function (`const resolvedHeaderMediaUrl = useResolvedMediaUrl(form.header_media_url)`) and use that in the `src`, or — if the surrounding JSX is itself inside a small already-extracted sub-component — call it there instead. Read the ~30 lines around line 857 first to see which shape fits; do not introduce a new sub-component just to host the hook call unless the existing structure makes that clearly necessary.

**Verify**: `npx tsc --noEmit` exits 0. This component doesn't appear to have an existing test file that renders the header-image preview (check `ls src/components/settings/*.test.tsx` to confirm) — if none exists, a manual/visual check is acceptable for this step (no PGlite/DB involved, pure UI), do not create a new test file speculatively.

### Step 5: Fix the `message-composer.tsx` staged-attachment preview

Add `useResolvedMediaUrl` calls in `MediaDraftPreview` (module-scope component, `:585-589` in Current state) for the `image`/`video`/`audio` branches — model exactly on how `message-bubble.tsx`'s `MediaVideo`/`MediaAudio` functions call the hook once and use the returned value as `src` (Plan 001's Step 4 already established this pattern; do not diverge from it). The `document` branch renders no URL and needs no change.

**Verify**: `npx tsc --noEmit` exits 0.

### Step 6: Fix the `node-config-form.tsx` "open uploaded file" link

Add a `useResolvedMediaUrl(cfg.media_url)` call and use the resolved value as the `<a href>` at line 966. `displayName` (derived from `cfg.media_url` at `:894` for the filename shown as link text) should keep reading from `cfg.media_url` directly, not the resolved value — it's deriving a filename, not a fetchable target, and the resolved signed URL's querystring would produce a wrong filename if fed through the same `.split("/").pop()` logic.

**Verify**: `npx tsc --noEmit` exits 0.

## Test plan

- `src/lib/whatsapp/template-header-handle.test.ts` — 6 existing tests updated (3-arg call), 1 new test added (Step 3). This is the only test file this plan adds new assertions to; Steps 4–6 are UI wiring with no existing test scaffolding for these specific render paths (see Step 4's note) — do not invent new test infrastructure for them, that's disproportionate to a same-pattern reuse fix.
- `npx vitest run` → all pass, including the updated/new template-header-handle tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npx vitest run` exits 0
- [ ] `npx next build` exits 0
- [ ] `npx vitest run src/lib/whatsapp/template-header-handle.test.ts` → 7/7 pass (6 updated + 1 new)
- [ ] `grep -n "fetch(payload.header_media_url)" src/lib/whatsapp/template-header-handle.ts` returns no matches (replaced by `fetch(mediaUrl)` or equivalent resolved variable)
- [ ] `grep -rn "ensureImageHeaderHandle(payload, accessToken)" src/app/api/whatsapp/templates/` returns no matches (both call sites now pass a third argument)
- [ ] `grep -n "src={form.header_media_url}\|src={draft.mediaUrl}\|href={cfg.media_url}" src/components/settings/template-manager.tsx src/components/inbox/message-composer.tsx src/components/flows/forms/node-config-form.tsx` returns no matches (all three now reference a resolved value instead of the raw stored one)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any file in "Current state" doesn't match the excerpts shown (drift since this plan was written).
- `resolve-media-url.ts` or `account-media.tsx` don't exist on your base branch, or their exported signatures differ from what's described above (Plan 001 not merged/available, or changed since).
- You find a real defect in `resolveSignedMediaUrl` or `useResolvedMediaUrl` while wiring them in here — fix belongs in a Plan 001 follow-up, not smuggled into this plan.
- A step's verification fails twice after a reasonable fix attempt.
- You find a fifth place that fetches or renders `header_media_url`/`media_url`/`draft.mediaUrl`/`cfg.media_url` raw that isn't listed in this plan's four "Current state" items — report it rather than silently extending this plan's fix to it (same discipline Plan 001's executor already demonstrated once).

## Maintenance notes

- `ensureImageHeaderHandle`'s new required `supabase` parameter is a small breaking change to that function's signature — if any other caller is ever added beyond the two in `templates/submit/route.ts` and `templates/[id]/route.ts`, it must also pass a Supabase client with read access to the account's `chat-media` folder (an authenticated per-request client, same as both existing call sites use — do not default to a service-role client here, since the acting user's own RLS-scoped read is the right authorization boundary for "did this user actually upload this image to their own account's folder").
- Video/document template headers aren't handled by `ensureImageHeaderHandle` today (image-only, per its own doc comment) — if that scope ever expands, the same `resolveSignedMediaUrl` wiring this plan adds for the image case will need to be replicated for whatever handles video/document headers.
- This plan, combined with Plan 001, should make `grep -rn "getPublicUrl\|header_media_url\|media_url" src/components src/lib/whatsapp/template-header-handle.ts` a useful periodic check for a new raw (unresolved) usage sneaking back in — worth a lint rule eventually (same note Plan 001 left; still not implemented anywhere).
