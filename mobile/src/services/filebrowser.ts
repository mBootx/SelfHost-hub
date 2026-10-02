import { File, Directory, Paths, UploadType } from 'expo-file-system'
import { baseName } from './fileNames'
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
  /** The server can make a thumbnail of this file; false for, say, a video when ffmpeg isn't installed there. */
  hasPreview?: boolean
  /** The item already has a share link. */
  isShared?: boolean
}

/** How long a share link lasts; null is for ever. */
export type ShareDuration = { value: number; unit: 'minutes' | 'hours' | 'days' } | null

export interface ShareLink {
  hash: string
  /** The page that opens the share in a browser. */
  url: string
  /** The file itself, for a password-protected share with the token that lets it through. */
  downloadUrl: string
  path: string
  /** When the link stops working (ms), or null if it never does. */
  expiresAt: number | null
  hasPassword: boolean
  /** Who made it; only the server's list says. */
  username?: string
  pathExists?: boolean
}

export interface SearchHit {
  path: string
  name: string
  isDir: boolean
  size: number
  modified: string
  type?: string
  hasPreview?: boolean
}

/** What a request on several files did for each of them. */
export interface BatchResult {
  done: string[]
  failed: { path: string; message: string }[]
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

/** What the server said went wrong, if it said anything readable. */
function messageOf(res: { data: any; error?: string }): string | undefined {
  const data = res.data
  if (data && typeof data === 'object' && typeof data.message === 'string' && data.message) return data.message
  if (typeof data === 'string' && data.trim() && data.length < 200 && !data.trim().startsWith('<')) return data.trim()
  return res.error
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
  /** Identifies this app run to the server's search, which keeps results per session. */
  private sessionId = Math.random().toString(36).slice(2)
  /** Which preview route answered last: 'current' (FileBrowser 1.3 and later) or 'legacy'. */
  private previewRoute: 'current' | 'legacy' = 'current'

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

  /** The status the server gives a signed-in request: 0 when it doesn't answer at all, 401 or 403 when the session has lapsed. */
  async probe(): Promise<number> {
    const res = await xhrRequest({ url: `${this.baseUrl}/api/users?id=self`, headers: this.authHeaders(), timeout: 8000 })
    return res.status
  }

  /** Whether the server answers at all (anything below 500): tells a dead connection from a file the server refused. */
  async isReachable(): Promise<boolean> {
    const status = await this.probe()
    return status > 0 && status < 500
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
      type: it.type,
      hasPreview: typeof it.hasPreview === 'boolean' ? it.hasPreview : undefined,
      isShared: it.isShared === true ? true : undefined
    }))
  }

  /**
   * What images and video send along instead of the login in the address: the address ends up in the
   * server's and the reverse proxy's logs, and in the clipboard when someone copies it.
   */
  getAuthHeaders(): Record<string, string> {
    return this.authHeaders()
  }

  /** The address of a file's content. It carries no login: use getAuthHeaders() when loading it. */
  rawUrl(path: string): string {
    const params = new URLSearchParams({ source: this.source || '', file: path, inline: 'true' })
    return `${this.baseUrl}/api/resources/download?${params.toString()}`
  }

  /**
   * Addresses of the server-made thumbnail, best guess first. FileBrowser 1.3 and later serve it at
   * /api/resources/preview; older ones at /api/preview. Callers try them in turn, then fall back to
   * rawUrl(), and tell notePreviewWorked() which one answered so the next ones start with it.
   */
  previewUrls(path: string, size: 'small' | 'large' = 'small'): string[] {
    const query = new URLSearchParams({ source: this.source || '', path, size, inline: 'true' }).toString()
    const current = `${this.baseUrl}/api/resources/preview?${query}`
    const legacy = `${this.baseUrl}/api/preview?${query}`
    return this.previewRoute === 'current' ? [current, legacy] : [legacy, current]
  }

  notePreviewWorked(url: string): void {
    this.previewRoute = url.includes('/api/resources/preview') ? 'current' : 'legacy'
  }

  /** A picture's source for expo-image: the address, the login in the headers, and a cache key that outlives the session. */
  imageSource(uri: string, cacheKey: string): { uri: string; headers: Record<string, string>; cacheKey: string } {
    return { uri, headers: this.authHeaders(), cacheKey }
  }

  /** Downloads `url` (signed in through the headers) to `destination` and returns where it ended up. */
  private async saveTo(url: string, destination: File, onProgress?: (loaded: number, total: number) => void): Promise<string> {
    const task = File.createDownloadTask(url, destination, {
      headers: this.authHeaders(),
      onProgress: onProgress ? ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes) : undefined
    })
    const file = await task.downloadAsync()
    if (!file) throw new ApiError('Téléchargement interrompu', 0)
    return file.uri
  }

  async downloadToDevice(
    path: string,
    name: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    const params = new URLSearchParams({ source: this.source || '', file: path })
    const url = `${this.baseUrl}/api/resources/download?${params.toString()}`
    // Documents, not cache: Android purges the cache directory whenever it feels
    // like it, which silently deleted files the user had deliberately saved.
    return this.saveTo(url, new File(downloadsDir, uniqueName(name)), onProgress)
  }

  /**
   * A file for handing to another app (sharing, saving to the gallery): downloaded into the cache, where it is
   * not kept for good. The files left by earlier hand-overs are cleared first.
   */
  async downloadToCache(path: string, name: string, onProgress?: (loaded: number, total: number) => void): Promise<string> {
    const dir = new Directory(Paths.cache, 'shared')
    if (dir.exists) {
      for (const entry of dir.list()) {
        try {
          entry.delete()
        } catch {
          // still in use by the app it was handed to: Android clears the cache later
        }
      }
    } else {
      dir.create({ intermediates: true })
    }
    const params = new URLSearchParams({ source: this.source || '', file: path })
    const url = `${this.baseUrl}/api/resources/download?${params.toString()}`
    const clean = name.replace(/[\/:*?"<>|]/g, '_')
    return this.saveTo(url, new File(dir, clean === '' || clean === '.' || clean === '..' ? 'fichier' : clean), onProgress)
  }

  /** Several files and folders as one zip, kept with the other downloads. */
  async downloadArchive(
    paths: string[],
    name: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<string> {
    const params = new URLSearchParams({ source: this.source || '', algo: 'zip' })
    for (const path of paths) params.append('file', path)
    const url = `${this.baseUrl}/api/resources/download?${params.toString()}`
    return this.saveTo(url, new File(downloadsDir, uniqueName(name)), onProgress)
  }

  /**
   * Sends a file from the phone. A file of the same name is left alone and answered with a 409 unless
   * `override` says to replace it: nothing is overwritten by accident.
   */
  async uploadLocalFile(
    localUri: string,
    destDir: string,
    filename: string,
    onProgress?: (loaded: number, total: number) => void,
    options: { override?: boolean } = {}
  ): Promise<void> {
    const params = new URLSearchParams({
      path: joinPath(destDir, filename),
      source: this.source || '',
      override: options.override ? 'true' : 'false'
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
      if (result?.status === 409) throw new ApiError('Un fichier du même nom existe déjà', 409)
      throw new ApiError("Échec de l'upload", result?.status || 500)
    }
  }

  /** Deletes several files or folders in one request; the server reports each one that it could not delete. */
  async removeMany(paths: string[]): Promise<BatchResult> {
    if (paths.length === 0) return { done: [], failed: [] }
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/resources/bulk`,
      method: 'DELETE',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      data: paths.map((path) => ({ source: this.source, path }))
    })
    return this.batchOutcome(res, paths, 'Suppression impossible')
  }

  async remove(path: string): Promise<void> {
    const result = await this.removeMany([path])
    if (result.failed.length > 0) throw new ApiError(result.failed[0].message, 500)
  }

  /** Moves files or folders into another folder, keeping their names; nothing at the destination is overwritten. */
  async move(paths: string[], destDir: string): Promise<BatchResult> {
    if (paths.length === 0) return { done: [], failed: [] }
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/resources`,
      method: 'PATCH',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      data: {
        items: paths.map((path) => ({
          fromSource: this.source,
          fromPath: path,
          toSource: this.source,
          toPath: joinPath(destDir, baseName(path))
        })),
        action: 'move',
        overwrite: false,
        rename: false
      }
    })
    return this.batchOutcome(res, paths, 'Déplacement impossible')
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
    const result = this.batchOutcome(res, [path], 'Renommage impossible')
    if (result.failed.length > 0) throw new ApiError(result.failed[0].message, res.status || 500)
  }

  /**
   * Reads the answer to a request on several files. The server answers 200 when all went well, 207 when
   * some did not and 500 when none did, listing the failures with a reason: a 207 must not pass for success.
   */
  private batchOutcome(
    res: { ok: boolean; status: number; data: any; error?: string },
    paths: string[],
    fallback: string
  ): BatchResult {
    const failedList: any[] | null = Array.isArray(res.data?.failed) ? res.data.failed : null
    if (res.ok && !failedList?.length) return { done: [...paths], failed: [] }
    if (!failedList || failedList.length === 0) throw new ApiError(messageOf(res) || fallback, res.status)
    const failed = failedList.map((entry) => ({
      path: String(entry.fromPath ?? entry.path ?? ''),
      message: String(entry.message || fallback)
    }))
    const failedPaths = new Set(failed.map((f) => normalizePath(f.path)))
    // Every file failed, or the server named the ones that did.
    const allFailed = failed.length >= paths.length
    return {
      done: allFailed ? [] : paths.filter((p) => !failedPaths.has(normalizePath(p))),
      failed: allFailed
        ? paths.map((p, i) => ({ path: p, message: failed[Math.min(i, failed.length - 1)].message }))
        : failed.map((f) => ({ path: paths.find((p) => normalizePath(p) === normalizePath(f.path)) ?? f.path, message: f.message }))
    }
  }

  /**
   * Makes a link anyone can open without an account. It points at this server through the address the
   * app uses, whatever the server believes its own address to be behind a reverse proxy.
   */
  async createShare(path: string, duration: ShareDuration = null, password?: string): Promise<ShareLink> {
    const body: Record<string, unknown> = { path, source: this.source }
    if (duration) {
      body.expires = String(duration.value)
      body.unit = duration.unit
    }
    if (password) body.password = password
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/share`,
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      data: body
    })
    if (!res.ok || typeof res.data?.hash !== 'string') {
      if (res.status === 403) throw new ApiError("Ce compte n'a pas le droit de partager des fichiers", 403)
      throw new ApiError(messageOf(res) || 'Création du lien impossible', res.status || 500)
    }
    return this.toShareLink(res.data)
  }

  /** The share links of this account (all of them for an administrator), newest first. */
  async listShares(): Promise<ShareLink[]> {
    let res = await xhrRequest({ url: `${this.baseUrl}/api/share/list`, headers: this.authHeaders() })
    // Before FileBrowser 1.3 the list lived at /api/shares.
    if (res.status === 404) res = await xhrRequest({ url: `${this.baseUrl}/api/shares`, headers: this.authHeaders() })
    if (!res.ok || !Array.isArray(res.data)) throw new ApiError(messageOf(res) || 'Impossible de lister les liens', res.status || 500)
    return res.data
      .filter((raw: any) => typeof raw?.hash === 'string')
      .map((raw: any) => this.toShareLink(raw))
      .reverse()
  }

  async deleteShare(hash: string): Promise<void> {
    const res = await xhrRequest({
      url: `${this.baseUrl}/api/share?${new URLSearchParams({ hash }).toString()}`,
      method: 'DELETE',
      headers: this.authHeaders()
    })
    if (!res.ok) throw new ApiError(messageOf(res) || 'Suppression du lien impossible', res.status)
  }

  private toShareLink(raw: any): ShareLink {
    const hasPassword = raw.hasPassword === true
    const token = hasPassword && typeof raw.token === 'string' && raw.token ? `&token=${encodeURIComponent(raw.token)}` : ''
    const expire = Number(raw.expire) || 0
    return {
      hash: raw.hash,
      url: `${this.baseUrl}/public/share/${raw.hash}`,
      downloadUrl: `${this.baseUrl}/public/api/resources/download?hash=${encodeURIComponent(raw.hash)}${token}`,
      path: String(raw.path ?? ''),
      expiresAt: expire > 0 ? expire * 1000 : null,
      hasPassword,
      username: typeof raw.username === 'string' ? raw.username : undefined,
      pathExists: typeof raw.pathExists === 'boolean' ? raw.pathExists : undefined
    }
  }

  /** Looks for files and folders by name under `scope`. Only what the server has indexed turns up. */
  async search(query: string, scope = '/'): Promise<SearchHit[]> {
    const params = new URLSearchParams({ query, source: this.source || '', scope }).toString()
    const headers = { ...this.authHeaders(), SessionId: this.sessionId }
    let res = await xhrRequest({ url: `${this.baseUrl}/api/tools/search?${params}`, headers })
    // Before FileBrowser 1.3 the search lived at /api/search.
    if (res.status === 404) res = await xhrRequest({ url: `${this.baseUrl}/api/search?${params}`, headers })
    if (!res.ok || !Array.isArray(res.data)) throw new ApiError(messageOf(res) || 'Recherche impossible', res.status || 500)
    return res.data
      .filter((hit: any) => typeof hit?.path === 'string')
      .map((hit: any): SearchHit => {
        const isDir = hit.type === 'directory' || hit.path.endsWith('/')
        const path = normalizePath(`/${hit.path}`)
        return {
          path,
          name: baseName(path),
          isDir,
          size: Number(hit.size) || 0,
          modified: String(hit.modified ?? ''),
          type: typeof hit.type === 'string' ? hit.type : undefined,
          hasPreview: typeof hit.hasPreview === 'boolean' ? hit.hasPreview : undefined
        }
      })
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
