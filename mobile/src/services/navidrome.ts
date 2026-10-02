import { md5 } from 'js-md5'
import { fetchWithTimeout } from './http'

export interface NavidromeConfig {
  url: string
  username: string
  password: string
}

export interface NDArtist {
  id: string
  name: string
  albumCount?: number
  coverArt?: string
}

export interface NDAlbum {
  id: string
  name: string
  artist: string
  artistId?: string
  coverArt?: string
  songCount?: number
  duration?: number
  year?: number
}

/** ReplayGain as OpenSubsonic servers report it, in dB. Only there for files that carry the tags. */
export interface ReplayGain {
  trackGain?: number
  albumGain?: number
  trackPeak?: number
  albumPeak?: number
  /** What a client should apply to a file that has no ReplayGain tags of its own. */
  fallbackGain?: number
}

export interface NDSong {
  id: string
  title: string
  artist: string
  artistId?: string
  album?: string
  albumId?: string
  coverArt?: string
  duration: number
  track?: number
  starred?: string
  genre?: string
  replayGain?: ReplayGain
}

export interface NDGenre {
  name: string
  songCount: number
  albumCount: number
}

export interface NDPlaylist {
  id: string
  name: string
  songCount: number
  duration: number
  coverArt?: string
}

/** A song someone is playing right now, on any device, as the server sees it. */
export interface NowPlayingEntry extends NDSong {
  username: string
  minutesAgo: number
  playerName?: string
}

export interface ScanStatus {
  scanning: boolean
  /** Songs in the library. */
  count: number
  folderCount: number
  lastScan: string | null
}

function toScanStatus(raw: any): ScanStatus {
  return {
    scanning: !!raw?.scanning,
    count: raw?.count ?? 0,
    folderCount: raw?.folderCount ?? 0,
    lastScan: raw?.lastScan ?? null
  }
}

const CLIENT_NAME = 'SelfHostHub'
const API_VERSION = '1.16.1'

function randomSalt(): string {
  return Math.random().toString(36).slice(2, 12)
}

/** Every requested cover size maps to one of these, so a cover is downloaded (and cached) at most three times. */
function coverSizeBucket(size: number): number {
  return size <= 160 ? 160 : size <= 320 ? 320 : 640
}

export class ApiError extends Error {
  status: number
  /** Subsonic's own error code when the server answered 200 with a failure in the body (70: not found, 0: unexplained...). */
  code?: number
  constructor(message: string, status: number, code?: number) {
    super(message)
    this.status = status
    this.code = code
  }
}

export class NavidromeClient {
  private baseUrl: string
  private username: string
  private password: string
  private coverArtUrls = new Map<string, string>()
  // Derived from public account info only: a fixed salt keeps cover URLs identical across restarts.
  private coverSalt: string

  constructor(config: NavidromeConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '')
    this.username = config.username
    this.password = config.password
    this.coverSalt = md5(`${this.username}@${this.baseUrl}`).slice(0, 12)
  }

  private authParams(salt = randomSalt()): Record<string, string> {
    const token = md5(this.password + salt)
    return {
      u: this.username,
      t: token,
      s: salt,
      v: API_VERSION,
      c: CLIENT_NAME,
      f: 'json'
    }
  }

  buildMediaUrl(endpoint: 'stream' | 'getCoverArt' | 'download', params: Record<string, string>, salt?: string): string {
    const search = new URLSearchParams({ ...this.authParams(salt), ...params })
    return `${this.baseUrl}/rest/${endpoint}.view?${search.toString()}`
  }

  private async call<T>(method: string, params: Record<string, string | string[]> = {}): Promise<T> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...this.authParams(), ...params })) {
      if (Array.isArray(value)) value.forEach((v) => search.append(key, v))
      else search.append(key, value)
    }
    const url = `${this.baseUrl}/rest/${method}.view?${search.toString()}`
    let res: Response
    try {
      res = await fetchWithTimeout(url)
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : 'Serveur injoignable', 0)
    }
    if (!res.ok) throw new ApiError(`Requête échouée (${res.status})`, res.status)
    const json = await res.json().catch(() => null)
    const body = json?.['subsonic-response']
    if (!body) throw new ApiError('Réponse Navidrome invalide', res.status)
    if (body.status === 'failed') {
      const code = body.error?.code
      throw new ApiError(body.error?.message || 'Erreur Navidrome', code === 40 ? 401 : 500, typeof code === 'number' ? code : 0)
    }
    return body as T
  }

  async testConnection(): Promise<void> {
    await this.call('ping')
  }

  async getArtists(): Promise<NDArtist[]> {
    const body = await this.call<any>('getArtists')
    const index = body.artists?.index || []
    const artists: NDArtist[] = []
    for (const group of index) {
      for (const a of group.artist || []) {
        artists.push({ id: a.id, name: a.name, albumCount: a.albumCount, coverArt: a.coverArt })
      }
    }
    return artists
  }

  async getArtist(id: string): Promise<{ artist: NDArtist; albums: NDAlbum[] }> {
    const body = await this.call<any>('getArtist', { id })
    return { artist: body.artist, albums: body.artist?.album || [] }
  }

  async getAlbum(id: string): Promise<{ album: NDAlbum; songs: NDSong[] }> {
    const body = await this.call<any>('getAlbum', { id })
    return { album: body.album, songs: body.album?.song || [] }
  }

  async getAlbumList(type: 'newest' | 'recent' | 'frequent' | 'random' = 'newest', size = 40): Promise<NDAlbum[]> {
    const body = await this.call<any>('getAlbumList2', { type, size: String(size) })
    return body.albumList2?.album || []
  }

  /** Songs like this one, as the server works them out (Last.fm or its own tags). Often empty on a small library. */
  async getSimilarSongs(id: string, count = 40): Promise<NDSong[]> {
    const body = await this.call<any>('getSimilarSongs', { id, count: String(count) })
    return body.similarSongs?.song || []
  }

  /** Songs from artists like this one. */
  async getSimilarSongs2(artistId: string, count = 40): Promise<NDSong[]> {
    const body = await this.call<any>('getSimilarSongs2', { id: artistId, count: String(count) })
    return body.similarSongs2?.song || []
  }

  async getRandomSongs(count = 40, genre?: string): Promise<NDSong[]> {
    const params: Record<string, string> = { size: String(count) }
    if (genre) params.genre = genre
    const body = await this.call<any>('getRandomSongs', params)
    return body.randomSongs?.song || []
  }

  async getGenres(): Promise<NDGenre[]> {
    const body = await this.call<any>('getGenres')
    const genres: NDGenre[] = (body.genres?.genre || [])
      .filter((g: any) => typeof g?.value === 'string' && g.value.trim() !== '')
      .map((g: any) => ({ name: g.value, songCount: g.songCount ?? 0, albumCount: g.albumCount ?? 0 }))
    return genres.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
  }

  async getAlbumsByGenre(genre: string, size = 60, offset = 0): Promise<NDAlbum[]> {
    const body = await this.call<any>('getAlbumList2', { type: 'byGenre', genre, size: String(size), offset: String(offset) })
    return body.albumList2?.album || []
  }

  async getPlaylists(): Promise<NDPlaylist[]> {
    const body = await this.call<any>('getPlaylists')
    return body.playlists?.playlist || []
  }

  async getPlaylist(id: string): Promise<{ playlist: NDPlaylist; songs: NDSong[] }> {
    const body = await this.call<any>('getPlaylist', { id })
    return { playlist: body.playlist, songs: body.playlist?.entry || [] }
  }

  async createPlaylist(name: string, songIds?: string[]): Promise<NDPlaylist> {
    const params: Record<string, string | string[]> = { name }
    if (songIds && songIds.length > 0) params.songId = songIds
    const body = await this.call<any>('createPlaylist', params)
    return body.playlist
  }

  async addToPlaylist(playlistId: string, songIds: string[]): Promise<void> {
    if (songIds.length === 0) return
    await this.call('updatePlaylist', { playlistId, songIdToAdd: songIds })
  }

  /** songIndex is the 0-based position of the entry within the playlist, not a song id. */
  async removeFromPlaylist(playlistId: string, songIndex: number): Promise<void> {
    await this.call('updatePlaylist', { playlistId, songIndexToRemove: String(songIndex) })
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    await this.call('deletePlaylist', { id: playlistId })
  }

  async search(query: string): Promise<{ artists: NDArtist[]; albums: NDAlbum[]; songs: NDSong[] }> {
    const body = await this.call<any>('search3', { query, artistCount: '10', albumCount: '10', songCount: '20' })
    const r = body.searchResult3 || {}
    return { artists: r.artist || [], albums: r.album || [], songs: r.song || [] }
  }

  async star(id: string): Promise<void> {
    await this.call('star', { id })
  }

  async unstar(id: string): Promise<void> {
    await this.call('unstar', { id })
  }

  async getStarred(): Promise<{ artists: NDArtist[]; albums: NDAlbum[]; songs: NDSong[] }> {
    const body = await this.call<any>('getStarred2')
    const r = body.starred2 || {}
    return { artists: r.artist || [], albums: r.album || [], songs: r.song || [] }
  }

  async getLyrics(artist: string, title: string): Promise<string | null> {
    try {
      const body = await this.call<any>('getLyrics', { artist, title })
      return body.lyrics?.value || null
    } catch {
      return null
    }
  }

  /**
   * Reports a play. `submission: false` marks the song as now playing; `true` records the play, which
   * feeds play counts and "recently played" and is forwarded to Last.fm/ListenBrainz if the server is set up for it.
   */
  async scrobble(id: string, submission: boolean, time?: number): Promise<void> {
    const params: Record<string, string> = { id, submission: String(submission) }
    if (time) params.time = String(time)
    await this.call('scrobble', params)
  }

  async getScanStatus(): Promise<ScanStatus> {
    const body = await this.call<any>('getScanStatus')
    return toScanStatus(body.scanStatus)
  }

  /** Looks for new or changed files in the music folders. Needs an admin account. */
  async startScan(): Promise<ScanStatus> {
    const body = await this.call<any>('startScan')
    return toScanStatus(body.scanStatus)
  }

  /** What every account is playing right now. */
  async getNowPlaying(): Promise<NowPlayingEntry[]> {
    const body = await this.call<any>('getNowPlaying')
    return body.nowPlaying?.entry || []
  }

  /** Server version and round-trip time. */
  async ping(): Promise<{ version: string | null; latencyMs: number }> {
    const started = Date.now()
    const body = await this.call<any>('ping')
    return { version: body.serverVersion || null, latencyMs: Date.now() - started }
  }

  streamUrl(songId: string): string {
    return this.buildMediaUrl('stream', { id: songId })
  }

  /**
   * Image caches are keyed on URL, so a cover must always get the same one: a random
   * salt changed it on every launch and reconnect, and the disk cache never hit.
   */
  coverArtUrl(coverArtId: string, size = 300): string {
    const bucket = coverSizeBucket(size)
    const key = `${coverArtId}@${bucket}`
    let url = this.coverArtUrls.get(key)
    if (!url) {
      url = this.buildMediaUrl('getCoverArt', { id: coverArtId, size: String(bucket) }, this.coverSalt)
      this.coverArtUrls.set(key, url)
    }
    return url
  }

  downloadUrl(id: string): string {
    return this.buildMediaUrl('download', { id })
  }
}
