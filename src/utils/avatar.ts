/**
 * Avatars are hotlinked from wherever the user hosts them, so the field needs
 * a *direct image* URL — one that ends at the image file itself, not the page
 * the host wraps around it. That distinction trips people up constantly, so we
 * fix the cases we can recognise and warn about the ones we cannot.
 */

/** Rewrites known page URLs to their direct-image equivalent. */
export function normalizeAvatarUrl(input: string): string {
  const raw = input.trim()
  if (!raw) return ''

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }

  const host = url.hostname.replace(/^www\./, '')

  // imgur.com/cgb6Xai.jpg is the viewer page; i.imgur.com/cgb6Xai.jpg is the file.
  if (host === 'imgur.com') {
    const match = /^\/([A-Za-z0-9]{5,12})(\.(?:jpg|jpeg|png|gif|webp))?$/.exec(url.pathname)
    if (match) {
      const extension = match[2] ?? '.jpg'
      return `https://i.imgur.com/${match[1]}${extension}`
    }
  }

  return raw
}

const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|avif|svg)$/i

/**
 * Returns a warning when the URL is unlikely to load as an image. Advisory
 * only — plenty of legitimate CDNs serve images from extensionless paths, so
 * this never blocks a save.
 */
export function describeAvatarUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'That does not look like a web address.'
  }

  if (url.protocol !== 'https:') return 'Avatar links must start with https://'

  const host = url.hostname.replace(/^www\./, '')

  if (host === 'x.com' || host === 'twitter.com') {
    return 'X links point at a post, not an image file. Open the image itself and copy that address.'
  }
  if (host === 'imgur.com') {
    return 'That is an Imgur page. Right-click the image, copy the image address, and use the i.imgur.com link.'
  }
  if (host === 'ibb.co') {
    return 'That is an ImgBB page. Use the "Direct link" ImgBB offers — it starts with i.ibb.co.'
  }
  if (host === 'drive.google.com' || host === 'dropbox.com') {
    return 'Cloud storage links usually serve a viewer page rather than the image itself.'
  }
  if (!IMAGE_EXTENSION.test(url.pathname)) {
    return 'That address does not end in an image file. It may still work — the preview will tell you.'
  }

  return null
}
