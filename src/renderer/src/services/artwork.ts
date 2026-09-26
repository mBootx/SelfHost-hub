import { storage } from '@renderer/services/storage'

/**
 * Artwork fallback for tracks whose Navidrome entry has no cover. MusicBrainz
 * resolves artist+album to a release group id, then the Cover Art Archive serves
 * the image - both open data, no API key. MusicBrainz requires a descriptive
 * User-Agent and rate limits to one request a second, which is fine for a
 * button the user presses.
 *
 * Subsonic has no API for writing cover art back, so a hit is stored as a local
 * override on this machine only.
 */
const MUSICBRAINZ = 'https://musicbrainz.org/ws/2'
const COVER_ART_ARCHIVE = 'https://coverartarchive.org'
const HEADERS = { 'User-Agent': 'SelfHostHub/1.0.0 (self-hosted music client)' }

const OVERRIDES_KEY = 'artwork.overrides'

type Overrides = Record<string, string>

let cache: Overrides | null = null

async function readOverrides(): Promise<Overrides> {
  if (!cache) cache = (await storage.loadPref<Overrides>(OVERRIDES_KEY)) || {}
  return cache
}

export async function loadArtworkOverrides(): Promise<Overrides> {
  return readOverrides()
}

async function saveOverride(key: string, url: string): Promise<void> {
  const overrides = await readOverrides()
  overrides[key] = url
  cache = overrides
  await storage.savePref(OVERRIDES_KEY, overrides)
}

function escapeLucene(value: string): string {
  return value.replace(/(["\\+\-!(){}\[\]^~*?:/]|&&|\|\|)/g, '\\$1')
}

/**
 * Resolves cover art for an album. Returns the Cover Art Archive URL on success.
 * `key` is whatever id the caller wants the override filed under (album or song).
 */
export async function findArtwork(key: string, artist: string, album: string): Promise<string | null> {
  const overrides = await readOverrides()
  if (overrides[key]) return overrides[key]
  if (!artist || !album) return null

  const query = `artist:"${escapeLucene(artist)}" AND releasegroup:"${escapeLucene(album)}"`

  let groups: { id: string }[]
  try {
    const res = await window.api.net.request({
      url: `${MUSICBRAINZ}/release-group/`,
      method: 'GET',
      headers: HEADERS,
      params: { query, fmt: 'json', limit: 3 }
    })
    if (!res.ok || !res.data) return null
    groups = (res.data as { 'release-groups'?: { id: string }[] })['release-groups'] || []
  } catch {
    return null
  }

  // The archive 404s for plenty of valid release groups, so walk the top matches
  // until one actually has a front cover.
  for (const group of groups) {
    const url = `${COVER_ART_ARCHIVE}/release-group/${group.id}/front-500`
    try {
      const res = await window.api.net.request({ url, method: 'HEAD', timeout: 8000 })
      if (res.ok) {
        await saveOverride(key, url)
        return url
      }
    } catch {
      // try the next candidate
    }
  }

  return null
}
