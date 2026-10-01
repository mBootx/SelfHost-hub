import type { CameraBackupPhase } from '@/store/cameraBackupStore'

export type SyncKind =
  | 'off'
  | 'checking'
  | 'running'
  | 'waiting-wifi'
  | 'no-permission'
  | 'no-server'
  | 'error'
  | 'pending'
  | 'failed'
  | 'ok'

/** What the strip above the gallery offers to do about it. */
export type SyncAction = 'enable' | 'send-now' | 'send-anyway' | 'allow-access' | 'retry' | 'retry-failed'

export interface SyncInput {
  enabled: boolean
  phase: CameraBackupPhase
  progress: { done: number; total: number; filename: string } | null
  /** Photos and videos found on the phone but not sent yet, as of the last check; null before the first check. */
  pending: number | null
  /** Files given up on, which the app can try again. */
  gaveUp: number
  error: string | null
  lastSuccessAt: number | null
  /** Whether the phone has been looked at since the app started. */
  checked: boolean
}

export interface SyncStatus {
  kind: SyncKind
  title: string
  hint: string | null
  /** How far along the current run is, 0 to 1, while it is sending. */
  fraction: number | null
  action: SyncAction | null
}

export function timeAgo(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000)
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  return `il y a ${Math.round(hours / 24)} j`
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`
}

/**
 * One line that says where the backup stands, so a photo that isn't in the gallery can be explained: still
 * on the phone waiting for Wi-Fi, being sent, refused by the server, or the backup off altogether.
 */
export function describeSync(input: SyncInput, now = Date.now()): SyncStatus {
  const { enabled, phase, progress, pending, gaveUp, error, lastSuccessAt, checked } = input
  const status = (kind: SyncKind, title: string, hint: string | null = null, action: SyncAction | null = null, fraction: number | null = null): SyncStatus => ({
    kind,
    title,
    hint,
    action,
    fraction
  })

  if (!enabled) return status('off', 'Sauvegarde automatique désactivée', "Les nouvelles photos du téléphone n'arriveront pas ici.", 'enable')
  if (phase === 'running') {
    if (!progress) return status('running', 'Envoi en cours…')
    const fraction = progress.total > 0 ? progress.done / progress.total : null
    return status('running', `Envoi en cours · ${progress.done + 1} sur ${progress.total}`, progress.filename, null, fraction)
  }
  if (phase === 'waiting-wifi') {
    return status('waiting-wifi', 'En attente du Wi-Fi', pending ? `${count(pending, 'fichier', 'fichiers')} à envoyer` : null, 'send-anyway')
  }
  if (phase === 'no-permission') return status('no-permission', 'Accès aux photos refusé', 'La sauvegarde ne peut pas lire les photos du téléphone.', 'allow-access')
  if (phase === 'no-server') return status('no-server', 'FileBrowser injoignable', error, 'retry')
  if (phase === 'error') return status('error', 'Sauvegarde interrompue', error || 'Erreur inconnue', 'retry')
  if (!checked) return status('checking', 'Recherche des nouvelles photos…')
  if (pending) return status('pending', `${count(pending, 'fichier', 'fichiers')} à envoyer`, error, 'send-now')
  if (gaveUp > 0) {
    return status('failed', `${count(gaveUp, 'fichier', 'fichiers')} non envoyé${gaveUp > 1 ? 's' : ''}`, error || 'Trop volumineux ou refusés par le serveur.', 'retry-failed')
  }
  return status('ok', 'Sauvegarde à jour', lastSuccessAt ? `Dernier envoi ${timeAgo(lastSuccessAt, now)}` : null)
}
