import { md5 } from 'js-md5'
import { NavidromeAdmin } from './navidromeAdmin'

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

export interface NDSong {
  id: string
  title: string
  artist: string
  album?: string
  albumId?: string
  coverArt?: string
  duration: number
  track?: number; artistId?: string; genre?: string
  starred?: string
  /** The file's extension on the server (mp3, flac...). */
  suffix?: string
}

export interface NDPlaylist {
  id: string
  name: string
  songCount: number
  duration: number
  coverArt?: string
  /** The account it belongs to. */
  owner?: string
  /** Shown to every account of the server, not only to its owner. */
  public?: boolean
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
  // 1280 is for the full-screen player: a cover blown up to a whole screen from 640 px looks soft.
  return size <= 160 ? 160 : size <= 320 ? 320 : size <= 640 ? 640 : 1280
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

/**
 * The server could not be reached (no network, the server or its proxy down), as opposed to a request it refused:
 * worth trying again later, and no reason to forget the login.
 */
export function isUnreachable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return status === 0 || status === 502 || status === 503 || status === 504
}

/** The extension a downloaded song's file gets: its own (flac, ogg...), "mp3" when the server does not say. */
export function fileExtension(suffix: string | undefined): string {
  const clean = (suffix ?? '').trim().toLowerCase()
  return /^[a-z0-9]{1,5}$/.test(clean) ? clean : 'mp3'
}

/** What this computer's player (Chromium) can play from a file; anything else is downloaded as the server streams it. */
const PLAYABLE = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'aac', 'wav', 'webm'])
export function playableOriginal(suffix: string | undefined): boolean {
  return PLAYABLE.has(fileExtension(suffix))
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
    const res = await window.api.net.request({ url, method: 'GET' })
    if (!res.ok) {
      throw new ApiError(res.error || `Requête échouée (${res.status})`, res.status)
    }
    const body = res.data?.['subsonic-response']
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

  async getSong(id: string): Promise<NDSong> {
    const body = await this.call<any>('getSong', { id })
    if (!body.song) throw new ApiError('Titre introuvable', 404, 70)
    return body.song
  }

  async getSimilarSongs(id: string, count = 40): Promise<NDSong[]> {
    const body = await this.call<any>('getSimilarSongs', { id, count: String(count) })
    return body.similarSongs?.song || []
  }

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

  /** Every album of the library, the newest first (the server gives at most 500 at a time). */
  async getAllAlbums(): Promise<NDAlbum[]> {
    const PAGE = 500
    const albums: NDAlbum[] = []
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.getAlbumList('newest', PAGE, offset)
      albums.push(...page)
      if (page.length < PAGE) return albums
    }
  }

  async getAlbumList(type: 'newest' | 'recent' | 'frequent' | 'random' = 'newest', size = 40, offset = 0): Promise<NDAlbum[]> {
    const body = await this.call<any>('getAlbumList2', { type, size: String(size), offset: String(offset) })
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

  /**
   * Puts the playlist's songs in this order (the whole list: Subsonic's createPlaylist with an id replaces its songs),
   * sent as a form so a long list never makes an address too long for a proxy. Refused for a playlist that follows an
   * M3U file.
   */
  async replacePlaylistSongs(playlistId: string, songIds: string[]): Promise<void> {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...this.authParams(), playlistId })) form.append(key, value)
    for (const id of songIds) form.append('songId', id)
    const res = await window.api.net.request({
      url: `${this.baseUrl}/rest/createPlaylist.view`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: form.toString()
    })
    if (!res.ok) throw new ApiError(res.error || `Requête échouée (${res.status})`, res.status)
    const body = res.data?.['subsonic-response']
    if (!body) throw new ApiError('Réponse Navidrome invalide', res.status)
    if (body.status === 'failed') throw new ApiError(body.error?.message || 'Erreur Navidrome', body.error?.code === 40 ? 401 : 500, body.error?.code)
  }

  /** Shown to every account (true) or to its owner only (false). */
  async setPlaylistPublic(playlistId: string, isPublic: boolean): Promise<void> {
    await this.call('updatePlaylist', { playlistId, public: String(isPublic) })
  }

  /** Navidrome's own API, for an admin account: every account's playlists, and who they belong to. */
  admin(): NavidromeAdmin {
    return new NavidromeAdmin(this.baseUrl, this.username, this.password)
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
      const value = body.lyrics?.value
      return value || null
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
   * The browser cache is keyed on URL, so a cover must always get the same one: a
   * random salt changed it on every launch, and the disk cache never hit.
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

/**
   * The song's file as it is on the server, never converted to another format or bitrate (Subsonic `format=raw`): what
   * a download keeps. A plain stream can be converted when the server has a conversion set for this player.
   */
  originalUrl(songId: string): string {
    return this.buildMediaUrl('stream', { id: songId, format: 'raw' })
  }

  downloadUrl(id: string): string {
    return this.buildMediaUrl('download', { id })
  }
}
