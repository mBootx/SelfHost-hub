export interface DowntifyConfig {
  url: string
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
 * downloader, no Spotify account needed). There is no authentication at
 * all - the server only distinguishes callers by a per-install "client_id"
 * used to keep a separate settings profile. The exact endpoints below were
 * reverse-engineered from the app's own frontend bundle, since there is no
 * published API reference.
 */
export class DowntifyClient {
  private baseUrl: string
  private clientId: string

  constructor(config: DowntifyConfig, clientId: string) {
    this.baseUrl = config.url.replace(/\/+$/, '')
    this.clientId = clientId
  }

  private async request<T>(
    path: string,
    method = 'GET',
    params?: Record<string, string>,
    data?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    const query = params ? `?${new URLSearchParams(params).toString()}` : ''
    const res = await window.api.net.request({
      url: `${this.baseUrl}${path}${query}`,
      method,
      headers: { 'Content-Type': 'application/json' },
      data,
      timeout: timeoutMs
    })
    if (!res.ok) throw new ApiError(res.error || `Erreur Downtify (${res.status})`, res.status)
    return res.data as T
  }

  async testConnection(): Promise<void> {
    await this.request<string>('/api/version')
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
    // The server resolves, downloads and transcodes the track before responding to
    // this call (no separate "queued" ack), which can take well over the default
    // request timeout - especially when writing to a network-mounted destination.
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
      throw new ApiError(`Aucun resultat trouve pour ${type === 'album' ? 'cet album' : 'ce titre'}`, 404)
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

  fileUrl(file: string): string {
    const encoded = file.split('/').map(encodeURIComponent).join('/')
    return `${this.baseUrl}/downloads/${encoded}`
  }

  coverUrl(file: string): string {
    return `${this.baseUrl}/cover?file=${encodeURIComponent(file)}`
  }

  async getSettings(): Promise<DowntifySettings> {
    return this.request<DowntifySettings>('/api/settings', 'GET', { client_id: this.clientId })
  }

  async updateSettings(settings: DowntifySettings): Promise<void> {
    await this.request('/api/settings/update', 'POST', { client_id: this.clientId }, settings)
  }
}
