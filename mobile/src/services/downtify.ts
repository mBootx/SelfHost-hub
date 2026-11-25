import { fetchWithTimeout } from './http'

export interface HubDowntifyProxy {
  baseUrl: string
  apiToken: string
}

export interface DowntifyConfig {
  url: string
  getHubProxy?: () => HubDowntifyProxy | null
  onTransportChange?: (viaHub: boolean) => void
}

export interface DowntifySong {
  song_id: string
  name: string
  artists: string[]
  album_name: string
  cover_url: string
  duration: number
  url: string
  source: string
}

export type QueueStatus = 'queued' | 'downloading' | 'done' | 'error' | string

export interface QueueItem {
  song: DowntifySong
  status: QueueStatus
  progress: number
  message: string
  filename: string | null
}

export interface DowntifySettings {
  audio_providers: string[]
  lyrics_providers: string[]
  download_lyrics: boolean
  format: string
  bitrate: string
  output: string
  generate_m3u: boolean
  max_parallel_downloads: number
  organize_by_artist: boolean
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * Client for Downtify (open-source YouTube/YouTube-Music based music
 * downloader, no Spotify account needed). No authentication - the server
 * only distinguishes callers by a per-install "client_id" used to keep a
 * separate settings profile. Endpoints reverse-engineered from the app's
 * own frontend bundle, ported from the desktop client.
 */
export class DowntifyClient {
  private baseUrl: string
  private clientId: string
  private getHubProxy?: () => HubDowntifyProxy | null
  private onTransportChange?: (viaHub: boolean) => void
  private usingHub = false

  constructor(config: DowntifyConfig, clientId: string) {
    this.baseUrl = (config.url ?? '').trim().replace(/\/+$/, '')
    this.clientId = clientId
    this.getHubProxy = config.getHubProxy
    this.onTransportChange = config.onTransportChange
  }

  get isViaHub(): boolean {
    return this.usingHub
  }

  private setUsingHub(viaHub: boolean): void {
    if (this.usingHub === viaHub) return
    this.usingHub = viaHub
    this.onTransportChange?.(viaHub)
  }

  private parseResponse<T>(text: string): T {
    try {
      return JSON.parse(text) as T
    } catch {
      return text as unknown as T
    }
  }

  private async isLanReachable(): Promise<boolean> {
    if (!this.baseUrl) return false
    try {
      const res = await fetchWithTimeout(`${this.baseUrl}/api/version`, { method: 'GET' }, 2500)
      return res.ok
    } catch {
      return false
    }
  }

  private async request<T>(
    path: string,
    method = 'GET',
    params?: Record<string, string>,
    data?: unknown,
    timeoutMs = 20000
  ): Promise<T> {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    const query = params ? `?${new URLSearchParams(params).toString()}` : ''
    const body = data !== undefined ? JSON.stringify(data) : undefined
    const hub = this.getHubProxy?.() ?? null

    if (this.baseUrl) {
      let skipLan = false
      let lanTimeout = timeoutMs
      if (this.usingHub && hub) {
        if (timeoutMs > 10000) {
          skipLan = !(await this.isLanReachable())
        } else {
          lanTimeout = Math.min(timeoutMs, 2500)
        }
      }

      if (!skipLan) {
        try {
          const res = await fetchWithTimeout(
            `${this.baseUrl}${cleanPath}${query}`,
            {
              method,
              headers: { 'Content-Type': 'application/json' },
              body
            },
            lanTimeout
          )
          this.setUsingHub(false)
          if (!res.ok) throw new ApiError(`Erreur Downtify (${res.status})`, res.status)
          return this.parseResponse<T>(await res.text())
        } catch (err) {
          if (err instanceof ApiError || !hub) {
            if (err instanceof ApiError) throw err
            throw new ApiError(err instanceof Error ? err.message : 'Serveur injoignable', 0)
          }
          // Network error or timeout on direct LAN: fall back to the Hub proxy below.
        }
      }
    }

    if (!hub) throw new ApiError('Serveur injoignable', 0)

    const hubBase = hub.baseUrl.replace(/\/+$/, '')
    let res: Response
    try {
      res = await fetchWithTimeout(
        `${hubBase}/api/downtify${cleanPath}${query}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hub.apiToken}`
          },
          body
        },
        timeoutMs
      )
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : 'Serveur Hub injoignable', 0)
    }
    if (!res.ok) throw new ApiError(`Erreur Downtify (${res.status})`, res.status)
    this.setUsingHub(true)
    return this.parseResponse<T>(await res.text())
  }

  async testConnection(): Promise<void> {
    await this.request<string>('/api/version', 'GET', undefined, undefined, 5000)
  }

  async getQueue(): Promise<QueueItem[]> {
    const data = await this.request<QueueItem[]>('/api/queue')
    return Array.isArray(data) ? data : []
  }

  async cancelQueueItem(songId: string): Promise<void> {
    await this.request(`/api/queue/item`, 'DELETE', { song_id: songId })
  }

  async clearQueue(): Promise<void> {
    await this.request('/api/queue', 'DELETE')
  }

  async searchSongs(query: string): Promise<DowntifySong[]> {
    const data = await this.request<DowntifySong[]>('/api/songs/search', 'GET', { query })
    return Array.isArray(data) ? data : []
  }

  async downloadByUrl(songUrl: string): Promise<void> {
    // The server resolves, downloads and transcodes the track before responding
    // (no separate "queued" ack), which can take well over a default timeout.
    await this.request('/api/download/url', 'POST', { url: songUrl, client_id: this.clientId }, undefined, 180000)
  }

  /**
   * Resolves a free-text query to concrete targets via search, then fires their
   * downloads without waiting on them - downloadByUrl only returns once the
   * server has finished transcoding, so awaiting it here would block the caller
   * for as long as the download takes. Callers should watch the polled queue
   * (started right after this resolves) for real progress instead.
   */
  async queueByQuery(query: string, type: 'track' | 'album'): Promise<DowntifySong[]> {
    const results = await this.searchSongs(query)
    if (results.length === 0) {
      throw new ApiError(`Aucun résultat trouvé pour ${type === 'album' ? 'cet album' : 'ce titre'}`, 404)
    }
    const targets =
      type === 'track'
        ? [results[0]]
        : (() => {
            const albumName = results[0].album_name
            return (albumName ? results.filter((r) => r.album_name === albumName) : results.slice(0, 1)).slice(0, 25)
          })()
    Promise.allSettled(targets.map((song) => this.downloadByUrl(song.url)))
    return targets
  }

  async listLibrary(): Promise<string[]> {
    const data = await this.request<string[]>('/list')
    return Array.isArray(data) ? data : []
  }

  async deleteFromLibrary(file: string): Promise<void> {
    await this.request('/delete', 'DELETE', { file })
  }

  private activeBase(): string {
    if (this.usingHub || !this.baseUrl) {
      const hub = this.getHubProxy?.()
      if (hub) return `${hub.baseUrl.replace(/\/+$/, '')}/api/downtify`
    }
    return this.baseUrl
  }

  fileUrl(file: string): string {
    const encoded = file.split('/').map(encodeURIComponent).join('/')
    return `${this.activeBase()}/downloads/${encoded}`
  }

  coverUrl(file: string): string {
    return `${this.activeBase()}/cover?file=${encodeURIComponent(file)}`
  }

  async getSettings(): Promise<DowntifySettings> {
    return this.request<DowntifySettings>('/api/settings', 'GET', { client_id: this.clientId })
  }

  async updateSettings(settings: DowntifySettings): Promise<void> {
    await this.request('/api/settings/update', 'POST', { client_id: this.clientId }, settings)
  }
}
