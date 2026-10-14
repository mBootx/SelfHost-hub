/**
 * Playlists by account. Navidrome lists to every account the public playlists of the others, and to an admin every
 * playlist of every account: the apps keep to the account's own. The server's owner manages the rest through
 * Navidrome's own API (the one its web pages use), which is the only way to give a playlist to another account or to
 * unlock one imported from an M3U file (one that follows its file can't have songs added or removed).
 * Same rules as mobile/src/services/navidromeAdmin.ts; requests go through the main process like every other one.
 */

/** The account's own playlists among those the server lists. A server too old to say whose a playlist is shows them all. */
export function ownPlaylists<T extends { owner?: string }>(playlists: T[], username: string | null | undefined): T[] {
  const me = username?.trim().toLowerCase()
  if (!me) return playlists
  return playlists.filter((p) => !p.owner || p.owner.trim().toLowerCase() === me)
}

export interface AdminPlaylist {
  id: string
  name: string
  comment?: string
  ownerId: string
  ownerName?: string
  public: boolean
  songCount: number
  duration?: number
  /** The M3U file it was imported from, if it was. */
  path?: string
  /** Follows its M3U file: its songs can't be changed in the apps (the file would put them back). */
  sync?: boolean
  /** A smart playlist (rules instead of songs). */
  rules?: unknown
  [key: string]: unknown
}

export interface AdminUser {
  id: string
  userName: string
  name: string
  isAdmin: boolean
}

export type PlaylistChanges = Partial<Pick<AdminPlaylist, 'name' | 'comment' | 'public' | 'ownerId' | 'sync'>>

export class AdminError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Whether the playlist's songs can be changed (Navidrome: not a smart playlist, not following a file). */
export function tracksEditable(p: AdminPlaylist): boolean {
  return !p.sync && (p.rules === undefined || p.rules === null)
}

/** What Navidrome is sent back when a playlist is changed: the playlist as it is, with the changes (as its own web pages do). */
export function updateBody(current: AdminPlaylist, changes: PlaylistChanges): Record<string, unknown> {
  const { ownerName: _ownerName, tracks: _tracks, ...rest } = current
  return { ...rest, ...changes }
}

function describe(status: number, fallback: string, error?: string): string {
  if (status === 0) return error || 'Serveur injoignable'
  if (status === 401) return 'Identifiants refusés par Navidrome'
  if (status === 403) return 'Réservé à un compte administrateur de Navidrome'
  if (status === 404) return 'Playlist introuvable (supprimée entre-temps ?)'
  if (status === 409) return 'Cette playlist ne peut pas être modifiée ainsi'
  return `${fallback} (${status})`
}

export class NavidromeAdmin {
  private token: string | null = null
  /** The sign-in under way, which requests started at the same time share. */
  private signingIn: Promise<string> | null = null

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string
  ) {}

  private async login(): Promise<string> {
    const res = await window.api.net.request({
      url: `${this.baseUrl}/auth/login`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { username: this.username, password: this.password }
    })
    const data = res.data
    if (!res.ok || typeof data?.token !== 'string') throw new AdminError(describe(res.status, 'Connexion à Navidrome impossible', res.error), res.status)
    if (!data.isAdmin) throw new AdminError('Réservé à un compte administrateur de Navidrome', 403)
    this.token = data.token
    return data.token
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token =
      this.token ??
      (await (this.signingIn ??= this.login().finally(() => {
        this.signingIn = null
      })))
    const res = await window.api.net.request({
      url: `${this.baseUrl}${path}`,
      method,
      headers: { 'Content-Type': 'application/json', 'X-ND-Authorization': `Bearer ${token}` },
      data: body
    })
    // The session ran out: one new sign-in, then the request again.
    if (res.status === 401 && !retried) {
      this.token = null
      return this.request<T>(method, path, body, true)
    }
    // Navidrome hands back a renewed token as it goes.
    const renewed = res.headers?.['x-nd-authorization']
    if (typeof renewed === 'string' && renewed.startsWith('Bearer ')) this.token = renewed.slice(7)
    if (!res.ok) throw new AdminError(describe(res.status, 'Navidrome a refusé', res.error), res.status)
    return res.data as T
  }

  /** Every account of the server. */
  users(): Promise<AdminUser[]> {
    return this.request<AdminUser[]>('GET', '/api/user?_sort=userName&_order=ASC&_start=0&_end=1000')
  }

  /** Every playlist of every account (an admin sees them all). */
  playlists(): Promise<AdminPlaylist[]> {
    return this.request<AdminPlaylist[]>('GET', '/api/playlist?_sort=name&_order=ASC&_start=0&_end=10000')
  }

  /** Changes a playlist; giving it to another account (`ownerId`) is for an admin only. */
  async update(id: string, changes: PlaylistChanges): Promise<AdminPlaylist> {
    const current = await this.request<AdminPlaylist>('GET', `/api/playlist/${encodeURIComponent(id)}`)
    await this.request('PUT', `/api/playlist/${encodeURIComponent(id)}`, updateBody(current, changes))
    return { ...current, ...changes }
  }

  remove(id: string): Promise<unknown> {
    return this.request('DELETE', `/api/playlist/${encodeURIComponent(id)}`)
  }
}
