# Delfino Ghosts

A community archive for Super Mario Sunshine ghosts recorded with
[Moonshine](https://github.com/panther03/moonshine/releases/), the SMS practice mod.

Browse the archive, find a ghost, download it. An account is only needed to upload and to have
your downloads counted.

- **Frontend:** React + TypeScript + Vite, hosted on GitHub Pages
- **Backend:** Supabase (Auth, PostgreSQL, Storage) — no custom server
- **Live at:** `https://<your-username>.github.io/delfino-ghosts/`

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
cp .env.example .env      # then fill in the two values, see section 3
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

### 2.5 Storage

The Storage bucket is created by `supabase/migrations/0002_storage.sql`, so there is nothing to
click. After running it, check **Storage** and confirm a bucket named `ghosts` exists, is marked
public, and has a 2 MB file size limit.

The bucket is public on purpose: guests must be able to download ghosts. Public means *readable* —
writes are still governed by the policies in that same file, which only allow an authenticated user
to write inside a folder named after their own user id.

---

## 3. Environment variables

Create `.env` in the project root:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
```

**Which values are public, and why it matters.**

| Value | Where it belongs | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | `.env`, GitHub repository variable | Public. It is just your project's address. |
| `VITE_SUPABASE_ANON_KEY` | `.env`, GitHub repository variable | Public by design. It identifies the `anon` role; what it can actually do is decided entirely by Row Level Security. |
| `service_role` key | Nowhere in this project | Bypasses RLS. Treat it like a database superuser password. |
| Database password | Nowhere in this project | Only for direct psql/CLI access. |

Anything prefixed `VITE_` is **inlined into the built JavaScript** and is readable by anyone who
opens the site. That is fine for the two values above and unacceptable for anything else. `.env` is
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
psql -d delfino_test -f supabase/tests/security_checks.sql
```

Several checks deliberately provoke errors — for those, the error *is* the passing result, and each
block says what to expect.

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
| `file_path` | Storage key. A CHECK constraint requires it to start with `user_id/` and contain no `..` |
| `original_filename`, `file_size` | Size capped at 2 MiB |
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

There is deliberately no insert or delete policy on `profiles`: rows arrive via the signup trigger
and leave via the `auth.users` cascade.

### Storage policies

On `storage.objects` for bucket `ghosts`:

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
   add two repository variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

   Repository *variables* rather than *secrets* is the honest choice here: both values ship inside
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

### Downloads and the counter

Every visitor can download every ghost. The file is fetched from the public Storage URL and saved
byte-for-byte; nothing rewrites the container.

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

**Enforced by Supabase Storage**

- 2 MiB per object and an allowed MIME list, set on the bucket itself.
- Write policies keyed to `auth.uid()`, requiring the `.smsghost` extension and the expected folder
  depth — so no user can write into, overwrite or delete another user's folder.

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
  put arbitrary bytes under their own folder within the size, extension and MIME limits. Ghosts are
  served as `application/octet-stream` for download rather than executed or rendered, so the
  exposure is a junk file rather than code execution. Server-side content validation would need an
  Edge Function on the upload path.
- **Download counting resists casual inflation, not a determined one.** A signed-in user can add one
  count per ghost per hour, and could automate that across many accounts. Signup rate limits and the
  cooldown raise the cost; they do not eliminate it. The `ghost_downloads` log is there so tighter
  rules can be applied later.
- **Storage objects can be orphaned.** If a delete removes the row but the Storage call then fails,
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
│   ├── migrations/                0001_init.sql, 0002_storage.sql
│   └── tests/                     local_stubs.sql, security_checks.sql
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

**Uploads fail with a size or type error** — the Storage bucket enforces 2 MB and the `.smsghost`
extension independently of the browser. Confirm `0002_storage.sql` ran.

**Download counts are not moving** — counting only happens for signed-in users who are not the
ghost's author, and only once per ghost per hour per account. All three are intentional.

**Batch uploads stop part way** — the run halts at the 200-ghost limit, and everything uploaded
before that point is already saved. Rows left in the queue keep their metadata, so delete some
ghosts and press upload again to resume.

**Counters look wrong after manual database edits** — run `select public.recompute_profile_stats();`
in the SQL editor to rebuild the aggregates from the ghosts table.
