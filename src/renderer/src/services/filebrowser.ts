export interface FileBrowserConfig {
  url: string
  username: string
  password: string
}

export interface FBItem {
  name: string
  path: string
  size: number
  isDir: boolean
  modified: string
  type?: string
}

export interface SourceUsage {
  name: string
  used: number
  total: number
  usedPercentage: number
  numFiles: number
  numDirs: number
  status: string
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const JWT_COOKIE_NAME = 'filebrowser_quantum_jwt'

function extractCookie(setCookieHeader: unknown, name: string): string | null {
  const entries: string[] = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : typeof setCookieHeader === 'string'
      ? [setCookieHeader]
      : []
  for (const entry of entries) {
    const match = entry.match(new RegExp(`${name}=([^;]+)`))
    if (match) return decodeURIComponent(match[1])
  }
  return null
}

function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
}

function joinPath(dir: string, name: string): string {
  return normalizePath(dir === '/' ? `/${name}` : `${dir}/${name}`)
}

/**
 * Client for FileBrowser Quantum (github.com/gtsteffaniak/filebrowser).
 * Its API differs from the original filebrowser/filebrowser project:
 * login is cookie/JWT based (no token in the response body), and every
 * resource call needs a "source" name since Quantum supports multiple
 * storage backends. Both were reverse-engineered from the app's own
 * frontend bundle since there is no public request/response reference.
 */
export class FileBrowserClient {
  private baseUrl: string
  private username: string
  private password: string
  private token: string | null = null
  private source: string | null = null

  constructor(config: FileBrowserConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '')
    this.username = config.username
    this.password = config.password
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  getSourceName(): string | null {
    return this.source
  }

  async login(): Promise<void> {
    const params = new URLSearchParams({ username: this.username, recaptcha: '' })
    const res = await window.api.net.request({
      url: `${this.baseUrl}/api/auth/login?${params.toString()}`,
      method: 'POST',
      headers: { 'X-Password': encodeURIComponent(this.password), 'X-Secret': '' }
    })
    if (!res.ok) {
      // Unreachable is not the same as rejected: callers only log out on a real 401/403.
      if (res.status === 0) throw new ApiError(res.error || 'Serveur injoignable', 0)
      let message = res.status === 401 || res.status === 403 ? 'Identifiants invalides' : res.error
      try {
        const parsed = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
        if (parsed?.message) message = parsed.message
      } catch {
        // response body wasn't JSON, keep the default message
      }
      throw new ApiError(message || 'Connexion échouée', res.status || 401)
    }
    const token = extractCookie(res.headers?.['set-cookie'], JWT_COOKIE_NAME)
    if (!token) {
      throw new ApiError(
        "Session introuvable dans la réponse du serveur (l'authentification à deux facteurs n'est pas gérée)",
        500
      )
    }
    this.token = token
    await this.resolveSource()
  }

  private async resolveSource(): Promise<void> {
    const selfRes = await window.api.net.request({
      url: `${this.baseUrl}/api/users?id=self`,
      method: 'GET',
      headers: this.authHeaders()
    })
    if (selfRes.ok && Array.isArray(selfRes.data?.scopes) && selfRes.data.scopes.length > 0) {
      this.source = selfRes.data.scopes[0].name
      return
    }
    const sourcesRes = await window.api.net.request({
      url: `${this.baseUrl}/api/sources`,
      method: 'GET',
      headers: this.authHeaders()
    })
    if (sourcesRes.ok && Array.isArray(sourcesRes.data) && sourcesRes.data.length > 0) {
      this.source = sourcesRes.data[0].name
      return
    }
    this.source = 'default'
  }

  async list(path = '/'): Promise<FBItem[]> {
    const params = new URLSearchParams({ path, source: this.source || '' })
    const res = await window.api.net.request({
      url: `${this.baseUrl}/api/resources?${params.toString()}`,
      method: 'GET',
      headers: this.authHeaders()
    })
    if (res.status === 401) throw new ApiError('Session expirée', 401)
    if (!res.ok) throw new ApiError(res.error || 'Impossible de lister le dossier', res.status)
    const data = res.data || {}
    const folders = (data.folders || []).map((f: any) => ({ ...f, isDir: true }))
    const files = (data.files || []).map((f: any) => ({ ...f, isDir: false }))
    return [...folders, ...files].map((it) => ({
      name: it.name,
      path: joinPath(path, it.name),
      size: it.size || 0,
      isDir: it.isDir || it.type === 'directory',
      modified: it.modified || it.mtime || '',
      type: it.type
    }))
  }

  rawUrl(path: string): string {
    const params = new URLSearchParams({
      source: this.source || '',
      file: path,
      inline: 'true',
      auth: this.token || ''
    })
    return `${this.baseUrl}/api/resources/download?${params.toString()}`
  }

  /** Server-generated small preview; callers fall back to rawUrl() if the server can't produce one. */
  thumbnailUrl(path: string): string {
    const params = new URLSearchParams({
      source: this.source || '',
      path,
      size: 'small',
      inline: 'true',
      auth: this.token || ''
    })
    return `${this.baseUrl}/api/preview?${params.toString()}`
  }

  /** Returns where the file landed, so callers can log it in the downloads history. */
  async downloadTo(path: string, name: string): Promise<{ ok: boolean; path?: string; canceled?: boolean }> {
    const params = new URLSearchParams({ source: this.source || '', file: path })
    return window.api.fb.downloadFile({
      url: `${this.baseUrl}/api/resources/download?${params.toString()}`,
      suggestedName: name,
      headers: this.authHeaders()
    }) as Promise<{ ok: boolean; path?: string; canceled?: boolean }>
  }

  async uploadLocalFile(localPath: string, destDir: string, filename: string, uploadId?: string): Promise<void> {
    const params = new URLSearchParams({
      path: joinPath(destDir, filename),
      source: this.source || '',
      override: 'true'
    })
    const res = await window.api.fb.uploadFile({
      uploadId: uploadId || filename,
      url: `${this.baseUrl}/api/resources?${params.toString()}`,
      filePath: localPath,
      headers: this.authHeaders(),
      method: 'POST'
    })
    if (!res.ok) throw new ApiError("Échec de l'upload", res.status || 500)
  }

  async pickFiles(): Promise<{ path: string; size: number }[]> {
    return window.api.fb.pickFiles()
  }

  async remove(path: string): Promise<void> {
    const res = await window.api.net.request({
      url: `${this.baseUrl}/api/resources/bulk`,
      method: 'DELETE',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      data: [{ source: this.source, path }]
    })
    if (!res.ok) throw new ApiError('Suppression impossible', res.status)
  }

  async rename(path: string, newPath: string): Promise<void> {
    const res = await window.api.net.request({
      url: `${this.baseUrl}/api/resources`,
      method: 'PATCH',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      data: {
        items: [{ fromSource: this.source, fromPath: path, toSource: this.source, toPath: newPath }],
        action: 'move',
        overwrite: false,
        rename: false
      }
    })
    if (!res.ok) throw new ApiError('Renommage impossible', res.status)
  }

  async createFolder(path: string): Promise<void> {
    const params = new URLSearchParams({ path: normalizePath(path), source: this.source || '', isDir: 'true' })
    const res = await window.api.net.request({
      url: `${this.baseUrl}/api/resources?${params.toString()}`,
      method: 'POST',
      headers: this.authHeaders()
    })
    if (!res.ok) throw new ApiError('Création du dossier impossible', res.status)
  }

  async getSourcesUsage(): Promise<SourceUsage[]> {
    const res = await window.api.net.request({
      url: `${this.baseUrl}/api/settings/sources`,
      method: 'GET',
      headers: this.authHeaders()
    })
    if (!res.ok) throw new ApiError("Impossible de récupérer l'espace disque", res.status)
    const data = res.data || {}
    return Object.entries(data).map(([key, raw]) => {
      const v = raw as Record<string, any>
      const total = v.total || 0
      const used = v.used || 0
      return {
        name: v.name || key,
        used,
        total,
        usedPercentage: total ? Math.round((used / total) * 100) : 0,
        numFiles: v.numFiles || 0,
        numDirs: v.numDirs || 0,
        status: v.status || 'unknown'
      }
    })
  }

  async getCurrentSourceUsage(): Promise<SourceUsage | null> {
    const all = await this.getSourcesUsage()
    if (all.length === 0) return null
    return all.find((s) => s.name === this.source) || all[0]
  }

  async getTextPreview(path: string): Promise<string> {
    const params = new URLSearchParams({ source: this.source || '', file: path, inline: 'true' })
    const res = await window.api.net.request({
      url: `${this.baseUrl}/api/resources/download?${params.toString()}`,
      method: 'GET',
      headers: this.authHeaders()
    })
    if (!res.ok) throw new ApiError('Aperçu impossible', res.status)
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  }
}
