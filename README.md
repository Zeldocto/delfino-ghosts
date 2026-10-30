# Delfino Ghosts

A community archive for Super Mario Sunshine ghosts recorded with
[Moonshine](https://github.com/panther03/moonshine/releases/), the SMS practice mod.

Vibecoded, but all code is reviewed.

Browse the archive, find a ghost, download it. An account is only needed to upload and to have
your downloads counted.

- **Frontend:** React + TypeScript + Vite, hosted on GitHub Pages
- **Backend:** Supabase (Auth, PostgreSQL, Edge Functions) plus a Cloudflare R2 bucket for the ghost
  files — no server of our own
- **Live at:** [zeldocto.github.io/delfino-ghosts](https://zeldocto.github.io/delfino-ghosts/)

---

## Contents

1. [Local development](#1-local-development)
2. [Supabase setup](#2-supabase-setup)
3. [Environment variables](#3-environment-variables)
4. [Database setup](#4-database-setup)
5. [GitHub Pages deployment](#5-github-pages-deployment)
6. [How the system works](#6-how-the-system-works)
7. [Security: what is enforced and where](#7-security-what-is-enforced-and-where)
8. [Project layout](#8-project-layout)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Local development

Requires Node 20 or newer.

```bash
git clone https://github.com/<your-username>/delfino-ghosts.git
cd delfino-ghosts
npm install
cp .env.example .env      # then fill in the three values, see section 3
npm run dev
```

The dev server prints a local address, usually `http://localhost:5173`. Locally the app is served
from `/`; in production Vite builds against `/delfino-ghosts/`. Both are handled automatically.

Other scripts:

```bash
npm run build       # typecheck, then production build into dist/
npm run preview     # serve the production build locally
npm run typecheck   # types only
```

Until `.env` has real values, the app renders a short "not configured" page instead of failing
silently.

---

## 2. Supabase setup

### 2.1 Create the project

1. Sign in at [supabase.com](https://supabase.com) and create a new project.
2. Pick a region near your users and set a strong database password. **That password is not needed
   by this application** — the frontend never connects to Postgres directly. Store it somewhere
   safe and do not put it in the repository.
3. Wait for provisioning to finish.

### 2.2 Collect the two public values

In **Project Settings → API**:

- **Project URL** → `VITE_SUPABASE_URL`
- **anon / public key** (newer projects call this the *publishable* key) → `VITE_SUPABASE_ANON_KEY`

On the same page you will also see a **service_role** key. That key bypasses Row Level Security
entirely. It must never appear in this repository, in a `VITE_` variable, in a GitHub Actions
build, or anywhere a browser can reach. Nothing in this project needs it.

### 2.3 Configure Auth

In **Authentication → Providers**, keep **Email** enabled. Disable any provider you do not intend
to support.

In **Authentication → URL Configuration**:

- **Site URL:** `https://<your-username>.github.io/delfino-ghosts/`
- **Redirect URLs:** add both of these, one per line:
  ```
  https://<your-username>.github.io/delfino-ghosts/
  http://localhost:5173/
  ```

Verification and password-reset links land on the site root, which GitHub Pages serves directly,
so the SPA fallback is never involved in an auth round trip.

In **Authentication → Sign In / Providers → Email**, decide whether to require email confirmation:

- **Confirm email on** (recommended for a public archive): new accounts must click a link before
  they can sign in. The app shows a "check your email" screen after signup.
- **Confirm email off:** signup signs the user straight in. Useful while developing.

Supabase handles password hashing and session tokens. This project never sees, stores or hashes a
password, and `auth.users` is not readable through the anon key.

### 2.4 Run the migrations

See [section 4](#4-database-setup).

### 2.5 Ghost file storage (Cloudflare R2)

Ghost files live in an S3-compatible bucket, not in Supabase Storage. The code only speaks the plain
S3 API, so Backblaze B2 or Tebi work too by changing the secrets below; these steps use Cloudflare R2.

1. **Create the bucket.** In the Cloudflare dashboard, **R2 → Create bucket**, e.g. `delfino-ghosts`.
2. **Make it publicly readable.** Guests must be able to download. Under the bucket's **Settings →
   Public access**, connect a **custom domain** (recommended, e.g. `ghosts.example.org`). The
   `r2.dev` development URL also works for testing, but Cloudflare rate-limits it and does not
   recommend it for production. Public means *readable*: nobody can write without a signed URL.
3. **Add the CORS rule** under **Settings → CORS policy**, so the website can upload with presigned
   URLs and download with `fetch`. Origins are scheme + host only, no path:

   ```json
   [
     {
       "AllowedOrigins": ["https://<your-username>.github.io", "http://localhost:5173", "http://localhost:4173"],
       "AllowedMethods": ["GET", "HEAD", "PUT"],
       "AllowedHeaders": ["content-type", "if-none-match"],
       "ExposeHeaders": ["etag", "content-length"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

4. **Create an API token.** **R2 → Manage API tokens → Create API token**, permission *Object Read &
   Write*, limited to this one bucket. Note the *Access Key ID*, *Secret Access Key* and the account's
   S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`).
5. **Set the Edge Function secrets** (Supabase dashboard → **Edge Functions → Secrets**, or
   `supabase secrets set NAME=value`):

   | Secret | Value |
   | --- | --- |
   | `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `S3_BUCKET` | the bucket name |
   | `S3_REGION` | `auto` for R2 |
   | `S3_ACCESS_KEY_ID` | from step 4 |
   | `S3_SECRET_ACCESS_KEY` | from step 4 |
   | `GHOSTS_PUBLIC_BASE_URL` | the public base from step 2, e.g. `https://ghosts.example.org` (no trailing slash) |

   These stay inside the functions. None of them may ever go in a `VITE_` variable.
6. **Deploy the functions:**
   ```bash
   supabase functions deploy ghost-storage                  # JWT verification on (default)
   supabase functions deploy moonshine-api --no-verify-jwt
   ```

`ghost-storage` is the website's only write path to the bucket. It enforces what the old Storage
policies did; see [section 7](#7-security-what-is-enforced-and-where).

The Supabase Storage bucket `ghosts` (from `0002_storage.sql`) is legacy: it held the files before
the move to R2 and is kept, with its policies, until the copy has been verified. Moving existing
files is a one-off:

```bash
# values from the steps above, plus the project URL and publishable key
export SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... S3_ENDPOINT=... S3_BUCKET=...
export S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
node supabase/scripts/migrate_to_r2.mjs --dry-run   # report only
node supabase/scripts/migrate_to_r2.mjs             # copy
```

It copies every object under the same key (so `ghosts.file_path` needs no change), checks size and
sha256 after each copy, skips keys already copied, and never deletes anything from Supabase.

The private bucket `ghost-uploads` (Moonshine API staging, from 0012) stays in Supabase Storage.

---

## 3. Environment variables

Create `.env` in the project root:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
VITE_GHOSTS_PUBLIC_BASE_URL=https://ghosts.example.org
```

**Which values are public, and why it matters.**

| Value | Where it belongs | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `.env`, GitHub repository variable | Public. It is just your project's address. |
| `VITE_SUPABASE_ANON_KEY` | `.env`, GitHub repository variable | Public by design. It identifies the `anon` role; what it can actually do is decided entirely by Row Level Security. |
| `VITE_GHOSTS_PUBLIC_BASE_URL` | `.env`, GitHub repository variable | Public. The read-only download address of the ghost bucket (section 2.5). |
| `S3_*`, `GHOSTS_PUBLIC_BASE_URL` | Supabase Edge Function secrets only | The R2 access key and secret can write to the bucket. Never in `.env`, a `VITE_` variable or GitHub Actions. |
| `service_role` key | Nowhere in this project | Bypasses RLS. Treat it like a database superuser password. |
| Database password | Nowhere in this project | Only for direct psql/CLI access. |

Anything prefixed `VITE_` is **inlined into the built JavaScript** and is readable by anyone who
opens the site. That is fine for the three values above and unacceptable for anything else. `.env` is
in `.gitignore`; `.env.example` is the committed template and contains no real values.

---

## 4. Database setup

Two migration files, run in order. Either paste them into the Supabase SQL editor
(**SQL Editor → New query → Run**), or apply them with the CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

| File | What it creates |
| --- | --- |
| `supabase/migrations/0001_init.sql` | Tables, constraints, indexes, triggers, RLS policies, RPC functions |
| `supabase/migrations/0002_storage.sql` | The `ghosts` Storage bucket and its object policies |
| `supabase/migrations/0003_no_self_downloads.sql` | Stops an author's own downloads counting toward their ghosts |
| `supabase/migrations/0004_level_and_time.sql` | Adds `level` and `time_ms`, folds level into search, adds a fastest-time sort |
| `supabase/migrations/0005_fix_avatar_url_check.sql` | Repairs the avatar URL constraint (see below) |
| `supabase/migrations/0006_level_filter.sql` | Adds a level filter to `list_ghosts` and the `levels_in_use()` facet |
| `supabase/migrations/0008_account_deletion.sql` | Self-serve account deletion: the login is removed, the profile becomes "Anonymous N", ghosts stay |
| `supabase/migrations/0009_purge_auth_logs_on_deletion.sql` | Account deletion also removes that user's Supabase Auth sign-in log entries (with IP addresses) |
| `supabase/migrations/0010_ghost_size_10mb.sql` | Raises the per-ghost size limit from 2 MiB to 10 MiB (table check and bucket) |
| `supabase/migrations/0011_tas_filter.sql` | Adds a TAS-only filter to `list_ghosts` for the Browse checkbox |
| `supabase/migrations/0012_moonshine_api.sql` | Moonshine ghost-sharing API: server-side validation index, device linking, upload sessions, private `ghost-uploads` bucket. See [MOONSHINE-INTEGRATION.md](MOONSHINE-INTEGRATION.md) |
| `supabase/migrations/0013_moonshine_retention.sql` | Deletes linked-device records with the account and 30 days after unlinking; deletes finished upload sessions after 30 days |
| `supabase/migrations/0014_moonshine_route_sort.sql` | Moonshine catalogue: `sort=route` (browse by starting level) and cursors bound to their filters. Deploy the function **before** running this |
| `supabase/migrations/0015_size_100mb.sql` | One 100 MiB size limit for the archive and the Moonshine API (table checks, `moonshine_config()`, staging bucket). Only raises limits; deploy both Edge Functions **before** running this |

Migrations are cumulative and run in order. Never edit one that has already been applied somewhere —
add a new numbered file instead.

There is also a test suite under `supabase/tests/`. It runs against a throwaway local PostgreSQL
database — never a real project — and asserts the things that matter: forged ownership, direct
counter writes, path traversal, cross-user edits and deletes, guest calls to the download RPC, the
200-ghost limit reached through the API rather than the UI, MDP handover, and whether the
maintained aggregates still agree with a full recount. Re-run it after touching any policy, trigger
or grant:

```bash
createdb delfino_test
psql -d delfino_test -f supabase/tests/local_stubs.sql
psql -d delfino_test -f supabase/migrations/0001_init.sql
psql -d delfino_test -f supabase/migrations/0002_storage.sql
psql -d delfino_test -f supabase/migrations/0010_ghost_size_10mb.sql
psql -d delfino_test -f supabase/tests/security_checks.sql
```

Several checks deliberately provoke errors — for those, the error *is* the passing result, and each
block says what to expect.

The Moonshine API (migration 0012 and the `moonshine-api` Edge Function) has its own suite that
needs no PostgreSQL install — it runs Postgres in-process with PGlite:

```bash
npm run test:moonshine
MOONSHINE_VALIDATOR=../scripts/validate_ghost.py npm run test:moonshine   # also compare with Moonshine's validator
npm run test:storage      # the ghost-storage function: key rules, presigned uploads, delete guards
```

The files are the authoritative SQL — they are commented throughout and are meant to be read before
they are run. What follows is an inventory so you know what should exist afterwards.

### Tables

**`profiles`** — one row per account, created automatically on signup.

| Column | Notes |
| --- | --- |
| `id` | Primary key, references `auth.users(id)`, cascades on delete |
| `username` | 3–24 chars, `[A-Za-z0-9_-]`, reserved words rejected |
| `username_lower` | Generated column; carries the case-insensitive unique index |
| `display_name`, `avatar_url`, `bio` | Optional. Avatar must be an `https://` URL |
| `total_ghosts`, `total_downloads` | Trigger-maintained aggregates |
| `created_at`, `updated_at` | |

**`ghosts`** — one row per uploaded file.

| Column | Notes |
| --- | --- |
| `id` | uuid primary key |
| `user_id` | Owner; set from `auth.uid()` by the insert trigger, immutable afterwards |
| `title`, `description` | 1–100 and ≤2000 characters |
| `file_path` | Object key in the ghost bucket. A CHECK constraint requires it to start with `user_id/` and contain no `..` |
| `original_filename`, `file_size` | Size capped at 100 MiB (0015) |
| `level` | Which level the ghost is for, e.g. `Bianco Hills 3`. Free text, trimmed on write, up to 48 chars |
| `time_ms` | The run's time in whole milliseconds. Integer so it sorts and compares; formatted for display in the frontend |
| `is_tas` | The TAS flag |
| `moonshine_version`, `tags` | Optional; tags normalised and capped at 8 |
| `download_count` | Never writable by a client — see below |
| `search_vector` | Generated `tsvector` over title, description and tags, with a GIN index |

**`ghost_downloads`** — append-only log of counted downloads, used for the per-user cooldown and to
rebuild counters if they ever drift. Clients have no insert, update or delete grant on it.

### Indexes

`profiles`: unique on `username_lower`; `(total_downloads desc, username_lower)` for the
leaderboard and MDP; `created_at`.
`ghosts`: `created_at`, `updated_at`, `download_count`, `(user_id, created_at)`, `lower(title)`,
GIN on `search_vector`.
`ghost_downloads`: `(user_id, ghost_id, created_at)` for the cooldown check, plus `ghost_id`.

### Functions

| Function | Purpose |
| --- | --- |
| `handle_new_user()` | Creates the profile row on signup. A username that is missing, malformed, reserved or already taken becomes a derived fallback rather than a failed signup |
| `ghosts_before_insert()` | Forces ownership from `auth.uid()`, zeroes the counter, enforces the 200-ghost limit under an advisory lock |
| `ghosts_before_update()` | Pins `user_id`, `created_at` and `download_count` so an update cannot change them |
| `ghosts_after_change()` | Maintains the profile aggregates |
| `record_authenticated_download(uuid)` | The only path that may move a counter. `SECURITY DEFINER`, granted to `authenticated` only |
| `list_ghosts(...)` | Paged, sorted, searched listing; returns the page and the total in one query |
| `levels_in_use()` | Levels that currently have ghosts, with counts, for the Browse filter |
| `top_players(int)`, `community_stats()`, `current_mdp()` | Read the maintained aggregates |
| `username_available(text)` | Case-insensitive availability check |
| `recompute_profile_stats()` | Maintenance only; not granted to any client role |

### RLS policies

RLS is enabled on all three tables.

| Table | anon | authenticated |
| --- | --- | --- |
| `profiles` | select | select; update own row only |
| `ghosts` | select | select; insert own; update own; delete own |
| `ghost_downloads` | none | select own rows only; no write grants at all |

There is deliberately no insert or delete policy on `profiles`: rows arrive via the signup trigger.
Since migration 0008 they are never deleted — when the login is deleted, the profile is anonymised
to "Anonymous N" and its ghosts stay in the archive.

### Storage policies (legacy bucket)

These applied while ghost files lived in Supabase Storage, and stay in place until the old bucket is
removed. The same rules are now enforced for the R2 bucket by the `ghost-storage` Edge Function
(section 7). On `storage.objects` for bucket `ghosts`:

- **select:** everyone
- **insert:** authenticated, only where the first path segment equals `auth.uid()`, the path is
  exactly two folders deep, and the extension is `.smsghost`
- **update / delete:** authenticated, only within their own folder

---

## 5. GitHub Pages deployment

1. **Create the repository.** It must be named `delfino-ghosts` for the default base path to line
   up. (The workflow actually derives the base path from the repository name, so a rename works —
   but the Supabase redirect URLs from section 2.3 would need updating to match.)

2. **Push the code.**
   ```bash
   git init
   git add .
   git commit -m "Delfino Ghosts"
   git branch -M main
   git remote add origin https://github.com/<your-username>/delfino-ghosts.git
   git push -u origin main
   ```

3. **Add the build configuration.** In **Settings → Secrets and variables → Actions → Variables**,
   add three repository variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_GHOSTS_PUBLIC_BASE_URL`

   Repository *variables* rather than *secrets* is the honest choice here: all three values ship inside
   the built JavaScript, so marking them secret would imply a protection that does not exist. The
   workflow accepts either, so if you prefer secrets it will still build.

4. **Turn on Pages.** In **Settings → Pages**, set **Source** to **GitHub Actions**.

5. **Deploy.** The workflow at `.github/workflows/deploy.yml` runs on every push to `main`, and can
   be triggered by hand from the **Actions** tab.

6. **Verify the live site.** Work through this list once:
   - the front page lists recent ghosts
   - a deep link pasted directly into the address bar loads — try
     `https://<you>.github.io/delfino-ghosts/browse`, which exercises the 404 fallback
   - a reload on a ghost detail page keeps you on that page
   - signing out and downloading a ghost as a guest still delivers the file
   - the theme choice survives a reload

---

## 6. How the system works

### Moonshine API

The Moonshine practice mod can browse, download and (when the player opts in) upload ghosts through
the `moonshine-api` Edge Function. Ghost bytes are validated on the server against Moonshine's own
format rules before they are offered to the game; players link a Wii or Dolphin by entering a short
code at `/link`, and can unlink devices in Settings. Deployment steps, the full API contract and the
open questions are in [MOONSHINE-INTEGRATION.md](MOONSHINE-INTEGRATION.md).

### Downloads and the counter

Every visitor can download every ghost. The file is fetched from the bucket's public URL
(`VITE_GHOSTS_PUBLIC_BASE_URL`) and saved byte-for-byte; nothing rewrites the container.

Counting is separate from delivery:

- **Guest:** file is delivered, counter does not move.
- **The author, downloading their own ghost:** file is delivered, counter does not move. Otherwise
  anyone could climb the MDP ranking one click at a time on their own uploads.
- **Signed in:** file is delivered, and the client calls
  `record_authenticated_download(ghost_id)`. That function checks `auth.uid()`, performs a single
  atomic `download_count = download_count + 1`, updates the author's total and writes a log row.
- **Same account, same ghost, within an hour:** file is delivered, counter holds. This is a
  deliberate floor rather than a full anti-abuse system — the log table exists so stricter rules can
  be added later without a schema change.

If the counting call fails, the download still succeeds. Bookkeeping never blocks delivery.

### Most Download Player

MDP is `SUM(download_count)` across everything a runner has uploaded — not upload count, not a
single ghost's popularity, not votes. Rather than recomputing that aggregate on every render, it is
maintained incrementally on `profiles.total_downloads` by the same triggers that move the counters,
so the leaderboard is an index scan. `recompute_profile_stats()` rebuilds it from the ghosts table
if it ever needs reconciling.

Nobody is pinned as MDP. `current_mdp()` reads live figures, and the shimmering name follows the
current leader automatically. All rendering goes through one `<AuthorName />` component, so the
designation and its tooltip appear identically in Browse, ghost pages, profiles and the leaderboard.

### Level and time

Every ghost records which level it is for and what time it gets. Both are read out of the file where
possible: Moonshine writes its run label as `Bianco Hills 3 - 0:37.337`, and the filename carries the
same information as `BH3_37337`, so the upload form usually arrives already filled in. The filename
number is the clock time with the punctuation removed, not milliseconds: `BH4_100794` is 1:00.794.
A label that starts with `TAS` (`TAS Bianco Hills 4 - 1:00.794`) ticks the TAS box and leaves the
prefix out of the level, so TAS and RTA ghosts for the same stage share one level filter entry.

Times are stored as integer milliseconds. The input accepts the ways runners actually write them —
`14.387`, `0:37.337`, `1:23.456`, `1:23` — and displays them back in the shortest sensible form.
Level is free text with suggestions for the standard episodes, so secret stages and unusual
categories are not locked out by a dropdown.

Both columns are nullable, because ghosts uploaded before this existed have neither. Browse shows a
blank cell for those rather than hiding them.

### Filtering Browse by level

The Level dropdown next to Sort narrows the listing to one level — every Pinna Park 3 ghost, say.
It only lists levels that actually have ghosts, with counts, so no option leads to an empty page.
Matching happens in Postgres against the `lower(level)` index, so case differences between uploads
collapse together, and the filter combines with both search and sorting: pick a level, sort by
fastest time, and you have a per-level leaderboard.

The filter lives in the URL (`?level=Pinna+Park+3`), so a filtered view can be linked or bookmarked.
The **TAS** checkbox beside it narrows the listing to tool-assisted runs (`?tas=1`) and combines with
the level filter, search and sort.

### Uploading in bulk

The upload page takes a whole folder at once: drop any number of `.smsghost` files onto the box (it
highlights while files are over it) or click to browse. Each file is parsed on arrival, so titles,
versions and category tags arrive pre-filled, and each row can be edited individually before
sending. Files are uploaded one at a time rather than in parallel, which keeps the per-row status
accurate and means a failure part way through leaves everything before it saved.

### Ghost files

A `.smsghost` file is a binary container, not text. Its header carries a `SGHF` magic number, a
version, the file's own length, a CRC32 of the header region, a CRC32 of the recorded payload, the
disc id (`GMSJ` for the Japanese release), and labels for the run and category.

When you choose a file, the browser reads that header to confirm the container is intact —
including verifying both checksums — and to pre-fill the upload form with the run label and version.
Parsing lives behind `GhostParser` / `GhostValidator` / `GhostStorage` / `GhostMetadata`, with the
byte offsets held in a version-keyed profile. When Moonshine changes its format, add a profile entry
in `GhostParser.ts`; files whose version is not recognised still upload, with a warning, and are
stored and served unmodified.

---

## 7. Security: what is enforced and where

Client-side checks in this app exist to give people fast, clear feedback. None of them is the
boundary. Here is what actually holds, and what does not.

**Enforced by the database**

- Ownership. `ghosts.user_id` is set from `auth.uid()` on insert and pinned to its previous value on
  update, so a forged payload cannot claim or transfer a ghost.
- The 200-ghost limit. Checked in a `SECURITY DEFINER` trigger under a per-user advisory lock, so
  concurrent requests cannot both slip past 199. Editing React, or calling PostgREST directly, hits
  the same trigger.
- Download counters. There is no client-writable path to `download_count`. An update trigger
  restores the previous value unless the transaction is inside `record_authenticated_download`,
  which is granted to `authenticated` only. `ghost_downloads` has no client write grant at all.
- Row access. RLS on all three tables: public read, owner-only writes, no cross-user modification.
- Field shape. CHECK constraints on title and description length, file size, username format,
  avatar URL scheme, tag count, and non-negative counters.
- Path integrity. `file_path` must begin with the owner's uuid and may not contain `..`.

**Enforced by the `ghost-storage` Edge Function** (the R2 bucket has no notion of users, so the
rules Supabase Storage policies used to enforce now live in the function)

- Every upload goes through a presigned URL the function issues to a signed-in, non-deleted
  account. The function builds the key itself as `<auth.uid()>/<ghost-id>/<name>.smsghost` from the
  verified JWT, with exactly two folders, the `.smsghost` extension and the same `safeFilename` rules
  as the website, so no user can write into another user's folder.
- The URL signs the exact `Content-Length` (at most 100 MiB), `Content-Type:
  application/octet-stream` and `If-None-Match: *`, and expires after 15 minutes, so it cannot be
  reused for a different size or type, or to overwrite an existing object.
- Deletes are only for keys under the caller's own uid, and are refused for a file that has been
  validated for Moonshine or that a ghost row still points at.
- The R2 access keys exist only in Edge Function secrets; the browser never holds a credential.

**Enforced by Supabase Auth**

- Password storage and verification, session tokens, refresh and email flows. This project never
  hashes a password or stores one in its own tables.

**Handled in the frontend**

- React escapes interpolated text by default, and nothing here uses `dangerouslySetInnerHTML`, so
  stored titles, bios and descriptions cannot inject markup.
- Avatar URLs are restricted to `https://` in both the form and a database constraint, which rules
  out `javascript:` and `data:` sources.
- All queries are parameterised through the Supabase client or typed RPC arguments; no SQL is
  assembled from user input. The one dynamic `ORDER BY` in `list_ghosts` is chosen from a fixed
  whitelist, never interpolated from the request.
- Errors are mapped to plain sentences; raw Postgres messages are not shown to users.

**Limitations worth knowing**

- **File contents are validated in the browser, not on the server.** Magic number, declared length
  and both CRC32s are checked before upload, but a determined uploader can call Storage directly and
  put arbitrary bytes under their own folder within the size, extension and type limits by asking
  `ghost-storage` for a presigned URL directly. Ghosts are
  served as `application/octet-stream` for download rather than executed or rendered, so the
  exposure is a junk file rather than code execution. Since migration 0012 the `moonshine-api` Edge
  Function validates every ghost's stored bytes on the server, and only files that pass are offered
  to Moonshine — but the website archive itself still accepts files that fail.
- **Download counting resists casual inflation, not a determined one.** A signed-in user can add one
  count per ghost per hour, and could automate that across many accounts. Signup rate limits and the
  cooldown raise the cost; they do not eliminate it. The `ghost_downloads` log is there so tighter
  rules can be applied later.
- **Bucket objects can be orphaned.** If a delete removes the row but the `ghost-storage` call then fails,
  a file can be left behind. It is unreachable through the archive — nothing links to it — but it
  still occupies quota. A periodic sweep comparing bucket contents against `ghosts.file_path` would
  close this.
- **The anon key is public.** That is how Supabase is designed to work. Its blast radius is exactly
  what the RLS policies permit, which is why those policies rather than key secrecy are the thing to
  review when changing the schema.
- **Anyone can register.** There is no moderation queue, no reporting flow and no admin interface.
  Removing a bad upload currently means acting through Supabase directly.
- **This is not a claim of invulnerability.** It is a description of specific controls. If you change
  a policy, a trigger or a grant, re-check this section against what the SQL actually says.

---

## 8. Project layout

```text
delfino-ghosts/
├── .github/workflows/deploy.yml   GitHub Pages build and deploy
├── public/
│   ├── 404.html                   SPA fallback for deep links
│   ├── .nojekyll
│   └── favicon.svg
├── src/
│   ├── components/                Navbar, GhostList, GhostRow, AuthorName,
│   │                              TasIndicator, DownloadButton, GhostForm,
│   │                              SortSelector, SearchBar, Pagination, ...
│   ├── pages/                     Home, Browse, GhostDetail, Upload, EditGhost,
│   │                              Profile, Community, About, Login, Register,
│   │                              ResetPassword, Settings, NotFound
│   ├── lib/
│   │   ├── supabase.ts            Client construction
│   │   ├── auth.tsx               Session context and auth actions
│   │   ├── ghosts.ts              Ghost queries and mutations
│   │   ├── profiles.ts            Profile queries
│   │   ├── downloads.ts           Download delivery and counting
│   │   ├── community.ts           Stats, rankings, MDP
│   │   ├── errors.ts              Database errors to plain sentences
│   │   └── ghost/                 GhostParser, GhostValidator,
│   │                              GhostStorage, GhostMetadata
│   ├── hooks/                     useTheme, useMdp, useDebounced, useDocumentTitle
│   ├── types/                     Shared types and constants
│   ├── utils/                     Formatting and input validation
│   └── styles.css                 Design tokens and all styling
├── supabase/
│   ├── functions/                 ghost-storage/, moonshine-api/, _shared/
│   ├── migrations/                0001_init.sql … 0015_size_100mb.sql
│   ├── scripts/                   moonshine_backfill.mjs, migrate_to_r2.mjs
│   └── tests/                     local_stubs.sql, security_checks.sql, moonshine/, storage/
├── .env.example
└── vite.config.ts
```

Database access is confined to `src/lib`. Components receive data as props and never build queries.

---

## 9. Troubleshooting

**"Delfino Ghosts is not configured"** — `.env` is missing or empty. In production it means the
Actions variables were not set at build time; add them and re-run the workflow.

**Signup produced an unexpected username** — the trigger falls back to a derived name (like
`runner_a1b2c`) when the requested one is malformed, reserved, or lost a race for a name that is
case-insensitively taken (`Theo` and `theo` collide). The account is created either way; the person
can set the name they want in Settings.

**A deep link 404s on the live site** — confirm `dist/404.html` exists in the deployed artifact and
that Pages **Source** is set to **GitHub Actions** rather than a branch.

**Verification emails do not arrive** — check the redirect URLs in section 2.3, and remember
Supabase's built-in mail service is rate-limited and meant for development. Configure your own SMTP
provider before opening the archive to a real community.

**Avatars will not save** — fixed by migration 0005. The original constraint used a regex bound of
`{1,400}`, and PostgreSQL caps repetition bounds at 255: rather than failing to match, the pattern
raises `invalid regular expression: invalid repetition count(s)` whenever it is evaluated, so every
non-null avatar was rejected. Worth remembering for any future CHECK — put length limits in
`char_length()`, not in the pattern.

**An avatar saves but shows nothing** — the field needs a direct link to the image file, not the
page around it. `imgur.com/abc123.jpg` is a viewer page; `i.imgur.com/abc123.jpg` is the image. The
settings form rewrites Imgur links automatically, warns about X, ImgBB and cloud-storage links, and
previews the image so a broken link is visible before saving.

**Uploads fail with a size or type error** — the `ghost-storage` function enforces 100 MiB and the
`.smsghost` extension independently of the browser, and `ghosts_file_size_range` (0015) does the same
in the database. Confirm 0015 ran and the function is deployed.

**Uploads or downloads fail with a network error** — usually the R2 CORS rule (section 2.5): the
origin must be listed exactly, scheme and host, no path. A `403` on the PUT itself means the request
differed from what was signed (a different size or a missing header), or the 15-minute URL expired
before the upload started; uploading again gets a fresh URL.

**"A file with that name is already stored"** — the bucket refused to overwrite an existing object
(`object_exists`). Ghost files are never replaced in place; uploading again uses a new key.

**Download counts are not moving** — counting only happens for signed-in users who are not the
ghost's author, and only once per ghost per hour per account. All three are intentional.

**Batch uploads stop part way** — the run halts at the 200-ghost limit, and everything uploaded
before that point is already saved. Rows left in the queue keep their metadata, so delete some
ghosts and press upload again to resume.

**Counters look wrong after manual database edits** — run `select public.recompute_profile_stats();`
in the SQL editor to rebuild the aggregates from the ghosts table.
