import type { ShareDuration } from '@/services/filebrowser'

/** The lifetimes offered when making a share link. */
export const SHARE_DURATIONS: { label: string; duration: ShareDuration }[] = [
  { label: '1 heure', duration: { value: 1, unit: 'hours' } },
  { label: '1 jour', duration: { value: 1, unit: 'days' } },
  { label: '7 jours', duration: { value: 7, unit: 'days' } },
  { label: '30 jours', duration: { value: 30, unit: 'days' } },
  { label: 'Sans limite', duration: null }
]

/** How long a link has left, in words: "expire dans 3 j", "sans limite de durée", "expiré". */
export function describeExpiry(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return 'sans limite de durée'
  const left = expiresAt - now
  if (left <= 0) return 'expiré'
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `expire dans ${minutes} min`
  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `expire dans ${hours} h`
  return `expire dans ${Math.ceil(hours / 24)} j`
}
