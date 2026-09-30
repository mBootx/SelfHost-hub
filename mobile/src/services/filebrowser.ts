import { File, Directory, Paths, UploadType } from 'expo-file-system'
import { xhrRequest } from './httpXhr'

/** Where files pulled off the server are kept, and what the Downloads tab lists. */
export const downloadsDir = new Directory(Paths.document, 'downloads')

function ensureDownloadsDir(): void {
  if (!downloadsDir.exists) downloadsDir.create({ intermediates: true })
}

/** Keeps "report.pdf" from clobbering an earlier "report.pdf". */
function uniqueName(name: string): string {
  ensureDownloadsDir()
  if (!new File(downloadsDir, name).exists) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!new File(downloadsDir, candidate).exists) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

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

function extractCookie(setCookieHeader: string | undefined, name: string): string | null {
  if (!setCookieHeader) return null
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}

function normalizePath(path: string): string {
  const collapsed = path.replace(/\/+/g, '/')
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed
}

function joinPath(dir: string, name: string): string {
  return normalizePath(dir === '/' ? `/${name}` : `${dir}/${name}`)
}

/**
 * Client for FileBrowser Quantum (github.com/gtsteffaniak/filebrowser),
 * ported from the desktop app's client. Login is cookie/JWT based with no
 * token in the response body, so we use XHR (not fetch) to read the
 * Set-Cookie header ourselves - see httpXhr.ts for why. Every resource call
 * also needs a "source" name since Quantum supports multiple storage
 * backends.
 */
export class FileBrowserClient {
  private baseUrl: string
  private username: string
  private password: string
  private token: string | null = null
  private source: string | null = null
  /** The account's name as the server spells it; what was typed at login may differ in case. */
  private accountName: string | null = null

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

  getUsername(): string {
    return this.username
  }

  /** The name the server knows this account by: what the account's backup folder is called after. */
  getAccountName(): string {
    return this.accountName || this.username
  }

  async login(): Promise<void> {
    const params = new URLSearchParams({ username: this.username, recaptcha: '' })
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/auth/login?${params.toString()}`,
      method: 'POST',
      headers: { 'X-Password': encodeURIComponent(this.password), 'X-Secret': '' }
    })
    if (!res.ok) {
      // Unreachable is not the same as rejected: callers only log out on a real 401/403.
      if (res.status === 0) throw new ApiError(res.error || 'Serveur injoignable', 0)
      let message = res.status === 401 || res.status === 403 ? 'Identifiants invalides' : res.error
      if (res.data?.message) message = res.data.message
      throw new ApiError(message || 'Connexion échouée', res.status || 401)
    }
    const token = extractCookie(res.headers['set-cookie'], JWT_COOKIE_NAME)
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
    const selfRes = await xhrRequest({
      url: `${this.baseUrl}/api/users?id=self`,
      headers: this.authHeaders()
    })
    if (selfRes.ok && typeof selfRes.data?.username === 'string' && selfRes.data.username.trim()) {
      this.accountName = selfRes.data.username.trim()
    }
    if (selfRes.ok && Array.isArray(selfRes.data?.scopes) && selfRes.data.scopes.length > 0) {
      this.source = selfRes.data.scopes[0].name
      return
    }
    const sourcesRes = await xhrRequest({
      url: `${this.baseUrl}/api/sources`,
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
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/resources?${params.toString()}`,
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

  async downloadToDevice(
    path: string,
    name: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    const params = new URLSearchParams({ source: this.source || '', file: path, auth: this.token || '' })
    const url = `${this.baseUrl}/api/resources/download?${params.toString()}`
    // Documents, not cache: Android purges the cache directory whenever it feels
    // like it, which silently deleted files the user had deliberately saved.
    const destination = new File(downloadsDir, uniqueName(name))
    const task = File.createDownloadTask(url, destination, {
      onProgress: onProgress ? ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes) : undefined
    })
    const file = await task.downloadAsync()
    if (!file) throw new ApiError('Téléchargement interrompu', 0)
    return file.uri
  }

  async uploadLocalFile(
    localUri: string,
    destDir: string,
    filename: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const params = new URLSearchParams({
      path: joinPath(destDir, filename),
      source: this.source || '',
      override: 'true'
    })
    const url = `${this.baseUrl}/api/resources?${params.toString()}`
    const file = new File(localUri)
    const task = file.createUploadTask(url, {
      uploadType: UploadType.BINARY_CONTENT,
      httpMethod: 'POST',
      headers: this.authHeaders(),
      onProgress: onProgress ? ({ bytesSent, totalBytes }) => onProgress(bytesSent, totalBytes) : undefined
    })
    const result = await task.uploadAsync()
    if (!result || result.status < 200 || result.status >= 300) {
      throw new ApiError("Échec de l'upload", result?.status || 500)
    }
  }

  async remove(path: string): Promise<void> {
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/resources/bulk`,
      method: 'DELETE',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      data: [{ source: this.source, path }]
    })
    if (!res.ok) throw new ApiError('Suppression impossible', res.status)
  }

  async rename(path: string, newPath: string): Promise<void> {
    const res = await xhrRequest({
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
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/resources?${params.toString()}`,
      method: 'POST',
      headers: this.authHeaders()
    })
    if (!res.ok) throw new ApiError('Création du dossier impossible', res.status)
  }

  async getSourcesUsage(): Promise<SourceUsage[]> {
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/settings/sources`,
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
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/resources/download?${params.toString()}`,
      headers: this.authHeaders()
    })
    if (!res.ok) throw new ApiError('Aperçu impossible', res.status)
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  }
}
