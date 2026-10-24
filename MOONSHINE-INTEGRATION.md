# Delfino Ghosts × Moonshine: ghost-sharing integration

Handoff for Moonshine's coding agent. It covers what the Delfino Ghosts service offers Moonshine,
exactly how to call it, and what is still pending on our side.

> **Deployment status (2026-10-24): the API is implemented and tested, but not deployed yet.**
> Every URL under `/functions/v1/moonshine-api` below returns `404` until the site owner runs the
> deployment steps in §12. Treat those URLs as **placeholders that become live unchanged**; nothing
> about their shape depends on deployment. The download URLs (public Storage) already work today
> for the 121 ghosts in the archive.

Contents: [1 Status](#1-status-deployed-vs-pending) · [2 URLs and keys](#2-urls-and-keys) ·
[3 Client flow](#3-client-flow-in-one-page) · [4 Conventions](#4-conventions) ·
[5 Endpoints](#5-endpoints-with-real-examples) · [6 Catalogue entry](#6-the-catalogue-entry-catalogue_schema-1) ·
[7 File compatibility](#7-file-compatibility) · [8 Errors](#8-error-codes) · [9 Limits](#9-limits-and-rate-limits) ·
[10 Native Wii TLS](#10-native-wii-https-facts) · [11 OpenAPI](#11-openapi-31) ·
[12 Server side](#12-server-side-what-was-built-and-how-to-deploy-it) ·
[13 Open questions for Moonshine](#13-open-questions-for-moonshine) ·
[14 Still needed from us](#14-still-needed-from-us-delfino-ghosts)

---

## 1. Status: deployed vs pending

| Piece | State | How it was checked |
| --- | --- | --- |
| Website `zeldocto.github.io/delfino-ghosts` | **Live** (current version) | Fetched 2026-10-24 |
| Supabase project `cvadewafbthfhvzgdgay` with migrations 0001–0011 | **Live** | Public RPCs answer with the 0007 and 0011 signatures (`levels_in_use(p_user)`, `list_ghosts(p_tas)`). Those two files are missing from the repo; see §14 |
| Public `ghosts` Storage bucket (downloads) | **Live**: anonymous GET works, `Accept-Ranges: bytes`, `206` on Range | `curl` against a real object |
| `ghosts` bucket size limit | **Unconfirmed**. The repo says 10 MiB (migration 0010), but bucket metadata is not readable with the public key | Owner must run the SQL in §14 |
| Migration `0012_moonshine_api.sql` (tables, RPCs, policies, staging bucket) | **Pending**. In the repo, not applied | — |
| Edge Function `moonshine-api` | **Pending**. In the repo, not deployed (`/functions/v1/moonshine-api/*` → 404) | `curl` 2026-10-24 |
| Website `/link` approval page, Settings → Linked devices, upload-path changes | **Pending**. In the repo, not pushed to Pages | — |
| Validation of the 121 existing ghosts (backfill) | **Pending**. Runs after deploy (§12.4) | Locally, all 121 pass Moonshine's own `validate_ghost.py` |
| Tests | **Passing locally**: 19 tests, plus 3,121-input validator parity with `validate_ghost.py` | §12.5 |

---

## 2. URLs and keys

| What | Value | Status |
| --- | --- | --- |
| API base | `https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api` | **placeholder until deploy** |
| Capabilities | `GET {base}/v1/capabilities` | placeholder until deploy |
| Player approval page | `https://zeldocto.github.io/delfino-ghosts/link` (optional `?code=XXXX-XXXX`) | placeholder until the website push |
| Ghost downloads | `https://cvadewafbthfhvzgdgay.supabase.co/storage/v1/object/public/ghosts/<path>` | **live** |
| Website ghost page | `https://zeldocto.github.io/delfino-ghosts/ghost/<id>` | live |
| Supabase publishable key | `sb_publishable_mrh55bmXKXF_paQ7WTb3lA_oeJHWILU` | live; **intentionally public** (it ships in the website JS). **The Moonshine API does not need it.** It is only for calling the RPCs directly through PostgREST (§5.9) |

No secret or service-role key appears anywhere in this document or in any client. Do not ask users
for one; nothing in Moonshine should ever hold one.

---

## 3. Client flow in one page

```
Browse / download (no account, no key)
  GET  {base}/v1/capabilities                  once per session; check api_version == 1
  GET  {base}/v1/ghosts?route_key=..&cursor=..  page through compatible ghosts
  GET  file.download_url                        direct HTTPS, no redirect, no expiry, Range OK
       verify byte_length and sha256, then validate locally as usual

Link the device (once)
  POST {base}/v1/device/code                    -> user_code + verification_uri(_complete), device_code
       show "Go to delfino-ghosts/link and enter BCDF-GHJK" (or a QR of verification_uri_complete)
  POST {base}/v1/device/token  every `interval` s  -> 400 authorization_pending ... then 200 tokens
       store refresh_token (90-day sliding) and access_token (1 h)

Upload a saved recording (player opted in)
  POST {base}/v1/uploads         {byte_length, sha256}    Bearer access_token, Idempotency-Key
  PUT  upload.content_url        raw bytes                -> validated (or 422 with the validator's reason)
  POST upload.publish_url                                 -> 201 published (retries: 200 already_published)

Keep the link alive
  on 401 token_expired: POST {base}/v1/device/refresh {refresh_token} -> new pair (rotate both)
  on 400 invalid_grant from refresh: the link is gone; start linking again
  to unlink from the game: POST {base}/v1/device/revoke {token: refresh_token}
```

Every step is safe to repeat. A retry never creates a second ghost (§5.6).

---

## 4. Conventions

- **Transport:** HTTPS only. Request and response bodies are JSON (`application/json; charset=utf-8`)
  except ghost content, which is raw `application/octet-stream`. Responses carry
  `Cache-Control: no-store` and permissive CORS (`Access-Control-Allow-Origin: *`).
- **No client key.** Public endpoints need no headers at all. Upload endpoints need
  `Authorization: Bearer <access_token>`.
- **IDs:** ghost ids and upload ids are lowercase UUIDs. They are stable for the life of the entry and
  are the only identity of a catalogue entry. A ghost's *bytes* are identified by `file.sha256`. Titles,
  levels, display times and filenames are display text and never define identity or compatibility.
- **Timestamps** are ISO 8601 with offset, from PostgreSQL (`2026-10-24T21:15:07.955+00:00`).
- **Versioning:** `api_version` (currently `1`) covers URLs and envelopes; `catalogue_schema`
  (currently `1`) covers the shape of a catalogue entry. Both are in `/v1/capabilities` and in every
  listing. Additive fields may appear without a bump; removals or meaning changes bump the number.
  Ignore unknown fields.
- **Errors** use one small envelope, always:
  ```json
  {"error": {"code": "rate_limited", "message": "Too many requests. Wait `retry_after_s` seconds.",
             "retryable": true, "retry_after_s": 412}}
  ```
  `code` is stable and machine-readable (full table in §8). `retryable: true` means the identical
  request may succeed later; when a wait applies there is also a `Retry-After` header (seconds) and a
  numeric `retry_after_s` or `interval`. Optional `detail` holds a human-readable reason (for
  validation failures, the exact message from Moonshine's validator). Other keys are code-specific
  (`ghost_id`, `parameter`, `expected_sha256`, …).
- **Retry policy we recommend:** for `retryable` errors or network failures, exponential backoff from
  2 s up to 5 min with jitter, honouring `Retry-After`. Never retry a non-retryable error unchanged.

---

## 5. Endpoints, with real examples

The JSON bodies below are **real output** of the implemented handler, captured from the local test
run (§12.5). The test ran against a stand-in host, so the hostname has been replaced with the real
project host, timestamps converted to UTC, and long repeated objects shortened with `…`. Tokens and
ids are from that local run and are not valid anywhere.

```sh
BASE=https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api   # placeholder until deploy
```

### 5.1 `GET /v1/capabilities`

```sh
curl -s "$BASE/v1/capabilities"
```
```json
{
  "api_version": 1,
  "catalogue_schema": 1,
  "service": "delfino-ghosts",
  "api_base_url": "https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api",
  "website_url": "https://zeldocto.github.io/delfino-ghosts",
  "formats": [{
    "magic": "SGHF", "extension": ".smsghost",
    "versions": [3, 4, 5, 6, 7, 8, 9], "current_version": 9,
    "required_features_by_version": {"3": 0, "4": 1, "5": 3, "6": 7, "7": 15, "8": 31, "9": 63},
    "feature_names": {"1": "extended_codec", "2": "teaching", "4": "fludd", "8": "visual_v7", "16": "camera", "32": "initial_rng"},
    "validator": "delfino-sghf-validator/1 (port of validate_ghost.py @ moonshine-pr27)",
    "upstream_spec": "Moonshine PR27, 2026-10-24 (ghost_format.h, ghost_format.md, validate_ghost.py)",
    "unknown_versions": "rejected (unsupported_version)",
    "unknown_required_features": "rejected (unsupported_feature)"
  }],
  "limits": {
    "max_upload_bytes": 1297992, "max_download_bytes": 1297992,
    "page_size_default": 20, "page_size_max": 50,
    "upload_session_ttl_s": 86400, "max_open_uploads": 5, "max_content_attempts": 10,
    "upload_creates_per_hour": 30,
    "device_code_ttl_s": 600, "device_poll_interval_s": 5, "device_poll_interval_max_s": 60,
    "device_starts_per_10min": 10,
    "access_token_ttl_s": 3600, "refresh_token_ttl_s": 7776000,
    "max_linked_devices": 10, "archive_ghost_limit_per_account": 200
  },
  "auth": {
    "catalogue": "none", "downloads": "none",
    "uploads": "Authorization: Bearer <access_token> from device linking",
    "client_key_required": false,
    "device_authorization_url": "https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api/v1/device/code",
    "token_url":   "https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api/v1/device/token",
    "refresh_url": "https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api/v1/device/refresh",
    "revoke_url":  "https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api/v1/device/revoke",
    "verification_uri": "https://zeldocto.github.io/delfino-ghosts/link"
  },
  "downloads": {
    "url_field": "file.download_url", "redirects": false, "signed": false, "expires": false,
    "range_requests": true, "content_type": "application/octet-stream",
    "integrity": "compare file.sha256 and file.byte_length after download"
  },
  "catalogue": {
    "sorts": ["newest", "oldest", "result_qf"],
    "filters": ["route_key", "area", "episode", "region", "playable_on", "source_profile", "assistance", "format_version", "author", "sha256"],
    "assistance_values": ["tas", "assisted", "unknown"],
    "compatible_only": true
  }
}
```
The limits come from one SQL function (`moonshine_config()`), the same numbers the database
enforces, so the capabilities can't drift from the real behaviour.

### 5.2 `GET /v1/ghosts`: browse (public, paginated)

Only ghosts whose **stored bytes** passed server-side validation and the size limit are listed
(`compatible_only: true`). Website ghosts that fail stay on the website but never appear here.

| Query parameter | Meaning |
| --- | --- |
| `route_key` | Exact route identity, e.g. `02.2.ff.00.-1` (§6.3). The IL filter |
| `area`, `episode` | Header route area (0–60) / episode (0–9), as stored in the file |
| `region` | Source region of the recording: `jp`, `us`, `pal` |
| `playable_on` | `jp`/`us`/`pal`: same region **or** every segment route is cross-region portable (Moonshine's portable-route policy) |
| `source_profile` | The file's `sourceProfile` number (0–3, 5) |
| `assistance` | `tas`, `assisted` or `unknown` (§6.5). There is deliberately no "clean" value |
| `format_version` | SGHF version 3–9 |
| `author` | Website username (case-insensitive) |
| `sha256` | Exact bytes lookup ("is this file already on the site?") |
| `sort` | `newest` (default), `oldest`, `result_qf` (ascending; ghosts without a result last) |
| `limit` | 1–50, default 20 |
| `cursor` | Opaque; pass back `next_cursor` from the previous page. Must be used with the same `sort` |

Pagination is keyset-based: every sort is a total order on `(sort key, id)`, so ghosts added or
removed while you browse never duplicate or skip entries on later pages. `next_cursor` is `null` on
the last page. `total` is the exact count of matches for the filters.

```sh
curl -s "$BASE/v1/ghosts?route_key=02.2.ff.00.-1&sort=newest&limit=1"
```
```json
{
  "api_version": 1,
  "catalogue_schema": 1,
  "items": [{
    "id": "b852e301-ea86-48b8-8838-4bd6def79c05",
    "title": "Bianco Hills 3 - 0:37.337",
    "description": null,
    "uploaded_at": "2026-10-24T21:15:07.955+00:00",
    "updated_at": "2026-10-24T21:15:07.955+00:00",
    "author": {"id": "6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f", "username": "alice", "display_name": null},
    "file": {
      "path": "6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f/b852e301-ea86-48b8-8838-4bd6def79c05/2026_10_24_BH3_37337_1A2B3C4D_.smsghost",
      "filename": "2026_10_24_BH3_37337_1A2B3C4D_.smsghost",
      "byte_length": 21356,
      "sha256": "05ba53e4cbf31135bd689755092505c8fd53c8d4965d4082ad0ce2eb96224d39",
      "crc32": "35CA8C1C",
      "content_type": "application/octet-stream",
      "download_url": "https://cvadewafbthfhvzgdgay.supabase.co/storage/v1/object/public/ghosts/6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f/b852e301-ea86-48b8-8838-4bd6def79c05/2026_10_24_BH3_37337_1A2B3C4D_.smsghost"
    },
    "format": {
      "magic": "SGHF", "version": 9, "required_features": 63,
      "features": ["extended_codec", "teaching", "fludd", "visual_v7", "camera", "initial_rng"],
      "validator": "delfino-sghf-validator/1 (port of validate_ghost.py @ moonshine-pr27)",
      "validated_at": "2026-10-24T21:15:07.955+00:00"
    },
    "game": {"game_id": "GMSJ", "region": "jp", "disc_revision": 0},
    "profile": {"source_profile": 0, "name": "Any percent"},
    "route": {"key": "02.2.ff.00.-1", "area": 2, "episode": 2, "parent_area": 255, "flags": 0,
              "variant": -1, "segment_count": 1, "portable_across_regions": true},
    "timing": {"unit": "qf", "result_qf": 4476, "start_qf": 0, "end_qf": 4476, "duration_qf": 4476,
               "export_duration_ms": 37337},
    "recording": {"sample_count": 1120, "input_count": 40, "split_count": 3, "camera_sample_count": 3,
                  "initial_rng": {"seed": 610839776, "provenance": "first_recorded_pose"},
                  "header_ghost_id": "0123456789abcdef", "created_unix": 1760000000},
    "header_text": {"name": "Bianco Hills 3 - 0:37.337", "author": "alice"},
    "eligibility": {
      "run_flags": 0,
      "flags": {"assisted": false, "savestate_used": false, "fast_forward_used": false,
                "incomplete": false, "custom_route": false, "tas": false},
      "unknown_flag_bits": 0,
      "uploader_tas": null,
      "assistance": "unknown"
    },
    "site": {"level": "Bianco Hills 3", "time_ms": 37337, "download_count": 0},
    "page_url": "https://zeldocto.github.io/delfino-ghosts/ghost/b852e301-ea86-48b8-8838-4bd6def79c05"
  }],
  "next_cursor": null,
  "total": 1,
  "limit": 1,
  "sort": "newest"
}
```
A non-final page has `"next_cursor": "n~-1792876507955000~b852e301-…"`; send it back verbatim as
`&cursor=…`. Bad filters give `400 invalid_parameter` with `"parameter": "region"` (for example).

### 5.3 `GET /v1/ghosts/{id}` and `GET /v1/ghosts/{id}/file`

`GET /v1/ghosts/{id}` returns `{"api_version":1,"catalogue_schema":1,"ghost":{…entry…}}` for a
compatible ghost. For a ghost that exists on the website but is not offered, it explains why:

```json
{"api_version": 1, "catalogue_schema": 1,
 "ghost": {"compatible": false, "id": "…", "status": "invalid", "status_code": "invalid_ghost",
           "detail": "ghost file checksum mismatch"}}
```
`status` is `not_indexed` (not validated yet), `invalid`, `unsupported` or `too_large`. Unknown id →
`404 not_found`.

`GET /v1/ghosts/{id}/file` answers **`302`** with `Location: <download_url>` (and the same URL in a
JSON body) for clients that prefer a stable per-id URL. Incompatible or unknown ids → `404`. Clients
that cannot follow redirects should use `file.download_url` from the entry directly. That URL is
never a redirect.

### 5.4 Downloads

```sh
curl -sS -o ghost.smsghost "$DOWNLOAD_URL"                       # whole file
curl -sS -H 'Range: bytes=0-65535' -o part0 "$DOWNLOAD_URL"      # 206 Partial Content
```
- **No account, no key, no signature, no expiry.** The URL points at Supabase's public Storage
  endpoint for the object and stays valid while the ghost exists. There is **no redirect**.
- **Range/resume works** (verified live: `Accept-Ranges: bytes`, `206` with `Content-Range`).
- Response: `200`, `Content-Type: application/octet-stream`, exact `Content-Length`, an `ETag`,
  `Cache-Control: private, no-cache`. Bytes are exactly what was uploaded. The service never rewrites
  a ghost.
- **Missing object quirk (observed live):** a deleted or nonexistent object returns **HTTP 400** with
  body `{"statusCode":"404","error":"not_found","message":"Object not found"}`. Treat any non-2xx as
  "not available" and drop the entry from local caches.
- Size: every listed ghost is ≤ 1,297,992 bytes (`limits.max_download_bytes`). Today's largest live
  ghost is 94,648 bytes.
- **Integrity:** after download, check `byte_length` and `sha256`, then run Moonshine's own local
  validation before installing. If the hash differs, the website owner replaced the file after you
  listed it. Re-fetch the entry (`GET /v1/ghosts/{id}`) and try again.
- **Filenames:** `file.filename` is display text (sanitised to `[A-Za-z0-9._-]`, but up to 105 bytes,
  over the import leaf's 95-byte limit). Do not use it as a path. Build the local leaf yourself,
  e.g. the spec's host convention `g_<header_ghost_id>.smsghost`.
- Downloads through the API do **not** count toward the website's download counters or rankings.

### 5.5 Device linking

The flow follows OAuth 2.0 Device Authorization (RFC 8628). The game never sees a password and
never holds a Supabase session. It gets an access/refresh pair that works **only** for this API
(uploads and `/v1/me`). The player can revoke it on the website at any time.

**Start:** `POST /v1/device/code`
```sh
curl -s -X POST "$BASE/v1/device/code" -H 'content-type: application/json' \
     -d '{"client_name":"Moonshine Wii","client_version":"0.9.0"}'
```
```json
{
  "device_code": "dgd_cP83GIcdOlEItsAWzIHHJ-WZbFM2MtUcSDkpITa_O9g",
  "user_code": "NVSF-GXKW",
  "verification_uri": "https://zeldocto.github.io/delfino-ghosts/link",
  "verification_uri_complete": "https://zeldocto.github.io/delfino-ghosts/link?code=NVSF-GXKW",
  "expires_in": 600,
  "interval": 5
}
```
- `client_name` (≤48 printable ASCII, default `"Moonshine"`) and `client_version` (≤32) are shown to
  the player on the approval page and in their Settings. Use something like `Moonshine Wii` or
  `Moonshine (Dolphin)`.
- `user_code` is 8 characters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels, no 0/O/1/I). Display it as
  shown; the website accepts it in any case, with or without the dash.
- `device_code` is secret. Keep it in memory only and never display it.
- Rate limit: 10 starts per client IP per 10 minutes (`429 rate_limited` with `retry_after_s`).

**Player approves** on a phone or PC at `verification_uri` (they sign in to the website first if
needed). The page shows the device name and code and asks them to approve or deny. A QR code of
`verification_uri_complete` is a good option on the TV.

**Poll:** `POST /v1/device/token`, no faster than every `interval` seconds
```sh
curl -s -X POST "$BASE/v1/device/token" -H 'content-type: application/json' -d '{"device_code":"dgd_…"}'
```
While waiting (`400`, `Retry-After: 5`):
```json
{"error": {"code": "authorization_pending", "retryable": true, "interval": 5,
           "message": "The player has not approved this code yet. Poll again after `interval` seconds."}}
```
Polling early gets `slow_down`, and the interval grows by 5 s (capped at 60 s). Keep using the
latest `interval`:
```json
{"error": {"code": "slow_down", "retryable": true, "interval": 10,
           "message": "Polling too fast. The interval has been increased; wait `interval` seconds."}}
```
After approval (`200`):
```json
{
  "token_type": "Bearer",
  "access_token": "dga_ZtLgjMoSnttt7WMHqSe75YAfBS0-AYKyS_pjrSoqOGs",
  "expires_in": 3600,
  "refresh_token": "dgr_kduEO3o3O8492hgNUuJWX0y-sw12RJZOPd4khAnweUg",
  "refresh_expires_in": 7776000,
  "link_id": "84941371-f9aa-4c69-bccd-2acdcd56e52f",
  "user": {"id": "6f1c2d4e-8a3b-4c5d-9e7f-0a1b2c3d4e5f", "username": "alice", "display_name": null},
  "scope": "uploads"
}
```
Terminal poll errors (all `400`, not retryable; start over with `/v1/device/code`): `expired_token`
(10 minutes passed), `access_denied` (player denied, or revoked before collection), `invalid_grant`
(unknown code, or code already used). Polling ends within 10 minutes. With the `slow_down` cap,
a code can poll at most about 120 times.

*Lost response:* if the `200` never arrived, polling again with the same `device_code` **within 2
minutes** returns a fresh pair. The earlier pair stops working, so keep only the newest. After 2
minutes the code is spent (`invalid_grant`).

**Refresh:** `POST /v1/device/refresh`
```sh
curl -s -X POST "$BASE/v1/device/refresh" -H 'content-type: application/json' -d '{"refresh_token":"dgr_…"}'
```
Returns the same shape as the token response, with a **new access token and a new refresh token**.
Store both and discard the old ones.
- Access tokens last 1 hour. Refresh tokens last 90 days, renewed on every refresh, so a device that
  is used at least every 90 days stays linked indefinitely.
- Refresh on `401 token_expired`, or proactively a few minutes before `expires_in`.
- *Lost response:* presenting the previous refresh token **within 2 minutes** of the rotation
  returns another fresh pair. Presenting an old refresh token after that is treated as theft. The
  whole link is revoked (`400 invalid_grant`, `"reason":"refresh_token_reuse"`) and the player must
  link again.
- An expired refresh token gives `invalid_grant` with `"reason":"refresh_token_expired"`.

**Who am I:** `GET /v1/me` with `Authorization: Bearer <access_token>` →
`{"link_id":"…","user":{"id":"…","username":"alice","display_name":null}}`. Handy to show "Linked
as alice" and to check a stored token.

**Unlink from the game:** `POST /v1/device/revoke` with `{"token":"<refresh_token>"}` (or the access
token as `Authorization: Bearer`). It is idempotent: `{"revoked": true}` when the token belongs to a
link (even one already revoked), `{"revoked": false}` for a token we never issued. Always `200`.

**Unlinking elsewhere:** the player can unlink in *Settings → Linked devices*. Deleting their
account revokes all links at once. Either way the next API call gets `401 invalid_token` and the
next refresh `400 invalid_grant`.

Limits: 10 linked devices per account (approving an 11th shows the player an error).

### 5.6 Uploads

Three calls: **create** a session declaring the exact length and SHA-256, **PUT** the bytes, then
**publish**. The server validates the bytes against Moonshine's rules and publishes them under the
**token's own account**. Any `user_id` or author in the request is ignored.

**Create:** `POST /v1/uploads`
```sh
curl -s -X POST "$BASE/v1/uploads" \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -H 'idempotency-key: moonshine-0123456789abcdef' \
  -d '{"byte_length":21356,"sha256":"05ba53e4cbf31135bd689755092505c8fd53c8d4965d4082ad0ce2eb96224d39",
       "filename":"2026_10_24_BH3_37337[1A2B3C4D].smsghost","tas_declared":null}'
```
`201 Created`:
```json
{
  "result": "created",
  "upload": {
    "upload_id": "170c83ed-74b5-49e5-9f7a-a29914c27d06",
    "status": "awaiting_content",
    "byte_length": 21356,
    "sha256": "05ba53e4cbf31135bd689755092505c8fd53c8d4965d4082ad0ce2eb96224d39",
    "ghost_id": null,
    "created_at": "2026-10-24T21:15:07.911+00:00",
    "expires_at": "2026-10-25T21:15:07.911+00:00",
    "validation": null,
    "error": null,
    "content_url": "https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api/v1/uploads/170c83ed-74b5-49e5-9f7a-a29914c27d06/content",
    "publish_url": "https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api/v1/uploads/170c83ed-74b5-49e5-9f7a-a29914c27d06/publish"
  }
}
```
Body fields: `byte_length` (required, 1–1,297,992), `sha256` (required, 64 hex), and optionally
`filename` (≤200; display only), `title` (≤100; defaults to the file's header name, e.g.
`Bianco Hills 3 - 0:37.337`), `description` (≤2000), and `tas_declared` (`true` / `false` / `null`).
Header `Idempotency-Key` is optional: 1–64 characters of `[A-Za-z0-9_.:-]`, unique per account.
Using the file's SHA-256 or `header_ghost_id` works well.

**Transfer:** `PUT {content_url}` with the raw bytes (`POST` is accepted too, for clients without PUT)
```sh
curl -s -X PUT "$CONTENT_URL" -H "authorization: Bearer $ACCESS" \
     -H 'content-type: application/octet-stream' --data-binary @ghost.smsghost
```
`200`:
```json
{
  "result": "validated",
  "upload": {
    "upload_id": "170c83ed-74b5-49e5-9f7a-a29914c27d06",
    "status": "validated",
    "validation": {
      "validator": "delfino-sghf-validator/1 (port of validate_ghost.py @ moonshine-pr27)",
      "format_version": 9,
      "features": ["extended_codec", "teaching", "fludd", "visual_v7", "camera", "initial_rng"],
      "region": "jp", "source_profile": 0, "route_key": "02.2.ff.00.-1",
      "result_qf": 4476, "duration_qf": 4476,
      "header_name": "Bianco Hills 3 - 0:37.337", "header_ghost_id": "0123456789abcdef"
    },
    "…": "…"
  }
}
```
The body must be exactly `byte_length` bytes with exactly the declared SHA-256:
- Wrong length → `422 length_mismatch`; wrong hash → `422 sha256_mismatch` (with `expected_sha256` and
  `received_sha256`). Both are **retryable**: the session stays open, so resend the exact file.
- Hash matches but the file fails validation → `422 invalid_ghost` / `unsupported_version` /
  `unsupported_feature`, with the validator's message in `detail`. These are **final**: the bytes are
  fixed by the hash, so the session becomes `rejected`.
  ```json
  {"error": {"code": "invalid_ghost", "message": "The file is not a valid canonical SGHF ghost.",
             "retryable": false, "detail": "ghost file checksum mismatch"}}
  ```
- Ten content attempts per session (`429 too_many_attempts` after that).
- Sending the same correct bytes again is harmless (`200`).

**Publish:** `POST {publish_url}` (no body)
```sh
curl -s -X POST "$PUBLISH_URL" -H "authorization: Bearer $ACCESS"
```
`201 Created`, with `{"result":"published","ghost":{…full catalogue entry, as in §5.2…}}`. The
ghost is immediately on the website and in the catalogue. Its `file.sha256` equals the declared hash
and the stored bytes are byte-for-byte identical to the upload.

Publishing before valid content → `409 not_validated`. Publishing an expired session → `410
upload_expired`.

**Status:** `GET /v1/uploads/{upload_id}` returns the session (and `ghost` once published).
**Cancel:** `DELETE /v1/uploads/{upload_id}` is idempotent and returns the session with
`status: "cancelled"`. A session you don't own returns `404` on every method.

#### Retries, duplicates and conflicts: exact behaviour

| Situation | Result |
| --- | --- |
| `POST /v1/uploads` repeated with the same `Idempotency-Key` and same length+hash | `200`, `"result":"existing"`, same `upload_id` |
| Same `Idempotency-Key`, different length or hash | `409 idempotency_key_reused` |
| `POST /v1/uploads` again (no key) while a session for the same bytes is open | `200 "existing"`, same session |
| Bytes already published **by this account** (via the API *or* the website) | `200`, `"result":"already_published"`, `ghost` = the existing entry. No new session |
| Bytes already published **by another account** | `409 duplicate_content`, with `ghost_id` of the existing ghost |
| `PUT` repeated with the correct bytes | `200`, unchanged |
| `POST …/publish` repeated after success (lost response, double tap) | `200`, `"result":"already_published"`, same `ghost.id`. Never a second ghost |
| Two publishes racing | One `201`, the other `200 already_published`. Serialised in the database |
| Storage hiccup during publish | `503 storage_unavailable`, retryable. Nothing is half-published; retry the same publish |
| Account at the archive's 200-ghost limit | `409 ghost_limit_reached`. The written object is removed again |
| Session older than 24 h, not published | `expired`. `PUT`/`publish` → `410 upload_expired`. A new create for the same bytes starts a fresh session |
| More than 5 unfinished sessions | `409 too_many_open_uploads` (retryable once one finishes, is cancelled or expires) |
| More than 30 creates per hour per account | `429 rate_limited` with `retry_after_s` |

Abandoned sessions expire after 24 hours. Their staged bytes (in a private bucket no client can read)
are deleted by a sweeper that runs on each upload create. Rejected, cancelled and published sessions
are swept the same way, and their rows are deleted 30 days later.

### 5.7 What the server derives on publish (display fields only)

The website row gets the same display fields a browser upload would. `title` defaults to the header
`name`. `level` and `time_ms` are parsed from a `"<level> - <m:ss.mmm>"` name. The website's TAS
flag is set when `tas_declared` is `true`, the name starts with `TAS`, or the file has the TAS run
flag. A tag is made from the profile name (`any percent`). None of these affect identity or
compatibility.

### 5.8 `POST /v1/ghosts/{id}/index` (website use)

It validates the ghost's *stored* bytes and records the result. The website calls it after every
browser upload or file replacement, and the backfill script calls it once per existing ghost. It is
public but cannot be abused to change anything: it reads the bytes itself, and is a no-op for an
already-validated ghost (`?force=1` re-validates). It is rate-limited to 300 per hour per IP.
Moonshine doesn't need it.

### 5.9 Optional: direct PostgREST access

The catalogue is also exposed as an RPC, for a client that would rather use Supabase directly:
```sh
curl -s -X POST https://cvadewafbthfhvzgdgay.supabase.co/rest/v1/rpc/moonshine_list_ghosts \
  -H 'apikey: sb_publishable_mrh55bmXKXF_paQ7WTb3lA_oeJHWILU' -H 'content-type: application/json' \
  -d '{"p_route_key":"02.2.ff.00.-1","p_limit":20}'
```
This returns the same `items`/`next_cursor`/`total`, but without `download_url` and `page_url`. Build
the download URL as `https://cvadewafbthfhvzgdgay.supabase.co/storage/v1/object/public/ghosts/` +
`file.path`, with each path segment URL-encoded. **Pending deploy** (migration 0012). The Edge
Function is the supported interface; prefer it.

---

## 6. The catalogue entry (`catalogue_schema` 1)

### 6.1 Identity

| Field | Meaning |
| --- | --- |
| `id` | Catalogue identity (UUID). Stable for the life of the entry |
| `file.sha256` | Identity of the exact bytes. `(id, sha256)` names one version of an entry: if the owner replaces the file on the website, `id` stays the same and `sha256` changes |
| `recording.header_ghost_id` | The file's own opaque 64-bit `ghostId` (16 lowercase hex). Not unique across the archive (six same-account duplicate uploads exist today) |
| `file.crc32` | The file's stored `fileChecksum`, as 8 uppercase hex digits (the bracketed suffix in Moonshine export names) |

### 6.2 Format

`format.version` is the SGHF version (3–9). `format.required_features` is the raw header value and
`format.features` names its bits (`extended_codec`=1, `teaching`=2, `fludd`=4, `visual_v7`=8,
`camera`=16, `initial_rng`=32). `format.validator` and `validated_at` record which validator
accepted these bytes and when.

### 6.3 Route

All values come straight from the file header (= segment 0's route):

- `area` (0–0x3C), `episode` (0–9), `parent_area` (**255 = none**), `flags` (bit 0 internal scene,
  bit 1 parent start), `variant` (**−1 = none**, else 0–255).
- `key`: one stable string combining all five, `"{area:02x}.{episode}.{parent_area:02x}.{flags:02x}.{variant}"`,
  e.g. `02.2.ff.00.-1` or `07.3.06.01.-1`. It is the route/IL filter. It contains no display names.
- `segment_count`: route segments in the recording.
- `portable_across_regions`: `true` when **every** segment's route passes Moonshine's portable-route
  policy (`validate_imported_ghost`), i.e. the file may be imported into a different region's game.
  `playable_on=<region>` filters on this.

The website's free-text `site.level` (e.g. "Bianco Hills 3") is display text. Don't match on it.

### 6.4 Timing convention

- All timing is in **QF** (`timing.unit: "qf"`), copied exactly from the header: `result_qf`
  (`null` when the file stores `0xFFFFFFFF`, i.e. no result), `start_qf`, `end_qf`, `duration_qf`.
- `export_duration_ms = floor(duration_qf × 1001 / 120)` is the one millisecond conversion
  Moonshine's spec defines (the compact time in export filenames). It is derived from
  `duration_qf`, not `result_qf`.
- **We do not publish any other derived time.** The spec doesn't say whether the official run time
  is `result_qf`, `result_qf − start_qf`, or `duration_qf`, or whether 1001/120 applies to PAL. See
  §13 Q2.
- `sort=result_qf` sorts by the raw number. It is not a ranking.
- `site.time_ms` is the website's uploader-entered display time. It is sometimes rounded (several
  PAL uploads were entered to the centisecond). **Never use it for comparison.**

### 6.5 Eligibility: "unknown" is not "clean"

```json
"eligibility": {
  "run_flags": 41,
  "flags": {"assisted": true, "savestate_used": false, "fast_forward_used": false,
            "incomplete": true, "custom_route": false, "tas": true},
  "unknown_flag_bits": 0,
  "uploader_tas": true,
  "assistance": "tas"
}
```
- `run_flags` is the raw header value (advisory). `flags` decodes the six known bits.
  `unknown_flag_bits` holds the rest, preserved rather than dropped.
- `uploader_tas` is `true` when the uploader marked the ghost TAS on the website, otherwise `null`.
  The website's checkbox defaults to unticked, so an unticked box is not evidence of anything. It is
  never reported as `false`. For the same reason the API stores `tas_declared: false` but reports it
  as `null`.
- `assistance` is derived as follows:
  - `tas`: the file's TAS bit is set, or `uploader_tas` is true.
  - `assisted`: any of the assisted, savestate-used or fast-forward-used bits are set.
  - `unknown`: everything else. **There is no `clean` value.** Absent flags don't prove an
    unassisted run, and validation is a structural check, not anti-cheat.

### 6.6 Other

`profile.source_profile` is the header number (0–3, or 5 = hoverless per `ghost_format.h`).
`profile.name` is the file's display text (live data today: 0 = "Any percent", 2 = "Custom 1"). We
do not map profile numbers to categories (§13 Q3). `recording.*` holds counts from the validated
file. `initial_rng` is `{seed, provenance}` for V9 (a seed of 0 is real) and `null` for older
versions. `header_text` is the file's own name and author text. `site.*` and `title`/`description`
are website display data.

---

## 7. File compatibility

**What "compatible" means here:** the stored bytes pass a strict port of Moonshine's
`scripts/validate_ghost.py` (snapshot *Moonshine PR27, 2026-10-24*; the hashes of
`ghost_format.h`, `ghost_format.md` and `validate_ghost.py` match `SOURCE-MANIFEST.json`), **and** the
file is at most **1,297,992 bytes**. The check runs on the server, on the exact bytes in Storage.
Browser validation is UI help only.

- **Versions:** SGHF V3–V9 are accepted. V1, V2 and any version above 9 → `unsupported_version`.
  Any required-feature bit the version doesn't define → `unsupported_feature`. Nothing unknown is
  ever silently accepted. Checksum-kind ≠ 1 → `unsupported_feature`.
- **Everything the reference checks is enforced:** exact `fileSize`; all three header CRCs
  (header, payload, file); the segment-table CRC; the SGTI teaching CRC and its bounds (V5+); the
  SGCA camera CRC and its bounds (V8+); the V9 initial-RNG provenance word; canonical bounds for
  every count, offset, route, text field, pose sample, delta, FLUDD/Yoshi observation, split and
  camera sample. The order of checks and the classification (corrupt vs unsupported) match the
  reference. The server reports the reference validator's own message in `detail`.
- **Parity is tested, not assumed:** 3,121 inputs (synthetic V3–V9 fixtures, all 121 live archive
  files, truncations, bit flips with and without fixed-up CRCs, version and feature mutations) give
  the same class, the same message and the same parsed result in both the TypeScript port and
  Moonshine's Python validator. A deliberately broken rule makes the test fail.
- **Bytes are preserved exactly**, including camera, input/split and initial-RNG data. Nothing is
  re-encoded, trimmed or normalised. A validated archive object is immutable in Storage: overwriting
  it in place is refused by policy. A website replacement creates a new object, and that new object
  is validated afresh.
- **Size limits are kept separate:** the API advertises and accepts at most 1,297,992 bytes (the
  maximum canonical size Moonshine states). The website archive bucket keeps its own, larger limit
  (10 MiB per the repo; deployed value unconfirmed, §14). Larger or unsupported files may stay on
  the website, but they are never listed as compatible (`status: "too_large"` / `"unsupported"`).
- **Region:** the server doesn't restrict regions. `game.region`, `route.portable_across_regions`
  and `playable_on` let the game apply its own personal-library vs imported-pool rules.
- **Live archive today:** 121 ghosts, all valid under the reference: 78 V4, 40 V5, 2 V6, 1 V7, and
  no V8/V9 yet. 114 JP and 7 PAL. All portable. Largest 94,648 bytes. They'll be listed once the
  backfill runs.

Validation is a **structural** check. It is not proof against cheating, and the API never presents
it as one.

---

## 8. Error codes

| HTTP | `code` | Retryable | Meaning / what to do |
| --- | --- | --- | --- |
| 400 | `invalid_request` | no | Malformed JSON or field. See `detail` |
| 400 | `invalid_parameter` | no | Bad query parameter (`parameter` names it) |
| 400 | `authorization_pending` | yes | Player hasn't approved yet. Poll after `interval` s |
| 400 | `slow_down` | yes | Polled too fast. Use the new `interval` |
| 400 | `expired_token` | no | Link code expired. Start linking again |
| 400 | `access_denied` | no | Player denied or revoked. Start again only if asked |
| 400 | `invalid_grant` | no | Device code spent or unknown, or refresh token invalid/expired/reused (`reason`). Re-link |
| 401 | `invalid_token` | no | Missing, unknown or revoked access token. Refresh; if that fails, re-link |
| 401 | `token_expired` | yes | Access token expired. Refresh, then retry |
| 404 | `not_found` | no | Unknown or not-yours ghost/upload, or an incompatible ghost's `/file` |
| 404 | `route_not_found` | no | No such endpoint |
| 404 | `object_missing` | no | (index) row exists, file missing in Storage |
| 405 | `method_not_allowed` | no | `allowed` lists the methods |
| 409 | `duplicate_content` | no | Another account published these bytes (`ghost_id`) |
| 409 | `idempotency_key_reused` | no | Key used before for different content |
| 409 | `upload_closed` | no | Session published, rejected or cancelled |
| 409 | `not_validated` | no | PUT valid content before publishing |
| 409 | `content_missing` | no | Staged bytes vanished. PUT again, then publish |
| 409 | `ghost_limit_reached` | no | Account holds the 200-ghost maximum |
| 409 | `too_many_open_uploads` | yes | Finish, cancel or wait out a session |
| 409 | `too_many_devices` | no | (website) 10 linked devices already |
| 409 | `stale` | yes | (index) ghost changed while being read |
| 410 | `upload_expired` | no | Session expired. Create a new one |
| 413 | `too_large` | no | Over 1,297,992 bytes |
| 422 | `length_mismatch` | yes | Body length ≠ `byte_length`. Resend |
| 422 | `sha256_mismatch` | yes | Body hash ≠ `sha256`. Resend |
| 422 | `invalid_ghost` | no | Corrupt or non-canonical file. `detail` = validator message |
| 422 | `unsupported_version` | no | SGHF version not supported |
| 422 | `unsupported_feature` | no | Unknown required feature or checksum kind |
| 429 | `rate_limited` | yes | Wait `retry_after_s` (also `Retry-After`) |
| 429 | `too_many_attempts` | no | 10 content attempts used. New session |
| 500 | `internal` | yes | Unexpected. Back off and retry |
| 503 | `storage_unavailable` | yes | Storage didn't answer. Back off and retry |

---

## 9. Limits and rate limits

| Limit | Value |
| --- | --- |
| Max ghost size (API upload and listing) | 1,297,992 bytes |
| Page size | default 20, max 50 |
| Device code lifetime / poll interval | 600 s / 5 s (grows by 5 s per `slow_down`, max 60 s) |
| Device-code starts | 10 per client IP per 10 min |
| Website code lookups + approvals | 20 per account per 10 min |
| Access token / refresh token | 1 h / 90 days sliding, rotated on every refresh |
| Lost-response grace (token collection, refresh retry) | 120 s |
| Linked devices per account | 10 |
| Upload session lifetime | 24 h |
| Open upload sessions per account | 5 |
| Upload creates per account | 30 per hour |
| Content attempts per session | 10 |
| Ghosts per account (archive rule) | 200 |
| Index calls | 300 per IP per hour |

IPs are never stored. Rate-limit keys are salted SHA-256 hashes, kept for about a day.

---

## 10. Native Wii HTTPS facts

There is nothing Wii-specific on the server, so these are the constraints any native client must
meet. Measured against `cvadewafbthfhvzgdgay.supabase.co:443` on 2026-10-24:

- **TLS 1.2 or 1.3 only.** TLS 1.0/1.1 are refused (`protocol version` alert).
- **SNI required.** A handshake without SNI fails.
- **Only ECDHE key exchange with AES-GCM.** Plain RSA key exchange and CBC suites (e.g.
  `ECDHE-RSA-AES128-SHA`) are refused. `ECDHE-ECDSA-AES128-GCM-SHA256` and
  `ECDHE-RSA-AES128-GCM-SHA256` work.
- **Certificates:** `CN=supabase.co`, SAN `*.supabase.co`, issued by Google Trust Services. The ECDSA
  P-256 chain is WE1 → GTS Root R4, cross-signed by GlobalSign Root CA. There is also an RSA
  chain via WR1. The current leaf expires 2027-01-22 and rotates automatically, so pin roots,
  not leaves.

In practice the Wii's built-in SSL stack can't connect. A native client needs a modern embedded TLS
library (for example mbedTLS, wolfSSL or BearSSL) plus a CA bundle with the GTS roots and the
GlobalSign root. The Dolphin companion (ordinary host HTTPS) has none of these issues. If native TLS
turns out to be impractical, tell us (§13 Q10). Plain HTTP to Supabase only returns a `301`
redirect to HTTPS, so any non-TLS fallback would need a separate relay that we'd have to build and
host.

---

## 11. OpenAPI 3.1

```yaml
openapi: 3.1.0
info:
  title: Delfino Ghosts - Moonshine ghost-sharing API
  version: "1"
  description: >
    Catalogue, download, device linking and uploads for Moonshine SGHF ghosts.
    catalogue_schema 1. Errors always use the ErrorEnvelope schema.
servers:
  - url: https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api
    description: Production (pending deployment as of 2026-10-24)
components:
  securitySchemes:
    deviceToken:
      type: http
      scheme: bearer
      description: Access token (dga_...) from the device flow. Not a Supabase JWT.
  parameters:
    GhostId: {name: id, in: path, required: true, schema: {type: string, format: uuid}}
    UploadId: {name: upload_id, in: path, required: true, schema: {type: string, format: uuid}}
  schemas:
    ErrorEnvelope:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, retryable]
          properties:
            code: {type: string, description: "Stable code; see the error table"}
            message: {type: string}
            retryable: {type: boolean}
            detail: {type: string}
            retry_after_s: {type: integer}
            interval: {type: integer}
            parameter: {type: string}
            ghost_id: {type: string, format: uuid}
            reason: {type: string, enum: [refresh_token_reuse, refresh_token_expired]}
            expected_sha256: {type: string}
            received_sha256: {type: string}
            expected_byte_length: {type: integer}
          additionalProperties: true
    Route:
      type: object
      properties:
        key: {type: string, example: "02.2.ff.00.-1"}
        area: {type: integer, minimum: 0, maximum: 60}
        episode: {type: integer, minimum: 0, maximum: 9}
        parent_area: {type: integer, description: "255 = none"}
        flags: {type: integer, description: "bit0 internal scene, bit1 parent start"}
        variant: {type: integer, description: "-1 = none, else 0..255"}
        segment_count: {type: integer}
        portable_across_regions: {type: boolean}
    GhostEntry:
      type: object
      required: [id, file, format, game, profile, route, timing, eligibility]
      properties:
        id: {type: string, format: uuid}
        title: {type: string}
        description: {type: [string, "null"]}
        uploaded_at: {type: string, format: date-time}
        updated_at: {type: string, format: date-time}
        page_url: {type: string, format: uri}
        author:
          type: object
          properties:
            id: {type: string, format: uuid}
            username: {type: string}
            display_name: {type: [string, "null"]}
        file:
          type: object
          properties:
            path: {type: string}
            filename: {type: string, description: "Display only; never use as a path"}
            byte_length: {type: integer, maximum: 1297992}
            sha256: {type: string, pattern: "^[0-9a-f]{64}$"}
            crc32: {type: string, pattern: "^[0-9A-F]{8}$"}
            content_type: {type: string, const: application/octet-stream}
            download_url: {type: string, format: uri, description: "Public, unsigned, no expiry, no redirect, Range supported"}
        format:
          type: object
          properties:
            magic: {type: string, const: SGHF}
            version: {type: integer, minimum: 3, maximum: 9}
            required_features: {type: integer}
            features: {type: array, items: {type: string, enum: [extended_codec, teaching, fludd, visual_v7, camera, initial_rng]}}
            validator: {type: string}
            validated_at: {type: string, format: date-time}
        game:
          type: object
          properties:
            game_id: {type: string, enum: [GMSJ, GMSE, GMSP]}
            region: {type: string, enum: [jp, us, pal]}
            disc_revision: {type: integer, const: 0}
        profile:
          type: object
          properties:
            source_profile: {type: integer, enum: [0, 1, 2, 3, 5]}
            name: {type: string, description: "File display text"}
        route: {$ref: "#/components/schemas/Route"}
        timing:
          type: object
          properties:
            unit: {type: string, const: qf}
            result_qf: {type: [integer, "null"]}
            start_qf: {type: integer}
            end_qf: {type: integer}
            duration_qf: {type: integer}
            export_duration_ms: {type: integer, description: "floor(duration_qf*1001/120), Moonshine's export-filename rule"}
        recording:
          type: object
          properties:
            sample_count: {type: integer}
            input_count: {type: integer}
            split_count: {type: integer}
            camera_sample_count: {type: [integer, "null"]}
            initial_rng:
              oneOf:
                - type: "null"
                - type: object
                  properties:
                    seed: {type: integer, minimum: 0, maximum: 4294967295}
                    provenance: {type: string, const: first_recorded_pose}
            header_ghost_id: {type: string, pattern: "^[0-9a-f]{16}$"}
            created_unix: {type: [integer, "null"], description: "u64 from the header; 0 is reported as null"}
        header_text:
          type: object
          properties:
            name: {type: string}
            author: {type: string}
        eligibility:
          type: object
          properties:
            run_flags: {type: integer}
            flags:
              type: object
              properties:
                assisted: {type: boolean}
                savestate_used: {type: boolean}
                fast_forward_used: {type: boolean}
                incomplete: {type: boolean}
                custom_route: {type: boolean}
                tas: {type: boolean}
            unknown_flag_bits: {type: integer}
            uploader_tas: {type: [boolean, "null"], description: "true or null, never false"}
            assistance: {type: string, enum: [tas, assisted, unknown]}
        site:
          type: object
          description: Website display data. Never use for identity or comparison.
          properties:
            level: {type: [string, "null"]}
            time_ms: {type: [integer, "null"]}
            download_count: {type: integer}
    NotOffered:
      type: object
      properties:
        compatible: {type: boolean, const: false}
        id: {type: string, format: uuid}
        status: {type: string, enum: [not_indexed, invalid, unsupported, too_large]}
        status_code: {type: [string, "null"]}
        detail: {type: [string, "null"]}
    Upload:
      type: object
      properties:
        upload_id: {type: string, format: uuid}
        status: {type: string, enum: [awaiting_content, validated, published, rejected, expired, cancelled]}
        byte_length: {type: integer}
        sha256: {type: string}
        ghost_id: {type: [string, "null"], format: uuid}
        created_at: {type: string, format: date-time}
        expires_at: {type: string, format: date-time}
        validation: {type: [object, "null"]}
        error:
          oneOf:
            - type: "null"
            - type: object
              properties: {code: {type: string}, detail: {type: [string, "null"]}}
        content_url: {type: string, format: uri}
        publish_url: {type: string, format: uri}
    TokenResponse:
      type: object
      properties:
        token_type: {type: string, const: Bearer}
        access_token: {type: string, pattern: "^dga_"}
        expires_in: {type: integer}
        refresh_token: {type: string, pattern: "^dgr_"}
        refresh_expires_in: {type: integer}
        link_id: {type: string, format: uuid}
        scope: {type: string, const: uploads}
        user:
          type: object
          properties: {id: {type: string, format: uuid}, username: {type: string}, display_name: {type: [string, "null"]}}
  responses:
    Error:
      description: Error
      content: {application/json: {schema: {$ref: "#/components/schemas/ErrorEnvelope"}}}
paths:
  /v1/capabilities:
    get:
      summary: API version, formats, limits and auth requirements
      responses: {"200": {description: Capabilities}}
  /v1/ghosts:
    get:
      summary: List compatible ghosts (keyset pagination)
      parameters:
        - {name: route_key, in: query, schema: {type: string, pattern: "^[0-9a-f]{2}\\.\\d\\.[0-9a-f]{2}\\.[0-9a-f]{2}\\.-?\\d{1,3}$"}}
        - {name: area, in: query, schema: {type: integer}}
        - {name: episode, in: query, schema: {type: integer}}
        - {name: region, in: query, schema: {type: string, enum: [jp, us, pal]}}
        - {name: playable_on, in: query, schema: {type: string, enum: [jp, us, pal]}}
        - {name: source_profile, in: query, schema: {type: integer}}
        - {name: assistance, in: query, schema: {type: string, enum: [tas, assisted, unknown]}}
        - {name: format_version, in: query, schema: {type: integer}}
        - {name: author, in: query, schema: {type: string}}
        - {name: sha256, in: query, schema: {type: string}}
        - {name: sort, in: query, schema: {type: string, enum: [newest, oldest, result_qf], default: newest}}
        - {name: limit, in: query, schema: {type: integer, minimum: 1, maximum: 50, default: 20}}
        - {name: cursor, in: query, schema: {type: string}}
      responses:
        "200":
          description: A page
          content:
            application/json:
              schema:
                type: object
                properties:
                  api_version: {type: integer}
                  catalogue_schema: {type: integer}
                  items: {type: array, items: {$ref: "#/components/schemas/GhostEntry"}}
                  next_cursor: {type: [string, "null"]}
                  total: {type: integer}
                  limit: {type: integer}
                  sort: {type: string}
        "400": {$ref: "#/components/responses/Error"}
  /v1/ghosts/{id}:
    get:
      parameters: [{$ref: "#/components/parameters/GhostId"}]
      responses:
        "200":
          description: Entry, or why it is not offered
          content:
            application/json:
              schema:
                type: object
                properties:
                  ghost: {oneOf: [{$ref: "#/components/schemas/GhostEntry"}, {$ref: "#/components/schemas/NotOffered"}]}
        "404": {$ref: "#/components/responses/Error"}
  /v1/ghosts/{id}/file:
    get:
      parameters: [{$ref: "#/components/parameters/GhostId"}]
      responses:
        "302": {description: "Location: download_url"}
        "404": {$ref: "#/components/responses/Error"}
  /v1/ghosts/{id}/index:
    post:
      summary: Validate a ghost's stored bytes (website/backfill use)
      parameters:
        - {$ref: "#/components/parameters/GhostId"}
        - {name: force, in: query, schema: {type: string, enum: ["1"]}}
      responses:
        "200": {description: "{ghost_id, status, compatible, code, detail, reindexed}"}
        "404": {$ref: "#/components/responses/Error"}
        "429": {$ref: "#/components/responses/Error"}
  /v1/device/code:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                client_name: {type: string, maxLength: 48}
                client_version: {type: string, maxLength: 32}
      responses:
        "200":
          description: Codes
          content:
            application/json:
              schema:
                type: object
                properties:
                  device_code: {type: string}
                  user_code: {type: string, pattern: "^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$"}
                  verification_uri: {type: string, format: uri}
                  verification_uri_complete: {type: string, format: uri}
                  expires_in: {type: integer}
                  interval: {type: integer}
        "429": {$ref: "#/components/responses/Error"}
  /v1/device/token:
    post:
      requestBody:
        required: true
        content: {application/json: {schema: {type: object, required: [device_code], properties: {device_code: {type: string}}}}}
      responses:
        "200": {description: Tokens, content: {application/json: {schema: {$ref: "#/components/schemas/TokenResponse"}}}}
        "400": {description: "authorization_pending | slow_down | expired_token | access_denied | invalid_grant", content: {application/json: {schema: {$ref: "#/components/schemas/ErrorEnvelope"}}}}
  /v1/device/refresh:
    post:
      requestBody:
        required: true
        content: {application/json: {schema: {type: object, required: [refresh_token], properties: {refresh_token: {type: string}}}}}
      responses:
        "200": {description: Rotated tokens, content: {application/json: {schema: {$ref: "#/components/schemas/TokenResponse"}}}}
        "400": {$ref: "#/components/responses/Error"}
  /v1/device/revoke:
    post:
      requestBody:
        content: {application/json: {schema: {type: object, properties: {token: {type: string}}}}}
      responses:
        "200": {description: "{revoked: boolean}"}
  /v1/me:
    get:
      security: [{deviceToken: []}]
      responses:
        "200": {description: "{link_id, user}"}
        "401": {$ref: "#/components/responses/Error"}
  /v1/uploads:
    post:
      security: [{deviceToken: []}]
      parameters:
        - {name: Idempotency-Key, in: header, schema: {type: string, pattern: "^[A-Za-z0-9_.:-]{1,64}$"}}
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [byte_length, sha256]
              properties:
                byte_length: {type: integer, minimum: 1, maximum: 1297992}
                sha256: {type: string, pattern: "^[0-9a-fA-F]{64}$"}
                filename: {type: string, maxLength: 200}
                title: {type: string, maxLength: 100}
                description: {type: string, maxLength: 2000}
                tas_declared: {type: [boolean, "null"]}
      responses:
        "201": {description: "created: {result, upload}"}
        "200": {description: "existing: {result, upload} | already_published: {result, ghost}"}
        "400": {$ref: "#/components/responses/Error"}
        "401": {$ref: "#/components/responses/Error"}
        "409": {$ref: "#/components/responses/Error"}
        "413": {$ref: "#/components/responses/Error"}
        "429": {$ref: "#/components/responses/Error"}
  /v1/uploads/{upload_id}:
    get:
      security: [{deviceToken: []}]
      parameters: [{$ref: "#/components/parameters/UploadId"}]
      responses: {"200": {description: "{result, upload, ghost?}"}, "404": {$ref: "#/components/responses/Error"}}
    delete:
      security: [{deviceToken: []}]
      parameters: [{$ref: "#/components/parameters/UploadId"}]
      responses: {"200": {description: "{result: cancelled, upload}"}, "404": {$ref: "#/components/responses/Error"}}
  /v1/uploads/{upload_id}/content:
    put:
      security: [{deviceToken: []}]
      parameters: [{$ref: "#/components/parameters/UploadId"}]
      requestBody:
        required: true
        content: {application/octet-stream: {schema: {type: string, format: binary}}}
      responses:
        "200": {description: "validated: {result, upload}"}
        "409": {$ref: "#/components/responses/Error"}
        "410": {$ref: "#/components/responses/Error"}
        "413": {$ref: "#/components/responses/Error"}
        "422": {$ref: "#/components/responses/Error"}
        "429": {$ref: "#/components/responses/Error"}
    post:
      description: Same as PUT, for clients without PUT
      security: [{deviceToken: []}]
      parameters: [{$ref: "#/components/parameters/UploadId"}]
      requestBody:
        required: true
        content: {application/octet-stream: {schema: {type: string, format: binary}}}
      responses: {"200": {description: Same as PUT}}
  /v1/uploads/{upload_id}/publish:
    post:
      security: [{deviceToken: []}]
      parameters: [{$ref: "#/components/parameters/UploadId"}]
      responses:
        "201": {description: "published: {result, ghost: GhostEntry}"}
        "200": {description: "already_published: {result, ghost: GhostEntry}"}
        "409": {$ref: "#/components/responses/Error"}
        "410": {$ref: "#/components/responses/Error"}
        "503": {$ref: "#/components/responses/Error"}
```

---

## 12. Server side: what was built and how to deploy it

### 12.1 Files (repository `Zeldocto/delfino-ghosts`)

| Path | What |
| --- | --- |
| `supabase/migrations/0012_moonshine_api.sql` | Everything in the database (below). One file; safe on the live DB; changes no existing rows |
| `supabase/functions/moonshine-api/app.ts` | HTTP API (routing, auth, uploads, catalogue). Runtime-agnostic |
| `supabase/functions/moonshine-api/index.ts` | Deno entry: wires Supabase RPC and Storage with the service-role key, which stays server-side |
| `supabase/functions/_shared/ghost_format.ts` | Strict TypeScript port of `validate_ghost.py` plus the 1,297,992-byte ceiling |
| `supabase/scripts/moonshine_backfill.mjs` | One-off: validate the existing archive (public endpoints only) |
| `supabase/tests/moonshine/*` | Tests (§12.5), fixture generator, Python oracle runner, PGlite harness |
| `supabase/tests/standin_0007_0011.sql` | **Test-only** reconstruction of the two live-but-uncommitted migrations |
| `src/pages/LinkDevice.tsx`, `src/components/LinkedDevices.tsx`, `src/lib/moonshine.ts` | Website: `/link` approval page; Settings → Linked devices |
| `src/lib/ghosts.ts`, `src/lib/ghost/*`, `src/components/ProtectedRoute.tsx`, `src/App.tsx`, `src/pages/Settings.tsx` | Website: trigger validation after upload; replace files via a new object; sign-in keeps `?code=`; parser fixed to the real spec |

### 12.2 Database (migration 0012)

- **Tables.** RLS is on for every table. Clients never get the hashes or the raw rows.
  - `ghost_moonshine_index`: the validation verdict for a ghost's *exact stored object* (path,
    size, sha256, and every field the catalogue filters on). Public select; written only by the
    function.
  - `moonshine_device_links`: device codes and tokens, stored as SHA-256 hashes only. No client
    grants at all.
  - `moonshine_uploads`: upload sessions. No client grants.
  - `moonshine_rate_limits`: fixed-window counters. No client grants.
- **View** `moonshine_catalogue` (`security_invoker`): compatible ghosts only, joined on
  path + size + status, so a stale verdict can never be served.
- **Functions:**
  - Public: `moonshine_list_ghosts`, `moonshine_get_ghost`, `moonshine_config`.
  - Website, signed-in only: `moonshine_link_lookup`, `moonshine_link_decide`,
    `moonshine_my_device_links`, `moonshine_revoke_device_link`.
  - `service_role` only (the Edge Function): device start/poll/refresh/revoke/authenticate, upload
    create/get/content/publish/cancel/sweep, index candidate/put, rate limiting. Each is
    `SECURITY DEFINER` with `search_path = ''`, and is revoked from `public`, `anon` and
    `authenticated`. Tests check that website users and guests get `permission denied`.
- **Triggers:**
  - Changing a ghost's `file_path`/`file_size` deletes its verdict.
  - An account deletion (0008) revokes its device links and cancels its open uploads.
  - The archive's existing ownership trigger, 200-ghost-limit trigger and counter triggers apply
    unchanged to API publishes. The function inserts with an explicit owner; `auth.uid()` is null
    for the service role, so the trigger keeps it.
- **Storage:**
  - New private bucket `ghost-uploads`: 1,297,992-byte limit, `application/octet-stream` only, and no
    client policies.
  - The `ghosts` bucket's owner **update** and **delete** policies now refuse objects that have a
    validation verdict. Overwriting in place would make the recorded sha256 false. The website now
    replaces a file by uploading a new object and pointing the row at it, which clears the verdict
    and triggers re-validation.
  - Read access and all other existing policies are unchanged.

### 12.3 Required server-side configuration

| Item | Value |
| --- | --- |
| Function JWT verification | **Off** (`--no-verify-jwt`). Moonshine uses the API's own device tokens |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Injected automatically by Supabase into the function. Never put them anywhere else |
| `MOONSHINE_SITE_URL` (optional secret) | Defaults to `https://zeldocto.github.io/delfino-ghosts` |
| `MOONSHINE_RATE_SALT` (optional secret) | Random string for rate-limit key hashing. Defaults to a value derived from the service key |
| Auth URL configuration | Unchanged. `/link` is a normal SPA route; sign-in returns to `/link?code=…` |

### 12.4 Deployment steps (site owner)

1. **Check what's live first** (Supabase → SQL Editor):
   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets;
   select proname, pg_get_function_identity_arguments(oid) from pg_proc
    where proname in ('list_ghosts', 'levels_in_use', 'is_active_account');
   ```
   Expect `ghosts | true | 10485760`, `list_ghosts(… p_tas boolean)` and `is_active_account()`.
2. **Run** `supabase/migrations/0012_moonshine_api.sql` in the SQL Editor (or `supabase db push`).
3. **Deploy the function** (Supabase CLI, logged in to the project):
   ```sh
   supabase link --project-ref cvadewafbthfhvzgdgay
   supabase functions deploy moonshine-api --no-verify-jwt
   supabase secrets set MOONSHINE_RATE_SALT="$(openssl rand -hex 32)"   # optional
   ```
4. **Smoke test:** `curl -s https://cvadewafbthfhvzgdgay.supabase.co/functions/v1/moonshine-api/v1/capabilities`
   should return `api_version: 1`. Also confirm the function answers **without** an `apikey` header.
5. **Backfill** existing ghosts:
   ```sh
   node supabase/scripts/moonshine_backfill.mjs https://cvadewafbthfhvzgdgay.supabase.co sb_publishable_mrh55bmXKXF_paQ7WTb3lA_oeJHWILU
   ```
   Expected result: all 121 `compatible` (matching the local reference run).
6. **Push the website** to `main` (the GitHub Action deploys Pages). Then sign in, open `/link`, and
   link a test device with the curl commands in §5.5.
7. **End-to-end check with curl:** device code → approve on `/link` → token → upload a known-good
   ghost → confirm it appears in `/v1/ghosts` and on the website, and that the download's sha256
   matches.

### 12.5 Tests

```sh
npm ci
npm run test:moonshine                         # 19 tests; parity test skipped without the oracle
MOONSHINE_VALIDATOR=../scripts/validate_ghost.py npm run test:moonshine   # + parity vs Moonshine's Python
npm run typecheck:moonshine && npm run build   # function/test typecheck, website build
```
They run entirely locally: PostgreSQL in-process (PGlite) with the Supabase stand-ins and all
migrations, an in-memory object store, and the real request handler. Nothing touches the live
project. Coverage:

- **Files:** corrupt (CRC flips), truncated, oversized, V1/V2/V10, unknown feature bits, bad
  checksum kind, and 3,121-input parity with `validate_ghost.py` including the live corpus.
- **Unauthorized writes:**
  - No token, a fake token, or a Supabase JWT → 401.
  - Website users and guests can't read the link, upload or rate-limit tables, can't write
    verdicts, and can't execute service-role functions.
  - Cross-account access to an upload → 404.
  - A forged `user_id` is ignored.
  - In-place overwrite or delete of a validated object is refused.
- **Linking:** pending, `slow_down`, approve/deny, expired code, single-use code with the
  lost-response grace, refresh rotation, reuse detection, expired access/refresh tokens, unlink
  from the website and from the device, account deletion, the 10-device cap, and the start rate
  limit.
- **Pagination:** a stable cursor across concurrent inserts, every filter, and bad-parameter
  rejection.
- **Uploads:**
  - Every retry path produces no duplicates (idempotency key, re-create, re-PUT, re-publish, a
    storage outage mid-publish, starting over after publish).
  - Cross-account duplicates are refused.
  - A website-then-API duplicate resolves to the existing ghost.
  - Expiry, sweeping of staged objects, cancel, the open-session cap, and the 200-ghost limit with
    no orphaned object.
  - Exact byte preservation.
- **Existing site:** the original `security_checks.sql` suite was also run against all migrations
  plus 0012. Every check gives its expected result.

Not tested: the Deno entry file (`index.ts`) against real Supabase, because it isn't deployed.
It is a thin adapter (RPC + Storage calls) and typechecks. The website's new `/link` page and
Settings section were rendered in jsdom with the data layer stubbed. That covered code
normalisation from `?code=`, approval and unlinking, but not a real browser against the live
project.

---

## 13. Open questions for Moonshine

We didn't invent answers to these. The current behaviour is stated for each, so you can tell us if
it's wrong.

1. **Split limit discrepancy.** `validate_ghost.py` allows 8 splits (`V5_MAX_SPLIT_COUNT = 8`,
   computed V5 maximum 1,298,016 bytes). `ghost_format.md` says "Split count, 0–6" and a V5 maximum
   of 1,297,992, matching the prompt. *Current behaviour:* structure follows the validator (7–8 splits
   accepted); size is capped at 1,297,992. Which is authoritative? Changing either is a one-constant
   change on our side.
2. **Run time and PAL timing.** Which value is the official time of a run: `resultQf`,
   `resultQf − startQf`, or `durationQf`? Does `floor(qf × 1001 / 120)` apply to PAL recordings, or
   only to the export-filename rule for every region? On every live ghost `startQf = 0` and
   `resultQf = durationQf` (or no result), so the data doesn't settle it. *Current behaviour:* raw QF
   values plus `export_duration_ms` from `duration_qf` only, and no `result_ms`.
3. **Profile mapping.** What do `sourceProfile` 0–3 and 5 mean as categories, and is `profileName`
   player-editable? Live files show 0 = "Any percent" and 2 = "Custom 1". *Current behaviour:* filter
   by number, show the file's text, no mapping.
4. **IL identity.** Is the header (segment-0) route tuple the right key for "same IL"? Or should the
   final segment's route, or the split `schema`/`route` id, be part of it? Do you want the server to
   publish a canonical route-id → name table, and if so can you supply it? *Current behaviour:*
   `route_key` = header tuple; names are the website's free text.
5. **Run-flag semantics.**
   - Is `RUN_ASSISTED` always set when `SAVESTATE_USED` or `FAST_FORWARD_USED` are?
   - Were the flags reliably written in V3–V8, or can older files have `0` meaning "not tracked"?
   - Should `INCOMPLETE` or `CUSTOM_ROUTE` ghosts be hidden from the in-game browser by default?

   *Current behaviour:* any of assisted/savestate/fast-forward → `assisted`; the TAS bit → `tas`;
   otherwise `unknown`; nothing hidden.
6. **Cross-account duplicates.** We refuse identical bytes from a second account (`409
   duplicate_content`). Is that what you want (e.g. for shared or re-uploaded ghosts)?
7. **Files referenced but not supplied:** `timewarp-ghost-v7.md`, `timewarp-ghost-camera-v8.md`,
   `ghost_teaching.h`, `ghost_storage.h`, `scripts/test_ghost_format.py`. The server enforces exactly
   what `validate_ghost.py` enforces. If those documents add rules the Python validator doesn't
   check, we don't enforce them yet. Please send them, or confirm the validator is complete.
8. **Old versions.** Should V3/V4 (no inputs/splits) and V5–V7 ghosts be offered as downloads, or only
   newer ones? *Current behaviour:* all of V3–V9 are listed; filter with `format_version`.
9. **Download counting.** Should in-game downloads count toward the website's download totals and
   its "Most Downloaded Player" designation? *Current behaviour:* they don't (the API is kept
   independent of rankings). It could be added as an authenticated "downloaded" call later.
10. **Native Wii TLS** (§10): will Moonshine ship a TLS 1.2 + ECDHE + AES-GCM client with SNI and the
    GTS/GlobalSign roots, or do you need a relay? A relay would be new infrastructure on our side.
11. **Device naming/QR.** Is `client_name` "Moonshine Wii" / "Moonshine (Dolphin)" fine? Will the game
    show a QR code of `verification_uri_complete`? (We'd then keep that URL short and stable.)
12. **Upload metadata.** Do you want to send a `title`/`description`, or always use the header name?
    Should the website's TAS box be driven only by the file's flags rather than by the `TAS` name
    prefix, as browser uploads currently do?

---

## 14. Still needed from us (Delfino Ghosts)

1. **Deploy** (§12.4): run migration 0012, deploy `moonshine-api` with `--no-verify-jwt`, run the
   backfill, push the website. Until then every API URL here is a placeholder.
2. **Confirm the deployed Storage limits** with the SQL in §12.4 step 1. The public key can't read
   bucket metadata, so the live `ghosts` limit (10 MiB per the repo) is unverified.
3. **Commit the original 0007 and 0011 migration files.** They are applied on the live project and
   listed in the README, but missing from git. The test suite uses a clearly marked reconstruction
   (`supabase/tests/standin_0007_0011.sql`), which must never be run on a real project.
4. **Licence (decided).** `supabase/functions/_shared/ghost_format.ts` is a close port of Moonshine's
   GPL-3.0 `validate_ghost.py`, so that file alone is GPL-3.0-or-later (notice at its top). The rest
   of the repository is unaffected. Let the Moonshine developer know, in case they want different
   terms.
5. **Privacy page.** It should mention the new data: linked device names and last-used times, and
   hashed (never raw) IP-based rate-limit keys kept for about a day. `src/pages/Privacy.tsx` has not
   been updated.
6. **Real SMTP** (an existing known gap): device approval needs a website account, and Supabase's
   built-in mail is rate-limited.
7. After deploy: confirm the function is reachable without any `apikey` header (§12.4 step 4), and
   tell the Moonshine developer the API is live.
