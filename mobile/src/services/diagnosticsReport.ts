import type { LogEntry, LogScope } from '@/services/diagnostics'

/** What the Diagnostic screen shows, gathered into one object so the same text can be copied as a report. */
export interface ServerLine {
  name: string
  /** 'ok': signed in and working; 'down': configured but not working; 'off': never set up. */
  state: 'ok' | 'down' | 'off'
  /** 'connecté', 'déconnecté', 'erreur'... as the screen words it. */
  status: string
  account?: string
  host?: string
  /** How long the last test took (ms), or null if it failed. Absent when nothing was tested. */
  latencyMs?: number | null
  detail?: string
}

export interface BackupLine {
  enabled: boolean
  phase: string
  /** The folder photos go to on the server. */
  destination: string | null
  pending: number | null
  uploaded: number
  gaveUp: number
  lastSuccessAt: number | null
  lastCheckAt: number | null
  error: string | null
  /** Photos and videos taken after this moment are backed up (ms), or null before anything was read. */
  cursor: number | null
  rememberedSent: number | null
  failing: number | null
  permission: string
  network: string
  charging: boolean | null
  wifiOnly: boolean
}

export interface Snapshot {
  now: number
  app: { version: string; build: string; device: string; lock: boolean }
  servers: ServerLine[]
  backup: BackupLine
  /** `status` is as the screen words it; `failed` says it is an error, not just "not connected". */
  remote: { enabled: boolean; status: string; failed: boolean; paired: boolean; error: string | null }
  entries: LogEntry[]
}

export const SCOPE_LABELS: Record<LogScope, string> = {
  app: 'application',
  backup: 'sauvegarde',
  photos: 'photos',
  files: 'fichiers',
  music: 'musique',
  scrobbler: 'écoutes',
  update: 'mise à jour',
  remote: 'contrôle à distance',
  connection: 'connexion',
  lock: 'verrouillage'
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** "02/10/2026 11:20:05" in the phone's own time. */
export function formatDateTime(t: number): string {
  const d = new Date(t)
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export function formatClock(t: number): string {
  const d = new Date(t)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** The time of day for today's lines, the day and time for older ones: "11:20:05" / "01/10 22:04". */
export function formatStamp(t: number, now: number): string {
  const d = new Date(t)
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? formatClock(t) : `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`
}

const PHASES: Record<string, string> = {
  idle: 'au repos',
  running: 'envoi en cours',
  'waiting-wifi': 'attend le Wi-Fi',
  'waiting-charger': 'attend le chargeur',
  'no-permission': 'accès aux photos refusé',
  'no-server': 'FileBrowser injoignable',
  error: 'interrompue'
}

/** The backup's phase in words. */
export function describePhase(phase: string): string {
  return PHASES[phase] ?? phase
}

/** "il y a 5 min" / "il y a 2 h" / "il y a 3 j" relative to `now`. */
export function ago(t: number | null, now: number): string {
  if (t === null) return 'jamais'
  const minutes = Math.max(0, Math.round((now - t) / 60_000))
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return `il y a ${Math.round(hours / 24)} j`
}

/** Names shorter than this are only replaced where they stand alone. */
const SHORT_SECRET = 5

export interface Secret {
  value: string
  label: string
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9À-ÿ]/.test(ch)
}

/**
 * Hides what identifies the person or the servers: every secret given (host names, account names...) is
 * replaced by a label, whatever case it is in. The report is copied by hand and pasted to someone else, so it
 * should say what went wrong without saying whose server it is.
 *
 * One pass over the text, longest secret first at each spot, so a label that was put in is never read again
 * as part of another secret (an account called "navidrome" must not eat the label of the Navidrome host).
 */
export function redact(text: string, secrets: Secret[]): string {
  const ordered: { lower: string; label: string }[] = []
  const seen = new Set<string>()
  for (const secret of [...secrets].sort((a, b) => b.value.trim().length - a.value.trim().length)) {
    const value = secret.value.trim()
    if (value.length < 2 || seen.has(value.toLowerCase())) continue
    seen.add(value.toLowerCase())
    ordered.push({ lower: value.toLowerCase(), label: secret.label })
  }
  if (ordered.length === 0) return text

  let out = ''
  let i = 0
  while (i < text.length) {
    let hit: { lower: string; label: string } | null = null
    for (const candidate of ordered) {
      const end = i + candidate.lower.length
      if (text.slice(i, end).toLowerCase() !== candidate.lower) continue
      // A short name ("al") also sits inside other words ("normal"): only the whole word is replaced.
      if (candidate.lower.length < SHORT_SECRET && (isWordChar(text[i - 1]) || isWordChar(text[end]))) continue
      hit = candidate
      break
    }
    if (hit) {
      out += hit.label
      i += hit.lower.length
    } else {
      out += text[i]
      i += 1
    }
  }
  return out
}

/** "nas.local:4533" from "https://nas.local:4533/music". */
export function hostOf(url: string): string {
  const withoutScheme = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  return withoutScheme.split(/[/?#]/)[0] ?? ''
}

/** The same without its port: "nas.local". */
export function hostName(url: string): string {
  const host = hostOf(url)
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
}

/** What identifies one service: where it is and who signs in to it. */
export interface ServiceIdentity {
  label: string
  url?: string | null
  accounts?: (string | null | undefined)[]
}

/** The secrets to hide from a report, with a label each that says what was there. */
export function secretsFor(services: ServiceIdentity[]): Secret[] {
  const secrets: Secret[] = []
  for (const service of services) {
    if (service.url) {
      const base = service.url.trim().replace(/\/+$/, '')
      secrets.push({ value: base, label: `[adresse ${service.label}]` })
      secrets.push({ value: hostOf(base), label: `[hôte ${service.label}]` })
      secrets.push({ value: hostName(base), label: `[hôte ${service.label}]` })
    }
    for (const account of service.accounts ?? []) {
      if (account) secrets.push({ value: account, label: `[compte ${service.label}]` })
    }
  }
  return secrets
}

/** Any IPv4 address left in the text (a PC found on the network, say) is hidden too. */
export function maskAddresses(text: string): string {
  return text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '[adresse IP]')
}

function yesNo(value: boolean): string {
  return value ? 'oui' : 'non'
}

/** The report as plain text, newest log lines last. */
export function buildReport(snapshot: Snapshot, options: { logLines?: number } = {}): string {
  const { now, app, servers, backup, remote, entries } = snapshot
  const lines: string[] = []
  lines.push('SelfHost Hub — rapport de diagnostic', `Généré le ${formatDateTime(now)}`, '')

  lines.push('Application', `  Version : ${app.version} (build ${app.build})`, `  Appareil : ${app.device}`, `  Verrouillage : ${app.lock ? 'activé' : 'désactivé'}`, '')

  lines.push('Serveurs')
  for (const server of servers) {
    const parts = [server.status]
    if (server.account) parts.push(`compte « ${server.account} »`)
    if (server.host) parts.push(server.host)
    if (server.latencyMs !== undefined) parts.push(server.latencyMs === null ? 'ne répond pas' : `${server.latencyMs} ms`)
    if (server.detail) parts.push(server.detail)
    lines.push(`  ${server.name} : ${parts.join(' — ')}`)
  }
  lines.push('')

  lines.push(
    'Sauvegarde des photos',
    `  Activée : ${yesNo(backup.enabled)} (état : ${describePhase(backup.phase)})`,
    `  Destination : ${backup.destination ?? '—'}`,
    `  En attente : ${backup.pending ?? '?'} · envoyés : ${backup.uploaded} · refusés par le serveur : ${backup.gaveUp}`,
    `  Dernier envoi : ${ago(backup.lastSuccessAt, now)} · dernière vérification : ${ago(backup.lastCheckAt, now)}`,
    `  Accès aux photos : ${backup.permission} · réseau : ${backup.network}${backup.wifiOnly ? ' (Wi-Fi uniquement)' : ''} · en charge : ${backup.charging === null ? '?' : yesNo(backup.charging)}`
  )
  if (backup.cursor !== null) {
    const reached = backup.cursor > 0 ? `tout ce qui date d'avant ${formatDateTime(backup.cursor)} est sauvegardé` : 'rien n’a encore été passé en revue'
    lines.push(`  Journal : ${reached} · ${backup.rememberedSent ?? 0} fichiers retenus · ${backup.failing ?? 0} en échec`)
  }
  if (backup.error) lines.push(`  Dernière erreur : ${backup.error}`)
  lines.push('')

  lines.push('Contrôle à distance', `  Activé : ${yesNo(remote.enabled)} · état : ${remote.status} · appairé : ${yesNo(remote.paired)}${remote.error ? ` · ${remote.error}` : ''}`, '')

  const shown = entries.slice(-(options.logLines ?? 80))
  lines.push(`Journal (les ${shown.length} derniers événements)`)
  if (shown.length === 0) lines.push('  (vide)')
  for (const entry of shown) {
    const mark = entry.level === 'error' ? '!! ' : entry.level === 'warn' ? '!  ' : '   '
    lines.push(`${mark}${formatDateTime(entry.t)} [${SCOPE_LABELS[entry.scope] ?? entry.scope}] ${entry.message}`)
  }
  return lines.join('\n')
}

const DAY_MS = 24 * 60 * 60 * 1000

/** What is wrong right now, in a sentence each, for the line at the top of the screen. Empty when all is well. */
export function findProblems(snapshot: Snapshot): string[] {
  const { now, servers, backup, remote, entries } = snapshot
  const problems: string[] = []

  for (const server of servers) {
    if (server.state === 'down') problems.push(`${server.name} : ${server.detail ?? server.status}.`)
    else if (server.state === 'ok' && server.latencyMs === null) problems.push(`${server.name} ne répond pas au test${server.detail ? ` (${server.detail})` : ''}.`)
    else if (server.state === 'ok' && server.detail) problems.push(`${server.name} : ${server.detail}.`)
  }

  if (backup.enabled) {
    if (backup.phase === 'no-permission' || backup.permission === 'refusé') problems.push("La sauvegarde n'a pas accès aux photos du téléphone.")
    else if (backup.permission === 'limité') problems.push("L'accès aux photos est limité à celles que vous avez choisies : le reste n'est pas sauvegardé.")
    if (backup.phase === 'no-server') problems.push(`La sauvegarde ne joint pas FileBrowser${backup.error ? ` (${backup.error})` : ''}.`)
    if (backup.phase === 'error') problems.push(`La sauvegarde est interrompue : ${backup.error ?? 'erreur inconnue'}.`)
    if (backup.gaveUp > 0) problems.push(`${backup.gaveUp} fichier${backup.gaveUp > 1 ? 's' : ''} que le serveur refuse.`)
    const waiting = backup.pending ?? 0
    if (waiting > 0 && backup.phase === 'idle' && backup.lastSuccessAt !== null && now - backup.lastSuccessAt > 3 * DAY_MS) {
      problems.push(`${waiting} fichier${waiting > 1 ? 's attendent' : ' attend'} depuis plus de 3 jours : aucun envoi n'a abouti.`)
    }
  }

  if (remote.enabled && remote.failed) problems.push(`Contrôle à distance : ${remote.error ?? 'erreur'}.`)

  const crash = [...entries].reverse().find((e) => e.scope === 'app' && e.level === 'error')
  if (crash && now - crash.t < 3 * DAY_MS) problems.push(`Un plantage a été enregistré ${ago(crash.t, now)}.`)
  return problems
}

/** The report as it is copied to send to someone: the servers' addresses and the account names are hidden. */
export function shareableReport(snapshot: Snapshot, services: ServiceIdentity[], options: { logLines?: number } = {}): string {
  return maskAddresses(redact(buildReport(snapshot, options), secretsFor(services)))
}
