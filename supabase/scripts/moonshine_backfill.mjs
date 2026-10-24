#!/usr/bin/env node
/**
 * One-off: ask the deployed moonshine-api function to validate every ghost
 * already in the archive, so existing uploads can be offered to Moonshine.
 *
 *   node supabase/scripts/moonshine_backfill.mjs <SUPABASE_URL> <PUBLISHABLE_KEY>
 *
 * Uses only public endpoints: the publishable (anon) key to list ghost ids,
 * and the function's public /index endpoint, which reads the stored bytes
 * itself. No secret key is needed. Safe to re-run; indexed ghosts are skipped.
 * Add --force to re-validate everything (e.g. after a validator update).
 */
const [url, key] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const force = process.argv.includes('--force')
if (!url || !key) {
  console.error('usage: node supabase/scripts/moonshine_backfill.mjs <SUPABASE_URL> <PUBLISHABLE_KEY> [--force]')
  process.exit(1)
}
const base = url.replace(/\/$/, '')

const ids = []
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(`${base}/rest/v1/ghosts?select=id&order=created_at.asc&limit=1000&offset=${offset}`, {
    headers: { apikey: key },
  })
  if (!res.ok) throw new Error(`listing ghosts failed: ${res.status} ${await res.text()}`)
  const page = await res.json()
  ids.push(...page.map((row) => row.id))
  if (page.length < 1000) break
}
console.log(`${ids.length} ghosts`)

const tally = {}
for (const id of ids) {
  // Sequential and gentle: the endpoint allows 300 calls per hour per address.
  const res = await fetch(`${base}/functions/v1/moonshine-api/v1/ghosts/${id}/index${force ? '?force=1' : ''}`, { method: 'POST' })
  const body = await res.json().catch(() => ({}))
  const status = res.ok ? body.status : `error:${body.error?.code ?? res.status}`
  tally[status] = (tally[status] ?? 0) + 1
  if (!res.ok || body.status !== 'compatible') console.log(id, status, body.detail ?? body.error?.detail ?? '')
  if (res.status === 429) {
    console.log(`rate limited; re-run in ${body.error?.retry_after_s ?? 3600} seconds to continue`)
    break
  }
}
console.log(tally)
