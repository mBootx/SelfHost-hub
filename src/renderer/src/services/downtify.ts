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

interface HubProxyInfo {
  baseUrl: string
  apiToken: string
  downtifyEnabled: boolean
}

const DIRECT_RETRY_AFTER_MS = 60_000
const CONNECT_WAIT_MS = 2_500

/**
 * Client for Downtify (open-source YouTube/YouTube-Music based music
 * downloader, no Spotify account needed). There is no authentication at
 * all - the server only distinguishes callers by a per-install "client_id"
 * used to keep a separate settings profile. The exact endpoints below were
 * reverse-engineered from the app's own frontend bundle, since there is no
 * published API reference.
 *
 * When the direct LAN URL is unreachable (or unset), falls back to the
 * authenticated SelfHost Hub server proxy (`/api/downtify/*`).
 */
export class DowntifyClient {
  private baseUrl: string
  private clientId: string
  private usingProxy = false
  private proxyAt = 0
  private proxyInfo: HubProxyInfo | null = null

  constructor(config: DowntifyConfig, clientId: string) {
    this.baseUrl = (config.url || '').trim().replace(/\/+$/, '')
    this.clientId = clientId
  }

  private async resolveProxy(): Promise<HubProxyInfo | null> {
    let info = await window.api.hubServer.getProxyInfo().catch(() => null)
    if (!info) {
      const st = await window.api.hubServer.status().catch(() => null)
      if (st?.state === 'connecting') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            off()
            resolve()
          }, CONNECT_WAIT_MS)
          const off = window.api.hubServer.onStatus((next) => {
            if (next.state !== 'connecting') {
              clearTimeout(timer)
              off()
              resolve()
            }
          })
        })
        info = await window.api.hubServer.getProxyInfo().catch(() => null)
      }
    }
    this.proxyInfo = info
    return info
  }

  private async requestDirect<T>(
    cleanPath: string,
    query: string,
    method: string,
    data?: unknown,
    timeoutMs?: number
  ): Promise<{ ok: true; data: T } | { ok: false; networkError: boolean; status: number; error: string }> {
    const res = await window.api.net.request({
      url: `${this.baseUrl}/${cleanPath}${query}`,
      method,
      headers: { 'Content-Type': 'application/json' },
      data,
      timeout: timeoutMs
    })
    if (res.ok) return { ok: true, data: res.data as T }
    return {
      ok: false,
      networkError: res.status === 0,
      status: res.status,
      error: res.error || `Erreur Downtify (${res.status})`
    }
  }

  private async requestProxy<T>(
    proxy: HubProxyInfo,
    cleanPath: string,
    query: string,
    method: string,
    data?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    const base = proxy.baseUrl.replace(/\/+$/, '')
    const res = await window.api.net.request({
      url: `${base}/api/downtify/${cleanPath}${query}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${proxy.apiToken}`
      },
      data,
      timeout: timeoutMs
    })
    if (!res.ok) throw new ApiError(res.error || `Erreur Downtify (${res.status})`, res.status)
    return res.data as T
  }

  private async request<T>(
    path: string,
    method = 'GET',
    params?: Record<string, string>,
    data?: unknown,
    timeoutMs?: number,
    forceDirectCheck = false
  ): Promise<T> {
    const cleanPath = path.replace(/^\/+/, '')
    const query = params ? `?${new URLSearchParams(params).toString()}` : ''
    const shouldTryDirect =
      !!this.baseUrl && (forceDirectCheck || !this.usingProxy || Date.now() - this.proxyAt > DIRECT_RETRY_AFTER_MS)

    let directErr: ApiError | null = null
    if (shouldTryDirect) {
      const direct = await this.requestDirect<T>(cleanPath, query, method, data, timeoutMs)
      if (direct.ok) {
        this.usingProxy = false
        return direct.data
      }
      directErr = new ApiError(direct.error, direct.status)
      if (!direct.networkError) throw directErr
    }

    const proxy = await this.resolveProxy()
    if (proxy && proxy.downtifyEnabled && proxy.apiToken) {
      try {
        const result = await this.requestProxy<T>(proxy, cleanPath, query, method, data, timeoutMs)
        this.usingProxy = true
        this.proxyAt = Date.now()
        return result
      } catch (err) {
        // If proxy was tried first because we were cached in proxy mode, give direct LAN one chance.
        if (!shouldTryDirect && this.baseUrl) {
          const direct = await this.requestDirect<T>(cleanPath, query, method, data, timeoutMs)
          if (direct.ok) {
            this.usingProxy = false
            return direct.data
          }
        }
        throw err
      }
    }

    if (!shouldTryDirect && this.baseUrl) {
      const direct = await this.requestDirect<T>(cleanPath, query, method, data, timeoutMs)
      if (direct.ok) {
        this.usingProxy = false
        return direct.data
      }
      throw new ApiError(direct.error, direct.status)
    }

    throw directErr ?? new ApiError('Downtify injoignable', 0)
  }

  async testConnection(): Promise<void> {
    await this.request<string>('/api/version', 'GET', undefined, undefined, undefined, true)
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

  private activeProxyBase(): string | null {
    if ((this.usingProxy || !this.baseUrl) && this.proxyInfo?.downtifyEnabled && this.proxyInfo.apiToken) {
      return `${this.proxyInfo.baseUrl.replace(/\/+$/, '')}/api/downtify`
    }
    return null
  }

  fileUrl(file: string): string {
    const encoded = file.split('/').map(encodeURIComponent).join('/')
    const proxyBase = this.activeProxyBase()
    return proxyBase ? `${proxyBase}/downloads/${encoded}` : `${this.baseUrl}/downloads/${encoded}`
  }

  downloadUrl(file: string): string {
    return this.fileUrl(file)
  }

  coverUrl(file: string): string {
    const proxyBase = this.activeProxyBase()
    return proxyBase
      ? `${proxyBase}/cover?file=${encodeURIComponent(file)}`
      : `${this.baseUrl}/cover?file=${encodeURIComponent(file)}`
  }

  /** Fetches a cover image (with bearer auth if routed through the hub proxy) and returns a blob URL. */
  async fetchCoverBlob(file: string): Promise<string | null> {
    const proxy = this.usingProxy || !this.baseUrl ? await this.resolveProxy() : null
    const useProxy = !!proxy && proxy.downtifyEnabled && !!proxy.apiToken && (this.usingProxy || !this.baseUrl)
    const url = useProxy
      ? `${proxy!.baseUrl.replace(/\/+$/, '')}/api/downtify/cover?file=${encodeURIComponent(file)}`
      : `${this.baseUrl}/cover?file=${encodeURIComponent(file)}`
    const headers: Record<string, string> = useProxy ? { Authorization: `Bearer ${proxy!.apiToken}` } : {}
    const res = await window.api.net.request({ url, method: 'GET', headers, responseType: 'arraybuffer' })
    if (!res.ok || !res.data) return null
    const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data as ArrayBuffer)
    const contentType = res.headers?.['content-type'] || 'image/jpeg'
    return URL.createObjectURL(new Blob([bytes], { type: contentType }))
  }

  async getSettings(): Promise<DowntifySettings> {
    return this.request<DowntifySettings>('/api/settings', 'GET', { client_id: this.clientId })
  }

  async updateSettings(settings: DowntifySettings): Promise<void> {
    await this.request('/api/settings/update', 'POST', { client_id: this.clientId }, settings)
  }
}
