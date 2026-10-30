# CLAUDE.md

Orientation for an AI agent picking this project up. The README is written for a human setting the
site up; this file is about how the thing actually works, which parts are load-bearing, and the
mistakes that are easy to make here.

Read this, then `src/lib/` and `supabase/migrations/0001_init.sql`. Those two directories hold
everything that matters.

---

## What this is

**Delfino Ghosts** — a community archive for Super Mario Sunshine ghost files recorded with
[Moonshine](https://github.com/panther03/moonshine/releases/), the SMS practice mod. Runners upload
`.smsghost` files, anyone downloads them.

The core loop is deliberately small: **browse → find ghost → see author → download**. The owner has
said explicitly this should not become a social network. Resist adding comments, votes, feeds,
follows or a CMS. Community and profile pages exist to support the archive, not to compete with it.

- **Frontend:** React 18 + TypeScript + Vite, static, hosted on GitHub Pages
- **Backend:** Supabase (Auth, Postgres, two Edge Functions) plus an S3-compatible bucket
  (Cloudflare R2) that holds the ghost files. `ghost-storage` is the website's only write path to
  that bucket; `moonshine-api` serves the Moonshine game client (see MOONSHINE-INTEGRATION.md).
  Supabase Storage is left only for the private Moonshine staging bucket `ghost-uploads`. No other
  server of our own
- **Live:** `https://<user>.github.io/delfino-ghosts/`

## Design language

Minimal, dark-first, monospace, archival — modelled on a directory listing rather than a dashboard.
The reference is minerva-archive.org's Browse page. Rows, not cards. Right-aligned numerics.

Two conventions worth preserving:

- **Gold means MDP and nothing else.** If you introduce gold anywhere else, the shimmer stops
  reading as a status.
- Water-blue (`--link`) is the only other saturated colour, reserved for actions.

Everything is hand-written CSS with custom properties in `src/styles.css`. No Tailwind (the owner's
other project, moonshine-customs, uses it — a switch has been offered and not taken up).

---

## Invariants — do not break these

These are enforced in Postgres, and the frontend must never become the only thing enforcing them.
If you find yourself writing a rule in React, ask whether it belongs in a trigger or policy instead.

1. **Ownership comes from `auth.uid()`, never from the payload.** `ghosts_before_insert()` overwrites
   `user_id`; `ghosts_before_update()` pins it to `OLD`. A forged `user_id` is harmless.
2. **`ghosts.download_count` has no client-writable path.** `ghosts_before_update()` restores the
   previous value unless the transaction-local flag `delfino.counter_ctx` is `'on'`, which only
   `SECURITY DEFINER` routines set. Same mechanism protects `profiles.total_ghosts` and
   `profiles.total_downloads`. **If you add a trigger or function that legitimately needs to move
   these, it must set that flag and unset it after.**
3. **Counting rules:** a download counts only when the visitor is signed in, is *not* the ghost's
   author, and has not counted that same ghost within the last hour. Delivery of the file is
   independent of all three — a counting failure must never block a download.
4. **The 200-ghost limit is a trigger**, taken under `pg_advisory_xact_lock` so concurrent inserts
   cannot both pass at 199.
5. **`file_path` must start with the owner's uuid** and contain no `..`. There is a CHECK constraint
   plus the matching key check in the `ghost-storage` Edge Function, which builds every upload key
   from the caller's verified JWT (the bucket itself has no idea who anyone is).
   **`original_filename`** (the name a download is saved under) must have the shape `safeFilename()`
   produces, by CHECK since 0016: rows can be written straight through PostgREST, so otherwise a
   ghost could be served as `something.exe`. `downloadGhost()` re-cleans the name as well.
6. **Level and time** live on `ghosts.level` (free text) and `ghosts.time_ms` (integer
   milliseconds). Both nullable — pre-existing ghosts have neither, and Browse renders a blank cell
   rather than hiding them. Never store a formatted time string; format at the edge with
   `formatTime()`.
7. **MDP is always derived**, never stored as a flag. It is `SUM(download_count)` per author,
   maintained incrementally on `profiles.total_downloads` so lookups are index scans.

`supabase/tests/security_checks.sql` asserts every one of these. Run it after touching any policy,
trigger or grant — instructions in README section 4 and at the top of the file. It runs against a
throwaway local Postgres with `local_stubs.sql` standing in for Supabase's `auth` and `storage`
schemas. Several checks deliberately raise errors; the error is the pass.

---

## The ghost file format

Moonshine's specification now exists (snapshot "Moonshine PR27, 2026-10-24":
`include/susamune/ghost_format.h`, `doc/ghost_format.md`, `scripts/validate_ghost.py`; GPL-3.0, not
vendored here). The old reverse-engineered table was partly wrong: `0x04` is a `u16` format version
followed by a `u16` header size (`0x0100`), so "0.4.1" was really **SGHF V4** and "0.6.1" **V6** —
existing `moonshine_version` values in the database carry that misreading. `0x10` is the header CRC,
`0x78` is the length-delimited ghost name and `0xA8` the source profile's name.

- `src/lib/ghost/GhostParser.ts` reads only what the upload form needs, at the spec's offsets.
- `supabase/functions/_shared/ghost_format.ts` is the real validator: a strict port of
  `validate_ghost.py`, kept identical by `supabase/tests/moonshine/validator_parity.test.ts`. If
  Moonshine changes its format, port the change there and re-run the parity test against their new
  validator — do not edit rules by hand.

**Filenames** have changed shape between versions — `2026_09_05_BH3_37337_CDDABF1F_` (0.4) vs
`2026_10_13_AS1_45645[DE2C7FB6]` (0.6). The number after the level code is the clock time with the
punctuation stripped (`100794` = 1:00.794), **not** milliseconds; the two readings only agree under a
minute. `decodeFilenameTime()` handles it. Filename hints are only a fallback for when the label
cannot be read.

Unrecognised versions still upload to the archive with a warning and are stored and served
byte-for-byte; they are simply never offered to Moonshine. Never rewrite a ghost's bytes; download
must return exactly what was uploaded.

**Validated files are immutable.** Presigned uploads sign `If-None-Match: *` and `ghost-storage`
refuses to presign a key that exists, so nothing is ever overwritten in place; its `delete` action
refuses a key that has a `ghost_moonshine_index` verdict or that a `ghosts` row still points at.
Replacing a ghost's file therefore means uploading a *new* object and pointing `ghosts.file_path` at
it (`updateGhost()` does this); the trigger then drops the stale verdict and the website asks the
function to validate the new bytes.

**Size.** One limit everywhere: 100 MiB (`MAX_GHOST_BYTES` in `src/types/index.ts` and
`_shared/ghost_paths.ts`, `MOONSHINE_MAX_FILE_BYTES`, `ghosts_file_size_range`, 0015). The
validator still caps canonical SGHF files at 1,298,016 bytes (PR27), so anything bigger stays
website-only as `invalid`. The new **MSTR** trace format (`.msgt`, Moonshine decoder pack r8
documents v1/v2; captures in the wild are already v3) is **not supported** yet: the site accepts
only `.smsghost`.

---

## Layout

```
src/lib/          all database access lives here; components never build queries
  supabase.ts     client construction; isSupabaseConfigured gates the whole app
  auth.tsx        session context, signup/login/reset, recoveryMode flag
  ghosts.ts       list/get/create/update/delete
  downloads.ts    delivery + the counting RPC call
  profiles.ts     profile reads and updates
  community.ts    stats, leaderboard, current MDP
  errors.ts       Postgres errors → plain sentences (raw DB text never reaches the UI)
  ghost/          GhostParser, GhostValidator, GhostStorage, GhostMetadata
src/components/   presentational + form logic
src/pages/        one file per route
src/hooks/        useTheme, useMdp, useDebounced, useDocumentTitle
supabase/migrations/  0001 schema · 0002 storage · 0003 self-download rule
                      0004 level + time · 0005 avatar constraint fix
                      0006 level filter · 0007 per-user levels_in_use
                      0008 account deletion · 0009 purge auth logs on deletion
                      0010 ghost size limit 10 MiB · 0011 TAS filter
                      0012 Moonshine API (validation index, device links, uploads)
                      0013 retention limits for device and upload records
                      0014 Moonshine catalogue sort=route, filter-bound cursors
                      0015 one 100 MiB size limit (archive + Moonshine)
                      0016 original_filename must have safeFilename()'s shape
supabase/functions/   moonshine-api/ · ghost-storage/ (presign + delete for the bucket)
                      _shared/ghost_format.ts (validator) · _shared/s3.ts (S3 client, aws4fetch)
                      _shared/ghost_paths.ts (key rules, safeFilename, MAX_GHOST_BYTES)
supabase/scripts/     moonshine_backfill.mjs · migrate_to_r2.mjs (one-off Supabase -> R2 copy)
supabase/tests/       local_stubs.sql · security_checks.sql · moonshine/ · storage/ (node, PGlite)
```

Key components:

- **`list_ghosts` is the single listing query** used by Browse, Home and profiles. It takes search,
  sort, level, TAS and user filters and returns the page plus `total_count` in one round trip. Its
  argument list has changed three times; call it with **named arguments** so a future filter does not
  break callers.
- **`utils/time.ts`** — the only place times are parsed or formatted. `utils/levels.ts` holds the
  episode suggestions and the `BH3` → `Bianco Hills 3` code expansion used for filename hints.
- **`AuthorName`** — the *only* place a username is rendered. It decides MDP styling and tooltip.
  Never render a username directly; route it through here or the designation silently stops
  appearing somewhere.
- **`GhostList` / `GhostRow`** — the directory listing, shared by Browse, Home and profiles.
- **`GhostForm`** — single-ghost metadata form, now used only by EditGhost.
- **`DropZone` / `UploadQueue`** — the batch upload path.

---

## Things that will bite you

- **Vite base path.** Production builds emit absolute `/delfino-ghosts/assets/...`. Opening
  `dist/index.html` from disk gives a blank page. Use `npm run preview`. The Actions workflow derives
  `BASE_PATH` from the repo name; a local `npm run build` hardcodes `/delfino-ghosts/`.
- **SPA routing on Pages.** `public/404.html` stores the requested URL in sessionStorage and bounces
  to the base; a script in `index.html` restores it before React Router reads the address. Query and
  hash are preserved so Supabase auth links survive. Don't remove either half.
- **Auth redirects target the site root**, not a deep link, so the 404 fallback is never in the auth
  path. `recoveryMode` in `auth.tsx` catches `PASSWORD_RECOVERY` and routes to `/reset-password`.
- **Theme background.** `index.html` paints a background before the stylesheet loads; `useTheme`
  clears that inline style on mount so `html { background: var(--bg) }` governs. This already caused
  a bug once — an inline dark background survived the toggle and light mode only half-applied. If
  you touch either side, verify a toggle actually repaints.
- **PostgreSQL caps regex repetition bounds at 255.** `{1,400}` in a CHECK does not fail to match —
  it raises at evaluation time, so the constraint silently rejects everything. This shipped once and
  made avatars unsaveable for everyone. Put length limits in `char_length()`, keep patterns to
  unbounded quantifiers.
- **Avatars are hotlinked**, so the field needs a direct image URL. `utils/avatar.ts` rewrites Imgur
  page links and warns about hosts that serve viewer pages; Settings previews the image.
- **`array_to_string` is STABLE, not IMMUTABLE.** It cannot appear in a generated column. That is why
  `ghost_search_document()` exists. Same trap awaits any other generated column.
- **`handle_new_user()` must never raise.** An exception there means the account is created but the
  profile is not, and the user sees "Database error saving new user" with no recovery. Anything
  unusable — malformed, reserved, taken — must fall back to a derived name.
- **Batch uploads are sequential on purpose.** Parallel writes make per-row status unreliable and
  burst Storage. Hitting the 200 limit mid-run stops cleanly with prior uploads saved.
- **Profiles outlive their login.** Since 0008, `profiles` no longer cascades from `auth.users`.
  Deleting a user (via `delete_own_account()` or the dashboard) fires `anonymize_deleted_user()`,
  which renames the profile `anonymous-N` / "Anonymous N", clears avatar and bio, sets
  `deleted_at`, and drops that user's own `ghost_downloads` rows and `auth.audit_log_entries` (0009). Their ghosts stay. Owner-write
  policies also require `is_active_account()` so the leftover access token can do nothing.
  `anonymous` / `anonymous-<n>` usernames are reserved for these rows.
- **Orphaned bucket objects** are possible if a delete removes the row but the `ghost-storage`
  call fails. Unreachable through the archive, but they consume quota. No sweeper exists yet.
- **Account deletion does not touch ghost files.** Since 0008 ghosts outlive their author, so no
  SQL needs to reach the bucket. If that ever changes, the deletion must go through an Edge
  Function: Postgres cannot call R2.
- **The bucket needs a CORS rule** for the Pages origin and localhost (README 2.5). Without it,
  presigned PUTs and downloads fail in the browser with an opaque network error while the Edge
  Function itself looks healthy.
- **Presigned PUTs are strict.** The URL signs `content-length`, `content-type:
  application/octet-stream` and `if-none-match: *`; the browser must send exactly those (the
  function returns the headers to use) and the file must be the declared size. Presigning with
  aws4fetch needs `allHeaders: true` and an explicit `X-Amz-Expires`, or it silently leaves the size
  unsigned and the URL valid for 24 hours.
- **`S3_*` secrets live only in Edge Function secrets.** `VITE_GHOSTS_PUBLIC_BASE_URL` is the only
  bucket value the frontend gets, and it is public.

---

## Verifying changes

```bash
npm run build                # tsc -b then vite build; typecheck is real and strict
npm run test:moonshine       # Moonshine API + validator tests (PGlite, no Postgres install needed)
npm run test:storage         # ghost-storage function: key rules, presigning, delete guards
npm run typecheck:moonshine  # Edge Function and test code
```

For schema work, run the SQL suite (README section 4). For frontend behaviour, rendering the app in
jsdom has been a useful way to catch crash-on-load and to test drag-and-drop event sequences without
a browser — that is how the DropZone depth counter was verified.

Always check the built asset paths after touching Vite config.

---

## Known gaps, roughly in priority order

1. **The archive still accepts unvalidated bytes.** Since 0012 the `moonshine-api` function validates
   stored files server-side and only offers passing ones to Moonshine, but a website upload that
   fails validation stays on the website. Routing browser uploads through the function would close
   this.
2. **No moderation tooling.** Removing a bad upload means going into Supabase by hand. No reporting
   flow, no admin role, no audit trail beyond `ghost_downloads`.
3. **Download counting resists casual inflation, not determined inflation** across many accounts. The
   `ghost_downloads` log exists so stricter rules can be added without a schema change.
4. **Supabase's built-in mail is rate-limited** and meant for development. Real SMTP is needed before
   the archive opens to the community.
5. **No bucket sweeper** for orphans (see above).
6. **Bundle is ~460 KB** unsplit. Fine for now; route-level code splitting is the obvious lever.

---

## Working with the owner

- Speedrunner and community tool maintainer; strong spreadsheets, beginner HTML/Python, relies on AI
  for implementation. Explain just enough to stay productive — accuracy over volume.
- Everything must stay compatible with static hosting on GitHub Pages.
- When something is uncertain — a reverse-engineered offset, an unverified fix — say so plainly
  rather than presenting it as settled. Two real bugs in this project were found only by actually
  running the code (a non-immutable generated column, a signup dead-end on reserved usernames)
  rather than reasoning about it. Prefer running things.
- Schema changes ship as a **new numbered migration**. Migrations are cumulative and run in order;
  do not edit one that has already been applied anywhere. (`0001_init.sql` carries the 0003 change
  inline for historical reasons — that was a mistake to repeat.) Always say clearly which file the
  owner needs to run in the Supabase SQL editor, since that step is manual.
