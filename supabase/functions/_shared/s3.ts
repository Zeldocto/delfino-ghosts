/**
 * Minimal client for the S3-compatible bucket that holds archive ghosts.
 *
 * Written against the plain S3 REST API (path-style URLs, SigV4 via aws4fetch)
 * so Cloudflare R2, Backblaze B2 or Tebi can be swapped in by changing the
 * S3_* secrets only. Runs in Deno (Edge Functions) and Node (tests, scripts).
 *
 * Secrets stay server-side. The browser only ever sees a presigned URL, which
 * is bound to one key, one exact size, one content type, and expires.
 */
// Type-only, so Node's type stripping never has to resolve the npm: specifier.
// Callers pass the class in: index.ts imports it from npm:, Node from 'aws4fetch'.
import type { AwsClient } from 'npm:aws4fetch@1.0.20'

export type AwsClientClass = typeof AwsClient

export interface S3Config {
  /** e.g. https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string
  bucket: string
  /** `auto` for R2; the provider's region name elsewhere. */
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Public, unsigned base for downloads, e.g. https://ghosts.example.org */
  publicBaseUrl: string
}

export function s3ConfigFromEnv(get: (name: string) => string | undefined): S3Config {
  const need = (name: string) => {
    const value = get(name)
    if (!value) throw new Error(`missing secret ${name}`)
    return value
  }
  return {
    endpoint: need('S3_ENDPOINT').replace(/\/+$/, ''),
    bucket: need('S3_BUCKET'),
    region: get('S3_REGION') || 'auto',
    accessKeyId: need('S3_ACCESS_KEY_ID'),
    secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
    publicBaseUrl: need('GHOSTS_PUBLIC_BASE_URL').replace(/\/+$/, ''),
  }
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/** Public, unsigned, non-expiring download URL for an archive object. */
export function publicObjectUrl(publicBaseUrl: string, key: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/${encodeKey(key)}`
}

export class S3Error extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'S3Error'
    this.status = status
  }
}

export interface PresignedPut {
  url: string
  method: 'PUT'
  /** Headers the uploader must send exactly; all of them are signed. */
  headers: Record<string, string>
  expires_in: number
}

export interface S3Store {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  /** Object size in bytes, or null when the key does not exist. */
  head(key: string): Promise<number | null>
  /** Deleting a missing key is not an error. */
  remove(key: string): Promise<void>
  presignPut(key: string, byteLength: number, expiresInS: number): Promise<PresignedPut>
}

export function createS3(config: S3Config, Client: AwsClientClass, fetchImpl: typeof fetch = fetch): S3Store {
  // Signing and sending separately (rather than aws4fetch's own fetch(), which
  // retries up to 10 times) keeps failures fast and lets tests substitute fetchImpl.
  const aws = new Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
  })
  const objectUrl = (key: string) => `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodeKey(key)}`

  async function send(method: string, key: string, init: RequestInit = {}): Promise<Response> {
    const signed = await aws.sign(objectUrl(key), { method, ...init })
    return fetchImpl(signed)
  }

  async function failure(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '')
    throw new S3Error(`${what} failed: ${res.status} ${text.slice(0, 200)}`, res.status)
  }

  return {
    async put(key, bytes) {
      const res = await send('PUT', key, {
        body: bytes as BodyInit,
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=3600' },
      })
      if (!res.ok) await failure(res, `PUT ${key}`)
      await res.body?.cancel()
    },

    async get(key) {
      const res = await send('GET', key)
      if (res.status === 404) {
        await res.body?.cancel()
        return null
      }
      if (!res.ok) await failure(res, `GET ${key}`)
      return new Uint8Array(await res.arrayBuffer())
    },

    async head(key) {
      const res = await send('HEAD', key)
      await res.body?.cancel()
      if (res.status === 404) return null
      if (!res.ok) throw new S3Error(`HEAD ${key} failed: ${res.status}`, res.status)
      return Number(res.headers.get('content-length') ?? '0')
    },

    async remove(key) {
      const res = await send('DELETE', key)
      if (!res.ok && res.status !== 404) await failure(res, `DELETE ${key}`)
      await res.body?.cancel()
    },

    async presignPut(key, byteLength, expiresInS) {
      const headers = {
        'content-length': String(byteLength),
        'content-type': 'application/octet-stream',
        // Refuse to replace an existing object: the same guarantee as
        // upsert: false on Supabase Storage. Validated ghosts are immutable.
        'if-none-match': '*',
      }
      const url = new URL(objectUrl(key))
      // aws4fetch defaults to 24 hours when this is absent.
      url.searchParams.set('X-Amz-Expires', String(expiresInS))
      const signed = await aws.sign(url.toString(), {
        method: 'PUT',
        headers,
        // allHeaders: aws4fetch otherwise leaves content-length and
        // content-type out of the signature, and the size would be unbound.
        aws: { signQuery: true, allHeaders: true },
      })
      // content-length is set by the browser from the body; the rest the
      // uploader sends explicitly.
      return {
        url: signed.url,
        method: 'PUT',
        headers: { 'content-type': headers['content-type'], 'if-none-match': headers['if-none-match'] },
        expires_in: expiresInS,
      }
    },
  }
}
