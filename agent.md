# agent.md

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
- **Backend:** Supabase (Auth, Postgres, Storage). There is no server of our own and should not be
  one unless an Edge Function becomes necessary
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
   plus a matching Storage policy.
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

Not documented anywhere upstream. What is in `GhostParser.ts` was reverse-engineered from one real
file and verified, not guessed:

| Offset | Meaning |
| --- | --- |
| `0x00` | Magic `SGHF` |
| `0x04` | Version word — `0x00040100` reads as 0.4.1 |
| `0x08` | File length in bytes (**verified**: matches actual size) |
| `0x0C` | CRC32 of the whole file with these four bytes zeroed (**verified**) |
| `0x14` | CRC32 of the payload from `0x100` (**verified**) |
| `0x20` | Disc id — `GMSJ` for the JP release |
| `0x78` | Run label, 48 bytes, e.g. `Bianco Hills 3 - 0:37.337` (**inferred**, one sample). Split into level and time by `splitRunLabel()` |
| `0xA8` | Category, 16 bytes, e.g. `Any percent` (**inferred**, one sample) |
| `0x100` | Payload begins |

The three CRC/size facts are solid — a flipped payload byte fails validation. The two string offsets
come from a single file and could be wrong for other builds.

**When the format changes:** add an entry to `PROFILES` in `GhostParser.ts`, keyed by
`major.minor`. Nothing outside that file knows about byte offsets. Unrecognised versions still
upload — they fall back to a permissive profile, warn the user, and are stored and served byte-for-
byte unmodified. Never rewrite a ghost's bytes; download must return exactly what was uploaded.

If you can get the real format spec from panther03, reconciling it against this table is worthwhile.

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
                      0004 level + time
supabase/tests/       local_stubs.sql · security_checks.sql
```

Key components:

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
- **`array_to_string` is STABLE, not IMMUTABLE.** It cannot appear in a generated column. That is why
  `ghost_search_document()` exists. Same trap awaits any other generated column.
- **`handle_new_user()` must never raise.** An exception there means the account is created but the
  profile is not, and the user sees "Database error saving new user" with no recovery. Anything
  unusable — malformed, reserved, taken — must fall back to a derived name.
- **Batch uploads are sequential on purpose.** Parallel writes make per-row status unreliable and
  burst Storage. Hitting the 200 limit mid-run stops cleanly with prior uploads saved.
- **Orphaned Storage objects** are possible if a delete removes the row but the Storage call fails.
  Unreachable through the archive, but they consume quota. No sweeper exists yet.

---

## Verifying changes

There is no test runner. What exists:

```bash
npm run build          # tsc -b then vite build; typecheck is real and strict
```

For schema work, run the SQL suite (README section 4). For frontend behaviour, rendering the app in
jsdom has been a useful way to catch crash-on-load and to test drag-and-drop event sequences without
a browser — that is how the DropZone depth counter was verified.

Always check the built asset paths after touching Vite config.

---

## Known gaps, roughly in priority order

1. **Ghost contents are validated only in the browser.** Someone can call Storage directly and write
   arbitrary bytes under their own folder within the size, extension and MIME limits. Closing this
   needs an Edge Function on the upload path. This is the largest remaining hole and has been offered
   to the owner.
2. **No moderation tooling.** Removing a bad upload means going into Supabase by hand. No reporting
   flow, no admin role, no audit trail beyond `ghost_downloads`.
3. **Download counting resists casual inflation, not determined inflation** across many accounts. The
   `ghost_downloads` log exists so stricter rules can be added without a schema change.
4. **Supabase's built-in mail is rate-limited** and meant for development. Real SMTP is needed before
   the archive opens to the community.
5. **No Storage sweeper** for orphans (see above).
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
